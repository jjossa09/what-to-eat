"""P2-11: import data/backfill.csv into meals with source = 'backfill'. Local only, never deployed.

Run from api/:
    uv run python -m scripts.import_backfill [--csv data/backfill.csv] [--commit]

Dry run is the default: it validates the CSV, resolves places, signs in, and prints what would
be imported. --commit also sends every row to import_backfill() in one call. Relative paths are
from the repo root.

CSV: date,meal_slot,place,category,price,companions[,dish]. The category is the food eaten
(the same meaning as live meals since P1-17); it never relabels a place.

Auth: BACKFILL_EMAIL from api/.env, password typed at the prompt, then the user's JWT with the
anon key, so RLS and auth.uid() apply. No service role key. The token is never printed or saved.
"""

from __future__ import annotations

import argparse
import csv
import getpass
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import TextIO

import httpx2
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from app import places
from app.categories import OTHER, map_category, normalize
from app.config import ENV_FILE
from app.muse import CATEGORY_LABELS
from app.places import Candidate
from app.scoring import meal_context

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSV = Path("data/backfill.csv")
DEFAULT_RESOLUTIONS = Path("data/backfill_resolutions.json")

COLUMNS = ["date", "meal_slot", "place", "category", "price", "companions"]
OPTIONAL_COLUMNS = ["dish"]
SLOTS = ("breakfast", "lunch", "dinner", "late")
MAX_ROWS = 500  # import_backfill() cap
MAX_PRICE = Decimal("99999.99")  # numeric(7, 2)
MAX_DISH = 60  # same as the live food answer
MAX_PLACE_NAME = 200
MAX_COMPANION_NAME = 40  # same as the taste quiz
MAX_COMPANIONS = 20
SEARCH_LIMIT = 5
SEARCH_RADIUS_M = 50_000
TIMEOUT_S = 15.0  # sign-in and Supabase calls
# Geoapify's name= filter takes 3-10 s (measured 2026-11-01); without it, under 1 s.
GEOAPIFY_TIMEOUT = httpx2.Timeout(30.0, connect=5.0)
GEOAPIFY_ATTEMPTS = 2  # one retry on a timeout

ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
US_DATE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
PRICE = re.compile(r"\d+(\.\d{1,2})?")

# Slug or display name, any case -> slug. Other is handled separately (rejected).
CATEGORY_LOOKUP: dict[str, str] = {
    **{slug: slug for slug in CATEGORY_LABELS},
    **{label.lower(): slug for slug, label in CATEGORY_LABELS.items()},
}


class ImportSettings(BaseSettings):
    """What this script reads from api/.env. Never the service role key."""

    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    SUPABASE_URL: str | None = None
    SUPABASE_ANON_KEY: SecretStr | None = None
    GEOAPIFY_API_KEY: SecretStr | None = None
    BACKFILL_EMAIL: str | None = None
    BACKFILL_BIAS_LAT: float | None = None
    BACKFILL_BIAS_LON: float | None = None


class ImportFailed(Exception):
    """A config, network, or server problem. The message never contains the token or keys."""


# CSV parsing (pure, no network) ----------------------------------------------


@dataclass(frozen=True)
class Row:
    line: int
    eaten_on: date
    meal_slot: str
    place: str  # trimmed CSV spelling
    place_key: str  # normalized: lowercase, no accents
    category_id: str  # the food eaten
    price_amount: Decimal | None
    solo: bool | None
    companions: tuple[str, ...]
    dish: str | None


@dataclass(frozen=True)
class RowError:
    line: int
    message: str

    def __str__(self) -> str:
        return f"line {self.line}: {self.message}"


def clean(text: str | None) -> str:
    """NFC (so an accented letter is one character, as in Postgres) and trimmed."""
    return unicodedata.normalize("NFC", text or "").strip()


def local_today(now: datetime) -> date:
    """Today's meal date: before 05:00 it is still yesterday (the late-meal rule)."""
    return meal_context(now)[1]


def parse_date(value: str, today: date) -> date:
    value = clean(value)
    if m := ISO_DATE.fullmatch(value):
        y, mo, d = (int(g) for g in m.groups())
    elif m := US_DATE.fullmatch(value):
        mo, d, y = (int(g) for g in m.groups())
    else:
        raise ValueError(f"date {value!r} must be YYYY-MM-DD or M/D/YYYY")
    try:
        day = date(y, mo, d)
    except ValueError:
        raise ValueError(f"date {value!r} is not a real date") from None
    if day > today:
        raise ValueError(f"date {value!r} is in the future")
    return day


