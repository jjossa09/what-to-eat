"""Eight-second initial search and independent optional widening, synthetic provider only."""

import asyncio
import logging

import httpx2
import pytest

from app import main, widening
from app.auth import current_auth
from app.config import get_settings
from tests import test_recommendations as rec
from tests.test_recommendation_timeouts import Provider, pizza, rows
from tests.test_recommendations import env  # noqa: F401 (autouse: synthetic settings)


@pytest.fixture(autouse=True)
def scoped_config(monkeypatch):
    monkeypatch.setenv("PLACES_TIMEOUT_S", "4")  # existing .env override must not undo repair
    monkeypatch.setenv("RECOMMENDATION_PLACES_TIMEOUT_S", "8")
    get_settings.cache_clear()


def pool():
    near, far = pizza("Synthetic Chain Near", 101, .001), pizza("Synthetic Chain Far", 102, .01)
    for branch in (near, far):
        branch["properties"]["datasource"]["raw"].update({
            "brand": "Synthetic Pizza Chain", "brand:wikidata": "Q730001"})
    wrong = rec.feature("Unrelated Chinese", 200, rec.LAT + .002,
                        ["catering.restaurant.chinese"])
    return [near, far, wrong, *[pizza(f"Synthetic Independent {i}", i, .003 + i / 100000)
                               for i in range(103, 110)]]


def assert_eligible(body):
    assert body["picks"] and all(p["category"] == "pizza" for p in body["picks"])
    ids = {p["id"] for p in body["picks"]}
    assert "node/102" not in ids and "node/200" not in ids


def test_initial_provider_delay_above_four_below_eight_seconds_succeeds(caplog):
    class Delayed(Provider):
        async def __call__(self, request):
            if request.url.host == "api.geoapify.com":
                await asyncio.sleep(4.1)  # real mocked delay crosses the original hard cutoff
            return await super().__call__(request)

    caplog.set_level(logging.INFO)
    provider = Delayed([pool()])
    response = rec.post(provider, craving="pizza", radius_m=15000, request_source="typed")
    assert response.status_code == 200 and response.json()["logged"]
    assert_eligible(response.json())
    assert len(provider.searches) == 1  # eight eligible unique chains: no widening needed
    request, = provider.searches
    assert request.url.params["categories"] == (
        "catering.restaurant.pizza,catering.fast_food.pizza")
    assert set(request.extensions["timeout"].values()) == {8.0}
    search, = rows(caplog, "Recommendation search: ")
    assert search["remaining_ms"] == 8000 and search["elapsed_ms"] > 4000
    assert search["stage"] == "initial" and search["outcome"] == "success"


def test_initial_provider_exceeding_eight_seconds_fails_cleanly_once(caplog):
    caplog.set_level(logging.INFO)
    provider = Provider(["stall"])
    response = rec.post(provider, craving="pizza", request_source="typed")
    assert response.status_code == 504
    assert response.json() == {"detail": "Places search timed out"}
    assert len(provider.searches) == 1
    assert set(provider.searches[0].extensions["timeout"].values()) == {8.0}
    search, = rows(caplog, "Recommendation search: ")
    assert search["remaining_ms"] == 8000
    assert search["stage"] == "initial" and search["outcome"] == "shared_budget_timeout"
    summary, = rows(caplog, "Recommendation request: ")
    assert summary["http_status"] == 504 and summary["places_calls"] == 1


@pytest.mark.parametrize("failure", ["stall", httpx2.ReadTimeout("synthetic timeout")])
def test_optional_timeout_keeps_initial_eligible_closest_chain_cards(caplog, failure):
    caplog.set_level(logging.INFO)
    provider = Provider([pool()[:3], failure])
    response = rec.post(provider, craving="pizza", radius_m=15000)
    assert response.status_code == 200
    body = response.json()
    assert body["search_status"] == "partial" and body["search_issue"] == "timeout"
    assert [p["id"] for p in body["picks"]] == ["node/101"]
    assert_eligible(body)
    assert len(provider.searches) == 2
    assert set(provider.searches[1].extensions["timeout"].values()) == {2.0}
    search = rows(caplog, "Recommendation search: ")
    assert [r["remaining_ms"] for r in search] == [8000, 2000]
    assert [r["stage"] for r in search] == ["initial", "widening"]


def test_seven_second_initial_call_keeps_separate_two_second_widening_allowance(
    monkeypatch, caplog,
):
    # Virtual provider durations: initial 7, expansion 1.25, expansion .75 seconds.
    clock = iter((0., 7., 7., 8.25, 8.25, 9.))
    monkeypatch.setattr(widening, "monotonic", lambda: next(clock))
    caplog.set_level(logging.INFO)
    provider = Provider([pool()[:3], []])
    response = rec.post(provider, craving="pizza", radius_m=15000)
    assert response.status_code == 200
    assert [p["id"] for p in response.json()["picks"]] == ["node/101"]
    assert_eligible(response.json())
    assert len(provider.searches) == 3  # existing initial plus two optional expansions
    search = rows(caplog, "Recommendation search: ")
    assert [r["remaining_ms"] for r in search] == [8000, 2000, 750]
    assert [r["used_ms"] for r in search] == [7000, 8250, 9000]
    assert [set(r.extensions["timeout"].values()) for r in provider.searches] == [
        {8.0}, {2.0}, {.75}]


def test_recommendation_endpoint_is_bounded_including_auth_and_search_limits_are_fixed(
    monkeypatch,
):
    assert widening.INITIAL_PLACES_BUDGET_S == 8
    assert widening.WIDENING_BUDGET_S == 2 and widening.RECOMMENDATION_PLACES_BUDGET_S == 10
    assert widening.PLACES_BUDGET_S == 4 and get_settings().PLACES_TIMEOUT_S == 4
    assert main.ROUND_BUDGET_S == 13.5 and main.OPEN_ROUND_BUDGET_S == 7.5
    assert main.RECOMMENDATIONS_DEADLINE_S == 24
    assert widening.MAX_EXPANSIONS == 2 and widening.MAX_RADIUS_M == 40234

    async def stalled_auth():
        await asyncio.Event().wait()

    provider = Provider([pool()])
    client = rec.use(provider)
    main.app.dependency_overrides[current_auth] = stalled_auth
    monkeypatch.setattr(main, "RECOMMENDATIONS_DEADLINE_S", .01)
    response = client.post("/recommendations", json={
        "lat": rec.LAT, "lon": rec.LON, "local_time": rec.LOCAL_TIME})
    assert response.status_code == 504
    assert response.json() == {"detail": "Recommendation request timed out"}
    assert provider.searches == []
