import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import datetime
from typing import Literal

import httpx2
from fastapi import Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app import history, muse, places
from app.auth import current_auth, current_user
from app.categories import CATEGORY_IDS, OTHER
from app.config import get_settings
from app.scoring import Context, History, meal_context, merge_candidates, rank

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


class RecommendationsRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    local_time: datetime  # the device's local time; sets the meal slot and date
    craving: str | None = None  # ML2 category id
    budget_level: int | None = Field(default=None, ge=1, le=4)
    radius_m: Literal[1500, 5000, 15000] | None = None  # FR3 distance chips
    exclude_ids: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("craving")
    @classmethod
    def known_craving(cls, value: str | None) -> str | None:
        if value is not None and (value not in CATEGORY_IDS or value == OTHER):
            raise ValueError("unknown category")
        return value


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
    try:
        result, loaded = await asyncio.gather(
            places.search(body.lat, body.lon, radius, client=client),
            load_history(user_id, token, client),
        )
    except places.PlacesError as e:
        raise places_error(e) from None

    slot, local_date, is_weekend = meal_context(body.local_time)
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
    reasons = await muse.write_reasons(ranking.top3, client=client)

    logger.info(
        "Recommendations round in %d ms (reasons: %s)",
        (time.perf_counter() - started) * 1000,
        reasons.source,
    )
    return {
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
