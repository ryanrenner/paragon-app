'use strict';

/**
 * session.js
 *
 * In-memory cache for a logged-in Playwright browser context.
 *
 * Behavior (per project brief + decisions.md):
 *   - First request: spawn a fresh Chromium, log in, cache.
 *   - Subsequent requests within TTL (default 3 minutes): reuse.
 *   - After TTL, next request spawns fresh.
 *   - Server restart wipes everything (cache is in-memory only).
 *
 * The session never persists to disk. This is intentional to keep Paragon
 * "occupied" only for short windows, and to let server restarts reset.
 */

const { chromium } = require('playwright');
const { login } = require('./scraper');

function getTtlMs() {
  const minutes = parseInt(process.env.SESSION_TTL_MINUTES || '3', 10);
  return Math.max(1, minutes) * 60 * 1000;
}

class ParagonSession {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lastUsedAt = 0;
    this.loggingIn = null; // promise guard
  }

  isFresh() {
    if (!this.browser || !this.context || !this.page) return false;
    return Date.now() - this.lastUsedAt < getTtlMs();
  }

  async getPage() {
    // If a login is in-flight, wait for it rather than starting a second one.
    if (this.loggingIn) {
      await this.loggingIn;
    }

    if (this.isFresh()) {
      this.lastUsedAt = Date.now();
      return this.page;
    }

    // Stale or absent — tear down any existing state and start fresh.
    await this.close();

    this.loggingIn = (async () => {
      const headless = process.env.PLAYWRIGHT_HEADFUL ? false : true;
      this.browser = await chromium.launch({ headless });
      this.context = await this.browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      this.page = await this.context.newPage();
      await login(this.page);
      this.lastUsedAt = Date.now();
    })();

    try {
      await this.loggingIn;
    } finally {
      this.loggingIn = null;
    }

    return this.page;
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  async close() {
    const { browser, context, page } = this;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lastUsedAt = 0;

    // Best-effort teardown; swallow errors.
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
  }
}

// Module-level singleton. Paragon only allows one active web session at a
// time for a given account anyway, so singleton matches the real world.
const singleton = new ParagonSession();

module.exports = {
  ParagonSession,
  getSession: () => singleton,
};
