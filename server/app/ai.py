"""AI layer.

Uses Claude (Anthropic Python SDK, structured outputs + tool runner) when an
API key is configured. Falls back to the deterministic offline engine when
no key is set or a Claude call fails, so the app always works.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Literal, Optional

import anthropic
from anthropic import AsyncAnthropic, beta_async_tool
from pydantic import BaseModel, Field

from .blocks import normalize_proposal
from .heuristic_chat import heuristic_chat
from .heuristic_parser import parse_schedule
from .insights import heuristic_insights

log = logging.getLogger("quiet-hours.ai")

# If a safety classifier declines a request, the API retries it on a fallback model.
BETAS = ["server-side-fallback-2026-07-01"]
MAX_HISTORY = 20


def model() -> str:
    return os.environ.get("CLAUDE_MODEL") or "claude-opus-5-5"


# ---------- Output schemas (Claude is constrained to these) ----------
class Proposal(BaseModel):
    title: str = Field(description='Short label, e.g. "Deep focus" or "Sleep"')
    category: Literal["sleep", "study", "focus", "family", "wellness", "other"]
    startTime: str = Field(description="24h local time HH:MM")
    endTime: str = Field(description="24h local time HH:MM. If earlier than startTime the block ends the next day.")
    daysOfWeek: list[int] = Field(description="0=Sunday ... 6=Saturday")
    startDate: str = Field(description="YYYY-MM-DD, the first date the pattern may start on")
    repeatWeeks: int = Field(description="How many weeks to repeat, 1-8")
    reminderMinutes: int = Field(description="Minutes before start to remind, 0-120")
    rationale: str = Field(description="One sentence explaining the choice")


class ParseResult(BaseModel):
    proposals: list[Proposal]
    clarification: Optional[str] = Field(description="A short question if the request was too vague to schedule, else null")


class Suggestion(BaseModel):
    title: str
    detail: str
    proposal: Optional[Proposal] = Field(description="A concrete block pattern that applies this suggestion, or null")


class InsightsResult(BaseModel):
    score: int = Field(description="0-100 quiet-time health score")
    headline: str
    suggestions: list[Suggestion]


PARSE_SYSTEM = """You convert natural-language requests into quiet-hour schedule patterns for a "Quiet Hours Scheduler" app. A quiet block is a period when the user is not to be disturbed (sleep, study, deep focus, family time, wellness).

Rules:
- Output one proposal per distinct time window. "Weekdays" = [1,2,3,4,5], "weekends" = [0,6], "every day/night" = [0..6].
- Times are 24h local HH:MM. Overnight blocks (e.g. sleep 22:30-06:30) keep endTime earlier than startTime.
- If the user gives no duration for a recurring pattern, use repeatWeeks 2. A single occurrence uses repeatWeeks 1 with only that day in daysOfWeek.
- startDate defaults to today (or tomorrow if the user says so, or if a one-off window today has already passed).
- Use the user's existing schedule to avoid overlapping blocks; if a request would overlap, shift it minimally and say so in the rationale.
- reminderMinutes defaults to 10 unless the user specifies one.
- If the request has no schedulable time window at all, return no proposals and ask a short clarification question."""

INSIGHTS_SYSTEM = """You are a productivity and sleep-hygiene coach inside a "Quiet Hours Scheduler" app. You review a user's next 7 days of quiet blocks and return a 0-100 health score, a one-line headline, and 2-5 specific, actionable suggestions.

Score highly for: consistent sleep of 7-9 hours, regular focus/study windows of 60-150 minutes, buffers between blocks, a wind-down before sleep. Penalise: missing sleep blocks, marathon focus sessions over 3 hours, back-to-back blocks, an empty week.
Reference real days and times from the data. When a suggestion can be applied as a new block pattern, include it as "proposal" (it must not overlap existing blocks); otherwise set proposal to null. Keep each detail under 35 words."""

CHAT_SYSTEM = """You are "Quiet", the friendly assistant inside the Quiet Hours Scheduler app. You help the user plan and protect quiet time (sleep, study, deep focus, family, wellness) and give practical advice on focus, rest and sleep habits.

Tools:
- get_schedule: the user's real upcoming blocks. Call it before answering anything about their schedule; never guess.
- get_week_stats: totals and a rule-based score for the next 7 days.
- propose_blocks: when the user wants something scheduled (or accepts a suggestion), propose it. This only shows cards the user must confirm. It does NOT add anything, so never say a block "has been added"; say you've proposed it and they can tap "Add to calendar". Check get_schedule first and avoid overlaps.

