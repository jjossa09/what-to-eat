import asyncio
import json
import logging
import sys

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
MEALS = [{"source": "live", "went": True, "category_id": None, "eaten_on": "2026-10-20",
          "price_level": 2, "places": FAR_PLACE}]


class Upstreams:
    """One MockTransport for Geoapify, Supabase, and Meta, routed by host."""

    def __init__(self, places_status=200, history_status=200, muse_lines=None, muse_status=200,
                 history_exc=None, fail=(), last_round=None, session_found=True, shown=None,
                 outcome=None):
        self.places_status, self.history_status = places_status, history_status
        self.muse_lines, self.muse_status, self.history_exc = muse_lines, muse_status, history_exc
        self.fail = set(fail)  # "METHOD table" pairs that return 500
        self.last_round, self.session_found = last_round, session_found
        self.shown, self.outcome = shown, outcome  # shown: event rows for the session read
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
    if request.method == "GET" and table == "companions":
        return httpx2.Response(200, json=[])
    if request.method == "POST" and table == "sessions":
        return httpx2.Response(201, json=[{"id": SESSION_ID}])
    if request.method == "GET" and table == "sessions":
        if not self.session_found:
            return httpx2.Response(200, json=[])
        events = [] if self.last_round is None else [{"round": self.last_round}]
        if self.shown is not None:
            events = self.shown
        return httpx2.Response(200, json=[{"id": SESSION_ID, "outcome": self.outcome,
                                           "recommendation_events": events}])
    if request.method == "PATCH" and table == "sessions":
        return httpx2.Response(204)
    if request.method == "POST" and table == "append_session_gate":
        return httpx2.Response(200, json=getattr(self, "gate_result", True))
    if request.method == "POST" and table in ("places", "recommendation_events", "messages"):
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
    assert body["reasons_source"] == "template"
    assert body["cold_start"] is False
    assert body["radius_m"] == 11250
    assert len(body["picks"]) == 3
    ids = [p["id"] for p in body["picks"]]
    assert "node/4" not in ids  # hard no
    assert [p["rank"] for p in body["picks"]] == [1, 2, 3]
    assert [p["slot"] for p in body["picks"]] == ["familiar", "familiar", "discovery"]
    # Templates arrive without a language call; ordering is still the ranking order.
    assert all(p["reason"] for p in body["picks"])
    assert "api.meta.ai" not in up.hosts()
    assert set(body["picks"][0]) == {"rank", "slot", "id", "name", "lat", "lon", "distance_m",
                                     "category", "address", "reason"}


def test_one_call_each_and_parallel_fetch():
    class WithCompanions(Upstreams):
        def supabase(self, request):
            if request.method == "GET" and request.url.path.endswith("/companions"):
                return httpx2.Response(200, json=[])
            return super().supabase(request)

    up = WithCompanions()
    post(up)
    hosts = up.hosts()
    assert hosts.count("api.geoapify.com") == 3
    # taste_profiles + meals + companions reads (P2-07); session insert; places upsert; gate
    # append (P2-05); shown events insert.
    assert hosts.count(SUPABASE_HOST) == 8
    assert hosts.count("api.meta.ai") == 0
    # Places, the three history reads, and the session insert overlap; the places upsert
    # runs before shown events.
    assert up.max_in_flight == 5


def test_history_read_as_user():
    up = Upstreams()
    post(up)
    supabase = [r for r in up.requests if r.url.host == SUPABASE_HOST and r.method == "GET"]
    assert supabase
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in supabase)


def test_history_place_beyond_geoapify_is_merged():
    # Far Thai is only known from history. With the near Thai place rejected, it takes a
    # favorite slot, and its return score (P2-10, one past visit) puts it above nearer Pizza.
    body = post(Upstreams(), exclude_ids=["node/1"]).json()
    assert [p["id"] for p in body["picks"]][:2] == ["node/50", "node/2"]


def test_same_inputs_same_top3():
    first = post(Upstreams()).json()["picks"]
    second = post(Upstreams()).json()["picks"]
    assert [p["id"] for p in first] == [p["id"] for p in second]


@pytest.mark.parametrize("chip", [15000, 35000])
def test_chip_radius_is_searched_nearest_first(chip):
    up = Upstreams()
    assert post(up, radius_m=chip).json()["radius_m"] == {15000: 33750, 35000: 40234}[chip]
    params = up.requests[0].url.params
    assert str(chip) in params["filter"]
    assert params["bias"] == f"proximity:{LON},{LAT}"  # both levels: the nearest 100


