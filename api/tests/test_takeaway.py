"""P2-09: synthetic rows and mocked Meta only. Existing Insights tests stay untouched."""

import json
import logging

import httpx2
import pytest
from test_insights import AS_OF, A, Upstream, client, meal, settings  # noqa: F401

from app import insights, muse, takeaway
from app.config import get_settings

VALID = "Chinese appears in 8 of your 20 food meals."


@pytest.fixture(autouse=True)
def meta_settings(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "synthetic-key-never-log")
    monkeypatch.setenv("MUSE_TAKEAWAY_TIMEOUT_S", "8")
    monkeypatch.setenv("MUSE_DAILY_CAP", "200")
    monkeypatch.setenv("MUSE_TAKEAWAY_DAILY_CAP", "10")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    monkeypatch.setattr(muse, "takeaway_cap", muse.DailyCap())
    get_settings.cache_clear()


def rows():
    result = []
    for n in range(1, 27):
        category = "chinese" if n <= 8 else "mexican" if n <= 15 else "thai"
        row = meal(n, source="backfill" if n <= 20 else "live", category=category,
                   went=None if n <= 20 else True, companions=(A,) if n <= 5 else ())
        row.update(meal_slot="dinner" if n <= 8 or n > 20 else "lunch")
        if n in (21, 22, 23):
            row.update(price_tap=2, price_level=2)
        if n in (24, 25):
            row["budget_level"] = 3
        if n in (21, 22, 23, 24):
            row["distance_m"] = {21: 1000, 22: 3000, 23: 3000, 24: 5000}[n]
        row.update(dish="PRIVATE DISH", messages="PRIVATE MESSAGE")
        result.append(row)
    return result


class Services:
    def __init__(self, *, line=VALID, fact_id="category", content=None, status=200, error=None,
                 meals=None, failures=None):
        self.data = Upstream(rows() if meals is None else meals, failures=failures)
        self.data.companions[0]["name"] = "PRIVATE NAME"
        self.requests = []
        self.line, self.fact_id, self.content = line, fact_id, content
        self.status, self.error = status, error

    async def __call__(self, request):
        if request.url.host != "api.meta.ai":
            return await self.data(request)
        self.requests.append(request)
        if self.error:
            raise self.error
        content = self.content if self.content is not None else json.dumps(
            {"fact_id": self.fact_id, "line": self.line})
        return httpx2.Response(self.status, json={"choices": [{"message": {"content": content},
                                                              "finish_reason": "stop"}],
                                                  "usage": {"prompt_tokens": 800,
                                                            "completion_tokens": 80,
                                                            "completion_tokens_details": {
                                                                "reasoning_tokens": 20}}})


def post(services, **options):
    return client(services, **options).post("/insights/takeaway", json={"as_of": AS_OF.isoformat()})


def test_payload_is_only_whitelisted_aggregates_and_settings_are_pinned():
    service = Services()
    response = post(service)
    assert response.status_code == 200
    assert response.json() == {"source": "muse", "line": VALID, "companion_refs": []}
    assert len(service.data.requests) == 2 and len(service.requests) == 1
    body = json.loads(service.requests[0].content)
    payload = body["messages"][1]["content"]
    for private in (A, AS_OF.isoformat(), "2026-11-02", "PRIVATE", '"distance_m"', "eaten_on",
                    "dish", "messages", "places", "lat", "lon", "user_id"):
        assert private not in payload
    facts = json.loads(payload)["facts"]
    assert [f["id"] for f in facts] == ["category", "slot_food", "price", "distance", "companion"]
    assert facts[-1]["companion_ref"] == "Companion 1"
    assert body["model"] == "muse-spark-1.3" and body["reasoning_effort"] == "minimal"
    assert body["temperature"] == 0 and body["max_completion_tokens"] == 800
    assert body["response_format"]["json_schema"]["strict"] is True
    assert service.requests[0].extensions["timeout"]["read"] == 8


@pytest.mark.parametrize("line", [
    "Chinese appears in 3 food meals.",  # Three belongs to price, not the chosen food fact.
    "Mexican appears in 8 of your 20 food meals.",
    "Chinese is 40% of your food meals.",
    "Chinese appears in 20 of your 8 food meals.",
    "Chinese makes 8 healthy meals.", "Chinese — 8 meals.", "x" * 91,
    "Chinese appears in 8 lunches.", "Chinese appeared in 8 meals.\n",
    "Chinese will appear in 8 meals.", "You should try Chinese 8 times.",
    "Chinese is better than Mexican.", "Chinese is your favorite food.",
    "Your personality explains 8 Chinese meals.", "Chinese appeared in eight meals.",
    "Chinese appears in 8 meals with Companion 99.",
    "Chinese was a delicious choice for 8 meals.",
    "You are adventurous with 8 Chinese meals.",
    "Chinese appears in 8 $$$$ meals.",
    "You ate Chinese 8 times today.",
    "Chinese arrived in 8 helicopters.",
    "You recorded 8 meals.",
])
def test_bad_line_falls_back_once(line):
    service = Services(line=line)
    result = post(service)
    assert result.status_code == 200
    assert result.json() == {"source": "template",
                             "line": "Chinese appears in 8 recorded food meals.",
                             "companion_refs": []}
    assert len(service.requests) == 1


