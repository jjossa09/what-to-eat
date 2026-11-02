import random
from dataclasses import replace
from datetime import date, datetime

import pytest

from app.cuisine_model import predict
from app.place_model import place_scores
from app.places import Candidate
from app.scoring import (
    Context,
    History,
    PastMeal,
    QuizPrior,
    StoredPlace,
    category_fit,
    distance_fit,
    is_weak,
    meal_context,
    merge_candidates,
    price_fit,
    rank,
    usual_categories,
)
from app.scoring_rules import CLOSE_M, DONT_MIND_WEIGHTS, WEIGHTS

LAT, LON = 33.95, -84.55
TODAY = date(2026, 10, 29)
# About 111 m per 0.001 degree of latitude.
M_PER_DEG = 111_195


def ctx(**kw) -> Context:
    base = dict(lat=LAT, lon=LON, local_date=TODAY, meal_slot="dinner", is_weekend=False,
                search_radius_m=5000)
    return Context(**{**base, **kw})


def cand(pid, category, distance_m, name=None) -> Candidate:
    return Candidate(id=pid, name=name or pid, lat=LAT + distance_m / M_PER_DEG, lon=LON,
                     distance_m=distance_m, category=category, geoapify_categories=[],
                     address=None)


def stored(pid, distance_m, name="Stored", tags=("catering.restaurant.thai",)) -> StoredPlace:
    return StoredPlace(id=pid, name=name, lat=LAT + distance_m / M_PER_DEG, lon=LON,
                       geoapify_categories=tuple(tags), address=None)


def meal(place, days_ago=1, source="live", category_id=None, price_level=None,
         **kw) -> PastMeal:
    if source == "live":
        kw.setdefault("went", True)  # history loads live meals with went = true only
    return PastMeal(place=place, eaten_on=date.fromordinal(TODAY.toordinal() - days_ago),
                    source=source, category_id=category_id, price_level=price_level, **kw)


def top_ids(ranking) -> list[str]:
    return [p.scored.place.id for p in ranking.top3]


# Weights live in one place.


def test_weights_sum_to_one():
    assert sum(WEIGHTS.values()) == pytest.approx(1.0)


# Meal slot and context.


@pytest.mark.parametrize(
    ("local", "slot", "day"),
    [
        (datetime(2026, 10, 29, 4, 59), "late", date(2026, 10, 28)),
        (datetime(2026, 10, 29, 5, 0), "breakfast", date(2026, 10, 29)),
        (datetime(2026, 10, 29, 10, 59), "breakfast", date(2026, 10, 29)),
        (datetime(2026, 10, 29, 11, 0), "lunch", date(2026, 10, 29)),
        (datetime(2026, 10, 29, 16, 0), "dinner", date(2026, 10, 29)),
        (datetime(2026, 10, 29, 21, 0), "late", date(2026, 10, 29)),
    ],
)
def test_meal_context_slots_and_late_rule(local, slot, day):
    assert meal_context(local)[:2] == (slot, day)


def test_after_midnight_sunday_counts_as_saturday_weekend():
    # Mon 00:30 is late on Sunday: still the weekend.
    assert meal_context(datetime(2026, 11, 2, 0, 30)) == ("late", date(2026, 11, 1), True)
    assert meal_context(datetime(2026, 11, 3, 0, 30))[2] is False


# Fits.


def fit(category, history, context=None):
    context = context or ctx()
    return category_fit(category, predict(history, context, as_of=context.local_date))


def test_category_fit_quiz_prior_and_uniform():
    # One favorite holds 0.7; the other 23 share 0.3. Fit = p / max p.
    quiz = History(prior=QuizPrior(favorites=frozenset({"thai"})))
    assert fit("thai", quiz) == (1.0, "quiz")
    assert fit("pizza", quiz) == (pytest.approx((0.3 / 23) / 0.7), "quiz")
    assert fit("pizza", History()) == (pytest.approx(1.0), "quiz")
    assert fit("other", quiz)[0] == 0.0
    assert fit("other", History())[0] == 0.0


def test_category_fit_top_predicted_category_is_one():
    p = stored("node/1", 100)
    history = History(meals=(meal(p, 1, source="backfill", category_id="thai"),
                             meal(p, 2, source="backfill", category_id="thai"),
                             meal(p, 3, source="backfill", category_id="pizza")))
    assert fit("thai", history) == (1.0, "user")
    assert 0 < fit("pizza", history)[0] < 1.0
    assert fit("burgers", history)[0] < fit("pizza", history)[0]


