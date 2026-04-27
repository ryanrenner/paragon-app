'use strict';

/**
 * scraper.js
 *
 * Playwright-driven scraper for Paragon Connect v26.6 (Great Plains
 * Regional MLS). Exports:
 *
 *   - login(page)                        logs in, handles double-login warning
 *   - searchByMls(page, mls)             fills MLS# field, submits
 *   - searchByAddress(page, rawAddress)  walks the address ladder, returns
 *                                        { variation, results }
 *   - readSearchResultCards(page)        parses the results list (Stage 1)
 *   - selectBestResult(cards)            picks the right one
 *   - openListing(page, mls)             clicks into a specific listing card
 *   - expandAllFieldsDetail(page)        clicks "All Fields Detail", waits
 *   - scrapeAllFields(page)              returns the fields dict
 *   - scrapeDocuments(page)              returns the documents array
 *   - scrapeHistory(page)                returns the history array
 *   - scrapeAgentContacts(page)          returns the agents array
 *   - scrapeCoverPhoto(page, mls)        returns the cover photo URL
 *   - scrapeListing(query, opts)         top-level: does the whole pipeline
 *
 * See docs/02-selectors.md and docs/05-paragon-quirks.md. Those docs are
 * canonical — they describe the actual DOM patterns observed on the
 * production site. Any deviation here should be treated as a bug.
 */

const { buildVariations, stripCityStateZip } = require('./address-variations');

const PARAGON_BASE = 'https://gprmls.paragonrels.com';
const URLS = {
  login: `${PARAGON_BASE}/ParagonConnect/gprmls/login`,
  dashboard: `${PARAGON_BASE}/ParagonConnect/gprmls/dashboard`,
  residentialSearch: `${PARAGON_BASE}/ParagonConnect/gprmls/searches/property?classId=1`,
};

// --------------------------------------------------------------------------
// HTML entity decoder for values pulled from raw page HTML via regex.
// Keep a tiny built-in to avoid a dependency on `he`.
// --------------------------------------------------------------------------
function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// --------------------------------------------------------------------------
// 1. Login
// --------------------------------------------------------------------------

async function login(page) {
  const username = process.env.PARAGON_USERNAME;
  const password = process.env.PARAGON_PASSWORD;
  if (!username || !password) {
    throw new Error('PARAGON_USERNAME / PARAGON_PASSWORD are not set in environment.');
  }

  await page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Race between landing on /dashboard and the double-login confirmation
  // dialog. If the dialog wins, click it and then wait for /dashboard.
  await Promise.race([
    page.waitForURL(/\/dashboard/, { timeout: 20000 }),
    (async () => {
      const btn = page.getByRole('button', { name: /continue|ok|yes/i });
      await btn.waitFor({ state: 'visible', timeout: 20000 });
      await btn.click();
      await page.waitForURL(/\/dashboard/, { timeout: 20000 });
    })().catch(() => {}),
  ]);

  // Confirm we actually made it to the dashboard.
  if (!/\/dashboard/.test(page.url())) {
    // Sometimes the UI shows an error banner on login failure. Capture it
    // if we can so the caller gets a usable message.
    let hint = '';
    try {
      hint = (await page.locator('[role="alert"], .MuiAlert-message').first().innerText({ timeout: 1500 })) || '';
    } catch {}
    throw new Error('Login failed — check Paragon credentials.' + (hint ? ` (${hint.trim()})` : ''));
  }
}

// --------------------------------------------------------------------------
// 2. Navigation helpers
// --------------------------------------------------------------------------

