#!/usr/bin/env node

const Database = require('better-sqlite3');
const { SEVERITY_RANK, UPSERT_STATUS_SQL } = require('../server/publication');
const { robustStats, medianOf, severityForLevel } = require('./detect_alert_events');

const MINUTE = 60000;
const SLOT = 30 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;
const HOURS_DDL = `CREATE TABLE IF NOT EXISTS flight_behaviour_hours (
  cohort TEXT NOT NULL, hour_start TEXT NOT NULL, turnarounds INTEGER NOT NULL,
  departing_aircraft INTEGER NOT NULL, origin_clusters INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort, hour_start)
);
CREATE TABLE IF NOT EXISTS flight_behaviour_hour_origins (
  cohort TEXT NOT NULL, hour_start TEXT NOT NULL, hex TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  PRIMARY KEY (cohort, hour_start, hex)
);`;
const SOURCE = 'adsbx_heatmap';
const radians = (degrees) => degrees * Math.PI / 180;
const round = (value, digits = 2) => Number(value.toFixed(digits));
const iso = (time) => new Date(time).toISOString();
const bucket = (time) => Math.floor(time / SLOT);

// The shared parser requires a snapshot and rejects this CLI's flags, so only
// its statistical and severity helpers are reusable here.
function parseArgs(argv) {
  const options = { cohort: 'global_business_jet', slots: 24, minutes: 60, dryRun: false, eventsDb: process.env.EWS_DB_PATH };
  const names = { '--db': 'db', '--events-db': 'eventsDb', '--cohort': 'cohort', '--slots': 'slots', '--minutes': 'minutes' };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') options.dryRun = true;
    else if (names[flag] && argv[index + 1] && !argv[index + 1].startsWith('--')) options[names[flag]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  for (const name of ['slots', 'minutes']) {
    options[name] = Number(options[name]);
    if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (!options.db || !options.eventsDb) throw new Error('Usage: detect_flight_behaviour.js --db <cohort db> --events-db <main db> [--cohort id] [--slots 24] [--minutes 60] [--dry-run]');
  return options;
}

function validPoint(point) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function distanceKm(a, b) {
  const dlat = radians(b.lat - a.lat);
  const dlon = radians(b.lon - a.lon);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function bearing(a, b) {
  const dlon = radians(b.lon - a.lon);
  return (Math.atan2(Math.sin(dlon) * Math.cos(radians(b.lat)), Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) - Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(dlon)) * 180 / Math.PI + 360) % 360;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += Math.cos(radians(point.lat)) * Math.cos(radians(point.lon));
    y += Math.cos(radians(point.lat)) * Math.sin(radians(point.lon));
    z += Math.sin(radians(point.lat));
  }
  return { lat: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI };
}

function components(points, radiusKm = 60) {
  const remaining = new Set(points.map((_, index) => index));
  const groups = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const group = [points[first]];
    for (let index = 0; index < group.length; index += 1) {
      for (const candidate of remaining) {
        if (distanceKm(group[index], points[candidate]) <= radiusKm) {
          group.push(points[candidate]);
          remaining.delete(candidate);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function upsert(db, event) {
  const existing = db.prepare('SELECT id, severity FROM alert_events WHERE event_key = @eventKey').get(event);
  if (existing) {
    const ranks = SEVERITY_RANK;
    if (ranks[existing.severity] > ranks[event.severity]) return 'unchanged';
    db.prepare(`UPDATE alert_events SET severity = @severity, title = @title,
      message = @message, payload_json = @payloadJson,
      status = ${UPSERT_STATUS_SQL}
      WHERE id = @id`).run({ ...event, id: existing.id });
    return ranks[event.severity] > ranks[existing.severity] ? 'escalated' : 'unchanged';
  }
  db.prepare(`INSERT INTO alert_events (kind, severity, cohort, event_key, occurred_at, title, message, payload_json, status)
    VALUES (@kind, @severity, @cohort, @eventKey, @occurredAt, @title, @message, @payloadJson, @status)`).run(event);
  return 'written';
}

function detect(db, options, eventsDb = null) {
  const summary = { detector: 'flight_behaviour', slots_examined: 0, aircraft_examined: 0, turnarounds: 0, clusters: 0, warming: 0, events_written: 0, events_escalated: 0, dry_run: options.dryRun, aggregate_writes: 0, aggregates_dry_run: options.dryRun };
  const events = [];
  const unavailable = (reason) => ({ events: [], summary: { ...summary, unavailable: options.cohort, reason } });
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!hasTable('ingest_slots')) return unavailable('No ingest provenance');
  const provenance = db.prepare('SELECT sampled_at, live_ingested FROM ingest_slots WHERE source = ? ORDER BY sampled_at').all(SOURCE);
  if (!provenance.length) return unavailable('No live-source ingest slots');
  const latest = Date.parse(provenance[provenance.length - 1].sampled_at);
  const liveSlots = new Set(provenance.filter((row) => row.live_ingested === 1).map((row) => bucket(Date.parse(row.sampled_at))));
  // Replay is anchored to the cohort's newest slot, not the wall clock. The
  // as_of field makes this explicit; an absent recent live slot still fails L0.
  summary.as_of = iso(latest);
  const covered = (end, duration) => {
    for (let time = end; time > end - duration; time -= SLOT) {
      if (!liveSlots.has(bucket(time))) return false;
    }
    return true;
  };
  if (!covered(latest, Math.max(options.minutes * MINUTE, 2 * SLOT))) return unavailable('Recent slots did not run the live path');
  const start = latest - 21 * DAY - options.minutes * MINUTE - 90 * MINUTE;
  const rows = db.prepare(`SELECT hex, registration, observed_at, lat, lon, altitude_ft, is_airborne
    FROM observations WHERE source = ? AND unixepoch(observed_at) >= ? ORDER BY unixepoch(observed_at), hex`).all(SOURCE, Math.floor(start / 1000));
  const archiveTimes = [...new Set(rows.map((row) => Date.parse(row.observed_at)))].sort((a, b) => a - b);
  const selected = archiveTimes.filter((time) => time <= latest).slice(-options.slots);
  if (!selected.length) return unavailable('No archived aircraft observations');
  if (bucket(selected[selected.length - 1]) !== bucket(latest)) return unavailable('Latest live slot has no aircraft observations');
  const selectedSet = new Set(selected);
  summary.slots_examined = selected.length;
  const reportStart = selected[0];
  let end = latest;
  if (hasTable('live_snapshot')) {
    const snapshot = db.prepare('SELECT hex, registration, observed_at, lat, lon, altitude_ft, is_airborne FROM live_snapshot WHERE source = ?').all(SOURCE);
    for (const row of snapshot) {
      const time = Date.parse(row.observed_at);
      if (time > latest && time - latest <= SLOT && liveSlots.has(bucket(latest))) {
        row.live = true;
        rows.push(row);
        end = Math.max(end, time);
      }
    }
  }
  summary.as_of = iso(end);
  const byAircraft = new Map();
  const examined = new Set();
  for (const row of rows) {
    row.time = Date.parse(row.observed_at);
    if (!Number.isFinite(row.time) || row.time > end || (!row.live && !liveSlots.has(bucket(row.time)))) continue;
    if (selectedSet.has(row.time) || row.live) examined.add(row.hex);
    if (!byAircraft.has(row.hex)) byAircraft.set(row.hex, []);
    byAircraft.get(row.hex).push(row);
  }
  summary.aircraft_examined = examined.size;
  const turns = [];
  const changes = [];
  const emit = (kind, level, key, time, title, message, payload) => events.push({ kind, severity: severityForLevel(level), cohort: options.cohort, eventKey: `${kind}:${options.cohort}:${key}`, occurredAt: iso(time), title, message, payloadJson: JSON.stringify({ level, ...payload }), status: 'pending' });
  for (const fixes of byAircraft.values()) {
    fixes.sort((a, b) => a.time - b.time);
    for (let index = 2; index < fixes.length; index += 1) {
      const [a, b, c] = fixes.slice(index - 2, index + 1);
      const adjacent = (left, right) => right.time > left.time && right.time - left.time <= SLOT && (right.live || bucket(right.time) - bucket(left.time) === 1);
      if (!adjacent(a, b) || !adjacent(b, c) || c.time - a.time > 90 * MINUTE) continue;
      if (![a, b, c].every((fix) => validPoint(fix) && fix.is_airborne === 1 && fix.altitude_ft >= 10000)) continue;
      const lengths = [distanceKm(a, b) / 1.852, distanceKm(b, c) / 1.852];
      if (lengths.some((length) => length < 20)) continue;
      // Compare tangents at the shared fix, avoiding a spurious turn caused by
      // meridian convergence on long/high-latitude great-circle segments.
      const incoming = (bearing(b, a) + 180) % 360;
      const outgoing = bearing(b, c);
      const change = Math.abs((outgoing - incoming + 540) % 360 - 180);
      if (c.time >= reportStart) changes.push(change);
      if (change < 120) continue;
      const turn = { hex: c.hex, registration: c.registration || b.registration || a.registration, time: c.time, lat: b.lat, lon: b.lon, bearing_before: round(incoming), bearing_after: round(outgoing), bearing_change: round(change), segment_nm: lengths.map((length) => round(length)), fixes: [a, b, c].map((fix) => ({ time: fix.observed_at, lat: round(fix.lat), lon: round(fix.lon), altitude_ft: fix.altitude_ft })), midpoint: Object.fromEntries(Object.entries(centroid([b, c])).map(([key, value]) => [key, round(value)])) };
      turns.push(turn);
      if (c.time < reportStart) continue;
      emit('flight_turnaround', 1, `${c.hex}:${iso(b.time)}`, c.time, `Aircraft turnaround: ${turn.registration || c.hex}`, `${turn.registration || c.hex}: ${b.observed_at} (${round(b.lat)}, ${round(b.lon)}), ${b.altitude_ft} ft to ${c.observed_at} (${round(c.lat)}, ${round(c.lon)}), ${c.altitude_ft} ft; track bearing changed ${round(change)} degrees (${round(incoming)} to ${round(outgoing)}). Threshold: bearing change >= 120 degrees across 3 fixes within 90 minutes, altitude >= 10000 ft, each segment >= 20 nm.`, turn);
    }
  }
  summary.turnarounds = events.length;
  changes.sort((a, b) => a - b);
  summary.bearing_changes = { count: changes.length, p50: changes.length ? round(medianOf(changes)) : null, p90: changes.length ? round(changes[Math.ceil(changes.length * 0.9) - 1]) : null, p99: changes.length ? round(changes[Math.ceil(changes.length * 0.99) - 1]) : null, max: changes.length ? round(changes[changes.length - 1]) : null };
  const windowMs = options.minutes * MINUTE;
  const recent = (items, time) => items.filter((item) => item.time > time - windowMs && item.time <= time);
  const uniqueAircraft = (items) => [...new Map(items.map((item) => [item.hex, item])).values()];
  const departures = db.prepare(`SELECT hex, registration, label, observed_at, lat, lon FROM takeoff_events
    WHERE cohort = ? AND source = ? AND unixepoch(observed_at) >= ? AND unixepoch(observed_at) <= ?`).all(options.cohort, SOURCE, Math.floor(start / 1000), Math.floor(end / 1000)).map((row) => ({ ...row, time: Date.parse(row.observed_at) })).filter((row) => validPoint(row) && liveSlots.has(bucket(row.time)));
  const observationSlots = new Set(archiveTimes.map(bucket));
  const hours = new Map();
  const origins = new Map();
  if (eventsDb && eventsDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'flight_behaviour_hours'").get()) {
    for (const row of eventsDb.prepare('SELECT * FROM flight_behaviour_hours WHERE cohort = ? AND hour_start >= ? AND hour_start < ?').all(options.cohort, iso(end - 22 * DAY), iso(end))) hours.set(row.hour_start, row);
    if (eventsDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'flight_behaviour_hour_origins'").get()) {
      for (const row of eventsDb.prepare('SELECT * FROM flight_behaviour_hour_origins WHERE cohort = ? AND hour_start >= ? AND hour_start < ?').all(options.cohort, iso(end - 22 * DAY), iso(end))) {
        if (!origins.has(row.hour_start)) origins.set(row.hour_start, []);
        origins.get(row.hour_start).push(row);
      }
    }
  }
  const aggregates = [];
  for (let time = Math.ceil((archiveTimes[0] + HOUR) / HOUR) * HOUR; time + HOUR <= latest; time += HOUR) {
    // Two precursor slots and both slots of the completed hour must survive
    // with live provenance. Missing coverage must never overwrite a real zero.
    let complete = true;
    for (let stamp = time - HOUR; stamp < time + HOUR; stamp += SLOT) {
      if (!liveSlots.has(bucket(stamp)) || !observationSlots.has(bucket(stamp))) complete = false;
    }
    if (!complete) continue;
    const inHour = (items) => items.filter((item) => item.time >= time && item.time < time + HOUR);
    const points = uniqueAircraft(inHour(departures));
    const row = { cohort: options.cohort, hour_start: iso(time), turnarounds: uniqueAircraft(inHour(turns)).length, departing_aircraft: points.length, origin_clusters: components(points).filter((group) => group.length >= 6).length };
    hours.set(row.hour_start, row);
    origins.set(row.hour_start, points);
    aggregates.push({ row, points });
  }
  summary.aggregate_hours_evaluated = aggregates.length;
  if (eventsDb && !options.dryRun) {
    eventsDb.exec(HOURS_DDL);
    const putHour = eventsDb.prepare(`INSERT INTO flight_behaviour_hours (cohort, hour_start, turnarounds, departing_aircraft, origin_clusters)
      VALUES (@cohort, @hour_start, @turnarounds, @departing_aircraft, @origin_clusters)
      ON CONFLICT (cohort, hour_start) DO UPDATE SET turnarounds = excluded.turnarounds,
      departing_aircraft = excluded.departing_aircraft, origin_clusters = excluded.origin_clusters`);
    const deleteOrigins = eventsDb.prepare('DELETE FROM flight_behaviour_hour_origins WHERE cohort = ? AND hour_start = ?');
    const putOrigin = eventsDb.prepare('INSERT INTO flight_behaviour_hour_origins (cohort, hour_start, hex, lat, lon) VALUES (?, ?, ?, ?, ?)');
    eventsDb.transaction(() => {
      for (const { row, points } of aggregates) {
        putHour.run(row);
        deleteOrigins.run(row.cohort, row.hour_start);
        for (const point of points) putOrigin.run(row.cohort, row.hour_start, point.hex, point.lat, point.lon);
      }
    })();
    summary.aggregate_writes = aggregates.length;
  }
  // Match the historical clock window, weighting the intersected durable
  // UTC-hour counts by overlap. This explicitly estimates sub-hour rates;
  // it never treats an absent hourly aggregate as zero.
  const historical = [];
  for (let day = 1; day <= 21; day += 1) {
    const until = end - day * DAY;
    const from = until - windowMs;
    const samples = [];
    for (let time = Math.floor(from / HOUR) * HOUR; time < until; time += HOUR) {
      const key = iso(time);
      if (!hours.has(key)) break;
      const points = origins.get(key) || [];
      samples.push({ row: hours.get(key), points, spatialCovered: points.length === hours.get(key).departing_aircraft, weight: (Math.min(until, time + HOUR) - Math.max(from, time)) / HOUR });
    }
    const expected = Math.ceil(until / HOUR) - Math.floor(from / HOUR);
    if (samples.length === expected) historical.push(samples);
  }
  const currentTurns = uniqueAircraft(recent(turns, end));
  const turnBaseline = robustStats(historical.map((samples) => samples.reduce((sum, sample) => sum + sample.row.turnarounds * sample.weight, 0)));
  // A cohort-wide count of turns is not a cluster. Three aircraft turning
  // anywhere on earth in the same hour is weather, scheduling and ordinary
  // flying; a cluster means turns in the same piece of sky, which is what a
  // shared diversion, closure or instruction actually looks like. Military
  // patrol and training patterns also turn far more often than business
  // aviation (p90 bearing change 154 degrees against 19), so that cohort
  // carries a higher floor.
  const turnFloor = options.cohort === 'global_military_aircraft' ? 5 : 3;
  const turnGroups = components(currentTurns.map((turn) => ({ lat: turn.midpoint.lat, lon: turn.midpoint.lon })), 200)
    .map((group) => group.length)
    .filter((count) => count >= turnFloor)
    .sort((a, b) => b - a);
  if (turnBaseline.sampleCount < 10) summary.warming += 1;
  else if (turnGroups.length && turnGroups[0] >= 3 * turnBaseline.median) {
    const count = turnGroups[0];
    const level = count >= 2 * turnFloor ? 4 : 3;
    emit('flight_turnaround_cluster', level, `${iso(Math.floor(end / (60 * MINUTE)) * 60 * MINUTE)}`, end, `${count} aircraft turned around`, `${count} distinct aircraft turned around in ${options.cohort} within ${options.minutes} minutes, linked by separations <= 200 km, vs a same-hour median of ${turnBaseline.median} across ${turnBaseline.sampleCount} previous days. Threshold: count >= ${turnFloor} and >= 3x median.`, { count, baseline_median: turnBaseline.median, baseline_samples: turnBaseline.sampleCount, radius_km: 200, window_minutes: options.minutes, aircraft: currentTurns.slice(0, 20).map((turn) => ({ hex: turn.hex, registration: turn.registration, bearing_change: turn.bearing_change, midpoint: turn.midpoint })) });
  }
  const departureHistory = historical.filter((samples) => samples.every((sample) => sample.spatialCovered));
  if (departureHistory.length < 10) summary.warming += 1;
  const currentDepartures = uniqueAircraft(recent(departures, end));
  for (const group of components(currentDepartures)) {
    if (group.length < 6) continue;
    // Freeze the current single-linkage footprint for every historical day.
    // Historical points must lie within 60 km of a current member; they cannot
    // chain outward and silently expand the baseline region.
    const baseline = robustStats(departureHistory.map((samples) => samples.reduce((sum, sample) => sum + sample.points.filter((point) => group.some((member) => distanceKm(point, member) <= 60)).length * sample.weight, 0)));
    if (baseline.sampleCount < 10 || baseline.median < 1 || group.length < 3 * baseline.median) continue;
    const center = centroid(group);
    const nearest = group.reduce((best, point) => distanceKm(point, center) < distanceKm(best, center) ? point : best);
    const place = `${nearest.label || nearest.registration || nearest.hex} (${round(center.lat, 1)}, ${round(center.lon, 1)})`;
    const level = group.length >= 2 * Math.max(6, 3 * baseline.median) ? 4 : 3;
    // A stable member and hour identify the episode, even when its centroid
    // shifts as more departures arrive. Reuse a same-hour overlapping event.
    const hour = iso(Math.floor(end / (60 * MINUTE)) * 60 * MINUTE);
    emit('takeoff_origin_cluster', level, `${hour}:${group.map((point) => point.hex).sort()[0]}`, end, `${group.length} departures near ${place}`, `${group.length} distinct aircraft departed near ${place} within ${options.minutes} minutes vs a same-hour median of ${baseline.median} over ${baseline.sampleCount} previous days. Threshold: count >= 6 and >= 3x median; departures linked by separations <= 60 km.`, { count: group.length, baseline_median: baseline.median, baseline_samples: baseline.sampleCount, window_minutes: options.minutes, radius_km: 60, centroid: { lat: round(center.lat, 1), lon: round(center.lon, 1) }, aircraft: group.map(({ hex, registration, lat, lon }) => ({ hex, registration, lat: round(lat), lon: round(lon) })) });
  }
  summary.clusters = events.filter((event) => event.kind !== 'flight_turnaround').length;
  return { events, summary };
}

function main() {
  const options = parseArgs(process.argv);
  const db = new Database(options.db, { readonly: true, fileMustExist: true });
  let eventsDb;
  try {
    eventsDb = new Database(options.eventsDb, { readonly: options.dryRun, fileMustExist: true });
    if (!options.dryRun) eventsDb.exec(HOURS_DDL);
    const { events, summary } = detect(db, options, eventsDb);
    if (options.dryRun) {
      for (const event of events) console.log(JSON.stringify({ ...event, payload: JSON.parse(event.payloadJson), payloadJson: undefined }));
    } else if (events.length) {
      eventsDb.transaction(() => {
        for (const event of events) {
          if (event.kind === 'takeoff_origin_cluster') {
            const payload = JSON.parse(event.payloadJson);
            const hour = event.eventKey.split(':').slice(2, 5).join(':');
            const existing = eventsDb.prepare('SELECT event_key, payload_json FROM alert_events WHERE kind = ? AND cohort = ? AND event_key LIKE ?').all(event.kind, event.cohort, `${event.kind}:${event.cohort}:${hour}%`);
            const ids = new Set(payload.aircraft.map((aircraft) => aircraft.hex));
            const match = existing.find((row) => JSON.parse(row.payload_json).aircraft.some((aircraft) => ids.has(aircraft.hex)));
            if (match) event.eventKey = match.event_key;
          }
          const result = upsert(eventsDb, event);
          if (result === 'written') summary.events_written += 1;
          if (result === 'escalated') summary.events_escalated += 1;
        }
      })();
    }
    console.log(JSON.stringify(summary));
  } finally {
    if (eventsDb) eventsDb.close();
    db.close();
  }
}

if (require.main === module) main();
module.exports = { detect, parseArgs, distanceKm, bearing };
