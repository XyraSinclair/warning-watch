#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const MAIN_DB = process.env.EWS_DB_PATH || path.join(DATA_DIR, 'ews-main.sqlite');
const MILITARY_DB = process.env.EWS_MILITARY_DB_PATH || path.join(DATA_DIR, 'ews-military.sqlite');
const UNTRACKED_DB = process.env.EWS_UNTRACKED_DB_PATH || path.join(DATA_DIR, 'ews-untracked.sqlite');
const RESEARCH_JSON = path.join(ROOT_DIR, 'localized_event_signal_research.json');
const SNAPSHOT_FILES = [
  { fileName: 'dashboard.json', dbPath: MAIN_DB, fallbackCohort: 'global_business_jet', label: 'Business jet cohort', freshnessTable: 'concurrent_metrics' },
  { fileName: 'military-dashboard.json', dbPath: MILITARY_DB, fallbackCohort: 'global_military_aircraft', label: 'Military aircraft cohort', freshnessTable: 'concurrent_metrics' },
  { fileName: 'untracked-dashboard.json', dbPath: UNTRACKED_DB, fallbackCohort: 'non_icao_untracked', label: 'Untracked aircraft cohort', freshnessTable: 'non_icao_metrics' },
];
const ALERT_SIGNAL_KINDS = new Set(['statistical_anomaly', 'takeoff_anomaly', 'takeoff_rate_anomaly']);


function parseJson(value, fallback = null) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function severityForLevel(level) {
  if (level >= 5) return 'critical';
  if (level >= 4) return 'high';
  if (level >= 3) return 'elevated';
  return 'watch';
}

function formatCohortLabel(snapshot, fallback) {
  return snapshot?.cohort?.sourceLabel || snapshot?.cohort?.source || fallback;
}

function latestSampledAt(dbPath, tableName) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Current signal source database is missing: ${dbPath}`);
  }
  if (!/^[a-z_]+$/i.test(tableName)) {
    throw new Error(`Unsafe freshness table name: ${tableName}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT MAX(sampled_at) AS latestSampledAt FROM ${tableName}`).get();
    return row?.latestSampledAt || null;
  } finally {
    db.close();
  }
}

function assertSnapshotFresh(snapshotPath, snapshot, dbPath, freshnessTable) {
  const current = snapshot.current || {};
  const composite = snapshot.signals?.composite || {};
  const observedAt = current.asOf || composite.asOf || snapshot.liveStatus?.latestSampledAt || null;
  if (!observedAt) {
    throw new Error(`Current signal snapshot has no observation timestamp: ${snapshotPath}`);
  }
  const latestSampledAtValue = latestSampledAt(dbPath, freshnessTable);
  if (!latestSampledAtValue) {
    throw new Error(`Current signal source database has no ${freshnessTable} rows: ${dbPath}`);
  }
  const observedMs = Date.parse(observedAt);
  const latestMs = Date.parse(latestSampledAtValue);
  if (!Number.isFinite(observedMs) || !Number.isFinite(latestMs)) {
    throw new Error(`Current signal freshness comparison has invalid timestamps: ${snapshotPath}`);
  }
  // Snapshot timestamps use raw heatmap slot stamps (…:29:50 / …:59:50) while
  // some cohorts round concurrent_metrics.sampled_at to the half hour, so exact
  // equality can never hold there. Tolerate one 30-minute slot of skew; anything
  // beyond that is genuine staleness and still fails hard.
  const SLOT_TOLERANCE_MS = 35 * 60 * 1000;
  if (Math.abs(observedMs - latestMs) > SLOT_TOLERANCE_MS) {
    throw new Error(`Current signal snapshot timestamp mismatch: ${snapshotPath} observes ${observedAt}, database latest is ${latestSampledAtValue}.`);
  }
  return observedAt;
}

function recordsFromCurrentSnapshots() {
  return SNAPSHOT_FILES.map(({ fileName, dbPath, fallbackCohort, label, freshnessTable }) => {
    const snapshotPath = path.join(PUBLISHED_DIR, fileName);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Current signal snapshot is missing: ${snapshotPath}`);
    }
    const snapshot = parseJson(fs.readFileSync(snapshotPath, 'utf8'), {});
    const current = snapshot.current || {};
    const composite = snapshot.signals?.composite || {};
    const observedAt = assertSnapshotFresh(snapshotPath, snapshot, dbPath, freshnessTable);
    const cohort = snapshot.cohort?.source || fallbackCohort;
    const emergencyLevel = Number(composite.emergencyLevel ?? current.emergencyLevel ?? 1);
    const actualConcurrentCount = Number(composite.actualConcurrentCount ?? current.concurrentCount ?? 0);
    const expectedConcurrentCount = Number(composite.expectedConcurrentCount ?? current.baselineMean ?? 0);
    const sigmaShift = Number(composite.sigmaShift ?? current.zScore ?? 0);
    return {
      id: `current:${cohort}`,
      source: 'current_dashboard_snapshot',
      event: `${formatCohortLabel(snapshot, label)} current anomaly monitor`,
      phase: 'current_concurrent_activity',
      signalFamily: 'concurrent_count',
      windowStart: observedAt,
      windowEnd: observedAt,
      timezone: 'UTC',
      label: current.alertLevel || null,
      classificationLabel: `Emergency level ${Number.isFinite(emergencyLevel) ? emergencyLevel : 1}`,
      severity: severityForLevel(Number.isFinite(emergencyLevel) ? emergencyLevel : 1),
      method: 'rolling_baseline_current_snapshot',
      primaryCluster: null,
      distanceMiles: null,
      peakResidual: Number.isFinite(sigmaShift) ? sigmaShift : null,
      observedAircraft: Number.isFinite(actualConcurrentCount) ? actualConcurrentCount : null,
      expectedAircraft: Number.isFinite(expectedConcurrentCount) ? expectedConcurrentCount : null,
      takeoffEvents: null,
      landingEvents: null,
      sampleAircraft: [],
      provenance: `${cohort}: current concurrent-count monitor vs rolling baseline.`,
      status: 'current',
      alertEventKey: null,
    };
  });
}

