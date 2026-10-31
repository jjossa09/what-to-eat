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
SERVICE_KEY = "test-service-role-key"
SESSION_ID = "11111111-1111-1111-1111-111111111111"
HISTORY_TABLES = {"taste_profiles", "meals"}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", "test-geoapify-key")
    monkeypatch.setenv("SUPABASE_URL", f"https://{SUPABASE_HOST}")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
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
                 history_exc=None, fail=(), last_round=None, session_found=True):
        self.places_status, self.history_status = places_status, history_status
        self.muse_lines, self.muse_status, self.history_exc = muse_lines, muse_status, history_exc
        self.fail = set(fail)  # "METHOD table" pairs that return 500
        self.last_round, self.session_found = last_round, session_found
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
                return self.supabase(request)
            if host == "api.meta.ai":
                return httpx2.Response(self.muse_status, json=self.muse_reply(request))
            raise AssertionError(f"unexpected host {host}")
        finally:
            self.in_flight -= 1


def supabase(self, request: httpx2.Request) -> httpx2.Response:
    table = request.url.path.rsplit("/", 1)[-1]
    if request.method == "GET" and table in HISTORY_TABLES:
        if self.history_exc:
            raise self.history_exc
        rows = PRIOR if table == "taste_profiles" else MEALS
        return httpx2.Response(self.history_status, json=rows)
    if f"{request.method} {table}" in self.fail:
        return httpx2.Response(500, json={"message": "secret upstream detail"})
    if request.method == "POST" and table == "sessions":
        return httpx2.Response(201, json=[{"id": SESSION_ID}])
    if request.method == "GET" and table == "sessions":
        if not self.session_found:
            return httpx2.Response(200, json=[])
        events = [] if self.last_round is None else [{"round": self.last_round}]
        return httpx2.Response(200, json=[{"id": SESSION_ID, "recommendation_events": events}])
    if request.method == "POST" and table in ("places", "recommendation_events"):
        return httpx2.Response(201)
    raise AssertionError(f"unexpected Supabase call {request.method} {table}")


Upstreams.supabase = supabase


def writes(up: Upstreams, table: str) -> list[httpx2.Request]:
    return [r for r in up.requests if r.url.host == SUPABASE_HOST and r.method != "GET"
            and r.url.path.endswith(f"/{table}")]


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
    # taste_profiles + meals reads; session insert; places upsert; shown events insert.
    assert hosts.count(SUPABASE_HOST) == 5
    assert hosts.count("api.meta.ai") == 1
    paths = [r.url.path for r in up.requests]
    assert paths.index("/v1/chat/completions") < paths.index("/rest/v1/recommendation_events")
    # Places, both history reads, and the session insert overlap; the places upsert overlaps
    # the Muse call.
    assert up.max_in_flight == 4


def test_history_read_as_user():
    up = Upstreams()
    post(up)
    supabase = [r for r in up.requests if r.url.host == SUPABASE_HOST and r.method == "GET"]
    assert supabase
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


# Funnel logging (P1-15)


def test_round_one_creates_session_and_logs_shown():
    up = Upstreams()
    body = post(up, craving="thai", budget_level=2, radius_m=1500,
                timezone="America/New_York").json()
    assert body["logged"] is True
    assert body["session_id"] == SESSION_ID
    assert body["round"] == 1

    (session,) = writes(up, "sessions")
    row = json.loads(session.content)
    assert row == {"user_id": USER_ID, "timezone": "America/New_York",
                   "local_date": "2026-10-29", "meal_slot": "dinner", "lat": LAT, "lon": LON,
                   "craving_category_id": "thai", "budget_level": 2, "radius_m": 1500,
                   "search_radius_m": 1500}

    (events,) = writes(up, "recommendation_events")
    rows = json.loads(events.content)
    assert [r["place_id"] for r in rows] == [p["id"] for p in body["picks"]]
    for row, pick in zip(rows, body["picks"], strict=True):
        assert row["event"] == "shown"
        assert row["user_id"] == USER_ID
        assert row["session_id"] == SESSION_ID
        assert row["round"] == 1
        assert (row["rank"], row["slot"], row["pick_reason"]) == (
            pick["rank"], pick["slot"], pick["reason"])
        assert isinstance(row["score"], float)
        assert row["reasons_source"] == "muse"


