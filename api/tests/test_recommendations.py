import asyncio
import json
import logging

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import muse
from app.auth import current_auth
from app.config import get_settings
from app.main import app, get_http_client

LAT, LON = 33.95, -84.55
USER_ID = "00000000-0000-0000-0000-000000000001"
TOKEN = "user.jwt.token"
SUPABASE_HOST = "test-project.supabase.co"
META_KEY = "LLM_1_test-meta-key"
LOCAL_TIME = "2026-10-29T19:30:00-04:00"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", "test-geoapify-key")
    monkeypatch.setenv("SUPABASE_URL", f"https://{SUPABASE_HOST}")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("META_API_KEY", META_KEY)
    monkeypatch.setenv("PLACES_RADIUS_M", "5000")
    monkeypatch.setenv("MUSE_DAILY_CAP", "200")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    app.dependency_overrides.clear()


def feature(name, osm_id, lat, categories) -> dict:
    return {"type": "Feature", "properties": {
        "name": name, "lat": lat, "lon": LON, "categories": categories, "place_id": f"p{osm_id}",
        "formatted": f"{osm_id} Main St", "datasource": {"raw": {"osm_type": "n",
                                                                 "osm_id": osm_id}}}}


FEATURES = [
    feature("Thai One", 1, 33.953, ["catering", "catering.restaurant.thai"]),
    feature("Pizza Two", 2, 33.955, ["catering", "catering.restaurant.pizza"]),
    feature("Taco Three", 3, 33.957, ["catering", "catering.restaurant.mexican"]),
    feature("Burger Four", 4, 33.960, ["catering", "catering.fast_food.burger"]),
]

PRIOR = [{"favorite_categories": ["thai", "pizza"], "hard_no_categories": ["burgers"],
          "budget_level": 2}]
FAR_PLACE = {"id": "node/50", "name": "Far Thai", "lat": 33.98, "lon": LON,
             "geoapify_categories": ["catering.restaurant.thai"], "address": "50 Far Rd",
             "unresolved": False}
MEALS = [{"source": "live", "category_id": None, "eaten_on": "2026-10-20", "price_level": 2,
          "places": FAR_PLACE}]


class Upstreams:
    """One MockTransport for Geoapify, Supabase, and Meta, routed by host."""

    def __init__(self, places_status=200, history_status=200, muse_lines=None, muse_status=200,
                 history_exc=None):
        self.places_status, self.history_status = places_status, history_status
        self.muse_lines, self.muse_status, self.history_exc = muse_lines, muse_status, history_exc
        self.requests: list[httpx2.Request] = []
        self.in_flight = self.max_in_flight = 0

    def hosts(self) -> list[str]:
        return [r.url.host for r in self.requests]

    def muse_reply(self, request) -> dict:
        ids = [p["id"] for p in json.loads(json.loads(request.content)["messages"][1]["content"])
               ["picks"]]
        lines = self.muse_lines or {i: f"Reason for {i}." for i in reversed(ids)}
        content = json.dumps({"reasons": [{"id": i, "line": t} for i, t in lines.items()]})
        return {"choices": [{"message": {"content": content}}],
                "usage": {"prompt_tokens": 400, "completion_tokens": 50, "total_tokens": 450}}

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0.01)  # lets parallel requests overlap
            host = request.url.host
            if host == "api.geoapify.com":
                body = {"type": "FeatureCollection", "features": FEATURES}
                return httpx2.Response(self.places_status, json=body)
            if host == SUPABASE_HOST:
                if self.history_exc:
                    raise self.history_exc
                table = request.url.path.rsplit("/", 1)[-1]
                rows = PRIOR if table == "taste_profiles" else MEALS
                return httpx2.Response(self.history_status, json=rows)
            if host == "api.meta.ai":
                return httpx2.Response(self.muse_status, json=self.muse_reply(request))
            raise AssertionError(f"unexpected host {host}")
        finally:
            self.in_flight -= 1


def use(upstreams: Upstreams, authed=True) -> TestClient:
    async def client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstreams)) as c:
            yield c

    app.dependency_overrides[get_http_client] = client
    if authed:
        app.dependency_overrides[current_auth] = lambda: (USER_ID, TOKEN)
    return TestClient(app)


def post(upstreams: Upstreams, authed=True, **body):
    payload = {"lat": LAT, "lon": LON, "local_time": LOCAL_TIME, **body}
    return use(upstreams, authed).post("/recommendations", json=payload)


# Happy path