def parse_slot(value: str) -> str:
    slot = clean(value).lower()
    if not slot:
        raise ValueError("meal_slot is blank")
    if slot not in SLOTS:
        raise ValueError(f"meal_slot {value.strip()!r} must be one of {', '.join(SLOTS)}")
    return slot


def parse_category(value: str) -> str:
    key = clean(value).lower()
    if not key:
        raise ValueError("category is blank")
    if key == OTHER:
        raise ValueError("category 'other' is not allowed; use the food you ate")
    if key not in CATEGORY_LOOKUP:
        raise ValueError(f"category {value.strip()!r} is not a known category")
    return CATEGORY_LOOKUP[key]


def parse_price(value: str) -> Decimal | None:
    text = clean(value)
    if text.startswith("$"):
        text = text[1:].strip()
    if not text:
        if clean(value):
            raise ValueError("price is only a '$'")
        return None
    if not PRICE.fullmatch(text):
        raise ValueError(f"price {value.strip()!r} must be a number >= 0 with at most 2 decimals")
    amount = Decimal(text)
    if amount > MAX_PRICE:
        raise ValueError(f"price {value.strip()!r} is over {MAX_PRICE}")
    return amount


def parse_companions(value: str) -> tuple[bool | None, tuple[str, ...]]:
    """'solo' -> (True, ()); 'A;B' -> (False, names); blank -> (None, ())."""
    text = clean(value)
    if not text:
        return None, ()
    if text.lower() == "solo":
        return True, ()
    names: list[str] = []
    seen: set[str] = set()
    for raw in text.split(";"):
        name = clean(raw)
        if not name or name.lower() in seen:
            continue
        if name.lower() == "solo":
            raise ValueError("companions: 'solo' can't be mixed with names")
        if len(name) > MAX_COMPANION_NAME:
            raise ValueError(f"companion {name!r} is over {MAX_COMPANION_NAME} characters")
        seen.add(name.lower())
        names.append(name)
    if not names:
        raise ValueError("companions has no names")
    if len(names) > MAX_COMPANIONS:
        raise ValueError(f"more than {MAX_COMPANIONS} companions")
    return False, tuple(names)


def parse_dish(value: str | None) -> str | None:
    dish = clean(value)
    if not dish:
        return None
    if len(dish) > MAX_DISH:
        raise ValueError(f"dish is {len(dish)} characters (max {MAX_DISH})")
    return dish


def parse_place(value: str) -> tuple[str, str]:
    name = clean(value)
    if not name:
        raise ValueError("place is blank")
    if len(name) > MAX_PLACE_NAME:
        raise ValueError(f"place is over {MAX_PLACE_NAME} characters")
    key = normalize(name)
    if not key:
        raise ValueError(f"place {name!r} has no letters or digits")
    return name, key


def parse_row(line: int, raw: dict[str, str | None], today: date) -> tuple[Row | None, list[str]]:
    """One CSV row -> Row, or None plus every problem found."""
    errors: list[str] = []

    def field(fn: Callable, column: str, *extra):
        try:
            return fn(raw.get(column) or "", *extra)
        except ValueError as e:
            errors.append(str(e))
            return None

    eaten_on = field(parse_date, "date", today)
    slot = field(parse_slot, "meal_slot")
    place = field(parse_place, "place")
    category = field(parse_category, "category")
    price = field(parse_price, "price")
    companions = field(parse_companions, "companions")
    dish = field(parse_dish, "dish")
    if errors:
        return None, errors
    solo, names = companions
    name, key = place
    return Row(line, eaten_on, slot, name, key, category, price, solo, names, dish), []


