"""P2-06 (FR13): feedback changes the next prediction with no separate update step.

Every test builds History the way history.load does: PostgREST-shaped meals rows (the
MEALS_SELECT columns) through the real parse_meal / parse_prior, then runs the models and
rank() before and after the feedback change. price_level is the generated column, so a row
with a price tap carries it as PostgREST would return it.
"""

import asyncio
import json
from datetime import date, datetime, timedelta

import httpx2
import pytest

from app import history
from app.config import get_settings
from app.cuisine_model import predict
from app.history import parse_meal, parse_prior
from app.place_model import place_scores
from app.places import Candidate
from app.scoring import Context, History, meal_context, merge_candidates, rank

TODAY = date(2026, 11, 2)  # a Monday
LAT, LON = 33.95, -84.55
M_PER_DEG = 111_195
VISITED, NEW = "node/1", "node/2"
ATE_AT = "2026-10-30T19:30:00+00:00"


def place_row(pid=VISITED, name="Pizza Spot", tags=("catering.restaurant.pizza",)) -> dict:
    return {"id": pid, "name": name, "lat": LAT + 800 / M_PER_DEG, "lon": LON,
            "geoapify_categories": list(tags), "address": "1 Main St", "unresolved": False}


def meal_row(**kw) -> dict:
    """A live pick at VISITED (place category pizza) with went = true and nothing else yet."""
    row = {"source": "live", "category_id": "pizza", "eaten_on": "2026-10-30",
           "meal_slot": "dinner", "is_weekend": False, "dish": None, "ate_at": None,
           "price_level": None, "went": True, "stars": None, "places": place_row()}
    return {**row, **kw}


def build(rows: list[dict], prior_rows: list[dict] | None = None) -> History:
    """history.load's parse step, on rows the meals query returned."""
    meals = (parse_meal(r) for r in rows)
    return History(prior=parse_prior(prior_rows or []), meals=tuple(m for m in meals if m))


def ctx(local_date=TODAY, **kw) -> Context:
    base = dict(lat=LAT, lon=LON, local_date=local_date, meal_slot="dinner", is_weekend=False,
                search_radius_m=5000)
    return Context(**{**base, **kw})


def cand(pid, category="pizza", distance_m=800) -> Candidate:
    return Candidate(id=pid, name=pid, lat=LAT + distance_m / M_PER_DEG, lon=LON,
                     distance_m=distance_m, category=category,
                     geoapify_categories=[f"catering.restaurant.{category}"], address=None)


def ranked(h: History, context: Context | None = None):
    """Two identical pizza places at the same distance: VISITED and a never-visited NEW."""
    context = context or ctx()
    candidates, merged = merge_candidates([cand(VISITED), cand(NEW)], h, context)
    result = rank(candidates, context, h, merged)
    return {s.place.id: s for s in result.ranked}, [s.place.id for s in result.ranked]


# (a) went = true -----------------------------------------------------------------------


def test_went_true_is_a_visit_but_not_cuisine_without_a_food_answer():
    before, after = build([]), build([meal_row()])

    assert place_scores(before, TODAY) == {}
    score = place_scores(after, TODAY)[VISITED]
    assert score.visits == 1 and score.return_score > 0
    # The pick-time place category (pizza) is in the row, but ate_at is null: no cuisine count.
    assert predict(after, ctx(), TODAY).probs == predict(before, ctx(), TODAY).probs
    assert predict(after, ctx(), TODAY).user_counts == {}
    scores, order = ranked(after)
    assert order[0] == VISITED and scores[VISITED].evidence.visits == 1


# (b) went = false ----------------------------------------------------------------------


def test_went_false_is_never_a_visit_or_cuisine_including_the_true_to_false_correction():
    went_true, corrected = meal_row(), meal_row(went=False)

    # The meals query filters it out; parse_meal drops it even if it slipped through.
    assert parse_meal(corrected) is None
    assert parse_meal(meal_row(went=None)) is None
    before, after = build([went_true]), build([corrected])
    assert VISITED in place_scores(before, TODAY)
    assert place_scores(after, TODAY) == {}
    assert predict(after, ctx(), TODAY).probs == predict(build([]), ctx(), TODAY).probs
    # Not merged from history either: only the Geoapify result remains, as a new place.
    _, merged = merge_candidates([], after, ctx())
    assert merged == frozenset()
    scores, _ = ranked(after)
    assert scores[VISITED].evidence.visits == 0 and scores[VISITED].evidence.return_score == 0


