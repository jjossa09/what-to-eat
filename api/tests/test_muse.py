import asyncio
import json
import logging
from datetime import date

import httpx2
import pytest

from app import muse
from app.config import get_settings
from app.places import Candidate
from app.scoring import Context, History, PastMeal, QuizPrior, StoredPlace, rank

LAT, LON = 33.95, -84.55
TEST_KEY = "LLM_1_test-meta-key"
M_PER_DEG = 111_195


@pytest.fixture(autouse=True)
def muse_env(monkeypatch):
    monkeypatch.setenv("META_API_KEY", TEST_KEY)
    monkeypatch.setenv("MUSE_TIMEOUT_S", "3.5")
    monkeypatch.setenv("MUSE_DAILY_CAP", "200")
    monkeypatch.setattr(muse, "daily_cap", muse.DailyCap())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def cand(pid, category, distance_m) -> Candidate:
    return Candidate(id=pid, name=f"Place {pid}", lat=LAT + distance_m / M_PER_DEG, lon=LON,
                     distance_m=distance_m, category=category, geoapify_categories=[],
                     address="1 Main St")


def top3(**ctx_kw):
    context = Context(lat=LAT, lon=LON, local_date=date(2026, 10, 29), meal_slot="dinner",
                      is_weekend=False, search_radius_m=5000, **ctx_kw)
    history = History(prior=QuizPrior(favorites=frozenset({"thai", "pizza"})))
    candidates = [cand("node/1", "thai", 400), cand("node/2", "pizza", 800),
                  cand("node/3", "mexican", 1200), cand("node/4", "burgers", 3000)]
    return rank(candidates, context, history).top3


PICKS = top3()
IDS = [p.scored.place.id for p in PICKS]


def reply(lines: dict[str, str] | None = None, content=None, usage=True,
          finish_reason="stop") -> dict:
    if content is None:
        lines = lines or {i: f"Good pick {n}." for n, i in enumerate(IDS)}
        content = json.dumps({"reasons": [{"id": i, "line": t} for i, t in lines.items()]})
    body = {"choices": [{"message": {"role": "assistant", "content": content},
                         "finish_reason": finish_reason}]}
    if usage:
        body["usage"] = {"prompt_tokens": 500, "completion_tokens": 60, "total_tokens": 560,
                         "completion_tokens_details": {"reasoning_tokens": 10}}
    return body


class Meta:
    """MockTransport handler for chat completions. Records each request."""

    def __init__(self, body=None, status=200, exc=None, delay=0.0):
        self.body = reply() if body is None else body
        self.status, self.exc, self.delay, self.requests = status, exc, delay, []

    async def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return httpx2.Response(self.status, content=json.dumps(self.body).encode())


def run(meta: Meta, picks=PICKS) -> muse.Reasons:
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(meta)) as client:
            return await muse.write_reasons(picks, client=client)

    return asyncio.run(go())


def assert_templates(result: muse.Reasons):
    assert result.source == muse.TEMPLATE
    assert result.lines == tuple(muse.template_reason(p) for p in PICKS)


# Success


def test_success_uses_muse_lines_in_our_order():
    shuffled = {IDS[2]: "Third.", IDS[0]: "First.", IDS[1]: "Second."}
    result = run(Meta(reply(shuffled)))
    assert result.source == muse.MUSE
    assert result.lines == ("First.", "Second.", "Third.")
    assert result.usage == muse.Usage(prompt_tokens=500, completion_tokens=60,
                                      reasoning_tokens=10)


def test_request_shape():
    meta = Meta()
    run(meta)
    (request,) = meta.requests
    assert str(request.url) == "https://api.meta.ai/v1/chat/completions"
    assert request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {TEST_KEY}"
    body = json.loads(request.content)
    assert body["model"] == "muse-spark-1.3"
    assert body["reasoning_effort"] == "minimal"
    assert body["response_format"]["type"] == "json_schema"
    evidence = json.loads(body["messages"][1]["content"])
    assert [p["id"] for p in evidence["picks"]] == IDS


def test_prompt_has_no_coordinates_or_address():
    meta = Meta()
    run(meta)
    sent = json.loads(meta.requests[0].content)["messages"][1]["content"]
    assert "1 Main St" not in sent
    assert str(PICKS[0].scored.place.lat) not in sent


def test_em_dash_is_reworded_not_rejected():
    lines = {IDS[0]: "Thai — close by.", IDS[1]: "B.", IDS[2]: "C."}
    result = run(Meta(reply(lines)))
    assert result.source == muse.MUSE
    assert result.lines[0] == "Thai, close by."


def test_json_fence_is_tolerated():
    inner = json.dumps({"reasons": [{"id": i, "line": "Fine."} for i in IDS]})
    result = run(Meta(reply(content=f"```json\n{inner}\n```")))
    assert result.source == muse.MUSE


FENCED_INNER = json.dumps({"reasons": [{"id": i, "line": "Fine."} for i in IDS]})


