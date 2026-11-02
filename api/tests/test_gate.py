"""P2-05: confidence gate (ML6, FR4) and the refinement question by information gain (ML10)."""

import math
import time
from datetime import date

import pytest

from app import gate
from app.cuisine_model import PREDICTABLE
from app.places import Candidate
from app.scoring import Context, History, PastMeal, QuizPrior, StoredPlace, models_for, rank

LAT, LON = 33.95, -84.55
TODAY = date(2026, 10, 29)  # a Thursday
M_PER_DEG = 111_195


def meal(category, days_ago=1, slot="dinner", price=None, place=None, weekend=None,
         source="backfill") -> PastMeal:
    return PastMeal(place=place, eaten_on=date.fromordinal(TODAY.toordinal() - days_ago),
                    source=source, category_id=category, price_level=price, meal_slot=slot,
                    is_weekend=weekend, food_answered=True,
                    went=True if source == "live" else None)


def weekday_meals(category, n, slot="dinner", price=None) -> tuple[PastMeal, ...]:
    # Weekdays only: TODAY - 7k is a Thursday.
    return tuple(meal(category, days_ago=7 * (i + 1), slot=slot, price=price, weekend=False)
                 for i in range(n))


def cand(pid, category, distance_m) -> Candidate:
    return Candidate(id=pid, name=pid, lat=LAT + distance_m / M_PER_DEG, lon=LON,
                     distance_m=distance_m, category=category, geoapify_categories=[],
                     address=None)


def stored(c: Candidate) -> StoredPlace:
    return StoredPlace(id=c.id, name=c.name, lat=c.lat, lon=c.lon, geoapify_categories=(),
                       address=None)


def ctx(**kw) -> Context:
    base = dict(lat=LAT, lon=LON, local_date=TODAY, meal_slot="dinner", is_weekend=False,
                search_radius_m=5000)
    return Context(**{**base, **kw})


def refine_question(cands, history, context):
    models = models_for(history, context)
    ranking = rank(cands, context, history, frozenset(), models)
    budget = gate.predict_budget(history, context.meal_slot, context.is_weekend, TODAY)
    return ranking, gate.next_question(ranking, context, history, frozenset(), models, budget)


def h(p: float) -> float:
    return -sum(x * math.log2(x) for x in (p, 1 - p) if x > 0)


# The 3 questions -------------------------------------------------------------


def test_cold_start_asks_in_the_default_order_with_nothing_pre_filled():
    plan = gate.plan(History(), "dinner", False, TODAY)
    assert plan.order == ("craving", "budget", "distance")
    assert all(q.weak and q.prefill is None for q in plan.questions)


def test_quiz_only_is_weak_everywhere_zero_meals():
    prior = QuizPrior(favorites=frozenset({"thai", "pizza"}), budget_level=2)
    plan = gate.plan(History(prior=prior), "dinner", False, TODAY)
    craving, budget, distance = plan.questions
    assert plan.order == ("craving", "budget", "distance")
    assert (craving.meals, craving.level, craving.weak) == (0, "quiz", True)
    assert (budget.predicted, budget.meals, budget.weak) == (2, 0, True)
    assert budget.top_prob == pytest.approx(0.7)
    assert budget.prefill is None  # the quiz guess alone is not confident (fewer than 5 meals)
    assert distance.weak and distance.level == "none"


def test_four_meals_is_weak_five_is_confident_and_pre_filled():
    four = gate.plan(History(meals=weekday_meals("thai", 4)), "dinner", False, TODAY)
    five = gate.plan(History(meals=weekday_meals("thai", 5)), "dinner", False, TODAY)
    assert next(q for q in four.questions if q.key == "craving").weak
    craving = next(q for q in five.questions if q.key == "craving")
    assert not craving.weak and craving.prefill == "thai" and craving.meals == 5
    assert five.order[-1] == "craving"  # confident: asked last, pre-filled


def test_spread_history_with_many_meals_is_still_weak():
    cats = ("thai", "pizza", "mexican", "indian", "korean")
    meals = tuple(m for c in cats for m in weekday_meals(c, 4))
    craving = gate.plan(History(meals=meals), "dinner", False, TODAY).questions[0]
    assert craving.key == "craving" and craving.meals == 20
    assert craving.top_prob < 0.4 and craving.weak


