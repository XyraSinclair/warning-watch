#!/usr/bin/env node

// Publish alert events to a public ntfy topic (https://ntfy.sh/<topic>).
// Anyone can subscribe from the ntfy app or `curl -s ntfy.sh/<topic>/sse` —
// no accounts, no tokens. The `publications` table is the record: an event
// publishes once per severity it reaches, and a retraction of something this
// rail carried publishes as a correction. No-ops when EWS_NTFY_TOPIC is unset.
//
// What publishes is what server/publication.js calls public.

const path = require('node:path');
const Database = require('better-sqlite3');
const { loadEnvFile } = require('../server/env');
const { PUBLIC_EVENT_SQL, ensurePublications, recordPublication } = require('../server/publication');

loadEnvFile();

const LEGACY_CURSOR_KEY = 'ntfy_last_alert_id';
const RAIL = 'ntfy';

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
  const retracted = event.retracted ? JSON.parse(event.retracted) : null;
  const title = retracted ? `EWS RETRACTED: ${event.title}` : `EWS ${event.severity.toUpperCase()}: ${event.title}`;
  const body = retracted
    ? `Retracted: ${retracted.reason || 'no reason recorded'}\n\ncohort=${event.cohort} occurred_at=${event.occurred_at}`
    : `${event.message}\n\ncohort=${event.cohort} occurred_at=${event.occurred_at}`;
  if (dryRun) {
    console.log(JSON.stringify({ wouldPublish: title, topic }));
    return true;
  }
  const headers = {
    Title: title,
    Priority: retracted ? 'default' : PRIORITY_BY_SEVERITY[event.severity] || 'default',
    // The tag is the first thing a subscriber sees on a lock screen, so it
    // must not tell a radiation alert that it is about aeroplanes.
    Tags: retracted ? 'white_check_mark' : event.cohort === 'cbrn'
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
    ensurePublications(db);
    // One-time migration from the id cursor: everything at or below it counts
    // as published at its current severity, retracted rows as corrected too.
    const cursorRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_CURSOR_KEY);
    if (cursorRow && !args.dryRun) {
      db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO publications (event_id, rail, severity) SELECT id, ?, severity FROM alert_events WHERE id <= ?`).run(RAIL, Number(cursorRow.value));
        db.prepare(`INSERT OR IGNORE INTO publications (event_id, rail, severity) SELECT id, ?, 'retracted' FROM alert_events WHERE id <= ? AND json_extract(payload_json, '$.retracted') IS NOT NULL`).run(RAIL, Number(cursorRow.value));
        db.prepare('DELETE FROM meta WHERE key = ?').run(LEGACY_CURSOR_KEY);
      })();
    }

    // Work: public events with no row at their current severity, and retracted
    // events this rail carried with no correction row yet.
    const events = db
      .prepare(`SELECT id, kind, severity, cohort, title, message, occurred_at,
                json_extract(payload_json, '$.retracted') AS retracted
           FROM alert_events e
          WHERE (${PUBLIC_EVENT_SQL}
                 AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.event_id = e.id AND p.rail = '${RAIL}' AND p.severity = e.severity))
             OR (json_extract(payload_json, '$.retracted') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM publications p WHERE p.event_id = e.id AND p.rail = '${RAIL}' AND p.severity <> 'retracted')
                 AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.event_id = e.id AND p.rail = '${RAIL}' AND p.severity = 'retracted'))
          ORDER BY id ASC LIMIT ?`)
      .all(args.limit);

    let published = 0;
    for (const event of events) {
      const ok = await publish(args.server, args.topic, event, args.dryRun);
      if (!ok) break; // No row written; the event retries next pass.
      published += 1;
      if (!args.dryRun) recordPublication(db, event.id, RAIL, event.retracted ? 'retracted' : event.severity);
    }

    console.log(JSON.stringify({ ok: true, examined: events.length, published, dryRun: args.dryRun }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
