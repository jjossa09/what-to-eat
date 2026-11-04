"""Muse Spark reasons (P1-12 Stage B, FR7, ML7): one call words the evidence for the top 3.

Language only. The picks, their order, and their evidence are fixed before this runs (R2).
The output is checked against the pick ids, length, and NFR5; if anything is off, every pick
gets its template reason instead. One call, no retries (NFR4). Never log the key, the prompt,
or the response text.

API: https://dev.meta.ai/docs/api-reference/chat-completions/create-chat-completion
"""

import asyncio
import json
import logging
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from time import perf_counter
from uuid import uuid4

import httpx2

from app.categories import OTHER
from app.config import MissingSettingError, get_settings
from app.places import verified_cuisine
from app.scoring import DISCOVERY, Pick

MUSE_URL = "https://api.meta.ai/v1/chat/completions"
MODEL = "muse-spark-1.3"  # Standard mode: Contributor mode lets Meta train on our prompts
REASONING_EFFORT = "minimal"  # lowest above "none"; reasons need no reasoning
MAX_COMPLETION_TOKENS = 1500  # a ceiling that includes reasoning tokens; room for both
MAX_REASON_CHARS = 90  # R1: one short line on a card
METERS_PER_MILE = 1609.344

MUSE, TEMPLATE = "muse", "template"

# Display names, as seeded in supabase/migrations.
CATEGORY_LABELS: dict[str, str] = {
    "burgers": "Burgers",
    "pizza": "Pizza",
    "mexican": "Mexican",
    "latin": "Latin",
    "chinese": "Chinese",
    "japanese_sushi": "Japanese/Sushi",
    "korean": "Korean",
    "thai": "Thai",
    "vietnamese": "Vietnamese",
    "indian": "Indian",
    "mediterranean": "Mediterranean",
    "italian": "Italian",
    "french": "French",
    "american_diner": "American/Diner",
    "bbq": "BBQ",
    "chicken_wings": "Chicken/Wings",
    "sandwiches": "Sandwiches",
    "seafood": "Seafood",
    "salads_bowls": "Salads/Bowls",
    "breakfast_brunch": "Breakfast/Brunch",
    "coffee_bakery": "Coffee/Bakery",
    "smoothies_juice": "Smoothies/Juice",
    "dessert": "Dessert",
    "pubs_bars": "Pubs/Bars",
}

# NFR5: no nutrition, calorie, health, or diet claims. Whole words, any case; a hit rejects
# the whole output.
HEALTH_TERMS = re.compile(
    r"\b(health\w*|nutri\w*|calori\w*|kcal|diet\w*|keto|paleo|vegan|low[\s-]?carb\w*|carbs?"
    r"|protein\w*|low[\s-]?fat|fat[\s-]?free|sugar[\s-]?free|gluten[\s-]?free|guilt[\s-]?free"
    r"|wholesome|detox\w*|superfood\w*|vitamin\w*|antioxidant\w*|lean|weight\w*"
    r"|clean eating|good for you)\b",
    re.IGNORECASE,
)

# Implies a past visit. Rejected for a place the user has never been to (visits = 0).
PAST_VISIT_TERMS = re.compile(
    r"\b(familiar|usual\w*|again|back|return\w*|regular\w*|go-to)\b", re.IGNORECASE
)

# A star rating (P2-10). Rejected for a pick with no stars_mean; for a rated pick, a stated
# number of stars must be its stars_mean (rounded to 0.1, or the whole number when exact).
RATING_TERMS = re.compile(r"\b(stars?|rated|ratings?)\b", re.IGNORECASE)
STAR_CLAIM = re.compile(r"(\d+(?:\.\d+)?)[\s-]*stars?\b", re.IGNORECASE)

# Ranking labels, not facts: never sent to Muse (the slot name is withheld too).
RANKING_SIGNALS = frozenset({"familiar", "discovery"})

