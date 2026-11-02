"""P2-03 widening contract (M-S), using synthetic upstreams and controlled Places time."""

import asyncio
import json
from dataclasses import replace

import httpx2
import pytest

from app import widening
from app.auth import current_user
from app.main import app, get_places_client
from app.scoring import rank
from tests import test_recommendations as rec_t
from tests.test_recommendations import env  # noqa: F401 (autouse: synthetic API settings)


def features(n, *, start=100, category="thai", meters=1000):
    return [rec_t.feature(f"Synthetic {start + i}", start + i,
                          rec_t.LAT + (meters + 20 * i) / 111195,
                          ["catering", f"catering.restaurant.{category}"])
            for i in range(n)]


class Upstreams(rec_t.Upstreams):
    def __init__(self, responses, **kw):
        super().__init__(**kw)
        self.responses = responses
        self.places_calls = 0

    async def __call__(self, request):
        if request.url.host != "api.geoapify.com":
            return await super().__call__(request)
        self.requests.append(request)
        index = self.places_calls
        self.places_calls += 1
        response = self.responses[min(index, len(self.responses) - 1)]
        if isinstance(response, Exception):
            raise response
        if isinstance(response, int):
            return httpx2.Response(response)
        return httpx2.Response(200, json={"type": "FeatureCollection", "features": response})


def radii(up):
    return [int(r.url.params["filter"].rsplit(",", 1)[1]) for r in up.requests
            if r.url.host == "api.geoapify.com"]


def patches(up):
    return [r for r in rec_t.writes(up, "sessions") if r.method == "PATCH"]


def run(up, chip=15000, **kw):
    return rec_t.post(up, radius_m=chip, local_time="2026-11-04T19:30:00-05:00", **kw)


def test_m_close_chip_widens_twice_with_five_eligible_candidates():
    up = Upstreams([features(4)])  # Four unique Geoapify places plus one from history.
    response = run(up)
    assert response.status_code == 200
    assert radii(up) == [15000, 22500, 33750]
    assert response.json()["radius_m"] == 33750
    assert len(response.json()["picks"]) == 3


def test_n_far_chip_caps_and_never_repeats_the_capped_radius():
    up = Upstreams([features(4)])
    assert run(up, chip=35000).status_code == 200
    assert radii(up) == [35000, 40234]


def test_o_eight_eligible_candidates_need_only_one_call():
    up = Upstreams([features(7)])  # Seven plus the known history place.
    assert run(up).status_code == 200
    assert radii(up) == [15000]


@pytest.mark.parametrize("failure", [500, httpx2.ReadTimeout("synthetic timeout"),
                                    httpx2.ConnectError("synthetic failure")])
def test_p_widening_failure_keeps_initial_results_and_succeeds(failure):
    up = Upstreams([features(4), failure])
    body = run(up).json()
    assert body["logged"] is True
    assert body["radius_m"] == 15000 and body["answers"]["radius_m"] == 15000
    assert radii(up) == [15000, 22500]
    assert len(body["picks"]) == 3
    assert patches(up) == []


def test_q_places_budget_used_by_first_call_prevents_widening(monkeypatch):
    # Only PlacesBudget reads this clock. No sleeping or machine-speed assertions.
    clock = iter((0.0, 4.0))
    monkeypatch.setattr(widening, "monotonic", lambda: next(clock))
    up = Upstreams([features(4)])
    response = run(up)
    assert response.status_code == 200
    assert radii(up) == [15000]
    assert response.json()["radius_m"] == 15000
    assert patches(up) == []


def test_r_map_places_search_is_never_widened():
    up = Upstreams([features(4)])

    async def client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(up)) as c:
            yield c

    app.dependency_overrides[get_places_client] = client
    app.dependency_overrides[current_user] = lambda: rec_t.USER_ID
    response = rec_t.use(up).get(f"/places/search?lat={rec_t.LAT}&lon={rec_t.LON}&radius_m=15000")
    assert response.status_code == 200
    assert response.json()["radius_m"] == 15000 and response.json()["count"] == 4
    assert radii(up) == [15000]