def test_different_contexts_give_different_first_questions():
    # Weekday lunch: always cheap Thai. Weekend dinner: all over the place.
    lunch = weekday_meals("thai", 10, slot="lunch", price=1)
    spread = ("pizza", "mexican", "indian", "korean", "sushi", "bbq", "italian", "french")
    dinner = tuple(meal(c, days_ago=7 * i + 5, slot="dinner", price=1 + i % 4, weekend=True)
                   for i, c in enumerate(spread))
    history = History(meals=lunch + dinner)
    weekday_lunch = gate.plan(history, "lunch", False, TODAY)
    weekend_dinner = gate.plan(history, "dinner", True, TODAY)
    assert weekday_lunch.order == ("distance", "craving", "budget")  # both confident
    assert weekend_dinner.order[0] == "craving"
    assert weekday_lunch.order[0] != weekend_dinner.order[0]
    lunch_craving = next(q for q in weekday_lunch.questions if q.key == "craving")
    lunch_budget = next(q for q in weekday_lunch.questions if q.key == "budget")
    assert (lunch_craving.prefill, lunch_budget.prefill) == ("thai", 1)


def test_a_hard_no_is_never_predicted_or_pre_filled():
    prior = QuizPrior(favorites=frozenset({"pizza"}), hard_nos=frozenset({"thai"}))
    history = History(prior=prior, meals=weekday_meals("thai", 10) + weekday_meals("pizza", 6))
    craving = gate.plan(history, "dinner", False, TODAY).questions
    craving = next(q for q in craving if q.key == "craving")
    assert craving.predicted == "pizza" and craving.prefill == "pizza"


def test_plan_is_deterministic_and_logs_evidence():
    history = History(meals=weekday_meals("thai", 6, price=2))
    a = gate.plan(history, "dinner", False, TODAY)
    assert a == gate.plan(history, "dinner", False, TODAY)
    log = a.as_log()["questions"]
    assert [q["key"] for q in log] == list(a.order)
    assert set(log[0]) == {"key", "weak", "prefill", "predicted", "top_prob", "meals", "level"}


# Budget model ----------------------------------------------------------------


def test_budget_no_data_no_quiz_is_uniform():
    p = gate.predict_budget(History(), "dinner", False, TODAY)
    assert p.probs == dict.fromkeys(gate.LEVELS, 0.25) and (p.meals, p.level) == (0, "quiz")


def test_budget_quiz_prior():
    p = gate.predict_budget(History(prior=QuizPrior(budget_level=3)), "dinner", False, TODAY)
    assert p.probs[3] == pytest.approx(0.7) and sum(p.probs.values()) == pytest.approx(1)


def test_budget_meals_override_the_prior_and_future_meals_are_ignored():
    meals = weekday_meals("thai", 10, price=1) + (meal("thai", days_ago=-1, price=4),)
    p = gate.predict_budget(History(prior=QuizPrior(budget_level=4), meals=meals),
                            "dinner", False, TODAY)
    assert max(p.probs, key=p.probs.get) == 1
    assert (p.meals, p.level) == (10, "slot_weekend")


def test_budget_backs_off_to_the_slot_level():
    # Two weekend dinners (one alone weighs 0.93 < LEVEL_MIN_N_EFF and would not count).
    meals = weekday_meals("thai", 6, slot="lunch", price=1) + (
        meal("thai", days_ago=3, slot="dinner", price=4, weekend=True),
        meal("thai", days_ago=4, slot="dinner", price=4, weekend=True))
    p = gate.predict_budget(History(meals=meals), "dinner", False, TODAY)
    # Dinner on a weekday has no priced meals: the deepest level with data is dinner overall.
    assert (p.level, p.meals) == ("slot", 2)


def test_unpriced_meals_do_not_count():
    p = gate.predict_budget(History(meals=weekday_meals("thai", 8)), "dinner", False, TODAY)
    assert (p.meals, p.level) == (0, "quiz")


# Information gain ------------------------------------------------------------


def test_entropy_merges_answers_with_the_same_top3():
    a, b = frozenset({"x"}), frozenset({"y"})
    assert gate.entropy([(0.5, a), (0.5, b)]) == 1.0
    assert gate.entropy([(0.25, a), (0.25, a), (0.5, b)]) == 1.0
    assert gate.entropy([(0.3, a), (0.7, a)]) == 0.0
    assert gate.entropy([]) == 0.0


def test_choose_ties_keep_craving_then_budget_then_distance():
    assert gate.choose({"craving": 1.0, "budget": 1.0, "distance": 1.0}) == "craving"
    assert gate.choose({"craving": 0.5, "budget": 1.0, "distance": 1.0}) == "budget"
    assert gate.choose({"craving": 0.0, "budget": 0.0, "distance": 0.0}) is None


