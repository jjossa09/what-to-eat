"""P2-04 descriptive Insights contract. All rows and upstreams are synthetic."""

import asyncio
import json
from datetime import date, timedelta
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import insights
from app.auth import current_auth
from app.config import get_settings
from app.main import app, get_http_client

AS_OF = date(2026, 11, 4)
USER = "11111111-1111-4111-8111-111111111111"
OTHER_USER = "22222222-2222-4222-8222-222222222222"
A = "aaaaaaaa-1111-4111-8111-000000000001"
B = "bbbbbbbb-2222-4222-8222-000000000002"
C = "cccccccc-3333-4333-8333-000000000003"
HOST = "synthetic.supabase.co"
TOKEN = "synthetic-user-token"
KEY = "synthetic-publishable-key"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", f"https://{HOST}")
    monkeypatch.setenv("SUPABASE_ANON_KEY", KEY)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "must-not-be-used")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    app.dependency_overrides.clear()


def meal(n, on="2026-11-02", *, source="backfill", category="thai", went=None,
         food=False, solo=False, companions=(A,), user=USER):
    day = date.fromisoformat(on)
    return {
        "id": str(UUID(int=n)), "user_id": user, "source": source,
        "eaten_on": on, "day_of_week": day.isoweekday(), "category_id": category,
        "ate_at": f"{on}T20:00:00+00:00" if food else None,
        "went": went, "solo": solo,
        "meal_companions": [{"companion_id": cid} for cid in companions],
    }


def visits(n=5, *, companions=(A,), category="thai"):
    return [meal(i + 1, (AS_OF - timedelta(days=i)).isoformat(),
                 companions=companions, category=category) for i in range(n)]


class Upstream:
    def __init__(self, meals=(), companions=(A,), *, failures=None, bodies=None):
        self.meals = list(meals)
        self.companions = [{"id": cid, "user_id": USER} for cid in companions]
        self.failures = failures or {}
        self.bodies = bodies or {}
        self.requests = []
        self.active = self.max_active = 0
        self.fail_page = False
        self.repeat_page = False
        self.taste_profile = {"hard_no_categories": []}

    async def __call__(self, request):
        self.requests.append(request)
        assert request.url.host == HOST
        assert request.method == "GET"
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0)
            table = request.url.path.rsplit("/", 1)[-1]
            failure = self.failures.get(table)
            if isinstance(failure, Exception):
                raise failure
            if failure:
                return httpx2.Response(failure, json={"private": "synthetic upstream detail"})
            if table in self.bodies:
                return httpx2.Response(200, json=self.bodies[table])
            if table == "meals":
                # Intentionally return the supplied rows, so application checks are tested
                # even if an upstream violates its date, visit, or ownership filters.
                return httpx2.Response(200, json=self.meals)
            if table == "companions":
                offset = int(request.url.params["offset"])
                limit = int(request.url.params["limit"])
                if offset and self.fail_page:
                    return httpx2.Response(500)
                if self.repeat_page:
                    offset = 0
                return httpx2.Response(200, json=self.companions[offset:offset + limit])
            if table == "taste_profiles":
                return httpx2.Response(200, json=[self.taste_profile])
            raise AssertionError(f"unexpected table {table}")
        finally:
            self.active -= 1


def client(upstream, *, authenticated=True):
    async def http_client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as connection:
            yield connection

    app.dependency_overrides[get_http_client] = http_client
    if authenticated:
        app.dependency_overrides[current_auth] = lambda: (USER, TOKEN)
    else:
        app.dependency_overrides.pop(current_auth, None)
    return TestClient(app)


def get(upstream, **kw):
    return client(upstream, **kw).get(f"/insights?as_of={AS_OF.isoformat()}")


def companion(body, cid=A):
    return next(c for c in body["companions"]["companions"] if c["companion_id"] == cid)


