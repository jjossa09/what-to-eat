"""Distance chip prediction (P2-03). Pure, with the cuisine model's context levels.

Only stored distances from confirmed live visits before as_of count. The prior is uniform;
quiz answers, backfill coordinates, food answers, and dish names provide no distance evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING

from app.cuisine_model import context_levels, recency_weight
from app.refine import CLOSE_M, DONT_MIND_M
from app.scoring_rules import LEVEL_MIN_N_EFF, SMOOTHING_K

if TYPE_CHECKING:
    from app.scoring import Context, History

CLOSE, FAR = "close", "far"
CHIPS = {CLOSE: CLOSE_M, FAR: DONT_MIND_M}


@dataclass(frozen=True)
class DistancePrediction:
    probs: dict[str, float]
    n_eff: float
    meals: int
    level: str


def predict(history: History, context: Context, as_of: date) -> DistancePrediction:
    weights = [(m, recency_weight((as_of - m.eaten_on).days)) for m in history.meals
               if m.source == "live" and m.went is True and m.distance_m is not None
               and m.eaten_on < as_of]
    p_close = 0.5
    level, n_eff, meals = "none", 0.0, 0
    for name, match in context_levels(context):
        selected = [(m, w) for m, w in weights if match(m)]
        n = sum(w for _, w in selected)
        w_close = sum(w for m, w in selected if m.distance_m <= CLOSE_M)
        p_close = (w_close + SMOOTHING_K * p_close) / (n + SMOOTHING_K)
        if n >= LEVEL_MIN_N_EFF:
            level, n_eff, meals = name, n, len(selected)
    return DistancePrediction({CLOSE: p_close, FAR: 1 - p_close}, n_eff, meals, level)
