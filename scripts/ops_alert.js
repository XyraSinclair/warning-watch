#!/usr/bin/env node

// Operations watchdog. Runs the status report; when the system is unhealthy,
// pushes a human-readable summary to the private ops ntfy topic
// (EWS_NTFY_OPS_TOPIC). This exists because the ingestion feed once broke
// silently for five weeks: data problems must reach a human.
//
// - No-ops when EWS_NTFY_OPS_TOPIC is unset.
// - Deduplicates: an unchanged problem set re-alerts at most every 6 hours.
// - Sends a one-time recovery note when health returns after an alert.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT_DIR, 'tmp', 'ops-alert-state.json');
const REALERT_MS = 6 * 60 * 60 * 1000;

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

  const state = readState();
  const problemsHash = crypto.createHash('sha256').update(JSON.stringify(problems)).digest('hex').slice(0, 16);

  if (healthy) {
    if (state.alerting) {
      await publish(
        'Warning Watch recovered',
        'All cohorts are ingesting again and every service is healthy. No action needed.',
        'default'
      );
      writeState({ alerting: false });
      console.log(JSON.stringify({ ok: true, healthy: true, sent: 'recovery' }));
      return;
    }
    console.log(JSON.stringify({ ok: true, healthy: true }));
    return;
  }

  const unchanged = state.alerting && state.problemsHash === problemsHash;
  const recentlySent = state.sentAtMs && Date.now() - state.sentAtMs < REALERT_MS;
  if (unchanged && recentlySent) {
    console.log(JSON.stringify({ ok: true, healthy: false, suppressed: true, problems }));
    process.exit(1);
  }

  const body = [
    'The plane-flight monitor on xyra-dev-hetzner is unhealthy:',
    ...problems.map((p) => `- ${p}`),
    '',
    'The 6-hourly repair timer will attempt self-healing; if this repeats, check `journalctl -u warning-watch-refresh` on the box.',
  ].join('\n');
  await publish('Warning Watch unhealthy', body, 'high');
  writeState({ alerting: true, problemsHash, sentAtMs: Date.now() });
  console.log(JSON.stringify({ ok: true, healthy: false, sent: 'alert', problems }));
  process.exit(1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
