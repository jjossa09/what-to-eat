import json
import logging

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.auth import current_auth
from app.config import get_settings
from app.main import app, get_http_client
from app.places import distance_m

USER_ID = "00000000-0000-0000-0000-000000000001"
TOKEN = "user.jwt.token"
ANON_KEY = "test-anon-key"
SERVICE_KEY = "test-service-role-key"
SUPABASE_HOST = "test-project.supabase.co"
SESSION_ID = "11111111-1111-1111-1111-111111111111"
PLACE_ID = "node/1"
SESSION = {"lat": 33.95, "lon": -84.55, "local_date": "2026-10-29", "meal_slot": "dinner",
           "budget_level": 2, "solo": None, "outcome": None}
PLACE = {"category_id": "thai", "lat": 33.953, "lon": -84.55}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", f"https://{SUPABASE_HOST}")
    monkeypatch.setenv("SUPABASE_ANON_KEY", ANON_KEY)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    app.dependency_overrides.clear()


class Supabase:
    """PostgREST mock for the event endpoints. Records each request."""

    def __init__(self, shown=True, outcome=None, claim=True, session_exists=True, fail=(),
                 exc=None):
        self.shown, self.outcome, self.claim = shown, outcome, claim
        self.session_exists, self.fail, self.exc = session_exists, set(fail), exc
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        assert request.url.host == SUPABASE_HOST
        if self.exc:
            raise self.exc
        table = request.url.path.rsplit("/", 1)[-1]
        key = f"{request.method} {table}"
        if key in self.fail:
            return httpx2.Response(500, json={"message": "secret upstream detail"})
        if key == "GET recommendation_events":
            if not self.shown:
                return httpx2.Response(200, json=[])
            return httpx2.Response(200, json=[{
                "place_id": PLACE_ID, "places": PLACE,
                "sessions": {**SESSION, "outcome": self.outcome}}])
        if key == "PATCH sessions":
            return httpx2.Response(200, json=[{"id": SESSION_ID}] if self.claim else [])
        if key == "GET sessions":
            return httpx2.Response(200, json=[{"id": SESSION_ID}] if self.session_exists else [])
        if key in ("POST recommendation_events", "POST meals"):
            return httpx2.Response(201)
        raise AssertionError(f"unexpected call {key}")

    def calls(self, method: str, table: str) -> list[httpx2.Request]:
        return [r for r in self.requests
                if r.method == method and r.url.path == f"/rest/v1/{table}"]


def client(upstream: Supabase, authed=True) -> TestClient:
    async def http():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as c:
            yield c

    app.dependency_overrides[get_http_client] = http
    if authed:
        app.dependency_overrides[current_auth] = lambda: (USER_ID, TOKEN)
    return TestClient(app)


def send(upstream: Supabase, event: str, body: dict | None = None, authed=True,
         session_id=SESSION_ID):
    return client(upstream, authed).post(f"/sessions/{session_id}/{event}", json=body)


def assert_as_user(upstream: Supabase):
    """Every call is made as the user (RLS applies), never with the service role."""
    assert upstream.requests
    for r in upstream.requests:
        assert r.headers["authorization"] == f"Bearer {TOKEN}"
        assert r.headers["apikey"] == ANON_KEY


def assert_shown_lookup(upstream: Supabase, round_=1):
    (read,) = upstream.calls("GET", "recommendation_events")
    params = read.url.params
    assert params["user_id"] == f"eq.{USER_ID}"
    assert params["session_id"] == f"eq.{SESSION_ID}"
    assert params["round"] == f"eq.{round_}"
    assert params["place_id"] == f"eq.{PLACE_ID}"
    assert params["event"] == "eq.shown"


# Interested and rejected


