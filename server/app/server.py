"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import SERVER_DIR
from .ai import ai_status
from .auth import verify_token
from .db import Store
from .errors import ApiError
from .notifier import add_client, email_enabled
from .routes import ai as ai_routes
from .routes import auth as auth_routes
from .routes import blocks as block_routes
from .scheduler import scheduler_loop

log = logging.getLogger("quiet-hours")
DIST_DIR = SERVER_DIR.parent / "client" / "dist"
PING_SECONDS = 25


def create_app(store: Store, run_scheduler: bool = False) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(scheduler_loop(store)) if run_scheduler else None
        yield
        if task:
            task.cancel()

    app = FastAPI(title="Quiet Hours Scheduler API", lifespan=lifespan)
    app.state.store = store

    origins = os.environ.get("CORS_ORIGIN")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins.split(",") if origins else ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, exc: ApiError):
        return JSONResponse(exc.body, status_code=exc.status)

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_request: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"error": "Something went wrong"}, status_code=500)

    @app.get("/api/health")
    async def health():
        return {"ok": True, "ai": ai_status(), "email": email_enabled()}

    app.include_router(auth_routes.router)
    app.include_router(block_routes.router)
    app.include_router(ai_routes.router)

    # Server-Sent Events stream. EventSource can't send headers, so the JWT
    # comes as a query parameter.
    @app.get("/api/events")
    async def events(request: Request):
        user_id = verify_token(request.query_params.get("token", ""))
        if not user_id or not store.find_user_by_id(user_id):
            return Response(status_code=401)
        queue, remove = add_client(user_id)

        async def stream():
            try:
                yield "event: connected\ndata: {}\n\n"
                while True:
                    try:
                        yield await asyncio.wait_for(queue.get(), timeout=PING_SECONDS)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"  # keep proxies from closing idle connections
            finally:
                remove()

        headers = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
        return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)

    @app.api_route("/api", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    @app.api_route("/api/{_rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def api_not_found(_rest: str = ""):
        return JSONResponse({"error": "Not found"}, status_code=404)

    # In production, serve the built React app from the same origin.
    if DIST_DIR.exists():
        dist = DIST_DIR.resolve()

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            candidate = (dist / full_path).resolve()
            if full_path and candidate.is_file() and dist in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app
