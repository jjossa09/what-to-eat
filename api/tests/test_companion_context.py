"""P2-07 (#27): companion context in the models (FR15, ML1, ML3, ML6). Written before the code.

Contract (what the implementation must provide; this file is off-limits to the implementer):

Data
- PastMeal.companion_ids: frozenset[str] = frozenset()  (the meal's companions, ids)
- PastMeal.solo: bool | None = None                     (meals.solo)
- QuizPrior.mostly_solo: bool | None = None             (taste_profiles.mostly_solo)
- History.companions: frozenset[str] = frozenset()      (ids of the user's companions)
- history.load reads meals.solo and meal_companions(companion_id) on the meals query, and
  taste_profiles.mostly_solo. It reads the companions table for every user, whatever the
  quiz says (saved companions decide whether company joins the gate).
  Live and backfill companions both count (decision ii).

Cuisine model (ML3)
- With Context.companion_ids non-empty, one more level after slot_weekend, named
  "companion_slot": counted meals in the same meal slot (weekday or weekend alike) whose
  companions include every selected companion. Smoothed toward slot_weekend with the same
  K and half-life; reported when its weighted count is >= LEVEL_MIN_N_EFF.
- Empty companion_ids (no company answer, or solo): exactly today's prediction.

Gate (ML6, FR15), key "company"
- Company joins the pool when History.companions is non-empty (at least one saved companion),
  whatever the quiz says. prior.mostly_solo only feeds the company prior. Pool of 3 (no
  company): exactly today's plan, nothing skipped.
- Pool of 4: ask 3. Skip the most confident question (highest top_prob) among the confident
  ones (not weak by the ML6 rule). Ties skip budget. If none is confident, skip company.
  The 3 asked keep today's order rule: weak first, then the order craving, budget, distance,
  company.
- gate.arrange(questions) -> Plan: the rule above on the pool's Questions (in that order).
- Plan.skipped: Question | None. The skipped question's prediction is its answer. Plan.as_log()
  adds "skipped": the question's dict, or None. /questions/plan adds "skipped" too.
- Company prediction: outcomes "solo" (meal.solo is True) or the meal's companion group
  (sorted list of ids); other meals don't count. Prior: gate.company_prior(mostly_solo, groups)
  -> {"solo": p, group tuple: p}. Quiz solo: solo QUIZ_FAVORITES_MASS, the observed groups
  share the rest equally. Quiz with people: solo 1 - QUIZ_FAVORITES_MASS, groups share
  QUIZ_FAVORITES_MASS. No quiz answer: equal shares. No observed groups: solo keeps its quiz
  share and the rest goes to the placeholder gate.UNSEEN_GROUP, so the prior sums to 1 and
  never gives solo 1.0. The placeholder is never an answer: on top, company is weak with
  predicted None. Same levels (user, slot, slot_weekend),
  recency weight, K, and ML6 rule as the budget model; no data = weak. predicted is "solo"
  or the sorted list of ids.
- gate.asked_log accepts any 3 distinct keys of the pool the server recomputed; "company" stays
  invalid when company is not in that pool.

Live path
- POST /recommendations takes companion_ids: list of UUIDs (malformed = 422). They become
  Context.companion_ids on every round. Round 1 writes one session_companions row per id
  (session_id, companion_id, user_id), as the user. Later rounds write none.
- A pick copies the session's companions to meal_companions (meal_id, companion_id, user_id),
  as the user. A session without companions makes no meal_companions call (the existing pick
  test stays as is).

Evaluation (ML9): the replay passes no companions, so its results are unchanged.
Synthetic data only.
"""

import dataclasses
import json
from datetime import date, timedelta

import httpx2
import pytest

from app import gate, history
from app.cuisine_model import SLOT_WEEKEND, predict, recency_weight
from app.scoring import Context, History, PastMeal, QuizPrior, StoredPlace, is_weak
from app.scoring_rules import QUIZ_FAVORITES_MASS, SMOOTHING_K
from scripts.evaluate import build_runs
from tests import test_funnel as funnel_t
from tests import test_history as history_t
from tests import test_recommendations as rec_t
from tests.test_recommendations import env  # noqa: F401 (autouse: API settings for each test)

