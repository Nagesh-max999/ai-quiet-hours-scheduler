// Rule-based natural-language schedule parser. Used when no Claude API key is
// configured, or as a fallback if the Claude request fails. It understands
// phrases like "sleep 10:30pm-6:30am every night and study 2-4pm on weekdays".

import { addDays, fromMinutes, toMinutes } from './time.js';
import { normalizeProposal } from './blocks.js';

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const RANGE_RE = new RegExp(String.raw`(?:from\s+)?${TIME}\s*(?:-|–|—|to|until|till)\s*${TIME}`, 'gi');
const NAMED_TIMES = { midnight: 0, noon: 12 * 60 };

const DAY_NAMES = [
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
];

const CATEGORY_RULES = [
  { category: 'sleep', title: 'Sleep', words: ['sleep', 'bed', 'night', 'nightly', 'rest', 'nap'], defaults: ['22:30', '06:30'] },
  { category: 'study', title: 'Study session', words: ['study', 'exam', 'revision', 'revise', 'homework', 'learn', 'class', 'lecture'], defaults: ['19:00', '21:00'] },
  { category: 'focus', title: 'Deep focus', words: ['focus', 'deep work', 'work', 'coding', 'code', 'writing', 'project'], defaults: ['09:00', '11:00'] },
  { category: 'family', title: 'Family time', words: ['family', 'dinner', 'kids', 'partner', 'friends'], defaults: ['18:30', '20:00'] },
  { category: 'wellness', title: 'Wellness break', words: ['meditat', 'yoga', 'gym', 'workout', 'exercise', 'read', 'walk', 'relax', 'unwind'], defaults: ['07:00', '07:45'] },
];

/**
 * @param {string} text
 * @param {{ today: string, weekday: number, nowTime: string }} ctx
 * @returns {{ proposals: object[], clarification: string|null }}
 */
export function parseSchedule(text, ctx) {
  const input = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!input) return { proposals: [], clarification: 'Describe when you want quiet time, e.g. "study 7-9pm on weekdays".' };

  const clauses = splitClauses(input);
  const proposals = [];

  for (const clause of clauses) {
    const range = clause.range ?? defaultRangeFor(clause.text);
    if (!range) continue;
    const cat = detectCategory(clause.text);
    const { days, recurring, startDate } = detectDays(clause.text, ctx, range);
    const weeks = detectWeeks(clause.text) ?? (recurring ? 2 : 1);
    const reminder = detectReminder(clause.text);

    const p = normalizeProposal(
      {
        title: cat.title,
        category: cat.category,
        startTime: range.start,
        endTime: range.end,
        daysOfWeek: days,
        startDate,
        repeatWeeks: weeks,
        reminderMinutes: reminder ?? 10,
        rationale: clause.range ? 'Parsed from your description.' : `No time given, so a typical ${cat.category} window was used.`,
      },
      ctx.today,
    );
    if (p) proposals.push(p);
  }

  return {
    proposals,
    clarification: proposals.length
      ? null
      : 'I could not find a time range. Try something like "deep work 9-11am Mon, Wed, Fri".',
  };
}

/**
 * Split the text into clauses, each holding at most one time range. Clauses
 * without a range attach to the previous ranged clause (or the next one if
 * none came before), so "monday and wednesday 2-4pm" stays together.
 */
function splitClauses(input) {
  const parts = input.split(/\s*(?:,|;|\.(?!\d)|\band then\b|\bthen\b|\balso\b|\band\b)\s*/).filter(Boolean);
  const clauses = [];
  let pending = [];
  for (const part of parts) {
    const ranges = [...part.matchAll(RANGE_RE)];
    if (ranges.length === 0) {
      if (clauses.length && !/\b(sleep|study|focus|work|family|gym|yoga|read)\b/.test(part)) {
        clauses[clauses.length - 1].text += ` ${part}`;
      } else {
        pending.push(part);
      }
      continue;
    }
    const range = toRange(ranges[0]);
    clauses.push({ text: [...pending, part].join(' '), range });
    pending = [];
  }
  // Leftover clauses with no time (e.g. "sleep every night") get category defaults.
  if (pending.length) clauses.push({ text: pending.join(' '), range: null });
  return clauses;
}

