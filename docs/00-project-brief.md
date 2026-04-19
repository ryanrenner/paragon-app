# Project Brief: Paragon MLS Private Lookup Tool

## Overview

Build a private, self-hosted web application that allows a real estate agent to enter an MLS number or property address, automatically log into the Paragon Connect MLS platform, scrape the full listing detail, run AI analysis, and return a clean results page. Includes a simple lookup history stored in SQLite.

This tool is for private use only (one primary user, possibly a VA later). It must be simple, reliable, and easy to debug.

---

## Target User

- Solo real estate agent in Omaha, Nebraska
- Non-developer; can follow instructions and use Docker/Dokploy
- Has ADHD — UI should be clean, uncluttered, and scannable
- May use this on desktop or mobile
- May add a VA as a second user later

---

## Tech Stack

### Backend
- **Runtime:** Node.js (latest LTS)
- **Framework:** Express.js
- **Browser Automation:** Playwright (Chromium, headless)
- **AI:** Anthropic Claude API (`claude-sonnet-4-20250514`)
- **Database:** SQLite via `better-sqlite3`
- **Auth:** HTTP Basic Auth (hardcoded credentials in `.env`)

### Frontend
- Single HTML file with vanilla JS
- Clean, minimal, mobile-friendly
- No framework needed
- Served directly by Express

### Deployment
- Dockerized, deployed via Dokploy on existing self-hosted server
- All secrets stored in `.env` file

---

## MLS Platform Details

- **Platform:** Paragon Connect v26.6 (Great Plains Regional MLS)
- **Login URL:** `https://gprmls.paragonrels.com/ParagonConnect/gprmls/login`
- **Login type:** Standard username + password (no SSO, no reCAPTCHA on Connect version)
- **Double-login behavior:** Sometimes shows a "you are already logged in" warning that requires clicking through. Playwright must detect and handle this automatically.
- **After login:** Redirects to `https://gprmls.paragonrels.com/ParagonConnect/gprmls/dashboard`

### Search Flow (Playwright must replicate this exactly)

1. Navigate to login URL
2. Fill username and password fields, click Sign In
3. Detect if "already logged in" warning appears — if so, click the confirm/continue button
4. Once on dashboard, navigate to Residential Search
5. Enter MLS number OR address into the search form
6. Submit search
7. If multiple results, select the most recent ACTIVE listing (sort by status date descending if needed)
8. On the listing detail page, click the pink "All Fields Detail" link inside the Property Details accordion
9. Wait for all fields to expand on the same page (same URL, JavaScript-rendered)
10. Scrape all content from that expanded view

### Scraping Target: "All Fields Detail" Expanded View

This is a flat, single-page HTML layout with no iframes. It contains:

- All property fields in a two-column table layout
- Agent Remarks (may be empty — scrape it anyway)
- Public Remarks
- Showing Instructions
- Lock Box Provider and Showtime phone number
- Every MLS field (beds, baths, sq ft, year built, taxes, school districts, features, etc.)

### Documents Section

- Below the main listing content is an expandable "Documents" accordion
- Must click to expand it
- Contains PDF documents labeled with short codes (e.g., LBP, SPCD, WFN)
- Each PDF shows: name, file size, date added, visibility badge (Public/Private)
- PDF links are publicly accessible — no authentication required to open them
- Example PDF URL format: `https://gprmls.paragonrels.com/ParagonLS/Files/AssociatedDocs/gprmls/3/gprmls_XXXXXXX.pdf`
- Scrape: document name, file size, date added, visibility, and full URL for each PDF

### Property History Section

- Also an expandable accordion below Documents
- Shows all historical MLS numbers associated with the address
- Each MLS number has a timeline of status changes with dates and prices
- Example: shows previous sold listings, price changes, pending dates
- Scrape: all MLS numbers, their status history entries (date, status, price)

---

## Session Management

- On first request: fresh Playwright login, cache the browser context in memory
- Within 3 minutes of last use: reuse cached session for follow-up lookups (faster)
- After 3 minutes of inactivity: session expires, next request triggers fresh login
- Session stored in memory only — never written to disk
- Server restart clears session automatically
- This is intentional: avoids keeping Paragon "occupied" for extended periods

---

## Data Fields to Scrape

Scrape everything available in the All Fields Detail view. Priority fields (always display prominently):

- Address (full)
- MLS Number
- Status (Active, Pending, etc.)
- Listing Price
- Days on Market
- Bedrooms / Bathrooms
- Total Finished SqFt / Above Grade SqFt
- Year Built
- Public Remarks
- Agent Remarks (if populated)
- Showing Instructions
- Lock Box Provider + Showtime Phone
- School District (Grade, Jr High, High School)
- List Date / Status Date
- Original Price (if different from current)
- Taxes (annual)
- Garage Spaces
- Basement (yes/no + type)
- PDF Documents (name, size, date, visibility, URL)
- Property History (all prior MLS numbers + status/price timeline)

---

## AI Analysis

- After scraping, send the full listing data to the Claude API
- Model: `claude-sonnet-4-20250514`
- Max tokens: 1000
- The AI should analyze the full listing and return a structured summary including:
  - Quick property summary (2-3 sentences)
  - Key strengths of the property
  - Potential concerns or flags (days on market, price changes, unusual terms)
  - Showing/access notes (lock box type, call instructions)
  - Agent remarks summary if populated
  - Anything noteworthy from property history (recent price drops, previously expired listings, quick prior sale)