function formatCluster(cluster) {
  if (!cluster?.center) return null;
  return {
    lat: Number(cluster.center.lat),
    lon: Number(cluster.center.lon),
    delta: Number(cluster.total_delta || 0),
    currentCount: Number(cluster.current_count || 0),
    baselineMedianCount: Number(cluster.baseline_median_count || 0),
  };
}

function distanceForResult(result) {
  const distances = result.distances_miles || {};
  if (result.phase === 'arrival') {
    return distances.landing_endpoint_top ?? distances.landing_top ?? null;
  }
  if (String(result.phase || '').includes('departure')) {
    return distances.takeoff_endpoint_top ?? distances.takeoff_top ?? null;
  }
  return distances.presence_top ?? null;
}

function recordsFromResearch() {
  if (!fs.existsSync(RESEARCH_JSON)) return [];
  const payload = JSON.parse(fs.readFileSync(RESEARCH_JSON, 'utf8'));
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((result) => {
    const classificationLabel = result.classification?.label || 'Unclassified';
    return {
      id: `research:${result.key || result.event}:${result.phase}`,
      source: 'localized_event_signal_research',
      event: result.event,
      phase: result.phase,
      windowStart: result.local_start,
      windowEnd: result.local_end,
      timezone: result.timezone,
      label: classificationLabel,
      classificationLabel,
      severity: null,
      method: result.classification?.primary_cluster_method || null,
      primaryCluster: formatCluster(result.classification?.primary_cluster),
      distanceMiles: distanceForResult(result),
      peakResidual: result.current_global_residual?.peak_residual ?? null,
      observedAircraft: result.current_observed_aircraft ?? null,
      takeoffEvents: result.current_takeoff_events ?? null,
      landingEvents: result.current_landing_events ?? null,
      sampleAircraft: [],
      provenance: result.source_note || 'Localized event signal research.',
    };
  });
}

function recordsFromLiveAlerts(limit) {
  if (!fs.existsSync(MAIN_DB)) return [];
  const db = new Database(MAIN_DB, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(`
        SELECT id, kind, severity, cohort, event_key AS eventKey, occurred_at AS occurredAt, title, message, payload_json AS payloadJson, status
        FROM alert_events
        WHERE kind IN ('statistical_anomaly', 'takeoff_anomaly', 'takeoff_rate_anomaly')
          AND status <> 'observed'
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map((event) => {
        if (!ALERT_SIGNAL_KINDS.has(event.kind)) {
          throw new Error(`Unexpected live alert signal kind after SQL filtering: ${event.kind}`);
        }
        const payload = parseJson(event.payloadJson, {});
        const sampleAircraft = Array.isArray(payload.aircraft)
          ? payload.aircraft.filter(Boolean).map(String).slice(0, 10)
          : [];
        const signalFamily = payload.signalFamily || event.kind;
        return {
          id: `alert:${event.eventKey}`,
          source: 'live_alert_event',
          event: event.title,
          phase: event.kind,
          signalFamily,
          windowStart: payload.windowStart || event.occurredAt,
          windowEnd: payload.windowEnd || event.occurredAt,
          windowMinutes: payload.windowMinutes ?? null,
          timezone: 'UTC',
          label: null,
          classificationLabel: null,
          severity: event.severity,
          method: payload.model || 'refresh_pipeline_alert_event',
          primaryCluster: null,
          distanceMiles: null,
          peakResidual: payload.takeoffSurprise ?? payload.takeoffRateZScore ?? payload.zScore ?? null,
          observedAircraft: payload.concurrentCount ?? null,
          expectedAircraft: payload.expectedCount ?? null,
          observedTakeoffs: payload.takeoffCount ?? null,
          takeoffEvents: payload.takeoffCount ?? null,
          expectedTakeoffs: payload.expectedTakeoffCount ?? null,
          takeoffSurprise: payload.takeoffSurprise ?? null,
          takeoffRateZScore: payload.takeoffRateZScore ?? null,
          sampleCount: payload.sampleCount ?? null,
          landingEvents: null,
          sampleAircraft,
          provenance: `${event.cohort}: ${event.message}`,
          status: event.status,
          alertEventKey: event.eventKey,
        };
      });
  } finally {
    db.close();
  }
}

function main() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  const liveLimit = Math.min(Math.max(Number(process.env.EWS_EVENT_SIGNAL_LIVE_LIMIT) || 100, 1), 500);
  const records = [...recordsFromLiveAlerts(liveLimit), ...recordsFromCurrentSnapshots(), ...recordsFromResearch()];
  fs.writeFileSync(
    path.join(PUBLISHED_DIR, 'event-signals.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, records: records.length }));
}

main();
