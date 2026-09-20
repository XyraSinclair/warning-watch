#!/usr/bin/env node

// CBRN alarm contract — the shared shape for every chemical, biological,
// radiological or nuclear observation this system is willing to wake a
// person for.
//
// Three rules, inherited from the aviation instrument's discipline:
//
//   1. Evidence-bound. No baseline, no alert. An instrument without enough
//      history reports itself unavailable; it never reports "the world is
//      safe". Missing data is an outage, not an all-clear.
//
//   2. Two gates, in order. Statistics decide whether we look; absolute
//      physics decides whether a stranger's phone rings. A modern gamma
//      probe drifts 4 sigma while measuring nothing, and a quiet regional
//      airport posts zeros all night. Statistical extremity without a
//      physical threshold is an operator-only `watch` event; only real
//      magnitude reaches a public severity.
//
//   3. One alarm plane. Every CBRN event is a row in the existing
//      alert_events table (cohort = 'cbrn'), so the existing fan-out — ntfy
//      push, RSS, Telegram, email, SMS, web push, outbound webhook — carries
//      it with no new delivery code and no new channel to keep alive.
//      Severity keeps its existing meaning: watch (operator-only) <
//      elevated < high < critical.
//
// Alert text reports measured values, thresholds, locations and source
// provenance. Authority instruction text is relayed verbatim by its detector.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { UPSERT_STATUS_SQL } = require('../server/publication');

const { severityForLevel, robustStats, medianOf, cusumStep } = require('./detect_alert_events.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CBRN_DB = path.join(ROOT_DIR, 'data', 'ews-cbrn.sqlite');

// cohort value shared by every CBRN alert event.
const CBRN_COHORT = 'cbrn';

// Event kinds. `kind` is stable and load-bearing: the operator surface, the
// fusion pass, and any future severity review all key off it.
const KIND = {
  // Physical measurement.
  RADIATION_ANOMALY: 'cbrn_radiation_anomaly',
  RADIATION_NETWORK: 'cbrn_radiation_network',
  // Aviation behaviour.
  AIRSPACE_VOID: 'cbrn_airspace_void',
  AIRCRAFT_EMERGENCY: 'cbrn_aircraft_emergency',
  SPECIAL_AIRCRAFT: 'cbrn_special_aircraft',
  // Human signal.
  LEXICAL_BURST: 'cbrn_lexical_burst',
  // Authority.
  OFFICIAL_NOTICE: 'cbrn_official_notice',
  // Seismic catalogue: a detonation candidate by location, depth, or agency classification.
  SEISMIC_EVENT: 'cbrn_seismic_event',
  // Cross-family agreement (written only by the fusion pass).
  FUSED: 'cbrn_fused',
};

function cbrnDbPath() {
  return process.env.EWS_CBRN_DB_PATH || DEFAULT_CBRN_DB;
}

// The CBRN store is separate from the three aviation cohort databases and
// from the digital watch's evidence store: it holds instrument time series
// (thousands of stations per hour), not incident evidence or review state.
function openCbrnDb({ dbPath = cbrnDbPath(), readonly = false } = {}) {
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    ensureCbrnSchema(db);
  }
  return db;
}

const SCHEMA = [
  // Station roster for every instrumented network we poll.
  `CREATE TABLE IF NOT EXISTS cbrn_stations (
     source TEXT NOT NULL,
     station_id TEXT NOT NULL,
     name TEXT,
     lat REAL NOT NULL,
     lon REAL NOT NULL,
     country TEXT,
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     PRIMARY KEY (source, station_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cbrn_stations_source ON cbrn_stations (source)`,
  // One row per station per source-reported observation time. Re-ingesting a
  // corrected value for the same timestamp updates in place.
  `CREATE TABLE IF NOT EXISTS cbrn_readings (
     source TEXT NOT NULL,
     station_id TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     value REAL NOT NULL,
     unit TEXT NOT NULL,
     quality TEXT,
     ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (source, station_id, observed_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cbrn_readings_time ON cbrn_readings (observed_at)`,
  // CBRN-relevant geographies the live-aircraft instrument samples. The
  // roster is operator-controlled: it is an instrument config, not published
  // targeting data.
  `CREATE TABLE IF NOT EXISTS cbrn_regions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     lat REAL NOT NULL,
     lon REAL NOT NULL,
     radius_nm INTEGER NOT NULL,
     kind TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS cbrn_aircraft_slots (
     region TEXT NOT NULL,
     sampled_at TEXT NOT NULL,
     aircraft_count INTEGER NOT NULL,
     emergency_count INTEGER NOT NULL DEFAULT 0,
     military_count INTEGER NOT NULL DEFAULT 0,
     special_json TEXT,
     PRIMARY KEY (region, sampled_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cbrn_aircraft_slots_time ON cbrn_aircraft_slots (sampled_at)`,
  // Lexical counts per stream, region and time bucket. Counts and matched
  // surface forms only: no post bodies are retained here.
  `CREATE TABLE IF NOT EXISTS cbrn_lexical_buckets (
     stream TEXT NOT NULL,
     region TEXT NOT NULL,
     bucket_start TEXT NOT NULL,
     term_count INTEGER NOT NULL,
     post_count INTEGER NOT NULL DEFAULT 0,
     terms_json TEXT,
     PRIMARY KEY (stream, region, bucket_start)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cbrn_lexical_time ON cbrn_lexical_buckets (bucket_start)`,
  // Sequential-detector state (CUSUM accumulators, last-fired keys) keyed by
  // series so a restart resumes rather than re-alarms.
  `CREATE TABLE IF NOT EXISTS cbrn_alarm_state (
     series_key TEXT NOT NULL,
     method TEXT NOT NULL,
     state_json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (series_key, method)
   )`,
  // Per-source collection health. A source that stops answering must be
  // visible as an outage, never as quiet.
  `CREATE TABLE IF NOT EXISTS cbrn_ingest_runs (
     source TEXT PRIMARY KEY,
     last_attempt_at TEXT NOT NULL,
     last_success_at TEXT,
     last_error TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     detail_json TEXT
   )`,
];

