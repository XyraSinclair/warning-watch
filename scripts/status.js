#!/usr/bin/env node

// One-command health report. The re-entry tool: run `npm run status` after
// any absence to see exactly what state the system is in.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function dbReport(dbPath, label, freshnessTable) {
  if (!fs.existsSync(dbPath)) {
    return { label, missing: true };
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const latest = safe(() => db.prepare(`SELECT MAX(sampled_at) AS v FROM ${freshnessTable}`).get()?.v);
    const latestMs = latest ? Date.parse(latest) : null;
    const staleHours = latestMs ? +((Date.now() - latestMs) / 3600000).toFixed(1) : null;
    // Compare as epoch seconds, never as strings: stored timestamps are
    // ISO-'T' format while datetime('now') emits space-separated, and
    // lexicographic 'T' > ' ' silently widens the window by a day.
    const sampleCount7d = safe(() => db.prepare(
      `SELECT COUNT(DISTINCT sampled_at) AS c FROM ${freshnessTable}
       WHERE CAST(strftime('%s', sampled_at) AS INTEGER) >= CAST(strftime('%s', 'now') AS INTEGER) - 7 * 86400`
    ).get()?.c, 0);
    const sampleCount30d = safe(() => db.prepare(
      `SELECT COUNT(DISTINCT sampled_at) AS c FROM ${freshnessTable}
       WHERE CAST(strftime('%s', sampled_at) AS INTEGER) >= CAST(strftime('%s', 'now') AS INTEGER) - 30 * 86400`
    ).get()?.c, 0);
    const baselineReady = sampleCount7d >= 7 * 48 * 0.95; // tolerate a few missed slots

    // Data accountability: every expected 30-min slot is live, backfilled,
    // or missing — and the live instrument's age has its own bound,
    // distinct from row freshness (repair can heal rows without the live
    // ingester running).
    const hasProvenance = Boolean(safe(() =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_slots'").get()
    ));
    let provenance = null;
    if (hasProvenance) {
      const latestLive = safe(() =>
        db.prepare('SELECT MAX(sampled_at) AS v FROM ingest_slots WHERE live_ingested = 1').get()?.v
      );
      const latestLiveMs = latestLive ? Date.parse(latestLive) : null;
      const liveAgeMinutes = latestLiveMs ? Math.round((Date.now() - latestLiveMs) / 60000) : null;
      const liveSlots24h = safe(() => db.prepare(
        `SELECT COUNT(*) AS c FROM ingest_slots
         WHERE live_ingested = 1
           AND CAST(strftime('%s', sampled_at) AS INTEGER) >= CAST(strftime('%s', 'now') AS INTEGER) - 86400`
      ).get()?.c, 0);
      const firstLive = safe(() =>
        db.prepare('SELECT MIN(sampled_at) AS v FROM ingest_slots WHERE live_ingested = 1').get()?.v
      );
      const firstRow = safe(() => db.prepare(`SELECT MIN(sampled_at) AS v FROM ${freshnessTable}`).get()?.v);
      const windowStartMs = Math.max(
        firstRow ? Date.parse(firstRow) : Date.now(),
        Date.now() - 30 * 24 * 3600000,
      );
      const expectedSlots30d = latestMs && latestMs > windowStartMs
        ? Math.floor((latestMs - windowStartMs) / (30 * 60000)) + 1
        : 0;
      const missingSlots30d = Math.max(0, expectedSlots30d - sampleCount30d);
      provenance = {
        firstRowSample: firstRow,
        firstLiveSample: firstLive,
        latestLiveSample: latestLive,
        liveAgeMinutes,
        liveSlots24h,
        expectedSlots30d,
        missingSlots30d,
        completenessPct30d: expectedSlots30d
          ? Math.min(100, +((sampleCount30d / expectedSlots30d) * 100).toFixed(2))
          : null,
      };
    }
    return { label, latestSample: latest, staleHours, sampleCount7d, sampleCount30d, baselineReady, provenance };
  } finally {
    db.close();
  }
}

