'use strict';

/**
 * server.js
 *
 * Express app. HTTP Basic Auth in front of everything. Routes:
 *   GET  /              — serves public/index.html
 *   POST /lookup        — runs a scrape (optionally AI-analyzed) and returns JSON
 *   GET  /api/history       — last 20 lookups (JSON)
 *   GET  /api/history/:id   — one historical record (JSON)
 *   POST /api/history/:id/rerun — rescrape using the original query (JSON)
 *   GET  /history/:id   — serves index.html (SPA route for shareable result URLs)
 *   GET  /healthz       — unauthenticated health probe
 *
 * Scrapes are serialized through queue.js so two concurrent requests can't
 * both launch Playwright at once.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { getQueue } = require('./queue');
const { getSession } = require('./session');
const { scrapeListing } = require('./scraper');
const { analyzeListing } = require('./ai');
const {
  insertLookup,
  getRecentLookups,
  getLookupById,
  updateAiAnalysis,
} = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --------------------------------------------------------------------------
// Health check (unauthenticated)
// --------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --------------------------------------------------------------------------
// HTTP Basic Auth middleware
// --------------------------------------------------------------------------
function basicAuth(req, res, next) {
  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;

  if (!user || !pass) {
    res
      .status(500)
      .json({ error: 'APP_USERNAME and APP_PASSWORD must be set in .env.' });
    return;
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Paragon Lookup"');
    res.status(401).send('Authentication required.');
    return;
  }

  let provided = '';
  try {
    provided = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="Paragon Lookup"');
    res.status(401).send('Invalid credentials.');
    return;
  }
  const sep = provided.indexOf(':');
  const gotUser = sep >= 0 ? provided.slice(0, sep) : provided;
  const gotPass = sep >= 0 ? provided.slice(sep + 1) : '';

  if (!timingSafeEqual(gotUser, user) || !timingSafeEqual(gotPass, pass)) {
    res.set('WWW-Authenticate', 'Basic realm="Paragon Lookup"');
    res.status(401).send('Invalid credentials.');
    return;
  }

  next();
}

function timingSafeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// All non-healthz routes require auth.
app.use(basicAuth);

// --------------------------------------------------------------------------
// Static frontend
// --------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Core lookup logic
// --------------------------------------------------------------------------

/**
 * Run a scrape (+ optional AI) and insert into SQLite. Returns the persisted
 * row's id and a payload suitable for the frontend.
 *
 * `opts.skipAi` — if true, don't call the AI (used as a fallback on retry).
 */
async function runLookup(queryInput, opts = {}) {
  const trimmed = String(queryInput || '').trim();
  if (!trimmed) {
    throw new Error('Query is required.');
  }

  const queue = getQueue();
  const session = getSession();

  // Shared timings object — populated by this function and by scrapeListing.
  const timings = {};
  const enqueuedAt = Date.now();

  let scraped;
  try {
    scraped = await queue.run(async () => {
      timings.queue_wait_ms = Date.now() - enqueuedAt;

      const sessionStart = Date.now();
      const page = await session.getPage();
      timings.session_ms = Date.now() - sessionStart;

      try {
        // scrapeListing populates timings with per-phase durations.
        const result = await scrapeListing(page, trimmed, timings);
        session.touch();
        return result;
      } catch (err) {
        // On scrape error, it's often because Paragon booted the session.
        // Burn the cache so the next request relogs in cleanly.
        await session.close();
        throw err;
      }
    });
  } catch (err) {
    const id = insertLookup({
      query_input: trimmed,
      error: shortError(err),
    });
    const error = new Error(friendlyError(err));
    error.httpStatus = classifyHttpStatus(err);
    error.lookupId = id;
    throw error;
  }

  const f = scraped.fields || {};
  const cover = scraped.cover_photo_url || null;

  // Persist right away so we never lose the scrape, even if AI fails.
  const id = insertLookup({
    query_input: trimmed,
    query_variant: scraped.query_variant || null,
    mls_number: f['MLS #'] || null,
    address: composeAddress(f),
    status: f['Status'] || null,
    price: f['Listing Price'] || null,
    days_on_market: toIntOrNull(scraped.card && scraped.card.dom),
    cover_photo_url: cover,
    full_data: JSON.stringify(scraped),
    ai_analysis: null,
    error: null,
  });

  const aiStart = Date.now();
  let aiResult = null;
  if (!opts.skipAi) {
    aiResult = await analyzeListing(scraped);
    if (aiResult && aiResult.text) {
      updateAiAnalysis(id, aiResult.text);
    }
  }
  timings.ai_ms = Date.now() - aiStart;

  return {
    id,
    scraped,
    ai_analysis: aiResult ? aiResult.text : null,
    ai_available: Boolean(aiResult),
    timings,
  };
}

function composeAddress(fields) {
  if (!fields) return null;
  const street = fields['Address'];
  const city = fields['City'];
  const state = fields['State'];
  const zip = fields['Zip'];
  const tail = [city, state, zip].filter(Boolean).join(', ');
  if (street && tail) return `${street}, ${tail}`;
  return street || tail || null;
}

function toIntOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function shortError(err) {
  const msg = (err && (err.message || err.toString())) || 'Unknown error';
  return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
}

function friendlyError(err) {
  const msg = shortError(err);
  // The scraper already returns human-friendly messages for the common
  // cases. Pass those through; generic errors get a generic wrapper.
  if (/Login failed/i.test(msg)) return msg;
  if (/No active listing found/i.test(msg)) return msg;
  if (/Empty query/i.test(msg) || /Query is required/i.test(msg)) return msg;
  return `Lookup failed: ${msg}`;
}

function classifyHttpStatus(err) {
  const msg = shortError(err);
  if (/Query is required/i.test(msg) || /Empty query/i.test(msg)) return 400;
  if (/Login failed/i.test(msg)) return 502;
  if (/No active listing/i.test(msg)) return 404;
  return 500;
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

app.post('/lookup', async (req, res) => {
  const query = (req.body && req.body.query) || '';
  try {
    const result = await runLookup(query);
    res.json(result);
  } catch (err) {
    const status = err.httpStatus || 500;
    res.status(status).json({ error: err.message, lookup_id: err.lookupId || null });
  }
});

app.get('/api/history', (_req, res) => {
  try {
    const rows = getRecentLookups(20);
    res.json({ lookups: rows });
  } catch (err) {
    res.status(500).json({ error: shortError(err) });
  }
});

app.get('/api/history/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
    const row = getLookupById(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    // Parse full_data for the client if present.
    let full = null;
    if (row.full_data) {
      try {
        full = JSON.parse(row.full_data);
      } catch {}
    }
    res.json({ ...row, full_data_parsed: full });
  } catch (err) {
    res.status(500).json({ error: shortError(err) });
  }
});

app.post('/api/history/:id/rerun', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
    const row = getLookupById(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const result = await runLookup(row.query_input);
    res.json(result);
  } catch (err) {
    const status = err.httpStatus || 500;
    res.status(status).json({ error: err.message, lookup_id: err.lookupId || null });
  }
});

// Fallback: serve index.html for any other GET so soft-refresh from the SPA
// works even if we later add client-side routes.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[paragon-lookup] listening on :${PORT}`);
});