def test_full_round():
    up = Upstreams()
    response = post(up)
    assert response.status_code == 200
    body = response.json()
    assert body["history_used"] is True
    assert body["reasons_source"] == "muse"
    assert body["cold_start"] is False
    assert body["radius_m"] == 5000
    assert len(body["picks"]) == 3
    ids = [p["id"] for p in body["picks"]]
    assert "node/4" not in ids  # hard no
    assert [p["rank"] for p in body["picks"]] == [1, 2, 3]
    assert [p["slot"] for p in body["picks"]] == ["familiar", "familiar", "discovery"]
    # Muse answered in reverse; our order holds.
    assert [p["reason"] for p in body["picks"]] == [f"Reason for {i}." for i in ids]
    assert set(body["picks"][0]) == {"rank", "slot", "id", "name", "lat", "lon", "distance_m",
                                     "category", "address", "reason"}


def test_one_call_each_and_parallel_fetch():
    up = Upstreams()
    post(up)
    hosts = up.hosts()
    assert hosts.count("api.geoapify.com") == 1
    assert hosts.count(SUPABASE_HOST) == 2  # taste_profiles + meals
    assert hosts.count("api.meta.ai") == 1
    assert hosts[-1] == "api.meta.ai"  # Muse runs after ranking
    assert up.max_in_flight == 3  # places and both history reads overlap


def test_history_read_as_user():
    up = Upstreams()
    post(up)
    supabase = [r for r in up.requests if r.url.host == SUPABASE_HOST]
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in supabase)


def test_history_place_beyond_geoapify_is_merged():
    # Far Thai is only known from history. With the near Thai place rejected, it fills the
    # second favorite slot (v1 has no return score, so nearer places win otherwise).
    body = post(Upstreams(), exclude_ids=["node/1"]).json()
    assert [p["id"] for p in body["picks"]][:2] == ["node/2", "node/50"]


def test_same_inputs_same_top3():
    first = post(Upstreams()).json()["picks"]
    second = post(Upstreams()).json()["picks"]
    assert [p["id"] for p in first] == [p["id"] for p in second]


def test_chip_radius_is_searched():
    up = Upstreams()
    assert post(up, radius_m=1500).json()["radius_m"] == 1500
    assert "1500" in up.requests[0].url.params["filter"]


def test_craving_makes_it_familiar():
    picks = post(Upstreams(), craving="mexican").json()["picks"]
    assert picks[0]["category"] == "mexican"


def test_exclude_ids():
    ids = [p["id"] for p in post(Upstreams(), exclude_ids=["node/1"]).json()["picks"]]
    assert "node/1" not in ids


# History failure: cold start, round still returned


@pytest.mark.parametrize("kw", [{"history_status": 500},
                                {"history_exc": httpx2.ConnectError("down")},
                                {"history_exc": httpx2.ReadTimeout("slow")}])
def test_history_failure_falls_back_to_cold_start(kw, caplog):
    caplog.set_level(logging.WARNING)
    response = post(Upstreams(**kw))
    assert response.status_code == 200
    body = response.json()
    assert body["history_used"] is False
    assert body["cold_start"] is True
    assert len(body["picks"]) == 3
    assert "node/50" not in [p["id"] for p in body["picks"]]
    assert "History load failed: History" in caplog.text
    assert TOKEN not in caplog.text


def test_history_not_configured(monkeypatch):
    monkeypatch.setenv("SUPABASE_ANON_KEY", "")
    get_settings.cache_clear()
    body = post(Upstreams()).json()
    assert body["history_used"] is False


# Muse failure: templates, round still returned


def test_muse_failure_uses_templates():
    body = post(Upstreams(muse_status=500)).json()
    assert body["reasons_source"] == "template"
    assert all(p["reason"].endswith("away.") for p in body["picks"])


def test_muse_health_term_uses_templates():
    up = Upstreams()
    ids = [p["id"] for p in post(up).json()["picks"]]
    bad = Upstreams(muse_lines={ids[0]: "A healthy choice.", ids[1]: "B.", ids[2]: "C."})
    assert post(bad).json()["reasons_source"] == "template"


# Places failure and validation


@pytest.mark.parametrize("status_code, expected", [(500, 502), (401, 502)])
def test_places_failure(status_code, expected):
    up = Upstreams(places_status=status_code)
    response = post(up)
    assert response.status_code == expected
    assert "api.meta.ai" not in up.hosts()


def test_requires_auth():
    up = Upstreams()
    response = post(up, authed=False)
    assert response.status_code == 401
    assert up.requests == []


@pytest.mark.parametrize("body", [{"radius_m": 2000}, {"craving": "other"},
                                  {"craving": "sushi"}, {"budget_level": 5}, {"lat": 91}])
def test_bad_request(body):
    up = Upstreams()
    assert post(up, **body).status_code == 422
    assert up.requests == []
