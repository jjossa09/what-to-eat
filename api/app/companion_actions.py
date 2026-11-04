"""Bounded reads and confirmed action preparation. All writes use user-owned SQL RPCs."""

from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx2
from fastapi import HTTPException
from pydantic import Field, field_validator, model_validator

from app import conversation as c
from app import funnel


class MealDraft(c.Strict):
    category_id: str
    eaten_on: str
    timezone: str = Field(max_length=64)
    meal_slot: c.Slot | None = None
    dish: str | None = Field(default=None, max_length=60)
    place_id: str | None = Field(default=None, max_length=200)
    companion_ids: list[str] = Field(default_factory=list, max_length=20)
    solo: bool | None = None
    stars: int | None = Field(default=None, ge=1, le=5)
    allow_duplicate: bool = False

    _category = field_validator("category_id")(c.MealIntent.category_id.__func__)

    @model_validator(mode="after")
    def valid(self):
        from datetime import date

        try:
            zone = ZoneInfo(self.timezone)
            eaten = date.fromisoformat(self.eaten_on)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("invalid local date or timezone") from None
        if eaten.isoformat() != self.eaten_on or eaten > datetime.now(zone).date():
            raise ValueError("meal date must not be in the future")
        if self.solo is True and self.companion_ids:
            raise ValueError("solo cannot have companions")
        if len(set(self.companion_ids)) != len(self.companion_ids):
            raise ValueError("duplicate companion")
        for cid in self.companion_ids:
            UUID(cid)
        return self


class MealChanges(c.Strict):
    dish: str | None = Field(default=None, max_length=60)
    category_id: str | None = None
    stars: int | None = Field(default=None, ge=1, le=5)
    price_tap: int | None = Field(default=None, ge=1, le=4)
    price_amount: float | int | None = Field(default=None, ge=0, le=99999.99)
    solo: bool | None = None
    companion_ids: list[str] | None = Field(default=None, max_length=20)

    _category = field_validator("category_id")(c.MealIntent.category_id.__func__)

    @field_validator("companion_ids")
    @classmethod
    def ids(cls, value):
        if value is not None:
            if len(set(value)) != len(value):
                raise ValueError("duplicate companion")
            for cid in value:
                UUID(cid)
        return value


class EditDraft(c.Strict):
    meal_id: str
    revision: int = Field(ge=0)
    changes: MealChanges

    @field_validator("meal_id")
    @classmethod
    def meal_uuid(cls, value):
        return str(UUID(value))


class ProfileDraft(c.Strict):
    favorites: list[str] = Field(min_length=1, max_length=5)
    hard_nos: list[str] = Field(max_length=24)
    budget: int = Field(ge=1, le=4)
    mostly_solo: bool
    expected_updated_at: str = Field(max_length=64)
    source: Literal["chat", "profile"]

    @model_validator(mode="after")
    def valid(self):
        c.refine.known_categories(self.favorites)
        c.refine.known_categories(self.hard_nos)
        if set(self.favorites) & set(self.hard_nos):
            raise ValueError("favorite cannot be excluded")
        stamp = datetime.fromisoformat(self.expected_updated_at)
        if stamp.utcoffset() is None:
            raise ValueError("profile version must include timezone")
        return self


class Prepare(c.Strict):
    conversation_id: str
    client_key: str = Field(min_length=1, max_length=100)
    kind: Literal["log_meal", "rate_meal", "edit_meal", "preference_change"]
    arguments: dict = Field(max_length=12)

    @field_validator("conversation_id")
    @classmethod
    def conversation_uuid(cls, value):
        return str(UUID(value))

    def checked(self):
        schema = (MealDraft if self.kind == "log_meal" else ProfileDraft
                  if self.kind == "preference_change" else EditDraft)
        return schema.model_validate(self.arguments).model_dump(exclude_none=True)


class Confirmation(c.Strict):
    conversation_id: str
    action_id: str
    arguments: dict = Field(max_length=12)
    confirmed: Literal[True]

    _conversation = field_validator("conversation_id", "action_id")(
        Prepare.conversation_uuid.__func__)


