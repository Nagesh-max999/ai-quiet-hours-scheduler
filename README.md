# 🌙 AI-Assisted Quiet Hours Scheduler

A full-stack web app for planning and protecting your **quiet hours**: sleep, study, deep focus, and family time. You describe your ideal week in plain English. The AI assistant turns that into a conflict-free schedule, sends a live reminder before each block, and scores your week with suggestions you can apply in one click.

**Frontend:** React 19 · Vite · Vitest
**Backend:** Python 3.10+ · FastAPI · Uvicorn · Pydantic · Claude API (Anthropic Python SDK) · JWT · bcrypt · Server-Sent Events · pytest

---

## Features

| | |
|---|---|
| ✨ **Natural-language scheduling** | "Sleep 10:30pm–6:30am every night and study 7–9pm on weekdays" becomes a preview of recurring blocks. Claude returns **schema-validated JSON** (Pydantic models + structured outputs), and the server cleans it again before use. |
| 💬 **AI chatbot ("Quiet")** | A floating chat assistant that holds multi-turn conversations. It uses Claude **tool calling** (the Python SDK's tool runner) to read your real schedule and weekly stats, and to propose new blocks. Proposals appear as cards that need your confirmation, so the bot never changes your calendar on its own. An offline intent-based bot answers when no API key is set. |
| 🧠 **AI weekly insights** | A 0–100 quiet-time health score, plus specific suggestions (missing sleep, marathon sessions, back-to-back blocks). Each suggestion can carry a ready-made block pattern you apply with one click. |
| 🛡️ **Conflict detection** | Every create or update is checked for overlaps, both against your calendar and within a batch. A 409 response lists each clash so the UI can offer "add the rest, skip conflicts". |
| ⏰ **Real-time reminders** | A background asyncio job checks every 30 seconds and pushes reminders and "quiet mode started" events over **SSE**. You also get browser notifications and optional email (SMTP). Each reminder is claimed before it is sent, so it fires **exactly once**. |
| 📅 **Weekly calendar** | A custom-built week view. Overnight blocks are split across days, a now-line tracks the current time, and you click any empty slot to create a block. |
| 🔁 **Series management** | Each AI proposal becomes a series. "Delete this & following" removes the remaining occurrences together. |
| 🔌 **Works without an AI key** | With no API key, a rule-based NLP parser and insights engine take over. On a Claude error (auth, rate limit, network), the app falls back to it automatically and shows a notice. |
| 🔐 **Auth & safety** | bcrypt password hashing, JWT sessions, a per-user rate limit on AI calls, input validation on every route. |
| 🔄 **Multi-tab sync** | Changes in one tab or device refresh the others live. |

## Architecture

```
client/  (React + Vite)                 server/  (Python + FastAPI)
 ├─ pages/Dashboard, AuthPage            ├─ app/
 ├─ components/                          │   main.py        ASGI entry point (uvicorn app.main:app)
 │   WeekCalendar, AIAssistant,          │   server.py      app factory: routes, SSE stream, serves client/dist
 │   ChatWidget, InsightsPanel …         │   routes/        auth.py · blocks.py · ai.py
 ├─ hooks/useEvents (SSE)                │   ai.py          Claude (structured outputs + tool runner) with fallback
 └─ lib/schedule.js                      │   scheduler.py   reminder job (exactly-once)
     pattern → blocks, week layout,      │   notifier.py    SSE hub + SMTP email
     stats (local-time math)             │   blocks.py      validation + overlap detection
                                         │   heuristic_parser.py / heuristic_chat.py   offline AI
         ── /api (Vite proxy :8000) ──▶  │   insights.py    weekly summary + scoring
                                         │   db.py          JSON document store (swappable)
                                         └─ tests/         pytest: logic + API integration
```

**How a request flows.** The React app calls `/api/...`. In development, Vite proxies those calls to FastAPI on port 8000. In production, FastAPI serves both the built React files and the API from one origin.

**AI design.** The model never writes timestamps directly. Claude (or the offline parser) returns a compact *pattern*: `{ startTime, endTime, daysOfWeek, startDate, repeatWeeks }`. The browser expands it into concrete blocks in the user's own time zone. This keeps DST and time-zone math deterministic and testable, and makes the LLM output easy to validate.

## Getting started

Requires **Python 3.10+** and **Node.js 20+**.

```bash
npm install          # installs the root tooling (concurrently)
npm run setup        # pip installs server/requirements.txt + npm installs the client
npm run dev          # FastAPI on :8000, React app on http://localhost:5173
```

Open http://localhost:5173 and create an account. FastAPI's interactive API docs are at http://localhost:8000/docs.

> On macOS/Linux, if `python` isn't on your PATH, use `python3`, or activate a virtual environment first:
> `python3 -m venv .venv && source .venv/bin/activate`.

### Run the pieces separately

```bash
# Backend
cd server
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd client
npm install
npm run dev
```

### How to use it

1. **Sign up.** Your browser's time zone is saved with your account, so blocks show in local time.
2. **Describe your week** in the AI assistant box, for example *"sleep 11pm–7am every night, deep work 9–11am on weekdays"*.
3. **Review the proposals.** Each one shows its days, times, and how many weeks it repeats. Click **Add** to save it. If a proposal clashes with an existing block, you can skip the conflicts.
4. **Edit on the calendar.** Click an empty slot to create a block by hand, or click a block to edit or delete it.
5. **Chat with "Quiet"**, the bottom-right assistant. Ask it things like *"how much sleep am I getting?"* or *"find me two focus hours on Friday"*.
6. **Check Insights** to see your weekly score, then apply a suggestion with one click.

### Enable Claude (optional)

```bash
cp server/.env.example server/.env
# then set ANTHROPIC_API_KEY=... in server/.env and restart
```

The header badge switches from **Offline AI** to **Claude AI**. The model defaults to `claude-opus-5-5`; override it with `CLAUDE_MODEL`. Requests opt into server-side refusal fallbacks, so a declined request is retried on a fallback model automatically.

### Email reminders (optional)

Fill in the `SMTP_*` values in `server/.env`, then turn on **Settings → Email reminders**.

### Troubleshooting

- **API calls fail with "proxy error" or unexpected 401s:** another program may already be using port 8000. On Windows, run `netstat -ano | findstr :8000` to check. Either stop that program, or change `--port 8000` in the root `package.json` (`dev:api`) and the proxy target in `client/vite.config.js` to the same new port.
- **`python` not found:** install Python 3.10+ from python.org (tick "Add to PATH" on Windows), or use `python3`.

## Tests

```bash
npm test
```

- **Server (pytest):** overlap detection, validation, the NLP parser (overnight ranges, meridiem inference, named days, "tomorrow"), time-zone conversion, insights scoring, exactly-once reminders, JSON persistence, plus API integration tests for auth, preferences, CRUD, 409 conflicts, batch skip, series delete, AI endpoints, and SSE auth.
- **Client (Vitest):** pattern expansion, overnight splitting across days, weekly stats.

Run only the backend tests with `python -m pytest server -q`.

## Deploy (live site on Render, free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Nagesh-max999/ai-quiet-hours-scheduler)

The repo includes a `Dockerfile` (builds the React app, then runs FastAPI, which serves both the site and the API) and a `render.yaml` blueprint.

1. Click the button above (or on [render.com](https://render.com): **New → Blueprint** and pick this repo). Sign in with GitHub if asked.
2. Leave `ANTHROPIC_API_KEY` empty to use the offline AI, or paste a key to enable Claude. `JWT_SECRET` is generated for you.
3. Click **Apply**. After the first build (a few minutes), the site is live at `https://ai-quiet-hours-scheduler.onrender.com` (or a similar URL Render shows you).

Every push to `main` redeploys automatically.

**Free plan limits:** the service sleeps after 15 minutes without visitors, so the first visit after that takes about a minute to wake up. The free plan has no persistent disk, so accounts and blocks are reset whenever the service restarts or redeploys. For permanent data, add a Render disk (paid) mounted at `/srv/server/data`, or move the store to PostgreSQL.

Test the production image locally with Docker:

```bash
docker build -t quiet-hours .
docker run -p 8000:8000 -e JWT_SECRET=some-long-random-secret quiet-hours
# open http://localhost:8000
```

## Production (without Docker)

```bash
npm run build                                   # builds client/dist
cd server
ENV=production JWT_SECRET=your-long-secret python -m app    # serves the React app + API on $PORT (default 8000)
```

FastAPI serves the built React app and the API from one origin, so it deploys to Render, Railway, or Fly.io as a single Python service. Set `JWT_SECRET` in production (the server refuses to start without it when `ENV=production`).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Status, AI provider, email enabled |
| POST | `/api/auth/register` · `/api/auth/login` | Returns `{ token, user }` |
| GET / PATCH | `/api/auth/me` · `/api/auth/preferences` | Profile & reminder preferences |
| GET | `/api/blocks?from&to` | Blocks in a range |
| POST | `/api/blocks` | One block, or `{ blocks: [...], skipConflicts }`. Returns 409 with `conflicts` on overlap |
| PUT / DELETE | `/api/blocks/{id}` (`?series=1`) | Update (re-arms reminders) / delete one or the rest of a series |
| POST | `/api/ai/parse` | Natural language → schedule proposals |
| POST | `/api/ai/insights` | Weekly score + suggestions |
| POST | `/api/ai/chat` | `{ messages: [{role, content}] }` → `{ reply, proposals, source }` |
| GET | `/api/events?token=` | SSE stream: `reminder`, `started`, `blocks-changed` |

Errors always come back as `{ "error": "message" }` with a matching HTTP status.

## Roadmap ideas

- Swap the JSON store for PostgreSQL (SQLAlchemy) or MongoDB; all data access is isolated in `server/app/db.py`
- Google Calendar import to auto-detect busy time
- Web Push via a service worker for reminders while the tab is closed
