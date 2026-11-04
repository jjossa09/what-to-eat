"""#75 protocol and affected integration boundaries. Synthetic data, no .env or network."""

import asyncio
import json
from datetime import date
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import companion_actions as actions
from app import conversation as c
from app import cuisine_model, history, muse, place_model, places
from app.auth import current_auth, current_user
from app.config import Settings, get_settings
from app.main import app, get_http_client
from app.scoring import History, PastMeal, StoredPlace

TODAY = date(2026, 11, 4)
USER = "00000000-0000-0000-0000-000000000075"
PERSON = "00000000-0000-0000-0000-000000000076"


@pytest.fixture(autouse=True)
def synthetic_settings(monkeypatch):
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setenv("META_API_KEY", "synthetic-meta")
    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "synthetic-anon")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    get_settings.cache_clear()
    app.dependency_overrides[current_user] = lambda: USER
    app.dependency_overrides[current_auth] = lambda: (USER, "synthetic.jwt")
    yield
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def patch(**fields):
    return c.Patch.model_validate({k: {"status": "confirmed", "value": v}
                                   for k, v in fields.items()})


def test_all_values_in_one_message_need_zero_questions():
    state = c.apply_patch(c.Survey(), patch(craving="chinese", budget=1, distance=15000),
                          "typed", [])
    result = c.decide(state, History(), "dinner", False, TODAY)
    assert result["ready"] and result["next_key"] is None
    assert result["state"]["asked"] == []
    assert result["state"]["craving"]["source"] == "typed"


def test_partial_answers_ask_only_missing_and_never_reask_uncertainty():
    state = c.apply_patch(c.Survey(), patch(budget=1), "typed", [])
    assert c.decide(state, History(), "dinner", False, TODAY)["next_key"] == "craving"
    state = c.apply_patch(state, c.Patch(craving=c.Update(status="uncertain")), "typed", [])
    assert c.decide(state, History(), "dinner", False, TODAY)["next_key"] == "distance"
    assert state.budget.value == 1 and state.craving.status == "uncertain"


def test_recommend_now_uncertainty_and_exclusion_do_not_invent_answers():
    state = c.apply_patch(c.Survey(), c.Patch(craving=c.Update(status="uncertain"),
                                            exclude=["chinese"]), "typed", [])
    state.recommend_now = True
    result = c.decide(state, History(), "dinner", False, TODAY)
    assert result["ready"] and result["state"]["budget"]["value"] is None
    assert result["state"]["craving"]["status"] == "uncertain"
    assert result["state"]["exclusions"] == ["chinese"]
    assert History().prior.hard_nos == frozenset()


def test_correction_changes_two_fields_and_preserves_company_and_distance():
    state = c.apply_patch(c.Survey(), patch(craving="chinese", budget=3, distance=35000,
                                          company=["companion_1"]), "chip", [PERSON])
    corrected = c.apply_patch(state, patch(craving="italian", budget=1), "typed", [PERSON])
    assert corrected.craving.value == "italian" and corrected.budget.value == 1
    assert corrected.company == state.company and corrected.distance == state.distance
    assert corrected.craving.turn == 2 and corrected.company.turn == 1


@pytest.mark.parametrize("value", [
    {"budget": {"status": "confirmed", "value": True}},
    {"craving": {"status": "confirmed", "value": "pasta"}},
    {"craving": {"status": "uncertain", "value": "italian"}},
    {"exclude": ["invented"]}, {"surprise": True},
])
def test_invalid_patches_cannot_change_state(value):
    original = c.Survey()
    with pytest.raises(ValidationError):
        c.Patch.model_validate(value)
    assert original == c.Survey()


def test_three_asked_questions_stop_and_new_conversation_is_empty():
    state = c.Survey(asked=["craving", "budget", "distance"])
    assert c.decide(state, History(), "dinner", False, TODAY)["ready"]
    assert c.Survey().exclusions == [] and c.Survey().asked == []


