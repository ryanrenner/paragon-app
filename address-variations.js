'use strict';

/**
 * address-variations.js
 *
 * Parses a free-form address string into Paragon's search-form components
 * (number, direction prefix, street name, street type) and generates an
 * ordered ladder of variations to try if earlier ones return no results.
 *
 * See docs/01-decisions.md ("Address Search Ladder").
 *
 * The Paragon Residential search form has these fields:
 *   - Address Number          (e.g., "3503")
 *   - Address Direction Prefix (N, S, E, W)
 *   - Address Street          (street name, no suffix, e.g., "152nd")
 *   - Street Type             ("Street", "Avenue", "Drive", ...)
 *
 * So a "variation" is a full shape of { number, direction, street, type }
 * where we vary the representation of direction and type (and optionally
 * drop them entirely as a last-ditch attempt).
 */

const DIRECTION_EXPANSIONS = {
  N: 'North',
  S: 'South',
  E: 'East',
  W: 'West',
  NE: 'Northeast',
  NW: 'Northwest',
  SE: 'Southeast',
  SW: 'Southwest',
};

const DIRECTION_CONTRACTIONS = Object.fromEntries(
  Object.entries(DIRECTION_EXPANSIONS).map(([abbr, full]) => [full.toLowerCase(), abbr])
);

const STREET_TYPE_EXPANSIONS = {
  ST: 'Street',
  AVE: 'Avenue',
  AV: 'Avenue',
  BLVD: 'Boulevard',
  RD: 'Road',
  DR: 'Drive',
  LN: 'Lane',
  CT: 'Court',
  CIR: 'Circle',
  PL: 'Place',
  PKWY: 'Parkway',
  HWY: 'Highway',
  TER: 'Terrace',
  TRL: 'Trail',
  WAY: 'Way',
  PLZ: 'Plaza',
  SQ: 'Square',
  LOOP: 'Loop',
  RUN: 'Run',
  XING: 'Crossing',
};

const STREET_TYPE_CONTRACTIONS = Object.fromEntries(
  Object.entries(STREET_TYPE_EXPANSIONS).map(([abbr, full]) => [full.toLowerCase(), abbr])
);

const KNOWN_DIRECTION_TOKENS = new Set(
  [
    ...Object.keys(DIRECTION_EXPANSIONS),
    ...Object.values(DIRECTION_EXPANSIONS),
  ].map((t) => t.toLowerCase())
);

const KNOWN_STREET_TYPE_TOKENS = new Set(
  [
    ...Object.keys(STREET_TYPE_EXPANSIONS),
    ...Object.values(STREET_TYPE_EXPANSIONS),
  ].map((t) => t.toLowerCase())
);

/**
 * Strip city/state/zip tail from an address string.
 * Handles common forms like:
 *   "3503 S 152nd St, Omaha, NE 68144"
 *   "3503 S 152nd Street Omaha NE 68144-1234"
 *   "3503 S 152nd Street Omaha ne"            (lowercase state)
 *
 * Returns just the street portion: number + direction + street + (type).
 *
 * When there's no comma, we also trust the position of a recognized street
 * type token (St, Street, Avenue, etc.) to mark the boundary between the
 * street and the city. Anything AFTER the street type gets dropped.
 */
function stripCityStateZip(input) {
  if (!input) return '';
  let s = String(input).trim();

  // Remove anything after the first comma. Most users type commas.
  if (s.includes(',')) {
    s = s.split(',')[0].trim();
    return s.replace(/\s+/g, ' ');
  }

  // No comma. First, chew off a trailing ZIP and state (case-insensitive).
  s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim();
  s = s.replace(/\s+[A-Za-z]{2}\s*$/, '').trim();

  // If a recognized street-type token appears in the tokens, cut at the
  // LAST occurrence. Everything from there on is the street type; anything
  // beyond that token is likely a trailing city name.
  const tokens = s.split(/\s+/).filter(Boolean);
  let cutAt = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = normalizeToken(tokens[i]);
    if (KNOWN_STREET_TYPE_TOKENS.has(tok)) {
      cutAt = i;
      break;
    }
  }
  if (cutAt >= 0) {
    s = tokens.slice(0, cutAt + 1).join(' ');
  } else {
    s = tokens.join(' ');
  }

  return s.replace(/\s+/g, ' ');
}

/**
 * Normalize a token for dictionary lookup: lowercase, strip trailing punctuation.
 */
function normalizeToken(t) {
  return t.toLowerCase().replace(/[.,]/g, '');
}

/**
 * Parse a stripped street string into { number, direction, street, type }.
 * Fields may be undefined when not detected.
 */
function parseStreet(stripped) {
  const parts = {
    number: undefined,
    direction: undefined,
    street: undefined,
    type: undefined,
  };
  if (!stripped) return parts;

  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return parts;

  let i = 0;

  // Number: usually the first token is numeric (possibly with letters, e.g. "123B").
  if (/^\d+[A-Za-z]?$/.test(tokens[i])) {
    parts.number = tokens[i];
    i++;
  }

  // Direction prefix.
  if (i < tokens.length && KNOWN_DIRECTION_TOKENS.has(normalizeToken(tokens[i]))) {
    parts.direction = tokens[i].replace(/[.,]/g, '');
    i++;
  }

  // Street type: last token if it's a known street type and we still have
  // at least one token left for the street name.
  if (tokens.length - 1 > i) {
    const last = tokens[tokens.length - 1];
    if (KNOWN_STREET_TYPE_TOKENS.has(normalizeToken(last))) {
      parts.type = last.replace(/[.,]/g, '');
      tokens.splice(tokens.length - 1, 1);
    }
  }

  // Street name: everything between number/direction and (already-removed) type.
  const streetTokens = tokens.slice(i);
  if (streetTokens.length > 0) {
    parts.street = streetTokens.join(' ');
  }

  return parts;
}