def test_usual_is_raw_weighted_share_at_user_level():
    p = stored("node/1", 100)
    prior = QuizPrior(favorites=frozenset({"korean"}))
    # 6 thai, 1 pizza, all 1 day old: pizza share 1/7 = 0.143 < 0.15. Korean is a quiz
    # favorite with no meals: smoothing would give it mass, the raw share does not.
    meals = tuple(meal(p, 1, source="backfill", category_id="thai") for _ in range(6)) + (
        meal(p, 1, source="backfill", category_id="pizza"),)
    h = History(prior=prior, meals=meals)
    assert usual_categories(predict(h, ctx(), TODAY), prior) == frozenset({"thai"})
    meals += (meal(p, 1, source="backfill", category_id="pizza"),)  # 2/8 = 0.25
    h = History(prior=prior, meals=meals)
    assert usual_categories(predict(h, ctx(), TODAY), prior) == frozenset({"thai", "pizza"})


def test_usual_before_any_counted_meal_is_quiz_favorites_minus_hard_nos():
    prior = QuizPrior(favorites=frozenset({"thai", "pizza"}), hard_nos=frozenset({"pizza"}))
    # A live meal with no food answer does not count.
    h = History(prior=prior, meals=(meal(stored("node/1", 100), category_id="burgers"),))
    assert usual_categories(predict(h, ctx(), TODAY), prior) == frozenset({"thai"})


def test_is_weak():
    p = stored("node/1", 100)
    four = tuple(meal(p, 1, source="backfill", category_id="thai") for _ in range(4))
    five = four + (meal(p, 1, source="backfill", category_id="thai"),)
    assert is_weak(predict(History(), ctx(), TODAY))  # no meals
    assert is_weak(predict(History(meals=four), ctx(), TODAY))  # 4 raw meals < 5
    assert not is_weak(predict(History(meals=five), ctx(), TODAY))  # top 0.63, 5 meals
    mixed = tuple(meal(p, 1, source="backfill", category_id=c)
                  for c in ("thai", "pizza", "korean", "bbq", "seafood", "indian"))
    assert is_weak(predict(History(meals=mixed), ctx(), TODAY))  # 6 meals, top < 0.4


def test_never_visited_place_has_return_score_zero():
    history = History(meals=(meal(stored("node/1", 100), 2, source="backfill"),))
    r = rank([cand("node/1", "thai", 100), cand("new", "thai", 100)], ctx(), history)
    by_id = {s.place.id: s.evidence for s in r.ranked}
    assert by_id["new"].return_score == 0.0 and by_id["new"].visits == 0
    assert by_id["node/1"].return_score > 0 and by_id["node/1"].stars_mean is None


@pytest.mark.parametrize(
    ("known", "budget", "fit"),
    [(1, 2, 1.0), (2, 2, 1.0), (3, 2, 0.5), (4, 2, 0.0), (4, 1, 0.0),
     (None, 2, 0.5), (2, None, 0.5), (None, None, 0.5)],
)
def test_price_fit(known, budget, fit):
    assert price_fit(known, budget) == fit


def test_distance_fit():
    assert distance_fit(0, 5000) == 1.0
    assert distance_fit(2500, 5000) == 0.5
    assert distance_fit(6000, 5000) == 0.0


def test_dont_mind_weights_sum_to_one_and_lower_distance():
    assert sum(DONT_MIND_WEIGHTS.values()) == pytest.approx(1.0)
    assert DONT_MIND_WEIGHTS["distance"] < WEIGHTS["distance"]
    assert DONT_MIND_WEIGHTS["category"] > WEIGHTS["category"]


def test_dont_mind_shrinks_the_distance_gap():
    # Same category at 1 km and 10 km: about 0.12 apart at Close to me, about 0.02 at
    # I don't mind (lower weight and a flatter fit over 35 km).
    places = [cand("near", "thai", 1000), cand("far", "thai", 10000)]

    def gap(radius):
        r = rank(places, ctx(radius_m=radius, search_radius_m=radius), History())
        score = {s.place.id: s.score for s in r.ranked}
        return score["near"] - score["far"]

    assert gap(15000) == pytest.approx(0.12, abs=0.005)
    assert gap(35000) == pytest.approx(0.0206, abs=0.002)