def test_companions_are_placeholders_for_muse_and_ids_only_for_phone():
    service = Services(fact_id="companion", line="You recorded 5 meals with Companion 1.")
    result = post(service).json()
    assert result["source"] == "muse"
    assert result["companion_refs"] == [{"placeholder": "Companion 1", "companion_id": A}]
    assert A not in service.requests[0].content.decode()


@pytest.mark.parametrize("fact_id,line", [
    ("slot_food", "Mexican appears in 7 recorded lunch meals."),
    ("price", "You recorded 3 dinner prices at $$."),
    ("distance", "Dinner median: 1.9 mi from 4 measured meals."),
])
def test_each_other_fact_accepts_natural_wording(fact_id, line):
    service = Services(fact_id=fact_id, line=line)
    assert post(service).json() == {"source": "muse", "line": line, "companion_refs": []}


@pytest.mark.parametrize("meters,display", [(0, "0 mi"), (1, "<0.1 mi"), (3000, "1.9 mi")])
def test_distance_facts_keep_zero_and_small_nonzero_distances_distinct(meters, display):
    service = Services()
    stats = client(service).get(f"/insights?as_of={AS_OF.isoformat()}").json()
    stats["distance_by_slot"][2]["median_m"] = meters
    facts, _ = takeaway.build_facts(stats)
    fact = next(f for f in facts if f["id"] == "distance")
    assert fact["median_miles_display"] == display


def test_incomplete_history_is_a_template_without_muse(monkeypatch):
    monkeypatch.setattr(insights, "MEALS_LIMIT", 26)
    service = Services()
    result = post(service).json()
    assert result["source"] == "template"
    assert result["line"] == "Loaded history: Chinese appears in 8 recorded food meals."
    assert service.requests == []


def test_no_facts_hides_the_line_without_muse():
    service = Services(meals=[])
    assert post(service).json() == {"source": "none", "line": None, "companion_refs": []}
    assert service.requests == []


@pytest.mark.parametrize("options", [
    {"error": httpx2.ReadTimeout("PRIVATE TIMEOUT")}, {"status": 503},
    {"content": "PRIVATE invalid JSON"},
])
def test_failures_use_template_without_retry(options):
    service = Services(**options)
    assert post(service).json()["source"] == "template"
    assert len(service.requests) == 1


@pytest.mark.parametrize("table", ["meals", "companions"])
def test_failed_read_is_503_and_muse_is_not_called(table):
    service = Services(failures={table: 500})
    assert post(service).status_code == 503
    assert service.requests == []


def test_auth_is_required():
    service = Services()
    assert post(service, authenticated=False).status_code == 401
    assert service.requests == service.data.requests == []


def test_takeaway_cap_is_ten_under_global_cap():
    service = Services()
    for _ in range(10):
        assert post(service).json()["source"] == "muse"
    assert post(service).json()["source"] == "template"
    assert len(service.requests) == muse.daily_cap.count == 10


def test_global_cap_also_applies(monkeypatch):
    monkeypatch.setenv("MUSE_DAILY_CAP", "1")
    get_settings.cache_clear()
    service = Services()
    assert post(service).json()["source"] == "muse"
    assert post(service).json()["source"] == "template"
    assert len(service.requests) == muse.takeaway_cap.count == 1


def test_telemetry_has_metadata_only(caplog):
    caplog.set_level(logging.INFO)
    service = Services()
    post(service)
    records = [json.loads(r.message.split("Muse call: ", 1)[1]) for r in caplog.records
               if r.message.startswith("Muse call: ")]
    assert len(records) == 1
    row = records[0]
    assert row["call_type"] == "takeaway" and row["validation_outcome"] == "accepted"
    assert row["prompt_tokens"] == 800 and row["reasoning_tokens"] == 20
    assert row["elapsed_ms"] >= 0 and row["correlation_id"]
    for private in (VALID, "PRIVATE", A, AS_OF.isoformat(), "synthetic-key-never-log"):
        assert private not in caplog.text