async function gotoResidentialSearch(page) {
  if (!page.url().includes('/searches/property')) {
    await page.goto(URLS.residentialSearch, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    // Reset form state by reloading; ensures stale filters don't leak between
    // two address variants on the same ladder walk.
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  // Wait for the MLS# field (a known-stable anchor for this form).
  await page.getByLabel('MLS #').waitFor({ state: 'visible', timeout: 20000 });
}

async function clickSearch(page) {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

async function waitForResultsOrEmpty(page) {
  // Either result cards appear, or the page shows a "no results" state.
  // We look for the earliest visible signal.
  await Promise.race([
    page.locator('main[aria-labelledby^="listing-title-"]').first().waitFor({ state: 'visible', timeout: 20000 }),
    page.getByText(/no\s*(results|listings)/i).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null),
  ]).catch(() => null);
}

// --------------------------------------------------------------------------
// 3. Searches
// --------------------------------------------------------------------------

async function searchByMls(page, mlsNumber) {
  await gotoResidentialSearch(page);
  const mlsField = page.getByLabel('MLS #');
  const value = String(mlsNumber).trim();
  await mlsField.click();
  // Clear any stale value first. fill('') is fine for clearing because we're
  // not relying on React to notice.
  await mlsField.fill('');
  // Use pressSequentially so React's onChange fires for every keystroke —
  // page.fill() bypasses synthetic events on MUI/React inputs, which caused
  // Paragon to submit the user's "My Default" saved search instead of an
  // MLS-filtered one.
  await mlsField.pressSequentially(value, { delay: 30 });
  // Verify the field actually holds what we expect before submitting. If this
  // ever trips, it's the real bug — do not proceed with a stale/empty field.
  const actual = (await mlsField.inputValue()).trim();
  if (actual !== value) {
    throw new Error(`MLS# field did not accept input. Expected "${value}", got "${actual}".`);
  }
  // Intentionally do NOT press Enter here — on an empty/unsynced field, Enter
  // submits Paragon's default search. Clicking the Search button is enough.
  await clickSearch(page);
  await waitForResultsOrEmpty(page);
}

async function fillAddressFields(page, variation) {
  // Clear any previously entered values. The form is an autocomplete combo;
  // focusing and triple-clicking then typing is the safest cross-field idiom.
  const set = async (label, value) => {
    const input = page.getByLabel(label);
    await input.click();
    await input.fill('');
    if (value) await input.fill(String(value));
    // Autocompletes sometimes need a blur to commit. Tab out.
    await input.press('Tab').catch(() => {});
  };

  await set('Address Number', variation.number || '');
  await set('Address Direction Prefix', variation.direction || '');
  await set('Address Street', variation.street || '');
  await set('Street Type', variation.type || '');
}

/**
 * Walks the address ladder. Returns {
 *   variation: the winning variation (or null if nothing worked),
 *   results: the parsed cards array (possibly empty),
 * }
 */
async function searchByAddress(page, rawAddress) {
  const variations = buildVariations(rawAddress);
  if (variations.length === 0) {
    throw new Error(`Could not parse any search variation from address: "${rawAddress}"`);
  }

  for (const variation of variations) {
    await gotoResidentialSearch(page);
    await fillAddressFields(page, variation);
    await clickSearch(page);
    await waitForResultsOrEmpty(page);

    const cards = await readSearchResultCards(page);
    if (cards.length > 0) {
      return { variation, results: cards };
    }
  }

  return { variation: null, results: [] };
}

// --------------------------------------------------------------------------
// 4. Parsing result cards (Stage 1)
// --------------------------------------------------------------------------

/**
 * Parse all currently-rendered result cards into Stage 1 objects.
 * (React virtualizes the list — for our use case, the first batch
 * contains the target.)
 */
async function readSearchResultCards(page) {
  // Evaluate in the browser so we can walk the DOM naturally.
  const cards = await page.evaluate(() => {
    const out = [];
    const mains = document.querySelectorAll('main[aria-labelledby^="listing-title-"]');
    for (const main of mains) {
      const mlsMatch = (main.getAttribute('aria-labelledby') || '').match(/listing-title-(\w+)/);
      const mls = mlsMatch ? mlsMatch[1] : null;

      const titleEl = main.querySelector(`h6#listing-title-${mls}`);
      const address = titleEl ? titleEl.textContent.trim() : null;

      // City/State/Zip: first <p> with the ", NE ##### ." aria-label pattern.
      let cityStateZip = null;
      const pTags = main.querySelectorAll('p');
      for (const p of pTags) {
        const a = p.getAttribute('aria-label') || '';
        if (/,\s*[A-Z]{2}\s*\d{5}/.test(a)) {
          cityStateZip = p.textContent.trim();
          break;
        }
      }

      // Square footage (optional).
      let totalFinishedSqft = null;
      for (const p of pTags) {
        const t = p.textContent || '';
        const m = t.match(/Total Finished SqFt\s*-\s*([\d,]+)/i);
        if (m) {
          totalFinishedSqft = m[1];
          break;
        }
      }

      // Status badge.
      let status = null;
      const statusBadge = main.querySelector('[aria-label$=". ."]');
      if (statusBadge) {
        const m = (statusBadge.getAttribute('aria-label') || '').match(/^([A-Z]+)\. \.$/);
        if (m) status = m[1];
      }

      // Price.
      let price = null;
      for (const div of main.querySelectorAll('div')) {
        const t = (div.textContent || '').trim();
        if (/^\$[\d,]+$/.test(t)) {
          price = t;
          break;
        }
      }

      // Beds/Baths/DOM from aria-labels.
      const getByAriaEnd = (suffix) => {
        const el = main.querySelector(`[aria-label$="${suffix}."]`);
        if (!el) return null;
        const m = (el.getAttribute('aria-label') || '').match(/(\d+)\s/);
        return m ? m[1] : null;
      };
      const beds = getByAriaEnd('Beds');
      const baths = getByAriaEnd('Baths');
      const dom = getByAriaEnd('DOM');

      // Cover photo URL — the `src` on the <img role="link">.
      let coverPhotoUrl = null;
      const img = main.querySelector(`img[role="link"][aria-labelledby="listing-title-${mls}"]`);
      if (img) {
        const src = img.getAttribute('src') || '';
        // Some saved pages inline base64 images; ignore those. Prefer a
        // `data-savepage-src` attribute if present (from offline saves).
        if (/^https?:\/\//.test(src)) {
          coverPhotoUrl = src;
        } else {
          const dsp = img.getAttribute('data-savepage-src');
          if (dsp && /^https?:\/\//.test(dsp)) coverPhotoUrl = dsp;
        }
      }

      out.push({
        mls,
        address,
        city_state_zip: cityStateZip,
        status,
        price,
        beds,
        baths,
        dom,
        total_finished_sqft: totalFinishedSqft,
        cover_photo_url: coverPhotoUrl,
      });
    }
    return out;
  });

  // Normalize status to proper case per quirks.md.
  return cards.map((c) => ({ ...c, status: normalizeStatus(c.status) }));
}

function normalizeStatus(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (!v) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Pick the right card from a result set.
 *   1. Prefer Status === 'Active' or 'New' (both are active listings).
 *   2. Else, prefer the lowest DOM (most recent).
 *   3. Else, first card.
 */
function selectBestResult(cards) {
  if (!cards || cards.length === 0) return null;
  const ACTIVE_STATUSES = new Set(['active', 'new']);
  const active = cards.filter((c) => c.status && ACTIVE_STATUSES.has(c.status.toLowerCase()));
  if (active.length > 0) {
    // Among active listings, prefer lowest DOM.
    return active.slice().sort((a, b) => toInt(a.dom) - toInt(b.dom))[0];
  }
  // Fall back to lowest DOM across all (a rough proxy for most recent).
  return cards.slice().sort((a, b) => toInt(a.dom) - toInt(b.dom))[0];
}

function toInt(v) {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

// --------------------------------------------------------------------------
// 5. Open listing + expand All Fields Detail
// --------------------------------------------------------------------------

async function openListing(page, mls) {
  const clickable = page.locator(`img[role="link"][aria-labelledby="listing-title-${mls}"]`);
  await clickable.first().waitFor({ state: 'visible', timeout: 20000 });
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    clickable.first().click(),
  ]);
  // Wait for the listing detail to stabilize — the Property Details accordion
  // is a reliable anchor.
  await page.getByText('Property Details', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
}

async function expandAllFieldsDetail(page) {
  // Click the pink "All Fields Detail" link inside Property Details.
  // Use force: true to bypass actionability checks — a MUI-generated overlay
  // (css-tnlpd7 inside css-12tfjcl) intercepts pointer events in headless
  // Chromium on Linux even when the target is visible and stable.
  await page.getByText('All Fields Detail', { exact: false }).first().click({ force: true });
  // Wait for the expanded section header to render, then wait for at least
  // one known label to appear.
  await page.waitForSelector('p.css-bbdbyg:has-text("All Fields Detail")', { timeout: 20000 });
  await page.waitForSelector('div[data-left="true"]:has-text("MLS #")', { timeout: 20000 });
}

// --------------------------------------------------------------------------
// 6. Scrape fields (the big label/value pair walk)
// --------------------------------------------------------------------------

/**
 * Extract { label: value } pairs from the expanded All Fields view.
 *
 * Approach: regex-over-HTML using the label class `css-16biofz` and the
 * value class `css-1gmb2pb`. Decoding HTML entities is handled locally.
 *
 * Per docs/02-selectors.md, these class names are generated by MUI/Emotion
 * and may change on redeploy. If they do, we'll need to refresh them.
 */
async function scrapeAllFields(page) {
  const html = await page.content();
  const pattern = /<div class="MuiTypography-root MuiTypography-body2 (css-16biofz|css-1gmb2pb)"[^>]*data-left="true"[^>]*>([\s\S]*?)<\/div>/g;

  const fields = {};
  let currentLabel = null;
  for (const m of html.matchAll(pattern)) {
    const kind = m[1];
    // Strip inner HTML tags and decode entities to get the visible text.
    const raw = m[2].replace(/<[^>]+>/g, '').trim();
    const text = decodeEntities(raw);
    if (kind === 'css-16biofz') {
      currentLabel = text;
    } else if (currentLabel !== null) {
      // Only take the first value for each label encountered to avoid
      // accidentally overwriting with downstream duplicates.
      if (!(currentLabel in fields)) {
        fields[currentLabel] = text;
      } else {
        // Some labels legitimately repeat (e.g., "Subdivision" and
        // "Subdivision (2)" pattern we saw in the sample). Preserve them
        // with a numeric suffix.
        let i = 2;
        while ((`${currentLabel} (${i})`) in fields) i++;
        fields[`${currentLabel} (${i})`] = text;
      }
      currentLabel = null;
    }
  }
  return fields;
}

// --------------------------------------------------------------------------
// 7. Documents accordion
// --------------------------------------------------------------------------

async function scrapeDocuments(page) {
  // Expand the Documents accordion if it's collapsed.
  const heading = page.getByRole('button', { name: /^Documents\b/i }).first();
  try {
    const exists = await heading.count();
    if (exists > 0) {
      const expanded = await heading.getAttribute('aria-expanded').catch(() => 'false');
      if (expanded !== 'true') {
        await heading.click();
      }
      // Wait for at least one PDF link to appear, OR for a short grace
      // period if the listing legitimately has no documents.
      await Promise.race([
        page.waitForSelector('a[href*="AssociatedDocs"]', { timeout: 4000 }),
        page.waitForTimeout(4000),
      ]);
    }
  } catch {
    // Accordion missing — listing has no Documents section at all.
    return [];
  }

  return await page.evaluate(() => {
    const results = [];
    const anchors = document.querySelectorAll('a[href*="AssociatedDocs"]');
    // Iterate, deduping by URL. For each PDF, walk up to the <li> that
    // wraps it and pull size/date/visibility from the text content.
    const seen = new Set();
    for (const a of anchors) {
      const url = a.getAttribute('href');
      if (!url || seen.has(url)) continue;
      seen.add(url);

      // Find the nearest <li> ancestor.
      let li = a.parentElement;
      while (li && li.tagName !== 'LI') li = li.parentElement;
      if (!li) continue;

      // Name: the text-only <a> (not the one wrapping the svg).
      let name = null;
      const nameAnchors = li.querySelectorAll('a[href*="AssociatedDocs"]');
      for (const na of nameAnchors) {
        const hasSvg = na.querySelector('svg');
        if (!hasSvg) {
          name = na.textContent.trim();
          break;
        }
      }
      if (!name) name = (a.textContent || '').trim() || null;

      // Size, date, visibility — pull from span text within the <li>.
      let size = null;
      let dateAdded = null;
      let visibility = null;
      for (const span of li.querySelectorAll('span')) {
        const t = (span.textContent || '').trim();
        if (!t) continue;
        if (/^\d[\d.,]*\s*(KB|MB|GB)$/i.test(t)) size = t;
        else if (/^Added\s/i.test(t)) dateAdded = t.replace(/^Added\s+/i, '').trim();
        else if (/^(Public|Private)$/i.test(t)) visibility = t;
      }

      results.push({ name, url, size, date_added: dateAdded, visibility });
    }
    return results;
  });
}

// --------------------------------------------------------------------------
// 8. Property history accordion
// --------------------------------------------------------------------------

async function scrapeHistory(page) {
  const heading = page.getByRole('button', { name: /^Property History\b/i }).first();
  try {
    const exists = await heading.count();
    if (exists === 0) return [];
    const expanded = await heading.getAttribute('aria-expanded').catch(() => 'false');
    if (expanded !== 'true') {
      await heading.click();
    }
    // Wait for a year marker OR an h6 group header to appear.
    await Promise.race([
      page.waitForSelector('div.css-rbs0uv', { timeout: 4000 }),
      page.waitForSelector('h6[weight="600"]', { timeout: 4000 }),
      page.waitForTimeout(4000),
    ]);
  } catch {
    return [];
  }

  return await page.evaluate(() => {
    // Walk every descendant of the expanded Property History region. When
    // we see a recognized marker, update running state; when we see a
    // detail pane (.css-6s8rp0), emit an event record.
    //
    // To scope the walk, we find the Property History accordion's expanded
    // content by locating the <p> with text "Property History" and
    // climbing to its MuiPaper ancestor.
    let anchor = null;
    for (const p of document.querySelectorAll('p')) {
      if ((p.textContent || '').trim() === 'Property History') {
        anchor = p;
        break;
      }
    }
    if (!anchor) return [];
    let region = anchor;
    while (region && !region.classList.contains('MuiAccordion-root')) {
      region = region.parentElement;
    }
    if (!region) region = anchor.ownerDocument.body;

    const out = []; // [{mls, events: [...]}, ...]
    let currentMls = null;
    let currentYear = null;
    let currentMonth = null;
    let currentDay = null;
    let currentTime = null;
    let currentGroup = null;

    const all = region.querySelectorAll('*');
    for (const el of all) {
      // 1. New MLS group starts.
      if (el.tagName === 'H6' && el.getAttribute('weight') === '600') {
        const t = (el.textContent || '').trim();
        // Real MLS numbers are mostly digits. Guard against the heading itself.
        if (/^\w+$/.test(t) && t !== 'Property History') {
          currentMls = t;
          currentGroup = { mls: currentMls, events: [] };
          out.push(currentGroup);
          currentYear = currentMonth = currentDay = currentTime = null;
        }
        continue;
      }

      // 2. Year marker.
      if (el.classList && el.classList.contains('css-rbs0uv')) {
        const t = (el.textContent || '').trim();
        if (/^\d{4}$/.test(t)) currentYear = t;
        continue;
      }

      // 3. Month/day header. Pattern: <p>Mon<h6>DD</h6></p>.
      if (el.tagName === 'P' && el.children.length === 1 && el.children[0].tagName === 'H6') {
        const monthText = (el.childNodes[0] && el.childNodes[0].textContent || '').trim();
        const dayText = (el.children[0].textContent || '').trim();
        if (monthText && /^\d{1,2}$/.test(dayText)) {
          currentMonth = monthText;
          currentDay = dayText;
        }
        continue;
      }

      // 4. Time — standalone div with HH:MM AM/PM. Inside a .css-27dcjk block.
      if (el.tagName === 'DIV' && !el.children.length) {
        const t = (el.textContent || '').trim();
        if (/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(t)) {
          currentTime = t;
          continue;
        }
      }

      // 5. Event detail pane.
      if (el.classList && el.classList.contains('css-6s8rp0')) {
        if (!currentGroup) {
          // Shouldn't happen on real pages, but guard anyway.
          currentGroup = { mls: currentMls || null, events: [] };
          out.push(currentGroup);
        }
        // Event text is the first <p>'s content, before any <span>/date.
        const ps = el.querySelectorAll('p');
        let eventText = null;
        let generalDate = null;
        let price = null;
        for (const p of ps) {
          const t = (p.textContent || '').trim();
          if (!t) continue;
          if (/General Date:/i.test(t)) {
            generalDate = t.replace(/^.*General Date:\s*/i, '').trim();
          } else if (/Price:/i.test(t)) {
            price = t.replace(/^.*Price:\s*/i, '').trim();
          } else if (!eventText) {
            eventText = t;
          }
        }
        currentGroup.events.push({
          year: currentYear,
          month: currentMonth,
          day: currentDay,
          time: currentTime,
          event: eventText,
          general_date: generalDate,
          price,
        });
      }
    }

    return out;
  });
}

// --------------------------------------------------------------------------
// 9. Agent/Office contacts
// --------------------------------------------------------------------------

/**
 * Expand the "Agent/Office" accordion and scrape contact details for each
 * listed agent by opening their INFO modal. Returns an array of:
 *   { name, email, phone, brokerage }
 *
 * Failures for individual agents are silently skipped so a broken modal
 * never aborts the whole scrape.
 */
async function scrapeAgentContacts(page) {
  // Expand the Agent/Office accordion (same pattern as Documents/History).
  const heading = page.getByRole('button', { name: /^Agent\/Office\b/i }).first();
  try {
    const exists = await heading.count();
    if (exists === 0) return [];
    const expanded = await heading.getAttribute('aria-expanded').catch(() => 'false');
    if (expanded !== 'true') {
      await heading.click();
    }
    await Promise.race([
      page.getByRole('button', { name: 'INFO' }).first().waitFor({ state: 'visible', timeout: 6000 }),
      page.waitForTimeout(6000),
    ]);
  } catch {
    return [];
  }

  const total = await page.getByRole('button', { name: 'INFO' }).count();
  if (total === 0) return [];

  const agents = [];

  const seen = new Set();

  for (let i = 0; i < total; i++) {
    try {
      await page.getByRole('button', { name: 'INFO' }).nth(i).click();

      // INFO opens a MUI Drawer (role="dialog"). There are always multiple drawers in
      // the DOM; wait for the specific one containing "Agent Information" to go visible.
      const drawer = page.locator('[role="dialog"]').filter({ hasText: 'Agent Information' });
      await drawer.waitFor({ state: 'visible', timeout: 6000 });

      const agent = await drawer.evaluate((el) => {
        const texts = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const t = (node.textContent || '').trim();
            return t ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });
        while (walker.nextNode()) texts.push(walker.currentNode.textContent.trim());

        function getAfter(label) {
          const idx = texts.indexOf(label);
          if (idx === -1) return null;
          for (let j = idx + 1; j < texts.length; j++) {
            if (texts[j]) return texts[j];
          }
          return null;
        }

        const firstName = getAfter('First Name');
        const lastName  = getAfter('Last Name');
        const brokerage = getAfter('Office');

        const emailAnchor = el.querySelector('a[href^="mailto:"]');
        const email = emailAnchor
          ? (emailAnchor.getAttribute('href').replace(/^mailto:/, '') || emailAnchor.textContent.trim())
          : (getAfter('Email Address') || null);

        const phoneAnchor = el.querySelector('a[href^="tel:"]');
        const phone = phoneAnchor
          ? (phoneAnchor.textContent.trim() || phoneAnchor.getAttribute('href').replace(/^tel:/, ''))
          : (getAfter('M') || null);

        return {
          name:      [firstName, lastName].filter(Boolean).join(' ') || null,
          email:     email && email.includes('@') ? email : null,
          phone:     phone || null,
          brokerage: brokerage || null,
        };
      });

      // Close the drawer and wait for it to hide before opening the next.
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});

      // Deduplicate — some listings show the same agent across multiple INFO buttons.
      const key = agent.email || agent.name || '';
      if ((agent.name || agent.phone) && (!key || !seen.has(key))) {
        if (key) seen.add(key);
        agents.push(agent);
      }
    } catch {
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(300);
    }
  }

  return agents;
}

