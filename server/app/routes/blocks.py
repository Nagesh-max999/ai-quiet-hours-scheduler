from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..auth import current_user
from ..blocks import find_conflicts, validate_block
from ..errors import ApiError, as_dict, read_json
from ..notifier import send_event
from ..timeutil import parse_dt

MAX_BATCH = 120

router = APIRouter(prefix="/api/blocks")


@router.get("")
async def list_blocks(request: Request, user: dict = Depends(current_user)):
    q = request.query_params
    return {"blocks": request.app.state.store.list_blocks(user["id"], q.get("from"), q.get("to"))}


@router.post("")
async def create_blocks(request: Request, user: dict = Depends(current_user)):
    """Create one block ({...}) or many ({ blocks: [...], skipConflicts })."""
    store = request.app.state.store
    body = await read_json(request)
    is_batch = isinstance(body, dict) and isinstance(body.get("blocks"), list)
    raw = body["blocks"] if is_batch else [body]
    if not raw:
        raise ApiError(400, "No blocks to create")
    if len(raw) > MAX_BATCH:
        raise ApiError(400, f"At most {MAX_BATCH} blocks per request")

    valid = []
    for i, item in enumerate(raw):
        value, error = validate_block(item)
        if error:
            raise ApiError(400, f"Block {i + 1}: {error}" if is_batch else error)
        valid.append(value)

    conflicts = find_conflicts(valid, store.list_blocks(user["id"]))
    if conflicts and not (is_batch and body.get("skipConflicts")):
        raise ApiError(409, "Some blocks overlap with your existing schedule", conflicts=conflicts)
    skip = {c["index"] for c in conflicts}
    if len(skip) == len(valid):
        raise ApiError(409, "Every block overlaps an existing one", conflicts=conflicts)

    # Items sharing a `group` key (e.g. one AI proposal) become one series,
    # so the user can later delete "this and following" in one click.
    groups: dict[str, list[dict]] = {}
    for i, block in enumerate(valid):
        if i in skip:
            continue
        group = raw[i].get("group") if is_batch else None
        key = str(group if group is not None else "batch") if is_batch else f"single-{i}"
        groups.setdefault(key, []).append(block)

    created = []
    for items in groups.values():
        created.extend(store.create_blocks(user["id"], items, str(uuid.uuid4()) if len(items) > 1 else None))
    send_event(user["id"], "blocks-changed", {})
    return JSONResponse({"blocks": created, "skipped": conflicts}, status_code=201)


@router.put("/{block_id}")
async def update_block(block_id: str, request: Request, user: dict = Depends(current_user)):
    store = request.app.state.store
    existing = store.find_block(user["id"], block_id)
    if not existing:
        raise ApiError(404, "Block not found")
    body = as_dict(await read_json(request))
    value, error = validate_block({**existing, **body})
    if error:
        raise ApiError(400, error)

    conflicts = find_conflicts([value], store.list_blocks(user["id"]), ignore_id=existing["id"])
    if conflicts:
        raise ApiError(409, "This change overlaps another block", conflicts=conflicts)

    time_changed = value["start"] != existing["start"] or value["reminderMinutes"] != existing.get("reminderMinutes")
    patch = {**value, "source": existing.get("source", "manual")}
    if time_changed:
        patch.update({"reminderSentAt": None, "startNotifiedAt": None})  # re-arm reminders
    block = store.update_block(user["id"], existing["id"], patch)
    send_event(user["id"], "blocks-changed", {})
    return {"block": block}


@router.delete("/{block_id}")
async def delete_block(block_id: str, request: Request, user: dict = Depends(current_user)):
    """DELETE /:id -> one block.  DELETE /:id?series=1 -> this and all later blocks in its series."""
    store = request.app.state.store
    block = store.find_block(user["id"], block_id)
    if not block:
        raise ApiError(404, "Block not found")
    whole_series = bool(request.query_params.get("series")) and block.get("seriesId")
    start = parse_dt(block["start"])

    def matches(b: dict) -> bool:
        if whole_series:
            return b.get("seriesId") == block["seriesId"] and parse_dt(b["start"]) >= start
        return b["id"] == block["id"]

    removed = store.delete_blocks(user["id"], matches)
    send_event(user["id"], "blocks-changed", {})
    return {"removed": removed}
