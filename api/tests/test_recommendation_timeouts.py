"""Recommendation timeout stages and privacy, with synthetic provider responses only."""

import asyncio
import json
import logging
from uuid import UUID

import httpx2
import pytest

from app import main, widening
from tests import test_recommendations as rec
from tests.test_recommendations import env  # noqa: F401 (autouse: synthetic settings)


class Provider(rec.Upstreams):
    def __init__(self, responses):
        super().__init__()
        self.responses = responses
        self.searches = []

    async def __call__(self, request):
        if request.url.host != "api.geoapify.com":
            return await super().__call__(request)
        self.requests.append(request)
        self.searches.append(request)
        response = self.responses[min(len(self.searches) - 1, len(self.responses) - 1)]
        if response == "stall":
            await asyncio.Event().wait()  # only the real shared deadline can cancel this
        if isinstance(response, Exception):
            raise response
        if isinstance(response, int):
            return httpx2.Response(response)
        return httpx2.Response(200, json={"features": response})


def rows(caplog, prefix):
    return [json.loads(record.message.removeprefix(prefix)) for record in caplog.records
            if record.message.startswith(prefix)]


def assert_private_telemetry(caplog):
    telemetry = rows(caplog, "Recommendation search: ") + rows(
        caplog, "Recommendation request: ")
    allowed = {"request_id", "source", "stage", "call", "targeted", "outcome", "elapsed_ms",
               "remaining_ms", "used_ms", "candidates", "http_status", "search_status",
               "using_cached", "picks", "places_calls", "places_ms"}
    assert telemetry and all(set(row) <= allowed for row in telemetry)
    assert len({row["request_id"] for row in telemetry}) == 1
    UUID(telemetry[0]["request_id"])
    for secret in (rec.TOKEN, rec.SERVICE_KEY, rec.META_KEY, rec.USER_ID,
                   "test-geoapify-key", "PRIVATE_ERROR", "PRIVATE_MESSAGE"):
        assert secret not in caplog.text


@pytest.mark.parametrize("craving,category", [
    ("pizza", "catering.restaurant.pizza,catering.fast_food.pizza"),
    ("chinese", "catering.restaurant.chinese,catering.restaurant.dumpling,"
                 "catering.restaurant.taiwanese"),
    (None, "catering"),
])
def test_initial_provider_timeout_is_a_full_504_for_targeted_and_general_searches(
    monkeypatch, caplog, craving, category,
):
    caplog.set_level(logging.INFO)
    provider = Provider([httpx2.ReadTimeout("PRIVATE_ERROR with secret URL")])
    response = rec.post(provider, craving=craving, request_source="retry", transcript=[{
        "role": "user", "body": "PRIVATE_MESSAGE"}])
    assert response.status_code == 504
    assert response.json() == {"detail": "Places search timed out"}
    assert len(provider.searches) == 1  # no automatic retry or widening after full failure
    assert provider.searches[0].url.params["categories"] == category
    search, = rows(caplog, "Recommendation search: ")
    assert search["stage"] == "initial" and search["outcome"] == "provider_timeout"
    assert search["remaining_ms"] == 4000 and search["source"] == "retry"
    summary, = rows(caplog, "Recommendation request: ")
    assert summary["http_status"] == 504 and summary["places_calls"] == 1
    assert summary["search_status"] == "timeout" and summary["picks"] == 0
    assert_private_telemetry(caplog)


def test_shared_deadline_cancels_the_initial_search_without_a_retry(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(widening, "PLACES_BUDGET_S", .02)
    provider = Provider(["stall"])
    response = rec.post(provider, craving="pizza", request_source="typed")
    assert response.status_code == 504 and len(provider.searches) == 1
    search, = rows(caplog, "Recommendation search: ")
    assert search["outcome"] == "shared_budget_timeout" and search["stage"] == "initial"
    assert search["remaining_ms"] == 20
    assert_private_telemetry(caplog)


def pizza(name, osm_id, offset):
    return rec.feature(name, osm_id, rec.LAT + offset, ["catering.restaurant.pizza"])


@pytest.mark.parametrize("failure", ["stall", httpx2.ReadTimeout("PRIVATE_ERROR"), 504])
def test_optional_widening_failure_keeps_verified_closest_chain_pizza_results(
    monkeypatch, caplog, failure,
):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(widening, "PLACES_BUDGET_S", .04)
    near, far = pizza("Synthetic Chain Near", 101, .001), pizza("Synthetic Chain Far", 102, .01)
    for branch in (near, far):
        branch["properties"]["datasource"]["raw"].update({
            "brand": "Synthetic Pizza Chain", "brand:wikidata": "Q730001"})
    independent = pizza("Synthetic Independent", 103, .005)
    wrong = rec.feature("Unrelated Chinese", 104, rec.LAT + .002,
                        ["catering.restaurant.chinese"])
    provider = Provider([[near, far, independent, wrong], failure])
    response = rec.post(provider, craving="pizza", radius_m=15000, request_source="typed")
    assert response.status_code == 200
    body = response.json()
    assert body["search_status"] == "partial"
    assert body["search_issue"] == ("provider_error" if failure == 504 else "timeout")
    assert {p["id"] for p in body["picks"]} == {"node/101", "node/103"}
    assert all(p["category"] == "pizza" for p in body["picks"])
    assert len(provider.searches) == 2
    assert all(r.url.params["categories"] ==
               "catering.restaurant.pizza,catering.fast_food.pizza" for r in provider.searches)
    search = rows(caplog, "Recommendation search: ")
    assert [row["stage"] for row in search] == ["initial", "widening"]
    assert search[0]["outcome"] == "success" and search[0]["candidates"] == 4
    expected = ("shared_budget_timeout" if failure == "stall" else "provider_timeout"
                if isinstance(failure, Exception) else "PlacesUpstreamError")
    assert search[1]["outcome"] == expected
    assert search[1]["remaining_ms"] <= search[0]["remaining_ms"]
    summary, = rows(caplog, "Recommendation request: ")
    assert summary["http_status"] == 200 and summary["picks"] == 2
    assert summary["search_status"] == "partial" and summary["places_calls"] == 2
    assert_private_telemetry(caplog)


def test_completed_empty_pizza_search_has_distinct_coverage_and_bounded_calls(caplog):
    caplog.set_level(logging.INFO)
    provider = Provider([[]])
    response = rec.post(provider, craving="pizza", radius_m=15000, request_source="chip")
    assert response.status_code == 200 and response.json()["picks"] == []
    assert response.json()["search_status"] == "complete"
    assert len(provider.searches) == 3  # initial plus existing maximum two expansions
    summary, = rows(caplog, "Recommendation request: ")
    assert summary["search_status"] == "complete" and summary["http_status"] == 200
    assert summary["source"] == "chip"
    assert_private_telemetry(caplog)


def test_existing_deadlines_and_limits_are_unchanged():
    assert widening.PLACES_BUDGET_S == 4
    assert widening.MAX_EXPANSIONS == 2 and widening.MAX_RADIUS_M == 40234
    assert main.ROUND_BUDGET_S == 7.5
