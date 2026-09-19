#!/usr/bin/env node

// Operations watchdog. Runs the status report; when the system is unhealthy,
// pushes a human-readable summary to the private ops ntfy topic
// (EWS_NTFY_OPS_TOPIC). This exists because the ingestion feed once broke
// silently for five weeks: data problems must reach a human.
//
// - No-ops when EWS_NTFY_OPS_TOPIC is unset.
// - A page must mean something. In the two weeks to 19 Sept 2026 this sent
//   ~150 pages: a false pair every night while the backup was mid-write,
//   bursts every two minutes because a minute counter in the problem text
//   changed the problem set's hash, and the one real failure (the nightly
//   self-test) repeated identically four times a day. Nobody acted on it for
//   ten days. So: each problem is tracked on its own, identified by its text
//   with the numbers removed; it pages once it has lasted HOLD_MS; it re-pages
//   every 6 h on its first day and daily after that, at urgent priority, with
//   its age in the title. A problem is over only after CLEAR_MS of absence, so
//   a flapping failure can neither storm nor hide.
// - Sends one recovery note when every paged problem has cleared.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT_DIR, 'tmp', 'ops-alert-state.json');
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HOLD_MS = 3 * MINUTE_MS;
const CLEAR_MS = 10 * MINUTE_MS;

function problemKey(text) {
  return String(text).replace(/\d+(\.\d+)?/g, '#');
}

function formatAge(ms) {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
}

// Pure: (previous state, the problems seen now, the time) -> next state and
// at most one page. Kept free of I/O so the schedule can be run on a fake clock.
function decide(previous, problemTexts, nowMs) {
  const records = { ...(previous.problems || {}) };
  for (const text of problemTexts) {
    const key = problemKey(text);
    records[key] = { firstSeenMs: nowMs, lastPagedMs: null, ...records[key], text, lastSeenMs: nowMs };
  }
  const recovered = [];
  for (const [key, record] of Object.entries(records)) {
    if (nowMs - record.lastSeenMs >= CLEAR_MS) {
      if (record.lastPagedMs) recovered.push(record);
      delete records[key];
    }
  }
  const open = Object.values(records).filter((record) => nowMs - record.firstSeenMs >= HOLD_MS);
  const present = open.filter((record) => record.lastSeenMs === nowMs);
  const due = present.filter((record) => {
    if (!record.lastPagedMs) return true;
    // Crossing one day is itself due: the first urgent page lands at 24 h.
    const escalatesAtMs = record.firstSeenMs + DAY_MS;
    if (nowMs >= escalatesAtMs && record.lastPagedMs < escalatesAtMs) return true;
    return nowMs - record.lastPagedMs >= (nowMs < escalatesAtMs ? 6 * HOUR_MS : DAY_MS);
  });

  let page = null;
  if (due.length) {
    const listed = [...present].sort((left, right) => left.firstSeenMs - right.firstSeenMs);
    const oldestMs = nowMs - listed[0].firstSeenMs;
    page = {
      kind: 'alert',
      title: oldestMs >= HOUR_MS ? `Warning Watch unhealthy for ${formatAge(oldestMs)}` : 'Warning Watch unhealthy',
      priority: oldestMs >= DAY_MS ? 'urgent' : 'high',
      body: [
        'Warning Watch on xyra-dev-hetzner:',
        ...listed.map((record) => `- ${record.text} (for ${formatAge(nowMs - record.firstSeenMs)})`),
        '',
        oldestMs >= DAY_MS
          ? 'This has outlasted every automatic repair. It needs a person. It will page daily until it clears.'
          : 'The repair timer runs every 6 hours. This pages again in 6 hours if it persists.',
      ].join('\n'),
    };
    for (const record of listed) record.lastPagedMs = nowMs;
  } else if (recovered.length && !Object.values(records).some((record) => record.lastPagedMs)) {
    page = {
      kind: 'recovery',
      title: 'Warning Watch recovered',
      priority: 'default',
      body: [
        'Cleared:',
        ...recovered.map((record) => `- ${record.text} (lasted ${formatAge(record.lastSeenMs - record.firstSeenMs)})`),
        '',
        'Nothing else is open. No action needed.',
      ].join('\n'),
    };
  }
  return { state: { problems: records }, page };
}

function loadEnvFile(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // Optional file.
  }
}

loadEnvFile('/etc/warning-watch.env');
loadEnvFile(path.join(ROOT_DIR, '.env'));

const topic = String(process.env.EWS_NTFY_OPS_TOPIC || '').trim();
const server = String(process.env.EWS_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

async function publish(title, body, priority) {
  const headers = {
    Title: title,
    Priority: priority,
    Tags: 'wrench',
  };
  const token = String(process.env.EWS_NTFY_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${server}/${topic}`, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`ntfy ops publish failed: HTTP ${response.status}`);
  }
}

async function main() {
  const result = spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'status.js')], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Fall through: an unparseable status is itself a problem.
  }
  const problems = report?.verdict?.problems
    || (report ? [] : [`status.js did not produce a report (exit ${result.status})`]);
  const healthy = problems.length === 0;

  if (!topic) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'missing_EWS_NTFY_OPS_TOPIC', healthy, problems }));
    process.exit(healthy ? 0 : 1);
  }

  // Publish before writing state: a page that failed to send is retried on
  // the next run instead of being recorded as sent.
  const { state, page } = decide(readState(), problems, Date.now());
  if (page) await publish(page.title, page.body, page.priority);
  writeState(state);
  console.log(JSON.stringify({ ok: true, healthy, ...(page ? { sent: page.kind, priority: page.priority } : {}), problems }));
  process.exit(healthy ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}

module.exports = { decide, problemKey, HOLD_MS, CLEAR_MS };
