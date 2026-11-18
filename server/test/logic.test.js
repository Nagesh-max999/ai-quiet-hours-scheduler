import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, normalizeProposal, overlaps, validateBlock } from '../src/lib/blocks.js';
import { parseSchedule } from '../src/lib/heuristicParser.js';
import { heuristicInsights, summarizeWeek } from '../src/lib/insights.js';
import { localParts } from '../src/lib/time.js';
import { createStore } from '../src/db.js';
import { runSchedulerTick } from '../src/services/scheduler.js';

// Wednesday 2026-11-11, 10:00
const ctx = { today: '2026-11-11', weekday: 3, nowTime: '10:00' };

test('overlaps: touching blocks do not overlap', () => {
  const a = { start: '2026-11-11T10:00:00Z', end: '2026-11-11T11:00:00Z' };
  assert.equal(overlaps(a, { start: '2026-11-11T11:00:00Z', end: '2026-11-11T12:00:00Z' }), false);
  assert.equal(overlaps(a, { start: '2026-11-11T10:30:00Z', end: '2026-11-11T12:00:00Z' }), true);
});

test('findConflicts detects clashes with existing blocks and within the batch', () => {
  const existing = [{ id: 'x', title: 'Gym', start: '2026-11-11T18:00:00Z', end: '2026-11-11T19:00:00Z' }];
  const candidates = [
    { title: 'A', start: '2026-11-11T18:30:00Z', end: '2026-11-11T20:00:00Z' }, // clashes with Gym
    { title: 'B', start: '2026-11-11T20:00:00Z', end: '2026-11-11T21:00:00Z' }, // ok
    { title: 'C', start: '2026-11-11T20:30:00Z', end: '2026-11-11T21:30:00Z' }, // clashes with B
  ];
  const conflicts = findConflicts(candidates, existing);
  assert.deepEqual(conflicts.map((c) => c.index), [0, 2]);
  assert.equal(conflicts[0].conflictsWith.title, 'Gym');
  assert.equal(conflicts[1].conflictsWith.title, 'B');
});

test('validateBlock rejects bad input and normalises good input', () => {
  assert.match(validateBlock({ title: '', start: 'x', end: 'y' }).error, /Title/);
  assert.match(validateBlock({ title: 'T', start: '2026-11-11T10:00Z', end: '2026-11-11T09:00Z' }).error, /after/);
  assert.match(validateBlock({ title: 'T', start: '2026-11-11T10:00Z', end: '2026-11-13T10:00Z' }).error, /24 hours/);
  const { value } = validateBlock({ title: ' Study ', category: 'nope', start: '2026-11-11T10:00Z', end: '2026-11-11T12:00Z', reminderMinutes: 999 });
  assert.equal(value.title, 'Study');
  assert.equal(value.category, 'other');
  assert.equal(value.reminderMinutes, 120);
});

test('normalizeProposal clamps and rejects invalid proposals', () => {
  assert.equal(normalizeProposal({ startTime: '25:00', endTime: '10:00', daysOfWeek: [1] }, ctx.today), null);
  assert.equal(normalizeProposal({ startTime: '09:00', endTime: '10:00', daysOfWeek: [] }, ctx.today), null);
  const p = normalizeProposal({ title: 'X', startTime: '09:00', endTime: '10:00', daysOfWeek: [5, 1, 1, 9], repeatWeeks: 50 }, ctx.today);
  assert.deepEqual(p.daysOfWeek, [1, 5]);
  assert.equal(p.repeatWeeks, 8);
  assert.equal(p.startDate, ctx.today);
});

test('parser: multi-clause request with overnight sleep and weekday study', () => {
  const { proposals } = parseSchedule('Sleep 10:30pm-6:30am every night and study 2-4pm on weekdays', ctx);
  assert.equal(proposals.length, 2);
  const [sleep, study] = proposals;
  assert.equal(sleep.category, 'sleep');
  assert.equal(sleep.startTime, '22:30');
  assert.equal(sleep.endTime, '06:30');
  assert.deepEqual(sleep.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(sleep.repeatWeeks, 2);
  assert.equal(study.category, 'study');
  assert.equal(study.startTime, '14:00');
  assert.equal(study.endTime, '16:00');
  assert.deepEqual(study.daysOfWeek, [1, 2, 3, 4, 5]);
});

test('parser: meridiem inference and named days', () => {
  const [p] = parseSchedule('deep work 9-11am Mon, Wed and Fri for 3 weeks, remind me 5 minutes before', ctx).proposals;
  assert.equal(p.category, 'focus');
  assert.equal(p.startTime, '09:00');
  assert.equal(p.endTime, '11:00');
  assert.deepEqual(p.daysOfWeek, [1, 3, 5]);
  assert.equal(p.repeatWeeks, 3);
  assert.equal(p.reminderMinutes, 5);

  const [n] = parseSchedule('quiet 10-6am', ctx).proposals;
  assert.equal(n.startTime, '22:00');
  assert.equal(n.endTime, '06:00');
});

test('parser: "tomorrow" and default category window', () => {
  const [p] = parseSchedule('family dinner tomorrow 7-8:30pm', ctx).proposals;
  assert.equal(p.category, 'family');
  assert.equal(p.startDate, '2026-11-12');
  assert.deepEqual(p.daysOfWeek, [4]);
  assert.equal(p.endTime, '20:30');

  const res = parseSchedule('hello there', ctx);
  assert.equal(res.proposals.length, 0);
  assert.ok(res.clarification);
});

test('localParts respects time zones', () => {
  const p = localParts('2026-11-11T23:30:00Z', 'Asia/Kolkata');
  assert.equal(p.date, '2026-11-12');
  assert.equal(p.time, '05:00');
  assert.equal(p.weekday, 'Thursday');
});

test('insights: empty week scores 0 with starter suggestions; sleep improves score', () => {
  const now = new Date('2026-11-11T08:00:00Z');
  const empty = heuristicInsights(summarizeWeek([], { now, timeZone: 'UTC' }));
  assert.equal(empty.score, 0);
  assert.ok(empty.suggestions[0].proposal);

  const blocks = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    blocks.push({ title: 'Sleep', category: 'sleep', start: `${day}T22:30:00Z`, end: `${next}T06:30:00Z` });
  }
  const summary = summarizeWeek(blocks, { now, timeZone: 'UTC' });
  assert.equal(summary.days[0].sleepHours, 8);
  assert.ok(heuristicInsights(summary).score > 60);
});

test('scheduler sends each reminder exactly once', () => {
  const store = createStore(':memory:');
  const user = store.createUser({ name: 'A', email: 'a@x.com', passwordHash: 'h', preferences: {} });
  const now = new Date('2026-11-11T10:00:00Z');
  store.createBlocks(user.id, [
    { title: 'Soon', category: 'focus', start: '2026-11-11T10:08:00Z', end: '2026-11-11T11:00:00Z', reminderMinutes: 10 },
    { title: 'Later', category: 'focus', start: '2026-11-11T12:00:00Z', end: '2026-11-11T13:00:00Z', reminderMinutes: 10 },
  ]);
  assert.deepEqual(runSchedulerTick(store, now).map((f) => f.type), ['reminder']);
  assert.deepEqual(runSchedulerTick(store, now), []);
  const fired = runSchedulerTick(store, new Date('2026-11-11T10:08:30Z'));
  assert.deepEqual(fired.map((f) => f.type), ['started']);
});
