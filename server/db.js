const fs = require("node:fs");
const Database = require("better-sqlite3");
const { DB_PATH, SCHEMA_PATH, ensureDirectories } = require("./config");

let database;
const AIRCRAFT_PATH_POINT_LIMIT = 6;

function initDb() {
  if (database) {
    return database;
  }

  ensureDirectories();
  database = new Database(DB_PATH);
  database.pragma("busy_timeout = 30000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  migrateSchema(database);

  return database;
}

function tableColumns(db, tableName) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!table) {
    return new Set();
  }

  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function migrateSchema(db) {
  const rollingMetricColumns = tableColumns(db, "rolling_metrics");
  if (rollingMetricColumns.size) {
    if (rollingMetricColumns.has("sampled_at") && rollingMetricColumns.has("concurrent_count")) {
      db.prepare(`
        INSERT OR IGNORE INTO concurrent_metrics (sampled_at, concurrent_count, created_at)
        SELECT sampled_at, concurrent_count, created_at
        FROM rolling_metrics
      `).run();
    }

    db.prepare("DROP TABLE rolling_metrics").run();
  }

  const dailyMetricColumns = tableColumns(db, "daily_metrics");
  if (dailyMetricColumns.has("peak_rolling_24h_count")) {
    db.exec(`
      ALTER TABLE daily_metrics RENAME TO daily_metrics_legacy_rolling;
      CREATE TABLE daily_metrics (
        day TEXT PRIMARY KEY,
        unique_airborne_count INTEGER NOT NULL,
        peak_concurrent_count INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR REPLACE INTO daily_metrics (
        day,
        unique_airborne_count,
        peak_concurrent_count,
        sample_count,
        created_at
      )
      SELECT
        day,
        unique_airborne_count,
        peak_concurrent_count,
        sample_count,
        created_at
      FROM daily_metrics_legacy_rolling;
      DROP TABLE daily_metrics_legacy_rolling;
    `);
  }

  db.prepare("DROP INDEX IF EXISTS idx_recent_history_activity_last_observed_at").run();
  db.prepare("DROP TABLE IF EXISTS recent_history_activity").run();

  const notificationSubscriberColumns = tableColumns(db, "notification_subscribers");
  const pushColumns = [
    ["push_enabled", "INTEGER NOT NULL DEFAULT 0"],
    ["push_endpoint_hash", "TEXT"],
    ["push_endpoint_cipher", "TEXT"],
    ["push_p256dh_cipher", "TEXT"],
    ["push_auth_cipher", "TEXT"],
    ["push_encoding", "TEXT"],
    ["push_user_agent_hash", "TEXT"],
    ["push_failure_count", "INTEGER NOT NULL DEFAULT 0"],
    ["push_last_success_at", "TEXT"],
    ["push_last_failure_at", "TEXT"],
    ["push_last_error", "TEXT"],
    ["push_expired_at", "TEXT"],
    ["push_opted_out_at", "TEXT"],
    ["push_opt_out_source", "TEXT"],
    // Double opt-in (2026-08): email/SMS alerts only go to confirmed contacts.
    ["email_confirmed_at", "TEXT"],
    ["phone_confirmed_at", "TEXT"],
    ["email_confirm_sent_at", "TEXT"],
    ["phone_confirm_sent_at", "TEXT"],
  ];
  for (const [columnName, columnDefinition] of pushColumns) {
    if (!notificationSubscriberColumns.has(columnName)) {
      db.prepare(`ALTER TABLE notification_subscribers ADD COLUMN ${columnName} ${columnDefinition}`).run();
    }
  }
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_subscribers_push_endpoint_hash ON notification_subscribers (push_endpoint_hash)").run();
  // The severity a delivery carried: an escalation is new news to someone who
  // heard the lower tier. NULL rows predate the column and count as current.
  if (!db.pragma('table_info(alert_deliveries)').some((column) => column.name === 'severity')) {
    db.prepare('ALTER TABLE alert_deliveries ADD COLUMN severity TEXT').run();
  }
}

function getDb() {
  return initDb();
}

function getMetaValue(key) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT value
      FROM meta
      WHERE key = ?
    `)
    .get(key);

  return row?.value ?? null;
}

function setMetaValue(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value
  `).run(key, String(value));
}

