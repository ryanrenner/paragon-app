'use strict';

/**
 * db.js
 *
 * SQLite layer using better-sqlite3. Schema per docs/03-data-shapes.md §5.
 *
 * Timestamps are stored as UTC ISO8601 strings. The UI formats them in
 * America/Chicago at display time.
 *
 * Failed lookups are also stored (with an `error` message) so Ryan can see
 * them in history.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Allow an env override — handy for tests or alternate deployments.
// Default is the Docker-volume-mounted ./data directory.
const DB_PATH = process.env.PARAGON_DB_PATH || path.join(__dirname, 'data', 'lookups.db');
const DB_DIR = path.dirname(DB_PATH);

let db = null;

function ensureDir() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

function getDb() {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  // Prefer WAL (better concurrency + durability). Fall back to the default
  // rollback journal on filesystems that don't support WAL files (some FUSE
  // mounts, etc.). Docker volumes on Linux support WAL fine.
  try {
    db.pragma('journal_mode = WAL');
  } catch (err) {
    console.warn(
      '[db] WAL journal mode not supported on this filesystem; falling back. ' +
        '(' + err.message + ')'
    );
    try { db.pragma('journal_mode = DELETE'); } catch {}
  }
  try { db.pragma('foreign_keys = ON'); } catch {}
  migrate(db);
  return db;
}

function migrate(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS lookups (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      queried_at       TEXT NOT NULL,
      query_input      TEXT NOT NULL,
      query_variant    TEXT,
      mls_number       TEXT,
      address          TEXT,
      status           TEXT,
      price            TEXT,
      days_on_market   INTEGER,
      cover_photo_url  TEXT,
      full_data        TEXT,
      ai_analysis      TEXT,
      error            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_lookups_queried_at
      ON lookups(queried_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lookups_mls
      ON lookups(mls_number);
  `);
}

/**
 * Insert a row. Pass a plain object; missing fields become null.
 * Returns the new row's id.
 */
function insertLookup(row) {
  const conn = getDb();
  const stmt = conn.prepare(`
    INSERT INTO lookups (
      queried_at, query_input, query_variant, mls_number, address,
      status, price, days_on_market, cover_photo_url, full_data,
      ai_analysis, error
    ) VALUES (
      @queried_at, @query_input, @query_variant, @mls_number, @address,
      @status, @price, @days_on_market, @cover_photo_url, @full_data,
      @ai_analysis, @error
    )
  `);
  const params = {
    queried_at: row.queried_at || new Date().toISOString(),
    query_input: row.query_input ?? '',
    query_variant: row.query_variant ?? null,
    mls_number: row.mls_number ?? null,
    address: row.address ?? null,
    status: row.status ?? null,
    price: row.price ?? null,
    days_on_market: row.days_on_market ?? null,
    cover_photo_url: row.cover_photo_url ?? null,
    full_data: row.full_data ?? null,
    ai_analysis: row.ai_analysis ?? null,
    error: row.error ?? null,
  };
  const res = stmt.run(params);
  return res.lastInsertRowid;
}

function getRecentLookups(limit = 20) {
  const conn = getDb();
  return conn
    .prepare(
      `SELECT id, queried_at, query_input, query_variant, mls_number,
              address, status, price, days_on_market, cover_photo_url,
              error
       FROM lookups
       ORDER BY datetime(queried_at) DESC, id DESC
       LIMIT ?`
    )
    .all(limit);
}

function getLookupById(id) {
  const conn = getDb();
  return conn
    .prepare(`SELECT * FROM lookups WHERE id = ?`)
    .get(id);
}

function updateAiAnalysis(id, text) {
  const conn = getDb();
  conn
    .prepare(`UPDATE lookups SET ai_analysis = ? WHERE id = ?`)
    .run(text ?? null, id);
}

module.exports = {
  getDb,
  insertLookup,
  getRecentLookups,
  getLookupById,
  updateAiAnalysis,
};