@pytest.mark.parametrize("legacy", [1500, 5000])
def test_legacy_radius_reads_as_close_to_me(legacy):
    up = Upstreams()
    assert post(up, radius_m=legacy).json()["answers"]["radius_m"] == 15000
    assert "15000" in up.requests[0].url.params["filter"]


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
    body = post(up, craving="thai", budget_level=2, radius_m=15000,
                timezone="America/New_York", solo=True).json()
    assert body["logged"] is True
    assert body["session_id"] == SESSION_ID
    assert body["round"] == 1

    (session, _) = writes(up, "sessions")  # POST plus the widened search radius PATCH
    assert session.method == "POST"
    assert len(gate_calls(up)) == 1
    row = json.loads(session.content)
    assert row == {"user_id": USER_ID, "timezone": "America/New_York",
                   "local_date": "2026-10-29", "meal_slot": "dinner", "lat": LAT, "lon": LON,
                   "craving_category_id": "thai", "budget_level": 2, "radius_m": 15000,
                   "search_radius_m": 15000, "solo": True}

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
        assert row["reasons_source"] == "template"


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
    assert [r.method for r in writes(up, "sessions")] == ["PATCH"]  # answers, no new session
    (read,) = [r for r in up.requests if r.url.path.endswith("/sessions") and r.method == "GET"]
    assert read.url.params["id"] == f"eq.{SESSION_ID}"
    assert read.url.params["user_id"] == f"eq.{USER_ID}"
    assert read.url.params["recommendation_events.event"] == "eq.shown"
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


# Logging (P1-18)


def test_info_logging_never_logs_the_geoapify_key_url(caplog):
    caplog.set_level(logging.DEBUG)  # root at DEBUG; the client loggers keep their own level
    post(Upstreams())
    assert "Recommendations round in" in caplog.text  # INFO lines do get through
    assert "apiKey" not in caplog.text
    assert "test-geoapify-key" not in caplog.text


def test_client_loggers_are_quiet_and_would_otherwise_leak(caplog):
    # Guards the test above: with httpx2 at INFO, the request URL (and key) would be logged.
    assert logging.getLogger("httpx2").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore2").getEffectiveLevel() == logging.WARNING
    caplog.set_level(logging.INFO, logger="httpx2")
    post(Upstreams())
    assert "apiKey" in caplog.text



# Transcript (P1-09)

TRANSCRIPT = [
    {"role": "assistant", "body": "What are you craving?", "question_key": "craving"},
    {"role": "user", "body": "Thai", "question_key": "craving",
     "answer": {"craving": "thai"}, "input_mode": "chip"},
    {"role": "assistant", "body": "Budget this time?", "question_key": "budget"},
    {"role": "user", "body": "$$", "question_key": "budget", "answer": {"budget_level": 2},
     "input_mode": "prefill"},
    {"role": "assistant", "body": "How far?", "question_key": "distance"},
    {"role": "user", "body": "Close to me", "question_key": "distance",
     "answer": {"radius_m": 15000},
     "input_mode": "chip"},
]


def test_transcript_is_saved_as_round_zero():
    up = Upstreams()
    body = post(up, transcript=TRANSCRIPT).json()
    assert body["logged"] is True
    (insert,) = writes(up, "messages")
    assert insert.headers["authorization"] == f"Bearer {TOKEN}"
    rows = json.loads(insert.content)
    assert len(rows) == 6
    assert {r["user_id"] for r in rows} == {USER_ID}
    assert {r["session_id"] for r in rows} == {SESSION_ID}
    assert {r["round"] for r in rows} == {0}
    assert [r["role"] for r in rows] == ["assistant", "user"] * 3
    assert rows[3]["answer"] == {"budget_level": 2}
    assert rows[3]["input_mode"] == "prefill"
    assert rows[0]["answer"] is None and rows[0]["input_mode"] is None


def test_transcript_on_a_later_round_uses_the_previous_round():
    up = Upstreams(last_round=1)
    post(up, session_id=SESSION_ID, transcript=TRANSCRIPT[:2])
    rows = json.loads(writes(up, "messages")[0].content)
    assert {r["round"] for r in rows} == {1}


def test_no_transcript_makes_no_messages_call():
    up = Upstreams()
    assert post(up).json()["logged"] is True
    assert writes(up, "messages") == []


def test_transcript_failure_still_returns_the_round(caplog):
    caplog.set_level(logging.WARNING)
    up = Upstreams(fail=["POST messages"])
    body = post(up, transcript=TRANSCRIPT).json()
    assert body["logged"] is False
    assert len(body["picks"]) == 3
    assert "Funnel messages failed: FunnelUpstreamError" in caplog.text
    assert "What are you craving?" not in caplog.text


