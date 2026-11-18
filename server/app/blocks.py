"""Pure domain logic for quiet-hour blocks: validation, overlap detection,
and normalising schedule "proposals" (from Claude or the heuristic parser)."""

from __future__ import annotations

import math
from datetime import timedelta

from .timeutil import HHMM, YMD, iso_z, js_round, parse_dt, to_number

CATEGORIES = ["sleep", "study", "focus", "family", "wellness", "other"]
MAX_DURATION = timedelta(hours=24)


def clamp_int(v, lo: int, hi: int, default: int) -> int:
    n = to_number(v)
    if n is None or not math.isfinite(n):
        return default
    return min(hi, max(lo, js_round(n)))


def validate_block(data) -> tuple[dict | None, str | None]:
    """Validate a block payload. Returns (value, None) or (None, error)."""
    if not isinstance(data, dict):
        return None, "Block payload is required"
    title = str(data.get("title") if data.get("title") is not None else "").strip()
    if not title:
        return None, "Title is required"
    if len(title) > 80:
        return None, "Title must be 80 characters or fewer"

    start = parse_dt(data.get("start"))
    end = parse_dt(data.get("end"))
    if start is None or end is None:
        return None, "Start and end must be valid dates"
    if end <= start:
        return None, "End time must be after start time"
    if end - start > MAX_DURATION:
        return None, "A quiet block cannot be longer than 24 hours"

    notes = data.get("notes")
    return {
        "title": title,
        "category": data.get("category") if data.get("category") in CATEGORIES else "other",
        "start": iso_z(start),
        "end": iso_z(end),
        "reminderMinutes": clamp_int(data.get("reminderMinutes"), 0, 120, 10),
        "notes": str(notes if notes is not None else "")[:500],
        "source": "ai" if data.get("source") == "ai" else "manual",
    }, None


def overlaps(a: dict, b: dict) -> bool:
    return parse_dt(a["start"]) < parse_dt(b["end"]) and parse_dt(b["start"]) < parse_dt(a["end"])


def find_conflicts(candidates: list[dict], existing: list[dict], ignore_id=None) -> list[dict]:
    """Conflicts of candidates against existing blocks and against each other."""
    conflicts, accepted = [], []
    for index, cand in enumerate(candidates):
        hit = next((b for b in existing if b.get("id") != ignore_id and overlaps(cand, b)), None) or next(
            (b for b in accepted if overlaps(cand, b)), None
        )
        if hit:
            conflicts.append(
                {
                    "index": index,
                    "title": cand["title"],
                    "start": cand["start"],
                    "end": cand["end"],
                    "conflictsWith": {"id": hit.get("id"), "title": hit["title"], "start": hit["start"], "end": hit["end"]},
                }
            )
        else:
            accepted.append(cand)
    return conflicts


def normalize_proposal(p, fallback_date: str) -> dict | None:
    """Clamp/clean a schedule proposal that an LLM or parser might get slightly wrong:
    { title, category, startTime, endTime, daysOfWeek, startDate, repeatWeeks,
      reminderMinutes, rationale }."""
    if not isinstance(p, dict):
        return None
    start_time, end_time = p.get("startTime"), p.get("endTime")
    if not (isinstance(start_time, str) and HHMM.fullmatch(start_time)):
        return None
    if not (isinstance(end_time, str) and HHMM.fullmatch(end_time)):
        return None
    if start_time == end_time:
        return None

    raw_days = p.get("daysOfWeek") if isinstance(p.get("daysOfWeek"), list) else []
    days = set()
    for d in raw_days:
        n = to_number(d)
        if n is not None and math.isfinite(n) and n == int(n) and 0 <= n <= 6:
            days.add(int(n))
    if not days:
        return None

    title = str(p.get("title") if p.get("title") is not None else "Quiet time").strip()[:80] or "Quiet time"
    start_date = p.get("startDate")
    rationale = p.get("rationale")
    return {
        "title": title,
        "category": p.get("category") if p.get("category") in CATEGORIES else "other",
        "startTime": start_time,
        "endTime": end_time,
        "daysOfWeek": sorted(days),
        "startDate": start_date if isinstance(start_date, str) and YMD.fullmatch(start_date) else fallback_date,
        "repeatWeeks": clamp_int(p.get("repeatWeeks"), 1, 8, 1),
        "reminderMinutes": clamp_int(p.get("reminderMinutes"), 0, 120, 10),
        "rationale": str(rationale if rationale is not None else "")[:300],
    }
