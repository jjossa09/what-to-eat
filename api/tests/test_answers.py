import asyncio
import json
import logging

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import answers, muse, refine
from app.auth import current_user
from app.config import get_settings
from app.main import app, get_http_client

TEST_KEY = "LLM_1_test-meta-key"
SECRET_TEXT = "my secret dinner plans near 12 Oak St"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("META_API_KEY", TEST_KEY)
    monkeypatch.setenv("MUSE_TIMEOUT_S", "3.5")
    monkeypatch.setenv("MUSE_DAILY_CAP", "200")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    app.dependency_overrides.clear()


def output(understood=True, craving="none", exclude=(), budget="none", distance="none",
           something_else=False) -> dict:
    return {"understood": understood, "craving": craving, "exclude": list(exclude),
            "budget": budget, "distance": distance, "something_else": something_else}


def content(**kw) -> str:
    return json.dumps(output(**kw))


class Meta:
    """MockTransport handler for chat completions. Records each request."""

    def __init__(self, out=None, raw=None, status=200, exc=None, finish_reason="stop"):
        self.content = raw if raw is not None else json.dumps(out or output())
        self.status, self.exc, self.finish_reason = status, exc, finish_reason
        self.requests: list[httpx2.Request] = []

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        assert request.url.host == "api.meta.ai"
        if self.exc:
            raise self.exc
        body = {"choices": [{"message": {"content": self.content},
                             "finish_reason": self.finish_reason}],
                "usage": {"prompt_tokens": 450, "completion_tokens": 40,
                          "completion_tokens_details": {"reasoning_tokens": 20}}}
        return httpx2.Response(self.status, json=body)


def parse(meta: Meta, key="craving", text="thai please") -> answers.Parsed:
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as client:
            return await answers.parse(key, text, client=client)

    return asyncio.run(go())


def endpoint(meta: Meta, authed=True, **body):
    async def client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as c:
            yield c

    app.dependency_overrides[get_http_client] = client
    if authed:
        app.dependency_overrides[current_user] = lambda: "user-1"
    return TestClient(app).post("/answers/parse", json=body)


# The 3 questions (P1-21)


def test_spicy_cheap_close_fills_budget_and_distance_but_not_a_guessed_craving():
    # "Spicy" names no category: the craving question is not answered by it.
    # The budget and distance it did give come back to pre-fill those questions.
    meta = Meta(output(budget="1", distance="walk"))
    result = parse(meta, "craving", "something spicy, cheap, close by")
    assert result.status == answers.NOT_SURE
    assert result.change == refine.Change(budget=1, distance=1500)


def test_one_message_can_fill_all_three():
    result = parse(Meta(output(craving="thai", budget="1", distance="walk")))
    assert result.status == answers.OK and result.source == muse.MUSE
    assert result.change == refine.Change(craving="thai", budget=1, distance=1500)


@pytest.mark.parametrize("key, out, expected", [
    ("craving", output(craving="anything"), refine.Change(craving="anything")),
    ("craving", output(craving="anything", exclude=["burgers"]),
     refine.Change(craving="anything", exclude_categories=["burgers"])),
    ("budget", output(budget="3"), refine.Change(budget=3)),
    ("distance", output(distance="worth_the_drive"), refine.Change(distance=15000)),
    ("distance", output(distance="short_drive", budget="2"),
     refine.Change(distance=5000, budget=2)),
])
def test_first_questions(key, out, expected):
    assert parse(Meta(out), key).change == expected


@pytest.mark.parametrize("key, out", [
    ("craving", output(budget="1")),  # the asked field is missing
    ("budget", output(budget="cheaper")),  # a step is not an answer before round 1
    ("distance", output(distance="closer")),
    ("craving", output(something_else=True)),
    ("budget", output(understood=False, budget="2")),
])
def test_first_questions_not_sure(key, out):
    result = parse(Meta(out), key)
    assert (result.status, result.source) == (answers.NOT_SURE, muse.MUSE)
    assert result.change is None or getattr(result.change, key) is None


# Follow-ups (P1-14)


@pytest.mark.parametrize("out, expected", [
    (output(budget="cheaper"), refine.Change(budget="cheaper")),
    (output(distance="closer"), refine.Change(distance="closer")),
    (output(exclude=["burgers"]), refine.Change(exclude_categories=["burgers"])),
    (output(something_else=True), refine.Change(something_else=True)),
    (output(budget="cheaper", exclude=["burgers", "pizza"]),
     refine.Change(budget="cheaper", exclude_categories=["burgers", "pizza"])),
    (output(craving="korean", distance="farther"),
     refine.Change(craving="korean", distance="farther")),
])
def test_follow_ups(out, expected):
    for key in ("refine", "open"):
        assert parse(Meta(out), key).change == expected


@pytest.mark.parametrize("out", [
    output(),  # nothing filled
    output(understood=False, budget="cheaper"),
    output(craving="burgers", exclude=["burgers"]),  # contradicts itself
])
def test_follow_ups_not_sure(out):
    assert parse(Meta(out), "refine").status == answers.NOT_SURE


# Bad output: not sure, never a guess


