#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { KIND, openCbrnDb, robustStats, robustZ, medianOf, cusumStep, haversineKm, readAlarmState, writeAlarmState, buildCbrnEvent, insertCbrnEvent } = require('./cbrn_lib');
const RANK = { watch: 1, elevated: 3, high: 4, critical: 5 };
// Ordinary outdoor gamma is ~0.05–0.25 uSv/h; rain/radon washout can
// transiently double it; a real release can push stations to 1–100 uSv/h.
// Live DE status distribution: 1/in Betrieb (1583), 2/defekt (81),
// 3/Testbetrieb (12). Exclude observed defective/test states; unknown status
// is unavailable, never presumed normal. EURDEP normal status is 1.
const EXCLUDED_STATUS = new Set([2, 3]);
const EXCLUDED_TEXT = new Set(['defekt', 'Testbetrieb']);
// EPA RadNet is one monitor per city, hundreds of kilometres apart: no monitor
// has neighbours to agree with, so agreement is asked of time instead of space.
// The record (19 Sept 2026; 131 monitors, 1.59 million hours since Jan 2025):
// highest hour anywhere 0.316 uSv/h, highest ratio to a monitor's own median
// 5.75x (radon washout in rain), station threshold met zero times. One
// departing hour is therefore `elevated` (95% bound: about two a year across
// the network), a second consecutive hour or a second monitor is `high`.
// EPA publishes only hours it has approved, so a real spike may be held back
// for review: silence from RadNet is not an all-clear.
const SPARSE_NETWORKS = new Set(['radnet']);
const EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, severity TEXT NOT NULL,
  cohort TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL,
  title TEXT NOT NULL, message TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dispatched_at TEXT, dispatch_summary_json TEXT, bridged_at TEXT, bridge_summary_json TEXT
);`;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, eventsDb: process.env.EWS_DB_PATH || path.resolve(__dirname, '../data/ews-main.sqlite'), minutes: 180, dryRun: false };
  const names = { '--db': 'db', '--events-db': 'eventsDb', '--minutes': 'minutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  result.minutes = Number(result.minutes);
  if (!Number.isSafeInteger(result.minutes) || result.minutes < 1) throw new Error('--minutes must be a positive integer.');
  return result;
}

function normal(row) {
  try {
    const quality = JSON.parse(row.quality);
    if (row.source === 'radnet') return quality.status === 'APPROVED' && row.unit === 'µSv/h';
    return quality.site_status === 1 && !EXCLUDED_STATUS.has(quality.site_status) && !EXCLUDED_TEXT.has(quality.site_status_text) && ['µSv/h', 'μSv/h', 'uSv/h'].includes(row.unit);
  } catch { return false; }
}

function isDeparting(value, median) {
  return (value >= 3 * median && value - median >= 0.5) || value >= 5;
}

// How long has this station been departing without a break? History ascends; the last row is the latest.
function departingRun(history, median) {
  let start = history.length - 1;
  while (start > 0 && normal(history[start - 1]) && isDeparting(history[start - 1].value, median) && Date.parse(history[start].observed_at) - Date.parse(history[start - 1].observed_at) <= 90 * 60000) start -= 1;
  return { hours: history.length - start, since: history[start].observed_at };
}

function clusters(stations) {
  const groups = [];
  const remaining = new Set(stations);
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const group = [first];
    for (let index = 0; index < group.length; index += 1) {
      for (const other of remaining) {
        if (haversineKm(group[index].lat, group[index].lon, other.lat, other.lon) <= 50) {
          remaining.delete(other);
          group.push(other);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function detect(db, settings, now = Date.now()) {
  const summary = { stations_evaluated: 0, warming: 0, unavailable: 0, departing_stations: 0, considered_stations: 0, duplicate_stations: 0, truncated_stations: 0, suppressed_events: 0, events_written: 0, events_escalated: 0 };
  const events = [];
  const states = [];
  const candidates = [];
  const historyQuery = db.prepare('SELECT * FROM cbrn_readings WHERE source = ? AND station_id = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at');
  for (const station of db.prepare('SELECT * FROM cbrn_stations ORDER BY source, station_id').all()) {
    summary.stations_evaluated += 1;
    const history = historyQuery.all(station.source, station.station_id, new Date(now - 30 * 86400000).toISOString(), new Date(now).toISOString());
    const latest = history[history.length - 1];
    if (!latest || now - Date.parse(latest.observed_at) > Math.min(settings.minutes, 180) * 60000 || !normal(latest)) { summary.unavailable += 1; continue; }
    const baseline = history.slice(0, -1).filter(normal);
    if (baseline.length < 48) { summary.warming += 1; continue; }
    const stats = robustStats(baseline.map((row) => row.value));
    const z = robustZ(latest.value, stats, Math.max(0.02, 0.05 * stats.median));
    const rise = latest.value - stats.median;
    const ratio = stats.median > 0 ? latest.value / stats.median : null;
    const departing = isDeparting(latest.value, stats.median);
    const series = `radiation:${station.source}:${station.station_id}`;
    const previous = readAlarmState(db, series, 'cusum');
    const adjacent = previous && Date.parse(latest.observed_at) - Date.parse(previous.observed_at) <= 90 * 60000;
    const s = previous?.observed_at === latest.observed_at ? previous.s : departing ? cusumStep(adjacent ? previous.s : 0, Math.max(0, z), 0.5) : 0;
    states.push({ series, method: 'cusum', state: { observed_at: latest.observed_at, s } });
    if (departing) candidates.push({ ...station, ...latest, stats, z, rise, ratio, cusum: s, run: departingRun(history, stats.median) });
  }
  summary.departing_stations = candidates.length;
  candidates.sort((a, b) => b.value - a.value || a.station_id.localeCompare(b.station_id));
  // Mirror copies and colocated instruments cannot inflate the denominator.
  const distinct = [];
  for (const station of candidates) {
    if (distinct.some((other) => other.station_id === station.station_id || haversineKm(other.lat, other.lon, station.lat, station.lon) < 1)) { summary.duplicate_stations += 1; continue; }
    if (distinct.length === 200) { summary.truncated_stations += 1; continue; }
    distinct.push(station);
  }
  summary.considered_stations = distinct.length;
  const eventDb = settings.eventsConnection;
  const recentPublic = eventDb ? eventDb.prepare("SELECT event_key FROM alert_events WHERE cohort = 'cbrn' AND kind = ? AND severity IN ('elevated','high','critical') AND julianday(COALESCE(json_extract(payload_json, '$.public_emitted_at'), created_at)) >= julianday(?)").all(KIND.RADIATION_ANOMALY, new Date(now - 6 * 3600000).toISOString()) : [];
  let budgetKey = recentPublic[0]?.event_key || null;
  const publicKeys = new Set(recentPublic.map((row) => row.event_key));
  const existingQuery = eventDb?.prepare('SELECT severity, COALESCE(json_extract(payload_json, \'$.public_emitted_at\'), created_at) AS public_at FROM alert_events WHERE event_key = ?');
  for (const group of clusters(distinct)) {
    const lat = group.reduce((sum, row) => sum + row.lat, 0) / group.length;
    const lon = group.reduce((sum, row) => sum + row.lon, 0) / group.length;
    const nearest = [...group].sort((a, b) => haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon))[0];
    const maxValue = Math.max(...group.map((row) => row.value));
    const baselineMedian = medianOf(group.map((row) => row.stats.median));
    const valueMedian = medianOf(group.map((row) => row.value));
    const ratios = group.map((row) => row.ratio);
    const ratioMedian = ratios.every(Number.isFinite) ? medianOf(ratios) : null;
    const riseMedian = medianOf(group.map((row) => row.rise));
    const strong = group.every((row) => row.z >= 5) && ratioMedian >= 3 && riseMedian >= 0.5;
    const sparse = group.every((row) => SPARSE_NETWORKS.has(row.source));
    const runHours = Math.max(...group.map((row) => row.run.hours));
    const coherent = strong && (sparse ? runHours >= 2 || group.length >= 2 : group.length >= 3 && new Set(group.map((row) => row.name).filter(Boolean)).size >= 2);
    let level = sparse
      ? (strong ? (coherent ? (maxValue >= 10 ? 5 : 4) : 3) : 1)
      : coherent ? (maxValue >= 10 || group.length >= 15 ? 5 : group.length >= 5 ? 4 : 3) : 1;
    const observedAt = group.map((row) => row.observed_at).sort().at(-1);
    // A sparse episode is keyed to its first hour, so the confirming hour raises the same event instead of opening a second one.
    const keyHour = sparse ? group.map((row) => row.run.since).sort()[0] : observedAt;
    const keyParts = [`${lat.toFixed(2)},${lon.toFixed(2)}`, 'radiation', keyHour.slice(0, 13)];
    const eventKey = [KIND.RADIATION_ANOMALY, ...keyParts].join(':');
    const existing = existingQuery?.get(eventKey);
    if (existing && RANK[existing.severity] >= 3) publicKeys.add(eventKey);
    let suppression = null;
    if (level >= 3 && budgetKey && !publicKeys.has(eventKey)) { suppression = `Public radiation budget: one new public event per six hours; ${budgetKey}`; level = 1; summary.suppressed_events += 1; }
    else if (level >= 3 && !(existing && RANK[existing.severity] >= 3)) { budgetKey = eventKey; publicKeys.add(eventKey); }
    let diameter = 0;
    for (const a of group) for (const b of group) diameter = Math.max(diameter, haversineKm(a.lat, a.lon, b.lat, b.lon));
    const networks = [...new Set(group.map((row) => row.source))].sort();
    const countries = [...new Set(group.map((row) => row.country).filter(Boolean))].sort();
    const where = group.length === 1 ? `The gamma monitor at ${nearest.name || nearest.station_id}${nearest.country ? `, ${nearest.country}` : ''} (${networks.join(', ')}) rose` : `${group.length} gamma monitors within ${Math.ceil(diameter)} km near ${nearest.name || nearest.station_id}${nearest.country ? `, ${nearest.country}` : ''} on ${networks.join(', ')} rose together`;
    const message = `${where}: median ${baselineMedian.toFixed(2)} -> ${valueMedian.toFixed(2)} uSv/h (${Number.isFinite(ratioMedian) ? ratioMedian.toFixed(1) : 'undefined'}x the 30-day median, +${riseMedian.toFixed(2)} uSv/h), observed within the last ${settings.minutes} minutes. Station threshold: (value >= 3x median and rise >= 0.5 uSv/h) or value >= 5 uSv/h.${sparse ? ` This network has one monitor per city, so no neighbour can confirm it: ${runHours >= 2 ? `the departure has now held for ${runHours} consecutive hourly readings` : 'a second consecutive hour is the confirmation, and it has not come yet'}. In 1.59 million monitor-hours since January 2025 no monitor on it met this threshold once; the highest hour recorded was 0.32 uSv/h.` : ''}${suppression ? ` ${suppression}.` : ''}`;
    const payload = { cluster_station_count: group.length, departing_station_count: candidates.length, centroid_lat: lat, centroid_lon: lon, max_value: maxValue, ratio_median: ratioMedian, absolute_rise: riseMedian, countries, station_names: group.slice(0, 5).map((row) => row.name), networks, source_family: 'radiation', window_minutes: settings.minutes, fusion_eligible: coherent, sparse_network: sparse, consecutive_hours: runHours, suppression };
    if (level >= 3) payload.public_emitted_at = existing && RANK[existing.severity] >= 3 ? existing.public_at : new Date(now).toISOString();
    events.push(buildCbrnEvent({ kind: KIND.RADIATION_ANOMALY, level, occurredAt: observedAt, title: `Gamma dose-rate departure near ${nearest.name || nearest.station_id}`, message, source: networks.join(', '), keyParts, payload }));
  }
  for (const run of db.prepare("SELECT * FROM cbrn_ingest_runs WHERE source IN ('de','eurdep','radnet') AND consecutive_failures >= 3").all()) {
    let detail;
    try { detail = JSON.parse(run.detail_json || '{}'); } catch { detail = {}; }
    const series = `network:${run.source}`;
    const previous = readAlarmState(db, series, 'outage');
    if (previous?.last_success_at === run.last_success_at) continue;
    events.push(buildCbrnEvent({ kind: KIND.RADIATION_NETWORK, level: 1, occurredAt: run.last_attempt_at, title: `${run.source} radiation network unavailable`, source: run.source, keyParts: [run.source, run.last_success_at || 'never'], payload: { ...detail, consecutive_failures: run.consecutive_failures, fusion_eligible: false }, message: `${run.source}: ${run.consecutive_failures} consecutive failed, partial-coverage or stale polls; ${run.last_error}. Station shortfall ${detail.shortfall ?? 'unknown'} of ${detail.roster ?? 'unknown'}; returned ${detail.returned_known ?? 'unknown'}. Threshold: >= 3 consecutive polls.` }));
    states.push({ series, method: 'outage', state: { last_success_at: run.last_success_at } });
  }
  return { summary, events, states };
}

function main() {
  const settings = options(process.argv.slice(2));
  const db = openCbrnDb({ dbPath: settings.db, readonly: settings.dryRun });
  let eventsDb;
  try {
    if (!settings.dryRun || fs.existsSync(settings.eventsDb)) {
      eventsDb = new Database(settings.eventsDb, { readonly: settings.dryRun });
      if (!settings.dryRun) eventsDb.exec(EVENTS_SCHEMA);
      settings.eventsConnection = eventsDb;
    }
    let result;
    const run = () => {
      result = detect(db, settings);
      if (settings.dryRun) { for (const event of result.events) console.log(JSON.stringify(event)); return; }
      const lookup = eventsDb.prepare('SELECT severity FROM alert_events WHERE event_key = ?');
      for (const event of result.events) {
        const existing = lookup.get(event.eventKey);
        if (existing && RANK[existing.severity] > RANK[event.severity]) continue;
        const saved = insertCbrnEvent(eventsDb, event);
        if (saved.inserted) result.summary.events_written += 1;
        if (saved.escalated) result.summary.events_escalated += 1;
      }
    };
    if (settings.dryRun) run();
    else {
      eventsDb.transaction(run).immediate();
      db.transaction(() => { for (const entry of result.states) writeAlarmState(db, entry.series, entry.method, entry.state); })();
    }
    console.log(JSON.stringify(result.summary));
  } finally { eventsDb?.close(); db.close(); }
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { options, detect, clusters };
