"""P2-03 distance evidence, corrected weekday fixtures, and gate integration (A-L)."""

import asyncio
import math
from dataclasses import replace
from datetime import date, timedelta

import httpx2
import pytest

from app import distance_model, gate, history
from app.cuisine_model import COMPANION_SLOT, SLOT_WEEKEND, USER
from app.places import Candidate
from app.scoring import Context, History, PastMeal, StoredPlace, models_for, rank, weak

AS_OF = date(2026, 11, 4)
AGES = (1, 2, 5, 6, 7)
LAT, LON = 33.95, -84.55
ALICE = "00000000-0000-0000-0000-000000000001"
BOB = "00000000-0000-0000-0000-000000000002"
CAROL = "00000000-0000-0000-0000-000000000003"


def meal(age=1, distance=2000, **kw):
    day = AS_OF - timedelta(days=age)
    base = dict(place=None, eaten_on=day, source="live", category_id=None, price_level=None,
                meal_slot="dinner", is_weekend=day.isoweekday() >= 6, went=True,
                distance_m=distance)
    return PastMeal(**{**base, **kw})


def context(**kw):
    base = dict(lat=LAT, lon=LON, local_date=AS_OF, meal_slot="dinner", is_weekend=False,
                search_radius_m=35000, radius_m=35000)
    return Context(**{**base, **kw})


def case_c():
    return History(meals=tuple(meal(age) for age in AGES))


def question(h):
    plan = gate.plan(h, "dinner", False, AS_OF)
    return next(q for q in (*plan.questions, plan.skipped) if q and q.key == "distance")


def test_a_no_usable_meals_is_weak_without_prefill():
    prediction = distance_model.predict(History(), context(), AS_OF)
    assert prediction.probs == {"close": 0.5, "far": 0.5}
    assert prediction.meals == prediction.n_eff == 0
    assert prediction.level == "none"
    assert question(History()).weak and question(History()).prefill is None


def test_b_four_weekday_dinners_are_weak():
    h = History(meals=tuple(meal(age) for age in AGES[:4]))
    prediction = distance_model.predict(h, context(), AS_OF)
    assert prediction.probs["close"] == pytest.approx(0.955, abs=1e-3)
    assert prediction.meals == 4 and prediction.level == SLOT_WEEKEND
    assert question(h).weak and question(h).prefill is None


def test_c_five_weekday_dinners_are_confident_and_prefill_close():
    h = case_c()
    # Observe each real level by asking in contexts that have no narrower matching meals.
    user = distance_model.predict(h, context(meal_slot="lunch"), AS_OF)
    slot = distance_model.predict(h, context(is_weekend=True), AS_OF)
    full = distance_model.predict(h, context(), AS_OF)
    assert user.probs["close"] == pytest.approx(0.801, abs=1e-3)
    assert slot.probs["close"] == pytest.approx(0.921, abs=1e-3)
    assert full.probs["close"] == pytest.approx(0.969, abs=1e-3)
    assert full.n_eff == pytest.approx(4.544118015, abs=1e-9)
    assert full.meals == 5 and full.level == SLOT_WEEKEND
    q = question(h)
    assert not q.weak and q.prefill == 15000 and q.meals == 5
    assert sum(full.probs.values()) == pytest.approx(1)


def test_d_mixed_weekday_dinners_predict_close():
    h = History(meals=tuple(meal(age, 2000 if age in (1, 2, 5) else 30000) for age in AGES))
    for ctx, expected in ((context(meal_slot="lunch"), 0.573),
                          (context(is_weekend=True), 0.602), (context(), 0.614)):
        assert distance_model.predict(h, ctx, AS_OF).probs["close"] == pytest.approx(
            expected, abs=1e-3)
    assert not question(h).weak and question(h).prefill == 15000


def test_e_unusable_observations_do_not_change_case_c():
    h = case_c()
    extra = (meal(distance=30000, source="backfill", went=None),
             meal(distance=30000, went=False), meal(distance=30000, went=None),
             meal(distance=None))
    assert distance_model.predict(replace(h, meals=h.meals + extra), context(), AS_OF) == (
        distance_model.predict(h, context(), AS_OF))


@pytest.mark.parametrize("distance,outcome", [(0, "close"), (15000, "close"), (15001, "far")])
def test_f_boundary_and_zero(distance, outcome):
    h = History(meals=tuple(meal(age, distance) for age in AGES))
    prediction = distance_model.predict(h, context(), AS_OF)
    assert prediction.probs[outcome] == pytest.approx(0.969, abs=1e-3)
    assert question(h).prefill == (15000 if outcome == "close" else 35000)


def test_g_on_and_after_as_of_are_excluded():
    h = case_c()
    future = (meal(0, 30000), meal(-1, 30000))
    assert distance_model.predict(replace(h, meals=h.meals + future), context(), AS_OF) == (
        distance_model.predict(h, context(), AS_OF))


