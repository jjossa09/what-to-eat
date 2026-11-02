# Offline evaluation (ML9, P2-13)

Generated 2026-11-01 by `api/scripts/evaluate.py` from the user's meals in Supabase (live mode). Aggregates only.

## Method

- Time-ordered replay: meals in (date, meal slot) order. Each meal is predicted with only meals from earlier days (as_of = its own date), with its own meal slot and weekday/weekend. Same-day and later meals are never seen.
- The real models run unchanged: `cuisine_model.predict`, `place_model.place_scores`, `scoring.category_fit`. No parameter was changed or searched by this evaluation; the values below were fixed before the replay.
- Cuisine: meals with a countable category (backfill, or live with a food answer). A hit is the eaten category in the model's top 1 or top 3. Ties: alphabetical.
- Place: meals at resolved places. Candidate pool = places visited on earlier days, minus hard-no categories (as in the app). Score = (0.4 x category fit + 0.25 x return score) / 0.65, the engine's own category and return terms renormalized over those two weights. Distance and price are excluded because backfill has no location. A first visit to a new place is a miss. Ties: place id.
- Baselines on the same meals: most frequent so far (raw counts of earlier meals, ties alphabetical, never uses the quiz) and random, computed analytically, not sampled: k / allowed categories for cuisine, k / pool size for place, averaged over meals (0 when the eaten category or place is not in the allowed set).
- Observed rates show a 95% Wilson interval (CI). Random rates are exact expected values, so they have no interval.

## Parameters (app/scoring_rules.py)

- WEIGHTS: category 0.4, return 0.25 (price 0.15 and distance 0.2 not used here)
- HALF_LIFE_DAYS 30, SMOOTHING_K 3, QUIZ_FAVORITES_MASS 0.7, LEVEL_MIN_N_EFF 1.0
- FAMILIARITY_SCALE 1.5, STAR_UNKNOWN 0.85, STAR_FACTOR 5: 1.0, 4: 0.85, 3: 0.6, 2: -0.5, 1: -1.0
- SCORE_DIGITS 9

## Data

- Meals loaded: 24 (23 backfill, 1 live), spanning 58 days.
- Meals at unresolved places (cuisine only, not place): 6.
- Countable meals skipped for having no meal slot: 0.

## Run A: strict cold start

No quiz prior: level 0 is uniform over all predictable categories. Only earlier meals inform each prediction.

### Cuisine

n = 24 meals. The model may predict 24 categories. Meals in a hard-no category (automatic misses): 0.

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 16.7% (4/24), CI 6.7% to 35.9% | 33.3% (8/24), CI 18.0% to 53.3% |
| Most frequent so far | 20.8% (5/24), CI 9.2% to 40.5% | 45.8% (11/24), CI 27.9% to 64.9% |
| Random | 4.2% expected (analytic) | 12.5% expected (analytic) |

Top-3 by meal slot (slots with n >= 3):

| Slot | n | Model | Most frequent so far | Random |
|---|---|---|---|---|
| lunch | 10 | 30.0% (3/10), CI 10.8% to 60.3% | 50.0% (5/10), CI 23.7% to 76.3% | 12.5% expected (analytic) |
| dinner | 12 | 41.7% (5/12), CI 19.3% to 68.0% | 50.0% (6/12), CI 25.4% to 74.6% | 12.5% expected (analytic) |

### Place

n = 18 meals at resolved places. New-place share: 44.4% (8/18), CI 24.6% to 66.3%. Repeat visits to a hard-no place (not in the pool, misses): 0.

All visits (a first visit to a new place is a miss):

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 16.7% (3/18), CI 5.8% to 39.2% | 38.9% (7/18), CI 20.3% to 61.4% |
| Most frequent so far | 33.3% (6/18), CI 16.3% to 56.3% | 38.9% (7/18), CI 20.3% to 61.4% |
| Random | 9.2% expected (analytic) | 27.6% expected (analytic) |

Repeat visits only (n = 10):

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 30.0% (3/10), CI 10.8% to 60.3% | 70.0% (7/10), CI 39.7% to 89.2% |
| Most frequent so far | 60.0% (6/10), CI 31.3% to 83.2% | 70.0% (7/10), CI 39.7% to 89.2% |
| Random | 16.6% expected (analytic) | 49.7% expected (analytic) |

## Run B: with the quiz prior (given after the backfill period)

Uses the user's actual quiz prior (favorites and hard no's). This is information the user gave after the backfill period, so this run is optimistic for the earliest meals. Same meals as the cold start run.

Quiz prior: 4 favorite categories, 6 hard-no categories.

### Cuisine

n = 24 meals. The model may predict 18 categories. Meals in a hard-no category (automatic misses): 0.

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 16.7% (4/24), CI 6.7% to 35.9% | 37.5% (9/24), CI 21.2% to 57.3% |
| Most frequent so far | 20.8% (5/24), CI 9.2% to 40.5% | 45.8% (11/24), CI 27.9% to 64.9% |
| Random | 5.6% expected (analytic) | 16.7% expected (analytic) |

Top-3 by meal slot (slots with n >= 3):

| Slot | n | Model | Most frequent so far | Random |
|---|---|---|---|---|
| lunch | 10 | 40.0% (4/10), CI 16.8% to 68.7% | 50.0% (5/10), CI 23.7% to 76.3% | 16.7% expected (analytic) |
| dinner | 12 | 41.7% (5/12), CI 19.3% to 68.0% | 50.0% (6/12), CI 25.4% to 74.6% | 16.7% expected (analytic) |

### Place

n = 18 meals at resolved places. New-place share: 44.4% (8/18), CI 24.6% to 66.3%. Repeat visits to a hard-no place (not in the pool, misses): 0.

All visits (a first visit to a new place is a miss):

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 16.7% (3/18), CI 5.8% to 39.2% | 38.9% (7/18), CI 20.3% to 61.4% |
| Most frequent so far | 33.3% (6/18), CI 16.3% to 56.3% | 38.9% (7/18), CI 20.3% to 61.4% |
| Random | 9.2% expected (analytic) | 27.6% expected (analytic) |

Repeat visits only (n = 10):

| Method | Top-1 | Top-3 |
|---|---|---|
| Model | 30.0% (3/10), CI 10.8% to 60.3% | 70.0% (7/10), CI 39.7% to 89.2% |
| Most frequent so far | 60.0% (6/10), CI 31.3% to 83.2% | 70.0% (7/10), CI 39.7% to 89.2% |
| Random | 16.6% expected (analytic) | 49.7% expected (analytic) |

## Limitations

- Small n: intervals are wide; differences inside overlapping intervals are not evidence of a real difference.
- One user. Nothing here generalizes to other people.
- Backfill was entered from memory, so dates, slots, and categories may have errors.
- No location in backfill: distance and price fit (0.35 of the live score's weight) are not evaluated. The place ranking here is the category and return terms only.
- Backfill has no stars, so star factors are untested (every visited place uses STAR_UNKNOWN).