@pytest.mark.parametrize("transcript", [
    [{"role": "system", "body": "x"}],
    [{"role": "user", "body": ""}],
    [{"role": "user", "body": "x" * 201}],
    [{"role": "user", "body": "x", "question_key": "mood"}],
    [{"role": "user", "body": "x", "input_mode": "telepathy"}],
    [{"role": "user", "body": "x"}] * 9,
])
def test_bad_transcript_is_rejected(transcript):
    up = Upstreams()
    assert post(up, transcript=transcript).status_code == 422
    assert up.requests == []


# Follow-ups (P1-14, ML10)


def shown_event(round_, pid, score, category, lat, slot="familiar", reason="Stored reason."):
    return {"round": round_, "place_id": pid, "score": score, "slot": slot,
            "pick_reason": reason, "reasons_source": "muse",
            "places": {"name": f"Place {pid}", "lat": lat, "lon": LON, "category_id": category,
                       "address": f"{pid} Main St"}}


ROUND_1 = [shown_event(1, "node/1", 0.9, "thai", 33.953),
           shown_event(1, "node/2", 0.8, "pizza", 33.955),
           shown_event(1, "node/3", 0.5, "mexican", 33.957, slot="discovery")]


def follow_up(up: Upstreams, **body):
    base = {"session_id": SESSION_ID, "budget_level": 2, "radius_m": 35000}
    return post(up, **{**base, **body})


def rejected_rows(up: Upstreams) -> list[dict]:
    rows = [row for r in writes(up, "recommendation_events") for row in json.loads(r.content)]
    return [row for row in rows if row["event"] == "rejected"]


def session_patch(up: Upstreams) -> dict:
    (patch,) = [r for r in writes(up, "sessions") if r.method == "PATCH"]
    assert patch.url.params["id"] == f"eq.{SESSION_ID}"
    assert patch.url.params["user_id"] == f"eq.{USER_ID}"
    return json.loads(patch.content)


def test_follow_up_skips_every_shown_place_and_increments_the_round():
    up = Upstreams(shown=ROUND_1)
    body = follow_up(up, exclude_ids=[]).json()  # the server skips them even if the app doesn't
    assert body["round"] == 2 and body["logged"] is True
    assert not {"node/1", "node/2", "node/3"} & {p["id"] for p in body["picks"]}
    shown = [row for r in writes(up, "recommendation_events") for row in json.loads(r.content)
             if row["event"] == "shown"]
    assert {r["round"] for r in shown} == {2}


def test_follow_up_logs_previous_round_as_rejected_with_tags():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, refine={"budget": "cheaper", "exclude_categories": ["burgers"]})
    rows = rejected_rows(up)
    assert [r["place_id"] for r in rows] == ["node/1", "node/2", "node/3"]
    assert {r["round"] for r in rows} == {1}
    assert {r["reject_reason"] for r in rows} == {"refine:not:burgers,cheaper"}
    assert all(r["user_id"] == USER_ID and r["session_id"] == SESSION_ID for r in rows)


def test_cheaper_steps_the_budget_down_and_updates_the_session():
    up = Upstreams(shown=ROUND_1)
    body = follow_up(up, craving="thai", refine={"budget": "cheaper"}).json()
    assert body["answers"] == {"craving": "thai", "budget_level": 1, "radius_m": 35000,
                               "exclude_categories": []}
    assert session_patch(up) == {"craving_category_id": "thai", "budget_level": 1,
                                 "radius_m": 35000, "search_radius_m": 40234}


def test_cheaper_stops_at_one_dollar():
    body = follow_up(Upstreams(shown=ROUND_1), budget_level=1, refine={"budget": "cheaper"})
    assert body.json()["answers"]["budget_level"] == 1


def test_closer_searches_the_next_smaller_radius():
    up = Upstreams(shown=ROUND_1)
    body = follow_up(up, refine={"distance": "closer"}).json()
    assert body["answers"]["radius_m"] == 15000
    places_call = next(r for r in up.requests if r.url.host == "api.geoapify.com")
    assert "15000" in places_call.url.params["filter"]


def test_not_a_category_drops_it():
    up = Upstreams(shown=[])
    body = follow_up(up, refine={"exclude_categories": ["thai", "mexican"]}).json()
    assert body["answers"]["exclude_categories"] == ["thai", "mexican"]
    assert not {"thai", "mexican"} & {p["category"] for p in body["picks"]}


