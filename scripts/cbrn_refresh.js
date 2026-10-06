#!/usr/bin/env node

// CBRN instrument refresh.
//
// One pass = collect every CBRN instrument, run the deterministic detectors,
// then the cross-family fusion pass. It deliberately does NOT deliver: every
// alert event it creates lands in `alert_events` in the main database, and the
// existing two-minute refresh pipeline's delivery stages (ntfy, RSS, Telegram,
// subscriber dispatch, web push, webhook) carry it out within two minutes.
// One alarm plane, one fan-out, no second delivery path to keep alive.
//
// Stages are independent and failure-isolated, exactly like the aviation
// pipeline: a dead radiation network must not stop aircraft collection, and a
// failed stage must stay visible in the run summary rather than silently
// producing a quiet world.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MAIN_DB = process.env.EWS_DB_PATH || path.join(DATA_DIR, 'ews-main.sqlite');
const CBRN_DB = process.env.EWS_CBRN_DB_PATH || path.join(DATA_DIR, 'ews-cbrn.sqlite');
const WATCH_DB = process.env.EWS_WATCH_DB_PATH || path.join(DATA_DIR, 'ews-watch.sqlite');
const REGIONS_PATH = path.join(ROOT_DIR, 'config', 'cbrn-regions.json');
const LOCK_PATH = path.join(ROOT_DIR, 'tmp', 'cbrn-refresh.flock');
const STATE_PATH = path.join(DATA_DIR, 'cbrn-refresh-state.json');

const RUN_DEADLINE_MS = 270_000;
const STAGE_TIMEOUT_MS = 120_000;
// The aircraft instrument paces one request per six seconds to stay inside
// adsb.lol's dynamic rate limit, so fourteen regions need roughly 110 seconds.
const AIRCRAFT_STAGE_TIMEOUT_MS = 210_000;
const startedAt = Date.now();

const args = new Set(process.argv.slice(2));
const onlyStage = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const skipIngest = args.has('--skip-ingest');

// name -> [script, argv tail builder]
const STAGES = [
  ['radiation-ingest', 'ingest_cbrn_radiation.js', () => ['--db', CBRN_DB]],
  ['aircraft-ingest', 'ingest_cbrn_aircraft.js', () => ['--db', CBRN_DB, '--events-db', MAIN_DB, '--regions', REGIONS_PATH, '--once']],
  ['radiation-detect', 'detect_cbrn_radiation.js', () => ['--db', CBRN_DB, '--events-db', MAIN_DB]],
  ['airspace-detect', 'detect_cbrn_airspace.js', () => ['--db', CBRN_DB, '--events-db', MAIN_DB]],
  ['notices-detect', 'detect_cbrn_notices.js', () => ['--watch-db', WATCH_DB, '--events-db', MAIN_DB, '--cbrn-db', CBRN_DB]],
  ['lexical-detect', 'detect_cbrn_lexical.js', () => ['--watch-db', WATCH_DB, '--cbrn-db', CBRN_DB, '--events-db', MAIN_DB]],
  ['fusion', 'fuse_cbrn_signals.js', () => ['--events-db', MAIN_DB, '--cbrn-db', CBRN_DB]],
];

// The run state is a single module-level object; saveState() takes no argument
// deliberately, because an earlier version shadowed it with an unused parameter
// and silently wrote the literal string "undefined" — which then crashed the
// next run's JSON.parse and took the whole timer down with it.
function saveState() {
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, STATE_PATH);
}

// A state file is a record, not an input we trust: a truncated or corrupt file
// must degrade to "no previous run" rather than stop the instrument.
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function run(commandArgs, timeoutMs) {
  const remaining = RUN_DEADLINE_MS - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error('CBRN refresh deadline exceeded');
  const timeout = Math.min(remaining, timeoutMs);
  return spawnSync(process.execPath, commandArgs, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      EWS_DB_PATH: MAIN_DB,
      EWS_CBRN_DB_PATH: CBRN_DB,
      EWS_WATCH_DB_PATH: WATCH_DB,
      // The kill is SIGKILL, so a stage that paces its own work is told when.
      EWS_STAGE_KILL_AT: String(Date.now() + timeout),
    },
  });
}

function runStage(name, script, argvTail) {
  const scriptPath = path.join(ROOT_DIR, 'scripts', script);
  const stageStarted = Date.now();
  if (!fs.existsSync(scriptPath)) {
    return { stage: name, ok: false, durationMs: 0, error: `missing stage script: scripts/${script}` };
  }
  const timeoutMs = name === 'aircraft-ingest' ? AIRCRAFT_STAGE_TIMEOUT_MS : STAGE_TIMEOUT_MS;
  const result = run([scriptPath, ...argvTail], timeoutMs);
  const durationMs = Date.now() - stageStarted;
  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();
  if (stderr) console.error(`[${name}] ${stderr}`);
  if (stdout) console.log(`[${name}] ${stdout}`);
  if (result.error) {
    return { stage: name, ok: false, durationMs, error: String(result.error.message || result.error) };
  }
  if (result.status !== 0) {
    return { stage: name, ok: false, durationMs, error: `exit ${result.status}${stderr ? `: ${stderr.split('\n').at(-1)}` : ''}` };
  }
  return { stage: name, ok: true, durationMs, summary: stdout.split('\n').at(-1) || null };
}

// The OS releases flock on any exit, including SIGKILL, so a killed pass can
// never wedge the timer. A held lock means the previous pass is still working.
function acquireLock() {
  const result = spawnSync('python3', ['-c', [
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)',
    'try:',
    '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    'except BlockingIOError:',
    '    print(\'{"ok":true,"skipped":true,"reason":"cbrn refresh lock held"}\')',
    '    sys.exit(0)',
    'os.set_inheritable(fd, True)',
    'os.execv(sys.argv[2], sys.argv[2:])',
  ].join('\n'), LOCK_PATH, process.execPath, __filename, ...process.argv.slice(2), '--lock-held'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (!args.has('--lock-held')) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  acquireLock();
}

const state = loadState();
const stages = [];

for (const [name, script, argvTail] of STAGES) {
  if (onlyStage && name !== onlyStage) continue;
  if (skipIngest && name.endsWith('-ingest')) continue;
  const outcome = runStage(name, script, argvTail());
  stages.push(outcome);
  // Persist after every stage: a later stage timing out must not erase the
  // record of what the earlier ones found.
  state.lastAttemptAt = new Date(startedAt).toISOString();
  state.lastStages = stages;
  saveState();
}

const failed = stages.filter((stage) => !stage.ok);
state.finishedAt = new Date().toISOString();
state.durationMs = Date.now() - startedAt;
state.failedStages = failed;
state.lastError = failed.length ? failed.map((stage) => `${stage.stage}: ${stage.error}`).join('; ') : null;
if (!failed.length) state.lastSuccessAt = state.finishedAt;
saveState();

console.log(JSON.stringify({ ok: failed.length === 0, durationMs: state.durationMs, stages }));
if (failed.length) process.exit(1);