function ensureCbrnSchema(db) {
  for (const statement of SCHEMA) {
    db.exec(statement);
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- detection

// Robust z against a supplied baseline, with an absolute floor on the scale
// term. Without the floor, a probe with a 0.002 uSv/h MAD turns ordinary
// sensor noise into a 10-sigma "event"; the floor is the physics guard that
// makes the statistic mean something.
//
// `robustStats` (shared with the aviation detector) returns
// `{median, rawSigma, sigma, sampleCount}` where `rawSigma` is the unfloored
// 1.4826*MAD and `sigma` additionally applies the Poisson/unit floor. Callers
// pass the physical floor they want; when they pass none we use `sigma`.
function robustZ(value, stats, floor) {
  if (!stats || !Number.isFinite(stats.median)) {
    return null;
  }
  const scale = floor > 0 ? Math.max(stats.rawSigma ?? 0, floor) : stats.sigma;
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  return (value - stats.median) / scale;
}

function haversineKm(latA, lonA, latB, lonB) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Read/write a sequential detector's accumulator. Detectors must use this
// rather than module state so a restart resumes the same alarm sequence.
function readAlarmState(db, seriesKey, method) {
  const row = db
    .prepare('SELECT state_json FROM cbrn_alarm_state WHERE series_key = ? AND method = ?')
    .get(seriesKey, method);
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

function writeAlarmState(db, seriesKey, method, state) {
  db.prepare(
    `INSERT INTO cbrn_alarm_state (series_key, method, state_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(series_key, method) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
  ).run(seriesKey, method, JSON.stringify(state), nowIso());
}

function recordIngestRun(db, { source, ok, error = null, detail = null }) {
  const at = nowIso();
  const existing = db
    .prepare('SELECT consecutive_failures FROM cbrn_ingest_runs WHERE source = ?')
    .get(source);
  const failures = ok ? 0 : (existing?.consecutive_failures ?? 0) + 1;
  db.prepare(
    `INSERT INTO cbrn_ingest_runs (source, last_attempt_at, last_success_at, last_error, consecutive_failures, detail_json)
     VALUES (@source, @at, @successAt, @error, @failures, @detailJson)
     ON CONFLICT(source) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_success_at = COALESCE(excluded.last_success_at, cbrn_ingest_runs.last_success_at),
       last_error = excluded.last_error,
       consecutive_failures = excluded.consecutive_failures,
       detail_json = excluded.detail_json`,
  ).run({
    source,
    at,
    successAt: ok ? at : null,
    error,
    failures,
    detailJson: detail ? JSON.stringify(detail) : null,
  });
  return failures;
}

// ------------------------------------------------------------- event writing

// Compose one alert_events row and append observation/source provenance.
function buildCbrnEvent({
  kind,
  level,
  occurredAt,
  title,
  message,
  payload = {},
  keyParts = [],
  source,
  publicUrl,
}) {
  const severity = severityForLevel(level);
  const footer = [
    `Observed ${occurredAt}`,
    source ? `source ${source}` : null,
    publicUrl || 'https://warning.watch/cbrn',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
  return {
    kind,
    severity,
    cohort: CBRN_COHORT,
    eventKey: [kind, ...keyParts].join(':'),
    occurredAt,
    title,
    message: `${message}\n\n${footer}`,
    payloadJson: JSON.stringify({ ...payload, kind, severity }),
    status: 'pending',
  };
}

// Same upsert discipline as the aviation detector: a repeated event key
// updates the existing row (severity, text, payload) instead of creating a
// second alert; UPSERT_STATUS_SQL makes an escalation deliver again.
function insertCbrnEvent(db, event) {
  const existing = db
    .prepare('SELECT id, severity, payload_json FROM alert_events WHERE event_key = ?')
    .get(event.eventKey);

  if (existing) {
    db.prepare(
      `UPDATE alert_events
          SET event_key = @eventKey,
              severity = @severity,
              title = @title,
              message = @message,
              payload_json = @payloadJson,
              occurred_at = @occurredAt,
              status = ${UPSERT_STATUS_SQL}
        WHERE id = @id`,
    ).run({ ...event, id: existing.id });
    return { inserted: false, escalated: existing.severity !== event.severity, id: existing.id };
  }

  db.prepare(
    `INSERT INTO alert_events (kind, severity, cohort, event_key, occurred_at, title, message, payload_json, status)
     VALUES (@kind, @severity, @cohort, @eventKey, @occurredAt, @title, @message, @payloadJson, @status)`,
  ).run(event);
  return { inserted: true, escalated: false, id: null };
}

module.exports = {
  CBRN_COHORT,
  KIND,
  cbrnDbPath,
  openCbrnDb,
  ensureCbrnSchema,
  robustZ,
  haversineKm,
  readAlarmState,
  writeAlarmState,
  recordIngestRun,
  buildCbrnEvent,
  insertCbrnEvent,
  nowIso,
  // re-exported so detectors share exactly one implementation
  severityForLevel,
  robustStats,
  medianOf,
  cusumStep,
};