@pytest.mark.parametrize("kind", ["card", "directions"])
def test_interested(kind):
    up = Supabase()
    response = send(up, "interested", {"round": 2, "place_id": PLACE_ID, "kind": kind})
    assert response.status_code == 200
    assert response.json() == {"logged": True}
    assert_shown_lookup(up, round_=2)
    (insert,) = up.calls("POST", "recommendation_events")
    assert json.loads(insert.content) == {
        "user_id": USER_ID, "session_id": SESSION_ID, "round": 2, "place_id": PLACE_ID,
        "event": "interested", "interest_kind": kind}
    assert_as_user(up)


def test_rejected_with_reason():
    up = Supabase()
    response = send(up, "rejected", {"round": 1, "place_id": PLACE_ID, "reason": "  Too far "})
    assert response.status_code == 200
    (insert,) = up.calls("POST", "recommendation_events")
    row = json.loads(insert.content)
    assert (row["event"], row["reject_reason"], row["user_id"]) == ("rejected", "Too far",
                                                                     USER_ID)
    assert_as_user(up)


@pytest.mark.parametrize("event, extra", [("interested", {"kind": "card"}),
                                          ("rejected", {"reason": "Closed"}),
                                          ("picked", {})])
def test_place_not_shown_is_404(event, extra):
    # Not shown in this session and round, or not the user's (RLS returns no row).
    up = Supabase(shown=False)
    response = send(up, event, {"round": 1, "place_id": PLACE_ID, **extra})
    assert response.status_code == 404
    assert up.calls("POST", "recommendation_events") == []
    assert up.calls("POST", "meals") == []


@pytest.mark.parametrize("event, body", [
    ("interested", {"round": 1, "place_id": PLACE_ID, "kind": "map"}),
    ("interested", {"round": 0, "place_id": PLACE_ID, "kind": "card"}),
    ("rejected", {"round": 1, "place_id": PLACE_ID, "reason": "   "}),
    ("rejected", {"round": 1, "place_id": PLACE_ID, "reason": "x" * 201}),
    ("rejected", {"round": 1, "place_id": PLACE_ID}),
    ("picked", {"round": 1, "place_id": ""}),
])
def test_bad_event_body(event, body):
    up = Supabase()
    assert send(up, event, body).status_code == 422
    assert up.requests == []


def test_bad_session_id():
    up = Supabase()
    response = send(up, "none", session_id="not-a-uuid")
    assert response.status_code == 422
    assert up.requests == []


# Picked


def test_picked_logs_event_meal_and_outcome():
    up = Supabase()
    response = send(up, "picked", {"round": 1, "place_id": PLACE_ID})
    assert response.status_code == 200
    assert_shown_lookup(up)

    (claim,) = up.calls("PATCH", "sessions")
    assert claim.url.params["id"] == f"eq.{SESSION_ID}"
    assert claim.url.params["user_id"] == f"eq.{USER_ID}"
    assert claim.url.params["outcome"] == "is.null"
    patch = json.loads(claim.content)
    assert patch["outcome"] == "picked" and patch["ended_at"]

    (event,) = up.calls("POST", "recommendation_events")
    assert json.loads(event.content) == {
        "user_id": USER_ID, "session_id": SESSION_ID, "round": 1, "place_id": PLACE_ID,
        "event": "picked"}

    (meal,) = up.calls("POST", "meals")
    row = json.loads(meal.content)
    assert row["picked_at"]
    del row["picked_at"]
    assert row == {
        "user_id": USER_ID, "source": "live", "session_id": SESSION_ID, "place_id": PLACE_ID,
        "category_id": "thai", "eaten_on": "2026-10-29", "meal_slot": "dinner", "solo": None,
        "budget_level": 2,
        "distance_m": distance_m(SESSION["lat"], SESSION["lon"], PLACE["lat"], PLACE["lon"])}

    paths = [(r.method, r.url.path) for r in up.requests]
    assert paths.index(("PATCH", "/rest/v1/sessions")) < paths.index(("POST", "/rest/v1/meals"))
    assert_as_user(up)