function upsertTrackedAircraft(entries) {
  if (!entries.length) {
    return;
  }

  const db = getDb();
  const statement = db.prepare(`
    INSERT INTO tracked_aircraft (hex, registration, label, source, notes)
    VALUES (@hex, @registration, @label, @source, @notes)
    ON CONFLICT(hex) DO UPDATE SET
      registration = excluded.registration,
      label = excluded.label,
      source = excluded.source,
      notes = excluded.notes
  `);

  const transaction = db.transaction((aircraftEntries) => {
    for (const entry of aircraftEntries) {
      statement.run(entry);
    }
  });

  transaction(entries);
}

function getTrackedAircraftEntries() {
  const db = getDb();
  return db
    .prepare(`
      SELECT hex, registration, label, source, notes
      FROM tracked_aircraft
      WHERE source != 'demo'
      ORDER BY hex ASC
    `)
    .all();
}

function getConcurrentCount(liveSource = null) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT COUNT(*) AS concurrent_count
      FROM live_snapshot
      WHERE is_airborne = 1
        AND source != 'demo'
        AND (? IS NULL OR source = ?)
    `)
    .get(liveSource, liveSource);

  return Number(row?.concurrent_count ?? 0);
}

function getLiveAircraftPathMap(db, hexes, liveSource = null) {
  if (!hexes.length) {
    return new Map();
  }

  const placeholders = hexes.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT
        hex,
        observed_at AS observedAt,
        lat,
        lon
      FROM (
        SELECT
          hex,
          observed_at,
          lat,
          lon,
          ROW_NUMBER() OVER (PARTITION BY hex ORDER BY observed_at DESC) AS path_rank
        FROM observations
        WHERE source != 'demo'
          AND (? IS NULL OR source = ?)
          AND hex IN (${placeholders})
          AND is_airborne = 1
          AND lat IS NOT NULL
          AND lon IS NOT NULL
      )
      WHERE path_rank <= ?
      ORDER BY hex ASC, observed_at ASC
    `)
    .all(liveSource, liveSource, ...hexes, AIRCRAFT_PATH_POINT_LIMIT);

  const pathsByHex = new Map();
  for (const row of rows) {
    const path = pathsByHex.get(row.hex) || [];
    path.push({
      observedAt: row.observedAt,
      lat: Number(row.lat),
      lon: Number(row.lon),
    });
    pathsByHex.set(row.hex, path);
  }

  return pathsByHex;
}

function parseOwnerOperator(notes) {
  const text = String(notes || "").trim();
  if (!text || !text.startsWith("{")) {
    return null;
  }
  const parsed = JSON.parse(text);
  return parsed.owner_operator || null;
}

function getLiveAircraft(liveSource = null) {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        live_snapshot.hex,
        live_snapshot.registration,
        COALESCE(live_snapshot.label, live_snapshot.registration, live_snapshot.hex) AS label,
        live_snapshot.observed_at,
        live_snapshot.lat,
        live_snapshot.lon,
        live_snapshot.altitude_ft AS altitudeFt,
        live_snapshot.ground_speed_kt AS groundSpeedKt,
        live_snapshot.track,
        live_snapshot.is_airborne AS isAirborne,
        tracked_aircraft.notes AS trackingNotes
      FROM live_snapshot
      LEFT JOIN tracked_aircraft
        ON tracked_aircraft.hex = live_snapshot.hex
      WHERE live_snapshot.is_airborne = 1
        AND live_snapshot.source != 'demo'
        AND (? IS NULL OR live_snapshot.source = ?)
        AND live_snapshot.lat IS NOT NULL
        AND live_snapshot.lon IS NOT NULL
      ORDER BY live_snapshot.observed_at DESC, label ASC
    `)
    .all(liveSource, liveSource);
  const pathsByHex = getLiveAircraftPathMap(
    db,
    rows.map((row) => row.hex),
    liveSource,
  );

  return rows.map((row) => ({
    ...row,
    track: row.track == null ? null : Number(row.track),
    isAirborne: Boolean(row.isAirborne),
    ownerOperator: parseOwnerOperator(row.trackingNotes),
    trackingNotes: undefined,
    path: pathsByHex.get(row.hex) || [],
  }));
}

function getRecentDailyMetrics(limit = 365) {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        day,
        unique_airborne_count AS uniqueAirborneCount,
        peak_concurrent_count AS peakConcurrentCount,
        sample_count AS sampleCount
      FROM daily_metrics
      ORDER BY day DESC
      LIMIT ?
    `)
    .all(limit)
    .reverse();
}

