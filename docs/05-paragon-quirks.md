# Paragon Quirks & Gotchas

Things to know about Paragon Connect v26.6 that affect how the scraper must behave. Most of these are also mentioned in the brief, but this doc expands on them with what we learned from analyzing real HTML.

---

## 1. Double-Login Warning

If the scraper logs in while another session (e.g., Ryan's own browser) is active, Paragon shows a dialog saying something like "you are already logged in elsewhere." The user has to click Continue/OK to proceed and invalidate the other session.

**Handling:** After clicking Sign In, race the dashboard URL wait against a click on any visible Continue/OK/Yes button. If the dialog appears, dismiss it. If not, proceed normally.

```js
await Promise.race([
  page.waitForURL(/\/dashboard/, { timeout: 15000 }),
  (async () => {
    const btn = page.getByRole('button', { name: /continue|ok|yes/i });
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click();
    await page.waitForURL(/\/dashboard/);
  })()
]);
```

**Session conflict risk (Ryan-specific):** If Ryan is logged into Paragon in his own browser when the scraper runs, the scraper's login may kick him out, or his login may kick out a cached scraper session. Both are recoverable (each login just starts fresh), but the user should be aware this can happen.

---

## 2. No Permalinks — Session-Bound URLs

Listing detail URLs contain session-bound tokens like `ssId=728538`. **These URLs do not work outside the originating session.** You cannot deep-link to a listing by MLS number.

**Implication:** every lookup must go through the login + search flow. You can reuse a cached browser session (per the 3-minute TTL design) to skip re-logging-in, but you must re-navigate through the search form each time.

---

## 3. All Fields Detail Is JavaScript-Rendered

Clicking the pink "All Fields Detail" link on the listing detail page does not navigate — it expands the full field table in place on the same URL. The content is JS-rendered.

**Handling:** click, then `waitForSelector` on a field that only appears in the expanded view. A safe choice is the section header:

```js
await page.getByText('All Fields Detail', { exact: false }).click();
await page.waitForSelector('p.css-bbdbyg:has-text("All Fields Detail")');
// or wait for a specific field you expect to appear
await page.waitForSelector('div[data-left="true"]:has-text("MLS #")');
```

---

## 4. Accordions Default Closed

Both the Documents accordion and the Property History accordion are closed by default. You must click to expand them before scraping their contents.

**Handling:** for each accordion, click its heading and wait for the expanded content to render.

```js
await page.getByRole('button', { name: 'Documents' }).click();
await page.waitForSelector('a[href*="AssociatedDocs"]');

await page.getByRole('button', { name: 'Property History' }).click();
await page.waitForSelector('div.css-rbs0uv'); // year marker or h6[weight="600"]
```

---

## 5. Not All Fields Exist on Every Listing

Agent Remarks is the big one — often empty, but still present in the field table (typically blank value). Other fields like HOA Fee, School District, etc. only appear when populated. The scraper should not assume any specific label exists.

**Handling:** build the `fields` dictionary from whatever labels are actually present. Don't hard-code expected keys. When surfacing fields to the UI or AI, `fields["HOA Fee"] ?? null` style lookups.

---

## 6. Status Case Differs Between Pages

- Search results cards: ALL CAPS (`"NEW"`, `"ACTIVE"`, `"PENDING"`)
- Detail page All Fields Detail: proper case (`"New"`, `"Active"`, `"Pending"`)

**Handling:** normalize to proper case consistently when storing/displaying.

---

## 7. React Virtualization on Search Results

The search results page uses React virtualization. Only ~20 cards are in the DOM at any time, even if the header says "47 Results". Scrolling lazy-loads the rest.

**Implication for us:** for MLS# lookups, always just one result. For address lookups, the ladder is designed to narrow to a small number — typically 1-3 hits. We should not hit the virtualization ceiling in practice.

**If it ever becomes a problem:** scroll the results container programmatically until the target MLS# appears, or use the MLS# field in the search form to narrow down.

---

## 8. Multiple Results — Selecting the Right One

When an address search returns multiple listings (e.g., an address with prior MLS# entries), preference order:

1. Status = `Active` (proper case or ALL CAPS)
2. Fall back to most recent by Status Date or List Date

Never return an Expired or Sold listing if an Active one exists at the same address. (Note: this is the selection rule *within* search results. The Property History section on the chosen listing's detail page still shows all prior MLS#s.)

---

## 9. Auto-Generated IDs Are Unstable

The blank search form had a number field with `id="750010005003"` — an auto-generated numeric ID. These change across sessions/deploys. Do not rely on them.

**Handling:** always use label-based selectors (`getByLabel`) for search form fields. The label text ("Address Number", "Address Street", etc.) is stable.

---

## 10. MUI/Emotion CSS Classes Can Change

Class names like `css-16biofz`, `css-1gmb2pb`, etc. are generated by MUI/Emotion at build time. They can change when Paragon redeploys the front-end.

**Handling:** 
- Prefer semantic selectors (`aria-labelledby`, `role`, `getByText`, `getByLabel`) as primary.
- When you must use CSS classes (e.g., to find the label/value pairs), combine with an additional stable attribute like `data-left="true"` and `weight="600"` to reduce fragility.
- If the scraper suddenly breaks after a Paragon update, the first thing to check is whether class names changed.

---

## 11. PDF URLs Are Publicly Accessible

Documents linked from a listing (Lead-Based Paint, SPCDS, etc.) are hosted at URLs like:

```
https://gprmls.paragonrels.com/ParagonLS/Files/AssociatedDocs/gprmls/{N}/gprmls_{fileId}.pdf
```

These URLs do not require authentication. Anyone with the URL can download the PDF. Store the URL; the UI can link directly to it without any scraper mediation.

**Future consideration:** if Paragon ever tightens this, we may need to download the PDFs through the authenticated session and re-serve or cache them. Not a problem today.

---

## 12. Terms of Service & Home IP

Ryan is running this on his home internet connection, not a datacenter IP. This matters because:

- MLS providers often flag datacenter IPs as bots.
- Ryan is a legitimate MLS member with permission to access this data for his own use.
- The 3-minute session TTL and serial queue keep the load minimal.

Keep the scraper polite: don't batch-scrape large numbers of listings in tight loops. One lookup at a time is both the architecture and the right behavior.
