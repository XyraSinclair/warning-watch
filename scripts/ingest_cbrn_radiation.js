#!/usr/bin/env node

const { openCbrnDb, readAlarmState, writeAlarmState, recordIngestRun, nowIso } = require('./cbrn_lib');
const USER_AGENT = 'Warning.watch/1.0 (https://warning.watch; CBRN public-source watch)';
const NETWORKS = { de: 'odlinfo_odl_1h_latest', eurdep: 'eurdep_latestValue', radnet: null };
// EPA RadNet: one CSV per monitor per month (about 75 KB at month end), hourly
// readings stamped in UTC, published 30-60 minutes after the hour. The service
// ignores Range and gzip, and the whole-year file is ten times the size, so a
// poll is 140 small requests, four at a time: about 10 MB, at most once an hour.
const RADNET_ROOT = 'https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv';
const RADNET_HEADER = 'LOCATION_NAME,SAMPLE COLLECTION TIME,DOSE EQUIVALENT RATE (nSv/h),';
const RADNET_MONITORS = require('../config/radnet-monitors.json').monitors;
const MIN_INTERVAL_FLOOR = { radnet: 60 };
// Live comparison: projected GeoJSON 567985 bytes / 44556 gzip, CSV
// 358921 bytes / 65671 gzip. Keep the smaller compressed, typed GeoJSON.
const PROPERTIES = 'id,name,value,unit,end_measure,site_status,site_status_text,validated,geom';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FEATURES = 30000;