# (c) food answer -----------------------------------------------------------------------


def test_food_answer_counts_the_eaten_category_not_the_places():
    quiz = [{"favorite_categories": ["pizza"], "hard_no_categories": [], "budget_level": 2}]
    before = build([meal_row()], quiz)
    after = build([meal_row(category_id="thai", dish="Pad see ew", ate_at=ATE_AT)], quiz)

    p0, p1 = predict(before, ctx(), TODAY), predict(after, ctx(), TODAY)
    assert p1.probs["thai"] > p0.probs["thai"]
    assert p1.probs["pizza"] < p0.probs["pizza"]
    assert p1.user_counts == {"thai": 1}
    # The place keeps its own category (ML2 mapping); the meal label never relabels it.
    candidates, _ = merge_candidates([], after, ctx())
    assert [(c.id, c.category) for c in candidates] == [(VISITED, "pizza")]
    # A thai candidate now fits better than before (the quiz favors pizza).
    thai = [cand("node/9", "thai")]
    fit0 = rank(thai, ctx(), before).ranked[0].evidence.category_fit
    fit1 = rank(thai, ctx(), after).ranked[0].evidence.category_fit
    assert fit1 > fit0


# (d) stars -----------------------------------------------------------------------------


def test_one_star_moves_the_place_below_an_identical_new_place():
    answered = dict(category_id="pizza", ate_at=ATE_AT)
    before = build([meal_row(**answered)])
    after = build([meal_row(**answered, stars=1)])

    scores0, order0 = ranked(before)
    scores1, order1 = ranked(after)
    assert order0 == [VISITED, NEW] and scores0[VISITED].score > scores0[NEW].score
    assert scores1[VISITED].evidence.return_score < 0
    assert scores1[VISITED].evidence.stars_mean == 1
    assert order1 == [NEW, VISITED] and scores1[VISITED].score < scores1[NEW].score


def test_two_stars_also_make_the_return_score_negative():
    h = build([meal_row(category_id="pizza", ate_at=ATE_AT, stars=2)])
    assert place_scores(h, TODAY)[VISITED].return_score < 0


# (e) price tap -------------------------------------------------------------------------


def test_price_tap_becomes_the_known_price_and_drives_price_fit():
    answered = dict(category_id="pizza", ate_at=ATE_AT, stars=4)
    before = build([meal_row(**answered)])
    after = build([meal_row(**answered, price_level=4)])  # price_tap 4 -> generated price_level
    context = ctx(budget_level=1)

    e0, _ = ranked(before, context)
    e1, _ = ranked(after, context)
    assert e0[VISITED].evidence.known_price_level is None
    assert e0[VISITED].evidence.price_fit == 0.5
    assert e1[VISITED].evidence.known_price_level == 4
    assert e1[VISITED].evidence.price_fit == 0.0
    assert e1[VISITED].score < e0[VISITED].score
    assert "price_above_budget" in e1[VISITED].evidence.reasons


# (f) edit_meal: stars, price, dish -----------------------------------------------------


def test_edit_meal_changes_flow_through_the_same_way():
    answered = dict(category_id="pizza", ate_at=ATE_AT)
    rated = meal_row(**answered, stars=5, price_level=1, dish="Margherita")
    edited = meal_row(**answered, stars=1, price_level=4, dish="Pepperoni")
    context = ctx(budget_level=1)

    s0, order0 = ranked(build([rated]), context)
    s1, order1 = ranked(build([edited]), context)
    assert s0[VISITED].evidence.return_score > 0 and order0[0] == VISITED
    assert s1[VISITED].evidence.return_score < 0 and order1 == [NEW, VISITED]
    assert (s0[VISITED].evidence.price_fit, s1[VISITED].evidence.price_fit) == (1.0, 0.0)
    # A dish edit is not scored: the cuisine prediction is unchanged.
    assert predict(build([rated]), context, TODAY) == predict(build([edited]), context, TODAY)


