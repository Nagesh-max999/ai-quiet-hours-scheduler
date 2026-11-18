// Schedule analytics: turns a user's upcoming blocks into a compact summary
// (also used as Claude's input) plus a rule-based "quiet score" and tips.

import { addDays, localParts, WEEKDAYS } from './time.js';

const HOUR = 3600_000;

/** Summarise the next 7 days of blocks in the user's local time. */
export function summarizeWeek(blocks, { now = new Date(), timeZone = 'UTC' } = {}) {
  const today = localParts(now, timeZone).date;
  const horizon = new Date(now.getTime() + 7 * 24 * HOUR);
  const upcoming = blocks
    .filter((b) => new Date(b.end) > now && new Date(b.start) < horizon)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    return { date, weekday, blocks: [], quietHours: 0, sleepHours: 0 };
  });
  const byDate = new Map(days.map((d) => [d.date, d]));

  const byCategory = {};
  let totalHours = 0;
  for (const b of upcoming) {
    const hours = (new Date(b.end) - new Date(b.start)) / HOUR;
    const s = localParts(b.start, timeZone);
    const e = localParts(b.end, timeZone);
    totalHours += hours;
    byCategory[b.category] = (byCategory[b.category] ?? 0) + hours;
    // Sleep that starts after midnight counts toward the previous night.
    const anchor = b.category === 'sleep' && s.time < '05:00' ? addDays(s.date, -1) : s.date;
    const day = byDate.get(anchor);
    if (day) {
      day.blocks.push({ title: b.title, category: b.category, start: s.time, end: e.time, endsNextDay: e.date !== s.date, hours: round(hours) });
      day.quietHours += hours;
      if (b.category === 'sleep') day.sleepHours += hours;
    }
  }
  for (const d of days) {
    d.quietHours = round(d.quietHours);
    d.sleepHours = round(d.sleepHours);
  }

  // Back-to-back blocks with less than 10 minutes in between.
  const tightGaps = [];
  for (let i = 1; i < upcoming.length; i++) {
    const gapMin = (new Date(upcoming[i].start) - new Date(upcoming[i - 1].end)) / 60000;
    if (gapMin >= 0 && gapMin < 10) {
      tightGaps.push({ after: upcoming[i - 1].title, before: upcoming[i].title, at: localParts(upcoming[i].start, timeZone).date });
    }
  }

  return {
    today,
    timeZone,
    blockCount: upcoming.length,
    totalQuietHours: round(totalHours),
    hoursByCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round(v)])),
    days,
    tightGaps,
  };
}

/** Rule-based insights, same shape as the Claude response. */
export function heuristicInsights(summary) {
  const suggestions = [];
  let score = 50;

  if (summary.blockCount === 0) {
    return {
      score: 0,
      headline: 'Your week has no protected quiet time yet.',
      suggestions: [
        suggestion('Start with a sleep routine', 'Protecting 8 hours of sleep is the highest-impact quiet block you can add.', {
          title: 'Sleep', category: 'sleep', startTime: '22:30', endTime: '06:30', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: summary.today, repeatWeeks: 2, reminderMinutes: 15,
        }),
        suggestion('Add a daily deep-focus window', 'Two uninterrupted hours each weekday morning is where most deep work happens.', {
          title: 'Deep focus', category: 'focus', startTime: '09:00', endTime: '11:00', daysOfWeek: [1, 2, 3, 4, 5], startDate: summary.today, repeatWeeks: 2, reminderMinutes: 10,
        }),
      ],
    };
  }

  const nightsWithoutSleep = summary.days.filter((d) => d.sleepHours === 0);
  const shortNights = summary.days.filter((d) => d.sleepHours > 0 && d.sleepHours < 7);
  const sleepDays = 7 - nightsWithoutSleep.length;
  score += sleepDays * 4; // up to +28
  score -= shortNights.length * 3;

  if (nightsWithoutSleep.length > 0) {
    suggestions.push(
      suggestion(
        `Protect sleep on ${nightsWithoutSleep.length} more night${nightsWithoutSleep.length > 1 ? 's' : ''}`,
        `No sleep block on ${nightsWithoutSleep.map((d) => d.weekday).join(', ')}. Consistent sleep times improve focus the next day.`,
        {
          title: 'Sleep', category: 'sleep', startTime: '22:30', endTime: '06:30',
          daysOfWeek: [...new Set(nightsWithoutSleep.map((d) => WEEKDAYS.indexOf(d.weekday)))],
          startDate: summary.today, repeatWeeks: 1, reminderMinutes: 15,
        },
      ),
    );
  }
  if (shortNights.length > 0) {
    suggestions.push(suggestion('Some nights are under 7 hours', `${shortNights.map((d) => d.weekday).join(', ')} ${shortNights.length > 1 ? 'have' : 'has'} less than 7 hours of protected sleep. Consider extending them.`));
  }

  const focusHours = (summary.hoursByCategory.focus ?? 0) + (summary.hoursByCategory.study ?? 0);
  if (focusHours >= 6) score += 15;
  else if (focusHours > 0) score += 7;
  else {
    suggestions.push(
      suggestion('No focus or study time this week', 'Block a recurring 2-hour slot for deep work so notifications cannot break it up.', {
        title: 'Deep focus', category: 'focus', startTime: '09:00', endTime: '11:00', daysOfWeek: [1, 2, 3, 4, 5], startDate: summary.today, repeatWeeks: 1, reminderMinutes: 10,
      }),
    );
  }

  const longSessions = summary.days.flatMap((d) => d.blocks.filter((b) => ['focus', 'study'].includes(b.category) && b.hours > 3));
  if (longSessions.length) {
    score -= 4;
    suggestions.push(suggestion('Break up long focus sessions', `${longSessions.length} focus/study block${longSessions.length > 1 ? 's run' : ' runs'} over 3 hours. Splitting them with a 15-minute break keeps attention high.`));
  }
  if (summary.tightGaps.length) {
    score -= 3;
    suggestions.push(suggestion('Add buffers between blocks', `${summary.tightGaps.length} block${summary.tightGaps.length > 1 ? 's start' : ' starts'} right after another ends. A 10-minute buffer helps you transition.`));
  }
  if (!summary.hoursByCategory.wellness) {
    suggestions.push(
      suggestion('Add a short wind-down', 'A 30-minute screen-free wind-down before bed makes it easier to fall asleep on time.', {
        title: 'Wind-down', category: 'wellness', startTime: '22:00', endTime: '22:30', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: summary.today, repeatWeeks: 1, reminderMinutes: 5,
      }),
    );
  } else score += 5;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const headline =
    score >= 80 ? 'Great balance. Your quiet time is well protected.'
      : score >= 60 ? 'Solid foundation, with a few gaps to close.'
        : 'Your schedule has room for more protected quiet time.';
  return { score, headline, suggestions: suggestions.slice(0, 5) };
}

function suggestion(title, detail, proposal = null) {
  return { title, detail, proposal };
}

function round(n) {
  return Math.round(n * 10) / 10;
}