TODAY = date(2026, 10, 29)  # a Thursday
COMPANION_SLOT, COMPANY = "companion_slot", "company"
A = "aaaaaaaa-1111-4111-8111-000000000001"
B = "bbbbbbbb-2222-4222-8222-000000000002"
C = "cccccccc-3333-4333-8333-000000000003"
MEAL_ID = "33333333-3333-3333-3333-333333333333"


# Helpers: fail with a clear message (not a TypeError) while the fields don't exist yet. ----


def require(cls, *names):
    have = {f.name for f in dataclasses.fields(cls)}
    missing = [n for n in names if n not in have]
    if missing:
        pytest.fail(f"P2-07 not implemented: {cls.__name__} has no {', '.join(missing)}")


def meal(category, days_ago=1, slot="dinner", weekend=False, with_=(), solo=None,
         source="backfill", answered=True, price=None, place=None, on=None) -> PastMeal:
    require(PastMeal, "companion_ids", "solo")
    return PastMeal(place=place, eaten_on=on or TODAY - timedelta(days=days_ago), source=source,
                    category_id=category, price_level=price, meal_slot=slot, is_weekend=weekend,
                    food_answered=answered, went=True if source == "live" else None,
                    companion_ids=frozenset(with_), solo=solo)


def stripped(m: PastMeal) -> PastMeal:
    return dataclasses.replace(m, companion_ids=frozenset(), solo=None)


def ctx(with_=(), slot="dinner", weekend=False) -> Context:
    return Context(lat=0.0, lon=0.0, local_date=TODAY, meal_slot=slot, is_weekend=weekend,
                   search_radius_m=5000, companion_ids=frozenset(with_))


def hist(*meals, prior=QuizPrior(), companions=()) -> History:
    require(History, "companions")
    return History(prior=prior, meals=tuple(meals), companions=frozenset(companions))


def with_people(**kw) -> QuizPrior:
    require(QuizPrior, "mostly_solo")
    return QuizPrior(mostly_solo=False, **kw)


def run(h: History, with_=(), as_of=TODAY, **kw):
    return predict(h, ctx(with_, **kw), as_of)


def weekly(category, n, start=7, step=7, **kw) -> list[PastMeal]:
    return [meal(category, days_ago=start + step * i, **kw) for i in range(n)]


# Cuisine model: the companion level ---------------------------------------------------------


def test_companion_slot_is_the_most_specific_level_with_the_fixed_formula():
    # Background: pizza dinners. With A: Thai, on weekday and weekend dinners (same slot,
    # either day type counts); an A lunch is another slot and does not count.
    with_a = [meal("thai", d, with_=[A]) for d in (2, 3, 4)] + [
        meal("thai", 5, weekend=True, with_=[A])]
    noise = [meal("sushi", 6, slot="lunch", with_=[A])]
    h = hist(*weekly("pizza", 6), *with_a, *noise)
    parent = run(h).probs  # no companion: today's chain ending at slot_weekend
    got = run(h, with_=[A])
    assert got.level == COMPANION_SLOT
    assert got.meals == 4
    n = sum(recency_weight(d) for d in (2, 3, 4, 5))
    assert got.n_eff == pytest.approx(n)
    for c, p in got.probs.items():
        w = n if c == "thai" else 0.0
        assert p == pytest.approx((w + SMOOTHING_K * parent[c]) / (n + SMOOTHING_K))
    assert max(got.probs, key=got.probs.get) == "thai"


def test_a_different_companion_gives_a_different_prediction():
    h = hist(*[meal("thai", d, with_=[A]) for d in (1, 2, 3, 4)],
             *[meal("japanese_sushi", d, with_=[B]) for d in (1, 2, 3, 4)])
    a, b = run(h, with_=[A]), run(h, with_=[B])
    assert max(a.probs, key=a.probs.get) == "thai"
    assert max(b.probs, key=b.probs.get) == "japanese_sushi"


def test_no_companion_meals_in_this_slot_backs_off_to_slot_weekend():
    h = hist(*weekly("pizza", 6), *[meal("thai", d, slot="lunch", with_=[A]) for d in (1, 2, 3)])
    got, today = run(h, with_=[A]), run(h)
    assert got.level == today.level == SLOT_WEEKEND
    assert got.probs == pytest.approx(today.probs, abs=1e-12)


def test_no_companion_selected_is_exactly_today():
    meals = [*weekly("pizza", 5), *[meal("thai", d, with_=[A, B]) for d in (1, 2)],
             meal("bbq", 3, solo=True), meal("thai", 9, weekend=True, with_=[A])]
    with_data = run(hist(*meals))
    without = run(hist(*[stripped(m) for m in meals]))
    assert with_data == without  # companion data never changes a no-companion prediction