# (g) staleness -------------------------------------------------------------------------


@pytest.fixture
def supabase_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class Supabase:
    """MockTransport handler serving the current rows; the test changes them between rounds."""

    def __init__(self, meals: list[dict]):
        self.meals, self.meal_reads = meals, 0

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        table = request.url.path.rsplit("/", 1)[-1]
        if table == "meals":
            self.meal_reads += 1
        body = self.meals if table == "meals" else []
        return httpx2.Response(200, content=json.dumps(body).encode())


def load(upstream: Supabase) -> History:
    """One /recommendations round: a fresh client and a fresh history read (main.py)."""

    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            return await history.load("user-1", "user.jwt.token", client=client)

    return asyncio.run(go())


def test_history_is_read_fresh_every_round(supabase_env):
    upstream = Supabase([meal_row(category_id="pizza", ate_at=ATE_AT)])
    _, order0 = ranked(load(upstream))

    upstream.meals = [meal_row(category_id="pizza", ate_at=ATE_AT, stars=1)]  # the rating
    h1 = load(upstream)
    _, order1 = ranked(h1)

    assert upstream.meal_reads == 2
    assert h1.meals[0].stars == 1
    assert (order0, order1) == ([VISITED, NEW], [NEW, VISITED])


# (h) timing ----------------------------------------------------------------------------


def test_a_meal_counts_from_the_next_local_date_at_5am():
    row = meal_row(category_id="thai", ate_at=ATE_AT, stars=1, eaten_on=TODAY.isoformat())
    h, empty = build([row]), build([])
    tomorrow = TODAY + timedelta(days=1)

    # Same local date: excluded by as_of.
    assert place_scores(h, TODAY) == {}
    assert predict(h, ctx(), TODAY).probs == predict(empty, ctx(), TODAY).probs
    # 04:59 the next morning is still today's local date (late runs past midnight).
    _, at_459, _ = meal_context(datetime(2026, 11, 3, 4, 59))
    _, at_500, _ = meal_context(datetime(2026, 11, 3, 5, 0))
    assert (at_459, at_500) == (TODAY, tomorrow)
    assert place_scores(h, at_459) == {}
    assert place_scores(h, at_500)[VISITED].return_score < 0
    assert predict(h, ctx(at_500), at_500).user_counts == {"thai": 1}
    _, order = ranked(h, ctx(at_500))
    assert order == [NEW, VISITED]


def test_feedback_on_an_earlier_meal_counts_on_the_very_next_round():
    # Picked yesterday, rated today: eaten_on < as_of, so the next round already sees it.
    yesterday = (TODAY - timedelta(days=1)).isoformat()
    _, before = ranked(build([meal_row(category_id="pizza", ate_at=ATE_AT, eaten_on=yesterday)]))
    _, after = ranked(
        build([meal_row(category_id="pizza", ate_at=ATE_AT, eaten_on=yesterday, stars=1)])
    )
    assert (before, after) == ([VISITED, NEW], [NEW, VISITED])


# Gap B: a dish edit without a food answer -----------------------------------------------


def test_dish_without_a_food_answer_does_not_count_for_cuisine():
    # edit_meal (20261108120000) saves the dish and leaves ate_at null.
    dish_only = meal_row(dish="Garlic knots")
    answered = meal_row(dish="Garlic knots", ate_at=ATE_AT)
    empty = build([])

    meal = parse_meal(dish_only)
    assert meal.dish == "Garlic knots" and meal.food_answered is False
    assert predict(build([dish_only]), ctx(), TODAY).probs == predict(empty, ctx(), TODAY).probs
    assert place_scores(build([dish_only]), TODAY)[VISITED].visits == 1  # still a visit
    # With a real food answer it counts.
    assert predict(build([answered]), ctx(), TODAY).user_counts == {"pizza": 1}