function launchdState(agent) {
  const output = safe(() => execFileSync('launchctl', ['print', `gui/${process.getuid()}/${agent}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), '');
  if (!output) return { agent, loaded: false };
  const running = /\bstate = running\b/.test(output);
  const lastExit = output.match(/last exit code = ([^\n]+)/)?.[1]?.trim() || null;
  return { agent, loaded: true, running, lastExit };
}

function systemctlQuery(args) {
  // is-active/is-enabled exit non-zero for inactive/failed/disabled units but
  // still print the state — capture stdout from the thrown error, or the
  // whole report reads "unknown" and failed oneshots become invisible.
  try {
    return execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const output = String(error.stdout || '').trim();
    return output || 'unknown';
  }
}

function systemdState(unit) {
  const active = systemctlQuery(['is-active', unit]);
  const enabled = systemctlQuery(['is-enabled', unit]);
  // Timers report as loaded when waiting; oneshot services as inactive between
  // runs — both count as loaded. "failed" is the state that matters.
  const loaded = active !== 'unknown' && enabled !== 'not-found';
  return { agent: unit, loaded, running: active === 'active', lastState: active, enabled };
}

function serviceStates() {
  if (process.platform === 'darwin') {
    return [
      launchdState('com.xyra.warning-watch.refresh'),
      launchdState('com.xyra.warning-watch.server'),
      launchdState('com.xyra.warning-watch.repair'),
    ];
  }
  return [
    systemdState('warning-watch.service'),
    systemdState('warning-watch-refresh.timer'),
    systemdState('warning-watch-refresh-imports.timer'),
    systemdState('warning-watch-repair.timer'),
    systemdState('warning-watch-watchdog.timer'),
    systemdState('warning-watch-backup.timer'),
    systemdState('cloudflared.service'),
    systemdState('ntfy.service'),
    systemdState('warning-watch-canary.timer'),
    systemdState('warning-watch-canary.service'),
    systemdState('warning-watch-selftest.timer'),
    systemdState('warning-watch-selftest.service'),
    systemdState('warning-watch-cbrn.timer'),
    systemdState('warning-watch-cbrn.service'),
  ];
}

function backupsReport() {
  const backupRoot = process.env.EWS_BACKUP_DIR
    ? path.resolve(process.env.EWS_BACKUP_DIR)
    : path.join(DATA_DIR, 'backups');
  const days = safe(() => fs.readdirSync(backupRoot).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry)).sort(), []);
  if (!days.length) return { latestDay: null, dayCount: 0 };
  const latestDay = days[days.length - 1];
  const files = safe(() => fs.readdirSync(path.join(backupRoot, latestDay)).filter((f) => f.endsWith('.sqlite')), []);
  const ageHours = +(((Date.now() - Date.parse(`${latestDay}T02:10:00Z`)) / 3600000).toFixed(1));
  return { latestDay, dayCount: days.length, latestFiles: files.length, ageHours };
}

function alertsReport() {
  const dbPath = path.join(DATA_DIR, 'ews-main.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const total = safe(() => db.prepare('SELECT COUNT(*) AS c FROM alert_events').get()?.c, 0);
    const last = safe(() => db.prepare('SELECT severity, title, occurred_at FROM alert_events ORDER BY id DESC LIMIT 1').get());
    const cursors = safe(() => Object.fromEntries(
      db.prepare("SELECT key, value FROM meta WHERE key IN ('local_push_last_alert_id', 'ntfy_last_alert_id')").all()
        .map((row) => [row.key, Number(row.value)])
    ), {});
    return { totalEvents: total, lastEvent: last || null, publisherCursors: cursors };
  } finally {
    db.close();
  }
}

function watchReport() {
  const filename = process.env.EWS_WATCH_DB_PATH || path.join(DATA_DIR, 'ews-watch.sqlite');
  if (!fs.existsSync(filename)) return { available: false, healthy: false, error: 'Watch database has not been initialized.' };
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const { getWatchSnapshot } = require('../server/watch-store');
    const snapshot = getWatchSnapshot(db, { internal: true, limit: 1 });
    const lastRunAgeMinutes = snapshot.run.lastFinishedAt
      ? Math.round((Date.now() - Date.parse(snapshot.run.lastFinishedAt)) / 60000) : null;
    const sourceProblems = snapshot.sources.filter((source) => source.enabled && source.health !== 'healthy')
      .map((source) => ({ id: source.id, health: source.health, error: source.lastError, recovery: source.recovery }));
    const services = process.platform === 'darwin' ? [] : [
      systemdState('warning-watch-sources.timer'), systemdState('warning-watch-sources.service'),
    ];
    return {
      available: true, ...snapshot.counts, run: snapshot.run, agent: snapshot.agent,
      budget: snapshot.budget, processing: snapshot.processing, lastRunAgeMinutes, sourceProblems, services,
      healthy: lastRunAgeMinutes != null && lastRunAgeMinutes <= 6 && !snapshot.run.lastError
        && snapshot.agent.configured && sourceProblems.length === 0
        && ['running', 'idle'].includes(snapshot.processing.state)
        && services.every((service) => service.loaded && service.lastState !== 'failed' && (!service.agent.endsWith('.timer') || (service.running && service.enabled === 'enabled'))),
    };
  } catch (error) {
    return { available: false, healthy: false, error: `Watch status could not be read: ${error.message}` };
  } finally {
    db.close();
  }
}

function cbrnReport() {
  const state = safe(() => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cbrn-refresh-state.json'), 'utf8')), null);
  const runAgeMinutes = state?.lastSuccessAt
    ? Math.round((Date.now() - Date.parse(state.lastSuccessAt)) / 60000) : null;
  const failedStages = state?.failedStages ?? [];
  const dbPath = process.env.EWS_CBRN_DB_PATH || path.join(DATA_DIR, 'ews-cbrn.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { available: false, healthy: false, runAgeMinutes, failedStages, error: 'CBRN database has not been initialized.' };
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const readings = safe(() => db.prepare(
      'SELECT source, COUNT(DISTINCT station_id) AS stations, MAX(observed_at) AS newestReading FROM cbrn_readings GROUP BY source ORDER BY source',
    ).all(), []);
    const ingest = safe(() => db.prepare(
      'SELECT source, last_success_at AS lastSuccessAt, last_error AS lastError, consecutive_failures AS consecutiveFailures FROM cbrn_ingest_runs ORDER BY source',
    ).all(), []);
    const ingestBySource = new Map(ingest.map((row) => [row.source, row]));
    const networks = readings.map((row) => ({ ...row, ...(ingestBySource.get(row.source) ?? {}) }));
    // A source that reports health but no readings (or readings but no health)
    // is itself a wiring defect, so surface both sets rather than intersecting.
    for (const row of ingest) {
      if (!readings.some((reading) => reading.source === row.source)) {
        networks.push({ source: row.source, stations: 0, newestReading: null, ...row });
      }
    }
    const aircraft = safe(() => db.prepare(
      'SELECT COUNT(DISTINCT region) AS regions, MAX(sampled_at) AS newestSample FROM cbrn_aircraft_slots',
    ).get(), {});
    const lexical = safe(() => db.prepare(
      'SELECT COUNT(*) AS buckets, MAX(bucket_start) AS newestBucket FROM cbrn_lexical_buckets',
    ).get(), {});
    const alerts24h = safe(() => {
      const mainPath = process.env.EWS_DB_PATH || path.join(DATA_DIR, 'ews-main.sqlite');
      if (!fs.existsSync(mainPath)) return null;
      const main = new Database(mainPath, { readonly: true, fileMustExist: true });
      try {
        return main.prepare(
          "SELECT severity, COUNT(*) AS count FROM alert_events WHERE cohort = 'cbrn' AND created_at >= datetime('now', '-1 day') GROUP BY severity",
        ).all();
      } finally {
        main.close();
      }
    }, null);
    const newestReadingAgeMinutes = (value) => (value ? Math.round((Date.now() - Date.parse(value)) / 60000) : null);
    const radiation = networks.map((network) => ({
      source: network.source,
      stations: network.stations ?? 0,
      newestReading: network.newestReading ?? null,
      readingAgeMinutes: newestReadingAgeMinutes(network.newestReading),
      consecutiveFailures: network.consecutiveFailures ?? 0,
      lastError: network.lastError ?? null,
    }));
    const reporting = radiation.filter((network) => network.stations > 0
      && network.readingAgeMinutes != null && network.readingAgeMinutes <= 240);
    return {
      available: true,
      runAgeMinutes,
      failedStages,
      lastError: state?.lastError ?? null,
      networks: radiation,
      reportingNetworks: reporting.length,
      aircraft: {
        regions: aircraft?.regions ?? 0,
        newestSample: aircraft?.newestSample ?? null,
        sampleAgeMinutes: newestReadingAgeMinutes(aircraft?.newestSample),
      },
      lexical: { buckets: lexical?.buckets ?? 0, newestBucket: lexical?.newestBucket ?? null },
      alerts24h,
      healthy: runAgeMinutes != null && runAgeMinutes <= 15
        && failedStages.length === 0
        && reporting.length > 0
        && radiation.every((network) => network.consecutiveFailures < 6),
    };
  } catch (error) {
    return { available: false, healthy: false, runAgeMinutes, failedStages, error: `CBRN status could not be read: ${error.message}` };
  } finally {
    db.close();
  }
}

const report = {
  polling: safe(() => {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'refresh-state.json'), 'utf8'));
    return {
      ...state,
      pollAgeMinutes: state.lastPollSuccessAt
        ? Math.round((Date.now() - Date.parse(state.lastPollSuccessAt)) / 60000)
        : null,
    };
  }),
  generatedAt: new Date().toISOString(),
  cohorts: [
    dbReport(path.join(DATA_DIR, 'ews-main.sqlite'), 'global_business_jet', 'concurrent_metrics'),
    dbReport(path.join(DATA_DIR, 'ews-military.sqlite'), 'global_military_aircraft', 'concurrent_metrics'),
    dbReport(path.join(DATA_DIR, 'ews-untracked.sqlite'), 'non_icao_untracked', 'non_icao_metrics'),
  ],
  services: serviceStates(),
  serverHttp: safe(() => {
    execFileSync('curl', ['-sf', '-o', '/dev/null', '--max-time', '5', 'http://127.0.0.1:3030/dashboard.json']);
    return 'ok';
  }, 'unreachable'),
  alerts: alertsReport(),
  watch: watchReport(),
  cbrn: cbrnReport(),
  backups: process.platform === 'darwin' ? null : backupsReport(),
  verdict: null,
};

// Instrument bounds (rationale table in OPERATIONS.md "Instrument bounds").
// Archive cadence remains 30 min despite two-minute availability polling.
// Keep the observation-age bound distinct from the scheduler's liveness.
const MAX_DATA_AGE_HOURS = 1.25;
const MAX_LIVE_AGE_MINUTES = 75;
const MIN_LIVE_SLOTS_24H = 42; // 48 expected; tolerate 6 missed live slots/day
const MIN_COMPLETENESS_PCT_30D = 98;

const problems = [];
if (!report.polling) {
  problems.push('poll status missing — check warning-watch-refresh.service');
} else {
  if (report.polling.lastError) problems.push(`refresh pipeline: ${report.polling.lastError}`);
  if (!Number.isFinite(report.polling.pollAgeMinutes) || report.polling.pollAgeMinutes > 10) {
    problems.push(`availability polling stale (${report.polling.pollAgeMinutes}m > 10m bound)`);
  }
}
for (const cohort of report.cohorts) {
  if (cohort.missing) { problems.push(`${cohort.label}: database missing`); continue; }
  if (cohort.staleHours === null || cohort.staleHours > MAX_DATA_AGE_HOURS) {
    problems.push(`${cohort.label}: history stale (${cohort.staleHours}h > ${MAX_DATA_AGE_HOURS}h bound) — run npm run repair:gaps`);
  }
  const provenance = cohort.provenance;
  if (provenance) {
    // Warm-up grace: liveness bounds apply once the live instrument has any
    // history (age) / a full day of history (coverage), so a fresh box or a
    // newly wired cohort does not page before it can possibly comply.
    const liveHistoryHours = provenance.firstLiveSample
      ? (Date.now() - Date.parse(provenance.firstLiveSample)) / 3600000
      : 0;
    const rowHistoryHours = provenance.firstRowSample
      ? (Date.now() - Date.parse(provenance.firstRowSample)) / 3600000
      : 0;
    if (provenance.liveAgeMinutes !== null && provenance.liveAgeMinutes > MAX_LIVE_AGE_MINUTES) {
      problems.push(`${cohort.label}: live ingestion stale (${provenance.liveAgeMinutes}m > ${MAX_LIVE_AGE_MINUTES}m bound) — check warning-watch-refresh.timer`);
    } else if (provenance.liveAgeMinutes === null && rowHistoryHours >= 24) {
      problems.push(`${cohort.label}: live provenance never recorded despite ${Math.round(rowHistoryHours)}h of rows — live ingestion is not writing ingest_slots`);
    }
    if (liveHistoryHours >= 24 && provenance.liveSlots24h < MIN_LIVE_SLOTS_24H) {
      problems.push(`${cohort.label}: only ${provenance.liveSlots24h}/48 live slots in 24h (bound ${MIN_LIVE_SLOTS_24H}) — live ingestion is skipping slots`);
    }
    if (provenance.completenessPct30d !== null && provenance.completenessPct30d < MIN_COMPLETENESS_PCT_30D) {
      problems.push(`${cohort.label}: 30d slot completeness ${provenance.completenessPct30d}% < ${MIN_COMPLETENESS_PCT_30D}% (${provenance.missingSlots30d} slots missing) — run npm run repair:gaps`);
    }
  }
}
for (const service of report.services) {
  if (!service.loaded) problems.push(`${service.agent}: not loaded — see OPERATIONS.md`);
  else if (service.lastState === 'failed') problems.push(`${service.agent}: failed — check journalctl -u ${service.agent}`);
}
if (report.serverHttp !== 'ok') problems.push('dashboard server unreachable on :3030');
if (report.cbrn) {
  // The CBRN instrument is not allowed to fail quietly: a stopped radiation
  // network is an observation gap, and an observation gap is a problem.
  if (!report.cbrn.available) {
    problems.push(`cbrn: ${report.cbrn.error ?? 'status unavailable'}`);
  } else {
    if (report.cbrn.runAgeMinutes == null || report.cbrn.runAgeMinutes > 15) {
      problems.push(`cbrn: refresh stale (${report.cbrn.runAgeMinutes}m > 15m bound) — check warning-watch-cbrn.timer`);
    }
    for (const stage of report.cbrn.failedStages ?? []) {
      problems.push(`cbrn stage ${stage.stage}: ${stage.error}`);
    }
    if (!report.cbrn.reportingNetworks) {
      problems.push('cbrn: no gamma network reported within 4h — the radiological instrument is blind');
    }
    for (const network of report.cbrn.networks ?? []) {
      if (network.consecutiveFailures >= 6) {
        problems.push(`cbrn network ${network.source}: ${network.consecutiveFailures} consecutive collection failures (${network.lastError ?? 'no detail'})`);
      }
    }
  }
}
if (report.backups) {
  if (!report.backups.dayCount) problems.push('no sqlite backups yet — run npm run backup');
  else if (report.backups.latestFiles < 5) problems.push(`latest backup day ${report.backups.latestDay} has ${report.backups.latestFiles}/5 databases`);
  else if (report.backups.ageHours > 50) problems.push(`sqlite backups stale (${report.backups.ageHours}h) — check warning-watch-backup.timer`);
}
report.verdict = problems.length ? { healthy: false, problems } : { healthy: true };

console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
