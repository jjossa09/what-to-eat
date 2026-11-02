"""Layer 1, cuisine model (P2-02, ML3): history + context -> a probability per category.

Pure functions, no I/O, no clock: the caller passes as_of. Only meals eaten before as_of
count, so a time-ordered replay (ML9, P2-13) never sees the meal it predicts.

Recency-weighted counts per context, each level smoothed toward the broader one:
  quiz:          the quiz prior (favorites share 0.7, other allowed categories 0.3)
  user:          all counted meals, smoothed toward quiz
  slot:          same meal slot, smoothed toward user
  slot_weekend:  same meal slot and weekday/weekend, smoothed toward slot
p(c) = (weighted count of c + K * parent p(c)) / (weighted n + K).

P2-07 hook: the companion level goes after slot_weekend in context_levels() (this companion,
same slot and weekday/weekend), smoothed toward slot_weekend. Nothing else changes.

Constants are in app/scoring_rules.py, fixed before evaluation and never tuned on it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING

from app.categories import CATEGORY_IDS, OTHER
from app.scoring_rules import (
    HALF_LIFE_DAYS,
    LEVEL_MIN_N_EFF,
    QUIZ_FAVORITES_MASS,
    SMOOTHING_K,
)

if TYPE_CHECKING:
    from app.scoring import Context, History, PastMeal

# Other is shown but never predicted (ML2).
PREDICTABLE: tuple[str, ...] = tuple(c for c in CATEGORY_IDS if c != OTHER)

QUIZ, USER, SLOT, SLOT_WEEKEND = "quiz", "user", "slot", "slot_weekend"


@dataclass(frozen=True)
class CuisinePrediction:
    probs: dict[str, float]  # every predictable category; hard no's are 0; sums to 1
    n_eff: float  # recency-weighted meals behind the reported level
    meals: int  # raw meals behind the reported level
    level: str  # deepest level with n_eff >= LEVEL_MIN_N_EFF ("quiz" when none)
    # User level, unsmoothed: raw counted meals and recency-weighted share per category.
    # For usual categories (ML5) and evidence; never n_eff rounded.
    user_counts: dict[str, int]
    user_shares: dict[str, float]

    @property
    def user_meals(self) -> int:
        return sum(self.user_counts.values())


def recency_weight(age_days: int) -> float:
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def is_weekend(meal: PastMeal) -> bool:
    if meal.is_weekend is not None:
        return meal.is_weekend
    return meal.eaten_on.isoweekday() >= 6


def counts(meal: PastMeal, as_of: date, hard_nos: frozenset[str]) -> bool:
    """Backfill always; live only with a food answer (history loads live meals with went =
    true only). The meal's category is the food eaten, never Other or a hard no."""
    if meal.eaten_on >= as_of:
        return False
    if meal.category_id not in PREDICTABLE or meal.category_id in hard_nos:
        return False
    return meal.source == "backfill" or (meal.source == "live" and meal.food_answered)


def quiz_prior(favorites: frozenset[str], hard_nos: frozenset[str]) -> dict[str, float]:
    """Favorites share QUIZ_FAVORITES_MASS, other allowed categories the rest, hard no's 0.
    No quiz (no favorites): uniform over the allowed categories."""
    allowed = [c for c in PREDICTABLE if c not in hard_nos]
    favs = [c for c in allowed if c in favorites]
    rest = [c for c in allowed if c not in favorites]
    probs = dict.fromkeys(PREDICTABLE, 0.0)
    if favs and rest:
        for c in favs:
            probs[c] = QUIZ_FAVORITES_MASS / len(favs)
        for c in rest:
            probs[c] = (1 - QUIZ_FAVORITES_MASS) / len(rest)
    else:
        for c in favs or rest:
            probs[c] = 1 / len(favs or rest)
    return probs


def smooth(weighted: dict[str, float], parent: dict[str, float]) -> dict[str, float]:
    n = sum(weighted.values())
    return {
        c: (weighted.get(c, 0.0) + SMOOTHING_K * parent[c]) / (n + SMOOTHING_K)
        for c in PREDICTABLE
    }


def context_levels(context: Context) -> tuple[tuple[str, Callable[[PastMeal], bool]], ...]:
    """Narrowing levels after quiz, broadest first. Each filters the counted meals."""
    return (
        (USER, lambda m: True),
        (SLOT, lambda m: m.meal_slot == context.meal_slot),
        (
            SLOT_WEEKEND,
            lambda m: m.meal_slot == context.meal_slot and is_weekend(m) == context.is_weekend,
        ),
        # P2-07: (COMPANION, this companion + same slot + weekday/weekend) goes here.
    )


def predict(history: History, context: Context, as_of: date) -> CuisinePrediction:
    prior = history.prior
    counted = [m for m in history.meals if counts(m, as_of, prior.hard_nos)]
    weights = [(m, recency_weight((as_of - m.eaten_on).days)) for m in counted]

    probs = quiz_prior(prior.favorites, prior.hard_nos)
    level, n_eff, n_raw = QUIZ, 0.0, 0
    user_counts: dict[str, int] = {}
    user_weighted: dict[str, float] = {}
    for name, match in context_levels(context):
        weighted: dict[str, float] = {}
        raw: dict[str, int] = {}
        for m, w in weights:
            if match(m):
                weighted[m.category_id] = weighted.get(m.category_id, 0.0) + w
                raw[m.category_id] = raw.get(m.category_id, 0) + 1
        if name == USER:
            user_counts, user_weighted = raw, weighted
        probs = smooth(weighted, probs)
        n = sum(weighted.values())
        if n >= LEVEL_MIN_N_EFF:
            level, n_eff, n_raw = name, n, sum(raw.values())

    total = sum(user_weighted.values())
    shares = {c: w / total for c, w in user_weighted.items()} if total else {}
    return CuisinePrediction(probs, n_eff, n_raw, level, user_counts, shares)