def test_an_unknown_companion_is_the_same_as_none():
    h = hist(*weekly("pizza", 6), *[meal("thai", d, with_=[A]) for d in (1, 2, 3)])
    got, today = run(h, with_=[C]), run(h)
    assert got.level == today.level
    assert got.probs == pytest.approx(today.probs, abs=1e-12)


def test_group_rule_meals_must_include_every_selected_companion():
    h = hist(*[meal("japanese_sushi", d, with_=[A]) for d in (1, 2, 3, 4, 5)],  # A alone
             *[meal("thai", d, with_=[A, B]) for d in (6, 7, 8)],
             meal("thai", 9, with_=[A, B, C]))  # a bigger group still includes A and B
    got = run(h, with_=[A, B])
    assert got.level == COMPANION_SLOT and got.meals == 4
    assert max(got.probs, key=got.probs.get) == "thai"


def test_live_and_backfill_companion_meals_both_count():
    h = hist(*[meal("thai", d, with_=[A]) for d in (1, 2)],
             *[meal("thai", d, with_=[A], source="live") for d in (3, 4)],
             *[meal("thai", d, with_=[A], source="live", answered=False) for d in (5, 6, 7)])
    got = run(h, with_=[A])
    assert got.level == COMPANION_SLOT
    assert got.meals == 4  # live meals without a food answer never count (ML3, unchanged)


def test_hard_nos_and_other_never_count_at_the_companion_level():
    prior = QuizPrior(hard_nos=frozenset({"thai"}))
    h = hist(*[meal("thai", d, with_=[A]) for d in (1, 2, 3)],
             *[meal("other", d, with_=[A]) for d in (4, 5)],
             *[meal("pizza", d, with_=[A]) for d in (6, 7)], prior=prior)
    got = run(h, with_=[A])
    assert got.probs["thai"] == 0.0 and "other" not in got.probs
    assert got.level == COMPANION_SLOT and got.meals == 2


# Thin data --------------------------------------------------------------------------------


def test_one_companion_meal_never_creates_a_confident_pattern():
    background = [meal(c, 7 * (i + 1)) for i, c in enumerate(("pizza", "mexican", "indian"))]
    h = hist(*background, meal("thai", 1, with_=[A]))
    got, parent = run(h, with_=[A]), run(h)
    assert got.level != COMPANION_SLOT  # one meal weighs < 1: the level is not reported
    assert is_weak(got)
    bound = 1 / (1 + SMOOTHING_K)  # n / (n + K) with n <= 1
    assert max(abs(got.probs[c] - parent.probs[c]) for c in got.probs) <= bound + 1e-12


def test_four_companion_meals_stay_weak_even_on_a_confident_background():
    h = hist(*weekly("pizza", 10), *[meal("thai", d, with_=[A]) for d in (1, 2, 3, 4)])
    assert not is_weak(run(h))  # without company: confident (pizza)
    got = run(h, with_=[A])
    assert got.level == COMPANION_SLOT and got.meals == 4
    assert is_weak(got)  # the companion pattern rests on 4 meals: ask


def test_five_consistent_companion_meals_are_confident():
    h = hist(*weekly("pizza", 10), *[meal("thai", d, with_=[A]) for d in (1, 2, 3, 4, 5)])
    got = run(h, with_=[A])
    assert got.level == COMPANION_SLOT and got.meals == 5
    assert not is_weak(got) and max(got.probs, key=got.probs.get) == "thai"


# as_of: no future meals ---------------------------------------------------------------------


def test_companion_meals_on_or_after_as_of_never_count():
    past = [*weekly("pizza", 6), *[meal("thai", d, with_=[A]) for d in (1, 2, 3)]]
    future = [meal("japanese_sushi", on=TODAY, with_=[A]),
              *[meal("japanese_sushi", d, with_=[A]) for d in (-1, -2, -5)]]
    assert run(hist(*past, *future), with_=[A]) == run(hist(*past), with_=[A])


# History loading ----------------------------------------------------------------------------


class HistoryFake(history_t.Supabase):
    """The history test fake, plus the companions table."""

    def __init__(self, companions=(), **kw):
        super().__init__(**kw)
        self.bodies["companions"] = [{"id": c} for c in companions]


