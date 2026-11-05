"""Local calendar, explicit companion evidence and operational limits. Synthetic only."""

import asyncio
import json
import logging
from datetime import date
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import conversation as c
from app import main, meal_dates, muse
from app.auth import current_user
from app.config import Settings, get_settings

TODAY = date(2026, 11, 4)


@pytest.fixture(autouse=True)
def synthetic(monkeypatch):
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setenv("META_API_KEY", "synthetic-meta")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    get_settings.cache_clear()
    main.app.dependency_overrides[current_user] = lambda: str(UUID(int=90))
    yield
    main.app.dependency_overrides.clear()
    get_settings.cache_clear()


def parse(monkeypatch, text, intent=None, **kwargs):
    calls = []
    raw = {"type": "log_meal", "category": "chinese", "date": None, **(intent or {})}

    async def model(body, **_kwargs):
        calls.append(body)
        return muse.Reply(json.dumps({"intents": [raw], "patch": {}}), "stop", None)

    monkeypatch.setattr(muse, "call", model)
    result = asyncio.run(c.parse(text, None, ["companion_1"], client=None, today=TODAY, **kwargs))
    assert len(calls) == 1
    return result, calls[0]


@pytest.mark.parametrize("text,expected", [
    ("I had Chinese yesterday for dinner last night", "2026-11-03"),
    ("I had Chinese today", "2026-11-04"),
    ("I had Chinese last Tuesday", "2026-11-03"),
    ("I had Chinese last Wednesday", "2026-10-28"),
    ("I had Chinese on 2026-11-01", "2026-11-01"),
])
def test_omitted_muse_date_recovers_only_recognizable_explicit_dates(monkeypatch, text, expected):
    result, body = parse(monkeypatch, text)
    assert result["intents"][0]["date"] == {"kind": "iso", "value": expected}
    assert json.loads(body["messages"][1]["content"])["local_date"] == "2026-11-04"


def test_yesterday_uses_local_calendar_across_month_and_year_boundaries():
    assert meal_dates.resolve("yesterday", None, date(2026, 11, 4)) == date(2026, 11, 3)
    assert meal_dates.resolve("yesterday", None, date(2026, 3, 1)) == date(2026, 2, 28)
    assert meal_dates.resolve("yesterday", None, date(2026, 1, 1)) == date(2025, 12, 31)


@pytest.mark.parametrize("text,intent", [
    ("I ate Chinese tomorrow", {"date": {"kind": "iso", "value": "2026-11-05"}}),
    ("I ate Chinese on 2026-02-30", {}),
    ("I ate Chinese Tuesday", {"date": {"kind": "iso", "value": "2026-11-03"}}),
    ("I ate Chinese yesterday and today", {}),
    ("I ate Chinese yesterday or today", {"date": {"kind": "yesterday"}}),
    ("I did not eat yesterday", {"date": {"kind": "yesterday"}}),
])
def test_future_invalid_and_ambiguous_dates_are_never_saved_as_a_guess(monkeypatch, text, intent):
    result, _ = parse(monkeypatch, text, intent)
    assert result["intents"][0]["date"] is None
    assert "meal_date" in result["invalid_fields"]


def test_explicit_source_date_cannot_be_replaced_by_an_inconsistent_model_token(monkeypatch):
    result, _ = parse(monkeypatch, "I had Chinese yesterday", {"date": {"kind": "today"}})
    assert result["intents"][0]["date"] == {"kind": "iso", "value": "2026-11-03"}


def test_feedback_dates_use_the_same_calendar_and_ambiguity_never_selects_the_last_meal(
    monkeypatch,
):
    result, _ = parse(monkeypatch, "Rate my Chinese meal last Tuesday", {
        "type": "rate_meal", "reference": "date", "stars": 4})
    assert result["intents"][0]["date"] == {"kind": "iso", "value": "2026-11-03"}
    result, _ = parse(monkeypatch, "Rate my Chinese meal Tuesday", {
        "type": "rate_meal", "reference": "last", "date": {"kind": "weekday", "value": "tuesday"}})
    assert result["intents"][0]["reference"] == "date"
    assert result["intents"][0]["date"] is None


def test_pending_followup_cannot_inject_date_or_company_from_recommendation_context(monkeypatch):
    result, _ = parse(monkeypatch, "It was dinner", {
        "date": {"kind": "yesterday"}, "company": ["companion_1"], "solo": False,
    }, pending_meal=True, recent_context=[
        c.ContextLine(role="assistant", content="Company updated.")])
    meal = result["intents"][0]
    assert meal["date"] is None and meal["company"] == [] and meal["solo"] is None
    assert "meal_company" in result["invalid_fields"]