def parse_csv(f: TextIO, today: date) -> tuple[list[Row], list[RowError]]:
    """Reads the whole file. Returns the good rows and every error, with line numbers."""
    reader = csv.DictReader(f)
    header = [clean(h).lower() for h in reader.fieldnames or []]
    if header not in (COLUMNS, COLUMNS + OPTIONAL_COLUMNS):
        expected = ",".join(COLUMNS)
        return [], [RowError(1, f"header must be {expected} (dish optional at the end)")]
    reader.fieldnames = header

    rows: list[Row] = []
    errors: list[RowError] = []
    seen: dict[tuple[date, str, str], int] = {}
    for raw in reader:
        line = reader.line_num
        if None in raw:
            errors.append(RowError(line, "too many columns"))
            continue
        if all(not clean(v) for v in raw.values()):
            continue  # blank line (Excel leaves these)
        row, problems = parse_row(line, raw, today)
        errors.extend(RowError(line, p) for p in problems)
        if row is None:
            continue
        dup = (row.eaten_on, row.meal_slot, row.place_key)
        if dup in seen:
            errors.append(RowError(line, f"same date, slot, and place as line {seen[dup]}"))
            continue
        seen[dup] = line
        rows.append(row)
    return rows, errors


# Place resolutions -----------------------------------------------------------


@dataclass(frozen=True)
class Resolved:
    id: str
    name: str
    lat: float
    lon: float
    address: str | None
    geoapify_categories: tuple[str, ...]

    @property
    def category_id(self) -> str:
        return map_category(self.geoapify_categories, self.name)

    @classmethod
    def from_candidate(cls, c: Candidate) -> Resolved:
        return cls(c.id, c.name, c.lat, c.lon, c.address, tuple(c.geoapify_categories))


@dataclass(frozen=True)
class Unresolved:
    name: str  # the first CSV spelling, kept so lower(name) matches across runs

    @property
    def category_id(self) -> str:
        return map_category([], self.name)  # from the name only, never from the CSV


Resolution = Resolved | Unresolved


def resolution_to_json(r: Resolution) -> dict:
    if isinstance(r, Unresolved):
        return {"unresolved": True, "name": r.name}
    return {
        "id": r.id,
        "name": r.name,
        "lat": r.lat,
        "lon": r.lon,
        "address": r.address,
        "geoapify_categories": list(r.geoapify_categories),
    }


def resolution_from_json(data) -> Resolution:
    if not isinstance(data, dict) or not isinstance(data.get("name"), str) or not data["name"]:
        raise ValueError("entry needs a name")
    if data.get("unresolved") is True:
        return Unresolved(data["name"])
    pid, lat, lon = data.get("id"), data.get("lat"), data.get("lon")
    tags = data.get("geoapify_categories") or []
    address = data.get("address")
    if not isinstance(pid, str) or not pid or pid.startswith("unresolved:"):
        raise ValueError("bad id")
    for v in (lat, lon):
        if not isinstance(v, int | float) or isinstance(v, bool):
            raise ValueError("bad coordinates")
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise ValueError("bad geoapify_categories")
    if address is not None and not isinstance(address, str):
        raise ValueError("bad address")
    return Resolved(pid, data["name"], float(lat), float(lon), address, tuple(tags))