def test_meals_query_loads_companions_and_solo():
    assert "meal_companions(companion_id)" in history.MEALS_SELECT
    assert "solo" in history.MEALS_SELECT.split(",")
    assert "mostly_solo" in history.PRIOR_SELECT.split(",")


def test_parses_meal_companions_and_solo():
    require(PastMeal, "companion_ids", "solo")
    rows = [
        history_t.meal_row(meal_companions=[{"companion_id": A}, {"companion_id": B}], solo=False),
        history_t.meal_row(meal_companions=[], solo=True),
        history_t.meal_row(meal_companions=[{"companion_id": 7}, {}, "x", {"companion_id": A}]),
        history_t.meal_row(),  # no embed: no companions
    ]
    loaded = history_t.run_load(HistoryFake(meals=rows))
    assert [m.companion_ids for m in loaded.meals] == [
        frozenset({A, B}), frozenset(), frozenset({A}), frozenset()]
    assert [m.solo for m in loaded.meals] == [False, True, None, None]


def test_saved_companions_are_read_as_the_user():
    require(History, "companions")
    up = HistoryFake(prior=[{"mostly_solo": False}], companions=[A, B])
    loaded = history_t.run_load(up)
    assert loaded.prior.mostly_solo is False
    assert loaded.companions == frozenset({A, B})
    (read,) = [r for r in up.requests if r.url.path.endswith("/companions")]
    assert read.url.params["user_id"] == f"eq.{history_t.USER_ID}"
    assert read.headers["authorization"] == f"Bearer {history_t.TOKEN}"


@pytest.mark.parametrize("prior", [[{"mostly_solo": True}], [{"mostly_solo": False}], [{}], []])
def test_no_saved_companions_loads_an_empty_set_for_any_quiz(prior):
    require(History, "companions")
    up = HistoryFake(prior=prior, companions=[])
    loaded = history_t.run_load(up)
    assert loaded.companions == frozenset()
    (read,) = [r for r in up.requests if r.url.path.endswith("/companions")]
    assert read.url.params["user_id"] == f"eq.{history_t.USER_ID}"


# Gate: company in the pool (decision 1) -----------------------------------------------------


def q(key, top, meals=8, weak=None, predicted="x") -> gate.Question:
    weak = (top < 0.4 or meals < 5) if weak is None else weak
    return gate.Question(key, weak, predicted, top, meals, "slot_weekend")


def arrange(*questions):
    if not hasattr(gate, "arrange"):
        pytest.fail("P2-07 not implemented: gate.arrange")
    return gate.arrange(tuple(questions))


def skipped_key(plan):
    if not hasattr(plan, "skipped"):
        pytest.fail("P2-07 not implemented: Plan.skipped")
    return plan.skipped.key if plan.skipped else None


def test_device_case_budget_is_skipped_and_craving_at_046_is_asked():
    plan = arrange(q("craving", 0.46, predicted="chinese"), q("budget", 0.96, predicted=1),
                   q("distance", 0.5, meals=0, weak=True), q(COMPANY, 0.3, meals=0))
    assert skipped_key(plan) == "budget" and plan.skipped.predicted == 1
    assert plan.order == ("distance", COMPANY, "craving")  # weak first, then craving


def test_craving_is_never_skipped_while_a_more_confident_question_exists():
    plan = arrange(q("craving", 0.46), q("budget", 0.96), q("distance", 0.5, meals=0, weak=True),
                   q(COMPANY, 0.9, meals=12))
    assert skipped_key(plan) == "budget"
    assert "craving" in plan.order


def test_company_is_skipped_when_nothing_else_is_confident():
    plan = arrange(q("craving", 0.3), q("budget", 0.25, meals=0),
                   q("distance", 0.5, meals=0, weak=True), q(COMPANY, 0.3, meals=0))
    assert skipped_key(plan) == COMPANY
    assert plan.order == ("craving", "budget", "distance")


def test_a_high_probability_on_thin_data_is_not_confident_so_it_is_not_skipped():
    plan = arrange(q("craving", 0.9, meals=3), q("budget", 0.25, meals=0),
                   q("distance", 0.5, meals=0, weak=True), q(COMPANY, 0.3, meals=0))
    assert skipped_key(plan) == COMPANY
    assert "craving" in plan.order


