"""Small deterministic grammar for explicit meal dates, never inferred meal history."""

import re
from datetime import date, timedelta

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
DAY_NAMES = "|".join(WEEKDAYS)
EXPLICIT = re.compile(
    rf"\b(?:\d{{4}}-\d{{2}}-\d{{2}}|last\s+(?:{DAY_NAMES})|yesterday|today|last night)\b",
    re.IGNORECASE,
)
DATE_LANGUAGE = re.compile(
    rf"\b(?:{DAY_NAMES}|today|yesterday|tomorrow|tonight|last night|"
    r"january|february|march|april|may|june|july|august|september|october|november|december"
    r"|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{4}-\d{2}-\d{2}\b",
    re.IGNORECASE,
)
FUTURE = re.compile(rf"\b(?:tomorrow|next\s+(?:{DAY_NAMES}))\b", re.IGNORECASE)


def resolve(kind: str, value: str | None, today: date) -> date | None:
    if kind not in ("weekday", "last_weekday", "today", "yesterday", "iso"):
        raise ValueError("unsupported date kind")
    if kind == "weekday":
        return None  # a weekday without an occurrence is genuinely ambiguous
    if kind == "last_weekday":
        if value not in WEEKDAYS:
            raise ValueError("invalid weekday")
        days = (today.weekday() - WEEKDAYS.index(value)) % 7 or 7
        return today - timedelta(days=days)
    result = (today if kind == "today" else today - timedelta(days=1)
              if kind == "yesterday" else date.fromisoformat(value or ""))
    if result > today:
        raise ValueError("future meal")
    return result


def recover(
    text: str, kind: str | None, value: str | None, today: date,
) -> tuple[date | None, bool]:
    """Literal supported dates override an omitted or inconsistent model token.

    Distinct non-negated dates need clarification, even if the model picks one. Never
    replace a pending meal date from conversational context alone.
    """
    if not DATE_LANGUAGE.search(text):
        return None, False
    candidates: set[date] = set()
    negated = False
    invalid = bool(FUTURE.search(text))
    for match in EXPLICIT.finditer(text):
        prefix = text[max(0, match.start() - 80):match.start()]
        if (re.search(r"\b(?:not|wasn't|was not|didn't|did not|instead of|rather than)\s*$",
                      prefix, re.IGNORECASE) or re.search(
                r"\b(?:didn't|did not)\s+(?:eat|have|go|dine)\b[^.!?;]{0,40}$",
                prefix, re.IGNORECASE)):
            negated = True
            continue
        token = match.group().casefold()
        try:
            candidate = (resolve("last_weekday", token.split()[-1], today)
                         if token.startswith("last ") and token != "last night" else
                         resolve("yesterday", None, today) if token in ("yesterday", "last night")
                         else resolve("today", None, today) if token == "today"
                         else resolve("iso", token, today))
            candidates.add(candidate)
        except ValueError:
            invalid = True
    if invalid:
        return None, True
    if len(candidates) == 1:
        return next(iter(candidates)), False
    if len(candidates) > 1:
        return None, True
    if negated and not candidates:
        return None, True
    try:
        parsed = resolve(kind, value, today) if kind else None
    except ValueError:
        return None, True
    # Bare weekdays are not an occurrence, even if Muse supplied a plausible ISO date.
    if re.search(rf"\b(?:{DAY_NAMES})\b", text, re.IGNORECASE):
        return None, True
    return parsed, parsed is None