def test_exclude_categories_are_kept_on_later_rounds():
    body = follow_up(Upstreams(shown=[]), exclude_categories=["pizza"]).json()
    assert "pizza" not in {p["category"] for p in body["picks"]}


def test_something_else_drops_the_craving():
    up = Upstreams(shown=[])
    body = follow_up(up, craving="thai", refine={"something_else": True}).json()
    assert body["answers"]["craving"] is None
    assert body["answers"]["exclude_categories"] == ["thai"]
    assert "thai" not in {p["category"] for p in body["picks"]}


def test_something_else_with_anything_keeps_settings_and_shows_new_places():
    up = Upstreams(shown=[shown_event(1, "node/1", 0.9, "thai", 33.953)])
    body = follow_up(up, craving=None, refine={"something_else": True}).json()
    assert body["answers"] == {"craving": None, "budget_level": 2, "radius_m": 35000,
                               "exclude_categories": []}
    ids = [p["id"] for p in body["picks"]]
    assert "node/1" not in ids and len(ids) == 3
    assert {r["reject_reason"] for r in rejected_rows(up)} == {"refine:something_else"}


def test_follow_up_after_a_decision_is_a_conflict():
    up = Upstreams(shown=ROUND_1, outcome="none")
    assert follow_up(up, refine={"budget": "cheaper"}).status_code == 409
    assert "api.geoapify.com" not in up.hosts() and "api.meta.ai" not in up.hosts()


def test_follow_up_writes_run_without_muse():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, refine={"distance": "farther"})
    assert up.hosts().count("api.meta.ai") == 0
    assert up.hosts().count("api.geoapify.com") == 2
    paths = [(r.method, r.url.path) for r in up.requests]
    # One session read, one PATCH, one rejected insert, one shown insert, one places upsert.
    assert paths.count(("GET", "/rest/v1/sessions")) == 1
    assert paths.count(("PATCH", "/rest/v1/sessions")) == 1
    assert paths.count(("POST", "/rest/v1/recommendation_events")) == 2


@pytest.mark.parametrize("change", [{"budget": 5}, {"distance": 2000}, {"craving": "sushi"},
                                    {"exclude_categories": ["other"]}, {"mood": "happy"}])
def test_bad_refine_is_rejected(change):
    up = Upstreams()
    assert follow_up(up, refine=change).status_code == 422
    assert up.requests == []


def test_text_answers_with_a_list_are_saved():
    up = Upstreams(shown=ROUND_1)
    message = {"role": "user", "body": "not burgers, cheaper", "question_key": "refine",
               "input_mode": "text",
               "answer": {"exclude_categories": ["burgers"], "budget": "cheaper"}}
    follow_up(up, transcript=[message], refine={"budget": "cheaper"})
    (row,) = json.loads(writes(up, "messages")[0].content)
    assert (row["input_mode"], row["round"]) == ("text", 1)
    assert row["answer"]["exclude_categories"] == ["burgers"]


# Cap: round 4 without a pick is the best so far (ML10)


THREE_ROUNDS = [
    *ROUND_1,
    shown_event(2, "node/50", 0.85, "thai", 33.98, reason="Far but good."),
    shown_event(2, "node/6", 0.4, "pizza", 33.954),
    shown_event(3, "node/7", 0.7, "korean", 34.10),  # ~16.7 km: past Close to me
    shown_event(3, "node/8", 0.3, "indian", 33.958),
]


def shown_inserts(up: Upstreams) -> list[dict]:
    rows = [row for r in writes(up, "recommendation_events") for row in json.loads(r.content)]
    return [row for row in rows if row["event"] == "shown"]


def test_round_four_shows_best_so_far_without_places_or_muse():
    up = Upstreams(shown=THREE_ROUNDS)
    body = follow_up(up, refine={"something_else": True}).json()
    assert body["best_so_far"] is True and body["round"] == 4 and body["logged"] is True
    assert [p["id"] for p in body["picks"]] == ["node/1", "node/50", "node/2"]
    assert [p["rank"] for p in body["picks"]] == [1, 2, 3]
    assert body["picks"][1]["reason"] == "Far but good."
    assert "api.geoapify.com" not in up.hosts() and "api.meta.ai" not in up.hosts()
    rows = shown_inserts(up)
    assert [r["place_id"] for r in rows] == ["node/1", "node/50", "node/2"]
    assert {r["round"] for r in rows} == {4}
    assert {r["reasons_source"] for r in rows} == {"muse"}
    assert [r["place_id"] for r in rejected_rows(up)] == ["node/7", "node/8"]