def test_ties_skip_budget():
    plan = arrange(q("craving", 0.8), q("budget", 0.8), q("distance", 0.5, meals=0, weak=True),
                   q(COMPANY, 0.3, meals=0))
    assert skipped_key(plan) == "budget"


def test_a_confident_company_can_be_the_one_skipped():
    plan = arrange(q("craving", 0.3), q("budget", 0.5), q("distance", 0.5, meals=0, weak=True),
                   q(COMPANY, 0.9, meals=12, predicted=[A]))
    assert skipped_key(plan) == COMPANY and plan.skipped.predicted == [A]
    assert plan.order == ("craving", "distance", "budget")


def test_a_pool_of_three_skips_nothing():
    plan = arrange(q("craving", 0.46), q("budget", 0.96), q("distance", 0.5, meals=0, weak=True))
    assert skipped_key(plan) is None
    assert plan.order == ("distance", "craving", "budget")  # today's order rule


def device_history(prior, companions=()) -> History:
    # 8 dinners, 3 of them Chinese, all at $: craving about 0.43, budget about 0.97 (both
    # confident), like the device test.
    others = ("thai", "pizza", "mexican", "indian", "korean")
    cats = ("chinese",) * 3 + others
    return hist(*[meal(c, 3 * (i + 1), price=1) for i, c in enumerate(cats)], prior=prior,
                companions=companions)


def test_plan_no_company_without_saved_companions_when_the_quiz_says_solo():
    require(QuizPrior, "mostly_solo")
    plan = gate.plan(device_history(QuizPrior(mostly_solo=True, budget_level=2)),
                     "dinner", False, TODAY)
    assert plan.order == ("distance", "craving", "budget")
    assert skipped_key(plan) is None


def test_plan_company_joins_when_the_quiz_says_solo_but_companions_exist():
    require(QuizPrior, "mostly_solo")
    plan = gate.plan(device_history(QuizPrior(mostly_solo=True, budget_level=2), [A]),
                     "dinner", False, TODAY)
    # Same as the with-people device case: no meal has known company, so company is weak and
    # asked; budget (0.97) is the most confident and is skipped.
    assert plan.order == ("distance", COMPANY, "craving")
    assert skipped_key(plan) == "budget" and plan.skipped.predicted == 1


def test_plan_no_company_without_companions():
    plan = gate.plan(device_history(with_people(budget_level=2)), "dinner", False, TODAY)
    assert COMPANY not in plan.order and skipped_key(plan) is None


def test_plan_device_case_with_company_skips_budget_and_logs_it():
    plan = gate.plan(device_history(with_people(budget_level=2), [A]), "dinner", False, TODAY)
    craving = next(x for x in plan.questions if x.key == "craving")
    assert not craving.weak and 0.4 <= craving.top_prob < 0.5
    assert plan.order == ("distance", COMPANY, "craving")
    assert skipped_key(plan) == "budget" and plan.skipped.predicted == 1
    log = plan.as_log()
    assert [x["key"] for x in log["questions"]] == ["distance", COMPANY, "craving"]
    assert log["skipped"]["key"] == "budget" and log["skipped"]["predicted"] == 1


def test_plan_cold_start_with_company_skips_company():
    plan = gate.plan(hist(prior=with_people(), companions=[A]), "dinner", False, TODAY)
    assert plan.order == ("craving", "budget", "distance")
    assert skipped_key(plan) == COMPANY


def test_company_prediction_from_meals_with_the_same_group():
    h = hist(*[meal("thai", d, with_=[B, A]) for d in range(1, 11)], prior=with_people(),
             companions=[A, B])
    plan = gate.plan(h, "dinner", False, TODAY)
    everyone = {x.key: x for x in [*plan.questions, *([plan.skipped] if plan.skipped else [])]}
    company = everyone[COMPANY]
    assert not company.weak and company.predicted == sorted([A, B])


def test_company_prediction_solo():
    h = hist(*[meal("thai", d, solo=True) for d in range(1, 11)], prior=with_people(),
             companions=[A])
    plan = gate.plan(h, "dinner", False, TODAY)
    everyone = {x.key: x for x in [*plan.questions, *([plan.skipped] if plan.skipped else [])]}
    assert everyone[COMPANY].predicted == "solo" and not everyone[COMPANY].weak


def company_prior(mostly_solo, groups):
    if not hasattr(gate, "company_prior"):
        pytest.fail("P2-07 not implemented: gate.company_prior(mostly_solo, groups)")
    return gate.company_prior(mostly_solo, groups)


