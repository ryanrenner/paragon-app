# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paragon MLS Lookup is a self-hosted Node.js web app for real estate agents. It automates property lookups against a Paragon MLS system using Playwright browser automation, stores results in SQLite, and optionally runs AI analysis via OpenRouter.

## Commands

**First-time setup:**
```bash
./setup.sh          # Checks Node 20+, runs npm install, installs Playwright browsers
```

**Run the server:**
```bash
npm start                        # node server.js
PLAYWRIGHT_HEADFUL=1 npm start   # Same, but shows the Chromium window
./start.sh --watch               # Equivalent headful shortcut
```

**Smoke tests (manual, no test framework):**
```bash
node scripts/smoke-login.js                         # Validates Paragon login in isolation
node scripts/smoke-scrape.js 22610267               # End-to-end scrape by MLS number
PLAYWRIGHT_HEADFUL=1 node scripts/smoke-scrape.js 22610267  # With visible browser
```
Both write results to `./data/smoke-*.json`.

**Docker:**
```bash
docker compose up --build -d
```

There is no build step, no transpiler, and no linter configured.

## Architecture

### Request Pipeline

`POST /lookup` in `server.js` is the core entry point:
1. Validates query (8 digits → MLS#, else → address)
2. Enqueues in `queue.js` (serial — Paragon allows only one active session at a time)
3. Obtains a cached Playwright browser context from `session.js` (3-min TTL)
4. Calls `scrapeListing()` in `scraper.js`
5. Persists result immediately to SQLite via `db.js`
6. Calls `analyzeListing()` in `ai.js` (OpenRouter — skipped gracefully if no API key)
7. Updates `ai_analysis` column and returns timing metrics + data to frontend

### Key Modules

| File | Responsibility |
|---|---|
| `server.js` | Express app, HTTP Basic Auth, all routes, `runLookup` orchestrator |
| `scraper.js` | Playwright login + navigation + field extraction (~800 lines, most complex) |
| `session.js` | Singleton browser session cache; handles concurrent login races with a promise guard |
| `queue.js` | Simple serial queue — one scrape at a time |
| `address-variations.js` | Parses addresses and generates a 7-step variation ladder for MLS search fallback |
| `ai.js` | OpenRouter API wrapper; builds a focused field subset and prompt for agent-oriented analysis |
| `db.js` | SQLite schema init, WAL mode, prepared statements, auto-migration |
| `public/index.html` | Entire frontend — vanilla HTML/CSS/JS, no framework |

### Address Ladder

When the query is an address, `address-variations.js` strips city/state/zip and generates progressively broader variations (directional abbreviations, street type abbreviations, etc.). The scraper tries each in order and reports which variant succeeded.

### Session Conflicts

Paragon only supports one concurrent browser session per account. The serial queue (`queue.js`) prevents overlap. If a real user is logged into Paragon in a browser at the same time, Paragon may boot one session — this is documented behavior, not a bug.

### Paragon Quirks

The scraper handles several known Paragon behaviors:
- **Double-login warning:** Detected and clicked through automatically
- **MUI CSS class selectors** (e.g. `css-16biofz`): These are fragile and can break on Paragon platform updates. See `docs/02-selectors.md` for the full selector reference
- **Result ranking:** Among multiple results, picks the active listing with the lowest Days on Market

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

| Variable | Purpose |
|---|---|
| `PARAGON_USERNAME` / `PARAGON_PASSWORD` | MLS credentials |
| `APP_USERNAME` / `APP_PASSWORD` | HTTP Basic Auth for the web UI |
| `OPENROUTER_API_KEY` | AI analysis (optional — app works without it) |
| `AI_MODEL` | OpenRouter model (default: `google/gemini-2.5-flash-lite`) |
| `PLAYWRIGHT_HEADFUL` | Set to `1` to show the browser window |
| `PARAGON_DB_PATH` | SQLite file location (default: `./data/lookups.db`) |
| `TZ` | Display timezone (default: `America/Chicago`) |

## Database

SQLite via `better-sqlite3`. Schema is auto-initialized in `db.js`. The `lookups` table stores both successful and failed lookups — `full_data` holds the complete scraped JSON, `ai_analysis` holds the OpenRouter response. Timestamps are stored in UTC and displayed in the configured `TZ`.

WAL journal mode is enabled (falls back to DELETE mode on unsupported filesystems like some Docker volumes).

## Documentation

`/docs/` contains detailed reference material worth reading before modifying the scraper:
- `02-selectors.md` — All Paragon DOM selectors (critical when scraper breaks)
- `03-data-shapes.md` — JSON schemas at each pipeline stage
- `05-paragon-quirks.md` — Known Paragon platform gotchas
- `01-decisions.md` — Architecture decisions that supersede the original brief

> **Note:** The README references the Anthropic Claude API, but the actual AI integration (`ai.js`) uses **OpenRouter** (`OPENROUTER_API_KEY`). The README is outdated on this point.