@pytest.mark.parametrize("content", [
    f"```JSON\n{FENCED_INNER}\n```",
    f"```\n{FENCED_INNER}\n```",
    f"Here are the reasons:\n```json\n{FENCED_INNER}\n```",
    f"{FENCED_INNER}\nDone.",
])
def test_fence_and_stray_text_are_tolerated(content):
    result = run(Meta(reply(content=content)))
    assert result.source == muse.MUSE
    assert result.lines == ("Fine.",) * 3


def test_truncated_output_is_rejected(caplog):
    caplog.set_level(logging.DEBUG)
    cut = FENCED_INNER[: len(FENCED_INNER) // 2]
    result = run(Meta(reply(content=cut, finish_reason="length")))
    assert_templates(result)
    assert "rejected: truncated" in caplog.text
    assert "finish_reason=length" in caplog.text


def test_length_stop_rejects_even_parseable_output():
    assert_templates(run(Meta(reply(finish_reason="length"))))


def test_max_completion_tokens_leaves_room_for_reasoning():
    meta = Meta()
    run(meta)
    assert json.loads(meta.requests[0].content)["max_completion_tokens"] == 1500


def test_no_picks_makes_no_call():
    meta = Meta()
    result = run(meta, picks=())
    assert meta.requests == []
    assert result == muse.Reasons((), muse.TEMPLATE, None)


# Failures fall back to templates


def test_timeout(monkeypatch):
    monkeypatch.setenv("MUSE_TIMEOUT_S", "0.05")
    get_settings.cache_clear()
    result = run(Meta(delay=1.0))
    assert_templates(result)
    assert result.usage is None


def test_transport_timeout():
    assert_templates(run(Meta(exc=httpx2.ReadTimeout("slow"))))


def test_connection_error():
    assert_templates(run(Meta(exc=httpx2.ConnectError("down"))))


@pytest.mark.parametrize("status", [400, 401, 402, 429, 500, 503])
def test_error_status_no_retry(status):
    meta = Meta(body={"error": {"message": "nope"}}, status=status)
    assert_templates(run(meta))
    assert len(meta.requests) == 1


def test_cap_hit_makes_no_request(monkeypatch):
    monkeypatch.setenv("MUSE_DAILY_CAP", "2")
    get_settings.cache_clear()
    meta = Meta()
    assert run(meta).source == muse.MUSE
    assert run(meta).source == muse.MUSE
    assert_templates(run(meta))
    assert len(meta.requests) == 2


def test_cap_resets_next_day():
    cap = muse.DailyCap()
    assert cap.take(1, date(2026, 10, 29))
    assert not cap.take(1, date(2026, 10, 29))
    assert cap.take(1, date(2026, 10, 30))


def test_missing_key_makes_no_request(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "")
    get_settings.cache_clear()
    meta = Meta()
    assert_templates(run(meta))
    assert meta.requests == []


@pytest.mark.parametrize("content", ["not json", "{}", '{"reasons": "x"}', '{"reasons": [1]}',
                                     "[]"])
def test_malformed_json(content):
    result = run(Meta(reply(content=content)))
    assert_templates(result)
    assert result.usage is not None  # the call was made and billed


def test_unreadable_body():
    assert_templates(run(Meta(body={"choices": []})))


def test_null_content():
    assert_templates(run(Meta({"choices": [{"message": {"content": None}}]})))


@pytest.mark.parametrize("lines", [
    {IDS[0]: "A.", IDS[1]: "B."},  # missing
    {IDS[0]: "A.", IDS[1]: "B.", IDS[2]: "C.", "node/99": "D."},  # extra
    {IDS[0]: "A.", IDS[1]: "B.", "node/99": "C."},  # wrong
])
def test_wrong_or_missing_ids(lines):
    assert_templates(run(Meta(reply(lines))))


def test_duplicate_id():
    content = json.dumps({"reasons": [{"id": IDS[0], "line": "A."}, {"id": IDS[0], "line": "B."},
                                      {"id": IDS[1], "line": "C."}]})
    assert_templates(run(Meta(reply(content=content))))


@pytest.mark.parametrize("bad", [
    "A healthy pick close by.",
    "Low-carb options nearby.",
    "Great protein bowls.",
    "Light on calories.",
    "Fits your diet.",
    "Nutritious and quick.",
])
def test_health_term_rejects_all(bad):
    assert_templates(run(Meta(reply({IDS[0]: "Fine.", IDS[1]: bad, IDS[2]: "Fine."}))))


@pytest.mark.parametrize("bad", ["", "   ", "Two\nlines.", "x" * (muse.MAX_REASON_CHARS + 1)])
def test_bad_line(bad):
    assert_templates(run(Meta(reply({IDS[0]: bad, IDS[1]: "B.", IDS[2]: "C."}))))


def test_non_string_line():
    content = json.dumps({"reasons": [{"id": i, "line": 5} for i in IDS]})
    assert_templates(run(Meta(reply(content=content))))


# Templates


def test_templates_are_short_and_clean():
    for picks in (PICKS, top3(craving="mexican")):
        for pick in picks:
            line = muse.template_reason(pick)
            assert 0 < len(line) <= muse.MAX_REASON_CHARS
            assert not muse.HEALTH_TERMS.search(line)
            assert "—" not in line


def test_template_mentions_craving():
    picks = top3(craving="mexican")
    assert muse.template_reason(picks[0]).startswith("Matches your Mexican craving")


def test_salads_bowls_label_is_not_a_health_term():
    assert not muse.HEALTH_TERMS.search(muse.CATEGORY_LABELS["salads_bowls"])


# Logs


def test_logs_never_hold_key_prompt_or_output(caplog):
    caplog.set_level(logging.DEBUG)
    run(Meta(reply({IDS[0]: "A healthy secret line.", IDS[1]: "B.", IDS[2]: "C."})))
    run(Meta(status=401, body={"error": {"message": "bad key LLM_1_test-meta-key"}}))
    assert TEST_KEY not in caplog.text
    assert "healthy secret" not in caplog.text
    assert "Place node/1" not in caplog.text
    assert "one-line reason" not in caplog.text
    assert "rejected: health_term" in caplog.text


def test_json_rejection_logs_shape_and_usage_not_content(caplog):
    caplog.set_level(logging.DEBUG)
    secret = '```json\n{"reasons": [{"id": "x", "line": "secret output line"'
    run(Meta(reply(content=secret)))
    assert "secret output line" not in caplog.text
    assert "rejected: json" in caplog.text
    assert "finish_reason=stop" in caplog.text
    assert f"len={len(secret)}" in caplog.text
    assert "fence=True brace=False" in caplog.text
    assert "prompt=500 completion=60 reasoning=10" in caplog.text



# Honesty: no past-visit claims for places the user has never been to (P1-13)

PAST_VISIT_LINES = ["Your familiar Thai spot.", "Your usual pick nearby.", "Try it again tonight.",
                    "Head back for dinner.", "Worth a return trip.", "A regular stop for you.",
                    "Your go-to for Thai."]


def visited_picks():
    """Top 3 where node/1 has two past meals (visits > 0); the others are unvisited."""
    stored = StoredPlace(id="node/1", name="Place node/1", lat=LAT + 400 / M_PER_DEG, lon=LON,
                         geoapify_categories=(), address="1 Main St")
    meals = tuple(PastMeal(place=stored, eaten_on=date(2026, 10, d), source="backfill",
                           category_id="thai", price_level=None) for d in (20, 25))
    context = Context(lat=LAT, lon=LON, local_date=date(2026, 10, 29), meal_slot="dinner",
                      is_weekend=False, search_radius_m=5000)
    history = History(prior=QuizPrior(favorites=frozenset({"thai", "pizza"})), meals=meals)
    candidates = [cand("node/1", "thai", 400), cand("node/2", "pizza", 800),
                  cand("node/3", "mexican", 1200), cand("node/4", "burgers", 3000)]
    return rank(candidates, context, history).top3


def test_evidence_has_no_slot_or_ranking_labels():
    meta = Meta()
    run(meta)
    picks = json.loads(json.loads(meta.requests[0].content)["messages"][1]["content"])["picks"]
    for pick in picks:
        assert "slot" not in pick
        assert not {"familiar", "discovery"} & set(pick["signals"])
        assert pick["visited_before"] is False
        assert pick["visits"] == 0


def test_prompt_states_the_never_visited_rule():
    assert "If visited_before is false" in muse.SYSTEM_PROMPT
    assert "familiar" in muse.SYSTEM_PROMPT


@pytest.mark.parametrize("bad", PAST_VISIT_LINES)
def test_past_visit_claim_on_unvisited_place_uses_templates(bad, caplog):
    caplog.set_level(logging.WARNING)
    assert_templates(run(Meta(reply({IDS[0]: bad, IDS[1]: "B.", IDS[2]: "C."}))))
    assert "rejected: past_visit_claim" in caplog.text


def test_past_visit_wording_is_fine_for_a_visited_place():
    picks = visited_picks()
    ids = [p.scored.place.id for p in picks]
    visited = next(p for p in picks if p.scored.evidence.visits > 0)
    lines = {i: ("You're back again, 0.2 mi away." if i == visited.scored.place.id else "New spot.")
             for i in ids}
    result = run(Meta(reply(lines)), picks=picks)
    assert result.source == muse.MUSE
    meta = Meta(reply(lines))
    run(meta, picks=picks)
    sent = json.loads(json.loads(meta.requests[0].content)["messages"][1]["content"])["picks"]
    by_id = {p["id"]: p for p in sent}
    assert by_id[visited.scored.place.id]["visited_before"] is True


def test_templates_never_claim_a_past_visit_for_unvisited_places():
    for picks in (PICKS, top3(craving="mexican"), visited_picks()):
        for pick in picks:
            if pick.scored.evidence.visits == 0:
                assert not muse.PAST_VISIT_TERMS.search(muse.template_reason(pick))
