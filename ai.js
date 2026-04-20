'use strict';

/**
 * ai.js
 *
 * OpenRouter API wrapper. Given a Stage 2 scraped listing (see
 * docs/03-data-shapes.md), extract the AI-input subset, call the configured
 * model via OpenRouter, and return the text of the response.
 *
 * Configuration is via environment variables:
 *   OPENROUTER_API_KEY  — required; your OpenRouter API key
 *   AI_MODEL            — optional; defaults to google/gemini-2.5-flash-lite
 *   AI_MAX_TOKENS       — optional; defaults to 1000
 *
 * Failure modes are tolerated: if the API key is missing or the call
 * fails, analyzeListing returns null and the server still ships the
 * scraped data with an "AI analysis unavailable" indicator.
 */

const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_MAX_TOKENS = 1000;
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Pick the subset of fields sent to Claude, per docs/01-decisions.md.
 * Everything else is still stored in SQLite — just not sent to the model.
 */
function buildAiInput(stage2) {
  const f = (stage2 && stage2.fields) || {};

  const daysOnMarketRaw = f['DOM'] ?? f['Days on Market'] ?? f['Days On Market'];
  const daysOnMarket = daysOnMarketRaw != null ? Number(String(daysOnMarketRaw).replace(/[^\d.-]/g, '')) : null;

  // Property history summary: per decisions.md, just the most recent event
  // per prior MLS#.
  const historySummary = ((stage2 && stage2.history) || []).map((group) => {
    const first = (group.events && group.events[0]) || {};
    return {
      mls: group.mls,
      final_status: extractStatus(first.event),
      final_price: first.price || null,
    };
  });

  const cityStateZip = [f['City'], f['State'], f['Zip']].filter(Boolean).join(', ');
  const fullAddress = [f['Address'], cityStateZip].filter(Boolean).join(', ');

  return {
    address: fullAddress || f['Address'] || null,
    mls: f['MLS #'] || null,
    status: f['Status'] || null,
    list_price: f['Listing Price'] || null,
    original_price: f['Original Price'] || null,
    days_on_market: Number.isFinite(daysOnMarket) ? daysOnMarket : null,
    list_date: f['List Date'] || null,
    status_date: f['Status Date'] || null,
    beds: toNumOrString(f['Bedrooms']),
    baths: f['Bathrooms Full/Half'] || f['Bathrooms'] || null,
    total_finished_sqft: toNumOrString(f['Total Finished SqFt']),
    above_grade_sqft: toNumOrString(f['Above Grade SQFT'] || f['Above Grade SqFt']),
    year_built: toNumOrString(f['Year Built']),
    public_remarks: f['Public Remarks'] || null,
    agent_remarks: f['Agent Remarks'] || null,
    showing_instructions: f['Showing Instructions'] || null,
    lock_box_provider: f['Lock Box Provider'] || null,
    showtime_phone: f['Showtime Phone'] || extractShowtimePhone(f) || null,
    annual_taxes: f['Tax Amount'] || f['Annual Taxes'] || null,
    property_history_summary: historySummary,
  };
}

function toNumOrString(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/[$,]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : v;
}

function extractStatus(eventText) {
  if (!eventText) return null;
  const m = String(eventText).match(/Status:\s*([A-Z]+)/);
  if (m) return m[1];
  return eventText; // "First entry", "Listing Price", etc.
}

/**
 * Showtime phone number is not a dedicated field in the All Fields Detail —
 * it's often embedded in Showing Instructions or Agent Remarks as a
 * US phone number. Pull the first phone-shaped substring we find.
 */
function extractShowtimePhone(fields) {
  const sources = [fields['Showing Instructions'], fields['Agent Remarks']];
  const phoneRegex = /\(?\b(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/;
  for (const src of sources) {
    if (!src) continue;
    const m = String(src).match(phoneRegex);
    if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  }
  return null;
}

function buildPrompt(aiInput) {
  return (
    `You are a real estate agent's assistant. Analyze this MLS listing data and ` +
    `provide a concise, practical summary. Focus on what a buyer's or seller's ` +
    `agent would actually care about.\n\n` +
    `Structure your response with these sections (use short headings):\n` +
    `  1. Summary — 2 to 3 sentences about the property.\n` +
    `  2. Key strengths — bullet the most attractive features or data points.\n` +
    `  3. Potential concerns — flag anything notable: long DOM, price drops,\n` +
    `     prior expired listings, unusual remarks, missing info.\n` +
    `  4. Showing & access — lock box, call instructions, showing service info.\n` +
    `  5. Agent remarks summary — if populated, summarize practical notes.\n` +
    `  6. History highlights — note anything interesting in the property's\n` +
    `     prior MLS history (price drops, expired listings, fast prior sales).\n\n` +
    `Be direct. Do not pad. If a section has nothing worth saying, say so briefly.\n\n` +
    `Listing Data:\n${JSON.stringify(aiInput, null, 2)}`
  );
}

/**
 * Main entry: returns { text, input, model } on success, null on failure.
 * Caller should treat null as "AI unavailable" and still return scraped data.
 */
async function analyzeListing(stage2) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('[ai] OPENROUTER_API_KEY not set; skipping AI analysis.');
    return null;
  }

  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  const maxTokens = parseInt(process.env.AI_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS;

  const aiInput = buildAiInput(stage2);
  const prompt = buildPrompt(aiInput);

  console.log(`[ai] Using model: ${model}, max_tokens: ${maxTokens}`);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ai] OpenRouter API error ${res.status}: ${body.slice(0, 500)}`);
      return null;
    }

    const data = await res.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
    if (!text) {
      console.error('[ai] OpenRouter returned empty content.');
      return null;
    }
    return { text, input: aiInput, model };
  } catch (err) {
    console.error('[ai] OpenRouter API call failed:', err);
    return null;
  }
}

module.exports = {
  analyzeListing,
  buildAiInput,
  // exported for debugging/tests
  _internal: { DEFAULT_MODEL, DEFAULT_MAX_TOKENS, API_URL, buildPrompt },
};
