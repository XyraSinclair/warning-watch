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
//   before any parenthesis with the numbers removed; it pages once it is
//   HOLD_MS old and has been present at half or more of the checks since it
//   was first seen; it re-pages every 6 h on its first day and daily after
//   that, at urgent priority, with its age in the title. A problem is over
//   only after CLEAR_MS of absence, so a flapping failure can neither storm
//   nor hide. Age alone is not presence: on 9 Oct 2026 one NWS history page
//   failed at two checks twelve minutes apart, five healthy checks between
//   them, and that paged as a twelve-minute outage. A paged problem that
//   returns within MEMORY_MS of clearing is the same problem: it keeps its
//   first-seen time and its schedule. From 20 to 21 Oct 2026 the BfS pool
//   starvation yielded one whole read every three to eight hours, each read
//   cleared the six-failures count, and one outage paged five times in 32
//   hours as five fresh problems, each "for 4m", with four recovery notes
//   between and never reaching urgent; with the memory it is one problem that
//   pages on the 6 h marks, goes urgent at a day, and then pages daily.
// - A problem that names a third party's server ("cbrn network <source>: N
//   consecutive collection failures"; "aircraft archive adsbexchange: unread
//   for N m", since 23 Oct 2026) is theirs to end, not ours: it pages
//   once at onset, at default priority, and once more when it clears, never
//   on the marks and never urgent. From 20 to 22 Oct 2026 the BfS pool
//   starvation paged nine times in 56 hours, the last urgent as it crossed a
//   day, and sent six recovery notes, for an outage nothing on the box could
//   end; the public status page carries the gap instead. Everything the box
//   can mend — a dead timer, a failed stage, every gamma network blind at
//   once — keeps the full schedule.
// - Sends one recovery note when every paged problem has cleared. The note
//   closes pages: a remembered problem that returns, does not page again and
//   clears again sends none.

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
const MEMORY_MS = DAY_MS;

// The text before the first parenthesis names the problem; what follows is
// that run's measurement or the collector's last error, which changes while
// the problem stays. On 2 Oct 2026 one EURDEP outage paged seven times in 21
// hours where this schedule allows four: its detail flipped between
// stale=false and stale=true, and each flip was a new problem.
function problemKey(text) {
  return String(text).replace(/ \(.*$/s, '').replace(/\d+(\.\d+)?/g, '#');
}

// The problems that name a third party's server (status.js: "cbrn network" for
// the gamma networks and the adsb.lol feed, "aircraft archive" for the ADS-B
// Exchange archive).
const UPSTREAM_PREFIXES = ['cbrn network ', 'aircraft archive '];
const upstream = (record) => UPSTREAM_PREFIXES.some((prefix) => problemKey(record.text).startsWith(prefix));

function formatAge(ms) {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`;
}

function formatPresence(record, nowMs) {
  const age = formatAge(nowMs - record.firstSeenMs);
  return record.present === record.checks ? `for ${age}` : `at ${record.present} of ${record.checks} checks over ${age}`;
}

// Pure: (previous state, the problems seen now, the time) -> next state and
// at most one page. Kept free of I/O so the schedule can be run on a fake clock.
function decide(previous, problemTexts, nowMs) {
  const records = { ...(previous.problems || {}) };
  const seen = new Set();
  for (const text of problemTexts) {
    const key = problemKey(text);
    records[key] = { firstSeenMs: nowMs, lastPagedMs: null, notedMs: null, checks: 0, present: 0, ...records[key], text, lastSeenMs: nowMs, clearedMs: null };
    seen.add(key);
  }
  const recovered = [];
  for (const [key, record] of Object.entries(records)) {
    if (record.clearedMs) {
      // Remembered, not open: forgotten once it has stayed clear for MEMORY_MS.
      if (nowMs - record.clearedMs >= MEMORY_MS) delete records[key];
    } else if (nowMs - record.lastSeenMs >= CLEAR_MS) {
      if (!record.lastPagedMs) {
        delete records[key];
      } else {
        record.clearedMs = nowMs;
        if (record.lastPagedMs > (record.notedMs || 0)) recovered.push(record);
      }
    } else {
      record.checks += 1;
      if (seen.has(key)) record.present += 1;
    }
  }
  const live = Object.values(records).filter((record) => !record.clearedMs);
  const open = live.filter((record) => nowMs - record.firstSeenMs >= HOLD_MS && record.present * 2 >= record.checks);
  const present = open.filter((record) => record.lastSeenMs === nowMs);
  const due = present.filter((record) => {
    if (!record.lastPagedMs) return true;
    if (upstream(record)) return false;
    // Crossing one day is itself due: the first urgent page lands at 24 h.
    const escalatesAtMs = record.firstSeenMs + DAY_MS;
    if (nowMs >= escalatesAtMs && record.lastPagedMs < escalatesAtMs) return true;
    return nowMs - record.lastPagedMs >= (nowMs < escalatesAtMs ? 6 * HOUR_MS : DAY_MS);
  });

  let page = null;
  if (due.length) {
    const listed = [...present].sort((left, right) => left.firstSeenMs - right.firstSeenMs);
    // The title and priority follow the box's own problems; a page that lists
    // only a third party's is informational.
    const ours = listed.filter((record) => !upstream(record));
    const oldestMs = nowMs - (ours[0] || listed[0]).firstSeenMs;
    page = {
      kind: 'alert',
      title: !ours.length ? 'Warning Watch: upstream source unread' : oldestMs >= HOUR_MS ? `Warning Watch unhealthy for ${formatAge(oldestMs)}` : 'Warning Watch unhealthy',
      priority: !ours.length ? 'default' : oldestMs >= DAY_MS ? 'urgent' : 'high',
      body: [
        'Warning Watch on xyra-dev-hetzner:',
        ...listed.map((record) => `- ${record.text} (${formatPresence(record, nowMs)})`),
        '',
        !ours.length
          ? "A third party's server is not answering; nothing on the box ends this, and the status page shows the gap. This pages once more when it clears, and not before."
          : oldestMs >= DAY_MS
            ? 'This has outlasted every automatic repair. It needs a person. It will page daily until it clears.'
            : 'This pages again in 6 hours if it persists.',
      ].join('\n'),
    };
    for (const record of listed) record.lastPagedMs = nowMs;
  } else if (recovered.length && !live.some((record) => record.lastPagedMs)) {
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
    for (const record of recovered) record.notedMs = nowMs;
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
    return;
  }

  // Publish before writing state: a page that failed to send is retried on
  // the next run instead of being recorded as sent.
  const { state, page } = decide(readState(), problems, Date.now());
  if (page) await publish(page.title, page.body, page.priority);
  writeState(state);
  // Exit 0: the watchdog ran and reported. The unit fails only when the
  // watchdog itself broke, so a working watchdog never looks like a dead one.
  console.log(JSON.stringify({ ok: true, healthy, ...(page ? { sent: page.kind, priority: page.priority } : {}), problems }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}

module.exports = { decide, problemKey, HOLD_MS, CLEAR_MS, MEMORY_MS };
