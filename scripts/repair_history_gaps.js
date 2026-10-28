#!/usr/bin/env node

// Self-healing history repair. The refresh loop only ingests the latest
// 30-minute slot, so any downtime leaves a hole in the per-cohort history —
// which stalls the anomaly baselines (7 days continuous) and the
// takeoff-rate model (28-day lookback).
//
// Two detectors, per cohort database:
//   1. Trailing gap — latest sample is older than 2h.
//   2. Interior holes — any complete UTC day in the last 30 days with fewer
//      than MIN_SLOTS_PER_DAY distinct samples. Days are retried at most
//      MAX_DAY_ATTEMPTS times (ledger in the meta table) so days that are
//      genuinely incomplete upstream (404'd slots) cannot loop forever.
//
// Contiguous candidate days are repaired as single ranges via the cohort's
// backfill tool. The heatmap cache is shared across cohorts, so ranges are
// downloaded once (--keep-cache) and cleaned up after a successful pass.
// Idempotent; safe on a schedule. Skips when another repair holds the lock, and
// when the archive is unread (the backfill's EX_TEMPFAIL): a repair deletes only
// what it has read again, so a closed archive leaves every row as it was.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'adsbx');
const LOCK_DIR = path.join(ROOT_DIR, 'tmp', 'repair.lock');
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // repairs can legitimately run for hours
const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // ignore trailing holes smaller than 2h
const MAX_REPAIR_DAYS = 30; // baselines need <=28 days; cap runaway repairs
const MIN_SLOTS_PER_DAY = 40; // of 48; a day missing >4h of slots is a hole
const MAX_DAY_ATTEMPTS = 2; // per-day retry budget for interior repairs
const ATTEMPTS_META_KEY = 'repair_day_attempts';
const VENV_PYTHON = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.EWS_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const EX_TEMPFAIL = 75; // the backfill's exit when the archive did not answer: skipped, not failed

const DATABASES = [
  {
    dbPath: path.join(DATA_DIR, 'ews-main.sqlite'),
    freshnessTable: 'concurrent_metrics',
    backfillArgs: (dbPath, startDate, endDate) => [
      path.join(ROOT_DIR, 'scripts', 'backfill_history.py'),
      '--db', dbPath, '--start-date', startDate, '--end-date', endDate, '--keep-cache',
    ],
  },
  {
    dbPath: path.join(DATA_DIR, 'ews-military.sqlite'),
    freshnessTable: 'concurrent_metrics',
    backfillArgs: (dbPath, startDate, endDate) => [
      path.join(ROOT_DIR, 'scripts', 'backfill_history.py'),
      '--db', dbPath, '--start-date', startDate, '--end-date', endDate, '--keep-cache',
    ],
  },
  {
    dbPath: path.join(DATA_DIR, 'ews-untracked.sqlite'),
    freshnessTable: 'non_icao_metrics',
    backfillArgs: (dbPath, startDate, endDate) => [
      path.join(ROOT_DIR, 'scripts', 'track_non_icao_hex.py'),
      '--db', dbPath, '--start-date', startDate, '--end-date', endDate,
      '--metrics-only', '--write-concurrent-metrics',
    ],
  },
];

