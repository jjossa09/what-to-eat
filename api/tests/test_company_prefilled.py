"""Company pre-fill telemetry is separate, validated, and never rejects a round."""

import json
from datetime import timedelta

import httpx2
import pytest

from app import funnel, gate
from tests import test_funnel as funnel_t
from tests import test_recommendations as rec
from tests.test_companion_context import TODAY, A, B, FunnelFake, Upstreams
from tests.test_recommendations import env  # noqa: F401 (synthetic API settings)


@pytest.fixture
def company_pool(monkeypatch):
    monkeypatch.setattr(rec, "PRIOR", [{"mostly_solo": False}])
    return Upstreams(companions=[A, B])


def logged(up, **fields):
    response = rec.post(up, **fields)
    assert response.status_code == 200
    assert response.json()["gate_logged"] is True
    return rec.gate_calls(up)[0]["p_plan"]["asked"]


@pytest.mark.parametrize("value", ["solo", [A, B], None, []])
def test_valid_company_values_are_logged(company_pool, value):
    trace = {"received": value, "shown": value}
    asked = logged(company_pool, company_prefilled=trace)
    assert asked["company_prefilled"] == {"status": "ok", **trace}


def test_absent_company_trace_stays_absent(company_pool):
    assert "company_prefilled" not in logged(company_pool)


@pytest.mark.parametrize("value", [
    1, True, {}, "not-a-uuid", "Alex", ["not-a-uuid"], ["Alex"], [1], [None],
    [A, A], [A, A.upper()],
])
@pytest.mark.parametrize("side", ["received", "shown"])
def test_invalid_values_are_discarded_without_rejecting_round(company_pool, value, side):
    trace = {"received": [A], "shown": "solo", side: value}
    asked = logged(company_pool, company_prefilled=trace)
    assert asked["company_prefilled"] == {"status": "invalid", "received": None, "shown": None}


@pytest.mark.parametrize("trace", [None, [], "solo", 7, {}, {"received": None},
                                    {"received": None, "shown": None, "extra": "Alex"}])
def test_invalid_trace_shapes_do_not_reject_round(company_pool, trace):
    asked = logged(company_pool, company_prefilled=trace)
    assert asked["company_prefilled"] == {"status": "invalid", "received": None, "shown": None}


def test_existing_trace_is_unchanged(company_pool):
    trace = {"received": {"craving": None, "budget": 2, "distance": None},
             "shown": {"craving": None, "budget": 1, "distance": 15000}}
    asked = logged(company_pool, prefilled=trace,
                   company_prefilled={"received": [A], "shown": "solo"})
    assert asked["prefilled"] == {"status": "ok", **trace}


# Regression cases from the P2-07 review. Every request uses synthetic mocked upstreams.

def company_meals(known, total):
    return [{"source": "backfill", "category_id": None, "places": None,
             "eaten_on": (TODAY - timedelta(days=1)).isoformat(), "meal_slot": "dinner",
             "is_weekend": False, "solo": None,
             "meal_companions": [{"companion_id": A}] if i < known else []}
            for i in range(total)]


def company_question(body):
    return next(q for q in [*body["questions"], body["skipped"]]
                if q and q["key"] == "company")


def test_weak_skipped_company_has_no_prediction_in_response_or_log(company_pool, monkeypatch):
    monkeypatch.setattr(rec, "MEALS", company_meals(1, 1))
    response = rec.plan_post(company_pool)
    assert response.status_code == 200
    skipped = response.json()["skipped"]
    assert skipped["key"] == "company" and skipped["weak"] is True
    assert skipped["predicted"] is None and skipped["prefill"] is None
    assert skipped["reason"] == "skipped_weak"
    response = rec.post(company_pool)
    assert response.status_code == 200
    (call,) = rec.gate_calls(company_pool)
    assert call["p_plan"]["skipped"] == skipped


def test_five_company_meals_among_twenty_are_weak(company_pool, monkeypatch):
    monkeypatch.setattr(rec, "MEALS", company_meals(5, 20))
    response = rec.plan_post(company_pool)
    assert response.status_code == 200
    company = company_question(response.json())
    assert company["meals"] == 20
    assert company["top_prob"] < 0.4 and company["weak"] is True


