"""Scoring v1 weights and thresholds (P1-12). Data only; the logic is in app/scoring.py.

Every number here is an untuned starting value (REQUIREMENTS, Starting values). Tune on
live data only, never on the backfill.
"""

# Score = sum of weight * fit. Weights sum to 1. Every fit is in [0, 1] except the return
# score (P2-10), which is in [-1, 1]: 1-2 stars go negative so a low-rated place scores below
# a new place (0). Scores are in [-0.25, 1]; only their order is used.
WEIGHTS: dict[str, float] = {
    "category": 0.40,
    "return": 0.25,
    "price": 0.15,
    "distance": 0.20,
}

# Cuisine model (P2-02, ML3, app/cuisine_model.py). Fixed before evaluation (ML9), never
# tuned on the backfill. Category fit = p(category) / max p, so the top category fits 1.0.
HALF_LIFE_DAYS = 30  # recency weight = 0.5 ** (age_days / HALF_LIFE_DAYS)
SMOOTHING_K = 3  # p = (weighted count + K * parent p) / (weighted n + K)
QUIZ_FAVORITES_MASS = 0.7  # quiz prior: favorites share 0.7, other allowed categories 0.3
LEVEL_MIN_N_EFF = 1.0  # the reported level is the deepest with this much weighted data
OTHER_FIT = 0.0  # Other is shown but never predicted (ML2)

# Place model (P2-10, ML4, app/place_model.py). Fixed before evaluation (ML9), never tuned on
# the backfill. Same recency weight as the cuisine model (HALF_LIFE_DAYS).
FAMILIARITY_SCALE = 1.5  # familiarity = 1 - exp(-weighted visits / FAMILIARITY_SCALE)
# Star factor by the recency-weighted mean of the user's stars, linear between whole stars.
STAR_FACTOR: dict[int, float] = {5: 1.0, 4: 0.85, 3: 0.6, 2: -0.5, 1: -1.0}
STAR_UNKNOWN = 0.85  # a visited place with no ratings (all backfill)

# Usual categories (ML5): at least this raw recency-weighted share of the user's meals.
USUAL_MIN_SHARE = 0.15

# Weak prediction (ML6): top probability under this, or fewer raw meals at the level.
WEAK_TOP_PROB = 0.4
WEAK_MIN_MEALS = 5

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
