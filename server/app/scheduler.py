"""Background job: every 30s, finds blocks whose reminder window has opened
(or that just started) and notifies the owner exactly once per block."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from .db import Store
from .notifier import send_email, send_event
from .timeutil import local_parts, parse_dt, utcnow

log = logging.getLogger("quiet-hours.scheduler")
TICK_SECONDS = 30


def run_scheduler_tick(store: Store, now: datetime | None = None) -> list[dict]:
    now = now or utcnow()
    fired = []
    for block in store.all_blocks():
        start, end = parse_dt(block["start"]), parse_dt(block["end"])
        lead = timedelta(minutes=block.get("reminderMinutes", 0))

        # 1) Upcoming reminder. claim_notification() marks the block before
        #    sending, so a block is never reminded twice, even if ticks overlap.
        if (
            block.get("reminderMinutes", 0) > 0
            and start > now
            and start - now <= lead
            and store.claim_notification(block["id"], "reminderSentAt")
        ):
            minutes = max(1, round((start - now).total_seconds() / 60))
            _notify(store, block, "reminder", f'"{block["title"]}" starts in {minutes} min')
            fired.append({"id": block["id"], "type": "reminder"})

        # 2) Block started -> quiet mode on.
        if start <= now < end and store.claim_notification(block["id"], "startNotifiedAt"):
            _notify(store, block, "started", f'Quiet time: "{block["title"]}" has started')
            fired.append({"id": block["id"], "type": "started"})
    return fired


def _notify(store: Store, block: dict, event_type: str, message: str) -> None:
    send_event(
        block["userId"],
        event_type,
        {
            "block": {k: block[k] for k in ("id", "title", "category", "start", "end")},
            "message": message,
        },
    )
    user = store.find_user_by_id(block["userId"])
    prefs = (user or {}).get("preferences") or {}
    if event_type == "reminder" and prefs.get("emailReminders"):
        tz = prefs.get("timeZone") or "UTC"
        s, e = local_parts(block["start"], tz), local_parts(block["end"], tz)
        send_email(
            user["email"],
            f"Reminder: {block['title']} starts soon",
            f"Hi {user['name']},\n\nYour quiet block \"{block['title']}\" runs {s['weekday']} {s['time']}–{e['time']} ({tz}).\n"
            "Time to wrap up and silence notifications.\n\n— Quiet Hours Scheduler",
        )


async def scheduler_loop(store: Store) -> None:
    while True:
        try:
            run_scheduler_tick(store)
        except Exception:
            log.exception("[scheduler] tick failed")
        await asyncio.sleep(TICK_SECONDS)