def test_one_observed_group_never_has_probability_one(company_pool, monkeypatch):
    monkeypatch.setattr(rec, "MEALS", company_meals(10, 10))
    response = rec.plan_post(company_pool)
    assert response.status_code == 200
    company = company_question(response.json())
    assert 0.4 <= company["top_prob"] < 1.0
    assert company["predicted"] == [A] and company["weak"] is False


def test_companion_deletion_cascade_changes_historical_group(monkeypatch):
    # Known limitation: deleting B cascades {A, B} meal links to {A}; history loses B.
    monkeypatch.setattr(rec, "PRIOR", [{"mostly_solo": False}])
    monkeypatch.setattr(rec, "MEALS", company_meals(10, 10))
    response = rec.plan_post(Upstreams(companions=[A]))
    assert response.status_code == 200
    assert company_question(response.json())["predicted"] == [A]


class FailedSessionLinks(Upstreams):
    def supabase(self, request):
        if request.method == "POST" and request.url.path.endswith("/session_companions"):
            return httpx2.Response(500, json={"message": "private failure detail"})
        return super().supabase(request)


def test_failed_session_companions_preserves_round_and_r3_logging(caplog):
    up = FailedSessionLinks()
    response = rec.post(up, companion_ids=[A])
    assert response.status_code == 200
    assert response.json()["session_id"] == rec.SESSION_ID
    assert response.json()["logged"] is True
    assert response.json()["gate_logged"] is True
    assert len(rec.writes(up, "session_companions")) == 1
    assert rec.writes(up, "recommendation_events")
    assert "Funnel session_companions failed: FunnelUpstreamError" in caplog.text
    assert "private failure detail" not in caplog.text


class FailedMealLinks(FunnelFake):
    def __call__(self, request):
        if request.method == "POST" and request.url.path.endswith("/meal_companions"):
            self.requests.append(request)
            return httpx2.Response(500, json={"message": "private failure detail"})
        return super().__call__(request)


def test_failed_meal_companions_still_returns_a_successful_pick(caplog):
    up = FailedMealLinks(session_companions=[A])
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 200 and response.json() == {"logged": True}
    assert len(up.calls("PATCH", "sessions")) == 1
    assert len(up.calls("POST", "meals")) == 1
    assert len(up.calls("POST", "meal_companions")) == 1
    assert up.calls("POST", "recommendation_events")
    assert "Funnel meal_companions failed: FunnelUpstreamError" in caplog.text
    assert "private failure detail" not in caplog.text


@pytest.mark.parametrize("embed", [{}, "bad", [None], [{}], [{"companion_id": 7}],
                                   [{"companion_id": "Alex"}]])
def test_malformed_pick_embed_is_an_upstream_error_before_writes(embed):
    up = FunnelFake()
    up.session_companions = embed
    with pytest.raises(funnel.FunnelUpstreamError):
        funnel._session_companions(embed)
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 502
    assert up.calls("PATCH", "sessions") == []
    assert up.calls("POST", "meals") == []


def test_solo_with_companions_is_422_before_upstream_calls():
    up = Upstreams()
    assert rec.post(up, solo=True, companion_ids=[A]).status_code == 422
    assert up.requests == []


@pytest.mark.parametrize("last_round", [1, 2, 3])
@pytest.mark.parametrize("solo", [True, False, None])
def test_rounds_two_to_four_never_load_companion_list(monkeypatch, last_round, solo):
    monkeypatch.setattr(rec, "PRIOR", [{"mostly_solo": False}])
    up = Upstreams(companions=[A], shown=[{**r, "round": last_round} for r in rec.ROUND_1])
    response = rec.follow_up(up, solo=solo)
    assert response.status_code == 200
    assert response.json()["round"] == last_round + 1
    assert not [r for r in up.requests if r.url.path.endswith("/companions")]


def test_round_one_solo_still_validates_the_company_pool(company_pool):
    response = rec.post(company_pool, solo=True, asked_order=["craving", "company", "distance"],
                        plan_source="plan")
    assert response.status_code == 200
    assert any(r.url.path.endswith("/companions") for r in company_pool.requests)
    (call,) = rec.gate_calls(company_pool)
    assert call["p_plan"]["asked"]["status"] == "ok"


