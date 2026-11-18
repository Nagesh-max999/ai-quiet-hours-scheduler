"""JWT sessions and bcrypt password hashing."""

from __future__ import annotations

import os
from datetime import timedelta

import bcrypt
import jwt
from fastapi import Request

from .errors import ApiError
from .timeutil import utcnow

DEV_SECRET = "dev-only-secret-change-me-before-deploying"


def is_production() -> bool:
    return "production" in (os.environ.get("ENV"), os.environ.get("NODE_ENV"))


def jwt_secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret and is_production():
        raise RuntimeError("JWT_SECRET must be set in production")
    return secret or DEV_SECRET


def sign_token(user: dict) -> str:
    now = utcnow()
    payload = {"sub": user["id"], "iat": now, "exp": now + timedelta(days=7)}
    return jwt.encode(payload, jwt_secret(), algorithm="HS256")


def verify_token(token: str):
    try:
        return jwt.decode(token, jwt_secret(), algorithms=["HS256"]).get("sub")
    except jwt.PyJWTError:
        return None


def hash_password(password: str) -> str:
    # bcrypt only uses the first 72 bytes; truncate explicitly (newer bcrypt raises otherwise).
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt(rounds=10)).decode("utf-8")


def check_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], password_hash.encode("utf-8"))
    except ValueError:
        return False


def public_user(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != "passwordHash"}


def current_user(request: Request) -> dict:
    """FastAPI dependency: requires `Authorization: Bearer <jwt>`."""
    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else None
    user_id = verify_token(token) if token else None
    user = request.app.state.store.find_user_by_id(user_id) if user_id else None
    if not user:
        raise ApiError(401, "Not authenticated")
    return user