SYSTEM_PROMPT = (
    "You write the one-line reason shown under each restaurant pick in a food app. "
    "Use only the evidence given; never invent menus, dishes, ratings, hours, or prices. "
    "If visited_before is false, the user has never been there: never imply they have "
    "(no familiar, usual, again, back, return, regular, go-to). "
    "times_had_category counts the user's past meals of that food anywhere, not visits to "
    "this place. "
    "Mention a star rating only from stars_mean, the user's own rating of that place; "
    "if stars_mean is absent, never mention stars or ratings. "
    "Do not repeat the place name. No health, nutrition, calorie, or diet claims. "
    f"Each reason is one plain sentence of at most {MAX_REASON_CHARS} characters. "
    "Return exactly one entry per pick id given."
)

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "pick_reasons",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "reasons": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, "line": {"type": "string"}},
                        "required": ["id", "line"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["reasons"],
            "additionalProperties": False,
        },
    },
}

logger = logging.getLogger(__name__)


class DailyCap:
    """Muse calls started per UTC day.

    Per-instance only: the count lives in process memory, so each serverless instance keeps
    its own count and a cold start resets it to 0. It does not cap spend across instances;
    the Meta spend alert is the backstop.
    """

    def __init__(self) -> None:
        self.day: date | None = None
        self.count = 0

    def take(self, limit: int, today: date) -> bool:
        if not self.available(limit, today):
            return False
        self.count += 1
        return True

    def available(self, limit: int, today: date) -> bool:
        if today != self.day:
            self.day, self.count = today, 0
        return self.count < limit


daily_cap = DailyCap()
takeaway_cap = DailyCap()


@dataclass(frozen=True)
class Usage:
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int | None


@dataclass(frozen=True)
class Reasons:
    lines: tuple[str, ...]  # one per pick, in pick order
    source: str  # "muse" or "template"
    usage: Usage | None  # None when no call was made or the response had no usage


class RejectedOutput(Exception):
    """Muse output failed a check. The message is a short code, never the output itself."""


# Templates -------------------------------------------------------------------


def format_distance(meters: int) -> str:
    return f"{max(0.1, meters / METERS_PER_MILE):.1f} mi"


def template_reason(pick: Pick) -> str:
    """Deterministic one-liner from the evidence; used whenever Muse's output is not."""
    e = pick.scored.evidence
    label = (CATEGORY_LABELS.get(e.category) if verified_cuisine(
        e.category, pick.scored.place.geoapify_categories, e.category) else None)
    if ("craving_match" in e.reasons and label
            and verified_cuisine(e.category, pick.scored.place.geoapify_categories, e.craving)):
        lead = f"Matches your {label} craving"
    elif e.visits > 1:
        lead = f"You've been here {e.visits} times"
    elif e.visits == 1:
        lead = "You've been here before"
    elif e.category_meals >= 2 and label:
        lead = f"{label}, you've had it {e.category_meals} times"
    elif "favorite_category" in e.reasons and label:
        lead = f"{label}, one of your favorites"
    elif pick.slot == DISCOVERY:
        lead = f"Something different: {label}" if label else "Something different"
    else:
        lead = f"{label} nearby" if label else "A spot nearby"
    return f"{lead}, {format_distance(e.distance_m)} away."


# Prompt ----------------------------------------------------------------------


def price_note(price_fit_reason: str | None) -> str:
    return {
        "price_fits": "fits their budget",
        "price_above_budget": "above their budget",
    }.get(price_fit_reason or "", "unknown")


def pick_evidence(pick: Pick) -> dict:
    """Only what the reason may cite. No coordinates, address, or user id."""
    place, e = pick.scored.place, pick.scored.evidence
    price = next((r for r in e.reasons if r.startswith("price_")), None)
    return {
        "id": place.id,
        "category": CATEGORY_LABELS.get(e.category) if e.category != OTHER else None,
        "cuisine_verified": e.category != OTHER and verified_cuisine(
            e.category, place.geoapify_categories, e.category),
        "distance": format_distance(e.distance_m),
        "craving": CATEGORY_LABELS.get(e.craving) if e.craving else None,
        "visited_before": e.visits > 0,
        "visits": e.visits,
        "days_since_last_visit": e.last_visit_days,
        "times_had_category": e.category_meals,
        "price": price_note(price),
        "signals": [r for r in e.reasons if r not in RANKING_SIGNALS],
    } | ({"stars_mean": stars_shown(e.stars_mean)} if e.stars_mean is not None else {})