def test_new_search_log_reserves_craving_and_skips_weak_company(company_pool, monkeypatch):
    meals = company_meals(1, 10)
    for row in meals:
        row["category_id"] = "thai"
    monkeypatch.setattr(rec, "MEALS", meals)
    # Ordinary plan skips the confident craving. New search must count the user's craving.
    ordinary = rec.plan_post(company_pool).json()
    assert ordinary["skipped"]["key"] == "craving"
    response = rec.post(company_pool, craving="pizza", plan_source="new_search",
                        asked_order=["craving", "budget", "distance"])
    assert response.status_code == 200
    (call,) = rec.gate_calls(company_pool)
    plan = call["p_plan"]
    assert [q["key"] for q in plan["questions"]] == ["craving", "budget", "distance"]
    assert plan["skipped"]["key"] == "company"
    assert plan["skipped"]["predicted"] is None
    assert plan["skipped"]["reason"] == "skipped_weak"
    assert plan["asked"]["matches_plan"] is True
    (session, _) = rec.writes(company_pool, "sessions")
    assert json.loads(session.content)["craving_category_id"] == "pizza"


@pytest.mark.parametrize("budget,company,distance,skip", [
    (0.8, 0.8, 0.5, "budget"),
    (0.5, 0.9, 0.5, "company"),
    (0.3, 0.3, 0.5, "company"),
])
def test_reserved_craving_uses_the_same_remaining_skip_rule(budget, company, distance, skip):
    def q(key, top, meals=8):
        return gate.Question(key, top < 0.4 or meals < 5, [A] if key == "company" else 1,
                             top, meals, "slot_weekend")
    plan = gate.arrange((q("craving", 0.99), q("budget", budget),
                         q("distance", distance, 0), q("company", company)), new_search=True)
    assert plan.order[0] == "craving" and len(plan.order) == 3
    assert "distance" in plan.order
    assert plan.skipped.key == skip


def test_new_search_plan_endpoint_matches_round_one_gate(company_pool, monkeypatch):
    meals = company_meals(1, 10)
    for row in meals:
        row["category_id"] = "thai"
    monkeypatch.setattr(rec, "MEALS", meals)
    response = rec.use(company_pool).post("/questions/plan", json={
        "local_time": rec.LOCAL_TIME, "new_search": True,
    })
    assert response.status_code == 200
    body = response.json()
    order = [q["key"] for q in body["questions"]]
    assert order == ["craving", "budget", "distance"]
    assert body["skipped"]["reason"] == "skipped_weak"
    assert rec.post(company_pool, craving="pizza", plan_source="new_search",
                    asked_order=order).status_code == 200
    (call,) = rec.gate_calls(company_pool)
    assert call["p_plan"]["questions"] == body["questions"]
    assert call["p_plan"]["skipped"] == body["skipped"]



def test_failed_companions_read_preserves_other_history(monkeypatch):
    from tests import test_history as ht
    from tests.test_companion_context import HistoryFake

    class FailedRead(HistoryFake):
        def __call__(self, request):
            if request.url.path.endswith("/companions"):
                self.requests.append(request)
                return httpx2.Response(503)
            return super().__call__(request)

    up = FailedRead(prior=[{"budget_level": 2}], meals=[ht.meal_row()])
    loaded = ht.run_load(up)
    assert loaded.companions == frozenset()
    assert loaded.prior.budget_level == 2 and len(loaded.meals) == 1


@pytest.mark.parametrize("rows", [[], [{}]])
def test_missing_meal_id_skips_companion_copy(rows, caplog):
    class MissingId(FunnelFake):
        def __call__(self, request):
            if request.method == "POST" and request.url.path.endswith("/meals"):
                self.requests.append(request)
                return httpx2.Response(201, json=rows)
            return super().__call__(request)

    up = MissingId(session_companions=[A])
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 200
    assert len(up.calls("POST", "meals")) == 1
    assert up.calls("POST", "meal_companions") == []
    assert "meal insert returned no id" in caplog.text


def test_six_older_company_meals_confidently_skip_company(company_pool, monkeypatch):
    # Pinned current behavior: raw meal count determines confidence, despite recency decay.
    rows = company_meals(6, 6)
    for row, days in zip(rows, range(40, 66, 5), strict=True):
        row["eaten_on"] = (TODAY - timedelta(days=days)).isoformat()
    monkeypatch.setattr(rec, "MEALS", rows)
    skipped = rec.plan_post(company_pool).json()["skipped"]
    assert skipped["key"] == "company" and skipped["predicted"] == [A]
    assert skipped["meals"] == 6 and skipped["weak"] is False
    assert skipped["top_prob"] >= 0.4