def test_close_reason_is_a_fixed_distance():
    places = [cand("a", "thai", CLOSE_M), cand("b", "pizza", CLOSE_M + 1)]
    r = rank(places, ctx(radius_m=35000, search_radius_m=35000), History())
    reasons = {s.place.id: s.evidence.reasons for s in r.ranked}
    assert "close" in reasons["a"] and "close" not in reasons["b"]


# Cold start: no history, no quiz.


def test_cold_start_ranks_by_distance_and_sinks_other():
    places = [cand("far_thai", "thai", 3000), cand("near_other", "other", 100),
              cand("mid_pizza", "pizza", 1000), cand("near_burgers", "burgers", 200)]
    r = rank(places, ctx(), History())
    assert r.cold_start and r.usual == frozenset()
    assert [s.place.id for s in r.ranked] == ["near_burgers", "mid_pizza", "far_thai",
                                               "near_other"]
    assert top_ids(r) == ["near_burgers", "mid_pizza", "far_thai"]
    assert [p.slot for p in r.top3] == ["familiar", "familiar", "discovery"]
    assert all("cold_start" in p.scored.evidence.reasons for p in r.top3)
    assert all(s.evidence.price_fit == 0.5 for s in r.ranked)


def test_cold_start_discovery_takes_a_new_category():
    places = [cand("b1", "burgers", 100), cand("b2", "burgers", 200), cand("b3", "burgers", 300),
              cand("t1", "thai", 900)]
    r = rank(places, ctx(), History())
    assert top_ids(r) == ["b1", "b2", "t1"]
    assert "discovery" in r.top3[2].scored.evidence.reasons


def test_cold_start_budget_alone_changes_nothing():
    places = [cand("a", "thai", 100), cand("b", "pizza", 400), cand("c", "burgers", 800)]
    assert top_ids(rank(places, ctx(budget_level=1), History())) == top_ids(
        rank(places, ctx(), History())
    )


# Quiz prior, craving, filters.


def test_quiz_favorites_fill_familiar_slots_and_discovery_is_outside():
    prior = QuizPrior(favorites=frozenset({"thai", "pizza"}))
    places = [cand("near_burgers", "burgers", 100), cand("thai", "thai", 2000),
              cand("pizza", "pizza", 2500), cand("far_mexican", "mexican", 4000)]
    r = rank(places, ctx(), History(prior=prior))
    assert not r.cold_start
    assert top_ids(r) == ["thai", "pizza", "near_burgers"]
    assert "favorite_category" in r.top3[0].scored.evidence.reasons
    assert r.top3[0].scored.evidence.category_source == "quiz"


def test_craving_takes_the_familiar_slots():
    prior = QuizPrior(favorites=frozenset({"pizza"}))
    places = [cand("pizza", "pizza", 100), cand("sushi1", "japanese_sushi", 3000),
              cand("sushi2", "japanese_sushi", 4000)]
    r = rank(places, ctx(craving="japanese_sushi"), History(prior=prior))
    assert r.usual == frozenset({"japanese_sushi"})
    assert top_ids(r) == ["sushi1", "sushi2", "pizza"]
    assert "craving_match" in r.top3[0].scored.evidence.reasons
    assert r.top3[2].scored.evidence.category_fit == pytest.approx(0.25)


def test_craving_with_one_match_fills_second_familiar_slot_from_best_remaining():
    places = [cand("pizza", "pizza", 100), cand("burgers", "burgers", 200),
              cand("thai", "thai", 300), cand("sushi", "japanese_sushi", 4000)]
    r = rank(places, ctx(craving="japanese_sushi"), History())
    assert top_ids(r) == ["sushi", "pizza", "burgers"]
    assert [p.slot for p in r.top3] == ["familiar", "familiar", "discovery"]


def test_craving_with_no_match_fills_from_best_remaining():
    places = [cand("pizza", "pizza", 100), cand("burgers", "burgers", 200),
              cand("thai", "thai", 300)]
    r = rank(places, ctx(craving="japanese_sushi"), History())
    assert top_ids(r) == ["pizza", "burgers", "thai"]


def test_hard_nos_and_rejected_places_are_never_shown():
    prior = QuizPrior(hard_nos=frozenset({"seafood"}))
    places = [cand("fish", "seafood", 50), cand("rejected", "thai", 60),
              cand("a", "pizza", 500), cand("b", "burgers", 600)]
    r = rank(places, ctx(exclude_ids=frozenset({"rejected"})), History(prior=prior))
    shown = {s.place.id for s in r.ranked}
    assert shown == {"a", "b"}
    assert len(r.top3) == 2


