"""Offline chatbot used when Claude isn't configured (or a Claude call fails).
Detects a few intents: help, "what's next", insights, and scheduling requests."""

from __future__ import annotations

import re

from .heuristic_parser import parse_schedule
from .insights import heuristic_insights

HELP = (
    "I'm your quiet-hours assistant. I can:\n"
    '- **Plan blocks**: "study 7-9pm on weekdays" or "sleep 11pm-7am every night"\n'
    "- **Show your schedule**: \"what's coming up?\" or \"what do I have tomorrow?\"\n"
    '- **Coach you**: "how is my week looking?" or "any tips?"'
)


def heuristic_chat(text: str, ctx: dict) -> dict:
    """Reply to the latest user message. Returns { reply, proposals }."""
    t = str(text).lower().strip()

    if re.match(r"(hi|hello|hey|yo|help|what can you do|\?)\b", t) or len(t) < 3:
        return {"reply": f"Hi! {HELP}", "proposals": []}

    if re.search(r"\b(score|insight|tips?|advice|improve|better|healthy|how('s| is) my|how am i|review|analy[sz]e)\b", t):
        ins = heuristic_insights(ctx["week_summary"])
        lines = [f"- **{s['title']}**: {s['detail']}" for s in ins["suggestions"][:3]]
        return {
            "reply": f"Your quiet-time score is **{ins['score']}/100**. {ins['headline']}\n" + "\n".join(lines),
            "proposals": [s["proposal"] for s in ins["suggestions"] if s["proposal"]][:2],
        }

    has_time = bool(re.search(r"\d", t))
    if not has_time and re.search(
        r"\b(next|upcoming|coming up|today|tonight|tomorrow|schedule|agenda|planned|what do i have|this week)\b", t
    ):
        return {"reply": _describe_schedule(t, ctx), "proposals": []}

    parsed = parse_schedule(text, ctx)
    if parsed["proposals"]:
        noun = "blocks" if len(parsed["proposals"]) > 1 else "block"
        return {
            "reply": f"Here's what I'd add. Review the {noun} below and tap **Add to calendar** to confirm.",
            "proposals": parsed["proposals"],
        }

    return {"reply": f"I'm not sure how to help with that yet. {HELP}", "proposals": []}


def _describe_schedule(t: str, ctx: dict) -> str:
    days = ctx["week_summary"]["days"]
    label = "the next 7 days"
    if re.search(r"\btoday|tonight\b", t):
        days, label = days[:1], "today"
    elif re.search(r"\btomorrow\b", t):
        days, label = days[1:2], "tomorrow"

    with_blocks = [d for d in days if d["blocks"]]
    if not with_blocks:
        return f'You have nothing scheduled for {label}. Want me to plan something? Try "deep work 9-11am tomorrow".'
    lines = []
    for d in with_blocks:
        items = ", ".join(f"{b['title']} {b['start']}–{b['end']}{' (+1)' if b['endsNextDay'] else ''}" for b in d["blocks"])
        lines.append(f"- **{d['weekday']}**: {items}")
    return f"Here's {label}:\n" + "\n".join(lines)
