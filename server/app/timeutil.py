"""Date, time and time-zone helpers (standard library zoneinfo, no date library needed)."""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

HHMM = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")
YMD = re.compile(r"\d{4}-\d{2}-\d{2}")


def is_valid_time_zone(tz) -> bool:
    if not isinstance(tz, str) or not tz:
        return False
    try:
        ZoneInfo(tz)
        return True
    except Exception:  # ZoneInfoNotFoundError, ValueError, odd paths like "America"
        return False


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_dt(value) -> datetime | None:
    """Parse an ISO-8601 string (or epoch milliseconds) into an aware UTC datetime."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value):
            return None
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str) and value.strip():
        try:
            dt = datetime.fromisoformat(value.strip())
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_z(dt: datetime) -> str:
    """Format like JavaScript's toISOString(): 2026-11-11T10:00:00.000Z."""
    dt = dt.astimezone(timezone.utc)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def local_parts(value, time_zone: str = "UTC") -> dict:
    """Wall-clock parts of an instant in a given IANA time zone."""
    dt = parse_dt(value)
    loc = dt.astimezone(ZoneInfo(time_zone or "UTC"))
    idx = (loc.weekday() + 1) % 7  # Python: Monday=0 -> JS-style Sunday=0
    return {
        "date": f"{loc:%Y-%m-%d}",
        "time": f"{loc:%H:%M}",
        "weekday": WEEKDAYS[idx],
        "weekdayIndex": idx,
    }


def weekday_of(ymd: str) -> int:
    return (date.fromisoformat(ymd).weekday() + 1) % 7


def to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def from_minutes(total) -> str:
    t = int(total or 0) % 1440
    return f"{t // 60:02d}:{t % 60:02d}"


def add_days(ymd: str, days: int) -> str:
    return (date.fromisoformat(ymd) + timedelta(days=days)).isoformat()


def js_round(n: float) -> int:
    """Math.round semantics (half rounds up), unlike Python's banker's rounding."""
    return math.floor(n + 0.5)


def to_number(v) -> float | None:
    """Loose numeric conversion similar to JavaScript's Number()."""
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0.0
        try:
            return float(s)
        except ValueError:
            return None
    return None
