import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx2
from fastapi import Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app import funnel, history, muse, places, refine
from app.answers import QuestionKey as ParseKey
from app.answers import parse as parse_text
from app.auth import current_auth, current_user
from app.categories import CATEGORY_IDS, OTHER
from app.config import get_settings
from app.logs import configure_logging
from app.refine import Change
from app.scoring import Context, History, meal_context, merge_candidates, place_stats, rank

configure_logging()
app = FastAPI(title="What to eat! API")
logger = logging.getLogger(__name__)

# FR-R2 upper clamp: 25 miles.
MAX_RADIUS_M = 40_234
# ML10: after 3 rounds without a pick, round 4 is the best options so far.
CAP_ROUND = 4


async def get_places_client() -> AsyncIterator[httpx2.AsyncClient]:
    async with httpx2.AsyncClient() as client:
        yield client


async def get_http_client() -> AsyncIterator[httpx2.AsyncClient]:
    """One client per round for Geoapify, Supabase, and Muse."""
    async with httpx2.AsyncClient() as client:
        yield client


def places_error(e: places.PlacesError) -> HTTPException:
    if isinstance(e, places.PlacesTimeout):
        return HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "Places search timed out")
    if isinstance(e, places.PlacesNotConfigured):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Places search is not configured")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Places search failed")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/me")
def me(user_id: str = Depends(current_user)) -> dict[str, str]:
    return {"user_id": user_id}


@app.get("/places/search")
async def places_search(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius_m: int | None = Query(default=None, ge=1, le=MAX_RADIUS_M),
    user_id: str = Depends(current_user),
    client: httpx2.AsyncClient = Depends(get_places_client),
) -> dict:
    """Catering places within radius_m (default PLACES_RADIUS_M). Empty list is a 200."""
    try:
        result = await places.search(lat, lon, radius_m, client=client)
    except places.PlacesError as e:
        raise places_error(e) from None
    return {
        "radius_m": result.radius_m,
        "count": len(result.places),
        "truncated": result.truncated,
        "places": [asdict(p) for p in result.places],
    }


QuestionKey = Literal["craving", "budget", "distance", "company", "refine", "open"]


class TranscriptMessage(BaseModel):
    """One chat line before this round (messages table; R3 answers)."""

    role: Literal["assistant", "user"]
    body: str = Field(min_length=1, max_length=200)
    question_key: QuestionKey | None = None
    answer: dict[str, str | int | bool | list[str] | None] | None = Field(
        default=None, max_length=5
    )
    input_mode: Literal["chip", "text", "voice", "prefill"] | None = None


class RecommendationsRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    local_time: datetime  # the device's local time; sets the meal slot and date
    craving: str | None = None  # ML2 category id
    budget_level: int | None = Field(default=None, ge=1, le=4)
    radius_m: Literal[1500, 5000, 15000] | None = None  # FR3 distance chips
    exclude_ids: list[str] = Field(default_factory=list, max_length=100)
    # Current answers from the chat ("not burgers"); a follow-up's change is in refine.
    exclude_categories: list[str] = Field(default_factory=list, max_length=len(refine.CRAVINGS))
    refine: Change | None = None  # a follow-up (chip or parsed text), applied here
    session_id: UUID | None = None  # omitted on round 1; later rounds continue the session
    timezone: str | None = Field(default=None, max_length=64)  # device IANA zone
    solo: bool | None = None  # from the quiz prior in Phase 1 (company is not asked)
    transcript: list[TranscriptMessage] = Field(default_factory=list, max_length=8)

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("unknown timezone") from None
        return value

    @field_validator("craving")
    @classmethod
    def known_craving(cls, value: str | None) -> str | None:
        if value is not None and (value not in CATEGORY_IDS or value == OTHER):
            raise ValueError("unknown category")
        return value

    @field_validator("exclude_categories")
    @classmethod
    def known_excludes(cls, values: list[str]) -> list[str]:
        return refine.known_categories(values)

    def answered_open_question(self) -> bool:
        return any(m.role == "user" and m.question_key == "open" for m in self.transcript)


def offset_zone(local: datetime) -> str:
    """Fallback session timezone when the app sends none: the UTC offset, e.g. 'UTC-04:00'."""
    offset = local.utcoffset()
    if offset is None:
        return "unknown"
    minutes = int(offset.total_seconds()) // 60
    sign = "-" if minutes < 0 else "+"
    hours, mins = divmod(abs(minutes), 60)
    return f"UTC{sign}{hours:02d}:{mins:02d}"