def test_s_logs_searched_radius_but_keeps_answer_distance_fit_and_weights(monkeypatch):
    from app import main

    original = main.gate.next_question
    captured = []

    def inspect(ranking, ctx, history, merged, models, budget):
        # Re-rank the same pool with the original search radius. The explicit answer must
        # preserve every score, distance fit, and reason even when the searched area grows.
        initial = replace(ctx, search_radius_m=15000)
        reference = rank([s.place for s in ranking.ranked], initial, history, merged, models)
        assert ctx.radius_m == 15000 and ctx.search_radius_m == 33750
        assert ranking == reference
        for scored in ranking.ranked:
            evidence = scored.evidence
            assert evidence.radius_m == 15000
            assert evidence.distance_fit == pytest.approx(
                max(0, 1 - scored.place.distance_m / 15000))
        captured.append(True)
        return original(ranking, ctx, history, merged, models, budget)

    monkeypatch.setattr(main.gate, "next_question", inspect)
    up = Upstreams([features(4)])
    body = run(up).json()
    assert body["logged"] is True and captured == [True]
    assert body["answers"]["radius_m"] == 15000 and body["radius_m"] == 33750
    (patch,) = patches(up)
    assert json.loads(patch.content) == {"search_radius_m": 33750}
    assert patch.url.params["user_id"] == f"eq.{rec_t.USER_ID}"
    assert patch.url.params["id"] == f"eq.{rec_t.SESSION_ID}"


def test_no_widening_makes_no_extra_session_patch():
    up = Upstreams([features(7)])
    body = run(up).json()
    assert body["logged"] is True and body["radius_m"] == 15000
    assert radii(up) == [15000]
    assert [r.method for r in rec_t.writes(up, "sessions")] == ["POST"]


def test_searched_radius_patch_failure_never_affects_the_round(caplog):
    up = Upstreams([features(4)], fail=("PATCH sessions",))
    response = run(up)
    body = response.json()
    assert response.status_code == 200 and body["logged"] is True
    assert body["radius_m"] == 33750 and body["answers"]["radius_m"] == 15000
    assert len(body["picks"]) == 3 and len(patches(up)) == 1
    assert "Funnel search radius failed" in caplog.text


def test_later_round_logs_final_radius_in_existing_answer_patch():
    up = Upstreams([features(4)], last_round=1)
    body = run(up, session_id=rec_t.SESSION_ID).json()
    assert body["round"] == 2 and body["logged"] is True
    (patch,) = patches(up)
    values = json.loads(patch.content)
    assert values["search_radius_m"] == 33750 and values["radius_m"] == 15000


@pytest.mark.parametrize("fail_patch", [False, True])
def test_existing_session_without_shown_events_gets_final_radius_patch(fail_patch):
    up = Upstreams([features(4)], shown=[], fail=("PATCH sessions",) if fail_patch else ())
    response = run(up, session_id=rec_t.SESSION_ID)
    body = response.json()
    assert response.status_code == 200 and body["logged"] is True
    assert body["round"] == 1 and body["radius_m"] == 33750
    assert body["answers"]["radius_m"] == 15000
    assert radii(up) == [15000, 22500, 33750]
    (patch,) = patches(up)
    assert json.loads(patch.content) == {"search_radius_m": 33750}
    assert all(r.method != "POST" for r in rec_t.writes(up, "sessions"))


def test_existing_session_without_widening_gets_no_extra_patch():
    up = Upstreams([features(7)], shown=[])
    response = run(up, session_id=rec_t.SESSION_ID)
    assert response.status_code == 200 and response.json()["logged"] is True
    assert response.json()["round"] == 1 and response.json()["radius_m"] == 15000
    assert patches(up) == []