def stars_shown(stars_mean: float) -> float:
    return round(stars_mean, 1)


def star_claims_ok(line: str, stars_mean: float | None) -> bool:
    """No rating words without a rating; a stated star count must match the rating."""
    if stars_mean is None:
        return not RATING_TERMS.search(line)
    shown = stars_shown(stars_mean)
    return all(float(n) == shown for n in STAR_CLAIM.findall(line))


# Enhancements are optional. A small factual vocabulary deliberately falls back rather
# than letting unconstrained prose invent a menu item or a cuisine synonym. Category
# words are added only from the provider-grounded category in the signed evidence.
REASON_WORDS = frozenset((
    "a an the this that it its is are was be been you your you've have had here there "
    "and or with for from of to in at by on one two three first second third new another "
    "near nearby close closer closest away mi mile miles m meters distance within only "
    "before times time visit visits visited last days day ago since often again usual "
    "favorite favorites category food choice pick spot place option different something "
    "rated rating stars star gave fits fit budget price known unknown own matches match "
    "craving reason fine good back based recorded stored just far but"
).split())


def grounded_reason(line: str, evidence: dict) -> bool:
    words = set(re.findall(r"[a-z]+(?:'[a-z]+)?", line.casefold()))
    category = (evidence.get("category") or "") if evidence.get("cuisine_verified") else ""
    allowed = REASON_WORDS | set(re.findall(r"[a-z]+", category.casefold()))
    allowed |= set(re.findall(r"[a-z]+", evidence["id"].casefold()))
    if words - allowed:
        return False
    if "craving" in words or "matches" in words or "match" in words:
        return bool(evidence.get("cuisine_verified")
                    and "craving_match" in evidence.get("signals", []))
    return True


def request_body(picks: tuple[Pick, ...]) -> dict:
    return evidence_request_body([pick_evidence(p) for p in picks])


def evidence_request_body(picks: list[dict]) -> dict:
    evidence = {"picks": picks}
    return {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(evidence, separators=(",", ":"))},
        ],
        "response_format": RESPONSE_FORMAT,
        "reasoning_effort": REASONING_EFFORT,
        "max_completion_tokens": MAX_COMPLETION_TOKENS,
        "temperature": 0,
    }


# Output check ----------------------------------------------------------------


FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_json(content: str):
    """The JSON value in content: as is, without a ``` fence, or the outermost {...} span."""
    text = FENCE.sub("", content.strip())
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(text[start : end + 1])


def check_output(
    content,
    ids: list[str],
    finish_reason: str | None = None,
    never_visited: frozenset[str] = frozenset(),
    stars: dict[str, float | None] | None = None,
    evidence: dict[str, dict] | None = None,
) -> dict[str, str]:
    """Muse content -> {id: line} for exactly these ids, or RejectedOutput with a code.

    stars: pick id -> stars_mean (None = unrated) to check rating claims; None skips it.
    """
    if finish_reason == "length":
        raise RejectedOutput("truncated")
    if not isinstance(content, str):
        raise RejectedOutput("no_content")
    try:
        entries = parse_json(content)["reasons"]
    except (ValueError, KeyError, TypeError):
        raise RejectedOutput("json") from None
    if not isinstance(entries, list) or not all(isinstance(x, dict) for x in entries):
        raise RejectedOutput("shape")
    got = [x.get("id") for x in entries]
    if len(got) != len(ids) or set(got) != set(ids):
        raise RejectedOutput("ids")
    lines: dict[str, str] = {}
    for entry in entries:
        line = entry.get("line")
        if not isinstance(line, str):
            raise RejectedOutput("line")
        # Our writing rule; reworded rather than rejected.
        line = re.sub(r"\s*—\s*", ", ", line.strip())
        if not line or "\n" in line or "\r" in line:
            raise RejectedOutput("line")
        if len(line) > MAX_REASON_CHARS:
            raise RejectedOutput("length")
        if HEALTH_TERMS.search(line):
            raise RejectedOutput("health_term")
        if entry["id"] in never_visited and PAST_VISIT_TERMS.search(line):
            raise RejectedOutput("past_visit_claim")
        if stars is not None and not star_claims_ok(line, stars.get(entry["id"])):
            raise RejectedOutput("rating_claim")
        if evidence is not None and not grounded_reason(line, evidence[entry["id"]]):
            raise RejectedOutput("unsupported_claim")
        lines[entry["id"]] = line
    return lines


