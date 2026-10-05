#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadEnvFile } = require('../server/env');
loadEnvFile();
if (process.env.EWS_WATCH_ENV_PATH) loadEnvFile(process.env.EWS_WATCH_ENV_PATH);
const { openCbrnDb, recordIngestRun } = require('./cbrn_lib');
const { SPECIAL_TYPES } = require('./detect_cbrn_airspace');

const ROOT = path.resolve(__dirname, '..');
const USER_AGENT = 'Warning.watch/1.0 (https://warning.watch; CBRN public-source watch)';
const MAX_BYTES = 2 * 1024 * 1024;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, eventsDb: process.env.EWS_DB_PATH, regions: path.join(ROOT, 'config/cbrn-regions.json'), sampleMinutes: 5, once: false };
  const names = { '--db': 'db', '--events-db': 'eventsDb', '--regions': 'regions', '--sample-minutes': 'sampleMinutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') result.once = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  result.sampleMinutes = Number(result.sampleMinutes);
  if (!Number.isSafeInteger(result.sampleMinutes) || result.sampleMinutes < 1 || result.sampleMinutes > 60) throw new Error('--sample-minutes must be an integer from 1 to 60.');
  return result;
}

function loadRegions(filename) {
  const { regions } = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(regions) || regions.length > 64) throw new Error('Regions must be an array of at most 64 entries.');
  const enabled = regions.filter((region) => region.enabled);
  const ids = new Set();
  for (const region of enabled) {
    if (!region.id || ids.has(region.id) || !region.name || !['target', 'control'].includes(region.role)
      || !['nuclear_site', 'fuel_cycle', 'chemical_industrial', 'population_center', 'control'].includes(region.kind)
      || (region.role === 'control') !== (region.kind === 'control')
      || !Number.isFinite(region.lat) || Math.abs(region.lat) > 90 || !Number.isFinite(region.lon) || Math.abs(region.lon) > 180
      || !Number.isSafeInteger(region.radius_nm) || region.radius_nm < 1 || region.radius_nm > 250) throw new Error('Invalid or duplicate region configuration.');
    ids.add(region.id);
  }
  const controls = enabled.filter((region) => region.role === 'control');
  if (controls.length !== 2 || !controls.some((region) => region.id === 'europe-central') || !controls.some((region) => region.id === 'us-central')) throw new Error('Both named feed-health controls must be enabled.');
  return enabled.sort((a, b) => Number(b.role === 'control') - Number(a.role === 'control'));
}