def test_picked_when_outcome_already_set_is_409():
    up = Supabase(outcome="none")
    assert send(up, "picked", {"round": 1, "place_id": PLACE_ID}).status_code == 409
    assert up.calls("PATCH", "sessions") == []
    assert up.calls("POST", "meals") == []


def test_picked_race_loses_the_claim_is_409():
    up = Supabase(claim=False)
    assert send(up, "picked", {"round": 1, "place_id": PLACE_ID}).status_code == 409
    assert up.calls("POST", "meals") == []
    assert up.calls("POST", "recommendation_events") == []


def test_meal_unique_conflict_is_409():
    class Taken(Supabase):
        def __call__(self, request):
            if request.method == "POST" and request.url.path.endswith("/meals"):
                self.requests.append(request)
                return httpx2.Response(409, json={"message": "duplicate key"})
            return super().__call__(request)

    assert send(Taken(), "picked", {"round": 1, "place_id": PLACE_ID}).status_code == 409


# None


def test_none_sets_outcome():
    up = Supabase()
    response = send(up, "none")
    assert response.status_code == 200
    (claim,) = up.calls("PATCH", "sessions")
    assert claim.url.params["user_id"] == f"eq.{USER_ID}"
    assert claim.url.params["outcome"] == "is.null"
    patch = json.loads(claim.content)
    assert patch["outcome"] == "none" and patch["ended_at"]
    assert up.calls("POST", "recommendation_events") == []
    assert_as_user(up)


def test_none_when_outcome_already_set_is_409():
    up = Supabase(claim=False, session_exists=True)
    assert send(up, "none").status_code == 409


def test_none_on_someone_elses_session_is_404():
    up = Supabase(claim=False, session_exists=False)
    assert send(up, "none").status_code == 404
    (read,) = up.calls("GET", "sessions")
    assert read.url.params["user_id"] == f"eq.{USER_ID}"


# Auth and failures


@pytest.mark.parametrize("event, body", [
    ("interested", {"round": 1, "place_id": PLACE_ID, "kind": "card"}),
    ("rejected", {"round": 1, "place_id": PLACE_ID, "reason": "Closed"}),
    ("picked", {"round": 1, "place_id": PLACE_ID}),
    ("none", None),
])
def test_requires_auth(event, body):
    up = Supabase()
    assert send(up, event, body, authed=False).status_code == 401
    assert up.requests == []


@pytest.mark.parametrize("kw", [{"fail": ["POST recommendation_events"]},
                                {"fail": ["GET recommendation_events"]},
                                {"exc": httpx2.ConnectError("down")},
                                {"exc": httpx2.ReadTimeout("slow")}])
def test_upstream_failure_is_502_without_detail(kw, caplog):
    caplog.set_level(logging.DEBUG)
    response = send(Supabase(**kw), "rejected",
                    {"round": 1, "place_id": PLACE_ID, "reason": "Closed"})
    assert response.status_code == 502
    assert response.json() == {"detail": "Logging failed"}
    assert "secret upstream detail" not in caplog.text
    assert TOKEN not in caplog.text


def test_not_configured_is_503(monkeypatch):
    monkeypatch.setenv("SUPABASE_ANON_KEY", "")
    get_settings.cache_clear()
    up = Supabase()
    assert send(up, "none").status_code == 503
    assert up.requests == []


def test_service_role_key_is_read_in_one_function_only():
    import ast
    from pathlib import Path

    app_dir = Path(__file__).resolve().parent.parent / "app"
    users = []
    for path in sorted(app_dir.glob("*.py")):
        tree = ast.parse(path.read_text())
        for fn in ast.walk(tree):
            if isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef) and any(
                isinstance(n, ast.Constant) and n.value == "SUPABASE_SERVICE_ROLE_KEY"
                for n in ast.walk(fn)
            ):
                users.append(f"{path.name}:{fn.name}")
    assert users == ["funnel.py:upsert_places"]
