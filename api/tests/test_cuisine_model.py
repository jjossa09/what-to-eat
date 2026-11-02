from datetime import date, timedelta

import pytest

from app.cuisine_model import (
    PREDICTABLE,
    QUIZ,
    SLOT,
    SLOT_WEEKEND,
    USER,
    predict,
    quiz_prior,
    recency_weight,
)
from app.scoring import Context, History, PastMeal, QuizPrior
from app.scoring_rules import HALF_LIFE_DAYS, SMOOTHING_K

TODAY = date(2026, 10, 29)  # a Thursday


def ctx(slot="dinner", weekend=False) -> Context:
    return Context(lat=0.0, lon=0.0, local_date=TODAY, meal_slot=slot, is_weekend=weekend,
                   search_radius_m=5000)


def meal(category, days_ago=1, source="backfill", slot=None, weekend=None, answered=False,
         on=None) -> PastMeal:
    return PastMeal(place=None, eaten_on=on or TODAY - timedelta(days=days_ago), source=source,
                    category_id=category, price_level=None, meal_slot=slot,
                    is_weekend=weekend, food_answered=answered)


def run(*meals, prior=QuizPrior(), context=None, as_of=TODAY):
    return predict(History(prior=prior, meals=tuple(meals)), context or ctx(), as_of)


# Fixed constants and weights.


def test_constants_are_the_fixed_starting_values():
    assert (HALF_LIFE_DAYS, SMOOTHING_K) == (30, 3)
    assert len(PREDICTABLE) == 24 and "other" not in PREDICTABLE


@pytest.mark.parametrize("age, weight", [(0, 1.0), (15, 2 ** -0.5), (30, 0.5), (60, 0.25),
                                         (90, 0.125)])
def test_recency_weight_halves_every_30_days(age, weight):
    assert recency_weight(age) == pytest.approx(weight)


def test_counts_are_recency_weighted():
    p = run(meal("thai", 30), meal("thai", 30), meal("thai", 60))
    assert p.n_eff == pytest.approx(1.25)
    assert p.meals == 3 and p.user_counts == {"thai": 3}
    # Below 1 weighted meal, the level stays quiz even though the probs moved.
    low = run(meal("thai", 30), meal("thai", 60))
    assert (low.level, low.n_eff, low.meals) == (QUIZ, 0.0, 0)
    assert low.probs["thai"] > 1 / 24


# Quiz prior (L0) and cold start.


def test_quiz_prior_favorites_share_0_7_others_0_3_hard_nos_0():
    prior = quiz_prior(frozenset({"thai", "pizza"}), frozenset({"bbq", "seafood"}))
    assert prior["thai"] == prior["pizza"] == pytest.approx(0.35)
    assert prior["bbq"] == prior["seafood"] == 0.0
    assert prior["korean"] == pytest.approx(0.3 / 20)
    assert sum(prior.values()) == pytest.approx(1.0)


def test_no_quiz_is_uniform():
    assert all(v == pytest.approx(1 / 24) for v in quiz_prior(frozenset(), frozenset()).values())
    p = quiz_prior(frozenset(), frozenset({"bbq"}))
    assert p["bbq"] == 0.0 and p["thai"] == pytest.approx(1 / 23)


def test_all_allowed_categories_favorite_share_everything():
    favs = frozenset(PREDICTABLE) - {"bbq"}
    p = quiz_prior(favs, frozenset({"bbq"}))
    assert p["thai"] == pytest.approx(1 / 23) and p["bbq"] == 0.0


def test_cold_start_equals_quiz_prior():
    prior = QuizPrior(favorites=frozenset({"thai"}), hard_nos=frozenset({"pizza"}))
    p = run(prior=prior)
    assert p.probs == pytest.approx(quiz_prior(prior.favorites, prior.hard_nos))
    assert (p.level, p.n_eff, p.meals, p.user_meals) == (QUIZ, 0.0, 0, 0)
    assert run().probs == pytest.approx(quiz_prior(frozenset(), frozenset()))


# Smoothing math, by hand.


def test_k_smoothing_hand_computed_user_level():
    # No quiz: L0 = 1/24 each. Thai w = 0.5, pizza w = 0.25, n = 0.75.
    # thai = (0.5 + 3/24) / 3.75 = 1/6; pizza = 0.375 / 3.75 = 0.1; others 0.125 / 3.75.
    p = run(meal("thai", 30), meal("pizza", 60))
    assert p.probs["thai"] == pytest.approx(1 / 6)
    assert p.probs["pizza"] == pytest.approx(0.1)
    assert p.probs["korean"] == pytest.approx(1 / 30)
    # No meal slots: deeper levels are empty and equal their parent. n = 0.75 < 1: quiz.
    assert p.level == QUIZ


