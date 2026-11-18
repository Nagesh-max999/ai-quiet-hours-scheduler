// AI layer. Uses Claude (Anthropic SDK, structured outputs) when an API key is
// configured, and falls back to the deterministic heuristic engine otherwise
// or when a Claude call fails, so the app always works.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat, betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { CATEGORIES, normalizeProposal } from '../lib/blocks.js';
import { parseSchedule } from '../lib/heuristicParser.js';
import { heuristicInsights } from '../lib/insights.js';
import { heuristicChat } from '../lib/heuristicChat.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

// ---------- Output schemas (Claude is constrained to these) ----------
const ProposalSchema = z.object({
  title: z.string().describe('Short label, e.g. "Deep focus" or "Sleep"'),
  category: z.enum(CATEGORIES),
  startTime: z.string().describe('24h local time HH:MM'),
  endTime: z.string().describe('24h local time HH:MM. If earlier than startTime the block ends the next day.'),
  daysOfWeek: z.array(z.number().int()).describe('0=Sunday ... 6=Saturday'),
  startDate: z.string().describe('YYYY-MM-DD, the first date the pattern may start on'),
  repeatWeeks: z.number().int().describe('How many weeks to repeat, 1-8'),
  reminderMinutes: z.number().int().describe('Minutes before start to remind, 0-120'),
  rationale: z.string().describe('One sentence explaining the choice'),
});

const ParseSchema = z.object({
  proposals: z.array(ProposalSchema),
  clarification: z.string().nullable().describe('A short question if the request was too vague to schedule, else null'),
});

const InsightsSchema = z.object({
  score: z.number().int().describe('0-100 quiet-time health score'),
  headline: z.string(),
  suggestions: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      proposal: ProposalSchema.nullable().describe('A concrete block pattern that applies this suggestion, or null'),
    }),
  ),
});

const PARSE_SYSTEM = `You convert natural-language requests into quiet-hour schedule patterns for a "Quiet Hours Scheduler" app. A quiet block is a period when the user is not to be disturbed (sleep, study, deep focus, family time, wellness).

Rules:
- Output one proposal per distinct time window. "Weekdays" = [1,2,3,4,5], "weekends" = [0,6], "every day/night" = [0..6].
- Times are 24h local HH:MM. Overnight blocks (e.g. sleep 22:30-06:30) keep endTime earlier than startTime.
- If the user gives no duration for a recurring pattern, use repeatWeeks 2. A single occurrence uses repeatWeeks 1 with only that day in daysOfWeek.
- startDate defaults to today (or tomorrow if the user says so, or if a one-off window today has already passed).
- Use the user's existing schedule to avoid overlapping blocks; if a request would overlap, shift it minimally and say so in the rationale.
- reminderMinutes defaults to 10 unless the user specifies one.
- If the request has no schedulable time window at all, return no proposals and ask a short clarification question.`;

const INSIGHTS_SYSTEM = `You are a productivity and sleep-hygiene coach inside a "Quiet Hours Scheduler" app. You review a user's next 7 days of quiet blocks and return a 0-100 health score, a one-line headline, and 2-5 specific, actionable suggestions.

Score highly for: consistent sleep of 7-9 hours, regular focus/study windows of 60-150 minutes, buffers between blocks, a wind-down before sleep. Penalise: missing sleep blocks, marathon focus sessions over 3 hours, back-to-back blocks, an empty week.
Reference real days and times from the data. When a suggestion can be applied as a new block pattern, include it as "proposal" (it must not overlap existing blocks); otherwise set proposal to null. Keep each detail under 35 words.`;

// ---------- Client ----------
let client = null;
export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AI_DISABLED !== 'true';
}
function getClient() {
  client ??= new Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client;
}

export function aiStatus() {
  return aiEnabled() ? { provider: 'claude', model: MODEL } : { provider: 'heuristic', model: null };
}

async function callClaude({ system, user, schema, effort }) {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety classifier declines, the API retries on a fallback model
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'unknown'})`);
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was truncated');
  if (!response.parsed_output) throw new Error('Claude returned no structured output');
  return response.parsed_output;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'Claude rate limit reached';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}`;
  return err.message;
}

// ---------- Public API ----------

/**
 * Natural language -> schedule proposals.
 * ctx: { today, weekday, nowTime, timeZone, weekSummary }
 */
export async function parseRequest(text, ctx) {
  if (aiEnabled()) {
    try {
      const out = await callClaude({
        system: PARSE_SYSTEM,
        effort: 'low', // simple extraction on an interactive path: keep latency down
        schema: ParseSchema,
        user: JSON.stringify({
          request: text,
          now: { date: ctx.today, weekday: ctx.weekday, time: ctx.nowTime, timeZone: ctx.timeZone },
          existingSchedule: ctx.weekSummary.days.filter((d) => d.blocks.length),
        }),
      });
      return {
        source: 'claude',
        proposals: out.proposals.map((p) => normalizeProposal(p, ctx.today)).filter(Boolean),
        clarification: out.clarification,
      };
    } catch (err) {
      console.warn('[ai] parse fell back to heuristic:', describeError(err));
      return { source: 'heuristic', warning: `${describeError(err)}. Used the offline parser instead.`, ...parseSchedule(text, ctx) };
    }
  }
  return { source: 'heuristic', ...parseSchedule(text, ctx) };
}