def test_relative_steps_use_existing_rules_once_and_excludes_precede_ranking():
    state = c.apply_patch(c.Survey(), patch(craving="chinese", budget=3, distance=35000),
                          "typed", [])
    result = c.apply_patch(state, c.Patch(budget_step="cheaper", distance_step="closer",
                                        exclude=["chinese"]), "typed", [])
    assert result.budget.value == 2 and result.distance.value == 15000
    assert result.craving.value is None and result.exclusions == ["chinese"]


def test_explicit_correction_can_restore_a_previously_excluded_food():
    state = c.apply_patch(c.Survey(), c.Patch(exclude=["chinese"]), "typed", [])
    result = c.apply_patch(state, patch(craving="chinese"), "typed", [])
    assert result.craving.value == "chinese" and result.exclusions == []
    assert state.exclusions == ["chinese"]


def test_conflicting_absolute_and_relative_corrections_cannot_overwrite_state():
    with pytest.raises(ValidationError):
        c.Patch(budget=c.Update(status="confirmed", value=1), budget_step="pricier")


def test_date_tokens_handle_calendar_boundaries_and_ambiguous_weekdays():
    assert c.resolve_date(c.DateToken(kind="yesterday"), date(2026, 3, 1)) == date(2026, 2, 28)
    assert c.resolve_date(c.DateToken(kind="weekday", value="saturday"), TODAY) is None
    with pytest.raises(ValueError):
        c.resolve_date(c.DateToken(kind="iso", value="2026-11-05"), TODAY)
    assert c.date_range("last_7_days", TODAY) == (date(2026, 10, 29), TODAY)
    assert c.date_range("this_week", TODAY) == (date(2026, 11, 2), TODAY)


def test_last_meal_uses_date_and_slot_and_preserves_ambiguity():
    rows = [{"id": "older-record-created-later", "eaten_on": "2026-11-02", "meal_slot": "dinner"},
            {"id": "actual-last", "eaten_on": "2026-11-03", "meal_slot": "dinner"},
            {"id": "lunch", "eaten_on": "2026-11-03", "meal_slot": "lunch"}]
    assert actions.choose_meals(rows, "last")["meals"][0]["id"] == "actual-last"
    rows.append({"id": "unknown-time", "eaten_on": "2026-11-03", "meal_slot": None})
    assert actions.choose_meals(rows, "last")["ambiguous"]
    assert len(actions.choose_meals(rows, "last")["meals"]) == 3


def test_named_matches_reject_closest_guess_and_use_provider_brand_only():
    def candidate(id, name, distance, brand=None):
        return places.Candidate(id, name, 1, 2, distance, "chicken_wings", [], None, brand)
    found = [candidate("wrong", "Wing Stop Cafe", 1), candidate("far", "The Wingstop", 200),
             candidate("near", "Wingstop Location 2", 50, "Wingstop")]
    assert [p.id for p in places.named_matches(found, "wingstop!")] == ["near", "far"]
    assert places.named_matches(found, "Unrelated") == []


def test_unknown_place_chat_food_is_training_but_not_a_place_visit():
    row = {"source": "chat", "category_id": "chicken_wings", "eaten_on": "2026-11-03",
           "places": None, "went": True, "ate_at": "2026-11-04T12:00:00+00:00",
           "stars": 4, "meal_slot": None, "solo": None, "meal_companions": []}
    meal = history.parse_meal(row)
    assert meal and cuisine_model.counts(meal, TODAY, frozenset())
    assert not place_model.is_visit(meal, TODAY)
    assert not cuisine_model.counts(meal, date(2026, 11, 3), frozenset())
    row["ate_at"] = None
    assert not cuisine_model.counts(history.parse_meal(row), TODAY, frozenset())


def test_new_chat_meal_at_real_place_counts_as_visit_without_changing_mapping():
    place = StoredPlace("node/75", "Synthetic diner", 1, 2, (), None)
    meal = PastMeal(place, date(2026, 11, 3), "chat", "chicken_wings", None,
                    food_answered=True, went=True)
    assert place_model.is_visit(meal, TODAY)
    assert cuisine_model.counts(meal, TODAY, frozenset())


