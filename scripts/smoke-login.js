#!/usr/bin/env node
'use strict';

/**
 * Smoke test: just log in and confirm we land on /dashboard.
 *
 *   node scripts/smoke-login.js
 *
 * Set PLAYWRIGHT_HEADFUL=1 to watch it in a visible browser.
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { login } = require('../scraper');

(async () => {
  const headless = process.env.PLAYWRIGHT_HEADFUL ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page);
    console.log('[smoke] login ok, url:', page.url());
  } catch (err) {
    console.error('[smoke] login FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