@pytest.mark.parametrize("raw", [
    "not json",
    json.dumps([1, 2]),
    json.dumps({**output(), "craving": "sushi"}),
    json.dumps({**output(), "craving": "other"}),
    json.dumps({**output(), "exclude": ["burgers", "tacos"]}),
    json.dumps({**output(), "budget": "5"}),
    json.dumps({**output(), "budget": 1}),
    json.dumps({**output(), "distance": "far"}),
    json.dumps({**output(), "understood": "yes"}),
    json.dumps({k: v for k, v in output().items() if k != "something_else"}),
    json.dumps({**output(), "exclude": "burgers"}),
])
def test_bad_output_is_not_sure(raw):
    result = parse(Meta(raw=raw), "refine")
    assert (result.status, result.change, result.source) == (answers.NOT_SURE, None, "none")


def test_fenced_json_is_tolerated():
    raw = f"```json\n{content(craving='pizza')}\n```"
    assert parse(Meta(raw=raw)).change == refine.Change(craving="pizza")


def test_truncated_output_is_not_sure():
    assert parse(Meta(output(craving="thai"), finish_reason="length")).status == answers.NOT_SURE


@pytest.mark.parametrize("meta", [Meta(status=500), Meta(exc=httpx2.ConnectError("down")),
                                  Meta(exc=httpx2.ReadTimeout("slow"))])
def test_muse_failure_is_not_sure(meta):
    result = parse(meta)
    assert (result.status, result.source) == (answers.NOT_SURE, "none")


def test_not_configured_makes_no_call(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "")
    get_settings.cache_clear()
    meta = Meta(output(craving="thai"))
    assert parse(meta).status == answers.NOT_SURE
    assert meta.requests == []


def test_daily_cap_is_shared_with_reasons(monkeypatch):
    monkeypatch.setenv("MUSE_DAILY_CAP", "1")
    get_settings.cache_clear()
    meta = Meta(output(craving="thai"))
    assert parse(meta).status == answers.OK
    assert parse(meta).status == answers.NOT_SURE
    assert len(meta.requests) == 1


# Request


def test_one_call_with_json_schema_enums():
    meta = Meta(output(craving="thai"))
    parse(meta, "craving", "thai please")
    (request,) = meta.requests
    assert request.headers["authorization"] == f"Bearer {TEST_KEY}"
    body = json.loads(request.content)
    assert body["model"] == muse.MODEL and body["temperature"] == 0
    schema = body["response_format"]["json_schema"]
    assert body["response_format"]["type"] == "json_schema" and schema["strict"] is True
    props = schema["schema"]["properties"]
    assert set(props["craving"]["enum"]) == {*refine.CRAVINGS, "anything", "none"}
    assert "other" not in props["exclude"]["items"]["enum"]
    sent = json.loads(body["messages"][1]["content"])
    assert sent == {"question": "What are you craving?", "message": "thai please"}


def test_prompt_never_mentions_places():
    body = answers.request_body("refine", "cheaper")
    assert "places" not in json.dumps(body["messages"][1])
    assert "lat" not in json.loads(body["messages"][1]["content"])


# Logs: never the user's text, the prompt, or the output


@pytest.mark.parametrize("meta", [
    Meta(output(craving="thai")),
    Meta(output(understood=False)),
    Meta(raw=f"Sure! {SECRET_TEXT}"),
    Meta(status=500),
])
def test_logs_never_hold_the_text(meta, caplog):
    caplog.set_level(logging.DEBUG)
    parse(meta, "refine", SECRET_TEXT)
    assert "Oak" not in caplog.text and "secret" not in caplog.text
    assert TEST_KEY not in caplog.text
    assert "turn one chat message" not in caplog.text


def test_rejection_logs_shape_only(caplog):
    caplog.set_level(logging.DEBUG)
    parse(Meta(raw=json.dumps({**output(), "craving": "sushi"})), "refine", SECRET_TEXT)
    assert "Muse parse rejected: category (question=refine" in caplog.text
    assert "prompt=450 completion=40 reasoning=20" in caplog.text


# Endpoint


def test_endpoint_ok():
    response = endpoint(Meta(output(budget="cheaper", exclude=["burgers"])),
                        question_key="refine", text="cheaper, not burgers")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok", "source": "muse",
        "answer": {"craving": None, "exclude_categories": ["burgers"], "budget": "cheaper",
                   "distance": None, "something_else": False},
    }


def test_endpoint_not_sure_is_200():
    response = endpoint(Meta(status=500), question_key="craving", text="hmm")
    assert response.status_code == 200
    assert response.json() == {"status": "not_sure", "answer": None, "source": "none"}


def test_endpoint_answer_feeds_recommendations_refine():
    # The parsed answer is exactly the refine shape /recommendations accepts.
    answer = endpoint(Meta(output(distance="closer", something_else=True)),
                      question_key="refine", text="closer, something else").json()["answer"]
    assert refine.Change.model_validate(answer) == refine.Change(distance="closer",
                                                                 something_else=True)


@pytest.mark.parametrize("body", [
    {"question_key": "craving", "text": ""},
    {"question_key": "craving", "text": "   "},
    {"question_key": "craving", "text": "x" * 201},
    {"question_key": "company", "text": "solo"},
    {"text": "thai"},
])
def test_endpoint_bad_request(body):
    meta = Meta()
    assert endpoint(meta, **body).status_code == 422
    assert meta.requests == []


def test_endpoint_requires_auth():
    meta = Meta()
    assert endpoint(meta, authed=False, question_key="craving", text="thai").status_code == 401
    assert meta.requests == []
