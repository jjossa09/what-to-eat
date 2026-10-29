import asyncio
import json
from datetime import date

import httpx2
import pytest

from app import history
from app.config import get_settings
from app.scoring import QuizPrior

SUPABASE_URL = "https://test-project.supabase.co"
ANON_KEY = "test-anon-key"
USER_ID = "00000000-0000-0000-0000-000000000001"
TOKEN = "user.jwt.token"


@pytest.fixture(autouse=True)
def supabase_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", SUPABASE_URL)
    monkeypatch.setenv("SUPABASE_ANON_KEY", ANON_KEY)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "must-not-be-used")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def place_row(pid="node/1", unresolved=False, **kw) -> dict:
    return {"id": pid, "name": "Thai Spot", "lat": 33.96, "lon": -84.55,
            "geoapify_categories": ["catering.restaurant.thai"], "address": "1 Main St",
            "unresolved": unresolved, **kw}


def meal_row(place=None, **kw) -> dict:
    return {"source": "live", "category_id": None, "eaten_on": "2026-10-28", "price_level": 2,
            "places": place_row() if place is None else place, **kw}


class Supabase:
    """MockTransport handler: answers by table, records each request."""

    def __init__(self, prior=None, meals=None, status=200, exc=None):
        self.bodies = {"taste_profiles": [] if prior is None else prior,
                       "meals": [] if meals is None else meals}
        self.status, self.exc, self.requests = status, exc, []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.exc:
            raise self.exc
        table = request.url.path.rsplit("/", 1)[-1]
        return httpx2.Response(self.status, content=json.dumps(self.bodies[table]).encode())


def run_load(upstream: Supabase):
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            return await history.load(USER_ID, TOKEN, client=client)

    return asyncio.run(go())


def test_reads_as_the_user_with_anon_key_and_user_filter():
    upstream = Supabase()
    run_load(upstream)
    assert {r.url.path for r in upstream.requests} == {"/rest/v1/taste_profiles",
                                                      "/rest/v1/meals"}
    for request in upstream.requests:
        assert request.headers["apikey"] == ANON_KEY
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert "must-not-be-used" not in str(request.headers)
        assert request.url.params["user_id"] == f"eq.{USER_ID}"


def test_meals_query_counts_only_resolved_confirmed_meals():
    upstream = Supabase()
    run_load(upstream)
    meals = next(r for r in upstream.requests if r.url.path.endswith("/meals"))
    params = meals.url.params
    assert "places!inner(" in params["select"]
    assert params["places.unresolved"] == "is.false"
    assert params["or"] == "(source.eq.backfill,went.is.true)"
    assert params["order"].startswith("eaten_on.desc")


def test_no_quiz_and_no_meals_is_cold_start():
    result = run_load(Supabase())
    assert result.prior == QuizPrior()
    assert result.meals == ()


def test_parses_prior_and_drops_unknown_categories_and_levels():
    prior = [{"favorite_categories": ["thai", "not_a_category"], "hard_no_categories": ["bbq"],
              "budget_level": 7}]
    result = run_load(Supabase(prior=prior))
    assert result.prior == QuizPrior(favorites=frozenset({"thai"}),
                                     hard_nos=frozenset({"bbq"}), budget_level=None)


def test_parses_meals_and_drops_malformed_rows():
    meals = [
        meal_row(source="backfill", category_id="vietnamese", price_level=3),
        meal_row(place=place_row("node/2", unresolved=True)),
        meal_row(place=place_row("node/3", lat=None)),
        meal_row(place=place_row("node/4"), eaten_on="not a date"),
        meal_row(place=place_row("node/5"), source="other"),
        "not a row",
    ]
    result = run_load(Supabase(meals=meals))
    assert len(result.meals) == 1
    meal = result.meals[0]
    assert meal.place.id == "node/1" and meal.place.geoapify_categories == (
        "catering.restaurant.thai",)
    assert (meal.source, meal.category_id, meal.price_level) == ("backfill", "vietnamese", 3)
    assert meal.eaten_on == date(2026, 10, 28)


def test_missing_settings_raise_not_configured(monkeypatch):
    monkeypatch.delenv("SUPABASE_ANON_KEY")
    monkeypatch.setattr(get_settings(), "SUPABASE_ANON_KEY", None)
    with pytest.raises(history.HistoryNotConfigured):
        run_load(Supabase())


@pytest.mark.parametrize(
    ("upstream", "error"),
    [
        (Supabase(status=401), history.HistoryUpstreamError),
        (Supabase(exc=httpx2.ReadTimeout("slow")), history.HistoryTimeout),
        (Supabase(exc=httpx2.ConnectError("down")), history.HistoryUpstreamError),
        (Supabase(meals={"not": "a list"}), history.HistoryUpstreamError),
    ],
)
def test_upstream_failures(upstream, error):
    with pytest.raises(error):
        run_load(upstream)
