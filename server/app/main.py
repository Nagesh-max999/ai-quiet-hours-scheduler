"""ASGI entry point:  uvicorn app.main:app --port 8000"""

from __future__ import annotations

import logging
import os

from . import SERVER_DIR
from .ai import ai_status
from .auth import jwt_secret
from .db import Store
from .server import create_app

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

jwt_secret()  # fail fast: in production (ENV=production) JWT_SECRET must be set

DB_FILE = os.environ.get("DB_FILE") or str(SERVER_DIR / "data" / "db.json")

app = create_app(Store(DB_FILE), run_scheduler=True)

_ai = ai_status()
logging.getLogger("quiet-hours").info(
    "AI: Claude (%s)" % _ai["model"]
    if _ai["provider"] == "claude"
    else "AI: offline heuristic engine (set ANTHROPIC_API_KEY to enable Claude)"
)