- Display AI analysis prominently at the top of results, above raw data

### Claude API Call (JavaScript example)

```javascript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `You are a real estate agent's assistant. Analyze this MLS listing data and provide a concise, practical summary. Focus on what a buyer's or seller's agent would actually care about.\n\nListing Data:\n${JSON.stringify(listingData, null, 2)}`
      }
    ]
  })
});
```

---

## Lookup History

- Store every successful lookup in SQLite
- Table: `lookups`
  - `id` (integer, primary key)
  - `queried_at` (datetime)
  - `query_input` (text — what the user typed)
  - `mls_number` (text)
  - `address` (text)
  - `status` (text)
  - `price` (text)
  - `days_on_market` (integer)
  - `full_data` (text — JSON blob of all scraped data)
  - `ai_analysis` (text)
- Display last 20 lookups on the main page as a clickable history list
- Clicking a history item reloads that result from the database (no re-scrape)

---

## Frontend UI

Single HTML page served by Express. Clean and minimal. Mobile-friendly.

### Layout

**Top of page:**
- App title (e.g., "MLS Lookup")
- Input field: "Enter MLS # or Address"
- Submit button: "Look Up"
- Status indicator while loading (e.g., "Logging into Paragon..." → "Scraping listing..." → "Running AI analysis...")

**Results area (shown after lookup):**
- AI Analysis card at the top — highlighted/distinct visual treatment
- Key stats row: Price, Status, DOM, Beds, Baths, SqFt
- Showing info: Lock box, showtime number
- Public Remarks
- Agent Remarks (if populated)
- PDF Documents — listed with name, size, date, visibility badge, and clickable link
- Property History timeline
- Full "All Fields" data in a collapsible section at the bottom

**Bottom of page:**
- Recent Lookups list (last 20, clickable)

### Authentication

- HTTP Basic Auth over HTTPS (or at minimum HTTP for local use)
- Username and password set in `.env`
- Single set of credentials for now; add a second user for VA access later by adding to the `.env`

---

## Environment Variables (.env)

```
PARAGON_USERNAME=your_mls_username
PARAGON_PASSWORD=your_mls_password
ANTHROPIC_API_KEY=your_anthropic_api_key
APP_USERNAME=your_app_login_username
APP_PASSWORD=your_app_login_password
PORT=3000
SESSION_TTL_MINUTES=3
```

---

## Project File Structure

```
paragon-lookup/
├── Dockerfile
├── docker-compose.yml
├── .env                  # never committed to git
├── .gitignore
├── package.json
├── server.js             # Express app, auth, routes
├── scraper.js            # Playwright login + scraping logic
├── session.js            # In-memory session cache with TTL
├── ai.js                 # Claude API call
├── db.js                 # SQLite setup and queries
├── public/
│   └── index.html        # Single-page frontend
└── data/
    └── lookups.db        # SQLite database (auto-created)
```

---

## Docker Setup

```dockerfile
FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

Use the official Playwright Docker image — it includes all browser dependencies. No need to install Chromium separately.

---

## Build Order

Build in this sequence to keep it testable at each step:

1. **Project scaffold** — file structure, package.json, `.env` setup
2. **Playwright login** — just the login flow + double-login handler, log success to console
3. **Search + navigation** — enter MLS# or address, land on listing detail, expand All Fields Detail
4. **Scraper** — extract all fields, documents, property history into a JSON object
5. **Express API** — POST `/lookup` endpoint that triggers scraper and returns JSON
6. **SQLite history** — save lookup, expose GET `/history` endpoint
7. **AI analysis** — call Claude API with scraped data, append to response
8. **Frontend** — build the HTML/JS UI connecting to the API
9. **Auth** — add HTTP Basic Auth middleware
10. **Docker + Dokploy** — containerize and deploy

---

## Error Handling Requirements

- If login fails: return clear error "Login failed — check Paragon credentials"
- If listing not found: return "No active listing found for that address or MLS number"
- If multiple results with no clear active listing: return the most recent one by status date
- If AI call fails: still return scraped data, show "AI analysis unavailable" message
- All Playwright errors should be caught and logged with full stack trace
- Never expose raw errors to the frontend — always return a clean user-facing message

---

## Known Paragon Quirks to Handle

1. **Double-login warning:** After login, detect if a "you are already logged in" dialog appears. If so, click the continue/confirm button and proceed. Check for this before assuming login succeeded.

2. **Session-based URLs:** Listing detail page URLs contain session tokens (e.g., `ssId=728538`). There is no direct permalink to a listing by MLS number. Always go through the search form.

3. **All Fields Detail is JavaScript-rendered:** After clicking the "All Fields Detail" link, wait for the full field table to render before scraping. Use `waitForSelector` on a field that only appears in the expanded view.

4. **Documents accordion:** Must click to expand before scraping PDF links. Use `waitForSelector` after clicking.

5. **Most recent active listing:** When searching by address, always select the listing with Status = ACTIVE and the most recent List Date. Never return an expired or sold listing when an active one exists.

6. **MLS search field:** The search form has a dedicated "MLS #" field. Use it directly when the user inputs a number. Use the address fields when the user inputs an address.

---

## Future Features (do not build now)

- Address history view (all prior MLS numbers and their full details)
- n8n webhook integration to forward results or PDF links
- Follow Up Boss CRM integration
- S3 PDF storage
- Email or SMS alerts
- Multi-user role management