def test_t1_visit_and_food_cohorts_with_tied_weekdays():
    rows = [
        meal(1, "2026-11-02"),
        meal(2, "2026-11-02", category="pizza"),
        meal(3, "2026-10-30"),
        meal(4, "2026-10-30", source="live", went=True, food=True),
        meal(5, "2026-11-04", source="live", went=True),
        meal(6, "2026-11-03", source="live", went=None),
        meal(7, "2026-10-29", source="live", went=False),
    ]
    response = get(Upstream(rows))
    assert response.status_code == 200
    body = response.json()
    assert body["complete"] is True and body["cutoff_date"] == "2026-11-04"
    assert companion(body) == {
        "companion_id": A, "meal_count": 5, "category_meal_count": 4,
        "source_counts": {"live": 2, "backfill": 3},
        "weekdays": [{"iso_day": day, "meal_count": {1: 2, 3: 1, 5: 2}.get(day, 0)}
                     for day in range(1, 8)],
        "categories": [{"category_id": "pizza", "meal_count": 1},
                       {"category_id": "thai", "meal_count": 3}],
        "leading_day_ids": [1, 5], "leading_category_ids": ["thai"],
        "pattern_status": "available",
    }
    assert body["companions"]["coverage"] == {
        "unlinked_meals": 0, "contradictory_company_meals": 0,
    }


def test_t2_group_meal_counts_whole_participation_for_each_person():
    body = get(Upstream([meal(1, companions=(A, B))], companions=(B, A))).json()
    assert [c["companion_id"] for c in body["companions"]["companions"]] == [A, B]
    assert companion(body, A)["meal_count"] == companion(body, B)["meal_count"] == 1
    assert companion(body, A)["category_meal_count"] == 1
    assert companion(body, B)["source_counts"] == {"live": 0, "backfill": 1}


def test_t3_four_meals_have_distributions_but_no_leaders():
    body = get(Upstream(visits(4, companions=(B,)), companions=(B,))).json()
    metrics = companion(body, B)
    assert metrics["meal_count"] == 4 and metrics["category_meal_count"] == 4
    assert sum(d["meal_count"] for d in metrics["weekdays"]) == 4
    assert metrics["categories"] == [{"category_id": "thai", "meal_count": 4}]
    assert metrics["leading_day_ids"] is metrics["leading_category_ids"] is None
    assert metrics["pattern_status"] == "insufficient_data"


def test_t4_solo_and_unknown_company_are_unlinked():
    rows = [meal(1, solo=True, companions=()), meal(2, solo=None, companions=())]
    body = get(Upstream(rows)).json()
    assert companion(body)["meal_count"] == 0
    assert body["companions"]["coverage"] == {
        "unlinked_meals": 2, "contradictory_company_meals": 0,
    }


def test_t5_solo_with_links_is_excluded_and_counted_once_in_coverage():
    # Live meal edited to solo: edit_meal changes solo but leaves its links in place.
    row = meal(1, source="live", went=True, food=True, solo=True, companions=(A, B))
    body = get(Upstream([row], companions=(A, B))).json()
    assert all(c["meal_count"] == c["category_meal_count"] == 0
               for c in body["companions"]["companions"])
    assert body["companions"]["coverage"] == {
        "unlinked_meals": 0, "contradictory_company_meals": 1,
    }


def test_t6_cutoff_includes_as_of_and_excludes_future_meals():
    up = Upstream([meal(1, "2026-11-04"), meal(2, "2026-11-05")])
    body = get(up).json()
    assert companion(body)["meal_count"] == 1
    assert companion(body)["weekdays"][2] == {"iso_day": 3, "meal_count": 1}
    request = next(r for r in up.requests if r.url.path.endswith("/meals"))
    assert request.url.params["eaten_on"] == "lte.2026-11-04"


def test_t7_saved_companion_without_meals_is_returned():
    body = get(Upstream()).json()
    metrics = companion(body)
    assert metrics["meal_count"] == metrics["category_meal_count"] == 0
    assert metrics["source_counts"] == {"live": 0, "backfill": 0}
    assert metrics["weekdays"] == [{"iso_day": day, "meal_count": 0} for day in range(1, 8)]
    assert metrics["categories"] == []
    assert metrics["leading_day_ids"] is metrics["leading_category_ids"] is None
    assert metrics["pattern_status"] == "insufficient_data"


def test_t8_hard_no_categories_are_descriptive_food_counts():
    up = Upstream([meal(1)])
    up.taste_profile = {"hard_no_categories": ["thai"]}
    body = get(up).json()
    assert companion(body)["categories"] == [{"category_id": "thai", "meal_count": 1}]
    assert {r.url.path.rsplit("/", 1)[-1] for r in up.requests} == {"meals", "companions"}


@pytest.mark.parametrize("table", ["companions", "meals"])
@pytest.mark.parametrize("failure", [500, 401, httpx2.ConnectError("synthetic network failure"),
                                    httpx2.ReadTimeout("synthetic timeout")])
