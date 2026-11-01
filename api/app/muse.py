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
from dataclasses import dataclass
from datetime import UTC, date, datetime

import httpx2

from app.categories import OTHER
from app.config import MissingSettingError, get_settings
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

# Ranking labels, not facts: never sent to Muse (the slot name is withheld too).
RANKING_SIGNALS = frozenset({"familiar", "discovery"})

SYSTEM_PROMPT = (
    "You write the one-line reason shown under each restaurant pick in a food app. "
    "Use only the evidence given; never invent menus, dishes, ratings, hours, or prices. "
    "If visited_before is false, the user has never been there: never imply they have "
    "(no familiar, usual, again, back, return, regular, go-to). "
    "Do not repeat the place name. No health, nutrition, calorie, or diet claims. "
    f"Each reason is one plain sentence of at most {MAX_REASON_CHARS} characters. "
    'Reply with JSON only: {"reasons": [{"id": "<pick id>", "line": "<reason>"}]}, '
    "exactly one entry per pick id given."
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
        if today != self.day:
            self.day, self.count = today, 0
        if self.count >= limit:
            return False
        self.count += 1
        return True


daily_cap = DailyCap()


@dataclass(frozen=True)
class Usage:
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int


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
    label = CATEGORY_LABELS.get(e.category)
    if "craving_match" in e.reasons and label:
        lead = f"Matches your {label} craving"
    elif e.visits > 1:
        lead = f"You've been here {e.visits} times"
    elif e.visits == 1:
        lead = "You've been here before"
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
        "name": place.name,
        "category": CATEGORY_LABELS.get(e.category) if e.category != OTHER else None,
        "distance": format_distance(e.distance_m),
        "craving": CATEGORY_LABELS.get(e.craving) if e.craving else None,
        "visited_before": e.visits > 0,
        "visits": e.visits,
        "days_since_last_visit": e.last_visit_days,
        "price": price_note(price),
        "signals": [r for r in e.reasons if r not in RANKING_SIGNALS],
    }


def request_body(picks: tuple[Pick, ...]) -> dict:
    evidence = {"picks": [pick_evidence(p) for p in picks]}
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
) -> dict[str, str]:
    """Muse content -> {id: line} for exactly these ids, or RejectedOutput with a code."""
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
        lines[entry["id"]] = line
    return lines


def parse_usage(body: dict) -> Usage | None:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("completion_tokens_details") or {}
    return Usage(
        prompt_tokens=int(usage.get("prompt_tokens") or 0),
        completion_tokens=int(usage.get("completion_tokens") or 0),
        reasoning_tokens=int(details.get("reasoning_tokens") or 0),
    )


def usage_note(usage: Usage | None) -> str:
    if usage is None:
        return "none"
    return (
        f"prompt={usage.prompt_tokens} completion={usage.completion_tokens} "
        f"reasoning={usage.reasoning_tokens}"
    )


# Call ------------------------------------------------------------------------


@dataclass(frozen=True)
class Reply:
    content: object  # the message content; checked by the caller
    finish_reason: str | None
    usage: Usage | None


async def call(body: dict, *, client: httpx2.AsyncClient) -> Reply | None:
    """One chat completion, shared by reasons and answer parsing (app/answers.py).

    None on any failure (not configured, daily cap, timeout, HTTP error, unreadable body),
    with a short warning. Never logs the key, the request, or the response text.
    """
    settings = get_settings()
    try:
        api_key = settings.require("META_API_KEY")
    except MissingSettingError:
        logger.warning("Muse is not configured")
        return None
    if not daily_cap.take(settings.MUSE_DAILY_CAP, datetime.now(UTC).date()):
        logger.warning("Muse daily cap reached")
        return None

    # Exceptions are dropped without their message: it can echo request details.
    try:
        async with asyncio.timeout(settings.MUSE_TIMEOUT_S):  # total, not per phase
            response = await client.post(
                MUSE_URL,
                json=body,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=settings.MUSE_TIMEOUT_S,
            )
    except (TimeoutError, httpx2.TimeoutException):
        logger.warning("Muse timed out")
        return None
    except httpx2.HTTPError:
        logger.warning("Muse request failed")
        return None
    if response.status_code != 200:
        logger.warning("Muse returned status %s", response.status_code)
        return None
    try:
        data = response.json()
        choice = data["choices"][0]
        content = choice["message"]["content"]
        finish_reason = choice.get("finish_reason")
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("Muse returned an unreadable body")
        return None
    return Reply(content, finish_reason, parse_usage(data) if isinstance(data, dict) else None)


def rejection_note(content, finish_reason: str | None, usage: Usage | None) -> str:
    """Shape facts about rejected output, never the content (it can echo the prompt)."""
    text = content.strip() if isinstance(content, str) else ""
    return (
        f"finish_reason={finish_reason} len={len(text)} fence={text.startswith('```')} "
        f"brace={text.startswith('{')} usage={usage_note(usage)}"
    )


async def write_reasons(picks: tuple[Pick, ...], *, client: httpx2.AsyncClient) -> Reasons:
    """One Muse call for all picks. Any failure gives the template reasons, never an error."""
    templates = tuple(template_reason(p) for p in picks)

    def fallback(usage: Usage | None = None) -> Reasons:
        return Reasons(templates, TEMPLATE, usage)

    if not picks:
        return fallback()
    reply = await call(request_body(picks), client=client)
    if reply is None:
        return fallback()
    content, finish_reason, usage = reply.content, reply.finish_reason, reply.usage
    ids = [p.scored.place.id for p in picks]
    try:
        never_visited = frozenset(p.scored.place.id for p in picks if p.scored.evidence.visits == 0)
        lines = check_output(content, ids, finish_reason, never_visited)
    except RejectedOutput as e:
        logger.warning(
            "Muse output rejected: %s (%s)", e, rejection_note(content, finish_reason, usage)
        )
        return fallback(usage)
    logger.info("Muse usage: %s", usage_note(usage))
    # Our order, always (R2).
    return Reasons(tuple(lines[i] for i in ids), MUSE, usage)
