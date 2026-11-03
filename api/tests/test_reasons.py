"""Signed enhancement boundary. Synthetic evidence and mocked upstreams only."""

import asyncio
import json
import logging
from types import SimpleNamespace

import httpx2
import pytest
from test_muse import PICKS, category_picks, rated_picks, reply
from test_recommendations import (
    SESSION_ID,
    TOKEN,
    USER_ID,
    Upstreams,
    env,  # noqa: F401
    post,
    use,
    writes,
)

from app import main, reasons
from app.auth import current_auth
from app.config import get_settings


@pytest.fixture(autouse=True)
def signing(monkeypatch, env):  # noqa: F811
    monkeypatch.setenv("REASONS_SIGNING_SECRET", "synthetic-signing-key")
    monkeypatch.setenv("MUSE_TIMEOUT_S", "12")
    monkeypatch.setenv("MUSE_PARSE_TIMEOUT_S", "10")
    monkeypatch.setattr(reasons, "rate_limit", reasons.UserRateLimit())
    get_settings.cache_clear()


def signed(picks=PICKS):
    return reasons.envelope(USER_ID, SESSION_ID, 1, picks)


def enhance(up, body=None):
    return use(up).post("/reasons", json=signed() if body is None else body)


def test_round_templates_signed_evidence_and_zero_muse_calls():
    up = Upstreams()
    result = post(up).json()
    assert result["reasons_source"] == "template"
    assert "api.meta.ai" not in up.hosts()
    evidence = reasons.verify(reasons.Envelope(**result["reasons_envelope"]), USER_ID)
    assert evidence["session_id"] == result["session_id"]
    assert evidence["round"] == result["round"]
    assert [p["id"] for p in evidence["picks"]] == [p["id"] for p in result["picks"]]
    assert all("name" not in p and "address" not in p and "lat" not in p
               and "lon" not in p for p in evidence["picks"])
    events = json.loads(writes(up, "recommendation_events")[0].content)
    assert [e["pick_reason"] for e in events] == [p["reason"] for p in result["picks"]]
    assert all(e["reasons_source"] == "template" for e in events)


def test_missing_secret_keeps_round_available(monkeypatch):
    monkeypatch.setenv("REASONS_SIGNING_SECRET", "")
    get_settings.cache_clear()
    up = Upstreams()
    result = post(up)
    assert result.status_code == 200
    assert result.json()["reasons_envelope"] is None
    assert len(result.json()["picks"]) == 3 and "api.meta.ai" not in up.hosts()


@pytest.mark.parametrize("field,value", [
    ("session_id", "22222222-2222-2222-2222-222222222222"), ("round", 2),
    ("expires_at", 9999999999), ("version", 2), ("picks", []),
])
def test_tampering_is_400_before_any_upstream(field, value):
    body = signed()
    payload = json.loads(body["payload"])
    payload[field] = value
    body["payload"] = json.dumps(payload)
    up = Upstreams()
    assert enhance(up, body).status_code == 400
    assert up.requests == []


@pytest.mark.parametrize("signature", ["0" * 64, "bad", "", "f" * 65])
def test_bad_signature_never_calls_muse(signature):
    body = {**signed(), "signature": signature}
    up = Upstreams()
    assert enhance(up, body).status_code == 400
    assert up.requests == []


def test_expiry_is_two_minutes_and_boundary_is_rejected(monkeypatch):
    clock = [1000]
    monkeypatch.setattr(reasons, "time", SimpleNamespace(time=lambda: clock[0]))
    body = signed()
    assert json.loads(body["payload"])["expires_at"] == 1120
    clock[0] = 1120
    up = Upstreams()
    assert enhance(up, body).status_code == 400
    assert up.requests == []


def test_signature_is_bound_to_authenticated_user():
    up = Upstreams()
    client = use(up)
    main.app.dependency_overrides[current_auth] = lambda: ("other-user", TOKEN)
    assert client.post("/reasons", json=signed()).status_code == 400
    assert up.requests == []


def test_wrong_users_session_is_404_with_no_muse():
    up = Upstreams(session_found=False)
    assert enhance(up).status_code == 404
    assert "api.meta.ai" not in up.hosts()
    request, = up.requests
    assert request.url.params["user_id"] == f"eq.{USER_ID}"
    assert request.url.params["id"] == f"eq.{SESSION_ID}"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.url.params["select"] == "id"