def test_shown_places_are_cached_first():
    up = Upstreams()
    body = post(up).json()
    (upsert,) = writes(up, "places")
    assert upsert.url.params["on_conflict"] == "id"
    assert "merge-duplicates" in upsert.headers["prefer"]
    rows = json.loads(upsert.content)
    assert [r["id"] for r in rows] == [p["id"] for p in body["picks"]]
    assert all(r["unresolved"] is False and r["category_id"] for r in rows)
    paths = [r.url.path for r in up.requests]
    assert paths.index("/rest/v1/places") < paths.index("/rest/v1/recommendation_events")


def test_template_reasons_source_is_logged():
    up = Upstreams(muse_status=500)
    post(up)
    rows = json.loads(writes(up, "recommendation_events")[0].content)
    assert {r["reasons_source"] for r in rows} == {"template"}


def test_later_round_continues_the_session():
    up = Upstreams(last_round=2)
    body = post(up, session_id=SESSION_ID).json()
    assert (body["session_id"], body["round"], body["logged"]) == (SESSION_ID, 3, True)
    assert writes(up, "sessions") == []
    (read,) = [r for r in up.requests if r.url.path.endswith("/sessions")]
    assert read.url.params["id"] == f"eq.{SESSION_ID}"
    assert read.url.params["user_id"] == f"eq.{USER_ID}"
    rows = json.loads(writes(up, "recommendation_events")[0].content)
    assert {r["round"] for r in rows} == {3}


def test_session_with_no_events_yet_is_round_one():
    body = post(Upstreams(), session_id=SESSION_ID).json()
    assert body["round"] == 1


def test_timezone_falls_back_to_offset():
    up = Upstreams()
    post(up)
    assert json.loads(writes(up, "sessions")[0].content)["timezone"] == "UTC-04:00"


def test_unknown_timezone_is_rejected():
    up = Upstreams()
    assert post(up, timezone="Mars/Olympus").status_code == 422
    assert up.requests == []


@pytest.mark.parametrize("fail", ["POST sessions", "POST places", "POST recommendation_events"])
def test_logging_failure_still_returns_the_round(fail, caplog):
    caplog.set_level(logging.DEBUG)
    up = Upstreams(fail=[fail])
    response = post(up)
    assert response.status_code == 200
    body = response.json()
    assert body["logged"] is False
    assert len(body["picks"]) == 3
    assert "Funnel" in caplog.text and "FunnelUpstreamError" in caplog.text
    assert "secret upstream detail" not in caplog.text
    assert TOKEN not in caplog.text and SERVICE_KEY not in caplog.text
    if fail == "POST sessions":
        assert body["session_id"] is None
        assert writes(up, "places") == [] and writes(up, "recommendation_events") == []
    if fail == "POST places":
        assert writes(up, "recommendation_events") == []


def test_logging_transport_error_still_returns_the_round():
    class Down(Upstreams):
        def supabase(self, request):
            if request.method != "GET":
                raise httpx2.ConnectError("down")
            return super().supabase(request)

    body = post(Down()).json()
    assert body["logged"] is False
    assert len(body["picks"]) == 3


def test_someone_elses_session_is_not_logged():
    up = Upstreams(session_found=False)  # RLS and the user_id filter return no row
    body = post(up, session_id=SESSION_ID).json()
    assert body["logged"] is False
    assert len(body["picks"]) == 3
    assert writes(up, "places") == [] and writes(up, "recommendation_events") == []


def test_user_owned_writes_never_use_the_service_role():
    up = Upstreams()
    post(up)
    supabase = [r for r in up.requests if r.url.host == SUPABASE_HOST]
    service = [r for r in supabase if SERVICE_KEY in r.headers["authorization"]
               or r.headers["apikey"] == SERVICE_KEY]
    assert [r.url.path for r in service] == ["/rest/v1/places"]
    for r in supabase:
        if not r.url.path.endswith("/places"):
            assert r.headers["authorization"] == f"Bearer {TOKEN}"
            assert r.headers["apikey"] == "test-anon-key"


def test_bad_session_id_is_rejected():
    up = Upstreams()
    assert post(up, session_id="not-a-uuid").status_code == 422
    assert up.requests == []
