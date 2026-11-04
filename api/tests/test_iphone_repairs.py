"""#75 device regressions, synthetic provider/model/database transports only."""

import asyncio
import json
from dataclasses import replace
from datetime import date
from uuid import UUID

import httpx2
import pytest
from fastapi.testclient import TestClient
from test_recommendations import SESSION_ID, Upstreams, env, feature, post, use  # noqa: F401

from app import conversation as c
from app import main, muse, places, reasons
from app.auth import current_auth, current_user
from app.config import get_settings
from app.main import app, get_places_client
from app.scoring import Context, History, QuizPrior, rank

TODAY = date(2026, 11, 4)
USER = str(UUID(int=75))


@pytest.fixture(autouse=True)
def synthetic(monkeypatch):
    monkeypatch.setenv("REASONS_SIGNING_SECRET", "synthetic-iphone-signing")
    get_settings.cache_clear()
    app.dependency_overrides[current_user] = lambda: USER
    app.dependency_overrides[current_auth] = lambda: (USER, "synthetic.jwt")
    monkeypatch.setattr(reasons, "rate_limit", reasons.UserRateLimit())
    yield
    app.dependency_overrides.clear()


def candidate(id_, category, tags=True):
    tag = {"chinese": "catering.restaurant.chinese",
           "mexican": "catering.restaurant.mexican", "burgers": "catering.fast_food.burger"}
    return places.Candidate(id_, f"Synthetic {id_}", 1, 2, 100, category,
                            [tag[category]] if tags else ["catering.restaurant"], None)


POOL = [candidate("chinese", "chinese"), candidate("name-only", "chinese", False),
        candidate("mexican", "mexican"), candidate("burger", "burgers")]


def context(**changes):
    return Context(lat=1, lon=2, local_date=TODAY, meal_slot="lunch", is_weekend=False,
                   search_radius_m=15000, craving="chinese", **changes)


def test_explicit_chinese_has_no_discovery_or_fallback_from_other_cuisines():
    result = rank(POOL, context(required_craving="chinese"), History())
    assert [p.scored.place.id for p in result.top3] == ["chinese"]
    assert [s.place.id for s in result.ranked] == ["chinese"]


def test_predicted_craving_keeps_soft_ranking_and_discovery():
    result = rank(POOL, context(), History())
    assert len(result.top3) == 3
    assert any(p.scored.place.category != "chinese" for p in result.top3)


def test_craving_template_requires_provider_evidence_even_for_soft_predictions():
    verified = rank([POOL[0]], context(), History()).top3[0]
    unverified = rank([POOL[1]], context(), History()).top3[0]
    assert muse.template_reason(verified).startswith("Matches your Chinese craving")
    assert muse.template_reason(unverified) == "A spot nearby, 0.1 mi away."
    visited = replace(unverified, scored=replace(unverified.scored, evidence=replace(
        unverified.scored.evidence, visits=2)))
    assert muse.template_reason(visited) == "You've been here 2 times, 0.1 mi away."


def test_corrections_exclusions_anything_and_uncertainty_have_distinct_eligibility():
    def update(value):
        return c.Patch(craving=c.Update(status="confirmed", value=value))
    state = c.apply_patch(c.Survey(), update("chinese"), "typed", [])
    state = c.apply_patch(state, update("mexican"), "typed", [])
    body = main.RecommendationsRequest(lat=1, lon=2, local_time="2026-11-04T12:00:00Z",
                                       survey=state)
    answers = main.refine.Answers("mexican", None, None, ())
    assert main.required_craving(body, answers) == "mexican"
    ctx = replace(context(required_craving="mexican"), craving=state.craving.value)
    assert [p.scored.place.id for p in rank(POOL, ctx, History()).top3] == ["mexican"]
    state = c.apply_patch(state, c.Patch(exclude=["mexican"]), "typed", [])
    assert state.craving.value is None and state.exclusions == ["mexican"]
    state = c.apply_patch(state, update(None), "typed", [])
    assert state.craving.value is None
    body.survey = state
    assert main.required_craving(body, replace(answers, craving=None)) is None
    state.craving = c.FieldState(value="chinese", status="predicted", source="model")
    assert main.required_craving(body, replace(answers, craving="chinese")) is None
    state.craving.status = "uncertain"
    assert main.required_craving(body, replace(answers, craving="chinese")) is None
    excluded = rank(POOL, context(required_craving="chinese",
                    exclude_categories=frozenset({"chinese"})), History())
    assert not excluded.top3
    hard_no = History(prior=QuizPrior(hard_nos=frozenset({"chinese"})))
    assert not rank(POOL, context(required_craving="chinese"), hard_no).top3