def test_best_so_far_filters_by_current_answers():
    # Not thai drops node/1 and node/50; Close to me (15 km) drops node/7.
    up = Upstreams(shown=THREE_ROUNDS)
    body = follow_up(up, radius_m=15000, refine={"exclude_categories": ["thai"]}).json()
    assert [p["id"] for p in body["picks"]] == ["node/2", "node/3", "node/6"]


def test_best_so_far_drops_known_prices_above_budget():
    # node/50 was paid at $$ (history); at $ it no longer fits. Unknown prices stay.
    body = follow_up(Upstreams(shown=THREE_ROUNDS), budget_level=1).json()
    assert "node/50" not in [p["id"] for p in body["picks"]]
    assert [p["id"] for p in body["picks"]] == ["node/1", "node/2", "node/7"]


def test_best_so_far_fewer_than_three_shows_what_is_left():
    up = Upstreams(shown=THREE_ROUNDS)
    body = follow_up(up, radius_m=15000, refine={"exclude_categories": ["thai", "pizza"]}).json()
    assert body["best_so_far"] is True
    assert [p["id"] for p in body["picks"]] == ["node/3", "node/8"]
    assert [r["rank"] for r in shown_inserts(up)] == [1, 2]


def test_best_so_far_none_left_logs_no_cards():
    up = Upstreams(shown=THREE_ROUNDS)
    excluded = ["thai", "pizza", "mexican", "korean", "indian"]
    body = follow_up(up, refine={"exclude_categories": excluded}).json()
    assert body["best_so_far"] is True and body["picks"] == []
    assert body["logged"] is True
    assert shown_inserts(up) == []
    assert len(rejected_rows(up)) == 2  # round 3's cards


def test_answer_to_the_open_question_runs_a_normal_round():
    up = Upstreams(shown=THREE_ROUNDS)
    message = {"role": "user", "body": "Pizza", "question_key": "open", "input_mode": "chip",
               "answer": {"craving": "pizza"}}
    body = follow_up(up, transcript=[message], refine={"craving": "pizza"}).json()
    assert body["best_so_far"] is False and body["round"] == 4
    assert "api.geoapify.com" in up.hosts()


# Confidence gate (P2-05, ML6, ML10) -------------------------------------------


def plan_post(up: Upstreams, authed=True, **body):
    return use(up, authed).post("/questions/plan", json={"local_time": LOCAL_TIME, **body})


def gate_calls(up: Upstreams) -> list[dict]:
    """append_session_gate payloads, in order."""
    return [json.loads(r.content) for r in up.requests
            if r.url.path == "/rest/v1/rpc/append_session_gate"]


def test_plan_returns_three_questions_from_history_only():
    up = Upstreams()
    body = plan_post(up).json()
    assert body["history_used"] is True and body["meal_slot"] == "dinner"
    assert [q["key"] for q in body["questions"]] == ["craving", "budget", "distance"]
    # The quiz prior alone has no meals behind it: nothing is confident, nothing pre-filled.
    assert all(q["weak"] and q["prefill"] is None for q in body["questions"])
    assert set(up.hosts()) == {SUPABASE_HOST}  # no places search, no Muse call
    assert all(r.method == "GET" for r in up.requests)  # reads only, as the user
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in up.requests)


def test_plan_pre_fills_a_confident_craving_and_asks_it_last(monkeypatch):
    meals = [{"source": "backfill", "category_id": "thai", "eaten_on": f"2026-10-{d:02d}",
              "meal_slot": "dinner", "is_weekend": False, "price_level": None,
              "places": None} for d in (1, 8, 15, 22, 27, 28)]
    monkeypatch.setattr(sys.modules[__name__], "MEALS", meals)
    body = plan_post(Upstreams()).json()
    assert [q["key"] for q in body["questions"]] == ["budget", "distance", "craving"]
    assert body["questions"][-1]["prefill"] == "thai"


@pytest.mark.parametrize("kw", [{"history_status": 500},
                                {"history_exc": httpx2.ConnectError("down")}])
def test_plan_history_failure_is_the_cold_start_order(kw):
    response = plan_post(Upstreams(**kw))
    assert response.status_code == 200
    body = response.json()
    assert body["history_used"] is False
    assert [q["key"] for q in body["questions"]] == ["craving", "budget", "distance"]


def test_plan_requires_auth():
    assert plan_post(Upstreams(), authed=False).status_code == 401


def test_plan_bad_request():
    assert use(Upstreams()).post("/questions/plan", json={}).status_code == 422