async function fetchCounts(region, sampleMinutes, signal) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`https://api.adsb.lol/v2/point/${region.lat}/${region.lon}/${region.radius_nm}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.any([signal, timeout]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Response exceeds 2 MiB bound');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!Array.isArray(data.ac) || data.ac.length > 20000 || !Number.isFinite(data.now) || Math.abs(Date.now() - data.now) > 120000) throw new Error('Missing, stale or malformed aircraft observation');
  const classes = {};
  const types = {};
  let emergency = 0;
  let military = 0;
  for (const aircraft of data.ac) {
    if (!aircraft || typeof aircraft !== 'object') throw new Error('Malformed aircraft entry');
    // Count an aircraft once even if its emergency field and squawk both match.
    if ((aircraft.emergency && String(aircraft.emergency).toLowerCase() !== 'none') || ['7500', '7600', '7700'].includes(String(aircraft.squawk))) emergency += 1;
    if ((Number(aircraft.dbFlags) & 1) || aircraft.mil === true) military += 1;
    const type = String(aircraft.t || '').toUpperCase();
    if (Object.hasOwn(SPECIAL_TYPES, type)) {
      const label = SPECIAL_TYPES[type];
      classes[label] = (classes[label] || 0) + 1;
      types[type] = (types[type] || 0) + 1;
    }
  }
  return { aircraft_count: data.ac.length, emergency_count: emergency, military_count: military, special_json: JSON.stringify({ sample_minutes: sampleMinutes, classes, types }) };
}

async function collect(db, regions, settings, signal) {
  const windowMs = settings.sampleMinutes * 60000;
  const sampledAt = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const detail = { sampled_at: sampledAt, sample_minutes: settings.sampleMinutes, regions: [] };
  const results = new Map();
  const errors = new Map();
  const startedAt = Date.now();
  let lastFinished = 0;
  const ask = async (region) => {
    try {
      // adsb.lol rate-limits dynamically. Measured 2026-09-11 from a stable
      // host: 1.2 s spacing was throttled (HTTP 429) after three requests,
      // while six-second spacing sustained a clean run. Pacing is against the
      // previous request's completion, so a slow response also counts.
      await sleep(Math.max(0, 6000 - (Date.now() - lastFinished)), undefined, { signal });
      results.set(region.id, await fetchCounts(region, settings.sampleMinutes, signal));
      errors.delete(region.id);
    } catch (error) {
      // Never retain upstream URLs or response text: they can contain coordinates.
      errors.set(region.id, error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[source URL]') : 'Fetch failed');
    } finally {
      lastFinished = Date.now();
    }
  };
  for (const region of regions) {
    await ask(region);
    if (signal.aborted) break;
  }
  // The limit bites late in a pass. Over 1379 passes to 5 Oct 2026 none of the
  // first three requests was refused, 6% of the sixteenth were, and 37% of
  // passes lost a region; the request after a refusal was itself refused 8%
  // of the time. So each failed region is asked once more at the same pacing,
  // controls first. No second ask starts after 120 s: a pass that slow is
  // waiting on timeouts, and the stage is killed at 210 s.
  detail.asked_again = 0;
  for (const region of regions.filter((entry) => errors.has(entry.id))) {
    if (signal.aborted || Date.now() - startedAt > 120000) break;
    await ask(region);
    detail.asked_again += 1;
  }
  for (const region of regions) {
    const counts = results.get(region.id);
    if (counts) detail.regions.push({ region: region.id, aircraft_count: counts.aircraft_count, emergency_count: counts.emergency_count, military_count: counts.military_count });
    else if (errors.has(region.id)) detail.regions.push({ region: region.id, unavailable: true, error: errors.get(region.id) });
  }
  const failedControls = regions.filter((region) => region.role === 'control' && !(results.get(region.id)?.aircraft_count > 0));
  const healthy = failedControls.length === 0 && !signal.aborted;
  detail.control_healthy = healthy;
  const failures = detail.regions.filter((region) => region.unavailable);
  const error = !healthy ? `Feed-health gate failed: ${failedControls.map((region) => `${region.id}: ${results.has(region.id) ? 'zero aircraft' : 'fetch unavailable'}`).join('; ')}${signal.aborted ? '; interrupted' : ''}` : failures.length ? `Regions unavailable: ${failures.map((region) => `${region.region}: ${region.error}`).join('; ')}` : null;
  db.transaction(() => {
    // Invalidate an earlier attempt at this same window before applying its replacement.
    const remove = db.prepare('DELETE FROM cbrn_aircraft_slots WHERE region = ? AND sampled_at = ?');
    const insert = db.prepare(`INSERT INTO cbrn_aircraft_slots (region, sampled_at, aircraft_count, emergency_count, military_count, special_json)
      VALUES (@region, @sampled_at, @aircraft_count, @emergency_count, @military_count, @special_json)
      ON CONFLICT(region, sampled_at) DO UPDATE SET aircraft_count = excluded.aircraft_count, emergency_count = excluded.emergency_count, military_count = excluded.military_count, special_json = excluded.special_json`);
    for (const region of regions) {
      const counts = results.get(region.id);
      if (counts && (healthy || region.role === 'control')) insert.run({ region: region.id, sampled_at: sampledAt, ...counts });
      else remove.run(region.id, sampledAt);
    }
    recordIngestRun(db, { source: 'adsb.lol', ok: healthy && failures.length === 0, error, detail });
  })();
  console.log(JSON.stringify({ source: 'adsb.lol', ...detail, error }));
}

async function main() {
  const settings = options(process.argv.slice(2));
  const regions = loadRegions(settings.regions);
  const db = openCbrnDb({ dbPath: settings.db });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    db.transaction(() => {
      db.prepare('UPDATE cbrn_regions SET enabled = 0').run();
      const save = db.prepare(`INSERT INTO cbrn_regions (id, name, lat, lon, radius_nm, kind, enabled) VALUES (@id, @name, @lat, @lon, @radius_nm, @kind, 1)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon, radius_nm = excluded.radius_nm, kind = excluded.kind, enabled = 1`);
      for (const region of regions) save.run(region);
    })();
    do {
      await collect(db, regions, settings, controller.signal);
      if (settings.once || controller.signal.aborted) break;
      const windowMs = settings.sampleMinutes * 60000;
      await sleep(windowMs - Date.now() % windowMs, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    db.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, loadRegions, fetchCounts, collect };