def test_excluded_categories_are_never_shown():
    places = [cand("p", "pizza", 50), cand("b", "burgers", 60), cand("t", "thai", 70)]
    r = rank(places, ctx(exclude_categories=frozenset({"burgers"})), History())
    assert {s.place.id for s in r.ranked} == {"p", "t"}


def test_fewer_than_three_candidates():
    assert rank([], ctx(), History()).top3 == ()
    assert top_ids(rank([cand("only", "thai", 10)], ctx(), History())) == ["only"]


def test_missing_familiar_category_fills_from_best_remaining():
    prior = QuizPrior(favorites=frozenset({"korean"}))
    places = [cand("a", "thai", 100), cand("b", "pizza", 200), cand("c", "burgers", 300)]
    r = rank(places, ctx(), History(prior=prior))
    assert top_ids(r) == ["a", "b", "c"]
    assert [p.rank for p in r.top3] == [1, 2, 3]


# Price from the user's own history.


def test_price_uses_most_recent_known_level_and_session_budget_wins():
    place = stored("node/1", 500)
    history = History(
        prior=QuizPrior(budget_level=4),
        meals=(meal(place, 1, price_level=None), meal(place, 5, price_level=3),
               meal(place, 9, price_level=1)),
    )
    r = rank([cand("node/1", "thai", 500)], ctx(budget_level=2), history)
    ev = r.ranked[0].evidence
    assert (ev.known_price_level, ev.budget_level, ev.price_fit) == (3, 2, 0.5)
    assert ev.visits == 3 and ev.last_visit_days == 1
    assert "price_above_budget" in ev.reasons and "visited_before" in ev.reasons
    # Quiz budget is used when the session has none.
    assert rank([cand("node/1", "thai", 500)], ctx(), history).ranked[0].evidence.price_fit == 1.0


# Merge (#13 follow-up).


def test_merge_adds_visited_places_within_radius_and_remaps():
    near = stored("node/7", 4000, name="Far Thai")
    outside = stored("node/8", 6000)
    history = History(meals=(meal(near), meal(outside)))
    merged, ids = merge_candidates([cand("node/1", "pizza", 100)], history, ctx())
    assert [c.id for c in merged] == ["node/1", "node/7"]
    assert ids == frozenset({"node/7"})
    assert merged[1].category == "thai"  # mapped again from stored tags
    assert 3990 <= merged[1].distance_m <= 4010


def test_merge_dedupes_and_geoapify_row_wins():
    fresh = replace(cand("node/1", "pizza", 100), name="Fresh Name")
    history = History(meals=(meal(stored("node/1", 100, name="Old Name")),))
    merged, ids = merge_candidates([fresh], history, ctx())
    assert len(merged) == 1 and merged[0].name == "Fresh Name"
    assert ids == frozenset()


def test_meal_label_never_changes_a_place_category():
    # The meal's category is the food eaten (wings at a Thai place); the place stays Thai.
    p1, p2 = stored("node/1", 100), stored("node/2", 200)
    history = History(meals=(
        meal(p1, 1, source="backfill", category_id="chicken_wings"),
        meal(p2, 2, source="backfill", category_id="korean"),
        meal(p2, 3, category_id="burgers", food_answered=True),
    ))
    merged, _ = merge_candidates([cand("node/1", "thai", 100)], history, ctx())
    assert {c.id: c.category for c in merged} == {"node/1": "thai", "node/2": "thai"}
    r = rank(merged, ctx(), history)
    assert {s.place.id: s.place.category for s in r.ranked} == {"node/1": "thai",
                                                                "node/2": "thai"}


def test_unresolved_meals_count_for_cuisine_but_never_become_candidates():
    history = History(meals=(
        meal(None, 1, source="backfill", category_id="korean"),
        meal(None, 2, source="backfill", category_id="korean"),
        meal(stored("node/1", 100), 3, source="backfill", category_id="pizza"),
    ))
    merged, ids = merge_candidates([], history, ctx())
    assert [c.id for c in merged] == ["node/1"] and ids == frozenset({"node/1"})
    assert set(place_scores(history, TODAY)) == {"node/1"}
    prediction = predict(history, ctx(), TODAY)
    assert prediction.user_counts == {"korean": 2, "pizza": 1}
    r = rank([cand("k", "korean", 900)] + merged, ctx(), history, ids)
    korean = next(s for s in r.ranked if s.place.id == "k")
    assert korean.evidence.category_fit == 1.0 and korean.evidence.visits == 0
    assert korean.evidence.category_meals == 2


