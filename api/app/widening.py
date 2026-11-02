"""Bounded widening for recommendations only; the Map's Places search stays unchanged."""

import asyncio
import logging
from dataclasses import dataclass, replace
from time import monotonic

import httpx2

from app import places
from app.scoring import Context, History, Models, Ranking, merge_candidates, rank

MAX_RADIUS_M = 40_234
PLACES_BUDGET_S = 4.0
MIN_CANDIDATES = 8
MAX_EXPANSIONS = 2
logger = logging.getLogger(__name__)


@dataclass
class PlacesBudget:
    """Sum only Places call durations, including the initial call's time."""

    used_s: float = 0.0

    async def search(
        self, lat: float, lon: float, radius_m: int, *, client: httpx2.AsyncClient,
    ) -> places.SearchResult:
        remaining = PLACES_BUDGET_S - self.used_s
        if remaining <= 0:
            raise places.PlacesTimeout
        started = monotonic()
        try:
            async with asyncio.timeout(remaining):
                return await places.search(lat, lon, min(radius_m, MAX_RADIUS_M),
                                           bias=True, client=client)
        except TimeoutError:
            raise places.PlacesTimeout from None
        finally:
            self.used_s += monotonic() - started


@dataclass(frozen=True)
class Widened:
    result: places.SearchResult
    context: Context
    ranking: Ranking
    merged_ids: frozenset[str]


async def widen(
    result: places.SearchResult, budget: PlacesBudget, context: Context, history: History,
    models: Models, *, client: httpx2.AsyncClient,
) -> Widened:
    """Count the real ranking's eligible candidates; keep successful results on failure."""
    for expansion in range(MAX_EXPANSIONS + 1):
        context = replace(context, search_radius_m=result.radius_m)
        candidates, merged_ids = merge_candidates(result.places, history, context)
        ranking = rank(candidates, context, history, merged_ids, models)
        radius = min(round(result.radius_m * 1.5), MAX_RADIUS_M)
        if (len(ranking.ranked) >= MIN_CANDIDATES or expansion == MAX_EXPANSIONS
                or radius == result.radius_m or budget.used_s >= PLACES_BUDGET_S):
            break
        try:
            wider = await budget.search(context.lat, context.lon, radius, client=client)
        except places.PlacesError as error:
            logger.warning("Places widening failed: %s", type(error).__name__)
            break
        # A wider response may omit earlier places at the upstream limit; keep both sets.
        # Prefer the wider response, using the single-search rule for IDs and shared spots.
        result = places.SearchResult(wider.radius_m, wider.truncated,
                                     places.deduplicate([*wider.places, *result.places]))
    return Widened(result, context, ranking, merged_ids)
