"""Layer 2, place model (P2-10, ML4): history -> a return score per visited place.

Pure functions, no I/O, no clock: the caller passes as_of. Only meals eaten before as_of
count, so a time-ordered replay (ML9) never sees the meal it predicts. Same conventions as
app/cuisine_model.py.

A visit is a counted meal at a resolved place: backfill, or live with went = true (no food
answer needed). Unresolved places (place = None) are skipped.
  familiarity  = 1 - exp(-W / FAMILIARITY_SCALE), W = the sum of visit recency weights
  star factor  = STAR_FACTOR at the recency-weighted mean of the place's stars (interpolated),
                 STAR_UNKNOWN when it has no ratings. 1-2 stars are negative, so a low-rated
                 place scores below a new place (0).
  return score = familiarity * star factor, in [-1, 1]. Never visited = 0.
Stars come from live use only (backfill has none).

Constants are in app/scoring_rules.py, fixed before evaluation and never tuned on it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING

from app.cuisine_model import recency_weight
from app.scoring_rules import FAMILIARITY_SCALE, STAR_FACTOR, STAR_UNKNOWN

if TYPE_CHECKING:
    from app.scoring import History, PastMeal


@dataclass(frozen=True)
class PlaceScore:
    return_score: float
    visits: int  # raw visits before as_of
    weighted_visits: float  # W, the sum of recency weights
    last_visit_days: int  # days from the most recent visit to as_of (>= 1)
    stars_mean: float | None  # recency-weighted mean of the user's stars; None = no ratings
    known_price_level: int | None  # most recent known price at this place


def is_visit(meal: PastMeal, as_of: date) -> bool:
    if meal.place is None or meal.eaten_on >= as_of:
        return False
    return meal.source == "backfill" or (meal.source == "live" and meal.went is True)


def familiarity(weighted_visits: float) -> float:
    return 1 - math.exp(-weighted_visits / FAMILIARITY_SCALE)


def star_factor(stars_mean: float | None) -> float:
    """STAR_FACTOR at the mean, linear between whole stars; no ratings = STAR_UNKNOWN."""
    if stars_mean is None:
        return STAR_UNKNOWN
    s = min(5.0, max(1.0, stars_mean))
    low = math.floor(s)
    if low == s:
        return STAR_FACTOR[low]
    return STAR_FACTOR[low] + (s - low) * (STAR_FACTOR[low + 1] - STAR_FACTOR[low])


def place_scores(history: History, as_of: date) -> dict[str, PlaceScore]:
    visits: dict[str, list[tuple[PastMeal, float]]] = {}
    for meal in history.meals:
        if is_visit(meal, as_of):
            w = recency_weight((as_of - meal.eaten_on).days)
            visits.setdefault(meal.place.id, []).append((meal, w))

    scores: dict[str, PlaceScore] = {}
    for pid, items in visits.items():
        items.sort(key=lambda mw: mw[0].eaten_on, reverse=True)  # newest first, stable
        total = sum(w for _, w in items)
        rated = [(m.stars, w) for m, w in items if m.stars is not None]
        stars_mean = sum(s * w for s, w in rated) / sum(w for _, w in rated) if rated else None
        known = next((m.price_level for m, _ in items if m.price_level is not None), None)
        scores[pid] = PlaceScore(
            return_score=familiarity(total) * star_factor(stars_mean),
            visits=len(items),
            weighted_visits=total,
            last_visit_days=(as_of - items[0][0].eaten_on).days,
            stars_mean=stars_mean,
            known_price_level=known,
        )
    return scores
