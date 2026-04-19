# Build Order

Build in this sequence so you can test at each step. The order is the same as the project brief but with extra detail pulled in from the Q&A decisions.

## Step 1: Project Scaffold

Create the file structure from the brief:

```
paragon-lookup/
├── Dockerfile
├── docker-compose.yml
├── .env                  (never commit)
├── .env.example          (template, safe to commit)
├── .gitignore
├── .dockerignore
├── package.json
├── server.js
├── scraper.js
├── session.js
├── ai.js
├── db.js
├── queue.js              (new: one-at-a-time lookup queue, from decisions)
├── address-variations.js (new: address search ladder helper, from decisions)
├── public/
│   └── index.html
└── data/
    └── .gitkeep
```

**package.json deps:**
- `express`
- `playwright`
- `better-sqlite3`
- `dotenv`

**.env.example** should include every var from the brief plus any new ones:
```
PARAGON_USERNAME=
PARAGON_PASSWORD=
ANTHROPIC_API_KEY=
APP_USERNAME=
APP_PASSWORD=
PORT=3000
SESSION_TTL_MINUTES=3
TZ=America/Chicago
```

**Test:** `npm install` succeeds. `node -e "console.log('ok')"` works.

---

## Step 2: Playwright Login

`scraper.js` exports an async `login(browser)` function that:
1. Navigates to `https://gprmls.paragonrels.com/ParagonConnect/gprmls/login`
2. Fills username and password (use `getByLabel`)
3. Clicks Sign In
4. Handles the "double-login" warning dialog (race condition: dashboard URL vs. the warning button)
5. Waits for `/dashboard` URL
6. Returns the page context

**Test:** Write a tiny driver script that just calls `login` and logs "login ok" on success. Run it and verify. Also verify the double-login path works: log in twice in quick succession.

See `docs/02-selectors.md` for exact selectors.

---

## Step 3: Search + Navigation

Add functions to `scraper.js`:

- `searchByMls(page, mlsNum)` — navigates to residential search, fills MLS # field, clicks Search, waits for results page.
- `searchByAddress(page, addressString)` — uses address-variations.js to step through the ladder (see `docs/01-decisions.md`). Returns which variation succeeded plus the results page.
- `selectBestResult(page)` — on the results page, picks the best card (Active preferred, else most recent). Returns the selected MLS#.
- `openListing(page, mlsNum)` — clicks into that MLS#'s result card (click the `img[role="link"]`).
- `expandAllFieldsDetail(page)` — clicks the "All Fields Detail" link on the listing detail page and waits for it to render.

**Test:** Log in, run a known MLS# end-to-end through to the All Fields view. Log the page title or some fixed field to confirm. Then do the same with an address input that you know will hit a ladder variation (e.g., enter "3503 S 152nd St" which should need the "St → Street" expansion).

---

## Step 4: Scraper

Add to `scraper.js`:

- `scrapeAllFields(page)` — walks the label/value DOM pattern, returns `{ "MLS #": "...", "Status": "...", ... }`.
- `scrapeDocuments(page)` — clicks the Documents accordion, extracts PDFs, returns an array of `{name, url, size, date_added, visibility}`.
- `scrapeHistory(page)` — clicks the Property History accordion, walks the DOM to emit events, returns an array of `{mls, events: [...]}`.
- `scrapeCoverPhoto(page)` — grabs the cover photo URL (from the first `img[role="link"]` on the results page, or the main photo on the detail page).

Compose these into a top-level `scrapeListing(query)` that logs in, searches, navigates, and returns the full Stage 2 shape from `docs/03-data-shapes.md`.

**Test:** Run against 3-5 real listings, including one with no Agent Remarks and one with documents. Confirm all three accordions extract. Write the output to a local JSON file and diff against `samples/all-fields-detail.json` shape.

---

## Step 5: Express API

Create `server.js`:

- `POST /lookup` — takes `{ query: "..." }`, runs scraper via the queue (see below), returns `{ scraped_data, ai_analysis: null }` (AI added in step 7).
- `GET /history` — returns last 20 lookups from SQLite.
- `GET /history/:id` — returns one historical lookup.
- `POST /history/:id/rerun` — rescrapes the same query and inserts a new row (from decisions).
- Serves `public/index.html` at `GET /`.