def test_widening_merge_drops_co_located_duplicates_with_different_ids(monkeypatch):
    from app import main

    first = features(4)
    original = first[0]["properties"]
    duplicate = rec_t.feature(original["name"].upper(), 900, original["lat"] + 0.0000001,
                              original["categories"])
    duplicate["properties"]["lon"] = original["lon"] + 0.0000001
    second = [duplicate, *features(2, start=200, meters=3000)]
    up = Upstreams([first, second])
    next_question = main.gate.next_question
    captured = []

    def inspect(ranking, *args):
        captured.append([s.place for s in ranking.ranked])
        return next_question(ranking, *args)

    monkeypatch.setattr(main.gate, "next_question", inspect)
    response = run(up)
    assert response.status_code == 200 and response.json()["logged"] is True
    # Six unique Places results plus one history place leave seven eligible candidates.
    # Counting both IDs at the same spot would incorrectly stop after the second call.
    assert radii(up) == [15000, 22500, 33750]
    (candidates,) = captured
    assert len(candidates) == 7
    assert len({c.id for c in candidates} & {"node/100", "node/900"}) == 1
    spots = {(c.name.lower(), round(c.lat, 5), round(c.lon, 5)) for c in candidates}
    assert len(spots) == len(candidates)


def test_second_search_reaching_eight_eligible_candidates_stops():
    up = Upstreams([features(4), features(7)])
    assert run(up).status_code == 200
    assert radii(up) == [15000, 22500]


def test_count_uses_dedupe_history_hard_nos_exclusions_and_shown_places():
    # Raw count exceeds eight, but only five unique places remain eligible initially:
    # four allowed results plus the history place. Rejected results and duplicates never
    # satisfy the threshold. A second response provides enough new eligible candidates.
    allowed = features(4)
    first = (allowed + allowed + features(3, start=200, category="burger")
             + features(3, start=300, category="pizza") + features(1, start=400))
    up = Upstreams([first, first + features(4, start=500)])
    response = run(up, exclude_categories=["pizza"], exclude_ids=["node/400"])
    assert response.status_code == 200
    assert radii(up) == [15000, 22500]
    assert not {"burgers", "pizza"} & {p["category"] for p in response.json()["picks"]}
    shown = [rec_t.shown_event(1, "node/100", 0.9, "thai", 33.953)]
    up = Upstreams([features(7), features(8)], shown=shown)
    assert run(up, session_id=rec_t.SESSION_ID).status_code == 200
    assert radii(up) == [15000, 22500]


def test_budget_bounds_in_flight_widening_and_keeps_previous_results(monkeypatch):
    # Give the first call 3.99 s of the accounting budget without delaying it. The next
    # request blocks until cancelled by the remaining 0.01 s, despite its normal 4 s timeout.
    clock = iter((0.0, 3.99, 4.0, 4.01))
    monkeypatch.setattr(widening, "monotonic", lambda: next(clock))

    class Slow(Upstreams):
        async def __call__(self, request):
            if request.url.host == "api.geoapify.com" and self.places_calls:
                self.requests.append(request)
                self.places_calls += 1
                await asyncio.Event().wait()
            return await super().__call__(request)

    up = Slow([features(4)])
    response = run(up)
    assert response.status_code == 200
    assert radii(up) == [15000, 22500]
    assert response.json()["radius_m"] == 15000


def test_places_budget_never_includes_history_waits_or_other_work(monkeypatch):
    clock = iter((0.0, 1.0, 10.0, 11.0))
    monkeypatch.setattr(widening, "monotonic", lambda: next(clock))
    budget = widening.PlacesBudget()
    up = Upstreams([features(7)])

    async def check():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(up)) as client:
            await budget.search(rec_t.LAT, rec_t.LON, 15000, client=client)
            await budget.search(rec_t.LAT, rec_t.LON, 22500, client=client)

    asyncio.run(check())
    assert budget.used_s == 2.0  # the nine-second gap between calls is not Places time
    assert radii(up) == [15000, 22500]