def test_explicit_meal_companions_and_solo_remain_supported(monkeypatch):
    result, _ = parse(monkeypatch, "I ate Chinese with companion_1 yesterday", {
        "company": ["companion_1"], "solo": False})
    assert result["intents"][0]["company"] == ["companion_1"]
    result, _ = parse(monkeypatch, "I ate Chinese alone yesterday", {"solo": True})
    assert result["intents"][0]["solo"] is True


@pytest.mark.parametrize("text", ["I ate without companion_1 yesterday",
                                  "I ate yesterday, companion_1 wasn't there"])
def test_negated_attendance_is_never_a_confirmed_meal_companion(monkeypatch, text):
    result, _ = parse(monkeypatch, text, {"company": ["companion_1"], "solo": False})
    assert result["intents"][0]["company"] == []


def test_parse_route_resolves_against_the_users_timezone_instead_of_the_utc_date(monkeypatch):
    async def model(*args, **kwargs):
        return muse.Reply(json.dumps({"intents": [{"type": "log_meal", "category": "chinese"}],
                                      "patch": {}}), "stop", None)

    monkeypatch.setattr(muse, "call", model)
    response = TestClient(main.app).post("/conversation/parse", json={
        "text": "I had Chinese yesterday", "local_time": "2026-11-05T02:30:00Z",
        "timezone": "America/New_York"})
    assert response.status_code == 200
    assert response.json()["intents"][0]["date"]["value"] == "2026-11-03"
    assert TestClient(main.app).post("/conversation/parse", json={
        "text": "yesterday", "local_time": "2026-11-04T12:00:00"}).status_code == 422


def test_companion_endpoint_deadline_includes_auth_without_starting_a_muse_call(monkeypatch):
    async def stalled_auth():
        await asyncio.Event().wait()

    main.app.dependency_overrides[current_user] = stalled_auth
    monkeypatch.setattr(main, "COMPANION_PARSE_DEADLINE_S", .01)
    response = TestClient(main.app).post("/conversation/parse", json={"text": "PRIVATE"})
    assert response.status_code == 200 and response.json()["status"] == "timeout"
    assert muse.daily_cap.count == 0


def test_upper_bounds_and_configured_lower_parse_allowances_do_not_affect_reasons(monkeypatch):
    settings = Settings(_env_file=None)
    assert settings.MUSE_PARSE_MAX_TOKENS == 1400 and settings.MUSE_PARSE_TIMEOUT_S == 14
    assert settings.MUSE_PARSE_DEADLINE_S == 17 and settings.MUSE_TIMEOUT_S == 12
    for change in ({"MUSE_PARSE_TIMEOUT_S": 15}, {"MUSE_PARSE_MAX_TOKENS": 1401},
                   {"MUSE_PARSE_DEADLINE_S": 18}):
        with pytest.raises(ValueError):
            Settings(_env_file=None, **change)
    monkeypatch.setenv("MUSE_PARSE_MAX_TOKENS", "1100")
    monkeypatch.setenv("MUSE_PARSE_TIMEOUT_S", "6")
    get_settings.cache_clear()
    _, body = parse(monkeypatch, "I ate Chinese yesterday")
    assert body["max_completion_tokens"] == 1100


@pytest.mark.parametrize("status,code,expected", [
    (429, None, "RateLimit"), (429, "insufficient_quota", "QuotaExhausted"),
    (402, None, "QuotaExhausted"), (504, None, "ProviderTimeout"),
    (503, None, "HTTPStatus"),
])
def test_provider_failure_classes_are_content_free_and_never_retry(status, code, expected, caplog):
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx2.Response(status, json={"error": {"code": code, "message": "PRIVATE_PAYLOAD"}})

    async def run():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            return await muse.call({"max_completion_tokens": 1400}, client=client,
                                   call_type="parse")

    caplog.set_level(logging.INFO)
    assert asyncio.run(run()) is None
    # ContextVars are local to asyncio.run; use the operational row as the public proof.
    rows = [json.loads(r.message.split("Muse call: ")[1]) for r in caplog.records
            if r.message.startswith("Muse call: ")]
    assert len(requests) == 1 and len(rows) == 1
    assert rows[0]["failure_class"] == expected and rows[0]["effective_timeout_s"] == 14
    assert "PRIVATE_PAYLOAD" not in caplog.text and "synthetic-meta" not in caplog.text


def test_parse_timeout_and_reasoning_usage_are_reported_without_response_content(caplog):
    calls = []

    def upstream(request):
        calls.append(request)
        raise httpx2.ReadTimeout("PRIVATE_URL")

    async def run():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            return await c.parse("PRIVATE_MESSAGE", None, [], client=client)

    caplog.set_level(logging.INFO)
    result = asyncio.run(run())
    assert result["status"] == "timeout" and len(calls) == 1
    assert calls[0].extensions["timeout"]["read"] == 14
    assert "PRIVATE_MESSAGE" not in caplog.text and "PRIVATE_URL" not in caplog.text
