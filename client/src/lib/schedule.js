// Client-side schedule helpers. All wall-clock math happens in the browser's
// local time zone, which is the user's.

export const CATEGORIES = {
  sleep: { label: 'Sleep', icon: '🌙', color: 'var(--cat-sleep)' },
  study: { label: 'Study', icon: '📚', color: 'var(--cat-study)' },
  focus: { label: 'Deep focus', icon: '🎯', color: 'var(--cat-focus)' },
  family: { label: 'Family', icon: '🏡', color: 'var(--cat-family)' },
  wellness: { label: 'Wellness', icon: '🧘', color: 'var(--cat-wellness)' },
  other: { label: 'Other', icon: '🔕', color: 'var(--cat-other)' },
};

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;

/** Expand a proposal pattern into concrete blocks (skipping ones already over). */
export function expandProposal(p, now = new Date()) {
  const [y, m, d] = p.startDate.split('-').map(Number);
  const [sh, sm] = p.startTime.split(':').map(Number);
  const [eh, em] = p.endTime.split(':').map(Number);
  const overnight = eh * 60 + em <= sh * 60 + sm;
  const out = [];
  for (let i = 0; i < p.repeatWeeks * 7; i++) {
    const day = new Date(y, m - 1, d + i);
    if (!p.daysOfWeek.includes(day.getDay())) continue;
    const start = new Date(y, m - 1, d + i, sh, sm);
    const end = new Date(y, m - 1, d + i + (overnight ? 1 : 0), eh, em);
    if (end <= now) continue;
    out.push({
      title: p.title,
      category: p.category,
      start: start.toISOString(),
      end: end.toISOString(),
      reminderMinutes: p.reminderMinutes,
      source: 'ai',
    });
  }
  return out;
}

/** Monday 00:00 of the week containing `date`. */
export function startOfWeek(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Split blocks into per-day segments for the 7 days from weekStart. Overnight
 * blocks appear on both days. Positions are in minutes from local midnight.
 */
export function layoutWeek(blocks, weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const dayStart = addDays(weekStart, i);
    const dayEnd = addDays(weekStart, i + 1);
    const segments = blocks
      .filter((b) => new Date(b.start) < dayEnd && new Date(b.end) > dayStart)
      .map((b) => {
        const s = Math.max(new Date(b.start), dayStart);
        const e = Math.min(new Date(b.end), dayEnd);
        return {
          block: b,
          top: (s - dayStart) / 60000,
          height: Math.max(15, (e - s) / 60000),
          continuesBefore: new Date(b.start) < dayStart,
          continuesAfter: new Date(b.end) > dayEnd,
        };
      });
    return { date: dayStart, segments };
  });
}

export function hoursBetween(start, end) {
  return (new Date(end) - new Date(start)) / 3_600_000;
}

/** Hours of a block that fall inside [from, to). */
export function overlapHours(block, from, to) {
  const s = Math.max(new Date(block.start), from);
  const e = Math.min(new Date(block.end), to);
  return e > s ? (e - s) / 3_600_000 : 0;
}

export function weekStats(blocks, weekStart, now = new Date()) {
  const weekEnd = addDays(weekStart, 7);
  const byCat = {};
  let total = 0;
  for (const b of blocks) {
    const h = overlapHours(b, weekStart, weekEnd);
    if (!h) continue;
    total += h;
    byCat[b.category] = (byCat[b.category] ?? 0) + h;
  }
  const active = blocks.find((b) => new Date(b.start) <= now && new Date(b.end) > now) ?? null;
  const next = blocks.filter((b) => new Date(b.start) > now).sort((a, b) => new Date(a.start) - new Date(b.start))[0] ?? null;
  const sleepNights = new Set(blocks.filter((b) => b.category === 'sleep' && overlapHours(b, weekStart, weekEnd)).map((b) => new Date(b.start).toDateString()));
  return {
    total,
    byCat,
    active,
    next,
    focusHours: (byCat.focus ?? 0) + (byCat.study ?? 0),
    avgSleep: sleepNights.size ? (byCat.sleep ?? 0) / sleepNights.size : 0,
  };
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(date) {
  return new Date(date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtHours(h) {
  if (!h) return '0h';
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins ? `${whole}h ${mins}m` : `${whole}h`;
}

export function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  return `in ${Math.round(hrs / 24)}d`;
}

export function describeDays(days) {
  const key = [...days].sort().join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]).join(', ');
}

/** Value for <input type="date"> / <input type="time"> from a Date. */
export function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function toTimeInput(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export { DAY_MS };
