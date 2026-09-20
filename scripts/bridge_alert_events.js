#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { PUBLIC_EVENT_SQL } = require('../server/publication');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) process.env[key] = valueParts.join('=');
  }
}

loadEnvFile('/etc/warning-watch.env');
loadEnvFile(path.join(__dirname, '..', '.env'));

function parseArgs(argv) {
  const args = {
    db: process.env.EWS_DB_PATH || path.join(__dirname, '..', 'data', 'ews-main.sqlite'),
    limit: Number(process.env.EWS_ALERT_EVENT_BRIDGE_LIMIT || 100),
    // The bridge target must be EXPLICIT. It was once derived from
    // EWS_PUBLIC_URL/APP_BASE_URL, which silently posted alert payloads at
    // whatever site those display URLs pointed to (including, at one point,
    // the upstream reference deployment). Unset means: do not bridge.
    url: process.env.EWS_ALERT_EVENTS_WEBHOOK_URL || '',
    statusPath:
      process.env.EWS_ALERT_BRIDGE_STATUS_PATH ||
      path.join(__dirname, '..', 'data', 'published', 'alert-bridge-status.json'),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--limit') {
      args.limit = Number(argv[++index]);
    } else if (value === '--url') {
      args.url = argv[++index];
    } else if (value === '--status-path') {
      args.statusPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  args.limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
  return args;
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function ensureAlertEventBridgeColumns(db) {
  const columns = tableColumns(db, 'alert_events');
  if (!columns.has('bridged_at')) {
    db.prepare('ALTER TABLE alert_events ADD COLUMN bridged_at TEXT').run();
  }
  if (!columns.has('bridge_summary_json')) {
    db.prepare('ALTER TABLE alert_events ADD COLUMN bridge_summary_json TEXT').run();
  }
}

function listAlertEvents(db, limit) {
  return db
    .prepare(`
      SELECT
        id,
        kind,
        severity,
        cohort,
        event_key AS eventKey,
        occurred_at AS occurredAt,
        title,
        message,
        payload_json AS payloadJson,
        status,
        created_at AS createdAt,
        dispatched_at AS dispatchedAt,
        bridged_at AS bridgedAt
      FROM alert_events
      WHERE ${PUBLIC_EVENT_SQL}
        AND bridged_at IS NULL
      ORDER BY occurred_at ASC, id ASC
      LIMIT ?
    `)
    .all(limit)
    .map((event) => {
      return {
        ...event,
        payload: JSON.parse(event.payloadJson),
        payloadJson: undefined,
      };
    });
}

function writeBridgeStatus(args, status) {
  const payload = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    webhookConfigured: Boolean(String(args.url || '').trim()),
    limit: args.limit,
    ...status,
  };
  fs.mkdirSync(path.dirname(args.statusPath), { recursive: true });
  fs.writeFileSync(args.statusPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function postEvent(url, token, event) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: 'local_refresh', events: [event] }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error || text || `Alert event bridge failed with HTTP ${response.status}`);
  }
  return payload;
}

function markEventBridged(db, event, result) {
  db.prepare(`
    UPDATE alert_events
    SET bridged_at = ?,
        bridge_summary_json = ?
    WHERE id = ?
      AND bridged_at IS NULL
  `).run(new Date().toISOString(), JSON.stringify(result), event.id);
}

async function postEvents(db, url, token, events) {
  const results = [];
  for (const event of events) {
    const result = await postEvent(url, token, event);
    markEventBridged(db, event, result);
    results.push({ eventKey: event.eventKey, result });
  }
  return { ok: results.every((entry) => entry.result?.ok !== false), results };
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (!args.url) {
      const status = writeBridgeStatus(args, {
        ok: true,
        skipped: true,
        reason: 'missing_EWS_ALERT_EVENTS_WEBHOOK_URL',
      });
      console.log(JSON.stringify(status));
      return;
    }
    const token = String(process.env.INTERNAL_ALERT_TOKEN || '').trim();
    if (!token) {
      const error = new Error('Missing INTERNAL_ALERT_TOKEN for alert event bridge.');
      error.bridgeStatus = {
        ok: false,
        skipped: true,
        reason: 'missing_INTERNAL_ALERT_TOKEN',
      };
      throw error;
    }

    const dbPath = path.resolve(args.db);
    const db = new Database(dbPath, { fileMustExist: true });
    ensureAlertEventBridgeColumns(db);
    try {
      const events = listAlertEvents(db, args.limit);
      if (!events.length) {
        const status = writeBridgeStatus(args, {
          ok: true,
          skipped: true,
          reason: 'no_alert_events',
          eventCount: 0,
        });
        console.log(JSON.stringify(status));
        return;
      }
      const result = await postEvents(db, args.url, token, events);
      const status = writeBridgeStatus(args, {
        ok: true,
        skipped: false,
        postedEvents: events.length,
        result,
      });
      console.log(JSON.stringify(status));
    } finally {
      db.close();
    }
  } catch (error) {
    writeBridgeStatus(
      args,
      error.bridgeStatus || {
        ok: false,
        skipped: false,
        error: error.message || String(error),
      },
    );
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