GROUPS = [(A,), (A, B)]


@pytest.mark.parametrize("mostly_solo,solo,each_group", [
    (True, QUIZ_FAVORITES_MASS, (1 - QUIZ_FAVORITES_MASS) / 2),   # 0.7, 0.15 each
    (False, 1 - QUIZ_FAVORITES_MASS, QUIZ_FAVORITES_MASS / 2),    # 0.3, 0.35 each
    (None, 1 / 3, 1 / 3),                                         # no quiz answer: equal
])
def test_company_prior_with_no_meals(mostly_solo, solo, each_group):
    probs = company_prior(mostly_solo, GROUPS)
    assert probs == pytest.approx({"solo": solo, (A,): each_group, (A, B): each_group},
                                  abs=1e-12)


def unseen_group():
    if not hasattr(gate, "UNSEEN_GROUP"):
        pytest.fail("P2-07 not implemented: gate.UNSEEN_GROUP")
    return gate.UNSEEN_GROUP


def test_company_prior_without_groups_keeps_the_quiz_share_for_solo():
    probs = company_prior(True, [])
    assert probs == pytest.approx({"solo": QUIZ_FAVORITES_MASS,
                                   unseen_group(): 1 - QUIZ_FAVORITES_MASS}, abs=1e-12)


def test_twenty_solo_dinners_without_groups_skip_company_as_solo():
    days = range(1, 21)
    cats = ("thai", "pizza", "mexican", "indian", "korean")  # craving stays weak
    h = hist(*[meal(cats[d % 5], d, solo=True) for d in days],
             prior=QuizPrior(mostly_solo=False), companions=[A])
    # Prior: solo 0.3, unseen group 0.7. Every meal is a weekday dinner: three equal levels.
    n = sum(recency_weight(d) for d in days)
    p_solo = 1 - QUIZ_FAVORITES_MASS
    for _ in range(3):
        p_solo = (n + SMOOTHING_K * p_solo) / (n + SMOOTHING_K)
    assert 0.4 <= p_solo < 1.0
    plan = gate.plan(h, "dinner", False, TODAY)
    assert plan.order == ("craving", "budget", "distance")
    assert skipped_key(plan) == COMPANY
    assert plan.skipped.predicted == "solo" and not plan.skipped.weak
    assert plan.skipped.top_prob == pytest.approx(p_solo, abs=1e-12)


def test_unseen_group_on_top_is_weak_and_never_an_answer():
    # One solo lunch: counted at the user level only. Prior solo 0.3, unseen 0.7, so after
    # one level the unseen group stays on top and the dinner levels add nothing.
    h = hist(meal("thai", 1, slot="lunch", solo=True), prior=QuizPrior(mostly_solo=False),
             companions=[A])
    w = recency_weight(1)
    p_unseen = SMOOTHING_K * QUIZ_FAVORITES_MASS / (w + SMOOTHING_K)
    assert p_unseen > (w + SMOOTHING_K * (1 - QUIZ_FAVORITES_MASS)) / (w + SMOOTHING_K)
    got = gate.predict_company(h, "dinner", False, TODAY)
    assert got.weak and got.predicted is None and got.prefill is None
    assert got.predicted != unseen_group()


def test_quiz_solo_is_overridden_by_five_dinners_with_a():
    days = range(1, 6)
    h = hist(*[meal("thai", d, with_=[A]) for d in days],
             prior=QuizPrior(mostly_solo=True), companions=[A])
    # Prior: solo 0.7, A 0.3. Every meal is a weekday dinner, so user, slot, and slot_weekend
    # all count the same n, and each smooths toward the level before it.
    n = sum(recency_weight(d) for d in days)
    p_a = 1 - QUIZ_FAVORITES_MASS
    for _ in range(3):
        p_a = (n + SMOOTHING_K * p_a) / (n + SMOOTHING_K)
    assert p_a == pytest.approx(0.9581, abs=1e-4)
    got = gate.predict_company(h, "dinner", False, TODAY)
    assert got.predicted == [A]
    assert got.top_prob == pytest.approx(p_a, abs=1e-12)
    assert got.meals == 5 and not got.weak


def test_company_without_data_is_weak():
    h = hist(*weekly("pizza", 6), prior=with_people(), companions=[A])
    plan = gate.plan(h, "dinner", False, TODAY)
    everyone = {x.key: x for x in [*plan.questions, *([plan.skipped] if plan.skipped else [])]}
    assert everyone[COMPANY].weak


