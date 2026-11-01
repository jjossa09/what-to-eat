"""Scoring v1 weights and thresholds (P1-12). Data only; the logic is in app/scoring.py.

Every number here is an untuned starting value (REQUIREMENTS, Starting values). Tune on
live data only, never on the backfill.
"""

# Score = sum of weight * fit, each fit in [0, 1]. Weights sum to 1, so scores are in [0, 1].
# Return score is 0 for every place until P2-10, so its weight shifts no ranking yet.
WEIGHTS: dict[str, float] = {
    "category": 0.40,
    "return": 0.25,
    "price": 0.15,
    "distance": 0.20,
}

# Category fit v1 (quiz prior, ML5 Phase 1). P2-02 replaces it with the cuisine model.
FAVORITE_FIT = 1.0  # a quiz favorite
NON_FAVORITE_FIT = 0.5  # any other allowed category, when the user has favorites
UNIFORM_FIT = 1.0  # every allowed category, when there are no favorites (cold start)
OTHER_FIT = 0.0  # Other is shown but never predicted (ML2)

# Craving answer: the craved category fits fully; every other category is scaled down.
CRAVING_MATCH_FIT = 1.0
CRAVING_OTHER_FACTOR = 0.25

# Price fit by levels (REQUIREMENTS, Price fit). Index = levels above the budget.
PRICE_FIT_BY_LEVELS_ABOVE: tuple[float, ...] = (1.0, 0.5, 0.0)  # 0, 1, 2 or more above
PRICE_FIT_UNKNOWN = 0.5  # no known price for the place, or no budget

# "I don't mind" (P1-19, 35 km): distance counts less and category more; still sums to 1.
DONT_MIND_WEIGHTS: dict[str, float] = {
    "category": 0.52,
    "return": 0.25,
    "price": 0.15,
    "distance": 0.08,
}

# Distance fit = max(0, 1 - distance / radius). The "close" reason is a fixed distance, so a
# 35 km radius never calls 10 km close.
CLOSE_M = 3000

# Meal slots by local start hour (REQUIREMENTS, Meal slot). Late runs past midnight and
# counts on the previous day's local date.
MEAL_SLOT_STARTS: tuple[tuple[int, str], ...] = (
    (5, "breakfast"),
    (11, "lunch"),
    (16, "dinner"),
    (21, "late"),
)

# Scores are rounded before ranking so float noise never decides a tie.
SCORE_DIGITS = 9
