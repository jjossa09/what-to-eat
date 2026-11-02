from datetime import date, timedelta

import pytest

from app.place_model import familiarity, place_scores, star_factor
from app.scoring import History, PastMeal, StoredPlace
from app.scoring_rules import FAMILIARITY_SCALE, STAR_FACTOR, STAR_UNKNOWN

TODAY = date(2026, 10, 29)


def place(pid="node/1") -> StoredPlace:
    return StoredPlace(id=pid, name=pid, lat=0.0, lon=0.0, geoapify_categories=(), address=None)


def visit(days_ago=1, pid="node/1", source="backfill", went=None, stars=None, price=None,
          unresolved=False) -> PastMeal:
    if source == "live" and went is None:
        went = True
    return PastMeal(place=None if unresolved else place(pid),
                    eaten_on=TODAY - timedelta(days=days_ago), source=source, category_id="thai",
                    price_level=price, went=went, stars=stars)


def scores(*meals, as_of=TODAY):
    return place_scores(History(meals=tuple(meals)), as_of)


# Fixed constants.


def test_constants_are_the_fixed_starting_values():
    assert FAMILIARITY_SCALE == 1.5 and STAR_UNKNOWN == 0.85
    assert STAR_FACTOR == {5: 1.0, 4: 0.85, 3: 0.6, 2: -0.5, 1: -1.0}


# Weighting and as_of.


def test_visits_are_recency_weighted():
    s = scores(visit(30), visit(60))["node/1"]
    assert (s.visits, s.last_visit_days) == (2, 30)
    assert s.weighted_visits == pytest.approx(0.75)


def test_as_of_excludes_same_day_and_future_meals():
    s = scores(visit(1), visit(0), visit(-2))["node/1"]
    assert s.visits == 1 and s.last_visit_days == 1
    assert scores(visit(0), visit(-1)) == {}


def test_replay_never_sees_the_meal_it_predicts():
    target = visit(10, stars=1, source="live")
    as_of = target.eaten_on
    assert scores(visit(20), target, visit(5), as_of=as_of) == scores(visit(20), as_of=as_of)


# Familiarity curve.


@pytest.mark.parametrize("weighted, value", [(0.0, 0.0), (1.5, 1 - 1 / 2.718281828459045),
                                             (3.0, 0.8647)])
def test_familiarity_curve(weighted, value):
    assert familiarity(weighted) == pytest.approx(value, abs=1e-4)


def test_one_recent_visit_and_three_recent_visits():
    one = scores(visit(1))["node/1"]
    three = scores(visit(1), visit(1), visit(1))["node/1"]
    # Yesterday is the youngest a visit can be (as_of drops today): w = 0.977.
    assert one.return_score == pytest.approx(0.479 * STAR_UNKNOWN, abs=1e-3)
    assert familiarity(one.weighted_visits) == pytest.approx(0.479, abs=1e-3)
    assert familiarity(three.weighted_visits) == pytest.approx(0.858, abs=1e-3)


# Stars.


@pytest.mark.parametrize("mean, factor", [(5, 1.0), (4, 0.85), (3, 0.6), (2, -0.5), (1, -1.0),
                                          (4.5, 0.925), (2.5, 0.05), (1.5, -0.75),
                                          (None, 0.85)])
def test_star_factor_mapping_and_interpolation(mean, factor):
    assert star_factor(mean) == pytest.approx(factor)


def test_stars_mean_is_recency_weighted():
    # 5 stars at w = 0.5, 1 star at w = 0.25: (2.5 + 0.25) / 0.75 = 3.667.
    s = scores(visit(30, source="live", stars=5), visit(60, source="live", stars=1),
               visit(10))["node/1"]
    assert s.stars_mean == pytest.approx(11 / 3)
    assert s.visits == 3  # the unrated backfill visit counts for familiarity


def test_low_stars_drop_a_frequent_place_below_a_new_place():
    frequent = [visit(d, source="live", stars=1) for d in range(1, 9)]
    s = scores(*frequent)["node/1"]
    assert familiarity(s.weighted_visits) > 0.95
    assert s.return_score < 0  # a never-visited place scores 0
    two = scores(*[visit(d, source="live", stars=2) for d in range(1, 9)])["node/1"]
    assert two.return_score < 0
    loved = scores(*[visit(d, source="live", stars=5) for d in range(1, 9)])["node/1"]
    assert loved.return_score > 0.95


def test_unknown_stars_use_star_unknown():
    s = scores(visit(1), visit(3))["node/1"]
    assert s.stars_mean is None
    assert s.return_score == pytest.approx(familiarity(s.weighted_visits) * STAR_UNKNOWN)


# What counts as a visit.


def test_went_false_is_never_a_visit_and_no_food_answer_is_needed():
    assert scores(visit(1, source="live", went=False)) == {}
    s = scores(visit(1, source="live", went=True))["node/1"]
    assert s.visits == 1


def test_unresolved_meals_are_skipped():
    assert scores(visit(1, unresolved=True), visit(2, unresolved=True)) == {}


def test_never_visited_place_is_absent():
    assert "node/9" not in scores(visit(1))


def test_known_price_is_the_most_recent_known_level():
    s = scores(visit(1, price=None), visit(5, price=3), visit(9, price=1))["node/1"]
    assert s.known_price_level == 3 and s.last_visit_days == 1
    assert scores(visit(1))["node/1"].known_price_level is None


def test_places_are_scored_separately():
    out = scores(visit(1, "node/1"), visit(2, "node/2"), visit(3, "node/2"))
    assert {k: v.visits for k, v in out.items()} == {"node/1": 1, "node/2": 2}
