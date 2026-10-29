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
# Meals that count (backfill, or live with went = true), each with its resolved place.
# Unresolved backfill places have no coordinates, so they never become candidates.
MEALS_SELECT = (
    "source,category_id,eaten_on,price_level,"
    "places!inner(id,name,lat,lon,geoapify_categories,address,unresolved)"
)
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


def parse_meal(row: dict) -> PastMeal | None:
    """One meals row -> PastMeal, or None if the place is unresolved or malformed."""
    place = row.get("places")
    if not isinstance(place, dict) or place.get("unresolved") is not False:
        return None
    pid, name, lat, lon = (place.get(k) for k in ("id", "name", "lat", "lon"))
    if not (isinstance(pid, str) and pid and isinstance(name, str) and name.strip()):
        return None
    if row.get("source") not in ("backfill", "live"):
        return None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in (lat, lon)):
        return None
    try:
        eaten_on = date.fromisoformat(row.get("eaten_on") or "")
    except (TypeError, ValueError):
        return None
    tags = place.get("geoapify_categories")
    category = row.get("category_id")
    return PastMeal(
        place=StoredPlace(
            id=pid,
            name=name.strip(),
            lat=float(lat),
            lon=float(lon),
            geoapify_categories=tuple(t for t in tags or [] if isinstance(t, str)),
            address=place.get("address") or None,
        ),
        eaten_on=eaten_on,
        source=row["source"],
        category_id=category if category in CATEGORY_IDS else None,
        price_level=_level(row.get("price_level")),
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
        "places.unresolved": "is.false",
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
