from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from ..auth import check_password, current_user, hash_password, public_user, sign_token
from ..errors import ApiError, as_dict, read_json
from ..timeutil import is_valid_time_zone, to_number

EMAIL_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")

router = APIRouter(prefix="/api/auth")


def _text(body: dict, key: str) -> str:
    v = body.get(key)
    return str(v if v is not None else "")


@router.post("/register")
async def register(request: Request):
    store = request.app.state.store
    body = as_dict(await read_json(request))
    name = _text(body, "name").strip()
    email = _text(body, "email").strip().lower()
    password = _text(body, "password")
    time_zone = body.get("timeZone") if is_valid_time_zone(body.get("timeZone")) else "UTC"

    if not name:
        raise ApiError(400, "Name is required")
    if not EMAIL_RE.fullmatch(email):
        raise ApiError(400, "A valid email is required")
    if len(password) < 8:
        raise ApiError(400, "Password must be at least 8 characters")
    if store.find_user_by_email(email):
        raise ApiError(409, "An account with this email already exists")

    password_hash = await run_in_threadpool(hash_password, password)  # bcrypt is CPU-heavy
    user = store.create_user(
        {
            "name": name,
            "email": email,
            "passwordHash": password_hash,
            "preferences": {"timeZone": time_zone, "defaultReminderMinutes": 10, "emailReminders": False},
        }
    )
    return JSONResponse({"token": sign_token(user), "user": public_user(user)}, status_code=201)


@router.post("/login")
async def login(request: Request):
    store = request.app.state.store
    body = as_dict(await read_json(request))
    user = store.find_user_by_email(_text(body, "email").strip().lower())
    ok = user is not None and await run_in_threadpool(check_password, _text(body, "password"), user["passwordHash"])
    if not ok:
        raise ApiError(401, "Invalid email or password")
    return {"token": sign_token(user), "user": public_user(user)}


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    return {"user": public_user(user)}


@router.patch("/preferences")
async def preferences(request: Request, user: dict = Depends(current_user)):
    store = request.app.state.store
    body = as_dict(await read_json(request))
    prefs = dict(user.get("preferences") or {})
    if "timeZone" in body:
        if not is_valid_time_zone(body["timeZone"]):
            raise ApiError(400, "Unknown time zone")
        prefs["timeZone"] = body["timeZone"]
    if "defaultReminderMinutes" in body:
        n = to_number(body["defaultReminderMinutes"])
        if n is None or n != int(n) or not 0 <= n <= 120:
            raise ApiError(400, "Reminder must be 0-120 minutes")
        prefs["defaultReminderMinutes"] = int(n)
    if "emailReminders" in body:
        prefs["emailReminders"] = bool(body["emailReminders"])
    updated = store.update_user(user["id"], {"preferences": prefs})
    return {"user": public_user(updated)}