def test_budget_wins_when_prices_split_the_top3_and_craving_does_not():
    # Nine Thai places at the same distance, all visited once. The first three are shown.
    # Of the rest, three cost $$$$ and three cost $. Craving cannot change anything (one
    # category), distance cannot (same distance); budget swaps the $$$$ three for the $ three.
    cands = [cand(f"n{i}", "thai", 1000) for i in range(9)]
    price = {f"n{i}": (4 if i < 6 else 1) for i in range(9)}
    meals = tuple(meal("thai", days_ago=3, place=stored(c), price=price[c.id]) for c in cands)
    history = History(meals=meals)
    ranking, nq = refine_question(cands, history, ctx())
    assert [p.scored.place.id for p in ranking.top3] == ["n0", "n1", "n2"]
    assert nq.gains["craving"] == 0.0
    assert nq.gains["distance"] == 0.0
    assert nq.gains["budget"] > 0
    assert (nq.key, nq.options) == ("budget", (1, 2, 3, 4))
    # Hand check: $$$$ keeps n3-n5; $, $$, $$$ give n6-n8. IG = H(P($$$$)).
    p4 = gate.predict_budget(history, "dinner", False, TODAY).probs[4]
    assert nq.gains["budget"] == pytest.approx(h(p4), abs=1e-9)


def test_distance_wins_when_the_radius_splits_the_top3_and_craving_does_not():
    # All Thai, no prices. Far places (20-25 km) were visited, near ones (1 km) were not.
    # At "I don't mind" the far ones lead; "Close to me" drops everything past 15 km.
    far = [cand(f"f{i}", "thai", 20000 + 1000 * i) for i in range(6)]
    near = [cand(f"n{i}", "thai", 1000) for i in range(4)]
    history = History(meals=tuple(meal("thai", days_ago=3, place=stored(c)) for c in far))
    context = ctx(radius_m=35000, search_radius_m=35000)
    ranking, nq = refine_question(far + near, history, context)
    assert {p.scored.place.id for p in ranking.top3} == {"f0", "f1", "f2"}
    assert nq.gains == {"craving": 0.0, "budget": 0.0, "distance": 1.0}
    assert (nq.key, nq.options) == ("distance", (15000, 35000))


def test_craving_wins_when_categories_split_the_top3():
    cats = ("thai", "pizza", "mexican", "indian", "korean")
    cands = [cand(f"{c}{i}", c, 1000) for c in cats for i in range(3)]
    prior = QuizPrior(favorites=frozenset({"thai", "pizza"}))
    ranking, nq = refine_question(cands, History(prior=prior), ctx())
    assert nq.key == "craving" and nq.gains["craving"] > 0
    assert nq.gains["budget"] == 0.0  # no known prices: every budget gives the same picks
    assert len(nq.options) == gate.CRAVING_OPTIONS
    assert set(nq.options) <= set(cats)
    assert nq.options[:2] == ("pizza", "thai")  # favorites first (quiz prior), then id order


def test_craving_options_skip_hard_nos_and_excluded_categories():
    cats = ("thai", "pizza", "mexican", "indian", "korean")
    cands = [cand(f"{c}{i}", c, 1000) for c in cats for i in range(3)]
    history = History(prior=QuizPrior(hard_nos=frozenset({"pizza"})))
    _, nq = refine_question(cands, history, ctx(exclude_categories=frozenset({"thai"})))
    assert nq.key == "craving"
    assert not {"pizza", "thai"} & set(nq.options)


@pytest.mark.parametrize("n", [0, 1, 3, 4])
def test_thin_candidates_mean_no_question(n):
    # At most one place left after the shown three: every answer gives the same picks.
    cands = [cand(f"c{i}", PREDICTABLE[i], 1000 + i) for i in range(n)]
    _, nq = refine_question(cands, History(), ctx())
    assert nq.key is None and nq.as_dict() is None
    assert nq.gains == {"craving": 0.0, "budget": 0.0, "distance": 0.0}


def test_no_history_no_quiz_still_gives_a_valid_choice():
    cats = ("thai", "pizza", "mexican", "indian")
    cands = [cand(f"{c}{i}", c, 500 + 100 * i) for c in cats for i in range(3)]
    _, nq = refine_question(cands, History(), ctx())
    assert nq.key == "craving"  # uniform prior over categories; no prices, one radius split
    assert all(g >= 0 for g in nq.gains.values())


def test_same_inputs_same_question():
    cats = ("thai", "pizza", "mexican")
    cands = [cand(f"{c}{i}", c, 1000) for c in cats for i in range(3)]
    assert refine_question(cands, History(), ctx())[1] == refine_question(
        cands, History(), ctx())[1]


