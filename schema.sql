CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_aircraft (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aircraft_metadata (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  icao_type TEXT,
  manufacturer TEXT,
  model TEXT,
  owner_operator TEXT,
  short_type TEXT,
  year TEXT,
  military INTEGER NOT NULL DEFAULT 0,
  faa_pia INTEGER NOT NULL DEFAULT 0,
  faa_ladd INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  category_reason TEXT,
  sources_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aircraft_metadata_category
  ON aircraft_metadata (category);

CREATE INDEX IF NOT EXISTS idx_aircraft_metadata_icao_type
  ON aircraft_metadata (icao_type);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  hex TEXT NOT NULL,
  registration TEXT,
  source TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  is_airborne INTEGER NOT NULL DEFAULT 1,
  UNIQUE(hex, observed_at, source) ON CONFLICT IGNORE
);

CREATE INDEX IF NOT EXISTS idx_observations_observed_at
  ON observations (observed_at);

CREATE INDEX IF NOT EXISTS idx_observations_hex_time
  ON observations (hex, observed_at);

CREATE TABLE IF NOT EXISTS concurrent_metrics (
  sampled_at TEXT PRIMARY KEY,
  concurrent_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Slot provenance + data-quality denominators. One row per ingested 30-min
-- slot carrying two distinct facts:
--   source        - which process wrote the slot's concurrent count last
--                   (adsbx_heatmap = live snapshot, adsbx_history = trace
--                   backfill, seeded_live_day = retroactive liveness seed)
--   live_ingested - whether the live snapshot-transition process ran for
--                   this slot. Preserved when repair rewrites the count:
--                   the slot's live takeoff events remain valid samples.
-- The takeoff-rate model only baselines live_ingested slots; the L0 gate
-- uses total_aircraft (global feed volume, live path only).
CREATE TABLE IF NOT EXISTS ingest_slots (
  sampled_at TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  total_aircraft INTEGER,
  cohort_airborne INTEGER,
  live_ingested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT PRIMARY KEY,
  unique_airborne_count INTEGER NOT NULL,
  peak_concurrent_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS non_icao_activity (
  sampled_at TEXT NOT NULL,
  hex TEXT NOT NULL,
  message_type TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  airborne_observation_count INTEGER NOT NULL,
  first_lat REAL,
  first_lon REAL,
  last_lat REAL,
  last_lon REAL,
  min_altitude_ft REAL,
  max_altitude_ft REAL,
  max_ground_speed_kt REAL,
  flight TEXT,
  squawk TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sampled_at, hex, message_type, source)
);

CREATE INDEX IF NOT EXISTS idx_non_icao_activity_hex_time
  ON non_icao_activity (hex, sampled_at);

CREATE TABLE IF NOT EXISTS non_icao_metrics (
  sampled_at TEXT PRIMARY KEY,
  unique_hex_count INTEGER NOT NULL,
  airborne_unique_hex_count INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  airborne_observation_count INTEGER NOT NULL,
  message_type_counts_json TEXT NOT NULL,
  top_prefix_counts_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_snapshot (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  observed_at TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  track REAL,
  is_airborne INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS takeoff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort TEXT NOT NULL,
  hex TEXT NOT NULL,
  registration TEXT,
  label TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  previous_observed_at TEXT,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  track REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cohort, hex, observed_at, source) ON CONFLICT IGNORE
);

CREATE INDEX IF NOT EXISTS idx_takeoff_events_observed_at
  ON takeoff_events (observed_at);

CREATE INDEX IF NOT EXISTS idx_takeoff_events_cohort_time
  ON takeoff_events (cohort, observed_at);

CREATE TABLE IF NOT EXISTS alert_events (
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

-- The firing record: what left the box, per rail, per severity; append-only.
CREATE TABLE IF NOT EXISTS publications (
  event_id INTEGER NOT NULL REFERENCES alert_events(id),
  rail TEXT NOT NULL,
  severity TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, rail, severity)
);

CREATE INDEX IF NOT EXISTS idx_alert_events_status_created
  ON alert_events (status, created_at);

CREATE INDEX IF NOT EXISTS idx_alert_events_kind_time
  ON alert_events (kind, occurred_at);

CREATE TABLE IF NOT EXISTS notification_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'active',
  email_hash TEXT UNIQUE,
  phone_hash TEXT UNIQUE,
  email_cipher TEXT,
  phone_cipher TEXT,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  push_endpoint_hash TEXT UNIQUE,
  push_endpoint_cipher TEXT,
  push_p256dh_cipher TEXT,
  push_auth_cipher TEXT,
  push_encoding TEXT,
  push_user_agent_hash TEXT,
  push_failure_count INTEGER NOT NULL DEFAULT 0,
  push_last_success_at TEXT,
  push_last_failure_at TEXT,
  push_last_error TEXT,
  push_expired_at TEXT,
  push_opted_out_at TEXT,
  push_opt_out_source TEXT,
  email_confirmed_at TEXT,
  phone_confirmed_at TEXT,
  email_confirm_sent_at TEXT,
  phone_confirm_sent_at TEXT,
  source TEXT NOT NULL DEFAULT 'local_api',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_subscribers_status
  ON notification_subscribers (status);

CREATE INDEX IF NOT EXISTS idx_notification_subscribers_active_batch
  ON notification_subscribers (status, id);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_event_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  attempted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(alert_event_id, subscriber_id, channel) ON CONFLICT IGNORE,
  FOREIGN KEY(alert_event_id) REFERENCES alert_events(id),
  FOREIGN KEY(subscriber_id) REFERENCES notification_subscribers(id)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  details TEXT
);