/** Weekly summary -> score + suggestions. */
export async function generateInsights(summary) {
  if (aiEnabled() && summary.blockCount > 0) {
    try {
      const out = await callClaude({
        system: INSIGHTS_SYSTEM,
        effort: 'medium',
        schema: InsightsSchema,
        user: JSON.stringify(summary),
      });
      return { source: 'claude', ...cleanInsights(out, summary.today) };
    } catch (err) {
      console.warn('[ai] insights fell back to heuristic:', describeError(err));
      return { source: 'heuristic', warning: `${describeError(err)}. Showing offline insights.`, ...cleanInsights(heuristicInsights(summary), summary.today) };
    }
  }
  return { source: 'heuristic', ...cleanInsights(heuristicInsights(summary), summary.today) };
}

// ---------- Chatbot ----------

const CHAT_SYSTEM = `You are "Quiet", the friendly assistant inside the Quiet Hours Scheduler app. You help the user plan and protect quiet time (sleep, study, deep focus, family, wellness) and give practical advice on focus, rest and sleep habits.

Tools:
- get_schedule: the user's real upcoming blocks. Call it before answering anything about their schedule; never guess.
- get_week_stats: totals and a rule-based score for the next 7 days.
- propose_blocks: when the user wants something scheduled (or accepts a suggestion), propose it. This only shows cards the user must confirm. It does NOT add anything, so never say a block "has been added"; say you've proposed it and they can tap "Add to calendar". Check get_schedule first and avoid overlaps.

Style: warm, concise (under 120 words unless asked for detail), plain text with short "- " bullet lists and **bold** for key times. Use 12-hour times like 9:30 PM. Stay on topic; for unrelated requests, briefly steer back to scheduling, focus and rest.`;

const MAX_HISTORY = 20;

/**
 * Multi-turn chat. `history` is [{ role: 'user'|'assistant', content: string }],
 * ending with the latest user message. Returns { source, reply, proposals }.
 */
export async function chat(history, ctx) {
  const latest = history[history.length - 1].content;
  if (!aiEnabled()) return { source: 'heuristic', ...heuristicChat(latest, ctx) };

  const proposals = [];
  const tools = [
    betaZodTool({
      name: 'get_schedule',
      description: "Returns the user's quiet blocks for the next 7 days, grouped by local date, with local start/end times.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify({ now: { date: ctx.today, time: ctx.nowTime, timeZone: ctx.timeZone }, days: ctx.weekSummary.days }),
    }),
    betaZodTool({
      name: 'get_week_stats',
      description: 'Returns total quiet hours, hours per category, tight gaps between blocks, and a rule-based 0-100 score for the next 7 days.',
      inputSchema: z.object({}),
      run: async () => {
        const { days, ...totals } = ctx.weekSummary;
        const { score, headline } = heuristicInsights(ctx.weekSummary);
        return JSON.stringify({ ...totals, score, headline });
      },
    }),
    betaZodTool({
      name: 'propose_blocks',
      description: 'Shows schedule proposals to the user as cards they can confirm. Does not modify the calendar.',
      inputSchema: z.object({ proposals: z.array(ProposalSchema) }),
      run: async ({ proposals: items }) => {
        const valid = items.map((p) => normalizeProposal(p, ctx.today)).filter(Boolean);
        proposals.push(...valid);
        return valid.length
          ? `Showed ${valid.length} proposal card(s) to the user. They are NOT on the calendar until the user confirms.`
          : 'No valid proposals: times must be HH:MM, with at least one day of week.';
      },
    }),
  ];

  try {
    const final = await getClient().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 6,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' }, // chat is interactive: keep replies fast
      system: CHAT_SYSTEM,
      tools,
      messages: history.slice(-MAX_HISTORY),
    });
    if (final.stop_reason === 'refusal') {
      return { source: 'claude', reply: "Sorry, I can't help with that one. I can help you plan sleep, study or focus time, though.", proposals };
    }
    const reply = final.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { source: 'claude', reply: reply || 'Done! Take a look at the proposals below.', proposals };
  } catch (err) {
    console.warn('[ai] chat fell back to heuristic:', describeError(err));
    return { source: 'heuristic', warning: `${describeError(err)}. Answered with the offline assistant.`, ...heuristicChat(latest, ctx) };
  }
}

function cleanInsights(out, today) {
  return {
    score: Math.max(0, Math.min(100, Math.round(out.score))),
    headline: out.headline,
    suggestions: out.suggestions.slice(0, 5).map((s) => ({
      title: s.title,
      detail: s.detail,
      proposal: s.proposal ? normalizeProposal(s.proposal, today) : null,
    })),
  };
}
