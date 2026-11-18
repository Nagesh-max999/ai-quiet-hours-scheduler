import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAuth, verifyToken } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { blockRoutes } from './routes/blocks.js';
import { aiRoutes } from './routes/ai.js';
import { aiStatus } from './services/ai.js';
import { addClient, emailEnabled } from './services/notifier.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(store) {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiStatus(), email: emailEnabled() }));

  app.use('/api/auth', authRoutes(store));
  app.use('/api/blocks', requireAuth(store), blockRoutes(store));
  app.use('/api/ai', requireAuth(store), aiRoutes(store));

  // Server-Sent Events stream. EventSource can't send headers, so the JWT
  // comes as a query param.
  app.get('/api/events', (req, res) => {
    const userId = verifyToken(String(req.query.token ?? ''));
    if (!userId || !store.findUserById(userId)) return res.status(401).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: connected\ndata: {}\n\n`);
    const remove = addClient(userId, res);
    req.on('close', remove);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // In production, serve the built React app from the same origin.
  const dist = path.resolve(here, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