def test_t9_failed_read_returns_503_without_partial_numbers(table, failure, caplog):
    response = get(Upstream(visits(), failures={table: failure}))
    assert response.status_code == 503
    assert response.json() == {"detail": "Couldn't load insights"}
    assert "synthetic upstream detail" not in response.text + caplog.text
    assert "synthetic-user-token" not in response.text + caplog.text


def test_failed_meals_request_returns_503_not_zero_counts():
    response = get(Upstream(visits(), failures={"meals": 503}))
    assert response.status_code == 503
    assert set(response.json()) == {"detail"}


def test_t10_requires_auth_before_reading_any_data():
    up = Upstream(visits())
    response = get(up, authenticated=False)
    assert response.status_code == 401
    assert up.requests == []


def test_t10_own_filters_credentials_and_parallel_reads_reject_foreign_rows():
    rows = [meal(1), meal(2, user=OTHER_USER, category="pizza", companions=(C,))]
    up = Upstream(rows)
    up.companions.append({"id": C, "user_id": OTHER_USER})
    body = get(up).json()
    assert body["complete"] is False
    assert companion(body)["meal_count"] == companion(body)["category_meal_count"] == 1
    assert [c["companion_id"] for c in body["companions"]["companions"]] == [A]
    assert C not in json.dumps(body)
    assert len(up.requests) == up.max_active == 2
    for request in up.requests:
        assert request.url.params["user_id"] == f"eq.{USER}"
        assert request.headers["apikey"] == KEY
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert "must-not-be-used" not in str(request.headers)
        assert request.extensions["timeout"]["read"] == 2.0


def test_t11_response_and_queries_exclude_names_dishes_and_messages():
    row = meal(1)
    row.update(name="Private companion", dish="Private dish", messages="Private message")
    up = Upstream([row])
    up.companions[0]["name"] = "Private companion"
    response = get(up)
    body = response.json()
    assert set(body) == {"complete", "cutoff_date", "companions"}
    assert set(body["companions"]) == {"companions", "coverage"}
    assert set(companion(body)) == {
        "companion_id", "meal_count", "category_meal_count", "source_counts", "weekdays",
        "categories", "leading_day_ids", "leading_category_ids", "pattern_status",
    }
    assert "Private" not in response.text
    for request in up.requests:
        select = request.url.params["select"]
        assert all(word not in select for word in ("name", "dish", "message"))


def test_t12_meal_row_cap_marks_loaded_subset_incomplete(monkeypatch):
    monkeypatch.setattr(insights, "MEALS_LIMIT", 3)
    up = Upstream(visits(3))
    body = get(up).json()
    assert body["complete"] is False and companion(body)["meal_count"] == 3
    request = next(r for r in up.requests if r.url.path.endswith("/meals"))
    assert request.url.params["limit"] == "3"
    assert request.url.params["order"] == "eaten_on.desc,id.desc"


def test_one_malformed_meal_row_is_dropped_with_valid_counts_returned():
    bad = meal(2)
    bad["day_of_week"] = 8
    response = get(Upstream([meal(1), bad]))
    assert response.status_code == 200
    body = response.json()
    assert body["complete"] is False
    assert companion(body)["meal_count"] == companion(body)["category_meal_count"] == 1
    assert companion(body)["categories"] == [{"category_id": "thai", "meal_count": 1}]
    assert sum(day["meal_count"] for day in companion(body)["weekdays"]) == 1


@pytest.mark.parametrize("field,value", [
    ("day_of_week", 0), ("day_of_week", True), ("category_id", "invented-category"),
    ("eaten_on", "not a date"), ("eaten_on", "20261102"), ("source", "invented-source"),
    ("went", 1), ("solo", "false"), ("id", "bad-id"), ("ate_at", "bad-time"),
    ("ate_at", "2026-11-02T20:00:00"), ("meal_companions", None),
    ("meal_companions", [{"companion_id": "bad-id"}]), ("meal_companions", [None]),
])
def test_bad_field_drops_only_that_meal_and_marks_incomplete(field, value):
    bad = meal(2)
    bad[field] = value
    response = get(Upstream([meal(1), bad]))
    assert response.status_code == 200 and response.json()["complete"] is False
    assert companion(response.json())["meal_count"] == 1


def test_missing_field_and_non_object_meal_rows_are_dropped():
    bad = meal(2)
    del bad["day_of_week"]
    response = get(Upstream([meal(1), bad, "bad row"]))
    assert response.status_code == 200 and response.json()["complete"] is False
    assert companion(response.json())["meal_count"] == 1


