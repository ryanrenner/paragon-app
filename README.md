# Paragon MLS Lookup

A private, self-hosted web app that takes an MLS number or address, logs into Paragon Connect, scrapes the full listing, runs Claude over the important bits, and stores a searchable history in SQLite.

Built for a single agent (plus maybe a VA later). Not intended for public access or high-traffic use.

## What it does

Type an MLS number or an address into the box and hit Look Up. The app will:

1. Log into Paragon Connect on your behalf (reusing a cached session if it's less than 3 minutes old).
2. Search for the listing. If you typed an address, it tries a few variations (abbreviated vs. spelled-out directionals and street suffixes) until Paragon returns a match.
3. Click into the listing detail, expand All Fields Detail, and scrape every field, every attached PDF, and the full property history.
4. Send a focused subset of the data to Claude for a practical summary (key strengths, concerns, showing info, history highlights).
5. Save everything to a local SQLite database so you can revisit past lookups without re-scraping.

The result page puts the AI summary at the top, followed by key stats, showing info, remarks, documents, the MLS timeline, and a collapsible dump of every field.

## Requirements

You will need:

- Node.js 20 or newer (for local runs).
- A working Paragon Connect account for Great Plains Regional MLS.
- An Anthropic API key (the AI summary is optional; the app will still scrape and store if the key is missing).
- Docker if you want to deploy via Dokploy (recommended).

## First-time setup

Clone or copy this folder to your server (or local machine). Then:

```
cp .env.example .env
```

Open `.env` and fill in the five values:

- `PARAGON_USERNAME` and `PARAGON_PASSWORD` — your MLS login.
- `ANTHROPIC_API_KEY` — your Claude API key from console.anthropic.com. Leave blank to skip AI.
- `APP_USERNAME` and `APP_PASSWORD` — whatever you want to use to log into this app (it sits behind HTTP Basic Auth).

Install dependencies and the Chromium browser Playwright needs:

```
npm install
npx playwright install chromium
```

That's everything.

## Running it locally

```
npm start
```

Visit http://localhost:3000. Your browser will prompt for the username and password you put in `.env`. After that you'll see the lookup box.

To watch the scraper drive a real browser window (useful when something breaks), set `PLAYWRIGHT_HEADFUL=1`:

```
PLAYWRIGHT_HEADFUL=1 npm start
```

## Running it in Docker (recommended for the server)

The Dockerfile uses the official Playwright image, which has Chromium and all its dependencies already baked in. One command:

```
docker compose up --build -d
```

That builds the image, starts the container on port 3000, and mounts `./data` so the SQLite file survives rebuilds.

For Dokploy: point Dokploy at this folder (or a git repo containing it), pass the `.env` values through Dokploy's UI, and expose port 3000 behind Dokploy's reverse proxy for HTTPS. The included `docker-compose.yml` is Dokploy-compatible.

## Using the app

**Type an MLS number** (eight digits, nothing else) and Paragon's search form uses the dedicated MLS field. This is always the fastest and most reliable path.

**Type an address** like `3503 S 152nd St, Omaha, NE 68144`. City, state, and ZIP are optional. The app will strip anything after the first comma, parse the street components, and walk a ladder of variations:

1. As entered
2. Direction expanded (S to South)
3. Direction contracted (South to S)
4. Street type expanded (St to Street)
5. Street type contracted (Street to St)
6. Both expanded, both contracted
7. Last ditch: number plus street name only, no direction or type

The first variation that returns results wins. The UI shows which one succeeded so you can refine future searches.

**Selecting among multiple results.** If an address has multiple MLS entries (say, a home that was sold in 2018 and relisted in 2026), the app prefers Status Active. Among active listings it picks the one with the lowest Days on Market.

**Recent Lookups** at the bottom shows your last 20 searches. Clicking a row opens the cached version without touching Paragon. Clicking the Re-run button runs a fresh scrape of the same query and appends a new row to history.

**Failed lookups** are stored too (with the error message). You'll see them in the history list marked with an Error badge. This is on purpose so you can see what didn't work.

## Tips

- The first lookup after starting the server takes 10 to 20 seconds because it has to log into Paragon fresh. Subsequent lookups within 3 minutes reuse the session and finish in a few seconds.
- If you're logged into Paragon in your own browser while this app runs, one of you may get kicked out. That's Paragon's behavior, not ours. Just log back in where needed.
- PDF links in the Documents section are publicly accessible URLs. Click through or share them without going through this app.
- Timestamps in the UI are Central time. The database stores UTC.

## When something breaks

**Login failed.** Double-check your Paragon credentials in `.env`. If they're correct but login still fails, log into Paragon in a normal browser to make sure your account isn't locked or needing a password reset.

**Lookup returns "No active listing found."** For MLS numbers, confirm the number exists and is active. For addresses, try a different variation (full street type, with directional). Some very new listings take a few minutes to propagate.

**Scraper errors after a Paragon update.** Paragon ships front-end changes occasionally. If selectors break, the fix is usually in `scraper.js` (see `docs/02-selectors.md` for the full map of what we depend on). The most brittle selectors are the MUI-generated CSS classes (`css-16biofz` etc.) that identify label/value pairs in the field table.

**AI analysis unavailable.** Check `ANTHROPIC_API_KEY` in `.env`. The scraped data is still saved and viewable; the AI card will just show a note instead.

**Database errors.** The SQLite file lives in `data/lookups.db`. If it ever gets corrupted, stop the server, delete the file, and restart. You'll lose your history but the app will be healthy again.

## Project layout

```
paragon-lookup/
├── server.js              Express app, auth, routes
├── scraper.js             Playwright login + scraping
├── session.js             In-memory browser session cache (3-min TTL)
├── queue.js               One-at-a-time lookup queue
├── address-variations.js  Address parsing + search ladder
├── ai.js                  Claude API call
├── db.js                  SQLite setup and queries
├── public/
│   └── index.html         Single-page frontend (vanilla HTML/JS)
├── data/
│   └── lookups.db         SQLite file (auto-created, Docker volume)
├── scripts/
│   ├── smoke-login.js     Test the login flow in isolation
│   └── smoke-scrape.js    Run one end-to-end scrape and print results
├── docs/                  Build-time reference docs (selectors, shapes, etc.)
├── samples/               Real JSON examples of scraped data
├── html-snippets/         Small HTML excerpts of the Paragon DOM patterns
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md              (you are here)
```

## Smoke tests

When you first deploy (or after a Paragon-side change that might have broken things), run:

```
node scripts/smoke-login.js
node scripts/smoke-scrape.js 22610267
```

The login script just verifies your credentials and confirms the dashboard loads. The scrape script runs a full end-to-end lookup for the MLS number you pass and writes the JSON result to `data/smoke-*.json` so you can inspect it.

Add `PLAYWRIGHT_HEADFUL=1` to either command to watch the browser.

## Environment reference

All configuration lives in `.env`:

| Variable | Purpose |
|---|---|
| `PARAGON_USERNAME` | Your Paragon Connect login name |
| `PARAGON_PASSWORD` | Your Paragon Connect password |
| `ANTHROPIC_API_KEY` | Claude API key; leave blank to disable AI |
| `APP_USERNAME` | Username for logging into this app |
| `APP_PASSWORD` | Password for logging into this app |
| `PORT` | HTTP port (default 3000) |
| `SESSION_TTL_MINUTES` | Browser session cache lifetime (default 3) |
| `TZ` | Timezone for UI display (default America/Chicago) |
| `PARAGON_DB_PATH` | Optional override for the SQLite file location |
| `PLAYWRIGHT_HEADFUL` | Set to any value to run the browser visibly |

## What's intentionally not built

The brief and decisions docs list several future features that this version does not include: dedicated address history views, Follow Up Boss CRM integration, S3 PDF storage, email or SMS alerts, n8n webhook forwarding, and multi-user role management. Those are all on the table for later; the current build is a clean base to add them to.

## Technical details and background

The full project brief, locked-in decisions, selector map, data shape reference, and known Paragon quirks are all in `docs/`. If you (or someone else) ever needs to debug the scraper or extend the app, start there.

- `docs/00-project-brief.md` — original spec
- `docs/01-decisions.md` — decisions that override or extend the brief
- `docs/02-selectors.md` — every Paragon DOM selector the scraper relies on
- `docs/03-data-shapes.md` — JSON shapes at each stage of the pipeline
- `docs/04-build-order.md` — how the code was built, step by step
- `docs/05-paragon-quirks.md` — known gotchas in Paragon's behavior