// --------------------------------------------------------------------------
// 10. Cover photo
// --------------------------------------------------------------------------

async function scrapeCoverPhoto(page, mls) {
  // On the detail page, there's usually a hero image. Try a few selectors,
  // preferring the MLS-specific one if it exists.
  const candidates = [
    `img[role="link"][aria-labelledby="listing-title-${mls}"]`,
    'img[role="link"]',
    'img.MuiCardMedia-img',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      const count = await el.count();
      if (!count) continue;
      const src = await el.getAttribute('src');
      if (src && /^https?:\/\//.test(src)) return src;
    } catch {}
  }
  return null;
}

// --------------------------------------------------------------------------
// 11. End-to-end scrape
// --------------------------------------------------------------------------

/**
 * Decide whether an input looks like an MLS number.
 * Per decisions.md: 8 digits, all numeric, no spaces = MLS.
 */
function looksLikeMlsNumber(input) {
  if (!input) return false;
  const s = String(input).trim();
  return /^\d{8}$/.test(s);
}

/**
 * Top-level scrape. Uses an already-logged-in page (from session.js).
 * Returns the Stage 2 shape described in docs/03-data-shapes.md.
 *
 * `timings` is an optional object that will be populated with per-phase
 * millisecond durations (keys: search_ms, open_listing_ms, expand_fields_ms,
 * scrape_fields_ms, scrape_docs_ms, scrape_history_ms).
 */
