from __future__ import annotations

import os
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, Request

from ..ai import chat, generate_insights, parse_request
from ..auth import current_user
from ..errors import ApiError, as_dict, read_json
from ..insights import summarize_week
from ..timeutil import is_valid_time_zone, local_parts, utcnow

router = APIRouter(prefix="/api/ai")

# Simple per-user sliding-window limiter so the AI endpoints can't run up a bill.
WINDOW_SECONDS = 60
_calls: dict[str, list[float]] = defaultdict(list)


def rate_limit(user: dict = Depends(current_user)) -> dict:
    max_calls = int(os.environ.get("AI_RATE_LIMIT_PER_MIN") or 15)
    now = time.monotonic()
    recent = [t for t in _calls[user["id"]] if now - t < WINDOW_SECONDS]
    if len(recent) >= max_calls:
        raise ApiError(429, "Too many AI requests. Try again in a minute.")
    recent.append(now)
    _calls[user["id"]] = recent
    return user


def build_context(body: dict, user: dict, store) -> dict:
    tz = body.get("timeZone")
    if not is_valid_time_zone(tz):
        tz = (user.get("preferences") or {}).get("timeZone") or "UTC"
    now = utcnow()
    p = local_parts(now, tz)
    return {
        "time_zone": tz,
        "today": p["date"],
        "weekday": p["weekdayIndex"],
        "now_time": p["time"],
        "week_summary": summarize_week(store.list_blocks(user["id"]), now=now, time_zone=tz),
    }


@router.post("/parse")
async def parse(request: Request, user: dict = Depends(rate_limit)):
    body = as_dict(await read_json(request))
    text = str(body.get("text") if body.get("text") is not None else "").strip()
    if not text:
        raise ApiError(400, "Describe the quiet hours you want")
    if len(text) > 1000:
        raise ApiError(400, "Please keep requests under 1000 characters")
    return await parse_request(text, build_context(body, user, request.app.state.store))


@router.post("/chat")
async def chat_route(request: Request, user: dict = Depends(rate_limit)):
    body = as_dict(await read_json(request))
    raw = body.get("messages") if isinstance(body.get("messages"), list) else []
    # Keep only well-formed text turns, trimmed, alternating, starting with a user turn.
    history: list[dict] = []
    for m in raw[-20:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        content = str(m.get("content") if m.get("content") is not None else "").strip()[:2000]
        if not content:
            continue
        if history and history[-1]["role"] == m["role"]:
            history[-1]["content"] += f"\n{content}"
        else:
            history.append({"role": m["role"], "content": content})
    while history and history[0]["role"] != "user":
        history.pop(0)
    if not history or history[-1]["role"] != "user":
        raise ApiError(400, "Send a message to chat")
    return await chat(history, build_context(body, user, request.app.state.store))


@router.post("/insights")
async def insights(request: Request, user: dict = Depends(rate_limit)):
    body = as_dict(await read_json(request))
    summary = build_context(body, user, request.app.state.store)["week_summary"]
    return {"summary": summary, **(await generate_insights(summary))}
