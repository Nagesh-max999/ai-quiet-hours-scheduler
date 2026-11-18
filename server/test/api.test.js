import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db.js';

process.env.AI_DISABLED = 'true'; // integration tests use the offline engine

let server;
let base;
let token;

before(async () => {
  server = createApp(createStore(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, path, body, auth = token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('auth: register, duplicate, login, me', async () => {
  const reg = await call('POST', '/auth/register', { name: 'Sam', email: 'Sam@Example.com', password: 'password123', timeZone: 'UTC' }, null);
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'sam@example.com');
  assert.equal(reg.body.user.passwordHash, undefined);

  assert.equal((await call('POST', '/auth/register', { name: 'S', email: 'sam@example.com', password: 'password123' }, null)).status, 409);
  assert.equal((await call('POST', '/auth/login', { email: 'sam@example.com', password: 'wrong-password' }, null)).status, 401);

  const login = await call('POST', '/auth/login', { email: 'sam@example.com', password: 'password123' }, null);
  assert.equal(login.status, 200);
  token = login.body.token;
  assert.equal((await call('GET', '/auth/me')).body.user.name, 'Sam');
  assert.equal((await call('GET', '/blocks', null, 'bad-token')).status, 401);
});

test('blocks: create, conflict (409), skipConflicts batch, update, delete series', async () => {
  const one = await call('POST', '/blocks', { title: 'Focus', category: 'focus', start: '2030-01-07T09:00:00Z', end: '2030-01-07T11:00:00Z' });
  assert.equal(one.status, 201);
  const id = one.body.blocks[0].id;

  const clash = await call('POST', '/blocks', { title: 'Clash', start: '2030-01-07T10:00:00Z', end: '2030-01-07T12:00:00Z' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.conflicts[0].conflictsWith.title, 'Focus');

  const batch = [
    { title: 'Study', category: 'study', start: '2030-01-07T10:30:00Z', end: '2030-01-07T11:30:00Z' },
    { title: 'Study', category: 'study', start: '2030-01-08T10:30:00Z', end: '2030-01-08T11:30:00Z' },
    { title: 'Study', category: 'study', start: '2030-01-09T10:30:00Z', end: '2030-01-09T11:30:00Z' },
  ];
  assert.equal((await call('POST', '/blocks', { blocks: batch })).status, 409);
  const partial = await call('POST', '/blocks', { blocks: batch, skipConflicts: true });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.blocks.length, 2);
  assert.equal(partial.body.skipped.length, 1);
  const seriesFirst = partial.body.blocks[0];
  assert.ok(seriesFirst.seriesId);

  const upd = await call('PUT', `/blocks/${id}`, { title: 'Deep focus', end: '2030-01-07T10:00:00Z' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.block.title, 'Deep focus');

  const del = await call('DELETE', `/blocks/${seriesFirst.id}?series=1`);
  assert.equal(del.body.removed, 2);
  const list = await call('GET', '/blocks');
  assert.equal(list.body.blocks.length, 1);
});

test('ai: parse and insights work with the offline engine', async () => {
  const parsed = await call('POST', '/ai/parse', { text: 'sleep 11pm-7am every night', timeZone: 'UTC' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.source, 'heuristic');
  assert.equal(parsed.body.proposals[0].startTime, '23:00');

  const insights = await call('POST', '/ai/insights', { timeZone: 'UTC' });
  assert.equal(insights.status, 200);
  assert.equal(typeof insights.body.score, 'number');
  assert.ok(Array.isArray(insights.body.suggestions));

  assert.equal((await call('POST', '/ai/parse', { text: '' })).status, 400);
});

test('ai chat: multi-turn history, proposals, schedule questions, validation', async () => {
  const plan = await call('POST', '/ai/chat', {
    timeZone: 'UTC',
    messages: [
      { role: 'assistant', content: 'Hi! How can I help?' }, // leading assistant turn is dropped
      { role: 'user', content: 'Block study time 7-9pm on weekdays' },
    ],
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.source, 'heuristic');
  assert.equal(plan.body.proposals[0].startTime, '19:00');
  assert.match(plan.body.reply, /Add to calendar/);

  const sched = await call('POST', '/ai/chat', { messages: [{ role: 'user', content: "what's coming up this week?" }] });
  assert.equal(sched.status, 200);
  assert.deepEqual(sched.body.proposals, []);

  const tips = await call('POST', '/ai/chat', { messages: [{ role: 'user', content: 'any tips to improve my week?' }] });
  assert.match(tips.body.reply, /score/i);

  assert.equal((await call('POST', '/ai/chat', { messages: [{ role: 'assistant', content: 'hi' }] })).status, 400);
  assert.equal((await call('POST', '/ai/chat', { messages: 'nope' })).status, 400);
});