def test_round_one_appends_the_plan_and_the_refinement_choice():
    up = Upstreams()
    body = post(up).json()
    assert body["logged"] is True and body["gate_logged"] is True
    (call,) = gate_calls(up)
    assert (call["p_session_id"], call["p_round"]) == (SESSION_ID, 1)
    assert [q["key"] for q in call["p_plan"]["questions"]] == ["craving", "budget", "distance"]
    assert set(call["p_entry"]["gains"]) == {"craving", "budget", "distance"}
    (rpc,) = [r for r in up.requests if r.url.path.endswith("/append_session_gate")]
    assert rpc.headers["authorization"] == f"Bearer {TOKEN}"  # as the user (RLS)
    assert rpc.headers["apikey"] != SERVICE_KEY


def test_no_places_left_means_no_next_question():
    # 3 allowed places, all shown: nothing left to split, the app keeps its fixed chips.
    up = Upstreams()
    body = post(up).json()
    assert body["next_question"] is None
    assert gate_calls(up)[0]["p_entry"] == {
        "key": None, "options": [], "gains": {"craving": 0.0, "budget": 0.0, "distance": 0.0}}


def test_next_question_from_information_gain(monkeypatch):
    cats = [("thai", "catering.restaurant.thai"), ("pizza", "catering.restaurant.pizza"),
            ("mexican", "catering.restaurant.mexican"), ("indian", "catering.restaurant.indian")]
    features = [feature(f"{c} {i}", 100 + 10 * k + i, 33.951 + 0.001 * i, ["catering", tag])
                for k, (c, tag) in enumerate(cats) for i in range(3)]
    monkeypatch.setattr(sys.modules[__name__], "FEATURES", features)
    up = Upstreams()
    body = post(up).json()
    nq = body["next_question"]
    assert nq["key"] == "craving" and nq["gains"]["craving"] > 0
    assert set(nq["options"]) <= {"thai", "pizza", "mexican", "indian"}
    assert gate_calls(up)[0]["p_entry"]["key"] == "craving"
    assert up.hosts().count("api.meta.ai") == 0  # no extra Muse call for the question
    assert up.hosts().count("api.geoapify.com") == 1


def test_later_round_appends_its_entry_without_the_plan():
    up = Upstreams(shown=ROUND_1)
    body = follow_up(up, refine={"budget": "cheaper"}).json()
    assert body["gate_logged"] is True
    (call,) = gate_calls(up)
    assert (call["p_round"], call["p_plan"]) == (2, None)
    assert "gains" in call["p_entry"]
    assert "gate" not in session_patch(up)  # the answers' PATCH is unchanged


def test_cap_round_appends_the_rule():
    up = Upstreams(shown=THREE_ROUNDS)
    body = follow_up(up, refine={"something_else": True}).json()
    assert body["best_so_far"] is True and body["next_question"] is None
    assert body["gate_logged"] is True
    (call,) = gate_calls(up)
    assert (call["p_round"], call["p_entry"], call["p_plan"]) == (
        4, {"key": "open", "rule": "cap"}, None)


# Gate writes failing (e.g. the column or function is not there yet): the round and every
# other log go on; only the gate entry is lost.

GATE_FAILURES = [
    {"fail": {"POST append_session_gate"}},  # 500
    {"gate_result": False},  # no row of the caller's matched
]
GATE_TRANSCRIPT = [
    {"role": "assistant", "body": "What are you craving?", "question_key": "craving"},
    {"role": "user", "body": "Thai", "question_key": "craving", "answer": {"craving": "thai"},
     "input_mode": "chip"},
]


def failing(kw, **upstream) -> Upstreams:
    up = Upstreams(**{k: v for k, v in kw.items() if k == "fail"}, **upstream)
    if "gate_result" in kw:
        up.gate_result = kw["gate_result"]
    return up


def events(up: Upstreams, event: str) -> list[dict]:
    rows = [row for r in writes(up, "recommendation_events") for row in json.loads(r.content)]
    return [row for row in rows if row["event"] == event]


@pytest.mark.parametrize("kw", GATE_FAILURES)
def test_gate_failure_round_one_logs_everything_else(kw, caplog):
    up = failing(kw)
    body = post(up, transcript=GATE_TRANSCRIPT).json()
    assert (body["round"], body["logged"], body["gate_logged"]) == (1, True, False)
    assert len(body["picks"]) == 3
    assert [r["place_id"] for r in events(up, "shown")] == [p["id"] for p in body["picks"]]
    assert [r.method for r in writes(up, "sessions")] == ["POST", "PATCH"]
    assert len(writes(up, "messages")) == 1
    assert len(gate_calls(up)) == 1  # tried once, not retried
    assert "Funnel gate failed" in caplog.text


