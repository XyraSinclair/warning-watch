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

// The alert record is the one read this page cannot do without: if it
// cannot be read, the status fails loudly rather than reading as no alerts.
function readAlerts(db) {
  if (!db) throw new Error("alert record unavailable");
  // A retracted alert was raised under a threshold the instrument has since
  // recalibrated. It stays in the record with its delivery state intact, and
  // leaves the public feed. The page speaks of the aircraft cohorts alone: the
  // CBRN layer left the site on 3 Nov 2026 (8f98934) and its 4,911 events stay
  // in the record as they were delivered and leave this payload here, not by
  // retraction, which would have the ntfy rail post a correction for each one
  // it carried.
  return db.prepare(
    `SELECT kind, severity, cohort, occurred_at AS occurredAt, title, message
       FROM alert_events
      WHERE ${PUBLIC_EVENT_SQL}
        AND cohort IN ('global_business_jet', 'global_military_aircraft', 'non_icao_untracked')
      ORDER BY occurred_at DESC, id DESC LIMIT ?`,
  ).all(MAX_ALERTS);
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

// The ADS-B Exchange archive the cohorts are sampled from, as the refresh pass last
// left it: the newest whole read, and the archive's answer when the last read failed.
// The page says why the cohort rows stop when it is the archive that stopped them.
function readArchive() {
  const empty = { lastReadAt: null, ageMinutes: null, lastAttemptAt: null, error: null };
  try {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "refresh-state.json"), "utf8"));
    return {
      lastReadAt: state.lastPollSuccessAt ?? null,
      ageMinutes: minutesSince(state.lastPollSuccessAt),
      lastAttemptAt: state.lastAttemptAt ?? null,
      error: state.lastPollError ?? null,
    };
  } catch {
    return empty;
  }
}

function getStatusSummary(mainDbPath) {
  const mainPath = mainDbPath || resolveDb("EWS_DB_PATH") || path.join(DATA_DIR, "ews-main.sqlite");
  const main = open(mainPath);
  try {
    return {
      generatedAt: new Date().toISOString(),
      alerts: readAlerts(main),
      aviation: readAviation(main),
      cohorts: readCohorts(),
      archive: readArchive(),
    };
  } finally {
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