function options(argv) {
  const result = { db: process.env.EWS_CBRN_DB_PATH, networks: ['de', 'eurdep', 'radnet'], minIntervalMinutes: 30, months: 1, force: false };
  const names = { '--db': 'db', '--networks': 'networks', '--min-interval-minutes': 'minIntervalMinutes', '--months': 'months' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') result.force = true;
    else if (arg === '--once') continue;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (typeof result.networks === 'string') result.networks = [...new Set(result.networks.split(','))];
  if (!result.networks.length || result.networks.some((name) => !Object.hasOwn(NETWORKS, name))) throw new Error('--networks must contain de, eurdep and/or radnet.');
  // RadNet serves history by month: --months 2 also reads last month, which is how a baseline is seeded.
  result.months = Number(result.months);
  if (!Number.isSafeInteger(result.months) || result.months < 1 || result.months > 3) throw new Error('--months must be 1, 2 or 3.');
  result.minIntervalMinutes = Number(result.minIntervalMinutes);
  if (!Number.isFinite(result.minIntervalMinutes) || result.minIntervalMinutes < 30) throw new Error('--min-interval-minutes must be at least 30.');
  return result;
}

async function fetchNetwork(network) {
  const url = new URL('https://www.imis.bfs.de/ogc/opendata/ows');
  url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeName: `opendata:${NETWORKS[network]}`, outputFormat: 'application/json', propertyName: PROPERTIES }).toString();
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`WFS HTTP ${response.status}`); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error(`WFS body exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length || data.features.length > MAX_FEATURES) throw new Error('Invalid, empty or oversized WFS FeatureCollection');
  return { data, bytes, contentEncoding: response.headers.get('content-encoding'), wireBytes: response.headers.get('content-length') };
}

function ingestCollection(db, network, result, now = Date.now()) {
  const roster = new Set(db.prepare('SELECT station_id FROM cbrn_stations WHERE source = ?').all(network).map((row) => row.station_id));
  const seen = new Map();
  const rows = [];
  const statuses = {};
  let newest = null;
  let invalidReadings = 0;
  for (const feature of result.data.features) {
    const p = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (feature?.type !== 'Feature' || !p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || feature.geometry?.type !== 'Point' || !Array.isArray(coordinates) || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('Malformed WFS station');
    // EURDEP repeats identical hourly values across five analysis-window labels.
    const signature = JSON.stringify([coordinates, p.name, p.value, p.unit, p.end_measure, p.site_status, p.site_status_text, p.validated]);
    if (seen.has(p.id)) {
      if (seen.get(p.id) !== signature) throw new Error(`Conflicting WFS copies for ${p.id}`);
      continue;
    }
    seen.set(p.id, signature);
    const quality = JSON.stringify({ site_status: p.site_status ?? null, site_status_text: p.site_status_text ?? null, validated: p.validated ?? null });
    const statusKey = JSON.stringify([p.site_status ?? null, p.site_status_text ?? null]);
    statuses[statusKey] = (statuses[statusKey] || 0) + 1;
    const time = typeof p.end_measure === 'string' ? Date.parse(p.end_measure) : NaN;
    const valid = Number.isFinite(time) && time <= now + 5 * 60000 && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= 0 && typeof p.unit === 'string' && p.unit.length > 0;
    if (!valid) invalidReadings += 1;
    const observedAt = valid ? new Date(time).toISOString().replace(/\.000Z$/, 'Z') : null;
    if (valid && (!newest || observedAt > newest)) newest = observedAt;
    rows.push({ id: p.id, name: p.name, lat: coordinates[1], lon: coordinates[0], country: /^[A-Z]{2}\d+/.test(p.id) ? p.id.slice(0, 2) : null, readings: observedAt ? [{ observedAt, value: p.value, unit: p.unit, quality }] : [] });
  }
  const returnedKnown = [...roster].filter((id) => seen.has(id)).length;
  const partial = roster.size > 0 && returnedKnown < 0.8 * roster.size;
  const stale = !newest || now - Date.parse(newest) > 3 * 3600000;
  const detail = { features: result.data.features.length, stations: rows.length, readings: rows.length - invalidReadings, invalid_readings: invalidReadings, roster: roster.size, returned_known: returnedKnown, shortfall: roster.size - returnedKnown, partial, stale, newest, bytes: result.bytes, content_encoding: result.contentEncoding, wire_bytes: result.wireBytes, statuses };
  return store(db, network, rows, detail);
}

// One RadNet monitor-month -> readings. A monitor that was offline all month
// answers 200 with the header alone: that is zero readings, not a failure.
async function fetchRadnetMonth(monitor, year, month) {
  const url = `${RADNET_ROOT}/${year}/${String(month).padStart(2, '0')}/fixed/${monitor.state}/${encodeURIComponent(monitor.city)}`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`RadNet HTTP ${response.status} for ${monitor.state}/${monitor.city}`); }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('RadNet body oversized');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines[0]?.startsWith(RADNET_HEADER) || !lines[0].endsWith(',STATUS')) throw new Error(`RadNet CSV header changed for ${monitor.state}/${monitor.city}`);
  const readings = [];
  let withoutDose = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const stamp = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(cells[1] || '');
    if (cells.length !== 12 || !stamp) throw new Error(`Malformed RadNet row for ${monitor.state}/${monitor.city}`);
    const nanosieverts = cells[2].trim() === '' ? NaN : Number(cells[2]);
    if (!Number.isFinite(nanosieverts) || nanosieverts < 0) { withoutDose += 1; continue; }
    const observedAt = `${stamp[3]}-${stamp[1]}-${stamp[2]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`;
    // Stored in the shared unit so one station threshold serves every network.
    readings.push({ observedAt, value: nanosieverts / 1000, unit: 'µSv/h', quality: JSON.stringify({ status: cells[11].trim() }) });
  }
  return { readings, withoutDose, bytes: text.length };
}

async function fetchRadnet(months, now = Date.now()) {
  const wanted = [];
  for (let back = 0; back < months; back += 1) {
    const date = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - back, 1));
    wanted.push([date.getUTCFullYear(), date.getUTCMonth() + 1]);
  }
  const results = new Array(RADNET_MONITORS.length);
  let next = 0;
  const worker = async () => {
    while (next < RADNET_MONITORS.length) {
      const index = next;
      next += 1;
      const monitor = RADNET_MONITORS[index];
      try {
        const parts = [];
        for (const [year, month] of wanted) parts.push(await fetchRadnetMonth(monitor, year, month));
        results[index] = { monitor, readings: parts.flatMap((part) => part.readings), withoutDose: parts.reduce((sum, part) => sum + part.withoutDose, 0), bytes: parts.reduce((sum, part) => sum + part.bytes, 0) };
      } catch (error) { results[index] = { monitor, error: error.message }; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return results;
}

function ingestRadnet(db, results, now = Date.now()) {
  const latestStored = new Map(db.prepare("SELECT station_id, MAX(observed_at) AS latest FROM cbrn_readings WHERE source = 'radnet' GROUP BY station_id").all().map((row) => [row.station_id, row.latest]));
  const failed = results.filter((entry) => entry.error);
  const rows = [];
  let newest = null;
  let offered = 0;
  for (const entry of results) {
    if (entry.error) continue;
    const id = `${entry.monitor.state}/${entry.monitor.city}`;
    const valid = entry.readings.filter((reading) => Date.parse(reading.observedAt) <= now + 5 * 60000);
    offered += valid.length;
    for (const reading of valid) if (!newest || reading.observedAt > newest) newest = reading.observedAt;
    // Re-write the last two days in case EPA revises an hour; older rows are already stored.
    const latest = latestStored.get(id);
    const since = latest ? new Date(Math.min(Date.parse(latest), now - 48 * 3600000)).toISOString() : '';
    const name = `${entry.monitor.city.replace(/\w\S*/g, (word) => word[0] + word.slice(1).toLowerCase())}, ${entry.monitor.state}`;
    rows.push({ id, name, lat: entry.monitor.lat, lon: entry.monitor.lon, country: 'US', readings: valid.filter((reading) => reading.observedAt >= since) });
  }
  const fresh = results.filter((entry) => !entry.error && entry.readings.some((reading) => now - Date.parse(reading.observedAt) <= 3 * 3600000)).length;
  const partial = failed.length > 0.2 * results.length;
  const stale = !newest || now - Date.parse(newest) > 3 * 3600000;
  const detail = { stations: results.length, answered: results.length - failed.length, failed: failed.length, first_error: failed[0]?.error ?? null, reporting_last_3h: fresh, readings_offered: offered, readings_written: rows.reduce((sum, row) => sum + row.readings.length, 0), hours_without_dose: results.reduce((sum, entry) => sum + (entry.withoutDose || 0), 0), roster: results.length, returned_known: results.length - failed.length, shortfall: failed.length, partial, stale, newest, bytes: results.reduce((sum, entry) => sum + (entry.bytes || 0), 0) };
  return store(db, 'radnet', rows, detail);
}

function store(db, network, rows, detail) {
  const { partial, stale } = detail;
  const at = nowIso();
  const station = db.prepare(`INSERT INTO cbrn_stations (source, station_id, name, lat, lon, country, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, station_id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, country=excluded.country, last_seen=excluded.last_seen`);
  const reading = db.prepare(`INSERT INTO cbrn_readings (source, station_id, observed_at, value, unit, quality, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, station_id, observed_at) DO UPDATE SET value=excluded.value, unit=excluded.unit, quality=excluded.quality, ingested_at=excluded.ingested_at`);
  db.transaction(() => {
    for (const row of rows) {
      station.run(network, row.id, row.name, row.lat, row.lon, row.country, at, at);
      for (const entry of row.readings) reading.run(network, row.id, entry.observedAt, entry.value, entry.unit, entry.quality, at);
    }
    recordIngestRun(db, { source: network, ok: !partial && !stale, error: partial || stale ? `partial=${partial}; shortfall=${detail.shortfall}/${detail.roster}; stale=${stale}` : null, detail });
  })();
  return { network, ok: !partial && !stale, ...detail };
}

async function main() {
  const settings = options(process.argv.slice(2));
  const db = openCbrnDb({ dbPath: settings.db });
  const results = [];
  try {
    for (const network of settings.networks) {
      const now = Date.now();
      const allowed = db.transaction(() => {
        const previous = readAlarmState(db, `ingest:${network}`, 'cadence');
        if (!settings.force && previous && now - Date.parse(previous.polled_at) < Math.max(settings.minIntervalMinutes, MIN_INTERVAL_FLOOR[network] || 0) * 60000) return false;
        writeAlarmState(db, `ingest:${network}`, 'cadence', { polled_at: new Date(now).toISOString() });
        return true;
      }).immediate();
      if (!allowed) { results.push({ network, skipped: 'cadence' }); continue; }
      try { results.push(network === 'radnet' ? ingestRadnet(db, await fetchRadnet(settings.months)) : ingestCollection(db, network, await fetchNetwork(network))); }
      catch (error) {
        const roster = db.prepare('SELECT COUNT(*) AS n FROM cbrn_stations WHERE source = ?').get(network).n;
        const detail = { roster, returned_known: 0, shortfall: roster, failed: true };
        recordIngestRun(db, { source: network, ok: false, error: error.message, detail });
        results.push({ network, ok: false, error: error.message, ...detail });
        process.exitCode = 1;
      }
    }
    console.log(JSON.stringify({ networks: results }));
  } finally { db.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, fetchNetwork, ingestCollection, fetchRadnet, ingestRadnet };
