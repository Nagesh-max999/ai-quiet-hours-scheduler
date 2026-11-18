// Pure domain logic for quiet-hour blocks: validation, overlap detection,
// and normalising schedule "proposals" (from Claude or the heuristic parser).

import { HHMM, YMD } from './time.js';

export const CATEGORIES = ['sleep', 'study', 'focus', 'family', 'wellness', 'other'];
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Validate a block payload. Returns { value } or { error }. */
export function validateBlock(input) {
  if (!input || typeof input !== 'object') return { error: 'Block payload is required' };
  const title = String(input.title ?? '').trim();
  if (!title) return { error: 'Title is required' };
  if (title.length > 80) return { error: 'Title must be 80 characters or fewer' };

  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: 'Start and end must be valid dates' };
  }
  if (end <= start) return { error: 'End time must be after start time' };
  if (end - start > MAX_DURATION_MS) return { error: 'A quiet block cannot be longer than 24 hours' };

  const category = CATEGORIES.includes(input.category) ? input.category : 'other';
  const reminderMinutes = clampInt(input.reminderMinutes, 0, 120, 10);
  const notes = String(input.notes ?? '').slice(0, 500);

  return {
    value: {
      title,
      category,
      start: start.toISOString(),
      end: end.toISOString(),
      reminderMinutes,
      notes,
      source: input.source === 'ai' ? 'ai' : 'manual',
    },
  };
}

export function overlaps(a, b) {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
}

/**
 * Find conflicts for a list of candidate blocks against existing blocks
 * and against each other. Returns [{ index, conflictsWith }].
 */
export function findConflicts(candidates, existing, { ignoreId } = {}) {
  const conflicts = [];
  const accepted = [];
  candidates.forEach((cand, index) => {
    const hit =
      existing.find((b) => b.id !== ignoreId && overlaps(cand, b)) ||
      accepted.find((b) => overlaps(cand, b));
    if (hit) {
      conflicts.push({
        index,
        title: cand.title,
        start: cand.start,
        end: cand.end,
        conflictsWith: { id: hit.id ?? null, title: hit.title, start: hit.start, end: hit.end },
      });
    } else {
      accepted.push(cand);
    }
  });
  return conflicts;
}

/**
 * Normalise a schedule proposal: { title, category, startTime, endTime,
 * daysOfWeek, startDate, repeatWeeks, reminderMinutes, rationale }.
 * Clamps/cleans anything an LLM or parser might get slightly wrong.
 */
export function normalizeProposal(p, fallbackDate) {
  if (!p || typeof p !== 'object') return null;
  if (!HHMM.test(p.startTime ?? '') || !HHMM.test(p.endTime ?? '')) return null;
  if (p.startTime === p.endTime) return null;
  const days = [...new Set((p.daysOfWeek ?? []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (days.length === 0) return null;
  return {
    title: String(p.title ?? 'Quiet time').trim().slice(0, 80) || 'Quiet time',
    category: CATEGORIES.includes(p.category) ? p.category : 'other',
    startTime: p.startTime,
    endTime: p.endTime,
    daysOfWeek: days,
    startDate: YMD.test(p.startDate ?? '') ? p.startDate : fallbackDate,
    repeatWeeks: clampInt(p.repeatWeeks, 1, 8, 1),
    reminderMinutes: clampInt(p.reminderMinutes, 0, 120, 10),
    rationale: String(p.rationale ?? '').slice(0, 300),
  };
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
