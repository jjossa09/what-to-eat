"""Final Otis repairs: synthetic language, Places and database boundaries only."""

import asyncio
import json
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient
from test_recommendations import Upstreams, env, feature, post  # noqa: F401
from test_widening import Upstreams as SearchUpstreams

from app import conversation as c
from app import main, muse, places, widening
from app.auth import current_user


def parse_reply(monkeypatch, data, text, **kwargs):
    calls = []

    async def respond(body, **_kwargs):
        calls.append(body)
        return muse.Reply(json.dumps(data), "stop", None)

    monkeypatch.setattr(muse, "call", respond)
    result = asyncio.run(c.parse(text, None, [], client=None, **kwargs))
    assert len(calls) == 1
    return result, calls[0]


@pytest.mark.parametrize("text,line", [
    ("Hello! How are you doing?", "I'm here and ready to help! What sounds good to eat?"),
    ("What about you?", "I don't eat, but I can help you choose! What sounds good?"),
    ("What can you do?", "I can find nearby food, help log meals, and show your history."),
])
def test_natural_conversation_uses_the_single_structured_parse(monkeypatch, text, line):
    result, body = parse_reply(monkeypatch, {
        "intents": [{"type": "unknown"}], "patch": {}, "reply": line}, text)
    assert result["understood"] and result["status"] == "ok"
    assert result["reply"] == line
    assert c.Patch.model_validate(result["patch"]) == c.Patch()
    schema = body["response_format"]["json_schema"]["schema"]
    assert "reply" in schema["required"]
    assert schema["additionalProperties"] is False


def test_context_and_active_requirement_reach_the_registered_parse_route(monkeypatch):
    calls = []

    async def respond(body, **kwargs):
        calls.append(body)
        return muse.Reply(json.dumps({"intents": [{"type": "unknown"}], "patch": {},
                                      "reply": "I'm here to help you choose!"}), "stop", None)

    monkeypatch.setattr(muse, "call", respond)
    main.app.dependency_overrides[current_user] = lambda: str(UUID(int=90))
    context = [{"role": "user", "content": "I want Japanese with companion_1"},
               {"role": "assistant", "content": "What sounds good?"}]
    response = TestClient(main.app).post("/conversation/parse", json={
        "text": "What about you?", "recent_context": context,
        "active_craving": "japanese_sushi", "companion_refs": ["companion_1"]})
    assert response.status_code == 200 and response.json()["understood"]
    assert len(calls) == 1
    sent = json.loads(calls[0]["messages"][1]["content"])
    assert sent["recent_context"] == context
    assert sent["active_craving"] == "japanese_sushi"
    assert TestClient(main.app).post("/conversation/parse", json={
        "text": "Hello", "recent_context": context * 4}).status_code == 422
    assert len(calls) == 1


def test_prompt_describes_real_capabilities_and_routes_cuisine_searches():
    for term in ("recommendations", "budget levels", "rating", "history", "Insights",
                 "confirmation", "No booking", "recent_context", "recommend_now",
                 "Something else/different", "Anything is fine"):
        assert term in c.SYSTEM


@pytest.mark.parametrize("line", [
    "I saved your meal.", "I found three restaurants.", "I verified the cuisine.",
    "I’ve saved your meal.", "I can't book tables, but I can deliver dinner.",
    "I can book a table.", "I can order delivery.", "It costs $12.",
    "You usually eat Chinese.", "I ate sushi yesterday.", "Here is a healthy option.",
    "First line.\nSecond line.", "How are you? What food do you want?",
])
def test_unverified_action_and_factual_replies_are_rejected(monkeypatch, line):
    result, _ = parse_reply(monkeypatch, {"intents": [{"type": "unknown"}],
                                          "patch": {}, "reply": line}, "synthetic request")
    assert not result["understood"] and result["reply"] is None


