// The one answer to "is this event public?". Every rail that leaves the
// operator surface — subscriber dispatch, ntfy, RSS, the status payload, the
// webhook bridge — imports this and nothing else decides it. Severity is the
// whole gate: `watch` is operator-only for every kind, and a kind never gates,
// so a new detector is public exactly when it emits a public severity.
const PUBLIC_SEVERITIES = Object.freeze(['elevated', 'high', 'critical']);
const SEVERITY_RANK = Object.freeze({ watch: 1, elevated: 3, high: 4, critical: 5 });

const PUBLIC_SEVERITY_LIST_SQL = PUBLIC_SEVERITIES.map((severity) => `'${severity}'`).join(', ');

// A literal SQL fragment over `alert_events` columns (no bound parameters, so
// it composes into any statement).
const PUBLIC_EVENT_SQL = `(severity IN (${PUBLIC_SEVERITY_LIST_SQL}) AND json_extract(payload_json, '$.retracted') IS NULL)`;

const severityRankSql = (expr) => `CASE ${expr} WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'elevated' THEN 3 ELSE 1 END`;

// The status clause of every upsert (bind @severity and @status). An event
// is a mutable row, so an escalation would otherwise vanish into a row already
// marked delivered: a rise to a higher public severity goes back to pending
// and subscribers hear it again. Anything else keeps what delivery decided.
const UPSERT_STATUS_SQL = `CASE
        WHEN status = 'processing' THEN status
        WHEN ${severityRankSql('@severity')} > ${severityRankSql('severity')} AND @severity IN (${PUBLIC_SEVERITY_LIST_SQL}) THEN 'pending'
        WHEN status IN ('sent', 'no_recipients', 'partial', 'failed') THEN status
        ELSE @status
      END`;

// The firing record: one row per (event, rail, severity) that left the box,
// appended and never rewritten. A rail's work is "public events with no row
// at their current severity"; a retraction is one more row, severity 'retracted'.
function ensurePublications(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS publications (
    event_id INTEGER NOT NULL REFERENCES alert_events(id),
    rail TEXT NOT NULL,
    severity TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, rail, severity)
  )`);
}

function recordPublication(db, eventId, rail, severity = null) {
  ensurePublications(db);
  if (severity) {
    db.prepare('INSERT OR IGNORE INTO publications (event_id, rail, severity) VALUES (?, ?, ?)').run(eventId, rail, severity);
  } else {
    db.prepare("INSERT OR IGNORE INTO publications (event_id, rail, severity) SELECT id, ?, severity FROM alert_events WHERE id = ?").run(rail, eventId);
  }
}

module.exports = { PUBLIC_SEVERITIES, SEVERITY_RANK, PUBLIC_EVENT_SQL, UPSERT_STATUS_SQL, ensurePublications, recordPublication };