def test_no_verified_matches_widens_boundedly_without_unrelated_filler():
    up = Upstreams()
    result = post(up, craving="chinese").json()
    assert result["picks"] == [] and result["required_craving"] == "chinese"
    assert up.hosts().count("api.geoapify.com") == 3
    assert up.hosts().count("api.meta.ai") == 0


def test_parse_state_reaches_widening_eligibility_and_returns_only_verified_matches(monkeypatch):
    import test_recommendations as fixtures

    monkeypatch.setattr(fixtures, "FEATURES", [
        feature("Synthetic Chinese", 101, 33.953, ["catering.restaurant.chinese"]),
        feature("Synthetic Mexican", 102, 33.954, ["catering.restaurant.mexican"]),
        feature("Chinese Name Only", 103, 33.955, ["catering.restaurant"]),
    ])
    state = c.apply_patch(c.Survey(),
                         c.Patch(craving=c.Update(status="confirmed", value="chinese")),
                         "typed", [])
    up = Upstreams()
    body = post(up, survey=state.model_dump(), craving="mexican").json()
    assert body["answers"]["craving"] == "chinese"
    assert [p["id"] for p in body["picks"]] == ["node/101"]
    assert up.hosts().count("api.geoapify.com") == 3  # unrelated venues never stop widening
    assert "Chinese" in body["picks"][0]["reason"]


def test_best_so_far_revalidates_metadata_exclusions_and_stale_reasons():
    def shown(id_, category, tags):
        return {"round": 3, "place_id": id_, "score": .9, "slot": "familiar",
                "pick_reason": "Matches your Mexican craving.", "reasons_source": "muse",
                "places": {"name": f"Synthetic {id_}", "lat": 33.95, "lon": -84.55,
                           "category_id": category, "geoapify_categories": tags}}
    up = Upstreams(last_round=3, shown=[
        shown("node/101", "chinese", ["catering.restaurant.chinese"]),
        shown("node/102", "mexican", ["catering.restaurant.mexican"]),
        shown("node/103", "chinese", []),
    ])
    result = post(up, session_id=str(UUID(int=1)), craving="chinese").json()
    assert result["best_so_far"] and [p["id"] for p in result["picks"]] == ["node/101"]
    assert "Mexican" not in result["picks"][0]["reason"]
    assert up.hosts().count("api.geoapify.com") == 0
    up = Upstreams(last_round=3, shown=up.shown)
    result = post(up, session_id=str(UUID(int=1)), craving="chinese",
                  exclude_categories=["chinese"]).json()
    assert result["picks"] == []


def parsed(monkeypatch, raw, text, **kwargs):
    calls = []
    async def fake(body, **_kwargs):
        calls.append(body)
        return muse.Reply(raw if isinstance(raw, str) else json.dumps(raw), "stop", None)
    monkeypatch.setattr(muse, "call", fake)
    result = asyncio.run(c.parse(text, None, [], client=None, **kwargs))
    assert len(calls) == 1
    return result, calls[0]


