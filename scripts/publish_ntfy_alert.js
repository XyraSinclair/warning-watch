#!/usr/bin/env node

// Publish new alert events to a public ntfy topic (https://ntfy.sh/<topic>).
// Anyone can subscribe from the ntfy app or `curl -s ntfy.sh/<topic>/sse` —
// no accounts, no tokens. Cursor lives in the meta table so each event
// publishes exactly once. No-ops when EWS_NTFY_TOPIC is unset.
//
// Publishing threshold: elevated and above. watch-level events are ambient
// and stay on the dashboard/RSS only.

const path = require('node:path');
const Database = require('better-sqlite3');
const { loadEnvFile } = require('../server/env');

loadEnvFile();

const CURSOR_KEY = 'ntfy_last_alert_id';
const PUBLISHED_SEVERITIES = new Set(['elevated', 'high', 'critical']);

const PRIORITY_BY_SEVERITY = {
  elevated: 'default',
  high: 'high',
  critical: 'urgent',
};

function parseArgs(argv) {
  const args = {
    db: process.env.EWS_DB_PATH || path.join(__dirname, '..', 'data', 'ews-main.sqlite'),
    topic: process.env.EWS_NTFY_TOPIC || '',
    server: (process.env.EWS_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''),
    dryRun: false,
    limit: 10,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--topic') args.topic = argv[++index];
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--limit') args.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function publish(server, topic, event, dryRun) {
  const title = `EWS ${event.severity.toUpperCase()}: ${event.title}`;
  const body = `${event.message}\n\ncohort=${event.cohort} occurred_at=${event.occurred_at}`;
  if (dryRun) {
    console.log(JSON.stringify({ wouldPublish: title, topic }));
    return true;
  }
  const headers = {
    Title: title,
    Priority: PRIORITY_BY_SEVERITY[event.severity] || 'default',
    // The tag is the first thing a subscriber sees on a lock screen, so it
    // must not tell a radiation alert that it is about aeroplanes.
    Tags: event.cohort === 'cbrn'
      ? (event.kind === 'cbrn_radiation_anomaly' ? 'radioactive,warning' : event.kind === 'cbrn_seismic_event' ? 'radioactive,collision' : 'warning,skull')
      : 'rotating_light,airplane',
  };
  const token = String(process.env.EWS_NTFY_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${server}/${topic}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    console.error(`ntfy publish failed for event ${event.id}: HTTP ${response.status}`);
    return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.topic) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'missing_EWS_NTFY_TOPIC' }));
    return;
  }

  const db = new Database(path.resolve(args.db));
  db.pragma('busy_timeout = 30000');
  try {
    const cursorRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(CURSOR_KEY);
    let cursor = cursorRow ? Number(cursorRow.value) : null;
    if (cursor === null) {
      const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM alert_events').get();
      cursor = maxRow.id;
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(cursor));
      console.log(JSON.stringify({ ok: true, initializedCursor: cursor, published: 0 }));
      return;
    }

    const events = db
      .prepare('SELECT id, severity, cohort, title, message, occurred_at FROM alert_events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(cursor, args.limit);

    let published = 0;
    for (const event of events) {
      if (PUBLISHED_SEVERITIES.has(event.severity)) {
        const ok = await publish(args.server, args.topic, event, args.dryRun);
        if (!ok) break; // Cursor stays put; event retries next pass.
        published += 1;
      }
      if (!args.dryRun) {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(event.id));
      }
    }

    console.log(JSON.stringify({ ok: true, cursor, examined: events.length, published, dryRun: args.dryRun }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
