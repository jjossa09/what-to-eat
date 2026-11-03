"""The recommendation deadline includes secondary writes. All upstreams are mocked."""

import asyncio
import time
from types import SimpleNamespace

from test_recommendations import Upstreams, env, post  # noqa: F401

from app import main
from app.config import get_settings


def test_places_time_does_not_start_a_reasons_call(monkeypatch):
    monkeypatch.setenv("MUSE_TIMEOUT_S", "5")
    get_settings.cache_clear()
    clock = [0.0]
    monkeypatch.setattr(main, "time", SimpleNamespace(perf_counter=lambda: clock[0]))

    class TimedPlaces(Upstreams):
        async def __call__(self, request):
            if request.url.host == "api.geoapify.com":
                clock[0] = 4.0
            return await super().__call__(request)

    upstream = TimedPlaces()
    response = post(upstream)
    assert response.status_code == 200 and response.json()["reasons_source"] == "template"
    assert not [r for r in upstream.requests if r.url.host == "api.meta.ai"]


def test_no_reasons_call_and_logging_cannot_extend_round(monkeypatch):
    monkeypatch.setattr(main, "ROUND_BUDGET_S", 0.15)
    cancelled = []

    class SlowSecondary(Upstreams):
        async def __call__(self, request):
            slow = request.url.host == "api.meta.ai" or (
                request.url.path.endswith("/recommendation_events") and request.method == "POST")
            if slow:
                try:
                    await asyncio.sleep(2)
                except asyncio.CancelledError:
                    cancelled.append(request.url.host)
                    raise
            return await super().__call__(request)

    start = time.perf_counter()
    response = post(SlowSecondary())
    assert response.status_code == 200
    assert response.json()["reasons_source"] == "template"
    assert time.perf_counter() - start < 1
    assert "api.meta.ai" not in cancelled
    assert cancelled  # The slow logging write was cancelled at the round deadline.


def test_quiet_write_uses_remaining_deadline_and_does_not_raise():
    cancelled = []

    async def write():
        try:
            await asyncio.sleep(2)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    async def go():
        return await main.quietly(write(), "synthetic", deadline=time.perf_counter() + 0.01)

    assert asyncio.run(go()) is None and cancelled == [True]