def parse_usage(body: dict) -> Usage | None:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    def count(value):
        return type(value) is int and value >= 0

    if not all(count(usage.get(k)) for k in ("prompt_tokens", "completion_tokens")):
        return None
    details = usage.get("completion_tokens_details")
    if details is not None and not isinstance(details, dict):
        return None
    reasoning = details.get("reasoning_tokens") if details is not None else None
    if reasoning is not None and not count(reasoning):
        return None
    return Usage(
        prompt_tokens=usage["prompt_tokens"],
        completion_tokens=usage["completion_tokens"],
        reasoning_tokens=reasoning,
    )


def usage_note(usage: Usage | None) -> str:
    if usage is None:
        return "none"
    return (
        f"prompt={usage.prompt_tokens} completion={usage.completion_tokens} "
        f"reasoning={usage.reasoning_tokens}"
    )


# Call ------------------------------------------------------------------------


@dataclass
class CallTelemetry:
    """Only operational metadata; one row including the caller's validation result."""

    call_type: str
    effective_timeout_s: float
    token_cap: int
    correlation_id: str = field(default_factory=lambda: str(uuid4()))
    started: float = field(default_factory=perf_counter)
    status: int | None = None
    failure_class: str | None = None
    finish_reason: str | None = None
    usage: Usage | None = None
    emitted: bool = False

    def emit(self, validation_outcome: str) -> None:
        if self.emitted:
            return
        self.emitted = True
        row = {
            "call_type": self.call_type, "correlation_id": self.correlation_id,
            "model": MODEL, "effort": REASONING_EFFORT, "token_cap": self.token_cap,
            "effective_timeout_s": self.effective_timeout_s,
            "elapsed_ms": round((perf_counter() - self.started) * 1000, 1),
            "status": self.status, "failure_class": self.failure_class,
            "finish_reason": self.finish_reason, "validation_outcome": validation_outcome,
            "prompt_tokens": self.usage.prompt_tokens if self.usage else None,
            "completion_tokens": self.usage.completion_tokens if self.usage else None,
            "reasoning_tokens": self.usage.reasoning_tokens if self.usage else None,
        }
        try:
            logger.info("Muse call: %s", json.dumps(row, separators=(",", ":")))
        except Exception:
            pass  # Secondary telemetry must never fail the request.


@dataclass(frozen=True)
class Reply:
    content: object  # the message content; checked by the caller
    finish_reason: str | None
    usage: Usage | None
    telemetry: CallTelemetry | None = None


# Per-request failure metadata. Never stores language or identifiers, and preserves the
# shared call's existing Reply-or-None contract for older callers.
last_failure: ContextVar[str | None] = ContextVar("muse_failure", default=None)


def validation_done(reply: Reply, outcome: str) -> None:
    if reply.telemetry is not None:
        reply.telemetry.emit(outcome)