def test_one_parse_call_and_rejection_are_content_free(monkeypatch, caplog):
    calls = []
    async def fake(body, **kwargs):
        calls.append(body)
        return muse.Reply('{"intents":[{"type":"log_meal","unexpected":"PRIVATE"}],"patch":{}}',
                          "stop", None)
    monkeypatch.setattr(muse, "call", fake)
    result = asyncio.run(c.parse("synthetic private text", None, [], client=None))
    assert len(calls) == 1 and not result["understood"]
    assert "PRIVATE" not in caplog.text and "synthetic private text" not in caplog.text


def endpoint_client(handler):
    async def client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as connection:
            yield connection
    app.dependency_overrides[get_http_client] = client
    return TestClient(app)


def test_action_confirmation_required_before_any_database_request():
    calls = []
    client = endpoint_client(lambda r: calls.append(r) or httpx2.Response(200, json={}))
    response = client.post("/conversation/actions/confirm", json={"action_id": str(UUID(int=75)),
        "conversation_id": str(UUID(int=76)), "arguments": {}})
    assert response.status_code == 422 and not calls


def test_history_range_is_filtered_on_server_and_never_calls_muse():
    requests = []
    def upstream(request):
        requests.append(request)
        assert request.url.host == "synthetic.supabase.co"
        return httpx2.Response(200, json=[])
    client = endpoint_client(upstream)
    response = client.post("/conversation/history", json={"range": "last_7_days", "chart_id": "top",
                                                          "timezone": "America/New_York"})
    assert response.status_code == 200
    result = response.json()
    assert result["stats"]["summary"]["meal_count"] == 0
    query = next(r.url.params for r in requests if r.url.path.endswith("/meals"))
    assert query["and"] == f"(eaten_on.gte.{result['from_date']})"
    assert query["eaten_on"] == f"lte.{result['to_date']}"


def test_preparation_binds_validated_payload_to_user_jwt_and_no_raw_message():
    requests = []
    def upstream(request):
        requests.append(request)
        return httpx2.Response(200, json={"id": str(UUID(int=1)), "state": "pending"})
    client = endpoint_client(upstream)
    response = client.post("/conversation/actions/prepare", json={
        "conversation_id": str(UUID(int=75)),
        "client_key": "turn:1", "kind": "log_meal", "arguments": {
            "category_id": "chicken_wings", "eaten_on": "2026-11-03",
            "timezone": "America/New_York"}})
    assert response.status_code == 200 and len(requests) == 1
    assert requests[0].headers["Authorization"] == "Bearer synthetic.jwt"
    payload = json.loads(requests[0].content)["p_arguments"]
    assert payload["category_id"] == "chicken_wings" and "place_id" not in payload
    assert "message" not in payload and "session_id" not in payload


def test_meta_schema_uses_the_documented_strict_subset():
    schema = c.strict_schema(c.Interpretation.model_json_schema())
    def check(node):
        if isinstance(node, dict):
            assert not {"oneOf", "allOf", "discriminator"} & node.keys()
            if "properties" in node:
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
            for value in node.values():
                check(value)
        elif isinstance(node, list):
            for value in node:
                check(value)
    check(schema)


@pytest.mark.parametrize("company,solo", [(["companion_1", "companion_1"], False),
                                         (["companion_1"], True)])
def test_ambiguous_or_contradictory_meal_company_is_rejected(company, solo):
    with pytest.raises(ValidationError):
        c.MealIntent(type="log_meal", company=company, solo=solo)


def test_only_confirmed_company_enters_the_displayed_round_snapshot():
    from app.main import RecommendationsRequest, company_snapshot

    state = c.Survey(company=c.FieldState(value=[PERSON], status="predicted", source="model"))
    body = RecommendationsRequest(lat=1, lon=2, local_time="2026-11-04T19:00:00-05:00",
                                  solo=False, companion_ids=[PERSON], survey=state)
    assert company_snapshot(body) == {"confirmed": False, "solo": None, "companion_ids": []}
    state.company = c.FieldState(value=[PERSON], status="confirmed", source="typed", turn=1)
    body.survey = state
    assert company_snapshot(body) == {"confirmed": True, "solo": False, "companion_ids": [PERSON]}