def test_partial_japanese_range_and_unrestricted_distance_keep_valid_fields(monkeypatch):
    text = "I want Japanese food that is in the range of $10–$20 and I don't mind how far"
    result, _ = parsed(monkeypatch, {"intents": [{"type": "survey_patch"}], "patch": {
        "craving": {"status": "confirmed", "value": "japanese_sushi"},
        "budget": {"status": "confirmed", "value": "$10–$20"},
        "distance": {"status": "confirmed", "value": 35000}, "unmatched": ["price_range"]}}, text)
    assert result["understood"] and result["status"] == "partial"
    assert result["invalid_fields"] == ["budget"]
    assert result["patch"]["budget"] == {"status": "uncertain", "value": None}
    before = c.Survey(budget=c.FieldState(value=4, status="confirmed", source="typed"))
    state = c.apply_patch(before, c.Patch.model_validate(result["patch"]), "typed", [])
    assert state.craving.value == "japanese_sushi" and state.distance.value == 35000
    assert state.budget.value is None and state.unmatched == ["price_range"]
    assert state.budget.status == "uncertain" and before.budget.value == 4


def test_ordinary_meal_and_pending_followup_use_same_bounded_protocol(monkeypatch):
    text = "I had McDonald's for lunch today, I had nuggets and fries and it was delicious"
    result, body = parsed(monkeypatch, {"patch": {}, "intents": [{"type": "log_meal",
        "category": "chicken_wings", "dish": "nuggets and fries", "date": {"kind": "today"},
        "slot": "lunch", "place_name": "McDonald's", "stars": "delicious"}]},
        text, pending_meal=True)
    meal = result["intents"][0]
    assert meal["category"] == "chicken_wings" and meal["slot"] == "lunch"
    assert meal["date"] == {"kind": "today", "value": None} and meal["stars"] is None
    assert meal["place_name"] == "McDonald's"
    sent = json.loads(body["messages"][1]["content"])
    assert sent["pending_meal"] is True and sent["message"] == text


@pytest.mark.parametrize("raw,status", [("{", "invalid_json"),
    ({"intents": [{"type": "unknown"}], "patch": {}}, "ambiguous"),
    ({"intents": [], "patch": {"unmatched": ["menu"]}}, "unsupported"),
    ({"intents": [], "patch": {"surprise": True}}, "invalid_fields")])
def test_parse_failure_classes_are_distinct(monkeypatch, raw, status):
    result, _ = parsed(monkeypatch, raw, "synthetic request")
    assert result["status"] == status


@pytest.mark.parametrize("failure,status", [("TimeoutError", "timeout"),
                                          ("HTTPStatus", "unavailable"), ("length", "truncated")])
def test_timeout_unavailable_and_truncation_are_distinct(monkeypatch, failure, status):
    async def fake(*args, **kwargs):
        if failure == "length":
            return muse.Reply("{}", "length", None)
        muse.last_failure.set(failure)
        return None
    monkeypatch.setattr(muse, "call", fake)
    result = asyncio.run(c.parse("synthetic request", None, [], client=None))
    assert result["status"] == status and not result["understood"]


def test_count_request_is_separate_from_nearby_distance(monkeypatch):
    result, _ = parsed(monkeypatch, {"intents": [{"type": "recommend_now"}], "patch": {
        "distance": {"status": "confirmed", "value": 15000}, "unmatched": ["result_count"]}},
        "Show me 2 restaurants nearby please")
    assert result["patch"]["distance"]["value"] == 15000
    assert result["patch"]["unmatched"] == ["result_count"]
    result, _ = parsed(monkeypatch, {"intents": [{"type": "recommend_now"}], "patch": {
        "distance": {"status": "confirmed", "value": 2}, "unmatched": ["result_count"]}},
        "Show me 2 restaurants please")
    assert result["patch"]["distance"] is None


def lookup_client(handler):
    async def connection():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
            yield client
    app.dependency_overrides[get_places_client] = connection
    return TestClient(app)


def test_possessive_name_normalization_keeps_exact_matches_without_fuzzy_guesses():
    actual = replace(candidate("real", "burgers"), name="McDonald’s")
    different = replace(candidate("different", "burgers"), name="McDonalds Cafe")
    assert places.named_matches([different, actual], "McDonalds") == [actual]
    assert places.named_matches([different, actual], "The McDonald's!") == [actual]
    assert places.named_matches([actual], "McDonald") == []


