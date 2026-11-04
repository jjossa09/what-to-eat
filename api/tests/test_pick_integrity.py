"""RPC contract tests. Real rollback/concurrency checks live under supabase/tests."""
import json

import httpx2
import pytest

from tests import test_companion_context as companion_t
from tests import test_funnel as funnel_t
from tests import test_recommendations as rec_t

pytestmark = pytest.mark.usefixtures("env")
env = rec_t.env


class Result(funnel_t.Supabase):
    def __init__(self, rows=None, status=200, exc=None):
        super().__init__()
        self.rows = rows if rows is not None else [{"status": "saved", "meal_id": funnel_t.MEAL_ID}]
        self.status, self.rpc_exc = status, exc

    def __call__(self, request):
        if request.url.path.endswith('/rpc/save_recommendation_pick'):
            self.requests.append(request)
            if self.rpc_exc:
                raise self.rpc_exc
            return httpx2.Response(self.status, json=self.rows)
        return super().__call__(request)


@pytest.mark.parametrize("status", ["saved", "replayed"])
def test_saved_and_verified_replay_return_same_meal_identity(status):
    up = Result([{"status": status, "meal_id": funnel_t.MEAL_ID}])
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 200
    assert response.json() == {"logged": True, "meal_id": funnel_t.MEAL_ID}
    assert len(up.calls("POST", "rpc/save_recommendation_pick")) == 1
    assert up.calls("POST", "meals") == up.calls("PATCH", "sessions") == []
    funnel_t.assert_as_user(up)


def test_endpoint_retry_preserves_existing_data_and_does_not_repeat_primary_writes():
    up = funnel_t.Supabase()
    request = {"round": 1, "place_id": funnel_t.PLACE_ID}
    first = funnel_t.send(up, "picked", request)
    up.meals[0].update(category_id="pizza", stars=4, dish="Synthetic meal",
                       ate_at="2026-11-03T13:00:00Z")
    before = json.dumps([up.meals, up.picked_events], sort_keys=True)
    second = funnel_t.send(up, "picked", request)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"logged": True, "meal_id": funnel_t.MEAL_ID}
    assert json.dumps([up.meals, up.picked_events], sort_keys=True) == before
    assert len(up.meals) == len(up.picked_events) == 1
    assert len(up.calls("POST", "rpc/save_recommendation_pick")) == 2


@pytest.mark.parametrize("round_,place", [(2, funnel_t.PLACE_ID), (1, "node/2")])
def test_endpoint_competing_choice_is_a_conflict_without_changing_original(round_, place):
    up = funnel_t.Supabase()
    first = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert first.status_code == 200
    before = json.dumps([up.meals, up.picked_events], sort_keys=True)
    response = funnel_t.send(up, "picked", {"round": round_, "place_id": place})
    assert response.status_code == 409 and "logged" not in response.json()
    assert json.dumps([up.meals, up.picked_events], sort_keys=True) == before


@pytest.mark.parametrize("status,code", [("conflict", 409), ("not_found", 404),
                                         ("inconsistent", 502)])
def test_rpc_outcomes_never_turn_competing_or_partial_decisions_into_success(status, code):
    up = Result([{"status": status, "meal_id": None}])
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == code
    assert "logged" not in response.json()


@pytest.mark.parametrize("rows", [[], [{}], [{"status": "saved"}],
    [{"status": "saved", "meal_id": None}], [{"status": "replayed", "meal_id": "invalid"}],
    [{"status": "saved", "meal_id": funnel_t.MEAL_ID}] * 2])
def test_invalid_rpc_result_is_failure_not_a_saved_confirmation(rows):
    up = Result(rows)
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 502


@pytest.mark.parametrize("fault", [500, httpx2.ReadTimeout("lost response")])
def test_rpc_failure_stays_retryable_and_lost_response_can_replay(fault):
    up = Result(status=fault if isinstance(fault, int) else 200,
                exc=fault if isinstance(fault, Exception) else None)
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 502
    original = json.loads(up.calls("POST", "rpc/save_recommendation_pick")[0].content)
    up.status, up.rpc_exc = 200, None
    up.rows = [{"status": "replayed", "meal_id": funnel_t.MEAL_ID}]
    response = funnel_t.send(up, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.json() == {"logged": True, "meal_id": funnel_t.MEAL_ID}
    assert json.loads(up.calls("POST", "rpc/save_recommendation_pick")[1].content) == original


def test_pick_never_makes_a_secondary_companion_write():
    up = companion_t.FunnelFake(session_companions=[companion_t.A], fail=["POST meal_companions"])
    # Any accidentally reintroduced secondary write hits this failure canary.
    # The real optional-copy failure inside SQL is covered by food_companion_test.sql.
    original = up.__call__

    def send(request):
        if request.url.path.endswith('/meal_companions'):
            up.requests.append(request)
            return httpx2.Response(500)
        return original(request)

    class Transport:
        def __call__(self, request):
            return send(request)

    transport = Transport()
    response = funnel_t.send(transport, "picked", {"round": 1, "place_id": funnel_t.PLACE_ID})
    assert response.status_code == 200
    assert response.json() == {"logged": True, "meal_id": companion_t.MEAL_ID}
    assert len(up.calls("POST", "rpc/save_recommendation_pick")) == 1
    assert len(up.calls("POST", "meal_companions")) == 0


@pytest.mark.parametrize("budget", [1, 3, None])
def test_normal_round_snapshots_the_applied_answer_without_changing_rankings(budget):
    up = rec_t.Upstreams()
    body = rec_t.post(up, budget_level=budget).json()
    assert body["logged"] is True
    shown = json.loads(rec_t.writes(up, "recommendation_events")[0].content)
    assert [e["decision_budget_level"] for e in shown] == (
        [body["answers"]["budget_level"]] * len(shown))
    assert [e["place_id"] for e in shown] == [p["id"] for p in body["picks"]]
    assert budget == body["answers"]["budget_level"]


@pytest.mark.parametrize("shown", [rec_t.ROUND_1, rec_t.THREE_ROUNDS])
def test_refined_and_capped_round_snapshots_follow_applied_budget(shown):
    up = rec_t.Upstreams(shown=shown)
    body = rec_t.follow_up(up, refine={"budget": "cheaper"}).json()
    events = rec_t.shown_inserts(up)
    assert body["logged"] is True and events
    assert {e["decision_budget_level"] for e in events} == {body["answers"]["budget_level"]}
    assert body["answers"]["budget_level"] == 1
    if body["best_so_far"]:
        assert {e["round"] for e in events} == {4}
        assert "api.geoapify.com" not in up.hosts() and "api.meta.ai" not in up.hosts()