async def rpc(name: str, body: dict, token: str, client: httpx2.AsyncClient):
    """Scalar RPC variant of the existing funnel transport; never exposes SQL messages."""
    try:
        response = await client.post(f"{funnel._base()}/rpc/{name}", json=body,
                                     headers=funnel._user_headers(token),
                                     timeout=funnel.get_settings().SUPABASE_TIMEOUT_S)
        if response.status_code >= 400:
            code = response.json().get("code") if response.content else None
            raise HTTPException(409 if code in ("40001", "23505") else 400,
                                "Action changed; reload" if code == "40001" else "Couldn't save")
        return response.json() if response.content else None
    except (httpx2.HTTPError, ValueError, funnel.FunnelError):
        raise HTTPException(503, "Couldn't save") from None


MEALS = ("id,revision,source,eaten_on,meal_slot,category_id,dish,went,ate_at,stars,price_tap,"
         "price_amount,solo,meal_companions(companion_id),places(id,name,unresolved)")
SLOTS = ("breakfast", "lunch", "dinner", "late")


def choose_meals(rows: list[dict], reference: str) -> dict:
    """Actual dates/slots only. An unknown slot or tie cannot establish a unique last meal."""
    if not rows:
        return {"meals": [], "ambiguous": False}
    if reference == "last":
        latest = max(r["eaten_on"] for r in rows)
        rows = [r for r in rows if r["eaten_on"] == latest]
        if all(r.get("meal_slot") in SLOTS for r in rows):
            last_slot = max(SLOTS.index(r["meal_slot"]) for r in rows)
            rows = [r for r in rows if SLOTS.index(r["meal_slot"]) == last_slot]
    rows = sorted(rows, key=lambda r: (r["eaten_on"],
                  SLOTS.index(r["meal_slot"]) if r.get("meal_slot") in SLOTS else -1,
                  r["id"]), reverse=True)
    return {"meals": rows[:3], "ambiguous": len(rows) > 1, "more": len(rows) > 3}


async def meals(user_id: str, token: str, client: httpx2.AsyncClient, *, reference="last",
                category: str | None = None, eaten_on: str | None = None, slot: str | None = None):
    params = {"select": MEALS, "user_id": f"eq.{user_id}",
              "or": "(source.in.(backfill,chat),and(source.eq.live,went.is.true))",
              "order": "eaten_on.desc,id.desc", "limit": 100}
    if category:
        if category not in c.refine.CRAVINGS:
            raise HTTPException(422, "Unknown food")
        params["category_id"] = f"eq.{category}"
        # A live pick's initial category is its restaurant, not confirmed eaten food.
        params["and"] = "(or(source.eq.backfill,ate_at.not.is.null))"
    if eaten_on:
        from datetime import date
        date.fromisoformat(eaten_on)
        params["eaten_on"] = f"eq.{eaten_on}"
    if slot:
        params["meal_slot"] = f"eq.{slot}"
    try:
        rows = await funnel._send(client, "GET", "meals", funnel._user_headers(token),
                                  params=params)
    except funnel.FunnelError:
        raise HTTPException(503, "Couldn't load meals") from None
    result = choose_meals(rows, reference)
    result["complete"] = len(rows) < 100
    if not result["complete"]:
        result["ambiguous"] = True
    return result


async def profile(user_id: str, token: str, client: httpx2.AsyncClient):
    try:
        rows = await funnel._send(client, "GET", "taste_profiles", funnel._user_headers(token),
                                 params={"select": "favorite_categories,hard_no_categories,"
                                         "budget_level,mostly_solo,updated_at",
                                         "user_id": f"eq.{user_id}", "limit": 1})
    except funnel.FunnelError:
        raise HTTPException(503, "Couldn't load profile") from None
    if not rows:
        raise HTTPException(404, "Finish your taste quiz first")
    return rows[0]
