"""Insights reads (P2-04): independent of ranking history, under the caller's RLS."""

import asyncio
import logging
from dataclasses import replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from uuid import UUID

import httpx2
from fastapi import HTTPException, status

from app.categories import CATEGORY_IDS
from app.companion_metrics import Meal, aggregate
from app.config import MissingSettingError, get_settings
from app.insight_metrics import SLOTS
from app.insight_metrics import aggregate as charts

MEALS_LIMIT = 1000
COMPANION_PAGE_SIZE = 1000
MEALS_SELECT = (
    "id,user_id,source,eaten_on,day_of_week,category_id,ate_at,went,solo,"
    "meal_companions(companion_id),meal_slot,price_amount,price_level,price_tap,budget_level,distance_m"
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
    if source not in ("live", "backfill", "chat") or not isinstance(eaten, str):
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


def _level(value: object) -> int | None:
    if value is not None and (type(value) is not int or value not in (1, 2, 3, 4)):
        raise ValueError
    return value


def _measurements(meal: Meal, row: dict) -> tuple[Meal, bool]:
    """A bad added measurement never discards the meal's other evidence."""
    complete = True
    slot = row.get("meal_slot")
    if slot is not None and slot not in SLOTS:
        slot, complete = None, False
    paid = budget = distance = None
    try:
        if meal.source == "backfill":
            amount = row.get("price_amount")
            level = _level(row.get("price_level"))
            if amount is not None:
                if isinstance(amount, bool) or not isinstance(amount, (int, float, str)):
                    raise ValueError
                amount = Decimal(str(amount))
                if not amount.is_finite() or amount < 0 or level is None:
                    raise ValueError
                # Postgres generates this level from the amount, using the existing boundaries.
                paid = level
        else:
            paid = _level(row.get("price_tap"))
            if paid is None:
                budget = _level(row.get("budget_level"))
    except (ValueError, InvalidOperation):
        paid = budget = None
        complete = False
    try:
        distance = row.get("distance_m")
        if distance is not None and (type(distance) is not int or distance < 0):
            raise ValueError
    except ValueError:
        distance, complete = None, False
    return replace(meal, meal_slot=slot, paid_level=paid, budget_level=budget,
                   distance_m=distance), complete


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


async def response(user_id: str, token: str, as_of: date, *, client: httpx2.AsyncClient,
                   from_date: date | None = None, meal_slot: str | None = None) -> dict:
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
                **({"and": f"(eaten_on.gte.{from_date.isoformat()})"} if from_date else {}),
                **({"meal_slot": f"eq.{meal_slot}"} if meal_slot else {}),
                "or": "(source.eq.backfill,and(source.in.(live,chat),went.is.true))",
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
            meal, measurements_complete = _measurements(meal, row)
            complete = complete and measurements_complete
            meals[meal.id] = meal
        except (ValueError, KeyError, TypeError):
            complete = False
    return {"complete": complete, "cutoff_date": as_of.isoformat(),
            "companions": aggregate(companions, meals.values(), as_of),
            **charts(meals.values(), as_of)}