@pytest.mark.parametrize("kw", GATE_FAILURES)
def test_gate_failure_later_round_logs_everything_else(kw):
    up = failing(kw, shown=ROUND_1)
    body = follow_up(up, refine={"budget": "cheaper"}, transcript=GATE_TRANSCRIPT).json()
    assert (body["round"], body["logged"], body["gate_logged"]) == (2, True, False)
    assert {r["round"] for r in events(up, "shown")} == {2}
    assert [r["place_id"] for r in events(up, "rejected")] == ["node/1", "node/2", "node/3"]
    assert session_patch(up)["budget_level"] == 1  # answers updated
    assert len(writes(up, "messages")) == 1


@pytest.mark.parametrize("kw", GATE_FAILURES)
def test_gate_failure_round_four_still_caps(kw):
    up = failing(kw, shown=THREE_ROUNDS)
    body = follow_up(up, refine={"something_else": True}, transcript=GATE_TRANSCRIPT).json()
    assert body["best_so_far"] is True and body["round"] == 4
    assert (body["logged"], body["gate_logged"]) == (True, False)
    assert {r["round"] for r in events(up, "shown")} == {4}
    assert [r["place_id"] for r in events(up, "rejected")] == ["node/7", "node/8"]
    assert len(writes(up, "sessions")) == 1  # the answers' PATCH
    assert len(writes(up, "messages")) == 1
    assert "api.geoapify.com" not in up.hosts() and "api.meta.ai" not in up.hosts()


# What the phone asked, next to the recomputed plan (round 1) -------------------
# The quiz-only fixture recomputes craving, budget, distance.

def asked(up: Upstreams) -> dict:
    """The asked block without the pre-fill trace (tested on its own below)."""
    block = dict(gate_calls(up)[0]["p_plan"]["asked"])
    block.pop("prefilled")
    return block


def prefilled(up: Upstreams) -> dict:
    return gate_calls(up)[0]["p_plan"]["asked"]["prefilled"]


def test_round_one_logs_the_plan_the_phone_used():
    up = Upstreams()
    body = post(up, asked_order=["craving", "budget", "distance"], plan_source="plan").json()
    assert body["gate_logged"] is True
    assert asked(up) == {"status": "ok", "order": ["craving", "budget", "distance"],
                         "source": "plan", "matches_plan": True}
    plan = gate_calls(up)[0]["p_plan"]
    assert [q["key"] for q in plan["questions"]] == ["craving", "budget", "distance"]


def test_round_one_logs_a_fallback():
    up = Upstreams()
    post(up, asked_order=["craving", "budget", "distance"], plan_source="fallback")
    assert (asked(up)["status"], asked(up)["source"]) == ("ok", "fallback")


def test_round_one_logs_a_new_search_after_a_pick():
    up = Upstreams()
    body = post(up, craving="thai", asked_order=["craving", "budget", "distance"],
                plan_source="new_search").json()
    assert body["gate_logged"] is True
    assert asked(up) == {"status": "ok", "order": ["craving", "budget", "distance"],
                         "source": "new_search", "matches_plan": True}


def test_round_one_logs_a_mismatch_with_the_recomputed_plan():
    # E.g. the phone's plan came from an earlier meal slot.
    up = Upstreams()
    post(up, asked_order=["budget", "distance", "craving"], plan_source="plan")
    assert asked(up) == {"status": "ok", "order": ["budget", "distance", "craving"],
                         "source": "plan", "matches_plan": False}


@pytest.mark.parametrize(("order", "source", "kept_order", "kept_source"), [
    (["craving", "craving", "budget"], "plan", None, "plan"),
    (["craving", "budget", "company"], "plan", None, "plan"),
    (["craving", "budget"], "plan", None, "plan"),
    ([1, {"a": 2}, None], "plan", None, "plan"),
    (["craving", "budget", "distance"], "guess", ["craving", "budget", "distance"], None),
    (["craving", "budget", "distance"], "new-search", ["craving", "budget", "distance"], None),
    (["craving", "budget", "distance"], {"nested": [1, 2]}, ["craving", "budget", "distance"],
     None),
])
def test_round_one_invalid_order_is_logged_never_refused(order, source, kept_order, kept_source):
    up = Upstreams()
    response = post(up, asked_order=order, plan_source=source)
    assert response.status_code == 200
    body = response.json()
    assert body["logged"] is True and body["gate_logged"] is True
    log = asked(up)
    assert log["status"] == "invalid"
    assert (log["order"], log["source"]) == (kept_order, kept_source)  # bad values never logged
    assert log["matches_plan"] == (None if kept_order is None else True)


