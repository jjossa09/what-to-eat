"""Funnel logging (P1-15, ML8, R3): sessions, shown cards, and the user's decisions.

User-owned rows (sessions, recommendation_events, meals) are written through PostgREST with
the user's own JWT and the publishable (anon) key, so RLS checks every write; user_id is also
set and filtered explicitly. The shared places cache is the one exception: upsert_places()
uses the service role, and no other function may. Never log the token or a response body.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime

import httpx2

from app.config import MissingSettingError, get_settings
from app.places import Candidate, distance_m
from app.scoring import Pick

logger = logging.getLogger(__name__)


class FunnelError(Exception):
    pass


class FunnelNotConfigured(FunnelError):
    pass


class FunnelTimeout(FunnelError):
    pass


class FunnelUpstreamError(FunnelError):
    pass


class NotFound(FunnelError):
    pass


class Conflict(FunnelError):
    pass


@dataclass(frozen=True)
class RoundRef:
    session_id: str
    round: int


@dataclass(frozen=True)
class NewSession:
    timezone: str
    local_date: date
    meal_slot: str
    lat: float
    lon: float
    craving: str | None
    budget_level: int | None
    radius_m: int | None
    search_radius_m: int


# REST plumbing ---------------------------------------------------------------


def _base() -> str:
    try:
        return get_settings().require("SUPABASE_URL").rstrip("/") + "/rest/v1"
    except MissingSettingError:
        raise FunnelNotConfigured from None


def _user_headers(token: str) -> dict[str, str]:
    try:
        anon_key = get_settings().require("SUPABASE_ANON_KEY")
    except MissingSettingError:
        raise FunnelNotConfigured from None
    return {"apikey": anon_key, "Authorization": f"Bearer {token}"}


async def _send(
    client: httpx2.AsyncClient,
    method: str,
    table: str,
    headers: dict[str, str],
    *,
    params: dict | None = None,
    json=None,
    prefer: str = "return=minimal",
) -> list:
    """One PostgREST call. Returns the rows (empty for return=minimal)."""
    try:
        response = await client.request(
            method,
            f"{_base()}/{table}",
            params=params,
            json=json,
            headers={**headers, "Prefer": prefer},
            timeout=get_settings().SUPABASE_TIMEOUT_S,
        )
    except httpx2.TimeoutException:
        raise FunnelTimeout from None
    except httpx2.HTTPError:
        raise FunnelUpstreamError from None
    if response.status_code == 409:
        raise Conflict
    if response.status_code not in (200, 201, 204):
        logger.warning("Supabase %s %s returned status %s", method, table, response.status_code)
        raise FunnelUpstreamError
    if response.status_code == 204 or not response.content:
        return []
    try:
        rows = response.json()
        if not isinstance(rows, list):
            raise TypeError
    except (ValueError, TypeError):
        raise FunnelUpstreamError from None
    return rows


def _now() -> str:
    return datetime.now(UTC).isoformat()


# Round -----------------------------------------------------------------------


async def open_round(
    user_id: str,
    token: str,
    session_id: str | None,
    new: NewSession,
    *,
    client: httpx2.AsyncClient,
) -> RoundRef:
    """Round 1 of a new session, or the next round of an existing session the user owns."""
    headers = _user_headers(token)
    if session_id is None:
        row = {
            "user_id": user_id,
            "timezone": new.timezone,
            "local_date": new.local_date.isoformat(),
            "meal_slot": new.meal_slot,
            "lat": new.lat,
            "lon": new.lon,
            "craving_category_id": new.craving,
            "budget_level": new.budget_level,
            "radius_m": new.radius_m,
            "search_radius_m": new.search_radius_m,
        }
        rows = await _send(client, "POST", "sessions", headers, params={"select": "id"},
                           json=row, prefer="return=representation")
        if not rows or not isinstance(rows[0], dict) or not rows[0].get("id"):
            raise FunnelUpstreamError
        return RoundRef(session_id=rows[0]["id"], round=1)

    params = {
        "select": "id,recommendation_events(round)",
        "id": f"eq.{session_id}",
        "user_id": f"eq.{user_id}",
        "recommendation_events.order": "round.desc",
        "recommendation_events.limit": 1,
    }
    rows = await _send(client, "GET", "sessions", headers, params=params)
    if not rows or not isinstance(rows[0], dict):
        raise NotFound
    events = rows[0].get("recommendation_events") or []
    last = events[0].get("round") if events and isinstance(events[0], dict) else 0
    return RoundRef(session_id=session_id, round=(last if isinstance(last, int) else 0) + 1)


async def upsert_places(candidates: list[Candidate], *, client: httpx2.AsyncClient) -> None:
    """Caches shown places in the shared places table (the events' place_id needs the row).

    The only use of the service role key in the API. Shared Geoapify data, no user data.
    """
    if not candidates:
        return
    try:
        service_key = get_settings().require("SUPABASE_SERVICE_ROLE_KEY")
    except MissingSettingError:
        raise FunnelNotConfigured from None
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    rows = [
        {
            "id": c.id,
            "name": c.name,
            "lat": c.lat,
            "lon": c.lon,
            "category_id": c.category,
            "geoapify_categories": c.geoapify_categories,
            "address": c.address,
            "unresolved": False,
            "updated_at": _now(),
        }
        for c in candidates
    ]
    await _send(client, "POST", "places", headers, params={"on_conflict": "id"}, json=rows,
                prefer="resolution=merge-duplicates,return=minimal")


async def log_shown(
    user_id: str,
    token: str,
    ref: RoundRef,
    picks: tuple[Pick, ...],
    reasons: tuple[str, ...],
    reasons_source: str,
    *,
    client: httpx2.AsyncClient,
) -> None:
    """One 'shown' row per card, in one insert."""
    if not picks:
        return
    rows = [
        {
            "user_id": user_id,
            "session_id": ref.session_id,
            "round": ref.round,
            "place_id": pick.scored.place.id,
            "event": "shown",
            "rank": pick.rank,
            "slot": pick.slot,
            "score": round(pick.scored.score, 4),
            "pick_reason": reason,
            "reasons_source": reasons_source,
        }
        for pick, reason in zip(picks, reasons, strict=True)
    ]
    await _send(client, "POST", "recommendation_events", _user_headers(token), json=rows)


# Decisions -------------------------------------------------------------------

SHOWN_SELECT = (
    "place_id,places(category_id,lat,lon),"
    "sessions(lat,lon,local_date,meal_slot,budget_level,solo,outcome)"
)


async def find_shown(
    user_id: str, token: str, session_id: str, round_: int, place_id: str,
    *, client: httpx2.AsyncClient,
) -> dict:
    """The shown card this event is about, with its place and session. NotFound if not shown."""
    params = {
        "select": SHOWN_SELECT,
        "user_id": f"eq.{user_id}",
        "session_id": f"eq.{session_id}",
        "round": f"eq.{round_}",
        "place_id": f"eq.{place_id}",
        "event": "eq.shown",
        "limit": 1,
    }
    rows = await _send(client, "GET", "recommendation_events", _user_headers(token),
                       params=params)
    if not rows or not isinstance(rows[0], dict):
        raise NotFound
    row = rows[0]
    if not isinstance(row.get("places"), dict) or not isinstance(row.get("sessions"), dict):
        raise FunnelUpstreamError
    return row


async def log_event(
    user_id: str, token: str, session_id: str, round_: int, place_id: str, event: str,
    fields: dict, *, client: httpx2.AsyncClient,
) -> None:
    row = {"user_id": user_id, "session_id": session_id, "round": round_,
           "place_id": place_id, "event": event, **fields}
    await _send(client, "POST", "recommendation_events", _user_headers(token), json=row)


async def close_session(
    user_id: str, token: str, session_id: str, outcome: str, *, client: httpx2.AsyncClient,
) -> None:
    """Sets the outcome once. Conflict if it is already set, NotFound if not the user's."""
    headers = _user_headers(token)
    rows = await _send(
        client, "PATCH", "sessions", headers,
        params={"id": f"eq.{session_id}", "user_id": f"eq.{user_id}", "outcome": "is.null",
                "select": "id"},
        json={"outcome": outcome, "ended_at": _now()},
        prefer="return=representation",
    )
    if rows:
        return
    existing = await _send(client, "GET", "sessions", headers,
                           params={"select": "id", "id": f"eq.{session_id}",
                                   "user_id": f"eq.{user_id}"})
    raise Conflict if existing else NotFound


async def log_pick(
    user_id: str, token: str, session_id: str, round_: int, place_id: str,
    *, client: httpx2.AsyncClient,
) -> None:
    """Picked: claims the session's outcome, then the event and the live meal (FR9, R3)."""
    shown = await find_shown(user_id, token, session_id, round_, place_id, client=client)
    session, place = shown["sessions"], shown["places"]
    if session.get("outcome") is not None:
        raise Conflict
    await close_session(user_id, token, session_id, "picked", client=client)
    meal = {
        "user_id": user_id,
        "source": "live",
        "session_id": session_id,
        "place_id": place_id,
        "category_id": place.get("category_id"),
        "eaten_on": session.get("local_date"),
        "meal_slot": session.get("meal_slot"),
        "picked_at": _now(),
        "solo": session.get("solo"),
        "budget_level": session.get("budget_level"),
        "distance_m": _distance(session, place),
    }
    await asyncio.gather(
        _send(client, "POST", "meals", _user_headers(token), json=meal),
        log_event(user_id, token, session_id, round_, place_id, "picked", {}, client=client),
    )


def _distance(session: dict, place: dict) -> int | None:
    coords = (session.get("lat"), session.get("lon"), place.get("lat"), place.get("lon"))
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in coords):
        return None
    return distance_m(*coords)