def test_every_plan_asks_exactly_three():
    for h in (hist(prior=with_people(), companions=[A]),
              device_history(with_people(budget_level=2), [A]),
              device_history(QuizPrior(budget_level=2))):
        assert len(gate.plan(h, "dinner", False, TODAY).order) == 3


def test_asked_order_with_company_is_valid_only_when_company_is_in_the_pool():
    with_company = gate.plan(device_history(with_people(budget_level=2), [A]), "dinner", False,
                             TODAY)
    log = gate.asked_log(["distance", COMPANY, "craving"], "plan", with_company)
    assert (log["status"], log["matches_plan"]) == ("ok", True)
    without = gate.plan(device_history(QuizPrior(budget_level=2)), "dinner", False, TODAY)
    assert gate.asked_log(["distance", COMPANY, "craving"], "plan", without)["status"] == "invalid"


# Live path: request, session_companions, meal_companions --------------------------------------


class Upstreams(rec_t.Upstreams):
    """The recommendations fake, plus the companion tables."""

    def __init__(self, companions=(), **kw):
        super().__init__(**kw)
        self.companions = list(companions)

    def supabase(self, request):
        table = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET" and table == "companions":
            return httpx2.Response(200, json=[{"id": c} for c in self.companions])
        if request.method == "POST" and table == "session_companions":
            return httpx2.Response(201)
        return rec_t.supabase(self, request)


def session_companion_rows(up) -> list[dict]:
    return [row for r in rec_t.writes(up, "session_companions") for row in json.loads(r.content)]


def test_round_one_records_the_session_companions_as_the_user():
    up = Upstreams()
    body = rec_t.post(up, companion_ids=[A, B]).json()
    assert body["round"] == 1
    rows = sorted(session_companion_rows(up), key=lambda r: r["companion_id"])
    assert rows == [{"session_id": rec_t.SESSION_ID, "companion_id": A, "user_id": rec_t.USER_ID},
                    {"session_id": rec_t.SESSION_ID, "companion_id": B, "user_id": rec_t.USER_ID}]
    for r in rec_t.writes(up, "session_companions"):
        assert r.headers["authorization"] == f"Bearer {rec_t.TOKEN}"
        assert r.headers["apikey"] != rec_t.SERVICE_KEY


def test_later_rounds_record_no_session_companions():
    up = Upstreams(shown=rec_t.ROUND_1)
    rec_t.follow_up(up, companion_ids=[A], refine={"budget": "cheaper"})
    assert rec_t.writes(up, "session_companions") == []


def test_no_companions_makes_no_session_companions_call():
    up = Upstreams()
    rec_t.post(up)
    assert rec_t.writes(up, "session_companions") == []


@pytest.mark.parametrize("ids", [["not-a-uuid"], [123], "aaaa"])
def test_malformed_companion_ids_are_rejected(ids):
    assert rec_t.post(Upstreams(), companion_ids=ids).status_code == 422


def companion_meals(companion, category, days):
    return [{"source": "backfill", "category_id": category,
             "eaten_on": (TODAY - timedelta(days=d)).isoformat(), "meal_slot": "dinner",
             "is_weekend": False, "price_level": None, "places": None,
             "meal_companions": [{"companion_id": companion}]} for d in days]


def test_same_answers_with_a_different_companion_give_different_picks(monkeypatch):
    # #27 acceptance. With A the user eats Mexican; with B, Thai. Same answers otherwise.
    places = [rec_t.feature(f"Thai {i}", 200 + i, 33.951 + 0.001 * i,
                            ["catering", "catering.restaurant.thai"]) for i in range(3)]
    places += [rec_t.feature(f"Taco {i}", 300 + i, 33.951 + 0.001 * i,
                             ["catering", "catering.restaurant.mexican"]) for i in range(3)]
    monkeypatch.setattr(rec_t, "FEATURES", places)
    monkeypatch.setattr(rec_t, "MEALS", companion_meals(A, "mexican", range(1, 7))
                        + companion_meals(B, "thai", range(1, 7)))
    with_a = rec_t.post(Upstreams(), companion_ids=[A]).json()["picks"]
    with_b = rec_t.post(Upstreams(), companion_ids=[B]).json()["picks"]
    assert [p["id"] for p in with_a] != [p["id"] for p in with_b]
    assert with_a[0]["category"] == "mexican" and with_b[0]["category"] == "thai"