def test_merged_place_carries_from_history_evidence():
    history = History(meals=(meal(stored("node/9", 300)),))
    merged, ids = merge_candidates([], history, ctx())
    r = rank(merged, ctx(), history, ids)
    assert r.ranked[0].evidence.from_history is True


# Determinism.


def test_ties_break_by_distance_then_id():
    places = [cand("node/b", "thai", 500), cand("node/a", "pizza", 500),
              cand("node/c", "burgers", 400)]
    r = rank(places, ctx(), History())
    assert [s.place.id for s in r.ranked] == ["node/c", "node/a", "node/b"]


def test_same_input_same_output_regardless_of_candidate_order():
    prior = QuizPrior(favorites=frozenset({"thai"}), budget_level=2)
    places = [cand(f"node/{i}", cat, 100 + (i * 37) % 900)
              for i, cat in enumerate(["thai", "pizza", "thai", "other", "burgers", "thai",
                                       "mexican", "pizza", "korean", "thai"])]
    history = History(prior=prior, meals=(meal(stored("node/3", 300), price_level=3),))
    first = rank(places, ctx(), history)
    for seed in range(5):
        shuffled = places[:]
        random.Random(seed).shuffle(shuffled)
        assert rank(shuffled, ctx(), history) == first


# Place model in the ranking (P2-10).


def test_frequent_one_star_place_ranks_below_an_identical_new_place():
    bad = stored("node/1", 500)
    history = History(meals=tuple(meal(bad, d, stars=1) for d in range(1, 9)))
    r = rank([cand("node/1", "thai", 500), cand("node/2", "thai", 500)], ctx(), history)
    assert [s.place.id for s in r.ranked] == ["node/2", "node/1"]
    assert r.ranked[1].evidence.return_score < 0 < r.ranked[1].evidence.visits
    assert r.ranked[1].evidence.stars_mean == 1.0


@pytest.mark.parametrize("radius_m", [None, 35000])
def test_score_is_the_weighted_sum_of_fits_for_a_visited_place(radius_m):
    place = stored("node/1", 1200)
    history = History(prior=QuizPrior(budget_level=2),
                      meals=(meal(place, 3, stars=4, price_level=2),
                             meal(place, 9, source="backfill", category_id="thai")))
    context = ctx(radius_m=radius_m, search_radius_m=radius_m or 5000)
    ev = rank([cand("node/1", "thai", 1200)], context, history).ranked[0].evidence
    w = DONT_MIND_WEIGHTS if radius_m else WEIGHTS
    assert sum(w.values()) == pytest.approx(1.0)
    expected = (w["category"] * ev.category_fit + w["return"] * ev.return_score
                + w["price"] * ev.price_fit + w["distance"] * ev.distance_fit)
    score = rank([cand("node/1", "thai", 1200)], context, history).ranked[0].score
    assert score == pytest.approx(expected)
    assert ev.return_score > 0 and ev.visits == 2 and ev.price_fit == 1.0


def test_return_score_never_lets_a_usual_place_take_the_discovery_slot():
    loved = stored("node/1", 100)
    history = History(meals=tuple(meal(loved, d, source="backfill", category_id="thai")
                                  for d in range(1, 6)))
    places = [cand("node/1", "thai", 100), cand("t2", "thai", 200), cand("t3", "thai", 300),
              cand("pizza", "pizza", 4500)]
    r = rank(places, ctx(), history)
    assert r.usual == frozenset({"thai"})
    assert top_ids(r) == ["node/1", "t2", "pizza"]
    assert r.top3[2].slot == "discovery"
    # The visited Thai place outscores the far pizza, but discovery is chosen by category.
    assert r.ranked[0].score > next(s for s in r.ranked if s.place.id == "pizza").score


def test_discovery_falls_back_to_a_usual_place_only_when_nothing_else_exists():
    loved = stored("node/1", 100)
    history = History(meals=(meal(loved, 1, source="backfill", category_id="thai"),))
    places = [cand("node/1", "thai", 100), cand("t2", "thai", 200), cand("t3", "thai", 300)]
    r = rank(places, ctx(), history)
    assert top_ids(r) == ["node/1", "t2", "t3"]