def test_round_one_without_asked_order_is_missing():
    up = Upstreams()
    post(up)
    assert asked(up)["status"] == "missing"


def test_later_rounds_ignore_the_asked_order():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, refine={"budget": "cheaper"}, asked_order=["craving", "budget", "distance"],
              plan_source="plan")
    assert gate_calls(up)[0]["p_plan"] is None


# "None of these" before a follow-up (P2-05) -----------------------------------


def test_none_of_these_is_the_first_rejected_reason():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, none_of_these=True, refine={"budget": "cheaper"})
    rows = rejected_rows(up)
    assert [r["place_id"] for r in rows] == ["node/1", "node/2", "node/3"]
    assert {r["reject_reason"] for r in rows} == {"refine:none_of_these,cheaper"}


def test_without_none_of_these_the_reason_is_unchanged():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, refine={"budget": "cheaper"})
    assert {r["reject_reason"] for r in rejected_rows(up)} == {"refine:cheaper"}


def test_none_of_these_on_the_cap_round_is_in_the_reason():
    up = Upstreams(shown=THREE_ROUNDS)
    body = follow_up(up, none_of_these=True, refine={"something_else": True}).json()
    assert body["best_so_far"] is True
    assert {r["reject_reason"] for r in rejected_rows(up)} == {
        "refine:none_of_these,something_else"}


def test_none_of_these_on_round_one_logs_no_rejections():
    up = Upstreams()
    body = post(up, none_of_these=True).json()
    assert body["round"] == 1 and body["logged"] is True
    assert rejected_rows(up) == []


def test_none_of_these_must_be_a_boolean():
    assert post(Upstreams(), none_of_these="maybe").status_code == 422



# Pre-fill trace (round 1): what the phone received and what it showed selected --------

TRACE = {"received": {"craving": "chinese", "budget": 1, "distance": None},
         "shown": {"craving": "chinese", "budget": 1, "distance": None}}


def test_round_one_logs_the_prefill_trace():
    up = Upstreams()
    post(up, asked_order=["distance", "craving", "budget"], plan_source="plan", prefilled=TRACE)
    assert prefilled(up) == {"status": "ok", **TRACE}


def test_a_received_prefill_that_was_not_shown_is_visible():
    # The case the trace exists for: the plan's $ arrived, but no budget chip was highlighted.
    trace = {"received": TRACE["received"],
             "shown": {"craving": None, "budget": None, "distance": None}}
    up = Upstreams()
    post(up, asked_order=["distance", "craving", "budget"], plan_source="plan", prefilled=trace)
    log = prefilled(up)
    assert log["received"]["budget"] == 1 and log["shown"]["budget"] is None


def test_round_one_without_a_trace_is_missing():
    up = Upstreams()
    post(up, asked_order=["craving", "budget", "distance"], plan_source="plan")
    assert prefilled(up) == {"status": "missing", "received": None, "shown": None}


@pytest.mark.parametrize("trace", [
    {"received": TRACE["received"]},  # no shown
    {**TRACE, "extra": {}},  # unknown set
    {**TRACE, "shown": {"craving": "Chinese", "budget": 1, "distance": None}},  # label, not id
    {**TRACE, "shown": {"craving": "chinese", "budget": "1", "distance": None}},  # string level
    {**TRACE, "shown": {"craving": "chinese", "budget": 5, "distance": None}},  # no such chip
    {**TRACE, "shown": {"craving": "chinese", "budget": True, "distance": None}},  # a bool
    {**TRACE, "shown": {"craving": "chinese", "budget": 1, "distance": 5000}},  # old radius
    {**TRACE, "shown": {"craving": "chinese", "budget": 1}},  # a key missing
    "not an object",
    [1, 2],
])
def test_an_invalid_trace_is_logged_as_invalid_never_refused(trace):
    up = Upstreams()
    response = post(up, asked_order=["craving", "budget", "distance"], plan_source="plan",
                    prefilled=trace)
    assert response.status_code == 200 and response.json()["gate_logged"] is True
    assert prefilled(up) == {"status": "invalid", "received": None, "shown": None}
    assert asked(up)["status"] == "ok"  # the order check is independent


def test_later_rounds_ignore_the_trace():
    up = Upstreams(shown=ROUND_1)
    follow_up(up, refine={"budget": "cheaper"}, prefilled=TRACE)
    assert gate_calls(up)[0]["p_plan"] is None
