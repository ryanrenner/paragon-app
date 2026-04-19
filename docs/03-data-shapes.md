# Data Shapes

This doc shows the expected shape of data at each stage of the pipeline. Use these as references when building the scraper and database layer.

See `samples/` for full JSON examples extracted from real Paragon HTML.

---

## Stage 1: Search Results Card (one per match)

Extracted by `scraper.js` when the search returns multiple results and we need to pick the right one.

```json
{
  "mls": "22610516",
  "address": "7105 Pine Drive",
  "city_state_zip": "La Vista, NE 68128",
  "status": "New",                      // Normalized to proper case
  "price": "$325,000",
  "beds": "4",
  "baths": "4",
  "dom": "1",
  "total_finished_sqft": "2,496",       // May be null
  "cover_photo_url": "https://zimg.paragon.ice.com/..."
}
```

See `samples/search-results-cards.json` for 20 real examples.

**Selection rule:** prefer `status === "Active"`. If no Active, take the most recent by date.

---

## Stage 2: Full Scraped Listing

The complete scrape from the detail page. This is what gets stored in `lookups.full_data` as a JSON blob.

```json
{
  "scraped_at": "2026-04-19T14:32:00Z",
  "url": "https://gprmls.paragonrels.com/ParagonConnect/gprmls/...?ssId=...",
  "cover_photo_url": "https://zimg.paragon.ice.com/...",
  "fields": {
    "MLS #": "22610267",
    "Status": "New",
    "Class": "RESIDENTIAL",
    "Listing Price": "$335,000",
    "Property Subtype": "Single Family Residence",
    "Address": "3503 S 152nd Street",
    "County": "Douglas",
    "City": "Omaha",
    "Zip": "68144",
    "State": "Nebraska",
    "Bedrooms": "3",
    "Bathrooms": "3",
    "Year Built": "1992",
    "Public Remarks": "Well-maintained 3 bed, 3 bath home on a spacious corner lot! ...",
    "Agent Remarks": "AMA. For any questions regarding the property, please call ...",
    "Showing Instructions": "For any questions regarding the property, ...",
    "Lock Box Provider": "Supra",
    "...": "... 130+ more fields ..."
  },
  "documents": [
    {
      "name": "LBP",
      "url": "https://gprmls.paragonrels.com/ParagonLS/Files/AssociatedDocs/gprmls/9/gprmls_1126824.pdf",
      "size": "216.25 KB",
      "date_added": "02/13/2026",
      "visibility": "Public"
    }
  ],
  "history": [
    {
      "mls": "22604189",
      "events": [
        {
          "year": "2026",
          "month": "Mar",
          "day": "3",
          "time": "12:02 AM",
          "event": "Status: ACTIVE",
          "general_date": "2/13/2026",
          "price": "$334,500"
        }
      ]
    }
  ]
}
```

See `samples/all-fields-detail.json` (138 fields), `samples/documents.json`, and `samples/property-history.json` for complete examples.

**Important:** keep field names as they appear in Paragon (e.g., "MLS #" with the space and hash, "HOA (Y/N)" with parentheses). Don't normalize keys. The raw `fields` object is a faithful copy of what the agent sees on screen, which makes debugging easy.

---

## Stage 3: AI Prompt Input

Per `docs/01-decisions.md`, a **subset** of the scraped data is sent to Claude. Not the full record. Shape:

```json
{
  "address": "3503 S 152nd Street, Omaha, NE 68144",
  "mls": "22610267",
  "status": "New",
  "list_price": "$335,000",
  "original_price": null,
  "days_on_market": 3,
  "list_date": "04/16/2026",
  "status_date": "04/16/2026",
  "beds": 3,
  "baths": "2/0",
  "total_finished_sqft": 1248,
  "above_grade_sqft": 1248,
  "year_built": 1992,
  "public_remarks": "...",
  "agent_remarks": "...",
  "showing_instructions": "...",
  "lock_box_provider": "Supra",
  "showtime_phone": "(402) 416-8366",
  "annual_taxes": null,
  "property_history_summary": [
    { "mls": "22604189", "final_status": "ACTIVE", "final_price": "$334,500" },
    { "mls": "22430375", "final_status": "SOLD", "final_price": "$285,000" },
    { "mls": "20716199", "final_status": "Current Entry", "final_price": "$123,500" }
  ]
}
```

**History summary:** for each prior MLS#, include only the most recent (first in the timeline) event's status and price. Full history still stays in SQLite.

---

## Stage 4: AI Response

Not rigidly structured. Claude returns free-form analysis covering:

- Quick property summary (2-3 sentences)
- Key strengths
- Potential concerns or flags
- Showing/access notes
- Agent remarks summary
- Notable history (price drops, prior expired listings, quick prior sale)

Stored as-is in `lookups.ai_analysis`. Displayed at the top of results.

---

## Stage 5: SQLite Row

The `lookups` table:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `queried_at` | DATETIME | UTC ISO8601 |
| `query_input` | TEXT | Raw user input |
| `query_variant` | TEXT | Which address ladder step succeeded (null for MLS# lookups) |
| `mls_number` | TEXT | Nullable; null on failed scrapes |
| `address` | TEXT | Nullable |
| `status` | TEXT | Nullable |
| `price` | TEXT | Nullable |
| `days_on_market` | INTEGER | Nullable |
| `cover_photo_url` | TEXT | Nullable |
| `full_data` | TEXT | JSON of Stage 2 output. Nullable on error. |
| `ai_analysis` | TEXT | AI response text. Nullable. |
| `error` | TEXT | Error message if the lookup failed. Nullable. |

Display all timestamps in `America/Chicago` in the UI. Store UTC.

---

## Notes on Field Types

Numeric fields in Paragon come through as strings with formatting:
- `"1,248"` for SqFt (has thousands separator)
- `"$335,000"` for prices (has currency symbol)
- `"0.230"` for Total Acres

Keep them as strings in `fields` so the raw data round-trips cleanly. Parse them only when you need to compute or compare (e.g., when selecting the most recent listing from multiple results).
