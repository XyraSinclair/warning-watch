// The one answer to "is this event public?". Every rail that leaves the
// operator surface — subscriber dispatch, ntfy, RSS, the status payload, the
// webhook bridge — imports this and nothing else decides it. Severity is the
// whole gate: `watch` is operator-only for every kind, and a kind never gates,
// so a new detector is public exactly when it emits a public severity.
const PUBLIC_SEVERITIES = Object.freeze(['elevated', 'high', 'critical']);

// A literal SQL fragment over `alert_events` columns (no bound parameters, so
// it composes into any statement).
const PUBLIC_EVENT_SQL = `(severity IN (${PUBLIC_SEVERITIES.map((severity) => `'${severity}'`).join(', ')}) AND json_extract(payload_json, '$.retracted') IS NULL)`;

module.exports = { PUBLIC_SEVERITIES, PUBLIC_EVENT_SQL };
