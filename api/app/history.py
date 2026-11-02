"""User history for scoring (P1-12): quiz prior and counted meals with their places.

Reads go through PostgREST with the user's own JWT and the publishable (anon) key, so RLS
decides what comes back. The user_id filter is a second check. Two queries, run together.
Never log the token. Errors carry no upstream detail beyond the status code.
"""

import asyncio
import logging
from datetime import date

import httpx2

from app.categories import CATEGORY_IDS
from app.config import MissingSettingError, get_settings
from app.scoring import History, PastMeal, QuizPrior, StoredPlace

# PostgREST caps rows per request; a month of backfill plus live use is far below this.
MEALS_LIMIT = 1000
# Meals that count (backfill, or live with went = true) with their place. A left join, so
# meals at unresolved backfill places load too (place = None): they count for the cuisine
# model only, never as candidates, place stats, or distance.
MEALS_SELECT = (
    "source,category_id,eaten_on,meal_slot,is_weekend,dish,ate_at,price_level,"
    "places(id,name,lat,lon,geoapify_categories,address,unresolved)"
)
MEAL_SLOTS = frozenset({"breakfast", "lunch", "dinner", "late"})
PRIOR_SELECT = "favorite_categories,hard_no_categories,budget_level"
LEVELS = range(1, 5)

logger = logging.getLogger(__name__)


class HistoryError(Exception):
    pass


class HistoryNotConfigured(HistoryError):
    pass


class HistoryTimeout(HistoryError):
    pass


class HistoryUpstreamError(HistoryError):
    pass


def _categories(value) -> frozenset[str]:
    if not isinstance(value, list):
        return frozenset()
    return frozenset(c for c in value if c in CATEGORY_IDS)


def _level(value) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value in LEVELS:
        return value
    return None


def parse_prior(rows: list) -> QuizPrior:
    """No taste_profiles row (quiz not done) = empty prior."""
    row = rows[0] if rows and isinstance(rows[0], dict) else {}
    return QuizPrior(
        favorites=_categories(row.get("favorite_categories")),
        hard_nos=_categories(row.get("hard_no_categories")),
        budget_level=_level(row.get("budget_level")),
    )


def parse_place(place: dict) -> StoredPlace | None:
    """A resolved places row -> StoredPlace, or None if malformed."""
    pid, name, lat, lon = (place.get(k) for k in ("id", "name", "lat", "lon"))
    if not (isinstance(pid, str) and pid and isinstance(name, str) and name.strip()):
        return None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in (lat, lon)):
        return None
    tags = place.get("geoapify_categories")
    return StoredPlace(
        id=pid,
        name=name.strip(),
        lat=float(lat),
        lon=float(lon),
        geoapify_categories=tuple(t for t in tags or [] if isinstance(t, str)),
        address=place.get("address") or None,
    )


def parse_meal(row: dict) -> PastMeal | None:
    """One meals row -> PastMeal, or None if malformed. An unresolved (or missing) place gives
    place = None; a resolved place with bad fields drops the row."""
    if row.get("source") not in ("backfill", "live"):
        return None
    place_row = row.get("places")
    if place_row is None:
        place = None
    elif not isinstance(place_row, dict) or not isinstance(place_row.get("unresolved"), bool):
        return None
    elif place_row["unresolved"]:
        place = None
    elif (place := parse_place(place_row)) is None:
        return None
    try:
        eaten_on = date.fromisoformat(row.get("eaten_on") or "")
    except (TypeError, ValueError):
        return None
    category, slot, weekend = (row.get(k) for k in ("category_id", "meal_slot", "is_weekend"))
    dish = row.get("dish")
    return PastMeal(
        place=place,
        eaten_on=eaten_on,
        source=row["source"],
        category_id=category if category in CATEGORY_IDS else None,
        price_level=_level(row.get("price_level")),
        meal_slot=slot if slot in MEAL_SLOTS else None,
        is_weekend=weekend if isinstance(weekend, bool) else None,
        dish=dish.strip() or None if isinstance(dish, str) else None,
        food_answered=isinstance(row.get("ate_at"), str) and bool(row["ate_at"]),
    )


async def _get(client: httpx2.AsyncClient, url: str, params: dict, headers: dict, timeout: float):
    try:
        response = await client.get(url, params=params, headers=headers, timeout=timeout)
    except httpx2.TimeoutException:
        raise HistoryTimeout from None
    except httpx2.HTTPError:
        logger.warning("Supabase request failed")
        raise HistoryUpstreamError from None
    if response.status_code != 200:
        logger.warning("Supabase returned status %s", response.status_code)
        raise HistoryUpstreamError
    try:
        rows = response.json()
        if not isinstance(rows, list):
            raise TypeError
    except (ValueError, TypeError):
        logger.warning("Supabase returned an unreadable body")
        raise HistoryUpstreamError from None
    return rows


async def load(user_id: str, token: str, *, client: httpx2.AsyncClient) -> History:
    """The quiz prior and counted meals (newest first), read as the user."""
    settings = get_settings()
    try:
        base = settings.require("SUPABASE_URL").rstrip("/") + "/rest/v1"
        anon_key = settings.require("SUPABASE_ANON_KEY")
    except MissingSettingError:
        raise HistoryNotConfigured from None
    headers = {"apikey": anon_key, "Authorization": f"Bearer {token}"}
    timeout = settings.SUPABASE_TIMEOUT_S
    meals_params = {
        "select": MEALS_SELECT,
        "user_id": f"eq.{user_id}",
        "or": "(source.eq.backfill,went.is.true)",
        "order": "eaten_on.desc,created_at.desc",
        "limit": MEALS_LIMIT,
    }
    prior_params = {"select": PRIOR_SELECT, "user_id": f"eq.{user_id}", "limit": 1}
    prior_rows, meal_rows = await asyncio.gather(
        _get(client, f"{base}/taste_profiles", prior_params, headers, timeout),
        _get(client, f"{base}/meals", meals_params, headers, timeout),
    )
    meals = (parse_meal(r) for r in meal_rows if isinstance(r, dict))
    return History(prior=parse_prior(prior_rows), meals=tuple(m for m in meals if m))
