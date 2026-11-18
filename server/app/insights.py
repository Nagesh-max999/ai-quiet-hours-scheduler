"""Schedule analytics: turns a user's upcoming blocks into a compact weekly
summary (also used as Claude's input) plus a rule-based "quiet score" and tips."""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from .timeutil import WEEKDAYS, add_days, js_round, local_parts, parse_dt, utcnow, weekday_of

HOUR = 3600


def _round1(n: float) -> float:
    return math.floor(n * 10 + 0.5) / 10


def summarize_week(blocks: list[dict], now: datetime | None = None, time_zone: str = "UTC") -> dict:
    """Summarise the next 7 days of blocks in the user's local time."""
    now = now or utcnow()
    today = local_parts(now, time_zone)["date"]
    horizon = now + timedelta(days=7)
    upcoming = sorted(
        (b for b in blocks if parse_dt(b["end"]) > now and parse_dt(b["start"]) < horizon),
        key=lambda b: parse_dt(b["start"]),
    )

    days = []
    for i in range(7):
        d = add_days(today, i)
        days.append({"date": d, "weekday": WEEKDAYS[weekday_of(d)], "blocks": [], "quietHours": 0, "sleepHours": 0})
    by_date = {d["date"]: d for d in days}

    by_category: dict[str, float] = {}
    total_hours = 0.0
    for b in upcoming:
        hours = (parse_dt(b["end"]) - parse_dt(b["start"])).total_seconds() / HOUR
        s = local_parts(b["start"], time_zone)
        e = local_parts(b["end"], time_zone)
        total_hours += hours
        by_category[b["category"]] = by_category.get(b["category"], 0) + hours
        # Sleep that starts after midnight counts toward the previous night.
        anchor = add_days(s["date"], -1) if b["category"] == "sleep" and s["time"] < "05:00" else s["date"]
        day = by_date.get(anchor)
        if day:
            day["blocks"].append(
                {
                    "title": b["title"],
                    "category": b["category"],
                    "start": s["time"],
                    "end": e["time"],
                    "endsNextDay": e["date"] != s["date"],
                    "hours": _round1(hours),
                }
            )
            day["quietHours"] += hours
            if b["category"] == "sleep":
                day["sleepHours"] += hours
    for d in days:
        d["quietHours"] = _round1(d["quietHours"])
        d["sleepHours"] = _round1(d["sleepHours"])

    # Back-to-back blocks with less than 10 minutes in between.
    tight_gaps = []
    for prev, cur in zip(upcoming, upcoming[1:]):
        gap_min = (parse_dt(cur["start"]) - parse_dt(prev["end"])).total_seconds() / 60
        if 0 <= gap_min < 10:
            tight_gaps.append({"after": prev["title"], "before": cur["title"], "at": local_parts(cur["start"], time_zone)["date"]})

    return {
        "today": today,
        "timeZone": time_zone,
        "blockCount": len(upcoming),
        "totalQuietHours": _round1(total_hours),
        "hoursByCategory": {k: _round1(v) for k, v in by_category.items()},
        "days": days,
        "tightGaps": tight_gaps,
    }