function acquireLock() {
  try {
    const stat = fs.statSync(LOCK_DIR);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmdirSync(LOCK_DIR);
    }
  } catch {
    // No existing lock.
  }
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: false });
  } catch {
    return false;
  }
  const release = () => {
    try { fs.rmdirSync(LOCK_DIR); } catch { /* released */ }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return true;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(dayIso, days) {
  return isoDate(Date.parse(`${dayIso}T00:00:00Z`) + days * 24 * 60 * 60 * 1000);
}

function openDb(dbPath, readonly) {
  const db = new Database(dbPath, { readonly, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  return db;
}

function readHistory(dbPath, freshnessTable) {
  const db = openDb(dbPath, true);
  try {
    const bounds = db
      .prepare(`SELECT MIN(sampled_at) AS first, MAX(sampled_at) AS latest FROM ${freshnessTable}`)
      .get();
    const dayRows = db
      .prepare(
        `SELECT substr(sampled_at, 1, 10) AS day, COUNT(DISTINCT sampled_at) AS slots
         FROM ${freshnessTable}
         WHERE sampled_at >= datetime('now', '-${MAX_REPAIR_DAYS + 1} days')
         GROUP BY day`
      )
      .all();
    let attempts = {};
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(ATTEMPTS_META_KEY);
      if (row?.value) attempts = JSON.parse(row.value);
    } catch {
      // meta table missing or unparseable ledger — treat as no attempts.
    }
    return {
      firstMs: bounds?.first ? Date.parse(bounds.first) : null,
      latestMs: bounds?.latest ? Date.parse(bounds.latest) : null,
      slotsByDay: Object.fromEntries(dayRows.map((row) => [row.day, row.slots])),
      attempts,
    };
  } finally {
    db.close();
  }
}

function recordAttempts(dbPath, attempts, days) {
  const pruneBefore = addDays(isoDate(Date.now()), -(MAX_REPAIR_DAYS + 15));
  const next = {};
  for (const [day, count] of Object.entries(attempts)) {
    if (day >= pruneBefore) next[day] = count;
  }
  for (const day of days) {
    next[day] = (next[day] || 0) + 1;
  }
  const db = openDb(dbPath, false);
  try {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(ATTEMPTS_META_KEY, JSON.stringify(next));
  } finally {
    db.close();
  }
  return next;
}

function runBackfill(entry, startDate, endDate) {
  const result = spawnSync(PYTHON_BIN, entry.backfillArgs(entry.dbPath, startDate, endDate), {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return result.status;
}

function holeyDayRanges(history, nowMs, excludeFromDay) {
  const today = isoDate(nowMs);
  const firstDay = history.firstMs ? isoDate(history.firstMs) : today;
  let day = addDays(today, -MAX_REPAIR_DAYS);
  if (day < firstDay) day = firstDay;

  const candidates = [];
  for (; day < today; day = addDays(day, 1)) {
    if (excludeFromDay && day >= excludeFromDay) continue; // trailing repair covers it
    const slots = history.slotsByDay[day] || 0;
    if (slots >= MIN_SLOTS_PER_DAY) continue;
    if ((history.attempts[day] || 0) >= MAX_DAY_ATTEMPTS) continue;
    candidates.push(day);
  }

  const ranges = [];
  for (const candidate of candidates) {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.endDate, 0) === candidate) {
      last.endDate = addDays(candidate, 1);
      last.days.push(candidate);
    } else {
      ranges.push({ startDate: candidate, endDate: addDays(candidate, 1), days: [candidate] });
    }
  }
  return ranges;
}

function repairDatabase(entry, { dryRun }) {
  const { dbPath, freshnessTable } = entry;
  if (!fs.existsSync(dbPath)) {
    return { db: dbPath, skipped: true, reason: 'missing_database' };
  }
  const history = readHistory(dbPath, freshnessTable);
  if (!history.latestMs) {
    return { db: dbPath, skipped: true, reason: 'no_history_rows' };
  }
  const nowMs = Date.now();
  const gapMs = nowMs - history.latestMs;
  const actions = [];

  // Trailing gap: last sample day through tomorrow (end date exclusive).
  let trailingStart = null;
  if (gapMs > GAP_THRESHOLD_MS) {
    let startMs = Date.parse(`${isoDate(history.latestMs)}T00:00:00Z`);
    const maxStartMs = nowMs - MAX_REPAIR_DAYS * 24 * 60 * 60 * 1000;
    if (startMs < maxStartMs) startMs = maxStartMs;
    trailingStart = isoDate(startMs);
    actions.push({
      kind: 'trailing',
      startDate: trailingStart,
      endDate: isoDate(nowMs + 24 * 60 * 60 * 1000),
      days: [],
      gapHours: +(gapMs / 3600000).toFixed(1),
    });
  }

  // Interior holes over complete UTC days not already covered by the trailing repair.
  for (const range of holeyDayRanges(history, nowMs, trailingStart)) {
    actions.push({ kind: 'interior', ...range });
  }

  if (actions.length === 0) {
    return { db: dbPath, skipped: true, reason: 'healthy', gapHours: +(gapMs / 3600000).toFixed(1) };
  }
  if (dryRun) {
    return { db: dbPath, wouldRepair: actions };
  }

  // A backfill that exits EX_TEMPFAIL found the archive unread (closed, rate-limited,
  // unanswering): it deleted and wrote nothing, so the remaining actions and databases
  // are skipped this run (the box asks once, not 48 times: on 28 Oct 2026 the burst of
  // refused reads got its address rate-limited on top of the gate), no day's attempt
  // is spent, and the run is not a failure; the next run asks again.
  const results = [];
  let archiveUnread = false;
  for (const action of actions) {
    if (archiveUnread) {
      results.push({ ...action, skipped: 'archive unread' });
      continue;
    }
    const status = runBackfill(entry, action.startDate, action.endDate);
    if (status === EX_TEMPFAIL) {
      archiveUnread = true;
      results.push({ ...action, skipped: 'archive unread' });
      continue;
    }
    if (action.days.length > 0) {
      history.attempts = recordAttempts(dbPath, history.attempts, action.days);
    }
    results.push({ ...action, repaired: status === 0 });
  }
  const ran = results.filter((result) => result.skipped === undefined);
  return {
    db: dbPath,
    ...(ran.length > 0 ? { repaired: ran.every((result) => result.repaired) } : {}),
    ...(archiveUnread ? { archiveUnread: true } : {}),
    actions: results,
  };
}

function cleanCache() {
  // Repairs share downloaded slots via --keep-cache; drop the cache afterward
  // so repeated repairs cannot grow the disk without bound.
  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  if (!acquireLock()) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'repair lock held' }));
    return;
  }
  const results = [];
  let archiveUnread = false;
  for (const entry of DATABASES) {
    if (archiveUnread) {
      results.push({ db: entry.dbPath, skipped: true, reason: 'archive unread' });
      continue;
    }
    const result = repairDatabase(entry, { dryRun });
    if (result.archiveUnread) archiveUnread = true;
    results.push(result);
  }
  if (!dryRun && results.some((entry) => entry.actions)) {
    cleanCache();
  }
  const ok = results.every((entry) => entry.repaired !== false);
  console.log(JSON.stringify({ ok, dryRun, archiveUnread, results }));
  if (!ok) {
    process.exit(1);
  }
}

main();
