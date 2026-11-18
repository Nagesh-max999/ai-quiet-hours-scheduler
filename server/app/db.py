"""Tiny JSON-file document store.

No database server needed, so the project runs anywhere with `pip install`.
All data access goes through this class, so it can be swapped for
PostgreSQL/MongoDB without touching the routes.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Callable

from .timeutil import iso_z, parse_dt, utcnow


class Store:
    def __init__(self, file: str | os.PathLike = ":memory:"):
        self.file = str(file)
        self.persist = self.file != ":memory:"
        self.lock = threading.RLock()
        self.state = {"users": [], "blocks": []}
        if self.persist and Path(self.file).exists():
            try:
                loaded = json.loads(Path(self.file).read_text(encoding="utf-8"))
                self.state = {"users": [], "blocks": [], **loaded}
            except Exception as err:  # corrupt file: start empty rather than crash
                print(f"[db] Could not read {self.file}, starting empty: {err}")

    def _save(self) -> None:
        if not self.persist:
            return
        path = Path(self.file)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        os.replace(tmp, path)  # atomic replace: never leaves a half-written file

    # ---- users ----
    def find_user_by_email(self, email: str):
        email = email.lower()
        with self.lock:
            return next((u for u in self.state["users"] if u["email"] == email), None)

    def find_user_by_id(self, user_id):
        with self.lock:
            return next((u for u in self.state["users"] if u["id"] == user_id), None)

    def create_user(self, data: dict) -> dict:
        user = {"id": str(uuid.uuid4()), "createdAt": iso_z(utcnow()), **data, "email": data["email"].lower()}
        with self.lock:
            self.state["users"].append(user)
            self._save()
        return user

    def update_user(self, user_id, patch: dict):
        with self.lock:
            user = self.find_user_by_id(user_id)
            if not user:
                return None
            user.update(patch)
            self._save()
            return user

    # ---- blocks ----
    def list_blocks(self, user_id, from_=None, to=None) -> list[dict]:
        lo = parse_dt(from_) if from_ else None
        hi = parse_dt(to) if to else None
        if (from_ and lo is None) or (to and hi is None):
            return []  # invalid range bounds match nothing
        with self.lock:
            items = [
                b
                for b in self.state["blocks"]
                if b["userId"] == user_id
                and (lo is None or parse_dt(b["end"]) > lo)
                and (hi is None or parse_dt(b["start"]) < hi)
            ]
        return sorted(items, key=lambda b: parse_dt(b["start"]))

    def all_blocks(self) -> list[dict]:
        with self.lock:
            return list(self.state["blocks"])

    def find_block(self, user_id, block_id):
        with self.lock:
            return next((b for b in self.state["blocks"] if b["id"] == block_id and b["userId"] == user_id), None)

    def create_blocks(self, user_id, items: list[dict], series_id=None) -> list[dict]:
        now = iso_z(utcnow())
        created = [
            {
                "id": str(uuid.uuid4()),
                "userId": user_id,
                "seriesId": series_id,
                "reminderSentAt": None,
                "startNotifiedAt": None,
                "createdAt": now,
                **item,
            }
            for item in items
        ]
        with self.lock:
            self.state["blocks"].extend(created)
            self._save()
        return created

    def update_block(self, user_id, block_id, patch: dict):
        with self.lock:
            block = self.find_block(user_id, block_id)
            if not block:
                return None
            block.update(patch)
            block["updatedAt"] = iso_z(utcnow())
            self._save()
            return block

    def delete_blocks(self, user_id, predicate: Callable[[dict], bool]) -> int:
        with self.lock:
            before = len(self.state["blocks"])
            self.state["blocks"] = [b for b in self.state["blocks"] if not (b["userId"] == user_id and predicate(b))]
            removed = before - len(self.state["blocks"])
            if removed:
                self._save()
            return removed

    def claim_notification(self, block_id, field: str) -> bool:
        """Mark a block notification field; returns False if it was already set (dedupe)."""
        with self.lock:
            block = next((b for b in self.state["blocks"] if b["id"] == block_id), None)
            if not block or block.get(field):
                return False
            block[field] = iso_z(utcnow())
            self._save()
            return True