async def call(
    body: dict, *, client: httpx2.AsyncClient, call_type: str = "reasons",
    timeout_s: float | None = None,
) -> Reply | None:
    """One chat completion, shared by reasons and answer parsing (app/answers.py).

    None on any failure (not configured, daily cap, timeout, HTTP error, unreadable body),
    with a short warning. Never logs the key, the request, or the response text.
    """
    settings = get_settings()
    cap = {"reasons": min(12.0, settings.MUSE_TIMEOUT_S),
           "parse": min(10.0, settings.MUSE_PARSE_TIMEOUT_S),
           "takeaway": min(8.0, settings.MUSE_TAKEAWAY_TIMEOUT_S)}[call_type]
    timeout = max(0.0, min(cap, timeout_s)) if timeout_s is not None else max(0.0, cap)
    trace = CallTelemetry(call_type, timeout, body["max_completion_tokens"])

    def failed(code: str):
        last_failure.set(code)
        trace.failure_class = code
        trace.emit("not_run")
        return None

    last_failure.set(None)
    if timeout <= 0:
        return failed("RoundDeadline")
    try:
        api_key = settings.require("META_API_KEY")
    except MissingSettingError:
        logger.warning("Muse is not configured")
        return failed("NotConfigured")
    today = datetime.now(UTC).date()
    if call_type == "takeaway" and not takeaway_cap.available(
        min(10, settings.MUSE_TAKEAWAY_DAILY_CAP), today
    ):
        return failed("TakeawayCap")
    if not daily_cap.take(settings.MUSE_DAILY_CAP, today):
        logger.warning("Muse daily cap reached")
        return failed("DailyCap")
    if call_type == "takeaway":
        takeaway_cap.take(min(10, settings.MUSE_TAKEAWAY_DAILY_CAP), today)

    # Exceptions are dropped without their message: it can echo request details.
    try:
        async with asyncio.timeout(timeout):  # total, not per phase; includes the body read
            response = await client.post(
                MUSE_URL,
                json=body,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=timeout,
            )
    except (TimeoutError, httpx2.TimeoutException) as error:
        logger.warning("Muse timed out")
        return failed(type(error).__name__)
    except httpx2.HTTPError:
        logger.warning("Muse request failed")
        return failed("HTTPError")
    except asyncio.CancelledError:
        failed("Cancelled")
        raise
    trace.status = response.status_code
    if response.status_code != 200:
        logger.warning("Muse returned status %s", response.status_code)
        return failed("HTTPStatus")
    try:
        data = response.json()
        trace.usage = parse_usage(data) if isinstance(data, dict) else None
        choice = data["choices"][0]
        content = choice["message"]["content"]
        finish_reason = choice.get("finish_reason")
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("Muse returned an unreadable body")
        return failed("UnreadableBody")
    trace.finish_reason = finish_reason if finish_reason in (
        "stop", "length", "content_filter", "tool_calls", "function_call", None
    ) else "other"
    return Reply(content, finish_reason, trace.usage, trace)


def rejection_note(content, finish_reason: str | None, usage: Usage | None) -> str:
    """Shape facts about rejected output, never the content (it can echo the prompt)."""
    text = content.strip() if isinstance(content, str) else ""
    return (
        f"finish_reason={finish_reason} len={len(text)} fence={text.startswith('```')} "
        f"brace={text.startswith('{')} usage={usage_note(usage)}"
    )


async def write_reasons(
    picks: tuple[Pick, ...], *, client: httpx2.AsyncClient, timeout_s: float | None = None,
) -> Reasons:
    """One Muse call for all picks. Any failure gives the template reasons, never an error."""
    templates = tuple(template_reason(p) for p in picks)

    def fallback(usage: Usage | None = None) -> Reasons:
        return Reasons(templates, TEMPLATE, usage)

    if not picks:
        return fallback()
    reply = await call(request_body(picks), client=client, timeout_s=timeout_s)
    if reply is None:
        return fallback()
    content, finish_reason, usage = reply.content, reply.finish_reason, reply.usage
    ids = [p.scored.place.id for p in picks]
    try:
        never_visited = frozenset(p.scored.place.id for p in picks if p.scored.evidence.visits == 0)
        stars = {p.scored.place.id: p.scored.evidence.stars_mean for p in picks}
        lines = check_output(content, ids, finish_reason, never_visited, stars,
                             {p.scored.place.id: pick_evidence(p) for p in picks})
    except RejectedOutput as e:
        logger.warning(
            "Muse output rejected: %s (%s)", e, rejection_note(content, finish_reason, usage)
        )
        validation_done(reply, f"rejected:{e}")
        return fallback(usage)
    logger.info("Muse usage: %s", usage_note(usage))
    validation_done(reply, "accepted")
    # Our order, always (R2).
    return Reasons(tuple(lines[i] for i in ids), MUSE, usage)
