"""Pushes real-time events to connected browsers over Server-Sent Events,
and optionally sends email reminders when SMTP is configured."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import smtplib
import threading
from email.message import EmailMessage

log = logging.getLogger("quiet-hours.notifier")

# user_id -> set of (event loop, queue) pairs, one per open browser tab
_clients: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}
_lock = threading.Lock()


def add_client(user_id: str) -> tuple[asyncio.Queue, callable]:
    entry = (asyncio.get_running_loop(), asyncio.Queue())
    with _lock:
        _clients.setdefault(user_id, set()).add(entry)

    def remove():
        with _lock:
            conns = _clients.get(user_id)
            if conns:
                conns.discard(entry)
                if not conns:
                    _clients.pop(user_id, None)

    return entry[1], remove


def connected_count(user_id: str) -> int:
    with _lock:
        return len(_clients.get(user_id, ()))


def send_event(user_id: str, event_type: str, data: dict) -> int:
    """Queue an SSE event for every open connection of a user. Safe to call from any thread."""
    payload = f"event: {event_type}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
    with _lock:
        conns = list(_clients.get(user_id, ()))
    for loop, queue in conns:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, payload)
        except RuntimeError:  # loop already closed
            pass
    return len(conns)


# ---------- Email (optional) ----------
def email_enabled() -> bool:
    return bool(os.environ.get("SMTP_HOST"))


def _send_email_sync(to: str, subject: str, text: str) -> None:
    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", "")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT") or 587)
    secure = os.environ.get("SMTP_SECURE") == "true"
    smtp_cls = smtplib.SMTP_SSL if secure else smtplib.SMTP
    with smtp_cls(host, port, timeout=30) as server:
        if not secure:
            server.starttls()
        if os.environ.get("SMTP_USER"):
            server.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
        server.send_message(msg)


def send_email(to: str, subject: str, text: str) -> bool:
    """Send an email in a background thread so the caller never blocks."""
    if not email_enabled():
        return False

    def worker():
        try:
            _send_email_sync(to, subject, text)
        except Exception as err:
            log.warning("[email] failed: %s", err)

    threading.Thread(target=worker, daemon=True).start()
    return True