def test_h_weekday_lunches_back_off_to_user_for_dinner():
    h = History(meals=tuple(meal(age, meal_slot="lunch") for age in AGES))
    prediction = distance_model.predict(h, context(), AS_OF)
    assert prediction.probs["close"] == pytest.approx(0.801, abs=1e-3)
    assert prediction.level == USER and prediction.meals == 5
    assert not question(h).weak and question(h).prefill == 15000


def test_i_companion_level_requires_every_selected_companion_and_same_slot():
    group = frozenset({ALICE, BOB})
    included = (meal(1, companion_ids=group),
                meal(2, companion_ids=group | {CAROL}),
                meal(3, companion_ids=group))  # Sunday counts in companion + slot.
    excluded = (meal(5, 30000, companion_ids=frozenset({ALICE})),
                meal(6, 30000, companion_ids=frozenset({BOB})),
                meal(7, 30000, companion_ids=group, meal_slot="lunch"))
    h = History(meals=included + excluded)
    parent = distance_model.predict(h, context(), AS_OF)
    child = distance_model.predict(h, context(companion_ids=group), AS_OF)
    n = sum(0.5 ** (age / 30) for age in (1, 2, 3))
    assert child.level == COMPANION_SLOT and child.meals == 3
    assert child.n_eff == pytest.approx(n)
    assert child.probs["close"] == pytest.approx((n + 3 * parent.probs["close"]) / (n + 3))
    assert distance_model.predict(h, context(companion_ids=frozenset()), AS_OF) == parent


def test_j_confident_distance_is_asked_after_weak_questions():
    plan = gate.plan(case_c(), "dinner", False, AS_OF)
    assert plan.order == ("craving", "budget", "distance")
    assert all(q.weak for q in plan.questions[:2])
    distance = plan.questions[-1]
    assert not distance.weak and distance.prefill == 15000


def test_k_company_pool_can_skip_confident_distance():
    h = replace(case_c(), companions=frozenset({ALICE}))
    plan = gate.plan(h, "dinner", False, AS_OF)
    assert plan.skipped.key == "distance"
    assert not plan.skipped.weak and plan.skipped.predicted == plan.skipped.prefill == 15000
    assert plan.order == ("craving", "budget", "company")


def test_l_refinement_uses_learned_distance_probabilities():
    ctx = context()
    cands = [Candidate(id=f"node/{i}", name=f"Synthetic {i}", lat=LAT + meters / 111195,
                       lon=LON, distance_m=meters, category="thai",
                       geoapify_categories=["catering.restaurant.thai"], address=None)
             for i, meters in enumerate([20000 + 1000 * i for i in range(6)] + [1000] * 4)]
    meals = tuple(replace(m, place=StoredPlace(c.id, c.name, c.lat, c.lon,
                                              tuple(c.geoapify_categories), None))
                  for m, c in zip(case_c().meals, cands))
    h = History(meals=meals)
    models = models_for(h, ctx)
    ranking = rank(cands, ctx, h, models=models)
    probabilities = distance_model.predict(h, ctx, AS_OF).probs
    assert probabilities["close"] == pytest.approx(0.969, abs=1e-3)
    # Past session origins differed from today's: the 2 km trips visited places now farther
    # away. Familiar far candidates lead when allowed; close admits only the near candidates.
    nxt = gate.next_question(ranking, ctx, h, frozenset(), models,
                             gate.predict_budget(h, "dinner", False, AS_OF))
    expected = -sum(p * math.log2(p) for p in probabilities.values())
    assert nxt.gains["distance"] == pytest.approx(round(expected, 6), abs=1e-6)
    assert nxt.gains["distance"] != 1.0


def test_history_loads_stored_distance_without_an_extra_query(monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "synthetic-key")
    get_settings.cache_clear()
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith("/meals"):
            rows = [dict(source="live", went=True, eaten_on="2026-11-03", meal_slot="dinner",
                         is_weekend=False, distance_m=d) for d in (0, 15001, None)]
            return httpx2.Response(200, json=rows)
        return httpx2.Response(200, json=[])

    async def load():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as client:
            return await history.load(ALICE, "synthetic-token", client=client)

    try:
        loaded = asyncio.run(load())
        assert [m.distance_m for m in loaded.meals] == [0, 15001, None]
        assert len(requests) == 3
        request = next(r for r in requests if r.url.path.endswith("/meals"))
        assert "distance_m" in request.url.params["select"].split(",")
    finally:
        get_settings.cache_clear()


def test_single_observation_never_creates_certainty_or_a_prefill():
    h = History(meals=(meal(),))
    prediction = distance_model.predict(h, context(), AS_OF)
    assert 0 < prediction.probs["far"] < prediction.probs["close"] < 1
    assert weak(max(prediction.probs.values()), prediction.meals)
    assert question(h).prefill is None