def test_twenty_per_hour_then_429_without_muse(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(reasons, "time", SimpleNamespace(
        time=lambda: 1000, monotonic=lambda: clock[0]))
    up = Upstreams()
    body = signed()
    for _ in range(20):
        assert enhance(up, body).status_code == 200
    assert up.hosts().count("api.meta.ai") == 20
    before = len(up.requests)
    assert enhance(up, body).status_code == 429
    assert len(up.requests) == before
    assert reasons.rate_limit.take("another-user")
    clock[0] += 3600
    assert enhance(up, body).status_code == 200
    assert up.hosts().count("api.meta.ai") == 21


def test_one_call_reorders_to_signed_ids_and_never_writes(caplog):
    caplog.set_level(logging.INFO)
    up = Upstreams()
    result = enhance(up).json()
    ids = [p.scored.place.id for p in PICKS]
    assert result == {"source": "muse", "reasons": [
        {"id": i, "line": f"Reason for {i}."} for i in ids]}
    assert up.hosts().count("api.meta.ai") == 1
    assert len(up.requests) == 2
    assert up.requests[0].method == "GET"
    meta = up.requests[1]
    assert meta.extensions["timeout"]["read"] == 12
    request = json.loads(meta.content)
    assert request["model"] == "muse-spark-1.3"
    assert request["reasoning_effort"] == "minimal"
    assert request["response_format"]["json_schema"]["strict"] is True
    assert '"call_type":"reasons"' in caplog.text
    assert '"validation_outcome":"accepted"' in caplog.text
    assert "Reason for" not in caplog.text and "synthetic-signing-key" not in caplog.text


@pytest.mark.parametrize("lines", [
    {"wrong": "Fine."},
    {"node/1": "Fine."},
    {"node/1": "Healthy choice.", "node/2": "Fine.", "node/3": "Fine."},
    {"node/1": "Your usual spot.", "node/2": "Fine.", "node/3": "Fine."},
    {"node/1": "Rated 5 stars.", "node/2": "Fine.", "node/3": "Fine."},
    {"node/1": "x" * 91, "node/2": "Fine.", "node/3": "Fine."},
])
def test_rejected_output_keeps_templates(lines):
    up = Upstreams(muse_lines=lines)
    assert enhance(up).json() == reasons.EMPTY
    assert up.hosts().count("api.meta.ai") == 1


def test_duplicate_ids_are_rejected():
    class Duplicate(Upstreams):
        def muse_reply(self, request):
            return reply(content=json.dumps({"reasons": [
                {"id": "node/1", "line": "Fine."}] * 3}))

    assert enhance(Duplicate()).json() == reasons.EMPTY


def test_food_counts_never_become_place_visits():
    up = Upstreams()
    assert enhance(up, signed(category_picks())).json()["source"] == "muse"
    sent = json.loads(json.loads(up.requests[-1].content)["messages"][1]["content"])
    by_id = {p["id"]: p for p in sent["picks"]}
    assert by_id["node/1"]["times_had_category"] == 2
    assert by_id["node/1"]["visits"] == 0 and not by_id["node/1"]["visited_before"]
    assert "usual_category" in by_id["node/1"]["signals"]
    assert "favorite_category" in by_id["node/2"]["signals"]
    assert by_id["node/2"]["times_had_category"] == 0
    assert all("familiar" not in p["signals"] and "discovery" not in p["signals"]
               and "slot" not in p for p in by_id.values())


@pytest.mark.parametrize("rating,source", [("4.5", "muse"), ("5", "template")])
def test_ratings_match_signed_evidence(rating, source):
    up = Upstreams(muse_lines={"node/1": f"You rated it {rating} stars.",
                               "node/2": "Fine.", "node/3": "Fine."})
    assert enhance(up, signed(rated_picks())).json()["source"] == source
    evidence = json.loads(json.loads(up.requests[-1].content)["messages"][1]["content"])
    by_id = {p["id"]: p for p in evidence["picks"]}
    assert by_id["node/1"]["stars_mean"] == 4.5
    assert "stars_mean" not in by_id["node/2"]


def test_upstream_failure_never_retries():
    up = Upstreams(muse_status=500)
    assert enhance(up).json() == reasons.EMPTY
    assert up.hosts().count("api.meta.ai") == 1


def test_endpoint_deadline_cancels_muse_and_emits_telemetry(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(main, "REASONS_DEADLINE_S", 0.05)
    cancelled = []

    class SlowMuse(Upstreams):
        async def __call__(self, request):
            if request.url.host == "api.meta.ai":
                self.requests.append(request)
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    cancelled.append(True)
                    raise
            return await super().__call__(request)

    up = SlowMuse()
    assert enhance(up).json() == reasons.EMPTY
    assert cancelled == [True] and up.hosts().count("api.meta.ai") == 1
    assert '"failure_class":"Cancelled"' in caplog.text


def test_parse_uses_ten_seconds_and_one_thousand_tokens():
    class Parsing(Upstreams):
        def muse_reply(self, request):
            return reply(content=json.dumps({"understood": True, "craving": "thai",
                "exclude": [], "budget": "1", "distance": "close",
                "something_else": False, "intent": "answer", "reply": ""}))

    up = Parsing()
    result = use(up).post("/answers/parse", json={"question_key": "craving", "text": "thai"})
    assert result.json()["status"] == "ok"
    answer = result.json()["answer"]
    assert answer["craving"] == "thai" and answer["budget"] == 1
    assert answer["distance"] == 15000
    request, = up.requests
    assert request.extensions["timeout"]["read"] == 10
    assert json.loads(request.content)["max_completion_tokens"] == 1000
    assert main.PARSE_DEADLINE_S == 13 and main.REASONS_DEADLINE_S == 15


@pytest.mark.parametrize("path,deadline,expected", [
    ("/reasons", "REASONS_DEADLINE_S", reasons.EMPTY),
    ("/answers/parse", "PARSE_DEADLINE_S", main.NOT_SURE),
])
def test_endpoint_deadline_includes_auth(path, deadline, expected, monkeypatch):
    async def stalled_auth():
        await asyncio.sleep(10)

    monkeypatch.setattr(main, deadline, 0.01)
    up = Upstreams()
    client = use(up)
    main.app.dependency_overrides[current_auth] = stalled_auth
    body = signed() if path == "/reasons" else {"question_key": "craving", "text": "thai"}
    result = client.post(path, json=body)
    assert result.status_code == 200 and result.json() == expected
    assert up.requests == []


def test_parse_muse_timeout_returns_not_sure(monkeypatch):
    monkeypatch.setenv("MUSE_PARSE_TIMEOUT_S", "0.01")
    get_settings.cache_clear()

    class SlowMuse(Upstreams):
        async def __call__(self, request):
            self.requests.append(request)
            await asyncio.sleep(10)
            return httpx2.Response(200, json={})

    up = SlowMuse()
    result = use(up).post("/answers/parse", json={"question_key": "craving", "text": "thai"})
    assert result.status_code == 200 and result.json() == main.NOT_SURE
    assert up.hosts() == ["api.meta.ai"]