function toRange(m) {
  let [, sh, sm, sap, eh, em, eap] = m;
  sap = sap?.[0];
  eap = eap?.[0];
  let start = clock(+sh, +(sm ?? 0), sap);
  const end = clock(+eh, +(em ?? 0), eap);
  if (start == null || end == null) return null;
  // "2-4pm" -> start inherits pm; "10-6am" -> start is the opposite (10pm).
  if (!sap && eap) {
    start = clock(+sh, +(sm ?? 0), eap);
    if (start >= end) start = clock(+sh, +(sm ?? 0), eap === 'a' ? 'p' : 'a');
  }
  let finalEnd = end;
  if (!sap && !eap) {
    if (+sh <= 7) start += 12 * 60; // "study 7-9" means the evening
    // "1-3" -> 13:00-15:00 rather than an overnight 01:00 -> 03:00 surprise.
    if (finalEnd <= start && finalEnd + 720 > start && finalEnd + 720 < 1440) finalEnd += 720;
  }
  return { start: fromMinutes(start), end: fromMinutes(finalEnd) };
}

function clock(h, m, ap) {
  if (h > 23 || m > 59) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h * 60 + m;
}

function defaultRangeFor(text) {
  const named = text.match(/(midnight|noon)\s*(?:-|to|until)\s*(\d{1,2})\s*(am|pm)?/);
  if (named) {
    const end = clock(+named[2], 0, named[3]?.[0]);
    return { start: fromMinutes(NAMED_TIMES[named[1]]), end: fromMinutes(end) };
  }
  const cat = detectCategory(text);
  if (!cat.matched) return null;
  return { start: cat.defaults[0], end: cat.defaults[1] };
}

function detectCategory(text) {
  let best = null;
  for (const rule of CATEGORY_RULES) {
    for (const w of rule.words) {
      const idx = text.indexOf(w);
      if (idx !== -1 && (best == null || idx < best.idx)) best = { idx, rule };
    }
  }
  if (!best) return { category: 'other', title: 'Quiet time', defaults: null, matched: false };
  return { ...best.rule, matched: true };
}

function detectDays(text, ctx, range) {
  const all = [0, 1, 2, 3, 4, 5, 6];
  if (/\b(every ?day|daily|every night|nightly|each night|each day|all week)\b/.test(text)) {
    return { days: all, recurring: true, startDate: ctx.today };
  }
  if (/\bweekdays?\b|\bmon(day)?\s*(?:-|to|through|thru)\s*fri(day)?\b/.test(text)) {
    return { days: [1, 2, 3, 4, 5], recurring: true, startDate: ctx.today };
  }
  if (/\bweekends?\b/.test(text)) return { days: [0, 6], recurring: true, startDate: ctx.today };

  const named = DAY_NAMES.filter(([abbr]) => new RegExp(String.raw`\b${abbr}[a-z]*\b`).test(text)).map(([, i]) => i);
  if (named.length) {
    const recurring = /\bevery\b|\beach\b|\bweekly\b|\bfor \w+ weeks?\b|\b(sun|mon|tues|wednes|thurs|fri|satur)days\b/.test(text);
    return { days: named, recurring, startDate: ctx.today };
  }

  if (/\btomorrow\b/.test(text)) {
    return { days: [(ctx.weekday + 1) % 7], recurring: false, startDate: addDays(ctx.today, 1) };
  }
  // Today, unless the slot already ended -> tomorrow.
  const endedToday = toMinutes(range.end) > toMinutes(range.start) && toMinutes(range.end) <= toMinutes(ctx.nowTime);
  if (endedToday && !/\btoday|tonight\b/.test(text)) {
    return { days: [(ctx.weekday + 1) % 7], recurring: false, startDate: addDays(ctx.today, 1) };
  }
  return { days: [ctx.weekday], recurring: false, startDate: ctx.today };
}

function detectWeeks(text) {
  const m = text.match(/\b(?:for|next)\s+(\d+|one|two|three|four)\s+weeks?\b/);
  if (!m) return null;
  const words = { one: 1, two: 2, three: 3, four: 4 };
  return words[m[1]] ?? Number(m[1]);
}

function detectReminder(text) {
  const m = text.match(/remind(?:er)?(?: me)?\s+(\d+)\s*(?:min|minutes?)/);
  if (m) return Number(m[1]);
  if (/\bno reminders?\b/.test(text)) return 0;
  return null;
}