def test_100_candidates_is_fast():
    cats = PREDICTABLE[:24]
    cands = [cand(f"c{i:03d}", cats[i % len(cats)], 200 + 150 * i) for i in range(100)]
    meals = tuple(meal(cats[i % 6], days_ago=1 + i % 40, slot=("lunch", "dinner")[i % 2],
                       price=1 + i % 4, place=stored(cands[i % 30])) for i in range(60))
    history = History(prior=QuizPrior(favorites=frozenset(cats[:3]), budget_level=2),
                      meals=meals)
    context = ctx(search_radius_m=35000, radius_m=35000)
    models = models_for(history, context)
    ranking = rank(cands, context, history, frozenset(), models)
    budget = gate.predict_budget(history, "dinner", False, TODAY)
    runs = 5
    started = time.perf_counter()
    for _ in range(runs):
        nq = gate.next_question(ranking, context, history, frozenset(), models, budget)
    per_call = (time.perf_counter() - started) / runs
    print(f"\nnext_question, 100 candidates: {per_call * 1000:.1f} ms per call ({nq.key})")
    assert nq.key is not None
    assert per_call < 0.5  # generous ceiling so CI noise never flakes; measured is far lower


# What the phone asked (round 1) ------------------------------------------------

PLAN = gate.plan(History(), "dinner", False, TODAY)  # craving, budget, distance


def test_asked_plan_used_matches():
    log = gate.asked_log(["craving", "budget", "distance"], "plan", PLAN)
    assert log == {"status": "ok", "order": ["craving", "budget", "distance"],
                   "source": "plan", "matches_plan": True}


def test_asked_fallback_is_logged_as_such():
    log = gate.asked_log(["craving", "budget", "distance"], "fallback", PLAN)
    assert (log["status"], log["source"], log["matches_plan"]) == ("ok", "fallback", True)


def test_asked_new_search_after_a_pick():
    # Craving first (the typed text is the craving), then the session's order.
    log = gate.asked_log(["craving", "distance", "budget"], "new_search", PLAN)
    assert log == {"status": "ok", "order": ["craving", "distance", "budget"],
                   "source": "new_search", "matches_plan": False}


def test_asked_mismatch_with_the_recomputed_plan():
    log = gate.asked_log(["budget", "distance", "craving"], "plan", PLAN)
    assert (log["status"], log["matches_plan"]) == ("ok", False)
    assert log["order"] == ["budget", "distance", "craving"]


def test_asked_missing_from_an_older_app():
    assert gate.asked_log(None, None, PLAN) == {
        "status": "missing", "order": None, "source": None, "matches_plan": None}


@pytest.mark.parametrize("order", [
    ["craving", "craving", "budget"],  # duplicate
    ["craving", "budget"],  # too short
    ["craving", "budget", "distance", "company"],  # too long
    ["craving", "budget", "company"],  # unknown key
    ["craving", "budget", 3],  # not a string
    "craving,budget,distance",  # not a list
    [],
])
def test_asked_invalid_order_is_never_logged_as_given(order):
    log = gate.asked_log(order, "plan", PLAN)
    assert log == {"status": "invalid", "order": None, "source": "plan", "matches_plan": None}


@pytest.mark.parametrize("source", ["Plan", "guess", 1, None, ["plan"], "New_search",
                                    "new-search", "newsearch"])
def test_asked_invalid_source(source):
    log = gate.asked_log(["craving", "budget", "distance"], source, PLAN)
    assert (log["status"], log["source"]) == ("invalid", None)
    assert log["order"] == ["craving", "budget", "distance"]  # the valid part is kept


# Pre-fill trace ----------------------------------------------------------------


def test_prefilled_valid_keeps_both_sets_in_question_order():
    trace = {"shown": {"distance": None, "budget": 2, "craving": None},
             "received": {"budget": 1, "craving": "chinese", "distance": 15000}}
    log = gate.prefilled_log(trace)
    assert log == {"status": "ok",
                   "received": {"craving": "chinese", "budget": 1, "distance": 15000},
                   "shown": {"craving": None, "budget": 2, "distance": None}}


def test_prefilled_missing():
    assert gate.prefilled_log(None) == {"status": "missing", "received": None, "shown": None}


@pytest.mark.parametrize("bad", [
    {"craving": "Chinese", "budget": None, "distance": None},
    {"craving": "other", "budget": None, "distance": None},  # Other is never predicted
    {"craving": None, "budget": 0, "distance": None},
    {"craving": None, "budget": 2.0, "distance": None},
    {"craving": None, "budget": None, "distance": 1500},
    {"craving": None, "budget": None, "distance": None, "company": None},
])
def test_prefilled_invalid_values(bad):
    ok = {"craving": None, "budget": None, "distance": None}
    assert gate.prefilled_log({"received": ok, "shown": bad})["status"] == "invalid"