async function scrapeListing(page, query, timings = {}) {
  // Helper: start a timer, returns a function that stops it and records the duration.
  const mark = (key) => {
    const start = Date.now();
    return () => { timings[key] = Date.now() - start; };
  };

  const cleaned = String(query).trim();
  if (!cleaned) throw new Error('Empty query.');

  const isMls = looksLikeMlsNumber(cleaned);
  let variationLabel = null;

  let cards;
  if (isMls) {
    const done = mark('search_ms');
    await searchByMls(page, cleaned);
    cards = await readSearchResultCards(page);
    done();
  } else {
    const done = mark('search_ms');
    const { variation, results } = await searchByAddress(page, cleaned);
    if (!variation) {
      done();
      throw new Error('No active listing found for that address or MLS number.');
    }
    variationLabel = variation.label;
    cards = results;
    done();
  }

  if (!cards || cards.length === 0) {
    throw new Error('No active listing found for that address or MLS number.');
  }

  const best = selectBestResult(cards);
  if (!best || !best.mls) {
    throw new Error('Could not determine which listing to open.');
  }

  // Safety belt: when the caller passed an MLS#, the card we're about to open
  // MUST have that same MLS#. If it doesn't, the search submitted with
  // unintended criteria (e.g. Paragon's "My Default" saved search) and we're
  // about to scrape the wrong listing. Fail loudly instead.
  if (isMls && String(best.mls).trim() !== cleaned) {
    throw new Error(
      `Search returned MLS ${best.mls} but MLS ${cleaned} was requested. ` +
      `This usually means the MLS# field did not get populated before submit.`
    );
  }

  // Capture the card's cover photo up front — the results page has the
  // canonical thumbnail URL for the MLS.
  const cardCoverPhoto = best.cover_photo_url || null;

  const doneOpen = mark('open_listing_ms');
  await openListing(page, best.mls);
  doneOpen();

  const doneExpand = mark('expand_fields_ms');
  await expandAllFieldsDetail(page);
  doneExpand();

  const doneFields = mark('scrape_fields_ms');
  const fields = await scrapeAllFields(page);
  doneFields();

  const doneDocs = mark('scrape_docs_ms');
  const documents = await scrapeDocuments(page);
  doneDocs();

  const doneHistory = mark('scrape_history_ms');
  const history = await scrapeHistory(page);
  doneHistory();

  const doneAgents = mark('scrape_agents_ms');
  const agents = await scrapeAgentContacts(page);
  doneAgents();

  const coverPhotoUrl = cardCoverPhoto || (await scrapeCoverPhoto(page, best.mls));

  return {
    scraped_at: new Date().toISOString(),
    url: page.url(),
    query_variant: variationLabel,
    card: best,
    cover_photo_url: coverPhotoUrl,
    fields,
    documents,
    history,
    agents,
  };
}

module.exports = {
  // URLs
  URLS,
  // login
  login,
  // navigation
  gotoResidentialSearch,
  // search
  searchByMls,
  searchByAddress,
  fillAddressFields,
  // parse
  readSearchResultCards,
  selectBestResult,
  // open / expand
  openListing,
  expandAllFieldsDetail,
  // scrape
  scrapeAllFields,
  scrapeDocuments,
  scrapeHistory,
  scrapeAgentContacts,
  scrapeCoverPhoto,
  // top-level
  scrapeListing,
  looksLikeMlsNumber,
  decodeEntities,
};