async def quietly(coro, what: str):
    """Runs a logging write. On any failure: logs the error type only and returns None."""
    try:
        result = await coro
    except Exception as e:
        logger.warning("Funnel %s failed: %s", what, type(e).__name__)
        return None
    return True if result is None else result


async def load_history(user_id: str, token: str, client: httpx2.AsyncClient) -> History | None:
    """History, or None on any failure (the round goes on as a cold start)."""
    try:
        return await history.load(user_id, token, client=client)
    except Exception as e:
        logger.warning("History load failed: %s", type(e).__name__)
        return None


@app.post("/recommendations")
async def recommendations(
    body: RecommendationsRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    """One round (FR7, NFR4): places + history in parallel, merge, rank, one Muse call.

    Later rounds (P1-14, ML10) apply the follow-up's change, skip every place already shown,
    and log the previous round's cards as rejected. Round 4 without a pick is the best so far.
    """
    started = time.perf_counter()
    user_id, token = auth
    default_radius = get_settings().PLACES_RADIUS_M
    current = refine.Answers(body.craving, body.budget_level, body.radius_m,
                             tuple(body.exclude_categories))
    applied = (refine.apply(body.refine, current, default_radius) if body.refine
               else refine.Applied(current, ()))
    answers = applied.answers
    radius = answers.radius_m or default_radius
    slot, local_date, is_weekend = meal_context(body.local_time)
    new_session = funnel.NewSession(
        timezone=body.timezone or offset_zone(body.local_time),
        local_date=local_date,
        meal_slot=slot,
        lat=body.lat,
        lon=body.lon,
        craving=answers.craving,
        budget_level=answers.budget_level,
        radius_m=answers.radius_m,
        search_radius_m=radius,
        solo=body.solo,
    )
    session_id = str(body.session_id) if body.session_id else None
    opening = quietly(
        funnel.open_round(user_id, token, session_id, new_session, client=client), "session"
    )
    try:
        if session_id is None:
            result, loaded, ref = await asyncio.gather(
                places.search(body.lat, body.lon, radius, client=client),
                load_history(user_id, token, client),
                opening,
            )
        else:
            # The session read decides the round (and whether it is the cap) before searching.
            loaded, ref = await asyncio.gather(load_history(user_id, token, client), opening)
            if ref and ref.closed:
                raise HTTPException(status.HTTP_409_CONFLICT, "Session already has an outcome")
            if ref and ref.round == CAP_ROUND and not body.answered_open_question():
                return await best_so_far_round(
                    body, user_id, token, ref, applied, new_session, loaded, started,
                    client=client,
                )
            result = await places.search(body.lat, body.lon, radius, client=client)
    except places.PlacesError as e:
        raise places_error(e) from None

    shown_before = frozenset(c.place_id for c in ref.shown) if ref else frozenset()
    context = Context(
        lat=body.lat,
        lon=body.lon,
        local_date=local_date,
        meal_slot=slot,
        is_weekend=is_weekend,
        search_radius_m=result.radius_m,
        craving=answers.craving,
        budget_level=answers.budget_level,
        radius_m=answers.radius_m,
        exclude_ids=frozenset(body.exclude_ids) | shown_before,
        exclude_categories=frozenset(answers.exclude_categories),
    )
    user_history = loaded or History()
    candidates, merged_ids = merge_candidates(result.places, user_history, context)
    ranking = rank(candidates, context, user_history, merged_ids)
    shown = [pick.scored.place for pick in ranking.top3]
    # The shown places are cached while Muse writes; the events need their rows.
    # The transcript and a later round's follow-up writes go alongside them.
    reasons, cached, saved, followed = await asyncio.gather(
        muse.write_reasons(ranking.top3, client=client),
        quietly(funnel.upsert_places(shown, client=client), "places")
        if ref
        else asyncio.sleep(0),
        log_transcript(user_id, token, ref, body, client) if ref else asyncio.sleep(0),
        log_follow_up(user_id, token, ref, new_session, applied.tags, client)
        if ref
        else asyncio.sleep(0),
    )
    logged = bool(
        ref
        and cached
        and saved
        and followed
        and await quietly(
            funnel.log_shown(
                user_id, token, ref, ranking.top3, reasons.lines, reasons.source, client=client
            ),
            "shown",
        )
    )

    logger.info(
        "Recommendations round in %d ms (reasons: %s)",
        (time.perf_counter() - started) * 1000,
        reasons.source,
    )
    return {
        "session_id": ref.session_id if ref else session_id,
        "round": ref.round if ref else None,
        "logged": logged,
        "history_used": loaded is not None,
        "reasons_source": reasons.source,
        "cold_start": ranking.cold_start,
        "radius_m": result.radius_m,
        "truncated": result.truncated,
        "best_so_far": False,
        "answers": answers_out(answers),
        "picks": [
            {
                "rank": pick.rank,
                "slot": pick.slot,
                "id": pick.scored.place.id,
                "name": pick.scored.place.name,
                "lat": pick.scored.place.lat,
                "lon": pick.scored.place.lon,
                "distance_m": pick.scored.place.distance_m,
                "category": pick.scored.place.category,
                "address": pick.scored.place.address,
                "reason": reason,
            }
            for pick, reason in zip(ranking.top3, reasons.lines, strict=True)
        ],
    }


def answers_out(answers: refine.Answers) -> dict:
    """The answers this round ran with, so the app continues from them."""
    return {
        "craving": answers.craving,
        "budget_level": answers.budget_level,
        "radius_m": answers.radius_m,
        "exclude_categories": list(answers.exclude_categories),
    }


async def log_transcript(
    user_id: str, token: str, ref: funnel.RoundRef, body: RecommendationsRequest,
    client: httpx2.AsyncClient,
):
    transcript = [m.model_dump() for m in body.transcript]
    return await quietly(
        funnel.log_messages(user_id, token, ref, transcript, client=client), "messages"
    )


async def log_follow_up(
    user_id: str, token: str, ref: funnel.RoundRef, new: funnel.NewSession,
    tags: tuple[str, ...], client: httpx2.AsyncClient,
) -> bool:
    """Later rounds: the session's current answers, and the previous round's cards as
    rejected with what changed (never the user's text). True when both were written."""
    if ref.round == 1:
        return True
    previous = ref.round - 1
    results = await asyncio.gather(
        quietly(funnel.update_answers(user_id, token, ref.session_id, new, client=client),
                "answers"),
        quietly(funnel.log_rejected(user_id, token, ref.session_id, previous,
                                    ref.shown_in(previous), refine.reject_reason(tags),
                                    client=client),
                "rejected"),
    )
    return all(results)


async def best_so_far_round(
    body: RecommendationsRequest, user_id: str, token: str, ref: funnel.RoundRef,
    applied: refine.Applied, new: funnel.NewSession, loaded: History | None, started: float,
    *, client: httpx2.AsyncClient,
) -> dict:
    """The cap (ML10): the best cards already shown that still fit the current answers.

    No places search and no Muse call: the cards and their reasons were shown before (R2).
    Fewer than 3 can fit; none means the app goes straight to the open question.
    """
    answers = applied.answers
    user_history = loaded or History()
    known = {pid: s.price_level for pid, s in place_stats(user_history, new.local_date).items()}
    budget = answers.budget_level or user_history.prior.budget_level
    best = refine.best_so_far(ref.shown, answers, new.search_radius_m, body.lat, body.lon,
                              known, budget)
    cards = [
        {
            "place_id": card.place_id,
            "rank": rank_,
            "slot": card.slot,
            "score": card.score,
            "pick_reason": card.pick_reason or best_reason(meters),
            "reasons_source": card.reasons_source if card.pick_reason else muse.TEMPLATE,
        }
        for rank_, (card, meters) in enumerate(best, start=1)
    ]
    saved, followed = await asyncio.gather(
        log_transcript(user_id, token, ref, body, client),
        log_follow_up(user_id, token, ref, new, applied.tags, client),
    )
    logged = bool(
        saved
        and followed
        and await quietly(funnel.log_shown_rows(user_id, token, ref, cards, client=client),
                          "shown")
    )
    logger.info(
        "Best-so-far round in %d ms (%d cards)", (time.perf_counter() - started) * 1000, len(best)
    )
    return {
        "session_id": ref.session_id,
        "round": ref.round,
        "logged": logged,
        "history_used": loaded is not None,
        "reasons_source": "stored",
        "cold_start": False,
        "radius_m": new.search_radius_m,
        "truncated": False,
        "best_so_far": True,
        "answers": answers_out(answers),
        "picks": [
            {
                "rank": row["rank"],
                "slot": card.slot,
                "id": card.place_id,
                "name": card.name,
                "lat": card.lat,
                "lon": card.lon,
                "distance_m": meters,
                "category": card.category,
                "address": card.address,
                "reason": row["pick_reason"],
            }
            for row, (card, meters) in zip(cards, best, strict=True)
        ],
    }


def best_reason(meters: int) -> str:
    return f"One of your best so far, {muse.format_distance(meters)} away."


# Answer parsing (P1-21 FR5, P1-14) --------------------------------------------


class ParseRequest(BaseModel):
    question_key: ParseKey
    text: str = Field(min_length=1, max_length=200)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text is blank")
        return value


@app.post("/answers/parse")
async def parse_answer(
    body: ParseRequest,
    user_id: str = Depends(current_user),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    """Typed text -> the same change a chip gives, not sure, or a chat line (small talk).
    One Muse call, never 5xx."""
    parsed = await parse_text(body.question_key, body.text, client=client)
    return {
        "status": parsed.status,
        "answer": parsed.change.model_dump() if parsed.change else None,
        "source": parsed.source,
        "reply": parsed.reply,
    }


# Funnel events (P1-15, ML8) --------------------------------------------------


class EventRequest(BaseModel):
    round: int = Field(ge=1, le=100)
    place_id: str = Field(min_length=1, max_length=200)


class InterestedRequest(EventRequest):
    kind: Literal["card", "directions"]


class RejectedRequest(EventRequest):
    reason: str = Field(min_length=1, max_length=200)

    @field_validator("reason")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason is blank")
        return value


def funnel_error(e: funnel.FunnelError) -> HTTPException:
    if isinstance(e, funnel.NotFound):
        return HTTPException(status.HTTP_404_NOT_FOUND, "Not found in this session")
    if isinstance(e, funnel.Conflict):
        return HTTPException(status.HTTP_409_CONFLICT, "Session already has an outcome")
    if isinstance(e, funnel.FunnelNotConfigured):
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Logging is not configured")
    logger.warning("Funnel event failed: %s", type(e).__name__)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Logging failed")


async def shown_event(
    session_id: UUID, body: EventRequest, event: str, fields: dict,
    auth: tuple[str, str], client: httpx2.AsyncClient,
) -> dict:
    """Logs an event on a card that was shown in this session and round (R2)."""
    user_id, token = auth
    sid = str(session_id)
    try:
        await funnel.find_shown(user_id, token, sid, body.round, body.place_id, client=client)
        await funnel.log_event(user_id, token, sid, body.round, body.place_id, event, fields,
                               client=client)
    except funnel.FunnelError as e:
        raise funnel_error(e) from None
    return {"logged": True}


@app.post("/sessions/{session_id}/interested")
async def interested(
    session_id: UUID,
    body: InterestedRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    return await shown_event(session_id, body, "interested", {"interest_kind": body.kind},
                             auth, client)


@app.post("/sessions/{session_id}/rejected")
async def rejected(
    session_id: UUID,
    body: RejectedRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    return await shown_event(session_id, body, "rejected", {"reject_reason": body.reason},
                             auth, client)


@app.post("/sessions/{session_id}/picked")
async def picked(
    session_id: UUID,
    body: EventRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    """Final choice (FR9): the picked event, the live meal, and outcome = 'picked'."""
    user_id, token = auth
    try:
        await funnel.log_pick(user_id, token, str(session_id), body.round, body.place_id,
                              client=client)
    except funnel.FunnelError as e:
        raise funnel_error(e) from None
    return {"logged": True}


@app.post("/sessions/{session_id}/none")
async def none(
    session_id: UUID,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    """No pick: outcome = 'none' and ended_at. 409 if the session already has an outcome."""
    user_id, token = auth
    try:
        await funnel.close_session(user_id, token, str(session_id), "none", client=client)
    except funnel.FunnelError as e:
        raise funnel_error(e) from None
    return {"logged": True}