Build `queue.js`: a simple in-memory promise queue. Only one scrape runs at a time; additional requests wait for the current one.

Build `session.js`: in-memory session cache with 3-minute TTL. On each scrape, check if we have a live browser context that was last-used within TTL; if so reuse; otherwise spawn a fresh one.

**Test:** `curl -X POST http://localhost:3000/lookup -d '{"query":"22610267"}'` returns the full scraped JSON. Fire two concurrent requests and confirm they run serially, not in parallel.

---

## Step 6: SQLite History

Build `db.js`:

- Initialize `data/lookups.db` if not present, create the `lookups` table (see schema in `docs/03-data-shapes.md`).
- Functions: `insertLookup(data)`, `getRecentLookups(limit)`, `getLookupById(id)`.
- Store `queried_at` as UTC ISO8601. Store `full_data` as stringified JSON.
- Store failed lookups too, with the error in the `error` column (from decisions).

Wire into `server.js`:
- After every `/lookup`, insert a row (success or error).
- `GET /history` reads from SQLite.

**Test:** Do 3 lookups. Hit `GET /history` and see all 3. Hit `GET /history/:id` for a specific one. Verify a deliberately bad MLS# still logs a row with the error.

---

## Step 7: AI Analysis

Build `ai.js`:

- `analyzeListing(stage2Data)` — picks the AI input fields per `docs/01-decisions.md`, builds the prompt, calls Claude API with `claude-sonnet-4-20250514`, returns the analysis text.
- Summarize history to just prior MLS#s + final status + final price before sending.
- Handle errors gracefully: return `null` and let server still return the scraped data, with a "AI analysis unavailable" flag.

Wire into `/lookup`: after scraping, call `analyzeListing` and attach to the response. Store in the `ai_analysis` column.

**Test:** Run a lookup and inspect the AI response. It should feel practical and focused (per the prompt in the brief). Re-run with the Anthropic key invalidated to confirm graceful degradation.

---

## Step 8: Frontend

Build `public/index.html`:

- Top: title, input field, Look Up button.
- Status indicator with phased text: "Logging into Paragon..." → "Scraping listing..." → "Running AI analysis..."
- Results area (hidden until a lookup completes):
  - AI Analysis card (visually distinct at top)
  - Key stats row: Price, Status, DOM, Beds, Baths, SqFt
  - Cover photo
  - Showing info
  - Public Remarks
  - Agent Remarks (hide if empty)
  - PDF Documents list (with size, date, visibility badge, clickable link)
  - Property History timeline
  - Full field data in a collapsible section
- Bottom: Recent Lookups list (last 20, clickable, shows query + timestamp + address + status). Each row has a "Re-run" button (from decisions).
- Display timestamps in `America/Chicago`.
- Mobile-friendly: no horizontal scroll, readable on phone.
- Keep it clean and uncluttered (ADHD-friendly per user context).

**Test:** Full UX flow end to end on desktop and a phone.

---

## Step 9: Auth

Add HTTP Basic Auth middleware to `server.js`. Single user from `.env`. The frontend lives behind the auth wall. Browser prompt is fine.

**Test:** Try accessing without credentials → 401. With bad credentials → 401. With good credentials → full app works.

---

## Step 10: Docker + Dokploy

Create `Dockerfile` per the brief:
```dockerfile
FROM mcr.microsoft.com/playwright:v1.XX.X-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```
(Pin to the actual latest stable Playwright version at build time.)

Create `docker-compose.yml` with an explicit volume for `./data` so the SQLite DB persists across redeploys (from decisions).

Also:
- `.dockerignore` excluding `node_modules`, `data`, `.env`
- `.gitignore` excluding `node_modules`, `data`, `.env`

**Test:** `docker compose up --build` locally, confirm the app works inside the container with data persistence across restarts. Then deploy via Dokploy. HTTPS is handled by Dokploy's reverse proxy.

---

## Notes on Testing Philosophy

Because this is a small one-person tool, skip a test framework. Write small driver scripts you can `node` for each step. Delete them before the final commit, or move them into `scripts/smoke-test.js` for manual re-runs.
