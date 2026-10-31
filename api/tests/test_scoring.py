import random
from dataclasses import replace
from datetime import date, datetime

import pytest

from app.places import Candidate
from app.scoring import (
    Context,
    History,
    PastMeal,
    QuizPrior,
    StoredPlace,
    category_fit,
    distance_fit,
    meal_context,
    merge_candidates,
    price_fit,
    rank,
    return_score,
)
from app.scoring_rules import WEIGHTS

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


def meal(place, days_ago=1, source="live", category_id=None, price_level=None) -> PastMeal:
    return PastMeal(place=place, eaten_on=date.fromordinal(TODAY.toordinal() - days_ago),
                    source=source, category_id=category_id, price_level=price_level)


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


def test_category_fit_quiz_prior_and_uniform():
    quiz = History(prior=QuizPrior(favorites=frozenset({"thai"})))
    assert category_fit("thai", quiz, ctx()) == (1.0, "quiz_prior")
    assert category_fit("pizza", quiz, ctx()) == (0.5, "quiz_prior")
    assert category_fit("pizza", History(), ctx()) == (1.0, "uniform")
    assert category_fit("other", quiz, ctx())[0] == 0.0
    assert category_fit("other", History(), ctx())[0] == 0.0


def test_return_score_is_zero_in_v1():
    assert return_score(None, ctx()) == 0.0


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
    assert r.top3[0].scored.evidence.category_source == "quiz_prior"


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


def test_backfill_label_overrides_mapping_for_any_candidate():
    p1, p2 = stored("node/1", 100), stored("node/2", 200)
    history = History(meals=(
        meal(p1, 1, source="backfill", category_id="vietnamese"),
        meal(p1, 9, source="backfill", category_id="thai"),
        meal(p2, 2, source="backfill", category_id="korean"),
    ))
    merged, _ = merge_candidates([cand("node/1", "thai", 100)], history, ctx())
    assert {c.id: c.category for c in merged} == {"node/1": "vietnamese", "node/2": "korean"}


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
