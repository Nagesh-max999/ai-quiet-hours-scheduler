import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { publicUser, requireAuth, signToken } from '../auth.js';
import { isValidTimeZone } from '../lib/time.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function authRoutes(store) {
  const r = Router();

  r.post('/register', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const timeZone = isValidTimeZone(req.body?.timeZone) ? req.body.timeZone : 'UTC';

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (store.findUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });

    const user = store.createUser({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      preferences: { timeZone, defaultReminderMinutes: 10, emailReminders: false },
    });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  });

  r.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const user = store.findUserByEmail(email);
    const ok = user && (await bcrypt.compare(String(req.body?.password ?? ''), user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  r.get('/me', requireAuth(store), (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/preferences', requireAuth(store), (req, res) => {
    const prefs = { ...req.user.preferences };
    const body = req.body ?? {};
    if (body.timeZone !== undefined) {
      if (!isValidTimeZone(body.timeZone)) return res.status(400).json({ error: 'Unknown time zone' });
      prefs.timeZone = body.timeZone;
    }
    if (body.defaultReminderMinutes !== undefined) {
      const n = Number(body.defaultReminderMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 120) return res.status(400).json({ error: 'Reminder must be 0-120 minutes' });
      prefs.defaultReminderMinutes = n;
    }
    if (body.emailReminders !== undefined) prefs.emailReminders = Boolean(body.emailReminders);
    const user = store.updateUser(req.user.id, { preferences: prefs });
    res.json({ user: publicUser(user) });
  });

  return r;
}