def test_plan_endpoint_includes_company_and_the_skipped_question(monkeypatch):
    monkeypatch.setattr(rec_t, "PRIOR", [{"favorite_categories": ["thai"],
                                          "hard_no_categories": [], "budget_level": 2,
                                          "mostly_solo": False}])
    monkeypatch.setattr(rec_t, "MEALS", [])
    body = rec_t.plan_post(Upstreams(companions=[A])).json()
    assert [x["key"] for x in body["questions"]] == ["craving", "budget", "distance"]
    assert body["skipped"]["key"] == COMPANY  # cold start: nothing confident


def test_plan_endpoint_without_company_has_no_skipped(monkeypatch):
    body = rec_t.plan_post(Upstreams()).json()
    assert "skipped" in body and body["skipped"] is None


def test_round_one_logs_the_skipped_question_in_the_gate_entry(monkeypatch):
    monkeypatch.setattr(rec_t, "PRIOR", [{"favorite_categories": [], "hard_no_categories": [],
                                          "budget_level": 2, "mostly_solo": False}])
    monkeypatch.setattr(rec_t, "MEALS", [])
    up = Upstreams(companions=[A])
    rec_t.post(up)
    plan = rec_t.gate_calls(up)[0]["p_plan"]
    assert plan["skipped"]["key"] == COMPANY


class FunnelFake(funnel_t.Supabase):
    """The funnel test fake, plus companions on the session and the meal's id."""

    def __init__(self, session_companions=(), **kw):
        super().__init__(**kw)
        self.session_companions = [{"companion_id": c} for c in session_companions]

    def __call__(self, request):
        table = request.url.path.rsplit("/", 1)[-1]
        key = f"{request.method} {table}"
        if key == "GET recommendation_events" and self.shown:
            self.requests.append(request)
            session = {**funnel_t.SESSION, "outcome": self.outcome,
                       "session_companions": self.session_companions}
            return httpx2.Response(200, json=[{"place_id": funnel_t.PLACE_ID,
                                               "places": funnel_t.PLACE, "sessions": session}])
        if key == "GET session_companions":
            self.requests.append(request)
            return httpx2.Response(200, json=self.session_companions)
        if key == "POST meals":
            self.requests.append(request)
            return httpx2.Response(201, json=[{"id": MEAL_ID}])
        if key == "POST meal_companions":
            self.requests.append(request)
            return httpx2.Response(201)
        return super().__call__(request)


def test_a_pick_copies_the_session_companions_to_the_meal():
    up = FunnelFake(session_companions=[B, A])
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 200
    inserts = up.calls("POST", "meal_companions")
    assert len(inserts) == 1, "P2-07 not implemented: the pick copies no companions to the meal"
    rows = sorted(json.loads(inserts[0].content), key=lambda r: r["companion_id"])
    assert rows == [{"meal_id": MEAL_ID, "companion_id": A, "user_id": funnel_t.USER_ID},
                    {"meal_id": MEAL_ID, "companion_id": B, "user_id": funnel_t.USER_ID}]
    funnel_t.assert_as_user(up)


def test_a_pick_without_companions_makes_no_meal_companions_call():
    up = FunnelFake()
    assert funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID}).status_code \
        == 200
    assert up.calls("POST", "meal_companions") == []


# Evaluation (ML9) ---------------------------------------------------------------------------


def test_offline_evaluation_is_unchanged_by_companion_data():
    places = [StoredPlace(f"node/{i}", f"Place {i}", 33.95, -84.55, ("catering.restaurant",),
                          None) for i in range(4)]
    cats = ("thai", "pizza", "mexican", "thai", "pizza", "thai", "indian", "thai")
    meals = [meal(c, days_ago=2 * i + 1, slot=("lunch", "dinner")[i % 2],
                  with_=[A] if i % 3 == 0 else [], solo=True if i % 3 == 1 else None,
                  place=places[i % 4], price=1 + i % 4) for i, c in enumerate(cats)]
    prior = QuizPrior(favorites=frozenset({"thai"}), budget_level=2)
    with_data = build_runs(History(prior=prior, meals=tuple(meals)), with_quiz=True)
    without = build_runs(History(prior=prior, meals=tuple(stripped(m) for m in meals)),
                         with_quiz=True)
    assert with_data == without