/**
 * Return the canonical abbreviation for a direction, or undefined.
 */
function directionAbbr(val) {
  if (!val) return undefined;
  const key = val.toLowerCase();
  if (DIRECTION_EXPANSIONS[val.toUpperCase()]) return val.toUpperCase();
  if (DIRECTION_CONTRACTIONS[key]) return DIRECTION_CONTRACTIONS[key];
  return undefined;
}

function directionFull(val) {
  if (!val) return undefined;
  const upper = val.toUpperCase();
  if (DIRECTION_EXPANSIONS[upper]) return DIRECTION_EXPANSIONS[upper];
  if (DIRECTION_CONTRACTIONS[val.toLowerCase()]) return val;
  return undefined;
}

function typeAbbr(val) {
  if (!val) return undefined;
  const upper = val.toUpperCase();
  if (STREET_TYPE_EXPANSIONS[upper]) return upper;
  if (STREET_TYPE_CONTRACTIONS[val.toLowerCase()]) return STREET_TYPE_CONTRACTIONS[val.toLowerCase()];
  return undefined;
}

function typeFull(val) {
  if (!val) return undefined;
  const upper = val.toUpperCase();
  if (STREET_TYPE_EXPANSIONS[upper]) return STREET_TYPE_EXPANSIONS[upper];
  if (STREET_TYPE_CONTRACTIONS[val.toLowerCase()]) return val;
  return undefined;
}

/**
 * Deduplicate variations by a stable key.
 */
function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const key = JSON.stringify({
      number: v.number || '',
      direction: v.direction || '',
      street: v.street || '',
      type: v.type || '',
    });
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/**
 * Build the ordered ladder of search variations.
 *
 * Ladder:
 *   1. As-entered (after stripping city/state/zip)
 *   2. Direction expanded (N → North) — keep original type
 *   3. Direction contracted (North → N) — keep original type
 *   4. Type expanded (St → Street)
 *   5. Type contracted (Street → St)
 *   6. Both expanded
 *   7. Both contracted
 *   8. Last-ditch: number + street only (no direction, no type)
 *
 * Returns an array of variations, each shaped like:
 *   {
 *     number, direction, street, type,
 *     label: "human-readable label of what changed"
 *   }
 *
 * Cap at 6 attempts per decisions.md ("~4 attempts" is soft guidance; we
 * bump to 6 to cover the combined expand/contract rungs cleanly).
 */
function buildVariations(rawAddress) {
  const stripped = stripCityStateZip(rawAddress);
  const base = parseStreet(stripped);

  const variations = [];

  const push = (v, label) => {
    // Require at least a number + street to be worth attempting.
    if (!v.number && !v.street) return;
    variations.push({ ...v, label });
  };

  // 1. As-entered
  push(base, 'as entered');

  // 2. Direction expanded
  if (base.direction) {
    const full = directionFull(base.direction);
    if (full && full !== base.direction) {
      push({ ...base, direction: full }, 'direction expanded');
    }
  }

  // 3. Direction contracted
  if (base.direction) {
    const abbr = directionAbbr(base.direction);
    if (abbr && abbr !== base.direction) {
      push({ ...base, direction: abbr }, 'direction contracted');
    }
  }

  // 4. Type expanded
  if (base.type) {
    const full = typeFull(base.type);
    if (full && full !== base.type) {
      push({ ...base, type: full }, 'street type expanded');
    }
  }

  // 5. Type contracted
  if (base.type) {
    const abbr = typeAbbr(base.type);
    if (abbr && abbr !== base.type) {
      push({ ...base, type: abbr }, 'street type contracted');
    }
  }

  // 6. Both expanded
  if (base.direction || base.type) {
    const vFull = {
      ...base,
      direction: directionFull(base.direction) || base.direction,
      type: typeFull(base.type) || base.type,
    };
    push(vFull, 'direction + type expanded');
  }

  // 7. Both contracted
  if (base.direction || base.type) {
    const vAbbr = {
      ...base,
      direction: directionAbbr(base.direction) || base.direction,
      type: typeAbbr(base.type) || base.type,
    };
    push(vAbbr, 'direction + type contracted');
  }

  // 8. Last-ditch: number + street core only (drop direction and type).
  if (base.number && base.street) {
    push(
      { number: base.number, direction: undefined, street: base.street, type: undefined },
      'number + street only',
    );
  }

  return uniq(variations).slice(0, 8);
}

module.exports = {
  stripCityStateZip,
  parseStreet,
  buildVariations,
  // exported for testing
  _internal: {
    directionAbbr,
    directionFull,
    typeAbbr,
    typeFull,
    DIRECTION_EXPANSIONS,
    STREET_TYPE_EXPANSIONS,
  },
};