def test_malformed_companion_row_marks_incomplete_without_inventing_a_person():
    up = Upstream([meal(1)])
    up.companions.append({"id": "bad-id", "user_id": USER})
    response = get(up)
    assert response.status_code == 200 and response.json()["complete"] is False
    assert companion(response.json())["meal_count"] == 1
    assert len(response.json()["companions"]["companions"]) == 1


def test_category_ties_use_canonical_order_and_counts_stay_consistent():
    rows = visits(6)
    for row in rows[3:]:
        row["category_id"] = "pizza"
    metrics = companion(get(Upstream(rows)).json())
    assert metrics["leading_category_ids"] == ["pizza", "thai"]
    assert metrics["categories"] == [{"category_id": "pizza", "meal_count": 3},
                                     {"category_id": "thai", "meal_count": 3}]
    assert sum(x["meal_count"] for x in metrics["weekdays"]) == metrics["meal_count"]
    assert sum(metrics["source_counts"].values()) == metrics["meal_count"]
    assert sum(x["meal_count"] for x in metrics["categories"]) == metrics["category_meal_count"]


def test_five_visits_without_food_still_have_day_leaders_and_available_status():
    rows = [meal(i + 1, source="live", went=True) for i in range(5)]
    metrics = companion(get(Upstream(rows)).json())
    assert metrics["meal_count"] == 5 and metrics["category_meal_count"] == 0
    assert metrics["leading_day_ids"] == [1]
    assert metrics["leading_category_ids"] is None and metrics["categories"] == []
    assert metrics["pattern_status"] == "available"


def test_null_category_does_not_supply_food_evidence():
    rows = [meal(1, category=None), meal(2, source="live", went=True, food=True, category=None)]
    metrics = companion(get(Upstream(rows)).json())
    assert metrics["meal_count"] == 2 and metrics["category_meal_count"] == 0


def test_unknown_solo_with_known_links_counts_but_missing_links_stay_unlinked():
    rows = [meal(1, source="live", went=True, solo=None),
            meal(2, source="live", went=True, solo=False, companions=())]
    body = get(Upstream(rows)).json()
    assert companion(body)["meal_count"] == 1
    assert body["companions"]["coverage"]["unlinked_meals"] == 1


def test_deleted_companion_is_not_reconstructed_from_unknown_links():
    body = get(Upstream([meal(1, companions=())], companions=())).json()
    assert body["companions"]["companions"] == []
    assert body["companions"]["coverage"]["unlinked_meals"] == 1


def test_companion_pagination_returns_every_saved_id(monkeypatch):
    monkeypatch.setattr(insights, "COMPANION_PAGE_SIZE", 2)
    up = Upstream([meal(1, companions=(C,))], companions=(A, B, C))
    body = get(up).json()
    assert body["complete"] is True
    assert [c["companion_id"] for c in body["companions"]["companions"]] == [A, B, C]
    assert companion(body, C)["meal_count"] == 1
    requests = [r for r in up.requests if r.url.path.endswith("/companions")]
    assert [r.url.params["offset"] for r in requests] == ["0", "2"]
    assert all(r.url.params["order"] == "id.asc" for r in requests)


@pytest.mark.parametrize("repeat", [False, True])
def test_companion_pagination_failure_returns_503_without_partial_counts(monkeypatch, repeat):
    monkeypatch.setattr(insights, "COMPANION_PAGE_SIZE", 2)
    up = Upstream(visits(), companions=(A, B, C))
    up.fail_page, up.repeat_page = not repeat, repeat
    response = get(up)
    assert response.status_code == 503 and set(response.json()) == {"detail"}


@pytest.mark.parametrize("table", ["companions", "meals"])
def test_bad_response_envelope_returns_503(table):
    response = get(Upstream(visits(), bodies={table: {"not": "a collection"}}))
    assert response.status_code == 503 and set(response.json()) == {"detail"}


def test_configuration_failure_returns_503_before_reading(monkeypatch):
    def invalid_settings():
        raise ValueError("synthetic configuration failure")

    monkeypatch.setattr(insights, "get_settings", invalid_settings)
    up = Upstream(visits())
    response = get(up)
    assert response.status_code == 503 and set(response.json()) == {"detail"}
    assert up.requests == []


@pytest.mark.parametrize("query", ["", "?as_of=not-a-date", "?as_of=2026-02-30"])
def test_invalid_or_missing_cutoff_is_422_without_upstream_reads(query):
    up = Upstream(visits())
    response = client(up).get(f"/insights{query}")
    assert response.status_code == 422 and up.requests == []
