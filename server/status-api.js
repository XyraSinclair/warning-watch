const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { DATA_DIR } = require("./config");
const { PUBLIC_EVENT_SQL } = require("./publication");

// One read for the single public page: what the instruments are measuring right
// now, which baselines are armed, and every alert that has been raised. Public
// severities only — `watch` stays on the operator surface.
const MAX_ALERTS = 40;
const MIN_ARMING_SAMPLES = 10;

function resolveDb(envKey) {
  return process.env[envKey] ? path.resolve(process.env[envKey]) : null;
}

function open(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    return db;
  } catch {
    return null;
  }
}

function minutesSince(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 60000)) : null;
}

function readAlerts(db) {
  if (!db) return [];
  try {
    // A retracted alert was raised under a threshold the instrument has since
    // recalibrated. It stays in the record with its delivery state intact, and
    // leaves the public feed.
    return db.prepare(
      `SELECT kind, severity, cohort, occurred_at AS occurredAt, title, message
         FROM alert_events
        WHERE ${PUBLIC_EVENT_SQL}
        ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    ).all(MAX_ALERTS);
  } catch {
    return [];
  }
}

function readRadiation(db) {
  if (!db) return { networks: [], reporting: 0, stationsArmed: 0, stationsTotal: 0 };
  try {
    const networks = db.prepare(
      `SELECT source, COUNT(DISTINCT station_id) AS stations, MAX(observed_at) AS newestReading
         FROM cbrn_readings GROUP BY source ORDER BY source`,
    ).all().map((row) => ({
      source: row.source,
      stations: row.stations,
      newestReading: row.newestReading,
      ageMinutes: minutesSince(row.newestReading),
    }));
    // A station can only alert once it carries the minimum baseline itself.
    const armed = db.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM cbrn_readings GROUP BY source, station_id HAVING COUNT(*) >= 48)",
    ).get();
    return {
      networks,
      reporting: networks.filter((n) => n.ageMinutes != null && n.ageMinutes <= 240).length,
      stationsArmed: armed?.n ?? 0,
      stationsTotal: networks.reduce((sum, network) => sum + network.stations, 0),
    };
  } catch {
    return { networks: [], reporting: 0, stationsArmed: 0, stationsTotal: 0 };
  }
}

function readCbrnAircraft(db) {
  if (!db) return { regions: 0, newestSample: null, ageMinutes: null };
  try {
    const row = db.prepare("SELECT COUNT(DISTINCT region) AS regions, MAX(sampled_at) AS newestSample FROM cbrn_aircraft_slots").get();
    return { regions: row?.regions ?? 0, newestSample: row?.newestSample ?? null, ageMinutes: minutesSince(row?.newestSample) };
  } catch {
    return { regions: 0, newestSample: null, ageMinutes: null };
  }
}

// Course behaviour and departures live in the aviation cohort databases. The
// page asks only for counts and arming state, never aircraft or positions.
function readAviation(db) {
  const empty = {
    aircraft: { tracked: 0, newestFix: null, ageMinutes: null },
    behaviour: { turnarounds24h: 0, hoursRecorded: 0, hourlySamples: 0, armed: false, oldestHour: null },
    departures: { records: 0, days: 0, newest: null, ageMinutes: null },
  };
  if (!db) return empty;
  try {
    const fixes = db.prepare("SELECT COUNT(DISTINCT hex) AS tracked, MAX(observed_at) AS newestFix FROM observations").get();
    let behaviour = empty.behaviour;
    const hours = db.prepare("SELECT COUNT(*) AS hours, SUM(turnarounds) AS turns, MIN(hour_start) AS oldest, MAX(hour_start) AS newest FROM flight_behaviour_hours WHERE cohort = 'global_business_jet'").get();
    if (hours && hours.hours) {
      // Arming is per hour-of-day: the same-hour baseline needs ten days.
      const samples = db.prepare("SELECT COUNT(*) AS n FROM flight_behaviour_hours WHERE cohort = 'global_business_jet' AND hour_start >= datetime('now', '-21 day') GROUP BY strftime('%H', hour_start) ORDER BY n DESC LIMIT 1").get();
      const recent = db.prepare("SELECT COALESCE(SUM(turnarounds), 0) AS turns FROM flight_behaviour_hours WHERE cohort = 'global_business_jet' AND hour_start >= datetime('now', '-1 day')").get();
      behaviour = {
        turnarounds24h: recent?.turns ?? 0,
        hoursRecorded: hours.hours,
        hourlySamples: samples?.n ?? 0,
        armed: (samples?.n ?? 0) >= MIN_ARMING_SAMPLES,
        oldestHour: hours.oldest ?? null,
      };
    }
    const departures = db.prepare("SELECT COUNT(*) AS records, COUNT(DISTINCT substr(observed_at, 1, 10)) AS days, MAX(observed_at) AS newest FROM takeoff_events WHERE cohort = 'global_business_jet'").get();
    return {
      aircraft: { tracked: fixes?.tracked ?? 0, newestFix: fixes?.newestFix ?? null, ageMinutes: minutesSince(fixes?.newestFix) },
      behaviour,
      departures: {
        records: departures?.records ?? 0,
        days: departures?.days ?? 0,
        newest: departures?.newest ?? null,
        ageMinutes: minutesSince(departures?.newest),
      },
    };
  } catch {
    return empty;
  }
}

// The three aircraft cohorts, each its own database: how many airframes are on
// the roster and how many were airborne at the newest sample. Aircraft that
// broadcast no registered address have no roster; they are counted, not named.
const COHORTS = [
  ["business", "Business jets", "EWS_DB_PATH", "ews-main.sqlite"],
  ["military", "Military aircraft", "EWS_MILITARY_DB_PATH", "ews-military.sqlite"],
  ["unregistered", "Aircraft broadcasting no registered address", "EWS_UNTRACKED_DB_PATH", "ews-untracked.sqlite"],
];

function readCohorts() {
  return COHORTS.map(([key, label, envKey, file]) => {
    const db = open(resolveDb(envKey) || path.join(DATA_DIR, file));
    const empty = { key, label, roster: 0, airborne: null, sampledAt: null, ageMinutes: null, samples: 0 };
    if (!db) return empty;
    try {
      const roster = db.prepare("SELECT COUNT(*) AS n FROM tracked_aircraft").get();
      const latest = db.prepare("SELECT sampled_at AS sampledAt, concurrent_count AS airborne FROM concurrent_metrics ORDER BY sampled_at DESC LIMIT 1").get();
      const samples = db.prepare("SELECT COUNT(*) AS n FROM concurrent_metrics").get();
      return { key, label, roster: roster?.n ?? 0, airborne: latest?.airborne ?? null, sampledAt: latest?.sampledAt ?? null, ageMinutes: minutesSince(latest?.sampledAt), samples: samples?.n ?? 0 };
    } catch {
      return empty;
    } finally {
      db.close();
    }
  });
}

function getStatusSummary(mainDbPath) {
  const mainPath = mainDbPath || resolveDb("EWS_DB_PATH") || path.join(DATA_DIR, "ews-main.sqlite");
  const cbrnPath = resolveDb("EWS_CBRN_DB_PATH") || path.join(DATA_DIR, "ews-cbrn.sqlite");
  const cbrn = open(cbrnPath);
  const main = open(mainPath);
  try {
    return {
      generatedAt: new Date().toISOString(),
      alerts: readAlerts(main),
      radiation: readRadiation(cbrn),
      aircraft: readCbrnAircraft(cbrn),
      aviation: readAviation(main),
      cohorts: readCohorts(),
    };
  } finally {
    cbrn?.close();
    main?.close();
  }
}

function mountStatusRoutes(app, { getDbPath, getChannels } = {}) {
  app.get("/api/status", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    try {
      response.json({ ...getStatusSummary(typeof getDbPath === "function" ? getDbPath() : null), channels: getChannels() });
    } catch (error) {
      console.error("Status API failed:", error.code || error.name || "Error");
      response.status(500).json({ error: "Status could not be read." });
    }
  });
}

module.exports = { getStatusSummary, mountStatusRoutes };