def load_resolutions(path: Path) -> dict[str, Resolution]:
    """Normalized place name -> saved choice. A missing file is empty."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ImportFailed(f"{path} is not valid JSON: {e}") from None
    if not isinstance(data, dict):
        raise ImportFailed(f"{path} must be a JSON object")
    out: dict[str, Resolution] = {}
    for key, entry in data.items():
        try:
            out[key] = resolution_from_json(entry)
        except ValueError as e:
            raise ImportFailed(f"{path}: entry {key!r}: {e}") from None
    return out


def save_resolutions(path: Path, resolutions: dict[str, Resolution]) -> None:
    """Writes the whole file atomically (temp file + rename)."""
    data = {k: resolution_to_json(v) for k, v in sorted(resolutions.items())}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def clear_match(csv_name: str, candidates: list[Candidate]) -> Candidate | None:
    """The one result whose normalized name equals the CSV name; None if zero or several."""
    key = normalize(csv_name)
    matches = [c for c in candidates if normalize(c.name) == key]
    return matches[0] if len(matches) == 1 else None


def backfill_key(row: Row, resolution: Resolution) -> str:
    """Stable across runs: the place id, or the normalized name for unresolved places."""
    pid = resolution.id if isinstance(resolution, Resolved) else f"unresolved:{row.place_key}"
    return f"{row.eaten_on.isoformat()}|{row.meal_slot}|{pid}"


# Network ---------------------------------------------------------------------


def search_places(
    client: httpx2.Client, api_key: str, name: str, lat: float, lon: float
) -> list[Candidate]:
    """One Geoapify search (retried once on a timeout), parsed with the live app's
    parse_feature, so ids and categories match."""
    params = {
        "name": name,
        "categories": places.CATEGORIES,
        "filter": f"circle:{lon},{lat},{SEARCH_RADIUS_M}",
        "bias": f"proximity:{lon},{lat}",
        "limit": SEARCH_LIMIT,
        "apiKey": api_key,
    }
    print(f'Searching "{name}"...')
    for attempt in range(1, GEOAPIFY_ATTEMPTS + 1):
        # Exceptions are re-raised without their message: it can include the URL (apiKey).
        try:
            resp = client.get(places.PLACES_URL, params=params, timeout=GEOAPIFY_TIMEOUT)
            break
        except httpx2.TimeoutException as e:
            if attempt == GEOAPIFY_ATTEMPTS:
                raise ImportFailed(f"Geoapify request failed ({type(e).__name__})") from None
            print(f'Geoapify is slow, retrying "{name}"...')
        except httpx2.HTTPError as e:
            raise ImportFailed(f"Geoapify request failed ({type(e).__name__})") from None
    if resp.status_code != 200:
        raise ImportFailed(f"Geoapify returned {resp.status_code}")
    out: list[Candidate] = []
    seen: set[str] = set()
    for feature in resp.json().get("features") or []:
        c = places.parse_feature(feature, lat, lon)
        if c and c.id not in seen:
            seen.add(c.id)
            out.append(c)
    return out[:SEARCH_LIMIT]


def ask_choice(
    csv_name: str,
    lines: list[int],
    candidates: list[Candidate],
    ask: Callable[[str], str],
) -> Candidate | str | None:
    """Returns the picked candidate, a new search name (str), or None for unresolved."""
    print(f'\n"{csv_name}" (line {", ".join(map(str, lines))})')
    if not candidates:
        while True:
            answer = clean(ask("  No results. Type another search name, or u for unresolved: "))
            if answer.lower() == "u":
                return None
            if answer:
                return answer
    for i, c in enumerate(candidates, 1):
        print(f"  {i}. {c.name} | {c.address or 'no address'} | {c.distance_m / 1000:.1f} km")
    while True:
        answer = clean(ask(f"  Pick 1-{len(candidates)}, or u for unresolved: ")).lower()
        if answer == "u":
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(candidates):
            return candidates[int(answer) - 1]


def resolve_places(
    rows: list[Row],
    resolutions: dict[str, Resolution],
    save: Callable[[dict[str, Resolution]], None],
    search: Callable[[str], list[Candidate]] | None,
    ask: Callable[[str], str] = input,
) -> dict[str, Resolution]:
    """Resolves each normalized name once: saved choice, else clear match, else asks."""
    lines: dict[str, list[int]] = {}
    spelling: dict[str, str] = {}
    for row in rows:
        lines.setdefault(row.place_key, []).append(row.line)
        spelling.setdefault(row.place_key, row.place)
    for key, csv_name in spelling.items():
        if key in resolutions:
            continue
        if search is None:
            raise ImportFailed("Geoapify is not configured")
        query = csv_name
        while True:
            candidates = search(query)
            match = clear_match(csv_name, candidates)
            if match:
                address = match.address or "no address"
                print(f'"{csv_name}" -> {match.name} | {address} (clear match)')
                choice: Candidate | str | None = match
            else:
                choice = ask_choice(csv_name, lines[key], candidates, ask)
            if isinstance(choice, str):
                query = choice
                continue
            break
        resolutions[key] = Resolved.from_candidate(choice) if choice else Unresolved(csv_name)
        save(resolutions)
    return resolutions


def sign_in(client: httpx2.Client, url: str, anon_key: str, email: str, password: str) -> str:
    try:
        resp = client.post(
            f"{url}/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": anon_key},
            json={"email": email, "password": password},
        )
    except httpx2.HTTPError as e:
        raise ImportFailed(f"sign-in request failed ({type(e).__name__})") from None
    body = _json(resp)
    if resp.status_code != 200 or not isinstance(body.get("access_token"), str):
        detail = body.get("error_description") or body.get("msg") or ""
        detail = detail if isinstance(detail, str) else ""
        raise ImportFailed(f"sign-in failed ({resp.status_code}) {detail}".strip())
    return body["access_token"]


def _json(resp) -> dict:
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _rest_headers(anon_key: str, token: str) -> dict[str, str]:
    return {"apikey": anon_key, "Authorization": f"Bearer {token}"}


def _rest_get(client: httpx2.Client, url: str, headers: dict, params: dict) -> list:
    try:
        resp = client.get(url, headers=headers, params=params)
    except httpx2.HTTPError as e:
        raise ImportFailed(f"Supabase request failed ({type(e).__name__})") from None
    if resp.status_code != 200:
        raise ImportFailed(f"Supabase returned {resp.status_code} {_server_message(resp)}".strip())
    return resp.json()


def _server_message(resp) -> str:
    message = _json(resp).get("message")
    return message if isinstance(message, str) else ""


def existing_keys(client: httpx2.Client, base: str, headers: dict) -> set[str]:
    """The signed-in user's backfill keys (RLS: own meals only)."""
    rows = _rest_get(client, f"{base}/rest/v1/meals", headers, {
        "select": "backfill_key", "source": "eq.backfill", "backfill_key": "not.is.null",
    })
    return {r["backfill_key"] for r in rows}


