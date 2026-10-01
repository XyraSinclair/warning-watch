#!/usr/bin/env node

const path = require('node:path');
const Database = require('better-sqlite3');
const { loadEnvFile } = require('../server/env');
loadEnvFile();
if (process.env.EWS_WATCH_ENV_PATH) loadEnvFile(process.env.EWS_WATCH_ENV_PATH);
const { KIND, openCbrnDb, robustStats, robustZ, cusumStep, readAlarmState, writeAlarmState, buildCbrnEvent, insertCbrnEvent } = require('./cbrn_lib');

const SPECIAL_TYPES = Object.freeze({
  WB57: 'high-altitude research aircraft',
  U2: 'high-altitude reconnaissance aircraft',
  E6: 'airborne command post',
  E6B: 'airborne command post',
  RC35: 'electronic reconnaissance aircraft',
  R135: 'electronic reconnaissance aircraft',
  P8: 'maritime patrol aircraft',
});
// C30J and C5M are deliberately excluded. These are type classes, not identities.
const DAY_MS = 86400000;
const MIN_SAMPLES = 10;
const SEVERITY_RANK = { watch: 1, elevated: 3, high: 4, critical: 5 };
const EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  cohort TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT,
  dispatch_summary_json TEXT,
  bridged_at TEXT,
  bridge_summary_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_status_created ON alert_events (status, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_kind_time ON alert_events (kind, occurred_at);`;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, eventsDb: process.env.EWS_DB_PATH || path.resolve(__dirname, '../data/ews-main.sqlite'), minutes: 60, dryRun: false };
  const names = { '--db': 'db', '--events-db': 'eventsDb', '--minutes': 'minutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  result.minutes = Number(result.minutes);
  if (!Number.isSafeInteger(result.minutes) || result.minutes < 1 || result.minutes > 1440) throw new Error('--minutes must be an integer from 1 to 1440.');
  return result;
}

function sampleMetadata(row) {
  try {
    const data = JSON.parse(row.special_json);
    if (!Number.isSafeInteger(data?.sample_minutes) || data.sample_minutes < 1 || data.sample_minutes > 60 || !data.types || !data.classes) return null;
    for (const count of [...Object.values(data.types), ...Object.values(data.classes)]) {
      if (!Number.isSafeInteger(count) || count < 0) return null;
    }
    return data;
  } catch {
    return null;
  }
}

function detect(db, settings, now = Date.now()) {
  const summary = { regions_evaluated: 0, warming: [], events_written: 0, events_escalated: 0 };
  const events = new Map();
  const states = new Map();
  const stateKey = (series, method) => `${series}/${method}`;
  const getState = (series, method) => states.has(stateKey(series, method)) ? states.get(stateKey(series, method)).state : readAlarmState(db, series, method);
  const setState = (series, method, state) => states.set(stateKey(series, method), { series, method, state });
  const warm = (region, detector, reason) => {
    if (!summary.warming.some((entry) => entry.region === region && entry.detector === detector && entry.reason === reason)) summary.warming.push({ region, detector, reason });
  };
  const regions = db.prepare("SELECT * FROM cbrn_regions WHERE enabled = 1 AND kind <> 'control' ORDER BY id").all();
  const healthySlots = new Set(db.prepare(`SELECT s.sampled_at FROM cbrn_aircraft_slots s
    JOIN cbrn_regions r ON r.id = s.region AND r.enabled = 1 AND r.kind = 'control'
    WHERE s.region IN ('europe-central', 'us-central') AND s.aircraft_count > 0 AND s.sampled_at >= ?
    GROUP BY s.sampled_at HAVING COUNT(DISTINCT s.region) = 2`).all(new Date(now - 22 * DAY_MS).toISOString()).map((row) => row.sampled_at));
  const historyQuery = db.prepare('SELECT * FROM cbrn_aircraft_slots WHERE region = ? AND sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at');
  for (const region of regions) {
    summary.regions_evaluated += 1;
    const history = historyQuery.all(region.id, new Date(now - 22 * DAY_MS).toISOString(), new Date(now).toISOString());
    const rows = history.filter((row) => Date.parse(row.sampled_at) > now - settings.minutes * 60000);
    if (!rows.length) {
      for (const detector of ['void', 'emergency', 'special']) warm(region.id, detector, 'No recent sample; unavailable');
      continue;
    }
    for (const row of rows) {
      const at = Date.parse(row.sampled_at);
      const metadata = sampleMetadata(row);
      if (!healthySlots.has(row.sampled_at) || !metadata) {
        for (const detector of ['void', 'emergency', 'special']) warm(region.id, detector, 'Control health or sample cadence unavailable');
        continue;
      }
      const cadence = metadata.sample_minutes * 60000;
      const hour = row.sampled_at.slice(0, 13);
      const baselineRows = history.filter((prior) => {
        const age = at - Date.parse(prior.sampled_at);
        return age > 0 && age <= 21 * DAY_MS && healthySlots.has(prior.sampled_at) && sampleMetadata(prior)?.sample_minutes === metadata.sample_minutes;
      });
      const sameHour = baselineRows.filter((prior) => new Date(prior.sampled_at).getUTCHours() === new Date(at).getUTCHours());
      const emit = (kind, level, suffix, message, payload, keyParts) => {
        const event = buildCbrnEvent({ kind, level, occurredAt: row.sampled_at, title: `${suffix}: ${region.name}`, message,
          payload: { region: region.id, control_healthy: true, ...payload }, keyParts, source: 'adsb.lol' });
        const previous = events.get(event.eventKey);
        if (!previous || SEVERITY_RANK[event.severity] >= SEVERITY_RANK[previous.severity]) events.set(event.eventKey, event);
      };
      const previousVoid = getState(`aircraft:${region.id}`, 'void');
      if (sameHour.length < MIN_SAMPLES || robustStats(sameHour.map((prior) => prior.aircraft_count)).median < 15) {
        warm(region.id, 'void', 'Requires 10 same-hour samples and median of at least 15 aircraft');
        if (!previousVoid || row.sampled_at > previousVoid.sampled_at) setState(`aircraft:${region.id}`, 'void', { sampled_at: row.sampled_at, consecutive: 0, s: 0 });
      } else if (!previousVoid || row.sampled_at > previousVoid.sampled_at) {
        const stats = robustStats(sameHour.map((prior) => prior.aircraft_count));
        const z = robustZ(row.aircraft_count, stats, 2);
        const isVoid = row.aircraft_count <= 0.25 * stats.median || z <= -5;
        const adjacent = previousVoid && at - Date.parse(previousVoid.sampled_at) === cadence;
        const consecutive = isVoid ? (adjacent ? previousVoid.consecutive || 0 : 0) + 1 : 0;
        const s = isVoid ? cusumStep(adjacent ? previousVoid.s : 0, -z, 0.5) : 0;
        setState(`aircraft:${region.id}`, 'void', { sampled_at: row.sampled_at, consecutive, s });
        if (isVoid && s > 0) {
          const level = consecutive >= 3 && row.aircraft_count <= 0.1 * stats.median ? 3 : 1;
          const facts = { lat: region.lat, lon: region.lon, count: row.aircraft_count, baseline_median: stats.median, baseline_samples: sameHour.length, z, cusum: s, consecutive, absolute_floor: { baseline_median: 15, public_max_ratio: 0.1 }, fusion_eligible: level === 3 };
          emit(KIND.AIRSPACE_VOID, level, 'Air traffic drop', `Air traffic over ${region.name}: ${row.aircraft_count} aircraft against a median of ${Number(stats.median.toFixed(1))} for this hour over 21 days (${sameHour.length} samples), robust score ${z.toFixed(1)}, low for ${consecutive} consecutive ${consecutive === 1 ? 'sample' : 'samples'}. A region is void at 25 % of its median or a score of −5.`, facts, [region.id, 'void', hour]);
          if (level === 3) setState(`fusion:${region.id}`, 'window', { region: region.id, timestamp: row.sampled_at, occurred_at: row.sampled_at, kind: KIND.AIRSPACE_VOID, level, control_healthy: true, ...facts });
        }
      }
      const recent = baselineRows.filter((prior) => at - Date.parse(prior.sampled_at) <= 7 * DAY_MS);
      const previousEmergency = getState(`aircraft:${region.id}`, 'emergency');
      if (recent.length < MIN_SAMPLES) warm(region.id, 'emergency', 'Requires 10 prior samples within seven days');
      else if (!previousEmergency || row.sampled_at > previousEmergency.sampled_at) {
        const stats = robustStats(recent.map((prior) => prior.emergency_count));
        const z = robustZ(row.emergency_count, stats, 1);
        setState(`aircraft:${region.id}`, 'emergency', { sampled_at: row.sampled_at });
        if (row.emergency_count >= 1 && z > 0) {
          const floor = stats.median === 0 ? 4 : 3;
          const level = row.emergency_count >= floor && row.emergency_count >= 3 * stats.median ? 3 : 1;
          emit(KIND.AIRCRAFT_EMERGENCY, level, 'Aircraft emergency indications', `${row.emergency_count} aircraft over ${region.name} reported emergency indications in 1 sample vs a 7-day median of ${stats.median} (${recent.length} samples); robust z ${z.toFixed(2)}. Threshold: count >= 1 and z > 0.`, { count: row.emergency_count, baseline_median: stats.median, baseline_samples: recent.length, z, absolute_floor: floor, watch_floor: 1 }, [region.id, 'emergency', row.sampled_at]);
        }
      }
      const previousSpecial = getState(`aircraft:${region.id}`, 'special');
      if (recent.length < MIN_SAMPLES) warm(region.id, 'special', 'Requires 10 prior typed samples within seven days');
      else if (!previousSpecial || row.sampled_at > previousSpecial.sampled_at) {
        const previousSample = baselineRows[baselineRows.length - 1];
        const previousMetadata = previousSample && at - Date.parse(previousSample.sampled_at) === cadence ? sampleMetadata(previousSample) : null;
        if (!previousMetadata) warm(region.id, 'special', 'Previous consecutive sample unavailable');
        else {
          const emittedClasses = new Set();
          for (const [type, label] of Object.entries(SPECIAL_TYPES)) {
            const count = metadata.types[type] || 0;
            const stats = robustStats(recent.map((prior) => sampleMetadata(prior).types[type] || 0));
            const z = robustZ(count, stats, 1);
            if (count < 1 || !(previousMetadata.types[type] >= 1) || z <= 0 || emittedClasses.has(label)) continue;
            emittedClasses.add(label);
            emit(KIND.SPECIAL_AIRCRAFT, 1, 'Special-mission aircraft observation', `${count} ${label} aircraft over ${region.name}; present in 2 consecutive samples vs a 7-day median of ${stats.median} (${recent.length} samples), robust z ${z.toFixed(2)}. Threshold: count >= 1 in each sample and z > 0.`, { class_label: label, count, baseline_median: stats.median, baseline_samples: recent.length, z, absolute_floor: 1, consecutive_samples: 2 }, [region.id, 'special', label, hour]);
          }
        }
        setState(`aircraft:${region.id}`, 'special', { sampled_at: row.sampled_at });
      }
    }
  }
  return { summary, events: [...events.values()], states: [...states.values()] };
}

function main() {
  const settings = options(process.argv.slice(2));
  const db = openCbrnDb({ dbPath: settings.db, readonly: settings.dryRun });
  let eventsDb;
  try {
    const result = detect(db, settings);
    if (settings.dryRun) {
      for (const event of result.events) console.log(JSON.stringify(event));
    } else {
      eventsDb = new Database(settings.eventsDb);
      eventsDb.exec(EVENTS_SCHEMA);
      eventsDb.transaction(() => {
        const lookup = eventsDb.prepare('SELECT severity FROM alert_events WHERE event_key = ?');
        for (const event of result.events) {
          const existing = lookup.get(event.eventKey);
          if (existing && SEVERITY_RANK[existing.severity] > SEVERITY_RANK[event.severity]) continue;
          const saved = insertCbrnEvent(eventsDb, event);
          if (saved.inserted) result.summary.events_written += 1;
          if (saved.escalated) result.summary.events_escalated += 1;
        }
      })();
      // Commit detector state only after events: a retry can upsert an event but cannot lose it.
      db.transaction(() => {
        for (const entry of result.states) writeAlarmState(db, entry.series, entry.method, entry.state);
      })();
    }
    console.log(JSON.stringify(result.summary));
  } finally {
    eventsDb?.close();
    db.close();
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { SPECIAL_TYPES, options, sampleMetadata, detect };
