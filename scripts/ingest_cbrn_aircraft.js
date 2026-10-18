#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadEnvFile } = require('../server/env');
loadEnvFile();
if (process.env.EWS_WATCH_ENV_PATH) loadEnvFile(process.env.EWS_WATCH_ENV_PATH);
const { openCbrnDb, recordIngestRun, stampIngestPass, readAlarmState, writeAlarmState, deadline, unanswered } = require('./cbrn_lib');
const { SPECIAL_TYPES } = require('./detect_cbrn_airspace');

const ROOT = path.resolve(__dirname, '..');
const USER_AGENT = 'Warning.watch/1.0 (https://warning.watch; CBRN public-source watch)';
const MAX_BYTES = 2 * 1024 * 1024;
const SPACING_MS = 6000;
const FETCH_TIMEOUT_MS = 15000;
// adsb.lol names its limits in the answer. On 18 Oct 2026 the headers read
// `x-ratelimit-limit: 500, 4;w=1, 60;w=60, 500;w=86400`: four requests a
// second, sixty a minute and five hundred a day for one address, the day
// anchored at 00:00 UTC (`x-ratelimit-reset: 16806` at 19:19:54 UTC). Sixteen
// regions every five minutes were 4,608 a day; the quota was spent at 18:45
// UTC, 2 h 35 min after the feed came back from an outage, and every request
// to midnight was refused. So the pass sweeps the regions once an hour, 384 a
// day, counts the day's requests itself and stops at the quota, honours a
// refusal that names the day's quota until the reset it names, and spends
// what is left only on asking a failed hour again.
const DAILY_QUOTA = 500;
const DAY_MS = 86_400_000;
const QUOTA_KEY = 'ingest:adsb.lol';
// cbrn_refresh.js kills this stage with SIGKILL at EWS_STAGE_KILL_AT, and a
// killed pass records nothing and stamps no end. A sweep of sixteen regions
// at six seconds of spacing and fifteen of timeout each can run 336 s, and on
// 18 Oct 2026, when adsb.lol timed out or refused for most of twelve hours,
// 27 passes were killed at 210 s: each read as a stage failure, two in a row
// as a stale refresh and a failed unit on the box and a stall at the off-box
// dead-man, so one feed outage paged under four names. Now every request ends
// this long before the kill, a region whose turn comes later is recorded
// unasked, and the pass is stamped, so a feed that will not answer costs one
// recorded failure, the page it is meant to be.
const STAGE_MARGIN_MS = 10_000;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, eventsDb: process.env.EWS_DB_PATH, regions: path.join(ROOT, 'config/cbrn-regions.json'), sampleMinutes: 60, once: false };
  // cbrn_refresh.js tells each stage when it will be killed; a run by hand has no such time.
  result.killAt = process.env.EWS_STAGE_KILL_AT === undefined ? Infinity : Number(process.env.EWS_STAGE_KILL_AT);
  if (Number.isNaN(result.killAt)) throw new Error('EWS_STAGE_KILL_AT must be epoch milliseconds.');
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

