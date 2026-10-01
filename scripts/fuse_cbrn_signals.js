#!/usr/bin/env node

const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { KIND, openCbrnDb, haversineKm, readAlarmState, writeAlarmState, buildCbrnEvent, insertCbrnEvent } = require('./cbrn_lib');
const FAMILIES = new Map([
  [KIND.RADIATION_ANOMALY, 'radiation'],
  [KIND.AIRSPACE_VOID, 'aviation'], [KIND.AIRCRAFT_EMERGENCY, 'aviation'], [KIND.SPECIAL_AIRCRAFT, 'aviation'],
  [KIND.OFFICIAL_NOTICE, 'official'], [KIND.LEXICAL_BURST, 'lexical'],
]);

const AGREEMENT_MS = 90 * 60000;
const PUBLIC = new Set(['elevated', 'high', 'critical']);

function options(argv) {
  const result = { eventsDb: process.env.EWS_DB_PATH || path.resolve(__dirname, '../data/ews-main.sqlite'), db: process.env.EWS_CBRN_DB_PATH, windowMinutes: 720, dryRun: false };
  const names = { '--events-db': 'eventsDb', '--cbrn-db': 'db', '--window-minutes': 'windowMinutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  result.windowMinutes = Number(result.windowMinutes);
  if (!Number.isSafeInteger(result.windowMinutes) || result.windowMinutes < 1 || result.windowMinutes > 10080) throw new Error('--window-minutes must be an integer from 1 to 10080.');
  return result;
}

function detect(db, eventsDb, settings, now = Date.now()) {
  const regions = new Map(db.prepare('SELECT id, lat, lon FROM cbrn_regions').all().map((row) => [row.id, row]));
  const rows = eventsDb.prepare("SELECT * FROM alert_events WHERE cohort = 'cbrn' AND julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) <= julianday(?) ORDER BY occurred_at, event_key").all(new Date(now - settings.windowMinutes * 60000).toISOString(), new Date(now).toISOString());
  const candidates = [];
  for (const row of rows) {
    if (!FAMILIES.has(row.kind)) continue;
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (!payload || payload.fusion_eligible === false) continue;
    const region = typeof (payload.region_id ?? payload.region) === 'string' ? payload.region_id ?? payload.region : null;
    const known = regions.get(region);
    const lat = payload.lat ?? payload.centroid_lat ?? known?.lat;
    const lon = payload.lon ?? payload.centroid_lon ?? known?.lon;
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!region && !hasPoint) continue;
    candidates.push({ ...row, family: FAMILIES.get(row.kind), region, lat: hasPoint ? lat : null, lon: hasPoint ? lon : null });
  }
  // Agreement is place and time: two observations hours apart are two stories, not one.
  const near = (a, b) => (a.region && a.region === b.region) || (a.lat !== null && b.lat !== null && haversineKm(a.lat, a.lon, b.lat, b.lon) <= 150);
  const agrees = (a, b) => near(a, b) && Math.abs(Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) <= AGREEMENT_MS;
  // Complete linkage: a long chain of nearby reports cannot connect distant
  // events that do not themselves agree in place.
  const groups = new Map();
  const memberships = new Map(candidates.map((row) => [row, new Set()]));
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left];
      const b = candidates[right];
      if (a.kind === b.kind || a.family === b.family || !agrees(a, b)) continue;
      let covered = false;
      for (const key of memberships.get(a)) {
        if (memberships.get(b).has(key)) { covered = true; break; }
      }
      if (covered) continue;
      const group = [a, b];
      for (const other of candidates) {
        if (other !== a && other !== b && group.every((row) => agrees(row, other))) group.push(other);
      }
      const key = JSON.stringify(group.map((row) => row.event_key).sort());
      groups.set(key, group);
      for (const row of group) memberships.get(row).add(key);
    }
  }
  const events = [];
  const states = [];
  let agreements = 0;
  for (const group of groups.values()) {
    if (new Set(group.map((row) => row.kind)).size < 2 || new Set(group.map((row) => row.family)).size < 2) continue;
    agreements += 1;
    const keys = group.map((row) => row.event_key).sort();
    const groupKey = crypto.createHash('sha256').update(JSON.stringify(keys)).digest('hex');
    if (readAlarmState(db, `fusion:${groupKey}`, 'emitted')) continue;
    const points = group.filter((row) => row.lat !== null);
    const lat = points.length ? points.reduce((sum, row) => sum + row.lat, 0) / points.length : null;
    const lon = points.length ? points.reduce((sum, row) => sum + row.lon, 0) / points.length : null;
    const contributors = group.map((row) => ({ event_key: row.event_key, kind: row.kind, source_family: row.family, observed_at: row.occurred_at, distance_km: row.lat !== null && lat !== null ? haversineKm(lat, lon, row.lat, row.lon) : null }));
    const observedAt = group.map((row) => row.occurred_at).sort().at(-1);
    const region = group.every((row) => row.region === group[0].region) ? group[0].region : null;
    // Only an authority's own public-tier warning makes agreement critical; watch-level official context does not.
    const level = group.some((row) => row.kind === KIND.OFFICIAL_NOTICE && PUBLIC.has(row.severity)) ? 5 : 4;
    const message = `${contributors.length} observations ${region ? `in ${region}` : `near ${lat.toFixed(2)}, ${lon.toFixed(2)}`}: ${contributors.map((row) => `${row.kind} observed ${row.observed_at}, ${row.distance_km === null ? 'distance unavailable (same named region)' : `${row.distance_km.toFixed(1)} km from the group centroid`}`).join('; ')}. Threshold: >= 2 kinds from >= 2 source families within ${settings.windowMinutes} minutes; each pair shares a named region or is <= 150 km apart.`;
    const event = buildCbrnEvent({ kind: KIND.FUSED, level, occurredAt: observedAt, title: `${contributors.length} CBRN observations in one region`, message, source: [...new Set(group.map((row) => row.family))].sort().join(', '), keyParts: [groupKey], payload: { region, centroid_lat: lat, centroid_lon: lon, contributors, source_families: [...new Set(group.map((row) => row.family))].sort(), window_minutes: settings.windowMinutes, fusion_eligible: false } });
    events.push(event);
    states.push({ series: `fusion:${groupKey}`, method: 'emitted', state: { event_key: event.eventKey, contributing_event_keys: keys, occurred_at: observedAt } });
  }
  return { events, states, summary: { result: agreements ? 'agreement' : 'no agreement', agreements, events_written: 0, events_escalated: 0 } };
}

function main() {
  const settings = options(process.argv.slice(2));
  const db = openCbrnDb({ dbPath: settings.db, readonly: settings.dryRun });
  let eventsDb;
  try {
    eventsDb = new Database(settings.eventsDb, { readonly: settings.dryRun, fileMustExist: true });
    let result;
    const run = () => {
      result = detect(db, eventsDb, settings);
      if (settings.dryRun) { for (const event of result.events) console.log(JSON.stringify(event)); return; }
      for (const event of result.events) {
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
module.exports = { options, detect };