def _suggestion(title: str, detail: str, proposal: dict | None = None) -> dict:
    return {"title": title, "detail": detail, "proposal": proposal}


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def heuristic_insights(summary: dict) -> dict:
    """Rule-based insights, same shape as the Claude response."""
    today = summary["today"]
    if summary["blockCount"] == 0:
        return {
            "score": 0,
            "headline": "Your week has no protected quiet time yet.",
            "suggestions": [
                _suggestion(
                    "Start with a sleep routine",
                    "Protecting 8 hours of sleep is the highest-impact quiet block you can add.",
                    {"title": "Sleep", "category": "sleep", "startTime": "22:30", "endTime": "06:30", "daysOfWeek": [0, 1, 2, 3, 4, 5, 6], "startDate": today, "repeatWeeks": 2, "reminderMinutes": 15},
                ),
                _suggestion(
                    "Add a daily deep-focus window",
                    "Two uninterrupted hours each weekday morning is where most deep work happens.",
                    {"title": "Deep focus", "category": "focus", "startTime": "09:00", "endTime": "11:00", "daysOfWeek": [1, 2, 3, 4, 5], "startDate": today, "repeatWeeks": 2, "reminderMinutes": 10},
                ),
            ],
        }

    suggestions = []
    score = 50
    days = summary["days"]
    nights_without_sleep = [d for d in days if d["sleepHours"] == 0]
    short_nights = [d for d in days if 0 < d["sleepHours"] < 7]
    score += (7 - len(nights_without_sleep)) * 4  # up to +28
    score -= len(short_nights) * 3

    if nights_without_sleep:
        n = len(nights_without_sleep)
        missing_days = list(dict.fromkeys(WEEKDAYS.index(d["weekday"]) for d in nights_without_sleep))
        suggestions.append(
            _suggestion(
                f"Protect sleep on {n} more night{_plural(n, '', 's')}",
                f"No sleep block on {', '.join(d['weekday'] for d in nights_without_sleep)}. Consistent sleep times improve focus the next day.",
                {"title": "Sleep", "category": "sleep", "startTime": "22:30", "endTime": "06:30", "daysOfWeek": missing_days, "startDate": today, "repeatWeeks": 1, "reminderMinutes": 15},
            )
        )
    if short_nights:
        n = len(short_nights)
        suggestions.append(
            _suggestion(
                "Some nights are under 7 hours",
                f"{', '.join(d['weekday'] for d in short_nights)} {_plural(n, 'has', 'have')} less than 7 hours of protected sleep. Consider extending them.",
            )
        )

    hbc = summary["hoursByCategory"]
    focus_hours = hbc.get("focus", 0) + hbc.get("study", 0)
    if focus_hours >= 6:
        score += 15
    elif focus_hours > 0:
        score += 7
    else:
        suggestions.append(
            _suggestion(
                "No focus or study time this week",
                "Block a recurring 2-hour slot for deep work so notifications cannot break it up.",
                {"title": "Deep focus", "category": "focus", "startTime": "09:00", "endTime": "11:00", "daysOfWeek": [1, 2, 3, 4, 5], "startDate": today, "repeatWeeks": 1, "reminderMinutes": 10},
            )
        )

    long_sessions = [b for d in days for b in d["blocks"] if b["category"] in ("focus", "study") and b["hours"] > 3]
    if long_sessions:
        n = len(long_sessions)
        score -= 4
        suggestions.append(
            _suggestion(
                "Break up long focus sessions",
                f"{n} focus/study block{_plural(n, ' runs', 's run')} over 3 hours. Splitting them with a 15-minute break keeps attention high.",
            )
        )
    if summary["tightGaps"]:
        n = len(summary["tightGaps"])
        score -= 3
        suggestions.append(
            _suggestion(
                "Add buffers between blocks",
                f"{n} block{_plural(n, ' starts', 's start')} right after another ends. A 10-minute buffer helps you transition.",
            )
        )
    if not hbc.get("wellness"):
        suggestions.append(
            _suggestion(
                "Add a short wind-down",
                "A 30-minute screen-free wind-down before bed makes it easier to fall asleep on time.",
                {"title": "Wind-down", "category": "wellness", "startTime": "22:00", "endTime": "22:30", "daysOfWeek": [0, 1, 2, 3, 4, 5, 6], "startDate": today, "repeatWeeks": 1, "reminderMinutes": 5},
            )
        )
    else:
        score += 5

    score = max(0, min(100, js_round(score)))
    if score >= 80:
        headline = "Great balance. Your quiet time is well protected."
    elif score >= 60:
        headline = "Solid foundation, with a few gaps to close."
    else:
        headline = "Your schedule has room for more protected quiet time."
    return {"score": score, "headline": headline, "suggestions": suggestions[:5]}