async function fetchCounts(region, sampleMinutes, signal, stage = null) {
  const response = await fetch(`https://api.adsb.lol/v2/point/${region.lat}/${region.lon}/${region.radius_nm}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.any([signal, deadline(FETCH_TIMEOUT_MS, stage)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status}`);
    // The refusal names the window it was refused under: no requests left and
    // a reset of hours is the day's quota, and the pass stops asking until the
    // reset; a reset of seconds is the per-second or per-minute window, an
    // ordinary refusal asked again at the end of the pass.
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (response.status === 429 && response.headers.get('x-ratelimit-remaining') === '0' && reset > 120) error.quotaSpentUntil = new Date(Date.now() + reset * 1000).toISOString();
    throw error;
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

// The day's requests, kept by the ingest because a healthy answer's headers
// name the window nearest to full, the per-second one, and not the day's.
function readQuota(db, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const state = readAlarmState(db, QUOTA_KEY, 'quota');
  return {
    day,
    requests: state?.day === day ? state.requests : 0,
    spentUntil: state?.spent_until && Date.parse(state.spent_until) > now ? state.spent_until : null,
  };
}

function writeQuota(db, quota) {
  writeAlarmState(db, QUOTA_KEY, 'quota', { day: quota.day, requests: quota.requests, spent_until: quota.spentUntil });
}

const nextMidnight = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString();
const spent = (quota) => `adsb.lol's daily quota is spent until ${quota.spentUntil.slice(11, 16)} UTC`;

async function collect(db, regions, settings, signal) {
  const windowMs = settings.sampleMinutes * 60000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const sampledAt = new Date(windowStart).toISOString();
  const quota = readQuota(db, now);
  // One sweep per window, in the first pass of the window. A window that did
  // not read whole is asked again at the next pass while the day's spare
  // allows: the quota less the requests sent and less a sweep for each window
  // still to start before midnight UTC, so a bad hour never spends the hours
  // after it. A pass that asks nothing still stamps its end for the dead-man.
  const swept = readAlarmState(db, QUOTA_KEY, 'cadence');
  if (swept?.sampled_at === sampledAt) {
    const windowsLeft = Math.max(0, Math.floor((Date.parse(nextMidnight(quota.day)) - windowStart) / windowMs) - 1);
    const spare = DAILY_QUOTA - quota.requests - regions.length * windowsLeft;
    if (swept.ok || spare < regions.length) {
      stampIngestPass(db, 'adsb.lol');
      console.log(JSON.stringify({ source: 'adsb.lol', sampled_at: sampledAt, sample_minutes: settings.sampleMinutes, skipped: swept.ok ? 'cadence' : 'spare', requests_today: quota.requests }));
      return;
    }
  }
  writeAlarmState(db, QUOTA_KEY, 'cadence', { sampled_at: sampledAt, ok: false });
  const detail = { sampled_at: sampledAt, sample_minutes: settings.sampleMinutes, regions: [] };
  const results = new Map();
  const errors = new Map();
  const deadlineAt = settings.killAt - STAGE_MARGIN_MS;
  const stage = Number.isFinite(deadlineAt) ? AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())) : null;
  let lastFinished = 0;
  const ask = async (region) => {
    let started = Date.now();
    try {
      if (quota.spentUntil) throw new Error(`unasked, ${spent(quota)}`);
      if (quota.requests >= DAILY_QUOTA) {
        quota.spentUntil = nextMidnight(quota.day);
        writeQuota(db, quota);
        throw new Error(`unasked, ${spent(quota)}`);
      }
      // Pacing is against the previous request's completion, so a slow
      // response also counts; six seconds kept adsb.lol's old limiter quiet
      // (2026-09-11: 1.2 s was refused after three requests) and is a tenth of
      // its published sixty a minute.
      const wait = Math.max(0, SPACING_MS - (Date.now() - lastFinished));
      if (Date.now() + wait >= deadlineAt) throw new Error('unasked at the stage deadline');
      await sleep(wait, undefined, { signal });
      started = Date.now();
      // Counted before it is sent: a request the kill interrupts still cost one.
      quota.requests += 1;
      writeQuota(db, quota);
      results.set(region.id, await fetchCounts(region, settings.sampleMinutes, signal, stage));
      errors.delete(region.id);
    } catch (error) {
      if (error.quotaSpentUntil) {
        quota.spentUntil = error.quotaSpentUntil;
        writeQuota(db, quota);
        errors.set(region.id, `HTTP 429, ${spent(quota)}`);
      } else {
        // Never retain upstream URLs or response text: they can contain coordinates.
        errors.set(region.id, error.name === 'TimeoutError' ? unanswered(started, stage) : error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[source URL]') : 'Fetch failed');
      }
    } finally {
      lastFinished = Date.now();
    }
  };
  for (const region of regions) {
    await ask(region);
    if (signal.aborted) break;
  }
  // adsb.lol's old limiter refused late in a pass: over 1379 passes to 5 Oct
  // 2026 none of the first three requests was refused, 6% of the sixteenth
  // were, and 37% of passes lost a region. Its published per-second and
  // per-minute windows should not bite at this spacing; a timeout still can.
  // So each failed region is asked once more at the same pacing, controls
  // first. A second ask starts only if its worst case, the spacing and a full
  // timeout, ends 30 s before the stage is killed: a kill loses the whole
  // sample, and the detectors after this stage take up to 12 s of the same
  // run. The first rule stopped at 120 s from the start of the pass, and a
  // sweep is 90 s of spacing alone, so one timeout or a slow feed spent it:
  // of 241 passes to 13:35 UTC on 6 Oct 2026, 18 of the 24 that lost a region
  // asked nothing again, all 19 timed-out regions among them, and six such
  // passes in a row paged.
  detail.asked_again = 0;
  for (const region of regions.filter((entry) => errors.has(entry.id))) {
    if (signal.aborted || quota.spentUntil || Date.now() + SPACING_MS + FETCH_TIMEOUT_MS + 30000 > settings.killAt) break;
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
  detail.requests_today = quota.requests;
  if (quota.spentUntil) detail.quota_spent_until = quota.spentUntil;
  const failures = detail.regions.filter((region) => region.unavailable);
  const error = !healthy ? `Feed-health gate failed: ${failedControls.map((region) => `${region.id}: ${results.has(region.id) ? 'zero aircraft' : (errors.get(region.id) ?? 'fetch unavailable')}`).join('; ')}${signal.aborted ? '; interrupted' : ''}` : failures.length ? `Regions unavailable: ${failures.map((region) => `${region.region}: ${region.error}`).join('; ')}` : null;
  db.transaction(() => {
    writeAlarmState(db, QUOTA_KEY, 'cadence', { sampled_at: sampledAt, ok: healthy && failures.length === 0 });
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