Style: warm, concise (under 120 words unless asked for detail), plain text with short "- " bullet lists and **bold** for key times. Use 12-hour times like 9:30 PM. Stay on topic; for unrelated requests, briefly steer back to scheduling, focus and rest."""


# ---------- Client ----------
_client: AsyncAnthropic | None = None


def ai_enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("AI_DISABLED") != "true"


def ai_status() -> dict:
    return {"provider": "claude", "model": model()} if ai_enabled() else {"provider": "heuristic", "model": None}


def get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(timeout=60.0, max_retries=1)
    return _client


class ClaudeOutputError(Exception):
    pass


async def _call_claude(system: str, user: str, schema: type[BaseModel], effort: str) -> BaseModel:
    response = await get_client().beta.messages.parse(
        model=model(),
        max_tokens=16000,
        betas=BETAS,
        fallbacks="default",
        output_config={"effort": effort},
        output_format=schema,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        category = getattr(response.stop_details, "category", None) if response.stop_details else None
        raise ClaudeOutputError(f"Claude declined the request ({category or 'unknown'})")
    if response.stop_reason == "max_tokens":
        raise ClaudeOutputError("Claude response was truncated")
    if response.parsed_output is None:
        raise ClaudeOutputError("Claude returned no structured output")
    return response.parsed_output


def _describe_error(err: Exception) -> str:
    if isinstance(err, anthropic.AuthenticationError):
        return "Invalid ANTHROPIC_API_KEY"
    if isinstance(err, anthropic.RateLimitError):
        return "Claude rate limit reached"
    if isinstance(err, anthropic.APIConnectionError):
        return "Could not reach the Claude API"
    if isinstance(err, anthropic.APIStatusError):
        return f"Claude API error {err.status_code}"
    return str(err)


def _clean_insights(out: dict, today: str) -> dict:
    return {
        "score": max(0, min(100, round(out["score"]))),
        "headline": out["headline"],
        "suggestions": [
            {
                "title": s["title"],
                "detail": s["detail"],
                "proposal": normalize_proposal(s["proposal"], today) if s.get("proposal") else None,
            }
            for s in out["suggestions"][:5]
        ],
    }


# ---------- Public API ----------
async def parse_request(text: str, ctx: dict) -> dict:
    """Natural language -> schedule proposals."""
    if not ai_enabled():
        return {"source": "heuristic", **parse_schedule(text, ctx)}
    try:
        out = await _call_claude(
            PARSE_SYSTEM,
            json.dumps(
                {
                    "request": text,
                    "now": {"date": ctx["today"], "weekday": ctx["weekday"], "time": ctx["now_time"], "timeZone": ctx["time_zone"]},
                    "existingSchedule": [d for d in ctx["week_summary"]["days"] if d["blocks"]],
                }
            ),
            ParseResult,
            effort="low",  # simple extraction on an interactive path: keep latency down
        )
        proposals = [normalize_proposal(p.model_dump(), ctx["today"]) for p in out.proposals]
        return {"source": "claude", "proposals": [p for p in proposals if p], "clarification": out.clarification}
    except Exception as err:
        log.warning("parse fell back to heuristic: %s", _describe_error(err))
        return {
            "source": "heuristic",
            "warning": f"{_describe_error(err)}. Used the offline parser instead.",
            **parse_schedule(text, ctx),
        }


async def generate_insights(summary: dict) -> dict:
    """Weekly summary -> score + suggestions."""
    if ai_enabled() and summary["blockCount"] > 0:
        try:
            out = await _call_claude(INSIGHTS_SYSTEM, json.dumps(summary), InsightsResult, effort="medium")
            return {"source": "claude", **_clean_insights(out.model_dump(), summary["today"])}
        except Exception as err:
            log.warning("insights fell back to heuristic: %s", _describe_error(err))
            return {
                "source": "heuristic",
                "warning": f"{_describe_error(err)}. Showing offline insights.",
                **_clean_insights(heuristic_insights(summary), summary["today"]),
            }
    return {"source": "heuristic", **_clean_insights(heuristic_insights(summary), summary["today"])}


async def chat(history: list[dict], ctx: dict) -> dict:
    """Multi-turn chat. `history` ends with the latest user message.
    Returns { source, reply, proposals }."""
    latest = history[-1]["content"]
    if not ai_enabled():
        return {"source": "heuristic", **heuristic_chat(latest, ctx)}

    collected: list[dict] = []
    summary = ctx["week_summary"]

    @beta_async_tool
    async def get_schedule() -> str:
        """Returns the user's quiet blocks for the next 7 days, grouped by local date, with local start/end times."""
        return json.dumps(
            {"now": {"date": ctx["today"], "time": ctx["now_time"], "timeZone": ctx["time_zone"]}, "days": summary["days"]}
        )

    @beta_async_tool
    async def get_week_stats() -> str:
        """Returns total quiet hours, hours per category, tight gaps between blocks, and a rule-based 0-100 score for the next 7 days."""
        totals = {k: v for k, v in summary.items() if k != "days"}
        ins = heuristic_insights(summary)
        return json.dumps({**totals, "score": ins["score"], "headline": ins["headline"]})

    @beta_async_tool
    async def propose_blocks(proposals: list[Proposal]) -> str:
        """Shows schedule proposals to the user as cards they can confirm. Does not modify the calendar.

        Args:
            proposals: The block patterns to show to the user.
        """
        items = [p.model_dump() if isinstance(p, BaseModel) else p for p in proposals]
        valid = [v for v in (normalize_proposal(p, ctx["today"]) for p in items) if v]
        collected.extend(valid)
        if valid:
            return f"Showed {len(valid)} proposal card(s) to the user. They are NOT on the calendar until the user confirms."
        return "No valid proposals: times must be HH:MM, with at least one day of week."

    try:
        runner = get_client().beta.messages.tool_runner(
            model=model(),
            max_tokens=16000,
            max_iterations=6,
            betas=BETAS,
            fallbacks="default",
            output_config={"effort": "low"},  # chat is interactive: keep replies fast
            system=CHAT_SYSTEM,
            tools=[get_schedule, get_week_stats, propose_blocks],
            messages=history[-MAX_HISTORY:],
        )
        final = await runner.until_done()
        if final.stop_reason == "refusal":
            return {
                "source": "claude",
                "reply": "Sorry, I can't help with that one. I can help you plan sleep, study or focus time, though.",
                "proposals": collected,
            }
        reply = "\n".join(b.text for b in final.content if b.type == "text").strip()
        return {"source": "claude", "reply": reply or "Done! Take a look at the proposals below.", "proposals": collected}
    except Exception as err:
        log.warning("chat fell back to heuristic: %s", _describe_error(err))
        return {
            "source": "heuristic",
            "warning": f"{_describe_error(err)}. Answered with the offline assistant.",
            **heuristic_chat(latest, ctx),
        }
