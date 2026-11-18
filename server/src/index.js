import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createStore } from './db.js';
import { startScheduler } from './services/scheduler.js';
import { aiStatus } from './services/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5000);
const DB_FILE = process.env.DB_FILE || path.resolve(here, '../data/db.json');

const store = createStore(DB_FILE);
const app = createApp(store);
startScheduler(store);

app.listen(PORT, () => {
  const ai = aiStatus();
  console.log(`Quiet Hours API listening on http://localhost:${PORT}`);
  console.log(ai.provider === 'claude' ? `AI: Claude (${ai.model})` : 'AI: offline heuristic engine (set ANTHROPIC_API_KEY to enable Claude)');
});