def existing_companions(client: httpx2.Client, base: str, headers: dict) -> set[str]:
    rows = _rest_get(client, f"{base}/rest/v1/companions", headers, {"select": "name"})
    return {r["name"].lower() for r in rows}


def call_import(client: httpx2.Client, base: str, headers: dict, payload: list[dict]) -> dict:
    try:
        resp = client.post(f"{base}/rest/v1/rpc/import_backfill", headers=headers,
                           json={"p_rows": payload})
    except httpx2.HTTPError as e:
        raise ImportFailed(f"import request failed ({type(e).__name__})") from None
    if resp.status_code != 200:
        raise ImportFailed(f"import failed ({resp.status_code}) {_server_message(resp)}".strip())
    return resp.json()


# Payload and output ----------------------------------------------------------


def place_payload(r: Resolution) -> dict:
    if isinstance(r, Unresolved):
        return {"unresolved": True, "name": r.name, "category_id": r.category_id}
    return {
        "id": r.id,
        "name": r.name,
        "lat": r.lat,
        "lon": r.lon,
        "address": r.address,
        "geoapify_categories": list(r.geoapify_categories),
        "category_id": r.category_id,
    }


def row_payload(row: Row, resolution: Resolution) -> dict:
    return {
        "eaten_on": row.eaten_on.isoformat(),
        "meal_slot": row.meal_slot,
        "category_id": row.category_id,
        "price_amount": None if row.price_amount is None else str(row.price_amount),
        "solo": row.solo,
        "companions": list(row.companions),
        "dish": row.dish,
        "backfill_key": backfill_key(row, resolution),
        "place": place_payload(resolution),
    }


def duplicate_keys(rows: list[Row], resolutions: dict[str, Resolution]) -> list[RowError]:
    """Different CSV names that resolved to the same place on the same date and slot."""
    seen: dict[str, int] = {}
    errors = []
    for row in rows:
        key = backfill_key(row, resolutions[row.place_key])
        if key in seen:
            errors.append(RowError(row.line, f"same date, slot, and place as line {seen[key]} "
                                             "(after resolving places)"))
        else:
            seen[key] = row.line
    return errors


def describe(row: Row, resolution: Resolution, status: str) -> str:
    place = (f"{resolution.name} ({resolution.id})" if isinstance(resolution, Resolved)
             else f"{resolution.name} (unresolved)")
    price = "no price" if row.price_amount is None else f"${row.price_amount}"
    if row.solo is None:
        who = "people unknown"
    else:
        who = "solo" if row.solo else "with " + ", ".join(row.companions)
    dish = f" | dish: {row.dish}" if row.dish else ""
    return (f"line {row.line}: {row.eaten_on} {row.meal_slot} | {place} | {row.category_id} | "
            f"{price} | {who}{dish} | {status}")


def summary(
    rows: list[Row],
    resolutions: dict[str, Resolution],
    known_keys: set[str],
    known_companions: set[str],
) -> dict[str, int]:
    new_rows = [r for r in rows if backfill_key(r, resolutions[r.place_key]) not in known_keys]
    used = {r.place_key for r in rows}
    to_create = {n.lower() for r in new_rows for n in r.companions} - known_companions
    return {
        "new": len(new_rows),
        "imported": len(rows) - len(new_rows),
        "resolved": sum(isinstance(resolutions[k], Resolved) for k in used),
        "unresolved": sum(isinstance(resolutions[k], Unresolved) for k in used),
        "companions": len(to_create),
        "blank_prices": sum(r.price_amount is None for r in rows),
    }


