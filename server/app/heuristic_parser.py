"""Rule-based natural-language schedule parser.

Used when no Claude API key is configured, or as a fallback if a Claude
request fails. Understands phrases like
"sleep 10:30pm-6:30am every night and study 2-4pm on weekdays".
"""

from __future__ import annotations

import re

from .blocks import normalize_proposal
from .timeutil import add_days, from_minutes, to_minutes

TIME = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?"
RANGE_RE = re.compile(rf"(?:from\s+)?{TIME}\s*(?:-|–|—|to|until|till)\s*{TIME}", re.IGNORECASE)
SPLIT_RE = re.compile(r"\s*(?:,|;|\.(?!\d)|\band then\b|\bthen\b|\balso\b|\band\b)\s*")
ACTIVITY_RE = re.compile(r"\b(sleep|study|focus|work|family|gym|yoga|read)\b")
NAMED_TIMES = {"midnight": 0, "noon": 12 * 60}

DAY_NAMES = [("sun", 0), ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6)]

CATEGORY_RULES = [
    {"category": "sleep", "title": "Sleep", "words": ["sleep", "bed", "night", "nightly", "rest", "nap"], "defaults": ["22:30", "06:30"]},
    {"category": "study", "title": "Study session", "words": ["study", "exam", "revision", "revise", "homework", "learn", "class", "lecture"], "defaults": ["19:00", "21:00"]},
    {"category": "focus", "title": "Deep focus", "words": ["focus", "deep work", "work", "coding", "code", "writing", "project"], "defaults": ["09:00", "11:00"]},
    {"category": "family", "title": "Family time", "words": ["family", "dinner", "kids", "partner", "friends"], "defaults": ["18:30", "20:00"]},
    {"category": "wellness", "title": "Wellness break", "words": ["meditat", "yoga", "gym", "workout", "exercise", "read", "walk", "relax", "unwind"], "defaults": ["07:00", "07:45"]},
]


def parse_schedule(text: str, ctx: dict) -> dict:
    """ctx: { today: 'YYYY-MM-DD', weekday: 0-6, now_time: 'HH:MM' }"""
    text_in = re.sub(r"\s+", " ", str(text or "").lower()).strip()
    if not text_in:
        return {"proposals": [], "clarification": 'Describe when you want quiet time, e.g. "study 7-9pm on weekdays".'}

    proposals = []
    for clause in _split_clauses(text_in):
        rng = clause["range"] or _default_range_for(clause["text"])
        if not rng:
            continue
        cat = _detect_category(clause["text"])
        days, recurring, start_date = _detect_days(clause["text"], ctx, rng)
        weeks = _detect_weeks(clause["text"])
        if weeks is None:
            weeks = 2 if recurring else 1
        reminder = _detect_reminder(clause["text"])

        p = normalize_proposal(
            {
                "title": cat["title"],
                "category": cat["category"],
                "startTime": rng["start"],
                "endTime": rng["end"],
                "daysOfWeek": days,
                "startDate": start_date,
                "repeatWeeks": weeks,
                "reminderMinutes": 10 if reminder is None else reminder,
                "rationale": "Parsed from your description."
                if clause["range"]
                else f"No time given, so a typical {cat['category']} window was used.",
            },
            ctx["today"],
        )
        if p:
            proposals.append(p)

    return {
        "proposals": proposals,
        "clarification": None
        if proposals
        else 'I could not find a time range. Try something like "deep work 9-11am Mon, Wed, Fri".',
    }


def _split_clauses(text_in: str) -> list[dict]:
    """Split into clauses holding at most one time range. Clauses without a
    range attach to the previous ranged clause (or the next one if none came
    before), so "monday and wednesday 2-4pm" stays together."""
    parts = [p for p in SPLIT_RE.split(text_in) if p]
    clauses: list[dict] = []
    pending: list[str] = []
    for part in parts:
        match = RANGE_RE.search(part)
        if not match:
            if clauses and not ACTIVITY_RE.search(part):
                clauses[-1]["text"] += f" {part}"
            else:
                pending.append(part)
            continue
        clauses.append({"text": " ".join([*pending, part]), "range": _to_range(match)})
        pending = []
    # Leftover clauses with no time (e.g. "sleep every night") get category defaults.
    if pending:
        clauses.append({"text": " ".join(pending), "range": None})
    return clauses