@pytest.mark.parametrize("kind,status,detail", [("empty", 200, "no_match"),
    ("provider", 502, "lookup_provider_error"), ("timeout", 504, "lookup_timeout"),
    ("invalid", 502, "lookup_invalid_response")])
def test_named_lookup_distinguishes_no_match_provider_timeout_and_invalid(
    kind, status, detail, caplog,
):
    calls = []
    def upstream(request):
        calls.append(request)
        if kind == "timeout":
            raise httpx2.ReadTimeout("PRIVATE_URL")
        return httpx2.Response(500 if kind == "provider" else 200,
                              json={"features": []} if kind == "empty" else {})
    response = lookup_client(upstream).get(
        "/places/search?name=PrivateSyntheticRestaurant&lat=1&lng=2&radius_m=15000")
    assert response.status_code == status
    assert response.json()["status" if status == 200 else "detail"] == detail
    assert len(calls) == (2 if kind == "empty" else 1)
    assert "PrivateSyntheticRestaurant" not in caplog.text and "PRIVATE_URL" not in caplog.text


def test_named_match_survives_a_secondary_place_cache_failure(monkeypatch):
    from app import funnel

    async def fail(*args, **kwargs):
        raise funnel.FunnelError()
    monkeypatch.setattr(funnel, "upsert_places", fail)
    response = lookup_client(lambda request: httpx2.Response(200, json={"features": [
        feature("Synthetic verified place", 101, 33.95, ["catering.restaurant.chinese"])
    ]})).get("/places/search?name=Synthetic%20verified%20place&lat=33.95&lng=-84.55")
    assert response.status_code == 200 and response.json()["status"] == "matched"
    assert response.json()["places"][0]["name"] == "Synthetic verified place"


@pytest.mark.parametrize("result,status", [({}, 503), ({"status": "failed"}, 503),
    ({"status": "saved"}, 503), ({"status": "saved", "meal_id": str(UUID(int=4))}, 200),
    ({"status": "duplicate"}, 200)])
def test_action_confirmation_requires_actual_success_contract(monkeypatch, result, status):
    calls = []
    async def rpc(*args):
        calls.append(args)
        return result
    monkeypatch.setattr(main.actions, "rpc", rpc)
    response = TestClient(app).post("/conversation/actions/confirm", json={
        "conversation_id": str(UUID(int=1)), "action_id": str(UUID(int=2)),
        "arguments": {"category_id": "chicken_wings"}, "confirmed": True})
    assert response.status_code == status and len(calls) == 1


@pytest.mark.parametrize("line", ["Japanese nearby.", "Serves nuggets and fries.",
    "Great dumplings nearby.", "Matches your craving.", "Order your favorite dish."])
def test_generated_cuisine_and_menu_claims_require_signed_evidence(line):
    evidence = {"id": "node/1", "category": "Chinese", "cuisine_verified": True, "signals": []}
    with pytest.raises(muse.RejectedOutput):
        muse.check_output(json.dumps({"reasons": [{"id": "node/1", "line": line}]}),
                          ["node/1"], evidence={"node/1": evidence})
    assert muse.grounded_reason("Chinese nearby.", evidence)
    assert not muse.grounded_reason("Chinese nearby.", {**evidence, "cuisine_verified": False})


def test_signed_reason_endpoint_falls_back_for_an_invented_dish():
    picks = rank(POOL, context(required_craving="chinese"), History()).top3
    envelope = reasons.envelope(USER, SESSION_ID, 1, picks)
    up = Upstreams(muse_lines={"chinese": "Serves nuggets and fries."})
    client = use(up)
    # use() supplies its own synthetic identity; bind this signed envelope to our identity.
    app.dependency_overrides[current_auth] = lambda: (USER, "synthetic.jwt")
    response = client.post("/reasons", json=envelope)
    assert response.status_code == 200 and response.json() == reasons.EMPTY
    assert up.hosts().count("api.meta.ai") == 1
