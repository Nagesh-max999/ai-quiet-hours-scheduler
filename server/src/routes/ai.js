import { Router } from 'express';
import { chat, generateInsights, parseRequest } from '../services/ai.js';
import { summarizeWeek } from '../lib/insights.js';
import { isValidTimeZone, localParts } from '../lib/time.js';

// Simple per-user sliding-window limiter so the AI endpoints can't run up a bill.
const WINDOW_MS = 60_000;
const MAX_CALLS = Number(process.env.AI_RATE_LIMIT_PER_MIN || 15);
const calls = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (calls.get(req.user.id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_CALLS) {
    return res.status(429).json({ error: 'Too many AI requests. Try again in a minute.' });
  }
  recent.push(now);
  calls.set(req.user.id, recent);
  next();
}

function context(req, store) {
  const timeZone = isValidTimeZone(req.body?.timeZone) ? req.body.timeZone : req.user.preferences?.timeZone || 'UTC';
  const now = new Date();
  const p = localParts(now, timeZone);
  const weekSummary = summarizeWeek(store.listBlocks(req.user.id), { now, timeZone });
  return { timeZone, today: p.date, weekday: p.weekdayIndex, nowTime: p.time, weekSummary };
}

export function aiRoutes(store) {
  const r = Router();

  r.post('/parse', rateLimit, async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'Describe the quiet hours you want' });
      if (text.length > 1000) return res.status(400).json({ error: 'Please keep requests under 1000 characters' });
      res.json(await parseRequest(text, context(req, store)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/chat', rateLimit, async (req, res, next) => {
    try {
      const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
      // Keep only well-formed text turns, trimmed, alternating, starting with a user turn.
      const history = [];
      for (const m of raw.slice(-20)) {
        if (!['user', 'assistant'].includes(m?.role)) continue;
        const content = String(m.content ?? '').trim().slice(0, 2000);
        if (!content) continue;
        if (history.length && history[history.length - 1].role === m.role) history[history.length - 1].content += `\n${content}`;
        else history.push({ role: m.role, content });
      }
      while (history.length && history[0].role !== 'user') history.shift();
      if (!history.length || history[history.length - 1].role !== 'user') {
        return res.status(400).json({ error: 'Send a message to chat' });
      }
      res.json(await chat(history, context(req, store)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/insights', rateLimit, async (req, res, next) => {
    try {
      const { weekSummary } = context(req, store);
      res.json({ summary: weekSummary, ...(await generateInsights(weekSummary)) });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
