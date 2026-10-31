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

from app import funnel, history, muse, places
from app.auth import current_auth, current_user
from app.categories import CATEGORY_IDS, OTHER
from app.config import get_settings
from app.logs import configure_logging
from app.scoring import Context, History, meal_context, merge_candidates, rank

configure_logging()
app = FastAPI(title="What to eat! API")
logger = logging.getLogger(__name__)

# FR-R2 upper clamp: 25 miles.
MAX_RADIUS_M = 40_234


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
    answer: dict[str, str | int | bool | None] | None = Field(default=None, max_length=5)
    input_mode: Literal["chip", "text", "voice", "prefill"] | None = None


class RecommendationsRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    local_time: datetime  # the device's local time; sets the meal slot and date
    craving: str | None = None  # ML2 category id
    budget_level: int | None = Field(default=None, ge=1, le=4)
    radius_m: Literal[1500, 5000, 15000] | None = None  # FR3 distance chips
    exclude_ids: list[str] = Field(default_factory=list, max_length=100)
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
    """One round (FR7, NFR4): places + history in parallel, merge, rank, one Muse call."""
    started = time.perf_counter()
    user_id, token = auth
    radius = body.radius_m or get_settings().PLACES_RADIUS_M
    slot, local_date, is_weekend = meal_context(body.local_time)
    new_session = funnel.NewSession(
        timezone=body.timezone or offset_zone(body.local_time),
        local_date=local_date,
        meal_slot=slot,
        lat=body.lat,
        lon=body.lon,
        craving=body.craving,
        budget_level=body.budget_level,
        radius_m=body.radius_m,
        search_radius_m=radius,
        solo=body.solo,
    )
    session_id = str(body.session_id) if body.session_id else None
    try:
        result, loaded, ref = await asyncio.gather(
            places.search(body.lat, body.lon, radius, client=client),
            load_history(user_id, token, client),
            quietly(
                funnel.open_round(user_id, token, session_id, new_session, client=client),
                "session",
            ),
        )
    except places.PlacesError as e:
        raise places_error(e) from None

    context = Context(
        lat=body.lat,
        lon=body.lon,
        local_date=local_date,
        meal_slot=slot,
        is_weekend=is_weekend,
        search_radius_m=result.radius_m,
        craving=body.craving,
        budget_level=body.budget_level,
        radius_m=body.radius_m,
        exclude_ids=frozenset(body.exclude_ids),
    )
    user_history = loaded or History()
    candidates, merged_ids = merge_candidates(result.places, user_history, context)
    ranking = rank(candidates, context, user_history, merged_ids)
    shown = [pick.scored.place for pick in ranking.top3]
    # The shown places are cached while Muse writes; the events need their rows.
    # The transcript is written alongside them.
    transcript = [m.model_dump() for m in body.transcript]
    reasons, cached, saved = await asyncio.gather(
        muse.write_reasons(ranking.top3, client=client),
        quietly(funnel.upsert_places(shown, client=client), "places")
        if ref
        else asyncio.sleep(0),
        quietly(funnel.log_messages(user_id, token, ref, transcript, client=client), "messages")
        if ref
        else asyncio.sleep(0),
    )
    logged = bool(
        ref
        and cached
        and saved
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