def test_action_reply_cannot_claim_success_before_code_runs(monkeypatch):
    result, _ = parse_reply(monkeypatch, {"intents": [{"type": "recommend_now"}],
        "patch": {"craving": {"status": "confirmed", "value": "chinese"}},
        "reply": "Here are your picks!"}, "Find Chinese food")
    assert result["understood"] and result["reply"] is None
    assert result["patch"]["craving"]["value"] == "chinese"


@pytest.mark.parametrize("line", [
    "What food do you prefer?", "What's your favorite cuisine?",
    "I can show your saved meals and help log what you ate.",
    "I can't book tables, but I can help you find food.",
])
def test_truthful_questions_capabilities_and_limitations_are_still_conversational(
    monkeypatch, line,
):
    result, _ = parse_reply(monkeypatch, {"intents": [{"type": "unknown"}],
        "patch": {}, "reply": line}, "synthetic conversation")
    assert result["understood"] and result["reply"] == line


def test_uncertain_food_uses_existing_planner_without_inventing_a_craving():
    from datetime import date

    state = c.apply_patch(c.Survey(), c.Patch(craving=c.Update(status="uncertain")),
                          "typed", [])
    result = c.decide(state, main.History(), "dinner", False, date(2026, 11, 4))
    assert result["state"]["craving"]["value"] is None
    assert result["next_key"] == "budget"


@pytest.mark.parametrize("cuisine,tags", [
    ("chinese", ("catering.restaurant.chinese", "catering.restaurant.dumpling",
                 "catering.restaurant.taiwanese")),
    ("japanese_sushi", ("catering.restaurant.japanese", "catering.restaurant.sushi",
                        "catering.restaurant.ramen", "catering.fast_food.ramen",
                        "catering.restaurant.beef_bowl")),
    ("mexican", ("catering.restaurant.mexican", "catering.restaurant.tex-mex",
                 "catering.restaurant.tacos", "catering.fast_food.tacos")),
])
def test_explicit_cuisine_targets_every_provider_call_and_validates_metadata(cuisine, tags):
    # The provider intentionally returns a name-only match and a different cuisine too.
    pool = [feature(f"Synthetic venue {i}", 100 + i, 33.953 + i * .001, [tag])
            for i, tag in enumerate(tags)]
    pool += [feature("Synthetic Name Only", 200, 33.951, ["catering.restaurant"]),
             feature("Unrelated Italian", 201, 33.952, ["catering.restaurant.italian"])]
    up = SearchUpstreams([pool])
    response = post(up, craving=cuisine, radius_m=15000)
    assert response.status_code == 200
    body = response.json()
    requests = [r for r in up.requests if r.url.host == "api.geoapify.com"]
    assert len(requests) == 3
    assert all(set(r.url.params["categories"].split(",")) == set(tags) for r in requests)
    radii = [int(r.url.params["filter"].rsplit(",", 1)[1]) for r in requests]
    assert radii == [15000, 22500, 33750]
    assert 0 < len(body["picks"]) <= 3
    assert all(p["category"] == cuisine for p in body["picks"])
    assert not {"node/200", "node/201"} & {p["id"] for p in body["picks"]}
    assert body["required_craving"] == cuisine
    assert up.hosts().count("api.meta.ai") == 0


def test_anything_and_predictions_use_normal_search_without_targeted_category():
    state = c.Survey(craving=c.FieldState(value="chinese", status="predicted", source="model"))
    predicted = Upstreams()
    assert post(predicted, survey=state.model_dump()).status_code == 200
    assert all(r.url.params["categories"] == "catering" for r in predicted.requests
               if r.url.host == "api.geoapify.com")
    state = c.apply_patch(state, c.Patch(craving=c.Update(status="confirmed", value=None)),
                          "typed", [])
    cleared = Upstreams()
    body = post(cleared, survey=state.model_dump(), requirements_changed=True).json()
    assert body["required_craving"] is None and body["picks"]
    assert all(r.url.params["categories"] == "catering" for r in cleared.requests
               if r.url.host == "api.geoapify.com")