# Main ------------------------------------------------------------------------


def repo_path(path: Path) -> Path:
    return path if path.is_absolute() else REPO_ROOT / path


def need(settings: ImportSettings, *names: str) -> None:
    missing = [n for n in names if getattr(settings, n) in (None, "")]
    if missing:
        raise ImportFailed(f"missing in api/.env: {', '.join(missing)}")


def secret(value: SecretStr | None) -> str:
    return value.get_secret_value() if value else ""


def print_errors(errors: Iterable[RowError]) -> None:
    for e in sorted(errors, key=lambda e: e.line):
        print(e, file=sys.stderr)


def run(csv_path: Path, resolutions_path: Path, commit: bool) -> int:
    # 1. Validate the whole CSV before any network call.
    try:
        with csv_path.open(encoding="utf-8-sig", newline="") as f:
            rows, errors = parse_csv(f, local_today(datetime.now()))
    except OSError as e:
        raise ImportFailed(f"can't read {csv_path}: {e.strerror}") from None
    if errors:
        print_errors(errors)
        print(f"{len(errors)} problem(s) in {csv_path}. Nothing was imported.", file=sys.stderr)
        return 1
    if not rows:
        print("No rows to import.")
        return 0
    if len(rows) > MAX_ROWS:
        raise ImportFailed(f"{len(rows)} rows; the import takes at most {MAX_ROWS}")

    settings = ImportSettings()
    need(settings, "SUPABASE_URL", "SUPABASE_ANON_KEY", "BACKFILL_EMAIL")
    resolutions = load_resolutions(resolutions_path)

    with httpx2.Client(timeout=TIMEOUT_S) as client:
        # 2. Places: saved choices first, then Geoapify plus a prompt.
        search: Callable[[str], list[Candidate]] | None = None
        if any(r.place_key not in resolutions for r in rows):
            need(settings, "GEOAPIFY_API_KEY", "BACKFILL_BIAS_LAT", "BACKFILL_BIAS_LON")
            key, lat, lon = (secret(settings.GEOAPIFY_API_KEY), settings.BACKFILL_BIAS_LAT,
                             settings.BACKFILL_BIAS_LON)
            search = lambda name: search_places(client, key, name, lat, lon)  # noqa: E731
        resolve_places(rows, resolutions, lambda r: save_resolutions(resolutions_path, r), search)

        dup_errors = duplicate_keys(rows, resolutions)
        if dup_errors:
            print_errors(dup_errors)
            print("Nothing was imported.", file=sys.stderr)
            return 1

        # 3. Sign in as the user (RLS applies). The token stays in memory only.
        base = settings.SUPABASE_URL.rstrip("/")
        anon = secret(settings.SUPABASE_ANON_KEY)
        password = getpass.getpass(f"\nPassword for {settings.BACKFILL_EMAIL}: ")
        headers = _rest_headers(anon, sign_in(client, base, anon, settings.BACKFILL_EMAIL,
                                              password))
        del password
        known_keys = existing_keys(client, base, headers)
        known_companions = existing_companions(client, base, headers)

        # 4. What would be imported.
        print()
        for row in rows:
            res = resolutions[row.place_key]
            status = "already imported" if backfill_key(row, res) in known_keys else "new"
            print(describe(row, res, status))
        s = summary(rows, resolutions, known_keys, known_companions)
        print(f"\nMeals: {s['new']} new, {s['imported']} already imported")
        print(f"Places: {s['resolved']} resolved, {s['unresolved']} unresolved")
        print(f"Companions to create: {s['companions']}")
        print(f"Blank prices: {s['blank_prices']}")

        if not commit:
            print("\nDry run: nothing was written. Re-run with --commit to import.")
            return 0

        # 5. One RPC call, one transaction.
        payload = [row_payload(r, resolutions[r.place_key]) for r in rows]
        counts = call_import(client, base, headers, payload)
        print("\nImported: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import the backfill CSV (dry run by default).")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--commit", action="store_true", help="write to Supabase")
    args = parser.parse_args(argv)
    try:
        return run(repo_path(args.csv), repo_path(DEFAULT_RESOLUTIONS), args.commit)
    except ImportFailed as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nStopped. Choices made so far are saved.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
