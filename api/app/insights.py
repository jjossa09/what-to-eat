"""Insights reads (P2-04): independent of ranking history, under the caller's RLS."""

import asyncio
import logging
from datetime import date, datetime
from uuid import UUID

import httpx2
from fastapi import HTTPException, status

from app.categories import CATEGORY_IDS
from app.companion_metrics import Meal, aggregate
from app.config import MissingSettingError, get_settings

MEALS_LIMIT = 1000
COMPANION_PAGE_SIZE = 1000
MEALS_SELECT = (
    "id,user_id,source,eaten_on,day_of_week,category_id,ate_at,went,solo,"
    "meal_companions(companion_id)"
)
logger = logging.getLogger(__name__)


class ReadFailed(Exception):
    pass


async def _read(client, url, params, headers, timeout) -> list:
    try:
        response = await client.get(url, params=params, headers=headers, timeout=timeout)
        if not response.is_success:
            raise ReadFailed
        rows = response.json()
    except (httpx2.HTTPError, ValueError):
        raise ReadFailed from None
    if not isinstance(rows, list):
        raise ReadFailed
    return rows


def _uuid(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError
    return str(UUID(value))


def _owned_id(row: object, user_id: str) -> str:
    if not isinstance(row, dict) or row.get("user_id") != user_id:
        raise ValueError
    return _uuid(row["id"])


def _meal(row: dict, user_id: str) -> Meal:
    mid = _owned_id(row, user_id)
    source, eaten, day = row["source"], row["eaten_on"], row["day_of_week"]
    if source not in ("live", "backfill") or not isinstance(eaten, str):
        raise ValueError
    eaten_on = date.fromisoformat(eaten)
    if eaten_on.isoformat() != eaten or type(day) is not int or not 1 <= day <= 7:
        raise ValueError
    category, ate_at, went, solo = (row[k] for k in ("category_id", "ate_at", "went", "solo"))
    if category is not None and category not in CATEGORY_IDS:
        raise ValueError
    if any(value is not None and type(value) is not bool for value in (went, solo)):
        raise ValueError
    if ate_at is not None:
        if not isinstance(ate_at, str) or datetime.fromisoformat(ate_at).utcoffset() is None:
            raise ValueError
    links = row["meal_companions"]
    if not isinstance(links, list):
        raise ValueError
    ids = frozenset(_uuid(link["companion_id"]) for link in links)
    return Meal(mid, source, eaten_on, day, category, ate_at is not None, went, solo, ids)


async def _companions(client, base, user_id, headers, timeout) -> tuple[frozenset[str], bool]:
    ids: set[str] = set()
    complete, offset, previous = True, 0, None
    while True:
        rows = await _read(client, f"{base}/companions", {
            "select": "id,user_id", "user_id": f"eq.{user_id}", "order": "id.asc",
            "limit": COMPANION_PAGE_SIZE, "offset": offset,
        }, headers, timeout)
        # A server ignoring pagination must fail rather than repeat forever or hide names.
        if rows and rows == previous:
            raise ReadFailed
        for row in rows:
            try:
                cid = _owned_id(row, user_id)
                if cid in ids:
                    raise ValueError
                ids.add(cid)
            except (ValueError, KeyError, TypeError):
                complete = False
        if len(rows) < COMPANION_PAGE_SIZE:
            return frozenset(ids), complete
        offset += len(rows)
        previous = rows


async def response(user_id: str, token: str, as_of: date, *, client: httpx2.AsyncClient) -> dict:
    """Failed reads return no counts; malformed rows are omitted and mark incomplete data."""
    try:
        settings = get_settings()
        base = settings.require("SUPABASE_URL").rstrip("/") + "/rest/v1"
        headers = {"apikey": settings.require("SUPABASE_ANON_KEY"),
                   "Authorization": f"Bearer {token}"}
        timeout = settings.SUPABASE_TIMEOUT_S
        results = await asyncio.gather(
            _read(client, f"{base}/meals", {
                "select": MEALS_SELECT, "user_id": f"eq.{user_id}",
                "eaten_on": f"lte.{as_of.isoformat()}",
                "or": "(source.eq.backfill,and(source.eq.live,went.is.true))",
                "order": "eaten_on.desc,id.desc", "limit": MEALS_LIMIT,
            }, headers, timeout),
            _companions(client, base, user_id, headers, timeout),
            return_exceptions=True,
        )
        if any(isinstance(result, Exception) for result in results):
            raise ReadFailed
    except (ReadFailed, MissingSettingError, ValueError) as error:
        logger.warning("Insights read failed: %s", type(error).__name__)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Couldn't load insights") from None

    rows, (companions, complete) = results
    complete = complete and len(rows) < MEALS_LIMIT
    meals: dict[str, Meal] = {}
    for row in rows:
        try:
            meal = _meal(row, user_id)
            if meal.id in meals:
                raise ValueError
            meals[meal.id] = meal
        except (ValueError, KeyError, TypeError):
            complete = False
    return {"complete": complete, "cutoff_date": as_of.isoformat(),
            "companions": aggregate(companions, meals.values(), as_of)}