def test_something_else_keeps_explicit_japanese_and_never_revives_mexican():
    state = c.apply_patch(c.Survey(), c.Patch(craving=c.Update(
        status="confirmed", value="japanese_sushi")), "typed", [])
    state = c.apply_patch(state, c.Patch(something_else=True), "chip", [])
    assert state.craving.value == "japanese_sushi" and state.exclusions == []
    shown = [{"round": 3, "place_id": "node/500", "score": .9, "slot": "familiar",
              "places": {"name": "Synthetic Mexican", "category_id": "mexican",
                         "lat": 33.95, "lon": -84.55,
                         "geoapify_categories": ["catering.restaurant.mexican"]}}]
    up = Upstreams(last_round=3, shown=shown)
    body = post(up, session_id=str(UUID(int=1)), survey=state.model_dump()).json()
    assert body["best_so_far"] and body["picks"] == []
    assert body["required_craving"] == "japanese_sushi" and body["search_status"] == "cached"
    # The direct refinement boundary also preserves explicit requests from older clients.
    up = Upstreams(last_round=3, shown=shown)
    body = post(up, session_id=str(UUID(int=1)), craving="japanese_sushi",
                refine={"something_else": True}).json()
    assert body["required_craving"] == "japanese_sushi" and body["picks"] == []


@pytest.mark.parametrize("craving,expected", [("japanese_sushi", "catering.restaurant.japanese"),
                                             (None, "catering")])
def test_changed_or_cleared_requirement_bypasses_cached_cap(craving, expected):
    state = c.apply_patch(c.Survey(), c.Patch(craving=c.Update(status="confirmed", value=craving)),
                          "typed", [])
    up = Upstreams(last_round=3)
    response = post(up, session_id=str(UUID(int=1)), survey=state.model_dump(),
                    requirements_changed=True)
    assert response.status_code == 200 and not response.json()["best_so_far"]
    requests = [r for r in up.requests if r.url.host == "api.geoapify.com"]
    assert requests and expected in requests[0].url.params["categories"].split(",")


@pytest.mark.parametrize("responses,expected", [
    ([[]], "complete"), ([[], httpx2.ReadTimeout("synthetic timeout")], "timeout"),
    ([[], 500], "provider_error"),
])
def test_zero_results_distinguish_completed_search_from_widening_failure(responses, expected):
    up = SearchUpstreams(responses)
    response = post(up, craving="chinese", radius_m=15000)
    assert response.status_code == 200
    assert response.json()["picks"] == [] and response.json()["search_status"] == expected
    assert len([r for r in up.requests if r.url.host == "api.geoapify.com"]) <= 3


def test_exhausted_budget_is_incomplete_instead_of_no_match(monkeypatch):
    clock = iter((0., 4.))
    monkeypatch.setattr(widening, "monotonic", lambda: next(clock))
    response = post(SearchUpstreams([[]]), craving="chinese", radius_m=15000)
    assert response.status_code == 200
    assert response.json()["picks"] == [] and response.json()["search_status"] == "incomplete"


def test_initial_provider_timeout_never_becomes_a_successful_empty_search():
    up = SearchUpstreams([httpx2.ReadTimeout("synthetic timeout")])
    response = post(up, craving="chinese")
    assert response.status_code == 504
    assert response.json()["detail"] == "Places search timed out"


def test_unsupported_cuisine_never_invents_a_provider_mapping():
    assert "breakfast_brunch" not in places.CUISINE_CATEGORIES
    assert places.search_categories("breakfast_brunch") == "catering"
    with pytest.raises(ValueError):
        c.Patch(craving=c.Update(status="confirmed", value="invented_cuisine"))
    up = Upstreams()
    response = post(up, craving="breakfast_brunch")
    assert response.status_code == 200
    assert response.json()["search_status"] == "unsupported_category"
    assert response.json()["picks"] == []
    assert "api.geoapify.com" not in up.hosts()
