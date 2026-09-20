#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
const MAIN_DB = path.join(DATA_DIR, 'ews-main.sqlite');
const MILITARY_DB = path.join(DATA_DIR, 'ews-military.sqlite');
const UNTRACKED_DB = path.join(DATA_DIR, 'ews-untracked.sqlite');
const VENV_PYTHON = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.EWS_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');

const args = new Set(process.argv.slice(2));
const refreshImports = args.has('--refresh-imports');
const skipAlerts = args.has('--skip-alerts');

const RUN_TIMEOUT_MS = refreshImports ? 20 * 60_000 : 5 * 60_000;
const startedAt = Date.now();
const STATE_PATH = path.join(DATA_DIR, 'refresh-state.json');
let state = {};
let sampleKey = null;

function saveState() {
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, STATE_PATH);
}

function currentSamples() {
  return [MAIN_DB, MILITARY_DB, UNTRACKED_DB].map((dbPath) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare("SELECT value FROM meta WHERE key = 'adsbx_heatmap_sampled_at'").get()?.value ?? null;
    } finally {
      db.close();
    }
  });
}
function run(command, commandArgs, options = {}) {
  const remaining = RUN_TIMEOUT_MS - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error('Refresh pipeline deadline exceeded');
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    timeout: Math.min(remaining, options.timeout ?? (refreshImports ? RUN_TIMEOUT_MS : 90_000)),
    killSignal: 'SIGKILL',
    env: { ...process.env, ...options.env },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with status ${result.status}`);
  }
  if (options.capture) {
    process.stdout.write(result.stdout);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  }
}

function trackedAircraftCount(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return 0;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    return db
      .prepare('SELECT hex FROM tracked_aircraft')
      .all()
      .filter((row) => /^[0-9a-f]{6}$/i.test(row.hex)).length;
  } finally {
    db.close();
  }
}

function purgeDemoTrackedAircraft(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return;
  }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  try {
    db.prepare("DELETE FROM tracked_aircraft WHERE source = 'demo'").run();
  } finally {
    db.close();
  }
}

function ensureMainCohort() {
  if (!refreshImports && trackedAircraftCount(MAIN_DB) > 0) {
    return;
  }

  run(PYTHON_BIN, ['scripts/import_faa_cohort.py', '--db', MAIN_DB]);
  run(PYTHON_BIN, ['scripts/import_global_cohort.py', '--db', MAIN_DB, ...(refreshImports ? ['--refresh'] : [])]);
}

function ensureMilitaryCohort() {
  if (!refreshImports && trackedAircraftCount(MILITARY_DB) > 0) {
    return;
  }

  run(PYTHON_BIN, [
    'scripts/import_global_cohort.py',
    '--db',
    MILITARY_DB,
    '--tracked-category',
    'military',
    '--tracked-source',
    'global_military_aircraft',
    ...(refreshImports ? ['--refresh'] : []),
  ]);
}

function refreshLiveData() {
  purgeDemoTrackedAircraft(MAIN_DB);
  purgeDemoTrackedAircraft(MILITARY_DB);
  purgeDemoTrackedAircraft(UNTRACKED_DB);
  const selected = run(PYTHON_BIN, [
    'scripts/update_latest_heatmap.py', '--db', MAIN_DB, '--additional-db', MILITARY_DB,
  ], { capture: true });
  run(PYTHON_BIN, [
    'scripts/track_non_icao_hex.py',
    '--db',
    UNTRACKED_DB,
    '--latest-live',
    '--selected-cache-path', selected.cachePath,
    '--selected-slot-key', selected.latestSlotKey,
    '--cache-dir',
    path.join(DATA_DIR, 'cache', 'adsbx_live'),
    '--replace-live-snapshot',
  ]);
}

function exportSnapshots() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    MAIN_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'dashboard.json'),
    '--endpoint',
    'main',
    '--cohort',
    'global_business_jet',
  ]);
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    MILITARY_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'military-dashboard.json'),
    '--endpoint',
    'military',
    '--cohort',
    'global_military_aircraft',
  ]);
  run('node', [
    'scripts/export_dashboard_snapshot.js',
    '--db',
    UNTRACKED_DB,
    '--output',
    path.join(PUBLISHED_DIR, 'untracked-dashboard.json'),
    '--endpoint',
    'untracked',
    '--cohort',
    'non_icao_untracked',
  ]);
}

function detectAlertEvents() {
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    MAIN_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'dashboard.json'),
    '--events-db',
    MAIN_DB,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-rate-min-count',
    '3',
  ]);
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    MILITARY_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'military-dashboard.json'),
    '--cohort',
    'global_military_aircraft',
    '--events-db',
    MAIN_DB,
    '--takeoff-batch-min',
    '4',
    '--takeoff-rate-min-count',
    '4',
  ]);
  run('node', [
    'scripts/detect_alert_events.js',
    '--db',
    UNTRACKED_DB,
    '--snapshot',
    path.join(PUBLISHED_DIR, 'untracked-dashboard.json'),
    '--cohort',
    'non_icao_untracked',
    '--events-db',
    MAIN_DB,
    '--takeoff-batch-min',
    '10',
    '--takeoff-rate-min-count',
    '10',
  ]);
}

// Course behaviour is a separate instrument from the volume detector: it asks
// what tracked aircraft did in the air, not how many were up. It reads the
// 30-minute per-aircraft fix series the same ingestion already stores, so it
// adds no collection load. Run per cohort; a failure stays isolated so a
// behaviour-detector fault cannot stop the calibrated volume instrument.
function detectFlightBehaviour() {
  for (const [dbPath, cohort] of [
    [MAIN_DB, 'global_business_jet'],
    [MILITARY_DB, 'global_military_aircraft'],
  ]) {
    run('node', [
      'scripts/detect_flight_behaviour.js',
      '--db',
      dbPath,
      '--events-db',
      MAIN_DB,
      '--cohort',
      cohort,
    ]);
  }
}
// Runs after every signal producer and before any delivery: an uncorroborated
// top-tier claim is reported one step lower, in the same pass, so it never
// reaches a subscriber as a critical.
function enforceSignalCorroboration() {
  run('node', ['scripts/enforce_signal_corroboration.js', '--db', MAIN_DB]);
}
// Alert channels are independent, cursored, and retry-safe: one channel
// failing must not stop the others (or the feed exports downstream). Failed
// stages are collected and the run still exits nonzero at the end so the
// failure stays visible to systemd, while the broken channel's cursor holds
// and retries on the next pass.
const stageFailures = [];

function runStage(label, callback) {
  try {
    callback();
    return true;
  } catch (error) {
    stageFailures.push({ label, message: String(error && error.message ? error.message : error) });
    console.error(`Stage failed (continuing): ${label}: ${error}`);
    return false;
  }
}

function updateAlerts() {
  if (skipAlerts) {
    return;
  }

  state.completedChannels ||= {};
  for (const [label, script] of [['rss', 'update_rss_feed.js'], ['telegram', 'send_telegram_alert.js']]) {
    if (!refreshImports && state.completedChannels[label] === sampleKey) continue;
    if (runStage(label, () => run('node', [`scripts/${script}`], { env: { EWS_DB_PATH: MAIN_DB } }))) {
      state.completedChannels[label] = sampleKey;
      saveState();
    }
  }
  runStage('dispatch', () => run('node', ['scripts/dispatch_alert_events.js', '--db', MAIN_DB]));
  runStage('bridge', () => run('node', ['scripts/bridge_alert_events.js', '--db', MAIN_DB]));
  runStage('local-push', () => run('node', ['scripts/notify_local_push.js', '--db', MAIN_DB]));
  runStage('ntfy', () => run('node', ['scripts/publish_ntfy_alert.js', '--db', MAIN_DB]));
}

function exportOperationsFeed() {
  run('node', ['scripts/export_operations_feed.js'], {
    env: {
      EWS_DB_PATH: MAIN_DB,
      EWS_MILITARY_DB_PATH: MILITARY_DB,
      EWS_UNTRACKED_DB_PATH: UNTRACKED_DB,
    },
  });
}

function exportEventSignalsFeed() {
  run('node', ['scripts/export_event_signals_feed.js'], {
    env: {
      EWS_DB_PATH: MAIN_DB,
    },
  });
}



const LOCK_PATH = path.join(ROOT_DIR, 'tmp', 'refresh.flock');

function acquireRefreshLock() {
  if (args.has('--lock-held')) return true;
  // The OS releases flock on every exit, including SIGKILL. PID/age locks
  // can overlap a slow live owner or wedge after a crash. Carry the lock
  // descriptor through exec, so normal and metadata refreshes share it.
  const result = spawnSync(PYTHON_BIN, ['-c', [
    'import fcntl, os, signal, sys',
    'def lock_timeout(*_):',
    '    raise TimeoutError("Metadata refresh waited 310 seconds for the refresh lock")',
    'waiting = "--refresh-imports" in sys.argv[3:]',
    'signal.signal(signal.SIGALRM, lock_timeout)',
    'if waiting: signal.alarm(310)',
    'fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)',
    'try:',
    '    fcntl.flock(fd, fcntl.LOCK_EX | (0 if waiting else fcntl.LOCK_NB))',
    'except BlockingIOError:',
    '    print(\'{"ok":true,"skipped":true,"reason":"refresh lock held"}\')',
    '    sys.exit(0)',
    'signal.alarm(0)',
    'os.set_inheritable(fd, True)',
    'os.execv(sys.argv[2], sys.argv[2:])',
  ].join('\n'), LOCK_PATH, process.execPath, __filename, ...process.argv.slice(2), '--lock-held'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
acquireRefreshLock();
state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
sampleKey = state.processedSamples ?? null;
state.lastAttemptAt = new Date(startedAt).toISOString();
state.pollCadenceMinutes = 2;
state.sourceCadenceMinutes = 30;
saveState();
try {
  ensureMainCohort();
  ensureMilitaryCohort();
  refreshLiveData();
  const samples = currentSamples();
  if (samples.some((sample) => !sample)) throw new Error('A cohort has no live sample');
  sampleKey = JSON.stringify(samples);
  state.lastPollSuccessAt = new Date().toISOString();
  state.observationChanged = sampleKey !== JSON.stringify(state.latestSampledAt);
  state.latestSampledAt = samples;
  if (state.observationChanged) state.lastNewObservationAt = new Date().toISOString();
  saveState();
  if (sampleKey !== state.processedSamples || refreshImports ||
      ['dashboard.json', 'military-dashboard.json', 'untracked-dashboard.json']
        .some((name) => !fs.existsSync(path.join(PUBLISHED_DIR, name)))) {
    exportSnapshots();
    detectAlertEvents();
    state.processedSamples = sampleKey;
  }
  saveState();
} catch (error) {
  state.lastError = String(error.message || error);
  stageFailures.push({ label: 'ingest-snapshots-detection', message: state.lastError });
  console.error(error);
}
// Even failed acquisition must not strand previously queued deliveries.
runStage('flight-behaviour', detectFlightBehaviour);
// The gate fails closed: if corroboration could not run, nothing is delivered
// this pass. The failed stage already fails the run, and the next pass retries.
if (runStage('signal-corroboration', enforceSignalCorroboration)) updateAlerts();
runStage('operations-feed', exportOperationsFeed);
runStage('event-signals-feed', exportEventSignalsFeed);
state.finishedAt = new Date().toISOString();
state.durationMs = Date.now() - startedAt;
state.failedStages = stageFailures;
state.lastError = stageFailures.length ? stageFailures.map((stage) => `${stage.label}: ${stage.message}`).join('; ') : null;
saveState();
console.log(JSON.stringify({ ok: stageFailures.length === 0, ...state }));

if (stageFailures.length > 0) {
  console.error(JSON.stringify({ ok: false, failedStages: stageFailures }));
  process.exit(1);
}
