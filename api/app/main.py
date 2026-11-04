import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, replace
from datetime import date, datetime
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx2
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field, JsonValue, field_validator, model_validator

from app import companion_actions as actions
from app import (
    conversation,
    funnel,
    gate,
    history,
    insights,
    muse,
    places,
    reasons,
    refine,
    takeaway,
    widening,
)
from app.answers import QuestionKey as ParseKey
from app.answers import parse as parse_text
from app.auth import current_auth, current_user
from app.categories import CATEGORY_IDS, OTHER
from app.config import get_settings
from app.logs import configure_logging
from app.place_model import place_scores
from app.refine import Change
from app.scoring import Context, History, meal_context, models_for

configure_logging()
PARSE_DEADLINE_S = 13.0
REASONS_DEADLINE_S = 15.0
NOT_SURE = {"status": "not_sure", "answer": None, "source": "none", "reply": None}


class LanguageRoute(APIRoute):
    """Whole endpoint deadline, including request parsing and auth dependencies."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request):
            path = request.url.path
            if path not in ("/reasons", "/answers/parse", "/conversation/parse"):
                return await handler(request)
            seconds = REASONS_DEADLINE_S if path == "/reasons" else PARSE_DEADLINE_S
            try:
                async with asyncio.timeout(seconds):
                    return await handler(request)
            except TimeoutError:
                if path == "/conversation/parse":
                    return JSONResponse({"intents": [{"type": "unknown"}],
                                         "patch": {}, "understood": False})
                return JSONResponse(reasons.EMPTY if path == "/reasons" else NOT_SURE)
            except RequestValidationError:
                if path == "/reasons":
                    return JSONResponse({"detail": "Invalid reasons envelope"}, status_code=400)
                raise

        return bounded


app = FastAPI(title="What to eat! API")
app.router.route_class = LanguageRoute
logger = logging.getLogger(__name__)

# FR-R2 upper clamp: 25 miles.
MAX_RADIUS_M = widening.MAX_RADIUS_M
# ML10: after 3 rounds without a pick, round 4 is the best options so far.
CAP_ROUND = 4
ROUND_BUDGET_S = 7.5


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


@app.get("/insights")
async def get_insights(
    as_of: date,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
    from_date: date | None = None,
    meal_slot: conversation.Slot | None = None,
) -> dict:
    if from_date and from_date > as_of:
        raise HTTPException(422, "Invalid date range")
    return await insights.response(*auth, as_of, client=client,
                                   from_date=from_date, meal_slot=meal_slot)


class TakeawayRequest(BaseModel):
    as_of: date


@app.post("/insights/takeaway")
async def insights_takeaway(
    body: TakeawayRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    return await takeaway.response(*auth, body.as_of, client=client)


@app.get("/places/search")
async def places_search(
    lat: float = Query(ge=-90, le=90),
    lon: float | None = Query(default=None, ge=-180, le=180),
    lng: float | None = Query(default=None, ge=-180, le=180),
    name: str | None = Query(default=None, min_length=1, max_length=80),
    radius_m: int | None = Query(default=None, ge=1, le=MAX_RADIUS_M),
    user_id: str = Depends(current_user),
    client: httpx2.AsyncClient = Depends(get_places_client),
) -> dict:
    """Catering places within radius_m (default PLACES_RADIUS_M). Empty list is a 200."""
    longitude = lng if lng is not None else lon
    if longitude is None or (lng is not None and lon is not None and lng != lon):
        raise HTTPException(422, "Supply one longitude")
    widened = False
    try:
        if name is None:
            result = await places.search(lat, longitude, radius_m, client=client)
        else:
            async with asyncio.timeout(widening.PLACES_BUDGET_S):
                result = await places.search(lat, longitude, radius_m, client=client,
                                             name=name, bias=True)
                matches = places.named_matches(result.places, name)
                if not matches and result.radius_m < MAX_RADIUS_M:
                    widened = True
                    result = await places.search(lat, longitude, MAX_RADIUS_M, client=client,
                                                 name=name, bias=True)
                    matches = places.named_matches(result.places, name)
                result = replace(result, places=matches)
                await quietly(funnel.upsert_places(matches, client=client), "named places")
    except places.PlacesError as e:
        raise places_error(e) from None
    except TimeoutError:
        raise HTTPException(504, "Place lookup timed out") from None
    return {
        "radius_m": result.radius_m,
        "count": len(result.places),
        "truncated": result.truncated,
        "places": [{k: v for k, v in asdict(p).items() if k != "brand" or v is not None}
                   for p in result.places],
        **({"widened": widened, "presentation": "nearby"} if name is not None else {}),
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
    # FR3 distance chips: 15000 Close to me, 35000 I don't mind. Legacy 1500 / 5000 (before
    # P1-19) are still accepted and read as Close to me.
    radius_m: Literal[1500, 5000, 15000, 35000] | None = None
    exclude_ids: list[str] = Field(default_factory=list, max_length=100)
    # Current answers from the chat ("not burgers"); a follow-up's change is in refine.
    exclude_categories: list[str] = Field(default_factory=list, max_length=len(refine.CRAVINGS))
    refine: Change | None = None  # a follow-up (chip or parsed text), applied here
    # The user tapped "None of these" on the previous round before this follow-up (P2-05):
    # its cards are logged as rejected with none_of_these first in the reason.
    none_of_these: bool = False
    session_id: UUID | None = None  # omitted on round 1; later rounds continue the session
    timezone: str | None = Field(default=None, max_length=64)  # device IANA zone
    solo: bool | None = None
    companion_ids: list[UUID] = Field(default_factory=list)
    transcript: list[TranscriptMessage] = Field(default_factory=list, max_length=40)
    survey: conversation.Survey | None = None
    # Round 1 (P2-05): the question order the phone used and where it came from ("plan" or
    # "fallback"). Loosely typed on purpose: a bad value is logged as invalid, never refused.
    asked_order: list[JsonValue] | None = Field(default=None, max_length=10)
    plan_source: JsonValue = None
    # Round 1 trace: the plan's pre-fills as the phone received them, and the chips it showed
    # selected at each answer. Loosely typed like the two above.
    prefilled: JsonValue = None
    company_prefilled: JsonValue = None

    @model_validator(mode="after")
    def consistent_company(self):
        if self.solo is True and self.companion_ids:
            raise ValueError("solo cannot include companions")
        return self

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


async def quietly(coro, what: str, *, deadline: float | None = None):
    """Runs a logging write. On any failure: logs the error type only and returns None."""
    try:
        if deadline is None:
            result = await coro
        else:
            async with asyncio.timeout(max(0.0, deadline - time.perf_counter())):
                result = await coro
    except Exception as e:
        logger.warning("Funnel %s failed: %s", what, type(e).__name__)
        return None
    return True if result is None else result


async def load_history(
    user_id: str, token: str, client: httpx2.AsyncClient, *, include_companions: bool = True,
) -> History | None:
    """History, or None on any failure (the round goes on as a cold start)."""
    try:
        return await history.load(user_id, token, client=client,
                                  include_companions=include_companions)
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
    deadline = started + ROUND_BUDGET_S
    user_id, token = auth
    if body.survey is not None:
        s = body.survey
        body.craving, body.budget_level, body.radius_m = (
            s.craving.value, s.budget.value, s.distance.value)
        body.exclude_categories = s.exclusions
        body.solo = True if s.company.value == "solo" else False if s.company.value else None
        body.companion_ids = ([UUID(x) for x in s.company.value]
                              if isinstance(s.company.value, list) else [])
    default_radius = get_settings().PLACES_RADIUS_M
    current = refine.Answers(body.craving, body.budget_level, refine.chip_radius(body.radius_m),
                             tuple(body.exclude_categories))
    applied = (refine.apply(body.refine, current, default_radius) if body.refine
               else refine.Applied(current, ()))
    answers = applied.answers
    radius = answers.radius_m or default_radius
    places_budget = widening.PlacesBudget()
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
        companion_ids=frozenset(str(c) for c in body.companion_ids),
        company_confirmed=bool(body.survey and body.survey.company.status == "confirmed"
                               and body.survey.company.source in ("chip", "typed")),
    )
    session_id = str(body.session_id) if body.session_id else None
    opening = quietly(
        funnel.open_round(user_id, token, session_id, new_session, client=client), "session",
        deadline=deadline,
    )
    try:
        if session_id is None:
            result, loaded, ref = await asyncio.gather(
                places_budget.search(body.lat, body.lon, radius, client=client),
                load_history(user_id, token, client),
                opening,
            )
        else:
            # The session read decides the round (and whether it is the cap) before searching.
            loaded, ref = await asyncio.gather(
                load_history(user_id, token, client, include_companions=False), opening
            )
            if ref and ref.closed:
                raise HTTPException(status.HTTP_409_CONFLICT, "Session already has an outcome")
            if ref and ref.round == CAP_ROUND and not body.answered_open_question():
                return await best_so_far_round(
                    body, user_id, token, ref, applied, new_session, loaded, started,
                    client=client,
                )
            result = await places_budget.search(body.lat, body.lon, radius, client=client)
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
        companion_ids=frozenset(str(c) for c in body.companion_ids),
        craving=answers.craving,
        budget_level=answers.budget_level,
        radius_m=radius,
        exclude_ids=frozenset(body.exclude_ids) | shown_before,
        exclude_categories=frozenset(answers.exclude_categories),
    )
    user_history = loaded or History()
    models = models_for(user_history, context)
    widened = await widening.widen(result, places_budget, context, user_history, models,
                                   client=client)
    result, context = widened.result, widened.context
    ranking, merged_ids = widened.ranking, widened.merged_ids
    new_session = replace(new_session, search_radius_m=result.radius_m)
    shown = [pick.scored.place for pick in ranking.top3]
    # P2-05 (ML10 v2): the next question by information gain, from the same models.
    chosen = gate.next_question(
        ranking, context, user_history, merged_ids, models,
        gate.predict_budget(user_history, slot, is_weekend, local_date),
    )
    # Cache places before shown events; language enhancement is a separate request.
    # The transcript and a later round's follow-up writes go alongside them.
    template_lines = tuple(muse.template_reason(p) for p in ranking.top3)
    cached, saved, followed, gated, _ = await asyncio.gather(
        quietly(funnel.upsert_places(shown, client=client), "places", deadline=deadline)
        if ref
        else asyncio.sleep(0),
        log_transcript(user_id, token, ref, body, client, deadline=deadline)
        if ref else asyncio.sleep(0),
        log_follow_up(user_id, token, ref, new_session, reject_tags(body, applied), client,
                      deadline=deadline)
        if ref
        else asyncio.sleep(0),
        # sessions.gate: never part of `logged`, so a failure loses only the gate entry.
        log_gate(token, ref, chosen.as_log(),
                 round_one_plan(body, user_history, slot, is_weekend, local_date)
                 if ref.round == 1 else None, client, deadline=deadline)
        if ref
        else asyncio.sleep(0),
        quietly(funnel.update_search_radius(user_id, token, ref.session_id, result.radius_m,
                                           client=client), "search radius", deadline=deadline)
        if ref and ref.round == 1 and result.radius_m != radius
        else asyncio.sleep(0),
    )
    logged = bool(
        ref
        and cached
        and saved
        and followed
        and await quietly(
            funnel.log_shown(
                user_id, token, ref, ranking.top3, template_lines, muse.TEMPLATE,
                budget_level=answers.budget_level, company=company_snapshot(body), client=client
            ),
            "shown",
            deadline=deadline,
        )
    )

    logger.info(
        "Recommendations round in %d ms (reasons: %s)",
        (time.perf_counter() - started) * 1000,
        muse.TEMPLATE,
    )
    return {
        "session_id": ref.session_id if ref else session_id,
        "round": ref.round if ref else None,
        "logged": logged,
        "gate_logged": bool(gated),
        "history_used": loaded is not None,
        "reasons_source": muse.TEMPLATE,
        "reasons_envelope": reasons.envelope(
            user_id, ref.session_id if ref else None, ref.round if ref else None, ranking.top3),
        "cold_start": ranking.cold_start,
        "radius_m": result.radius_m,
        "truncated": result.truncated,
        "best_so_far": False,
        "answers": answers_out(answers),
        "next_question": chosen.as_dict(),
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
            for pick, reason in zip(ranking.top3, template_lines, strict=True)
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


def company_snapshot(body: RecommendationsRequest) -> dict:
    confirmed = bool(body.survey and body.survey.company.status == "confirmed"
                     and body.survey.company.source in ("chip", "typed"))
    return {"confirmed": confirmed, "solo": body.solo if confirmed else None,
            "companion_ids": [str(cid) for cid in body.companion_ids] if confirmed else []}


async def log_transcript(
    user_id: str, token: str, ref: funnel.RoundRef, body: RecommendationsRequest,
    client: httpx2.AsyncClient, *, deadline: float | None = None,
):
    transcript = [m.model_dump() for m in body.transcript]
    return await quietly(
        funnel.log_messages(user_id, token, ref, transcript, client=client), "messages",
        deadline=deadline,
    )


def round_one_plan(
    body: RecommendationsRequest, user_history: History, slot: str, is_weekend: bool,
    local_date: date,
) -> dict:
    """Round 1's plan log: the plan recomputed from the same history and context as
    /questions/plan, and next to it what the phone actually asked (gate.asked_log)."""
    if body.survey is not None:
        return {"protocol": 2, "survey": body.survey.model_dump(),
                "question_count": len(body.survey.asked)}
    recomputed = gate.plan(user_history, slot, is_weekend, local_date,
                           new_search=body.plan_source == "new_search")
    asked = gate.asked_log(body.asked_order, body.plan_source, recomputed)
    asked["prefilled"] = gate.prefilled_log(body.prefilled)
    if "company_prefilled" in body.model_fields_set:
        asked["company_prefilled"] = gate.company_prefilled_log(body.company_prefilled)
    return {**recomputed.as_log(), "asked": asked}


async def log_gate(
    token: str, ref: funnel.RoundRef, entry: dict, plan_log: dict | None,
    client: httpx2.AsyncClient, *, deadline: float | None = None,
):
    """This round's gate entry; round 1 adds the plan log. True when written, None on any
    failure (logged, not raised)."""
    return await quietly(
        funnel.append_gate(token, ref.session_id, ref.round, entry, plan_log, client=client),
        "gate",
        deadline=deadline,
    )


def reject_tags(body: RecommendationsRequest, applied: refine.Applied) -> tuple[str, ...]:
    """What the previous round's rejected cards are logged with: none_of_these first when the
    user tapped it, then what the follow-up changed."""
    return (("none_of_these",) if body.none_of_these else ()) + applied.tags


async def log_follow_up(
    user_id: str, token: str, ref: funnel.RoundRef, new: funnel.NewSession,
    tags: tuple[str, ...], client: httpx2.AsyncClient, *, deadline: float | None = None,
) -> bool:
    """Later rounds: the session's current answers, and the previous round's cards as
    rejected with what changed (never the user's text). True when both were written."""
    if ref.round == 1:
        return True
    previous = ref.round - 1
    results = await asyncio.gather(
        quietly(funnel.update_answers(user_id, token, ref.session_id, new, client=client),
                "answers", deadline=deadline),
        quietly(funnel.log_rejected(user_id, token, ref.session_id, previous,
                                    ref.shown_in(previous), refine.reject_reason(tags),
                                    client=client),
                "rejected", deadline=deadline),
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
    deadline = started + ROUND_BUDGET_S
    answers = applied.answers
    user_history = loaded or History()
    known = {
        pid: s.known_price_level
        for pid, s in place_scores(user_history, as_of=new.local_date).items()
    }
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
    saved, followed, gated = await asyncio.gather(
        log_transcript(user_id, token, ref, body, client, deadline=deadline),
        log_follow_up(user_id, token, ref, new, reject_tags(body, applied), client,
                      deadline=deadline),
        log_gate(token, ref, gate.CAP_ENTRY, None, client, deadline=deadline),
    )
    logged = bool(
        saved
        and followed
        and await quietly(funnel.log_shown_rows(user_id, token, ref, cards,
                                               budget_level=answers.budget_level,
                                               company=company_snapshot(body), client=client),
                          "shown", deadline=deadline)
    )
    logger.info(
        "Best-so-far round in %d ms (%d cards)", (time.perf_counter() - started) * 1000, len(best)
    )
    return {
        "session_id": ref.session_id,
        "round": ref.round,
        "logged": logged,
        "gate_logged": bool(gated),
        "history_used": loaded is not None,
        "reasons_source": "stored",
        "cold_start": False,
        "radius_m": new.search_radius_m,
        "truncated": False,
        "best_so_far": True,
        "answers": answers_out(answers),
        "next_question": None,  # the cap asks the open question (ML10)
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


@app.post("/reasons")
async def enhance_reasons(
    body: reasons.Envelope,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    return await reasons.response(body, *auth, client=client)


# The 3 questions (P2-05, FR4, ML6) -------------------------------------------


class PlanRequest(BaseModel):
    new_search: bool = False
    local_time: datetime  # the device's local time; sets the meal slot and date


@app.post("/questions/plan")
async def question_plan(
    body: PlanRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client),
) -> dict:
    """The confidence gate: the 3 questions in asking order, weak first, confident ones with a
    pre-selected chip. History only: no places search, no Muse call. History failure = the
    cold start plan (craving, budget, distance), never a 5xx."""
    user_id, token = auth
    loaded = await load_history(user_id, token, client)
    slot, local_date, is_weekend = meal_context(body.local_time)
    chosen = gate.plan(loaded or History(), slot, is_weekend, local_date,
                       new_search=body.new_search)
    return {
        "history_used": loaded is not None,
        "meal_slot": slot,
        **chosen.as_log(),
    }


# Answer parsing (P1-21 FR5, P1-14) --------------------------------------------


class CompanionParseRequest(conversation.Strict):
    text: str = Field(min_length=1, max_length=200)
    asked: conversation.Key | None = None
    companion_refs: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("companion_refs")
    @classmethod
    def placeholders(cls, values):
        if values != [f"companion_{i+1}" for i in range(len(values))]:
            raise ValueError("Only anonymous companion references are allowed")
        return values


@app.post("/conversation/parse")
async def companion_parse(body: CompanionParseRequest,
    user_id: str = Depends(current_user), client: httpx2.AsyncClient = Depends(get_http_client)):
    return await conversation.parse(body.text, body.asked, body.companion_refs, client=client)


class CompanionPlanRequest(BaseModel):
    model_config = {"extra": "forbid"}
    local_time: datetime
    state: conversation.Survey = Field(default_factory=conversation.Survey)
    patch: conversation.Patch | None = None
    source: Literal["chip", "typed"] = "typed"
    companion_ids: list[UUID] = Field(default_factory=list, max_length=20)
    conversation_id: UUID | None = None
    recommend_now: bool = False


@app.post("/conversation/plan")
async def companion_plan(body: CompanionPlanRequest,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    user_id, token = auth
    loaded = await load_history(user_id, token, client)
    h = loaded or History()
    ids = [str(cid) for cid in body.companion_ids]
    if ids and (loaded is None or not set(ids) <= h.companions):
        raise HTTPException(422, "Companions unavailable; choose Solo or retry")
    if body.patch and body.patch.unmatched:
        logger.info("Unmatched request categories: %s", sorted(set(body.patch.unmatched)))
    state = body.state
    try:
        if body.patch is not None:
            state = conversation.apply_patch(state, body.patch, body.source, ids)
        if isinstance(state.company.value, list) and not set(state.company.value) <= h.companions:
            raise ValueError("unknown companion")
    except ValueError:
        raise HTTPException(422, "Couldn't apply that answer") from None
    state.recommend_now = state.recommend_now or body.recommend_now
    slot, day, weekend = meal_context(body.local_time)
    result = conversation.decide(state, h, slot, weekend, day)
    return {**result, "conversation_id": str(body.conversation_id or uuid4()),
            "history_used": loaded is not None}


@app.get("/conversation/meals")
async def companion_meals(reference: Literal["last", "food", "date"] = "last",
    category: str | None = None, eaten_on: date | None = None,
    slot: conversation.Slot | None = None, auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    return await actions.meals(*auth, client, reference=reference, category=category,
                              eaten_on=eaten_on.isoformat() if eaten_on else None, slot=slot)


@app.get("/conversation/profile")
async def companion_profile(auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    return await actions.profile(*auth, client)


@app.get("/conversation/context")
async def companion_context(user_id: str = Depends(current_user)):
    return {"conversation_id": str(uuid4())}


class HistoryQuery(BaseModel):
    range: conversation.Range
    chart_id: conversation.Chart
    slot: conversation.Slot | None = None
    timezone: str = Field(max_length=64)


@app.post("/conversation/history")
async def companion_history(body: HistoryQuery, auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    try:
        today = datetime.now(ZoneInfo(body.timezone)).date()
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(422, "Unknown timezone") from None
    start, end = conversation.date_range(body.range, today)
    stats = await insights.response(*auth, end, client=client, from_date=start, meal_slot=body.slot)
    facts, _ = takeaway.build_facts(stats)
    fact_type = {"top": "category_count", "food": "category_count", "price": "price_level_count",
                 "distance": "distance_median", "companions": "companion_count"}[body.chart_id]
    fact = next((f for f in facts if f["type"] == fact_type), None)
    # Factual fallback is sufficient: no extra Muse call to acknowledge a read or chip.
    line = (takeaway.template(fact) if fact and fact_type != "companion_count" else
            f"{stats['summary']['meal_count']} recorded meals.")
    return {"stats": stats, "chart_id": body.chart_id, "from_date": start.isoformat(),
            "to_date": end.isoformat(), "line": line,
            "note": None if stats["complete"] else "Loaded history only; some data is missing."}


class ManualCorrection(BaseModel):
    revision: int = Field(ge=0)
    changes: actions.MealChanges
    confirmed: Literal[True]


async def manual_action(kind, arguments, key, auth, client):
    context = str(uuid5(NAMESPACE_URL, auth[0] + ":manual:" + kind))
    prepared = await actions.rpc("prepare_companion_action", {"p_conversation_id": context,
        "p_client_key": key, "p_kind": kind, "p_arguments": arguments}, auth[1], client)
    if prepared["arguments"] != arguments:
        raise HTTPException(409, "This record changed; reload")
    return await actions.rpc("confirm_companion_action", {"p_id": prepared["id"],
        "p_conversation_id": context, "p_arguments": arguments}, auth[1], client)


@app.post("/meals/{meal_id}/correct")
async def correct_meal(meal_id: UUID, body: ManualCorrection,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    arguments = {"meal_id": str(meal_id), "revision": body.revision,
                 "changes": body.changes.model_dump(exclude_unset=True)}
    return await manual_action("edit_meal", arguments, f"{meal_id}:{body.revision}", auth, client)


@app.post("/profile/preferences")
async def save_preferences(body: actions.ProfileDraft,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    if body.source != "profile":
        raise HTTPException(422, "Use the chat confirmation card")
    return await manual_action("preference_change", body.model_dump(), body.expected_updated_at,
                               auth, client)


@app.post("/conversation/actions/prepare")
async def companion_prepare(body: actions.Prepare, auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    try:
        arguments = body.checked()
    except ValueError:
        raise HTTPException(422, "Check the highlighted action fields") from None
    return await actions.rpc("prepare_companion_action", {
        "p_conversation_id": body.conversation_id, "p_client_key": body.client_key,
        "p_kind": body.kind, "p_arguments": arguments}, auth[1], client)


@app.post("/conversation/actions/confirm")
async def companion_confirm(body: actions.Confirmation,
    auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    return await actions.rpc("confirm_companion_action", {"p_id": body.action_id,
        "p_conversation_id": body.conversation_id, "p_arguments": body.arguments}, auth[1], client)


class CancelAction(BaseModel):
    action_id: UUID | None = None
    conversation_id: UUID


@app.post("/conversation/actions/cancel")
async def companion_cancel(body: CancelAction, auth: tuple[str, str] = Depends(current_auth),
    client: httpx2.AsyncClient = Depends(get_http_client)):
    await actions.rpc("cancel_companion_action", {
        "p_id": str(body.action_id) if body.action_id else None,
        "p_conversation_id": str(body.conversation_id)}, auth[1], client)
    return {"cancelled": True}


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
        meal_id = await funnel.log_pick(user_id, token, str(session_id), body.round, body.place_id,
                                        client=client)
    except funnel.FunnelError as e:
        raise funnel_error(e) from None
    # Additive identity lets callers verify that an exact retry refers to the same meal.
    return {"logged": True, "meal_id": meal_id}


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
