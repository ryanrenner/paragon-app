#!/usr/bin/env node
'use strict';

/**
 * Smoke test: log in, run one scrape end-to-end, and print the result.
 *
 *   node scripts/smoke-scrape.js 22610267
 *   node scripts/smoke-scrape.js "3503 S 152nd St, Omaha, NE"
 *
 * Set PLAYWRIGHT_HEADFUL=1 to watch it in a visible browser.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { login, scrapeListing } = require('../scraper');

(async () => {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node scripts/smoke-scrape.js <MLS# | address>');
    process.exit(2);
  }

  const headless = process.env.PLAYWRIGHT_HEADFUL ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    console.log('[smoke] logging in...');
    await login(page);
    console.log('[smoke] scraping:', query);
    const result = await scrapeListing(page, query);

    const outPath = path.join(__dirname, '..', 'data', `smoke-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log('[smoke] ok — wrote', outPath);
    console.log('[smoke] MLS:', result.fields['MLS #']);
    console.log('[smoke] Address:', result.fields['Address']);
    console.log('[smoke] Status:', result.fields['Status']);
    console.log('[smoke] Price:', result.fields['Listing Price']);
    console.log('[smoke] Field count:', Object.keys(result.fields).length);
    console.log('[smoke] Documents:', result.documents.length);
    console.log('[smoke] History groups:', result.history.length);
  } catch (err) {
    console.error('[smoke] FAILED:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
