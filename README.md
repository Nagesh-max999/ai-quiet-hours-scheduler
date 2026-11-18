# 🌙 AI-Assisted Quiet Hours Scheduler

A full-stack web app for planning and protecting your **quiet hours**: sleep, study, deep focus, and family time. You describe your ideal week in plain English. The AI assistant turns that into a conflict-free schedule, sends a live reminder before each block, and scores your week with suggestions you can apply in one click.

**Stack:** React 19 · Vite · Node.js · Express 5 · Claude API (structured outputs) · JWT · Server-Sent Events · node:test · Vitest

---

## Features

| | |
|---|---|
| ✨ **Natural-language scheduling** | "Sleep 10:30pm–6:30am every night and study 7–9pm on weekdays" becomes a preview of recurring blocks. Claude returns **schema-validated JSON** (Zod + structured outputs), and the server sanitises it again before use. |
| 💬 **AI chatbot ("Quiet")** | A floating chat assistant that holds multi-turn conversations. It uses Claude **tool calling** (via the SDK tool runner) to read your real schedule and weekly stats, and to propose new blocks. Proposals appear as cards that need your confirmation, so the bot never changes your calendar on its own. An offline intent-based bot answers when no API key is set. |
| 🧠 **AI weekly insights** | A 0–100 quiet-time health score, plus specific suggestions (missing sleep, marathon sessions, back-to-back blocks). Each suggestion can carry a ready-made block pattern you apply with one click. |
| 🛡️ **Conflict detection** | Every create or update is checked for overlaps, both against your calendar and within a batch. A 409 response lists each clash so the UI can offer "add the rest, skip conflicts". |
| ⏰ **Real-time reminders** | A background scheduler checks every 30 seconds and pushes reminders and "quiet mode started" events over **SSE**. You also get browser notifications and optional email (SMTP). Each reminder is claimed before it is sent, so it fires **exactly once**. |
| 📅 **Weekly calendar** | A custom-built week view. Overnight blocks are split across days, a now-line tracks the current time, and you click any empty slot to create a block. |
| 🔁 **Series management** | Each AI proposal becomes a series. "Delete this & following" removes the remaining occurrences together. |
| 🔌 **Works offline from AI** | With no API key, a rule-based NLP parser and insights engine take over. On a Claude error (auth, rate limit, network), the app falls back to it automatically and shows a notice. |
| 🔐 **Auth & safety** | bcrypt password hashing, JWT sessions, a per-user rate limit on AI calls, input validation on every route. |
| 🔄 **Multi-tab sync** | Changes in one tab or device refresh the others live. |

## Architecture

```
client/ (React + Vite)                 server/ (Express)
 ├─ pages/Dashboard                     ├─ routes/   auth · blocks · ai
 ├─ components/                         ├─ services/
 │   WeekCalendar, AIAssistant,         │   ai.js         Claude + automatic fallback
 │   InsightsPanel, BlockModal …        │   scheduler.js  reminder job (exactly-once)
 ├─ hooks/useEvents (SSE)               │   notifier.js   SSE hub + email
 └─ lib/schedule.js                     ├─ lib/
     pattern → blocks, week layout,     │   blocks.js          validation + overlap detection
     stats (local-time math)            │   heuristicParser.js offline NLP parser
                                        │   insights.js        weekly summary + scoring
          ── /api (Vite proxy) ──▶      └─ db.js   JSON document store (swappable)
```

**AI design.** The model never writes timestamps directly. Claude (or the offline parser) returns a compact *pattern*: `{ startTime, endTime, daysOfWeek, startDate, repeatWeeks }`. The browser expands it into concrete blocks in the user's own time zone. This keeps DST and time-zone math deterministic and testable, and makes the LLM output easy to validate.

## Getting started

Requires **Node.js 20.6+**.

```bash
npm install          # installs the root tooling
npm run setup        # installs server + client dependencies
npm run dev          # API on :5000, React app on http://localhost:5173
```

Open http://localhost:5173 and create an account.

### How to use it

1. **Sign up.** Your browser's time zone is saved with your account, so blocks show in local time.
2. **Describe your week** in the AI assistant box, for example *"sleep 11pm–7am every night, deep work 9–11am on weekdays"*.
3. **Review the proposals.** Each one shows its days, times, and how many weeks it repeats. Click **Add** to save it. If a proposal clashes with an existing block, you can skip the conflicts.
4. **Edit on the calendar.** Click an empty slot to create a block by hand, or click a block to edit or delete it.
5. **Chat with "Quiet"**, the bottom-right assistant. Ask it things like *"how much sleep am I getting?"* or *"find me two focus hours on Friday"*.
6. **Check Insights** to see your weekly score, then apply a suggestion with one click.

### Troubleshooting

- **Every API call returns 401 or unexpected data:** another program may already be using port 5000. On Windows, run `netstat -ano | findstr :5000` to check. Either stop that program, or set `PORT=5050` in `server/.env` and change the proxy target in `client/vite.config.js` to match.
- **Quick single-port run:** run `npm run build`, then `PORT=5050 npm start --prefix server`, and open http://localhost:5050.

### Enable Claude (optional)

```bash
cp server/.env.example server/.env
# then set ANTHROPIC_API_KEY=... in server/.env and restart
```

The header badge switches from **Offline AI** to **Claude AI**. The model defaults to `claude-opus-5-5`; override it with `CLAUDE_MODEL`.

### Email reminders (optional)

Fill in the `SMTP_*` values in `server/.env`, then turn on **Settings → Email reminders**.

## Tests

```bash
npm test
```

- **Server (node:test):** overlap detection, validation, the NLP parser (overnight ranges, meridiem inference, named days, "tomorrow"), time-zone conversion, insights scoring, exactly-once reminders, plus API integration tests for auth, CRUD, 409 conflicts, batch skip, series delete, and AI endpoints.
- **Client (Vitest):** pattern expansion, overnight splitting across days, weekly stats.

## Production build

```bash
npm run build                          # builds client/dist
NODE_ENV=production JWT_SECRET=... npm start --prefix server
```

Express serves the built React app and the API from one origin, so it deploys to Render, Railway, or Fly.io as a single service.

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | Returns `{ token, user }` |
| GET / PATCH | `/api/auth/me` · `/api/auth/preferences` | Profile & reminder preferences |
| GET | `/api/blocks?from&to` | Blocks in a range |
| POST | `/api/blocks` | One block, or `{ blocks: [...], skipConflicts }`. Returns 409 with `conflicts` on overlap |
| PUT / DELETE | `/api/blocks/:id` (`?series=1`) | Update (re-arms reminders) / delete one or the rest of a series |
| POST | `/api/ai/parse` | Natural language → schedule proposals |
| POST | `/api/ai/insights` | Weekly score + suggestions |
| POST | `/api/ai/chat` | `{ messages: [{role, content}] }` → `{ reply, proposals, source }` |
| GET | `/api/events?token=` | SSE stream: `reminder`, `started`, `blocks-changed` |

## Roadmap ideas

- Swap the JSON store for MongoDB or PostgreSQL (all access is isolated in `db.js`)
- Google Calendar import to auto-detect busy time
- Web Push via a service worker for reminders while the tab is closed