def test_nested_back_off_hand_computed():
    # Context dinner, weekday. All weights 0.5 (30 days old).
    #   thai, dinner, weekday   -> user, slot, slot_weekend
    #   thai, dinner, weekend   -> user, slot
    #   pizza, lunch, weekday   -> user
    meals = (meal("thai", 30, slot="dinner", weekend=False),
             meal("thai", 30, slot="dinner", weekend=True),
             meal("pizza", 30, slot="lunch", weekend=False))
    l0 = 1 / 24
    user = {"thai": (1.0 + 3 * l0) / 4.5, "pizza": (0.5 + 3 * l0) / 4.5, "x": 3 * l0 / 4.5}
    slot = {k: ((1.0 if k == "thai" else 0.0) + 3 * v) / 4.0 for k, v in user.items()}
    slot_wk = {k: ((0.5 if k == "thai" else 0.0) + 3 * v) / 3.5 for k, v in slot.items()}
    p = run(*meals)
    assert p.probs["thai"] == pytest.approx(slot_wk["thai"])  # 0.5179
    assert p.probs["pizza"] == pytest.approx(slot_wk["pizza"])
    assert p.probs["korean"] == pytest.approx(slot_wk["x"])
    # slot has n = 1.0 (deepest with n_eff >= 1); slot_weekend has 0.5.
    assert (p.level, p.n_eff, p.meals) == (SLOT, pytest.approx(1.0), 2)
    assert p.user_counts == {"thai": 2, "pizza": 1}


@pytest.mark.parametrize("meals, level", [
    ((), QUIZ),
    ((meal("thai", 1, slot="lunch"), meal("thai", 2, slot="lunch")), USER),
    ((meal("thai", 1, slot="dinner", weekend=True), meal("thai", 2, slot="dinner",
                                                          weekend=True)), SLOT),
    ((meal("thai", 1, slot="dinner", weekend=False), meal("thai", 2, slot="dinner",
                                                           weekend=False)), SLOT_WEEKEND),
    ((meal("thai", 1, slot="dinner", weekend=False),), QUIZ),  # w = 0.98 < 1 at every level
])
def test_reported_level_is_deepest_with_n_eff_at_least_one(meals, level):
    assert run(*meals).level == level


def test_weekend_is_derived_from_the_date_when_not_loaded():
    saturday = date(2026, 10, 24)
    meals = (meal("thai", slot="dinner", on=saturday), meal("thai", slot="dinner", on=saturday))
    assert run(*meals, context=ctx(weekend=True)).level == SLOT_WEEKEND
    assert run(*meals, context=ctx(weekend=False)).level == SLOT


# What counts.


def test_as_of_excludes_same_day_and_future_meals():
    past = meal("thai", 1)
    with_future = run(past, meal("pizza", 0), meal("korean", -3))
    assert with_future.probs == run(past).probs
    assert with_future.user_counts == {"thai": 1}


def test_replay_never_sees_the_meal_it_predicts():
    target = meal("korean", 10)
    history = (meal("thai", 20), target, meal("pizza", 5))
    as_of = target.eaten_on
    assert run(*history, as_of=as_of).probs == run(meal("thai", 20), as_of=as_of).probs


def test_live_meals_count_only_with_a_food_answer():
    unanswered = meal("burgers", 1, source="live")
    answered = meal("burgers", 1, source="live", answered=True)
    assert run(unanswered).user_counts == {}
    assert run(answered).user_counts == {"burgers": 1}
    assert run(meal("burgers", 1)).user_counts == {"burgers": 1}  # backfill always


def test_hard_nos_and_other_get_zero_and_are_never_counted():
    prior = QuizPrior(hard_nos=frozenset({"seafood"}))
    p = run(meal("seafood", 1), meal("other", 1), meal(None, 1), meal("thai", 1), prior=prior)
    assert p.probs["seafood"] == 0.0 and "other" not in p.probs
    assert p.user_counts == {"thai": 1}


@pytest.mark.parametrize("prior", [
    QuizPrior(),
    QuizPrior(favorites=frozenset({"thai", "pizza"})),
    QuizPrior(favorites=frozenset({"thai"}), hard_nos=frozenset({"bbq", "korean"})),
])
def test_probs_sum_to_one(prior):
    meals = (meal("thai", 3, slot="dinner"), meal("korean", 9, slot="dinner"),
             meal("pizza", 40, slot="lunch", weekend=True), meal("bbq", 2, slot="dinner"))
    for context in (ctx(), ctx("lunch", True), ctx("breakfast")):
        p = run(*meals, prior=prior, context=context)
        assert sum(p.probs.values()) == pytest.approx(1.0)
        assert all(p.probs[c] == 0.0 for c in prior.hard_nos)


def test_unresolved_meals_count():
    p = run(meal("korean", 1), meal("korean", 2))  # place = None
    assert p.user_counts == {"korean": 2} and p.level == USER


def test_user_shares_are_raw_recency_weighted():
    p = run(meal("thai", 30), meal("pizza", 60))
    assert p.user_shares == {"thai": pytest.approx(2 / 3), "pizza": pytest.approx(1 / 3)}
