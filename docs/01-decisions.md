# Decisions Locked In During Planning

These decisions were made during the Q&A session after Ryan uploaded the project brief. They extend or override the brief where they conflict.

## Deployment & Infrastructure

- **No Browserless service.** Use vanilla Playwright in-process. It's simpler at single-user scale.
- **Single container.** One Docker image, one service. Playwright runs inside the same Node.js process as Express.
- **Use latest stable Playwright at build time** (pin via `package.json`, use the matching `mcr.microsoft.com/playwright` base image).
- **HTTPS via Dokploy reverse proxy.** The app itself serves HTTP on its port; Dokploy terminates TLS.
- **Volume declarations in `docker-compose.yml` for `./data`** so the SQLite file persists across redeploys.
- **Deployed via Dokploy on Ryan's home-IP server.** No datacenter. This is a factor in reducing ToS/abuse risk for the MLS provider.

## Concurrency & Sessions

- **One-at-a-time lookup queue.** If a lookup is in progress, a second request waits rather than starting a second browser. Single user, no need for parallelism.
- **In-memory session cache, 3-minute TTL** (as spec'd in brief). Server restart wipes session. Not persisted to disk.
- **Session conflict risk acknowledged:** if Ryan is logged into Paragon in his own browser while the scraper runs, Paragon may kick one of them out. The "double login" warning handler in the scraper should handle this gracefully.

## Input Detection

- **MLS# vs address:** 8 digits, all numeric, no spaces or dashes = MLS number. Anything else = address.

## Address Search Ladder

When the user inputs an address, the scraper tries variations in order until a listing is found. Strip city/state/zip first every time. Cap at ~4 attempts total.

1. Try as-entered (after stripping city/state/zip)
2. Expand directionals (N → North, S → South, etc.)
3. Contract directionals (reverse)
4. Expand street suffix (St → Street, Ave → Avenue, Dr → Drive, etc.)
5. Contract street suffix (reverse)
6. Last-ditch: street number + core street name only

The UI should show which variation succeeded.

## AI Input Field Selection

Only these fields are sent to the Claude API (budget: up to $0.03/lookup). The full scraped record is still stored in SQLite.

**Include:**
- Address
- MLS#
- Status
- List Price
- Original Price
- Days on Market
- List Date
- Status Date
- Beds
- Baths
- Total Finished SqFt
- Above Grade SqFt
- Year Built
- Public Remarks
- Agent Remarks
- Showing Instructions
- Lock Box Provider
- Showtime Phone
- Annual Taxes
- Property History summary (prior MLS#s with their final status and final price only — not every event)

**Exclude:**
- Room-by-room dimensions
- Full school district details (keep names only)
- Utility hookups
- HOA financial details
- Feature checklists
- Individual room sizes

## Storage Extensions to Brief

- **Error column in SQLite.** Failed lookups are also stored so Ryan can see them in history.
- **Cover photo URL stored.** No other photos, no visual AI analysis on photos.
- **Timestamps:** stored in UTC, displayed in `America/Chicago` timezone.

## UI Extensions to Brief

- **Re-run scrape button** on each history item. Clicking a history row defaults to showing the cached result; a button runs a fresh scrape.

## Writing Style

- **Do not use em dashes** when writing in Ryan's voice (UI copy, marketing-style text, etc.). Technical docs and code comments can use normal punctuation.

## Out of Scope for Now

Same as brief's "Future Features":
- Address history view
- n8n webhook integration
- Follow Up Boss CRM integration
- S3 PDF storage
- Email/SMS alerts
- Multi-user roles
