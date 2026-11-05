"""Bounded widening for recommendations only; the Map's Places search stays unchanged."""

import asyncio
import json
import logging
from dataclasses import dataclass, replace
from time import monotonic

import httpx2

from app import places
from app.config import get_settings
from app.scoring import Context, History, Models, Ranking, merge_candidates, rank

MAX_RADIUS_M = 40_234
PLACES_BUDGET_S = 4.0  # existing named-place lookup budget; never used by recommendations
INITIAL_PLACES_BUDGET_S = 8.0
WIDENING_BUDGET_S = 2.0  # shared by both optional expansions, never borrowed from initial
RECOMMENDATION_PLACES_BUDGET_S = INITIAL_PLACES_BUDGET_S + WIDENING_BUDGET_S
MIN_CANDIDATES = 8
MAX_EXPANSIONS = 2
logger = logging.getLogger(__name__)


@dataclass
class PlacesBudget:
    """Separate initial and optional allowances; used_s still reports their total."""

    used_s: float = 0.0
    request_id: str | None = None  # random, per request; never a session or user identity
    source: str = "unknown"
    calls: int = 0
    widening_used_s: float = 0.0

    async def search(
        self, lat: float, lon: float, radius_m: int, *, client: httpx2.AsyncClient,
        required_craving: str | None = None,
    ) -> places.SearchResult:
        if required_craving and required_craving not in places.CUISINE_CATEGORIES:
            return places.SearchResult(min(radius_m, MAX_RADIUS_M), False, [])
        stage = "initial" if self.calls == 0 else "widening"
        remaining = min(get_settings().RECOMMENDATION_PLACES_TIMEOUT_S,
                        INITIAL_PLACES_BUDGET_S if stage == "initial"
                        else WIDENING_BUDGET_S - self.widening_used_s)
        if remaining <= 0:
            raise places.PlacesTimeout
        started = monotonic()
        self.calls += 1
        outcome, result = "cancelled", None
        try:
            async with asyncio.timeout(remaining):
                result = await places.search(lat, lon, min(radius_m, MAX_RADIUS_M),
                                             bias=True, client=client,
                                             required_craving=required_craving,
                                             timeout_s=remaining)
            outcome = "success"
            return result
        except TimeoutError:
            outcome = "shared_budget_timeout"
            raise places.PlacesTimeout from None
        except places.PlacesError as error:
            outcome = ("provider_timeout" if isinstance(error, places.PlacesTimeout)
                       else type(error).__name__)
            raise
        finally:
            elapsed = max(0.0, monotonic() - started)
            self.used_s += elapsed
            if stage == "widening":
                self.widening_used_s += elapsed
            logger.info("Recommendation search: %s", json.dumps({
                "request_id": self.request_id, "source": self.source, "stage": stage,
                "call": self.calls, "targeted": required_craving is not None,
                "outcome": outcome, "elapsed_ms": round(elapsed * 1000),
                "remaining_ms": round(remaining * 1000),
                "used_ms": round(self.used_s * 1000),
                "candidates": len(result.places) if result is not None else 0,
            }, separators=(",", ":")))


@dataclass(frozen=True)
class Widened:
    result: places.SearchResult
    context: Context
    ranking: Ranking
    merged_ids: frozenset[str]
    search_status: str = "complete"


async def widen(
    result: places.SearchResult, budget: PlacesBudget, context: Context, history: History,
    models: Models, *, client: httpx2.AsyncClient,
) -> Widened:
    """Count the real ranking's eligible candidates; keep successful results on failure."""
    unsupported = (context.required_craving is not None
                   and context.required_craving not in places.CUISINE_CATEGORIES)
    search_status = "unsupported_category" if unsupported else "complete"
    for expansion in range(MAX_EXPANSIONS + 1):
        context = replace(context, search_radius_m=result.radius_m)
        candidates, merged_ids = merge_candidates(result.places, history, context)
        ranking = rank(candidates, context, history, merged_ids, models)
        radius = min(round(result.radius_m * 1.5), MAX_RADIUS_M)
        if (unsupported or len(ranking.ranked) >= MIN_CANDIDATES or expansion == MAX_EXPANSIONS
                or radius == result.radius_m or budget.widening_used_s >= WIDENING_BUDGET_S):
            if (len(ranking.ranked) < MIN_CANDIDATES and expansion < MAX_EXPANSIONS
                    and radius != result.radius_m
                    and budget.widening_used_s >= WIDENING_BUDGET_S):
                search_status = "incomplete"
            break
        try:
            wider = await budget.search(context.lat, context.lon, radius, client=client,
                                        required_craving=context.required_craving)
        except places.PlacesError as error:
            logger.warning("Places widening failed: %s", type(error).__name__)
            search_status = ("timeout" if isinstance(error, places.PlacesTimeout)
                             else "provider_error")
            break
        # A wider response may omit earlier places at the upstream limit; keep both sets.
        # Prefer the wider response, using the single-search rule for IDs and shared spots.
        result = places.SearchResult(wider.radius_m, wider.truncated,
                                     places.deduplicate([*wider.places, *result.places]))
    return Widened(result, context, ranking, merged_ids, search_status)