def _to_range(m: re.Match) -> dict | None:
    sh, sm, sap, eh, em, eap = m.groups()
    sap = sap[0] if sap else None
    eap = eap[0] if eap else None
    sh_i, sm_i, eh_i, em_i = int(sh), int(sm or 0), int(eh), int(em or 0)
    start = _clock(sh_i, sm_i, sap)
    end = _clock(eh_i, em_i, eap)
    if start is None or end is None:
        return None
    # "2-4pm" -> start inherits pm; "10-6am" -> start is the opposite (10pm).
    if not sap and eap:
        start = _clock(sh_i, sm_i, eap)
        if start >= end:
            start = _clock(sh_i, sm_i, "p" if eap == "a" else "a")
    final_end = end
    if not sap and not eap:
        if sh_i <= 7:
            start += 12 * 60  # "study 7-9" means the evening
        # "1-3" -> 13:00-15:00 rather than an overnight 01:00 -> 03:00 surprise.
        if final_end <= start and final_end + 720 > start and final_end + 720 < 1440:
            final_end += 720
    return {"start": from_minutes(start), "end": from_minutes(final_end)}


def _clock(h: int, m: int, ap: str | None) -> int | None:
    if h > 23 or m > 59:
        return None
    if ap == "p" and h < 12:
        h += 12
    if ap == "a" and h == 12:
        h = 0
    return h * 60 + m


def _default_range_for(text: str) -> dict | None:
    named = re.search(r"(midnight|noon)\s*(?:-|to|until)\s*(\d{1,2})\s*(am|pm)?", text)
    if named:
        end = _clock(int(named.group(2)), 0, named.group(3)[0] if named.group(3) else None)
        return {"start": from_minutes(NAMED_TIMES[named.group(1)]), "end": from_minutes(end)}
    cat = _detect_category(text)
    if not cat["matched"]:
        return None
    return {"start": cat["defaults"][0], "end": cat["defaults"][1]}


def _detect_category(text: str) -> dict:
    best = None
    for rule in CATEGORY_RULES:
        for w in rule["words"]:
            idx = text.find(w)
            if idx != -1 and (best is None or idx < best[0]):
                best = (idx, rule)
    if not best:
        return {"category": "other", "title": "Quiet time", "defaults": None, "matched": False}
    return {**best[1], "matched": True}


def _detect_days(text: str, ctx: dict, rng: dict) -> tuple[list[int], bool, str]:
    today, weekday = ctx["today"], ctx["weekday"]
    if re.search(r"\b(every ?day|daily|every night|nightly|each night|each day|all week)\b", text):
        return [0, 1, 2, 3, 4, 5, 6], True, today
    if re.search(r"\bweekdays?\b|\bmon(day)?\s*(?:-|to|through|thru)\s*fri(day)?\b", text):
        return [1, 2, 3, 4, 5], True, today
    if re.search(r"\bweekends?\b", text):
        return [0, 6], True, today

    named = [i for abbr, i in DAY_NAMES if re.search(rf"\b{abbr}[a-z]*\b", text)]
    if named:
        recurring = bool(
            re.search(r"\bevery\b|\beach\b|\bweekly\b|\bfor \w+ weeks?\b|\b(sun|mon|tues|wednes|thurs|fri|satur)days\b", text)
        )
        return named, recurring, today

    if re.search(r"\btomorrow\b", text):
        return [(weekday + 1) % 7], False, add_days(today, 1)
    # Today, unless the slot already ended -> tomorrow.
    ended_today = to_minutes(rng["end"]) > to_minutes(rng["start"]) and to_minutes(rng["end"]) <= to_minutes(ctx["now_time"])
    if ended_today and not re.search(r"\btoday|tonight\b", text):
        return [(weekday + 1) % 7], False, add_days(today, 1)
    return [weekday], False, today


def _detect_weeks(text: str) -> int | None:
    m = re.search(r"\b(?:for|next)\s+(\d+|one|two|three|four)\s+weeks?\b", text)
    if not m:
        return None
    words = {"one": 1, "two": 2, "three": 3, "four": 4}
    return words.get(m.group(1)) or int(m.group(1))


def _detect_reminder(text: str) -> int | None:
    m = re.search(r"remind(?:er)?(?: me)?\s+(\d+)\s*(?:min|minutes?)", text)
    if m:
        return int(m.group(1))
    if re.search(r"\bno reminders?\b", text):
        return 0
    return None
