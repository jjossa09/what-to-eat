"""Stateless, signed evidence for optional reasons. No ranking or funnel writes."""

import hashlib
import hmac
import json
import time
from collections import deque

import httpx2
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import funnel, muse
from app.config import MissingSettingError, get_settings

EXPIRY_S = 120
EMPTY = {"source": "template", "reasons": []}


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Preserve the exact signed serialization across Python and JavaScript numbers.
    payload: str = Field(min_length=1, max_length=16000)
    signature: str = Field(pattern=r"^[0-9a-f]{64}$")


def signature(payload: str, user_id: str) -> str:
    secret = get_settings().require("REASONS_SIGNING_SECRET")
    return hmac.new(secret.encode(), (user_id + "\n" + payload).encode(),
                    hashlib.sha256).hexdigest()


def envelope(user_id: str, session_id: str | None, round_: int | None, picks) -> dict | None:
    if not session_id or round_ is None or not picks:
        return None
    payload = json.dumps({"version": 1, "session_id": session_id, "round": round_,
                          "expires_at": int(time.time()) + EXPIRY_S,
                          "picks": [muse.pick_evidence(p) for p in picks]},
                         separators=(",", ":"), allow_nan=False)
    try:
        return {"payload": payload, "signature": signature(payload, user_id)}
    except MissingSettingError:
        return None


def verify(body: Envelope, user_id: str) -> dict:
    try:
        expected = signature(body.payload, user_id)
        if not hmac.compare_digest(body.signature, expected):
            raise ValueError
        payload = json.loads(body.payload)
        if payload["version"] != 1 or payload["expires_at"] <= time.time():
            raise ValueError
        return payload
    except (MissingSettingError, ValueError, KeyError, TypeError):
        raise HTTPException(400, "Invalid reasons envelope") from None


class UserRateLimit:
    """Sliding hour, per instance. Cold starts and other instances have separate limits."""

    def __init__(self):
        self.calls: dict[str, deque[float]] = {}

    def take(self, user_id: str) -> bool:
        now = time.monotonic()
        for user, calls in list(self.calls.items()):
            while calls and calls[0] <= now - 3600:
                calls.popleft()
            if not calls:
                del self.calls[user]
        calls = self.calls.setdefault(user_id, deque())
        if len(calls) >= 20:
            return False
        calls.append(now)
        return True


rate_limit = UserRateLimit()


async def response(body: Envelope, user_id: str, token: str, *, client: httpx2.AsyncClient):
    payload = verify(body, user_id)
    if not rate_limit.take(user_id):
        raise HTTPException(429, "Reasons rate limit reached")
    try:
        rows = await funnel._send(
            client, "GET", "sessions", funnel._user_headers(token),
            params={"select": "id", "id": f"eq.{payload['session_id']}",
                    "user_id": f"eq.{user_id}", "limit": "1"},
        )
    except funnel.FunnelError:
        return EMPTY
    if not rows or rows[0].get("id") != payload["session_id"]:
        raise HTTPException(404, "Session not found")
    picks = payload["picks"]
    reply = await muse.call(muse.evidence_request_body(picks), client=client)
    if reply is None:
        return EMPTY
    ids = [p["id"] for p in picks]
    try:
        lines = muse.check_output(
            reply.content, ids, reply.finish_reason,
            frozenset(p["id"] for p in picks if not p["visited_before"]),
            {p["id"]: p.get("stars_mean") for p in picks},
        )
    except muse.RejectedOutput as error:
        muse.validation_done(reply, f"rejected:{error}")
        return EMPTY
    muse.validation_done(reply, "accepted")
    return {"source": "muse", "reasons": [{"id": i, "line": lines[i]} for i in ids]}
