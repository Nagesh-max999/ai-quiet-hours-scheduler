"""API error type and request-body helper.

Every error response has the shape {"error": "...", ...extra}, which the
React client reads.
"""

from __future__ import annotations

import json

from fastapi import Request

MAX_BODY_BYTES = 200 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.body = {"error": message, **extra}


async def read_json(request: Request):
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError(413, "Request body is too large")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        raise ApiError(400, "Request body must be valid JSON")


def as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}
