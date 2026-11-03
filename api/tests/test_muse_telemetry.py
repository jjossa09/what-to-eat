"""Content-free operational telemetry and defensive usage parsing, synthetic only."""

import asyncio
import json
import logging

import httpx2
import pytest
from test_muse import PICKS, Meta, muse_env, reply, run  # noqa: F401

from app import answers, muse
from app.config import get_settings


def telemetry(caplog):
    return [json.loads(r.message.removeprefix("Muse call: ")) for r in caplog.records
            if r.message.startswith("Muse call: ")]


@pytest.mark.parametrize("usage", [None, [], "PRIVATE", {},
    {"prompt_tokens": "PRIVATE", "completion_tokens": 60},
    {"prompt_tokens": True, "completion_tokens": 60},
    {"prompt_tokens": -1, "completion_tokens": 60},
    {"prompt_tokens": 500, "completion_tokens": 1.5},
    {"prompt_tokens": 500, "completion_tokens": 60, "completion_tokens_details": []},
    {"prompt_tokens": 500, "completion_tokens": 60,
     "completion_tokens_details": {"reasoning_tokens": "PRIVATE"}},
])
def test_malformed_usage_never_fails_a_valid_reason(usage, caplog):
    caplog.set_level(logging.INFO)
    body = reply()
    body["usage"] = usage
    result = run(Meta(body))
    assert result.source == "muse" and result.usage is None
    row, = telemetry(caplog)
    assert row["validation_outcome"] == "accepted"
    assert row["prompt_tokens"] is row["completion_tokens"] is row["reasoning_tokens"] is None
    assert "PRIVATE" not in caplog.text


def test_missing_reasoning_usage_is_null_and_valid_counts_survive():
    assert muse.parse_usage({"usage": {"prompt_tokens": 5, "completion_tokens": 2}}) == (
        muse.Usage(5, 2, None))


@pytest.mark.parametrize("meta,failure,status", [
    (Meta(exc=httpx2.ReadTimeout("PRIVATE")), "ReadTimeout", None),
    (Meta(exc=httpx2.ConnectError("PRIVATE")), "HTTPError", None),
    (Meta(status=503), "HTTPStatus", 503),
    (Meta(body=[]), "UnreadableBody", 200),
])
def test_every_failed_call_emits_one_content_free_row(meta, failure, status, caplog):
    caplog.set_level(logging.INFO)
    assert run(meta).source == "template"
    row, = telemetry(caplog)
    assert row["failure_class"] == failure and row["status"] == status
    assert row["validation_outcome"] == "not_run" and row["call_type"] == "reasons"
    assert row["token_cap"] == 1500 and row["effective_timeout_s"] == 3.5
    assert row["elapsed_ms"] >= 0
    assert set(row) == {"call_type", "correlation_id", "model", "effort", "token_cap",
                        "effective_timeout_s", "elapsed_ms", "status", "failure_class",
                        "finish_reason", "validation_outcome", "prompt_tokens",
                        "completion_tokens", "reasoning_tokens"}
    assert "PRIVATE" not in caplog.text


def test_rejected_output_has_usage_and_validation_without_content(caplog):
    caplog.set_level(logging.INFO)
    assert run(Meta(reply(content="PRIVATE RESPONSE"))).source == "template"
    row, = telemetry(caplog)
    assert row["validation_outcome"] == "rejected:json" and row["finish_reason"] == "stop"
    assert row["prompt_tokens"] == 500 and row["completion_tokens"] == 60
    assert "PRIVATE RESPONSE" not in caplog.text


def test_answer_parsing_has_its_own_five_seconds_and_token_cap(monkeypatch, caplog):
    monkeypatch.setenv("MUSE_PARSE_TIMEOUT_S", "5")
    get_settings.cache_clear()
    caplog.set_level(logging.INFO)
    meta = Meta(reply(content=json.dumps({"kind": "not_sure"})))

    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as client:
            return await answers.parse("craving", "PRIVATE INPUT", client=client)

    asyncio.run(go())
    row, = telemetry(caplog)
    assert row["call_type"] == "parse" and row["token_cap"] == 600
    assert row["effective_timeout_s"] == 5
    assert meta.requests[0].extensions["timeout"]["read"] == 5
    assert "PRIVATE INPUT" not in caplog.text


@pytest.mark.parametrize("remaining,expected", [(3.1, 3.1), (7.5, 5)])
def test_reasons_use_remaining_round_time_capped_at_five(monkeypatch, remaining, expected):
    monkeypatch.setenv("MUSE_TIMEOUT_S", "5")
    get_settings.cache_clear()
    meta = Meta()

    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as client:
            return await muse.write_reasons(PICKS, client=client, timeout_s=remaining)

    assert asyncio.run(go()).source == "muse"
    assert meta.requests[0].extensions["timeout"]["read"] == expected


def test_expired_round_does_not_call_muse_or_consume_cap():
    meta = Meta()

    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as client:
            return await muse.write_reasons(PICKS, client=client, timeout_s=0)

    assert asyncio.run(go()).source == "template"
    assert meta.requests == [] and muse.daily_cap.count == 0


def test_telemetry_sink_failure_does_not_fail_reasons(monkeypatch):
    original = muse.logger.info

    def log(message, *args, **kwargs):
        if message == "Muse call: %s":
            raise OSError("synthetic sink failure")
        original(message, *args, **kwargs)

    monkeypatch.setattr(muse.logger, "info", log)
    assert run(Meta()).source == "muse"