function getAllDailyMetrics() {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        day,
        unique_airborne_count AS uniqueAirborneCount,
        peak_concurrent_count AS peakConcurrentCount,
        sample_count AS sampleCount
      FROM daily_metrics
      ORDER BY day ASC
    `)
    .all();
}

function getRecentConcurrentMetrics(limit = 120) {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        concurrent_count AS concurrentCount
      FROM concurrent_metrics
      ORDER BY sampled_at DESC
      LIMIT ?
    `)
    .all(limit)
    .reverse();
}

function getAllConcurrentMetrics() {
  const db = getDb();
  return db
    .prepare(`
      SELECT
        sampled_at AS sampledAt,
        concurrent_count AS concurrentCount
      FROM concurrent_metrics
      ORDER BY sampled_at ASC
    `)
    .all();
}

function getTrackedAircraftCount() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT COUNT(*) AS tracked_count
      FROM tracked_aircraft
      WHERE source != 'demo'
    `)
    .get();

  return Number(row?.tracked_count ?? 0);
}

function getTrackingSummary() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS tracked_count,
        SUM(CASE WHEN source = 'faa_business_jet' THEN 1 ELSE 0 END) AS faa_count,
        SUM(CASE WHEN source = 'global_business_jet' THEN 1 ELSE 0 END) AS global_count,
        SUM(CASE WHEN source = 'global_military_aircraft' THEN 1 ELSE 0 END) AS global_military_count,
        SUM(CASE WHEN source = 'local_watchlist' THEN 1 ELSE 0 END) AS watchlist_count
      FROM tracked_aircraft
      WHERE source != 'demo'
    `)
    .get();
  const cohortSource = db.prepare("SELECT value FROM meta WHERE key = 'cohort_source'").get()?.value ?? null;
  const untrackedCount = Number(
    db.prepare("SELECT COUNT(*) AS sample_count FROM concurrent_metrics").get()?.sample_count ?? 0,
  );

  const trackedCount = Number(row?.tracked_count ?? 0);
  const faaCount = Number(row?.faa_count ?? 0);
  const globalCount = Number(row?.global_count ?? 0);
  const globalMilitaryCount = Number(row?.global_military_count ?? 0);
  const watchlistCount = Number(row?.watchlist_count ?? 0);

  if (!trackedCount) {
    if (cohortSource === "non_icao_untracked" && untrackedCount) {
      return {
        configured: true,
        trackedCount: null,
        faaCount: 0,
        globalCount: 0,
        globalMilitaryCount: 0,
        watchlistCount: 0,
        reason: null,
        source: "non_icao_untracked",
        sourceLabel: "ADS-B Exchange non-ICAO addresses",
        cohortType: "non_icao",
      };
    }

    return {
      configured: false,
      trackedCount: 0,
      reason: "No cohort loaded yet. Run `npm run import:faa` to build the private-jet set.",
    };
  }

  return {
    configured: true,
    trackedCount,
    faaCount,
    globalCount,
    globalMilitaryCount,
    watchlistCount,
    reason: null,
    source: globalMilitaryCount
      ? "global_military_aircraft"
      : globalCount
        ? "global_business_jet"
        : faaCount
          ? "faa_business_jet"
          : watchlistCount
            ? "local_watchlist"
            : cohortSource || "custom",
    sourceLabel: globalMilitaryCount
      ? "Global public metadata military flag"
      : globalCount
        ? "Global public metadata + FAA"
        : faaCount
          ? "FAA registry"
          : watchlistCount
            ? "Local watchlist"
            : "Custom",
    cohortType: globalMilitaryCount ? "military" : "business_jet",
  };
}

function areAllTrackedAircraftDemo() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS tracked_count,
        SUM(CASE WHEN source = 'demo' THEN 1 ELSE 0 END) AS demo_count
      FROM tracked_aircraft
    `)
    .get();

  const trackedCount = Number(row?.tracked_count ?? 0);
  const demoCount = Number(row?.demo_count ?? 0);
  return trackedCount > 0 && trackedCount === demoCount;
}

module.exports = {
  getDb,
  initDb,
  getMetaValue,
  setMetaValue,
  upsertTrackedAircraft,
  getTrackedAircraftEntries,
  getConcurrentCount,
  getLiveAircraft,
  getAllDailyMetrics,
  getRecentDailyMetrics,
  getAllConcurrentMetrics,
  getRecentConcurrentMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
};