def test_named_endpoint_widens_once_and_never_returns_the_closest_guess(monkeypatch):
    from app import funnel
    from app.main import get_places_client
    from tests.test_places import collection, feature

    requests, cached = [], []
    def upstream(request):
        requests.append(request)
        assert request.url.params["name"] == "Wingstop"
        features = ([feature("Wing Stop Cafe")] if len(requests) == 1 else
                    [feature("Wingstop", osm_id=2), feature("Unrelated cafe", osm_id=3)])
        return httpx2.Response(200, json=collection(*features))
    async def connection():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            yield client
    async def save(rows, **kwargs):
        cached.extend(rows)
    monkeypatch.setenv("GEOAPIFY_API_KEY", "synthetic-key")
    monkeypatch.setattr(funnel, "upsert_places", save)
    app.dependency_overrides[get_places_client] = connection
    response = TestClient(app).get(
        "/places/search?name=Wingstop&lat=33.95&lng=-84.55&radius_m=15000")
    assert response.status_code == 200
    result = response.json()
    assert result["widened"] and result["presentation"] == "nearby"
    assert [p["name"] for p in result["places"]] == ["Wingstop"]
    assert len(requests) == 2 and len(cached) == 1
    assert requests[0].url.params["filter"].endswith(",15000")
    assert requests[1].url.params["filter"].endswith(",40234")


def test_survey_contract_reaches_real_ranking_and_logs_prediction_provenance(monkeypatch):
    from tests.test_recommendations import SUPABASE_HOST, Upstreams, post, writes

    monkeypatch.setenv("GEOAPIFY_API_KEY", "synthetic-key")
    monkeypatch.setenv("SUPABASE_URL", f"https://{SUPABASE_HOST}")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service")
    state = c.apply_patch(c.Survey(), patch(craving="pizza", budget=1, distance=15000),
                          "typed", [])
    state.exclusions = ["thai"]
    state.company = c.FieldState(value="solo", status="predicted", source="model")
    upstream = Upstreams()
    response = post(upstream, survey=state.model_dump(), craving="thai", budget_level=4)
    assert response.status_code == 200
    result = response.json()
    assert result["answers"]["craving"] == "pizza" and result["answers"]["budget_level"] == 1
    assert result["picks"] and all(p["category"] != "thai" for p in result["picks"])
    assert "api.meta.ai" not in upstream.hosts()
    assert json.loads(writes(upstream, "sessions")[0].content)["company_confirmed"] is False
    events = json.loads(writes(upstream, "recommendation_events")[-1].content)
    assert all(e["decision_company"] == {"confirmed": False, "solo": None, "companion_ids": []}
               for e in events)
    assert not writes(upstream, "taste_profiles") and not writes(upstream, "meals")


def test_context_cancellation_is_owned_and_does_not_require_a_lost_action_id():
    requests = []
    client = endpoint_client(lambda r: requests.append(r) or httpx2.Response(204))
    response = client.post("/conversation/actions/cancel", json={"conversation_id": USER})
    assert response.status_code == 200
    assert json.loads(requests[0].content) == {"p_id": None, "p_conversation_id": USER}
    assert requests[0].headers["Authorization"] == "Bearer synthetic.jwt"


def test_food_feedback_lookup_never_matches_a_provisional_restaurant_category():
    requests = []
    client = endpoint_client(lambda r: requests.append(r) or httpx2.Response(200, json=[]))
    response = client.get("/conversation/meals?reference=food&category=chicken_wings")
    assert response.status_code == 200
    assert requests[0].url.params["and"] == "(or(source.eq.backfill,ate_at.not.is.null))"
    assert requests[0].url.params["category_id"] == "eq.chicken_wings"
