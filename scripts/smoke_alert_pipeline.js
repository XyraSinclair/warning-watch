#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}


function createSmokeVapidEnv() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicKeyBytes = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url'),
  ]);
  return {
    WEB_PUSH_VAPID_PUBLIC_KEY: publicKeyBytes.toString('base64url'),
    WEB_PUSH_VAPID_PRIVATE_KEY: privateJwk.d,
    WEB_PUSH_CONTACT: 'mailto:alerts@example.test',
  };
}

async function createSmokePushSubscription(endpoint = 'https://push.example.test/send/smoke') {
  const keyPair = await nodeCrypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await nodeCrypto.webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    endpoint,
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: nodeCrypto.randomBytes(16).toString('base64url'),
    },
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function execNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: ROOT_DIR, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, options = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < (options.timeoutMs || 10_000)) {
    try {
      const response = await fetch(url, options.fetchOptions);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.ok) {
        return { response, payload };
      }
      lastError = new Error(`${url} returned ${response.status}: ${text}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function initTempDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'takeoff_cluster',
    'warning',
    'global_business_jet',
    'smoke-alert-1',
    '2026-06-23T00:00:00.000Z',
    'Smoke alert',
    'Smoke alert message',
    JSON.stringify({ zScore: 4.2, takeoffCount: 7, concurrentCount: 13 }),
    'pending',
  );
  db.close();
}


async function assertLocalDispatchSkipsRawTakeoffTelemetry() {
  const { dispatchPendingAlerts, upsertSubscriber } = require(path.join(ROOT_DIR, 'server', 'local-notifications'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-local-dispatch-')), 'ews.sqlite');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const env = {
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    POSTMARK_SERVER_TOKEN: 'smoke-postmark-token',
    POSTMARK_FROM_EMAIL: 'alerts@example.test',
  };
  upsertSubscriber(db, { email: 'fanout@example.test', wantsEmail: true }, env);
  // Double opt-in: dispatch only reaches confirmed channels; this stage tests
  // dispatch filtering, so confirm directly.
  db.prepare('UPDATE notification_subscribers SET email_confirmed_at = CURRENT_TIMESTAMP').run();
  const insertAlert = db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAlert.run(
    'takeoff_batch',
    'watch',
    'global_business_jet',
    'local-dispatch-batch',
    '2026-06-23T00:00:00.000Z',
    'Raw takeoff batch',
    'Raw takeoff batch message',
    JSON.stringify({ signalFamily: 'takeoff_batch' }),
    'pending',
  );
  insertAlert.run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    'local-dispatch-rate',
    '2026-06-23T00:01:00.000Z',
    'Takeoff-rate anomaly',
    'Takeoff-rate anomaly message',
    JSON.stringify({ signalFamily: 'takeoff_rate' }),
    'pending',
  );
  insertAlert.run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    'local-dispatch-active-processing',
    '2026-06-23T00:02:00.000Z',
    'Active processing takeoff-rate anomaly',
    'Active processing takeoff-rate anomaly message',
    JSON.stringify({ signalFamily: 'takeoff_rate' }),
    'processing',
  );
  db.prepare("UPDATE alert_events SET dispatched_at = CURRENT_TIMESTAMP WHERE event_key = 'local-dispatch-active-processing'").run();

  const originalFetch = globalThis.fetch;
  const providerRequests = [];
  globalThis.fetch = async (url, options) => {
    providerRequests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('', { status: 202, headers: { 'x-message-id': 'local-dispatch-smoke' } });
  };
  try {
    const summary = await dispatchPendingAlerts(db, env, { limit: 10 });
    assert(summary.alerts === 1, 'Local dispatch did not limit work to alertable events.');
    assert(providerRequests.length === 1, 'Local dispatch sent raw telemetry or skipped the alertable anomaly.');
    const statuses = db.prepare('SELECT kind, event_key, status FROM alert_events ORDER BY kind ASC, event_key ASC').all();
    const rawBatch = statuses.find((event) => event.event_key === 'local-dispatch-batch');
    const rateAnomaly = statuses.find((event) => event.event_key === 'local-dispatch-rate');
    const activeProcessing = statuses.find((event) => event.event_key === 'local-dispatch-active-processing');
    assert(rawBatch?.status === 'observed', 'Local dispatch did not demote raw takeoff batch telemetry.');
    assert(rateAnomaly?.status === 'sent', 'Local dispatch did not send the alertable takeoff-rate anomaly.');
    assert(activeProcessing?.status === 'processing', 'Local dispatch reclaimed an active processing alert without a stale lease.');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
}


async function assertTakeoffRateDetection() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-takeoff-rate-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAtMs = Date.UTC(2026, 5, 23, 12, 0, 0);
  const observedAt = new Date(observedAtMs).toISOString();
  const halfHourMs = 30 * 60 * 1000;
  const insertMetric = db.prepare('INSERT INTO concurrent_metrics (sampled_at, concurrent_count) VALUES (?, ?)');
  const insertTakeoff = db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 337; index += 1) {
    const sampledAt = new Date(observedAtMs - (index * halfHourMs)).toISOString();
    insertMetric.run(sampledAt, 10);
    if (index % 56 === 0) {
      insertTakeoff.run(
        'global_business_jet',
        `abc${String(index).padStart(3, '0')}`,
        `N${index}`,
        `Baseline ${index}`,
        'smoke',
        sampledAt,
        new Date(observedAtMs - ((index + 1) * halfHourMs)).toISOString(),
        1400,
        150,
      );
    }
  }
  insertMetric.run(observedAt, 10);
  // Mark every fixture slot as live-ingested: the takeoff-rate baseline only
  // samples slots where the live snapshot process ran.
  db.prepare(`
    INSERT INTO ingest_slots (sampled_at, source, total_aircraft, cohort_airborne, live_ingested)
    SELECT sampled_at, 'adsbx_heatmap', 10000, concurrent_count, 1 FROM concurrent_metrics
  `).run();
  for (let index = 0; index < 5; index += 1) {
    insertTakeoff.run(
      'global_business_jet',
      `def${String(index).padStart(3, '0')}`,
      `N9${index}`,
      `Current ${index}`,
      'adsbx_heatmap',
      observedAt,
      new Date(observedAtMs - halfHourMs).toISOString(),
      1600 + index,
      180 + index,
    );
  }
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 10,
      baselineMean: 10,
      zScore: 0,
      emergencyLevel: 1,
    },
    signals: {
      composite: {
        emergencyLevel: 1,
        sigmaShift: 0,
        expectedConcurrentCount: 10,
      },
    },
  });

  const run = await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-rate-min-count',
    '3',
    '--takeoff-rate-min-samples',
    '336',
    '--takeoff-rate-min-days',
    '7',
    '--takeoff-rate-surprise',
    '3',
  ]);
  const output = JSON.parse(run.stdout.trim());
  assert(output.takeoffRateModelReady === true, 'Takeoff-rate detector did not report a ready baseline.');
  assert(output.takeoffRateSampleCount >= 336, 'Takeoff-rate detector did not use a week-long historical sample window.');
  assert(output.takeoffRateSampleDayCount >= 7, 'Takeoff-rate detector did not require distinct-day history.');
  assert(output.takeoffRateRequiredSampleCount >= 336, 'Takeoff-rate detector advertised too few required samples.');
  assert(output.takeoffRateRequiredDayCount >= 7, 'Takeoff-rate detector advertised too few required days.');
  assert(output.takeoffSurprise >= 3, 'Takeoff-rate detector did not score the burst as a 1-in-1,000 slot or rarer.');
  const alerts = db.prepare('SELECT kind, status, payload_json AS payloadJson FROM alert_events ORDER BY kind ASC').all();
  const kinds = alerts.map((event) => event.kind);
  const batchAlert = alerts.find((event) => event.kind === 'takeoff_batch');
  assert(batchAlert?.status === 'observed', 'Takeoff batch telemetry should not be pending alert fanout.');
  assert(kinds.includes('takeoff_rate_anomaly'), 'Takeoff detector did not create a takeoff-rate anomaly alert.');
  assert(alerts.find((event) => event.kind === 'takeoff_rate_anomaly')?.status === 'pending', 'Takeoff-rate anomaly was not queued for alert fanout.');
  assert(!kinds.includes('statistical_anomaly'), 'Takeoff detector emitted a concurrent statistical anomaly without an elevated level.');
  const ratePayload = JSON.parse(alerts.find((event) => event.kind === 'takeoff_rate_anomaly').payloadJson);
  assert(ratePayload.windowStart && ratePayload.windowEnd, 'Takeoff-rate anomaly did not include window bounds.');
  assert(ratePayload.signalFamily === 'takeoff_rate', 'Takeoff-rate anomaly did not include the signal family.');
  assert(ratePayload.takeoffCount === 5, 'Takeoff-rate anomaly recorded the wrong takeoff count.');
  db.close();
}

async function assertAlertEventDetectionPreservesDispatchState() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-alert-state-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAtMs = Date.UTC(2026, 5, 23, 12, 0, 0);
  const observedAt = new Date(observedAtMs).toISOString();
  const halfHourMs = 30 * 60 * 1000;
  const insertMetric = db.prepare('INSERT INTO concurrent_metrics (sampled_at, concurrent_count) VALUES (?, ?)');
  const insertTakeoff = db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 337; index += 1) {
    const sampledAt = new Date(observedAtMs - (index * halfHourMs)).toISOString();
    insertMetric.run(sampledAt, 10);
  }
  insertMetric.run(observedAt, 10);
  // Mark every fixture slot as live-ingested: the takeoff-rate baseline only
  // samples slots where the live snapshot process ran.
  db.prepare(`
    INSERT INTO ingest_slots (sampled_at, source, total_aircraft, cohort_airborne, live_ingested)
    SELECT sampled_at, 'adsbx_heatmap', 10000, concurrent_count, 1 FROM concurrent_metrics
  `).run();
  for (let index = 0; index < 5; index += 1) {
    insertTakeoff.run(
      'global_business_jet',
      `fed${String(index).padStart(3, '0')}`,
      `N8${index}`,
      `State Current ${index}`,
      'adsbx_heatmap',
      observedAt,
      new Date(observedAtMs - halfHourMs).toISOString(),
      1600 + index,
      180 + index,
    );
  }
  const windowStart = new Date(observedAtMs - halfHourMs).toISOString();
  const eventKey = `takeoff_rate_anomaly:global_business_jet:${windowStart}:${observedAt}`;
  db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status,
      dispatched_at,
      dispatch_summary_json,
      bridged_at,
      bridge_summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'takeoff_rate_anomaly',
    'high',
    'global_business_jet',
    eventKey,
    observedAt,
    'Old title',
    'Old message',
    JSON.stringify({ stale: true }),
    'sent',
    '2026-06-23T12:01:00.000Z',
    JSON.stringify({ sent: 2 }),
    '2026-06-23T12:02:00.000Z',
    JSON.stringify({ ok: true }),
  );
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 10,
      baselineMean: 10,
      zScore: 0,
      emergencyLevel: 1,
    },
    signals: {
      composite: {
        emergencyLevel: 1,
        sigmaShift: 0,
        expectedConcurrentCount: 10,
      },
    },
  });

  await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-rate-min-count',
    '3',
    '--takeoff-rate-min-samples',
    '336',
    '--takeoff-rate-min-days',
    '7',
    '--takeoff-rate-surprise',
    '3',
  ]);
  const alert = db.prepare('SELECT status, title, payload_json AS payloadJson, bridged_at AS bridgedAt FROM alert_events WHERE event_key = ?').get(eventKey);
  assert(alert.status === 'sent', 'Alert detector reset a dispatched alert event back to pending.');
  assert(alert.bridgedAt === '2026-06-23T12:02:00.000Z', 'Alert detector cleared existing bridge state.');
  assert(alert.title.includes('takeoffs vs'), 'Alert detector did not refresh event metadata while preserving dispatch state.');
  assert(JSON.parse(alert.payloadJson).takeoffCount === 5, 'Alert detector did not refresh the event payload while preserving dispatch state.');
  db.close();
}

async function assertSingleTakeoffDuringConcurrentAnomalySuppressed() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-single-takeoff-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAt = '2026-06-23T12:00:00.000Z';
  db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'global_business_jet',
    'abc123',
    'N123',
    'Single Current',
    'smoke',
    observedAt,
    '2026-06-23T11:30:00.000Z',
    1600,
    180,
  );
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 40,
      baselineMean: 10,
      zScore: 4,
      emergencyLevel: 4,
      modelReady: true,
      weeklyBaselineSampleCount: 336,
      requiredHistorySampleCount: 336,
    },
    signals: {
      composite: {
        emergencyLevel: 4,
        sigmaShift: 4,
        expectedConcurrentCount: 10,
        modelReady: true,
        weeklyBaselineSampleCount: 336,
        requiredHistorySampleCount: 336,
      },
    },
  });

  await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--takeoff-batch-min',
    '3',
    '--takeoff-anomaly-level',
    '4',
  ]);
  const alerts = db.prepare('SELECT kind FROM alert_events ORDER BY kind ASC').all();
  assert(alerts.length === 0, 'Single takeoff during a concurrent anomaly should not create an alert event.');
  db.close();
}

async function assertConcurrentAnomalyRequiresReadyBaseline() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-concurrent-readiness-'));
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const snapshotPath = path.join(tempRoot, 'dashboard.json');
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT_DIR, 'schema.sql'), 'utf8'));
  const observedAt = '2026-06-23T12:00:00.000Z';
  const insertTakeoff = db.prepare(`
    INSERT INTO takeoff_events (
      cohort,
      hex,
      registration,
      label,
      source,
      observed_at,
      previous_observed_at,
      altitude_ft,
      ground_speed_kt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 3; index += 1) {
    insertTakeoff.run(
      'global_business_jet',
      `abc12${index}`,
      `N12${index}`,
      `Sparse Current ${index}`,
      'adsbx_heatmap',
      observedAt,
      '2026-06-23T11:30:00.000Z',
      1600 + index,
      180 + index,
    );
  }
  writeJson(snapshotPath, {
    current: {
      asOf: observedAt,
      concurrentCount: 70,
      baselineMean: 10,
      zScore: 8,
      emergencyLevel: 5,
      modelReady: false,
      weeklyBaselineSampleCount: 1,
      requiredHistorySampleCount: 336,
    },
    signals: {
      composite: {
        emergencyLevel: 5,
        sigmaShift: 8,
        expectedConcurrentCount: 10,
        modelReady: false,
        weeklyBaselineSampleCount: 1,
        requiredHistorySampleCount: 336,
      },
    },
  });

  await execNode([
    'scripts/detect_alert_events.js',
    '--db',
    dbPath,
    '--snapshot',
    snapshotPath,
    '--cohort',
    'global_business_jet',
    '--anomaly-level',
    '5',
    '--takeoff-batch-min',
    '3',
    '--takeoff-anomaly-level',
    '4',
  ]);
  const alerts = db.prepare('SELECT kind, status FROM alert_events ORDER BY kind ASC').all();
  assert(alerts.length === 1 && alerts[0].kind === 'takeoff_batch' && alerts[0].status === 'observed', 'Underpowered concurrent baseline should only emit observed takeoff telemetry.');
  db.close();
}



async function assertAlertEventBridgePosts(dbPath, token, statusPath) {
  const alertEventKey = 'bridge-post-smoke-event';
  const db = new Database(dbPath);
  db.prepare(`
    INSERT INTO alert_events (
      kind,
      severity,
      cohort,
      event_key,
      occurred_at,
      title,
      message,
      payload_json,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `).run(
    'takeoff_rate_anomaly',
    'critical',
    'global_business_jet',
    alertEventKey,
    '2026-06-23T00:30:00.000Z',
    'Bridge post smoke',
    'Bridge post smoke message',
    JSON.stringify({ emergencyLevel: 4, takeoffCount: 9, signalFamily: 'takeoff_rate' }),
    'pending',
  );
  db.close();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const receivedPayloads = [];
  let receivedAuth = null;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, baseUrl);
    if (request.method !== 'POST' || requestUrl.pathname !== '/api/internal/alert-events') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    receivedAuth = request.headers.authorization || '';
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const receivedPayload = JSON.parse(text);
      receivedPayloads.push(receivedPayload);
      const events = Array.isArray(receivedPayload.events) ? receivedPayload.events : [receivedPayload.event];
      sendJson(response, 200, {
        ok: true,
        results: events.map((event) => ({ ok: true, eventKey: event.eventKey })),
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const bridgeArgs = [
      'scripts/bridge_alert_events.js',
      '--db',
      dbPath,
      '--limit',
      '5',
      '--url',
      `${baseUrl}/api/internal/alert-events`,
      '--status-path',
      statusPath,
    ];
    const bridgeRun = await execNode(bridgeArgs, { env: { ...process.env, INTERNAL_ALERT_TOKEN: token } });
    const bridgeOutput = JSON.parse(bridgeRun.stdout.trim());
    const bridgeStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert(receivedAuth === `Bearer ${token}`, 'Bridge did not authenticate with the configured internal token.');
    assert(receivedPayloads.length === 1, 'Bridge did not post exactly one request for one queued event.');
    assert(receivedPayloads[0]?.source === 'local_refresh', 'Bridge did not identify the local refresh source.');
    assert(Array.isArray(receivedPayloads[0]?.events), 'Bridge did not post an events array.');
    assert(receivedPayloads[0].events.length === 1, 'Bridge did not limit each bridge request to one event.');
    assert(receivedPayloads[0].events[0]?.eventKey === alertEventKey, 'Bridge did not post the queued alert event.');
    assert(bridgeOutput.ok === true && bridgeOutput.skipped === false, 'Bridge success run did not report ok=true.');
    assert(bridgeOutput.postedEvents === 1, 'Bridge success run did not report the single posted event.');
    assert(bridgeStatus.ok === true && bridgeStatus.skipped === false, 'Bridge status file did not persist successful posting.');

    const bridgedDb = new Database(dbPath);
    const bridged = bridgedDb.prepare('SELECT bridged_at AS bridgedAt, bridge_summary_json AS bridgeSummaryJson FROM alert_events WHERE event_key = ?').get(alertEventKey);
    bridgedDb.close();
    assert(bridged?.bridgedAt, 'Bridge did not mark the local alert event as bridged.');
    assert(JSON.parse(bridged.bridgeSummaryJson).ok === true, 'Bridge did not store the provider bridge response summary.');

    const secondBridgeRun = await execNode(bridgeArgs, { env: { ...process.env, INTERNAL_ALERT_TOKEN: token } });
    const secondBridgeOutput = JSON.parse(secondBridgeRun.stdout.trim());
    assert(secondBridgeOutput.skipped === true && secondBridgeOutput.reason === 'no_alert_events', 'Bridge reposted an already bridged alert event.');
    assert(receivedPayloads.length === 1, 'Bridge made a second POST for an already bridged alert event.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}


async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warning-watch-alert-smoke-'));
  const publishedDir = path.join(tempRoot, 'published');
  const dbPath = path.join(tempRoot, 'ews.sqlite');
  const bridgeStatusPath = path.join(tempRoot, 'bridge-status.json');
  const token = 'alert-pipeline-smoke-token';
  initTempDb(dbPath);
  writeJson(path.join(publishedDir, 'alerts.json'), { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 1 }] });
  writeJson(path.join(publishedDir, 'takeoffs.json'), { generatedAt: '2026-06-23T00:00:00.000Z', events: [{ id: 1 }] });
  writeJson(path.join(publishedDir, 'event-signals.json'), { generatedAt: '2026-06-23T00:00:00.000Z', records: [{ id: 'signal-1' }] });
  writeJson(path.join(publishedDir, 'alert-bridge-status.json'), {
    schemaVersion: 1,
    checkedAt: '2026-06-23T00:00:00.000Z',
    ok: true,
    skipped: true,
    reason: 'smoke_seed',
    webhookConfigured: false,
  });

  const port = await freePort();
  const vapidEnv = createSmokeVapidEnv();
  const pushSubscription = await createSmokePushSubscription();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    EWS_DB_PATH: dbPath,
    EWS_PUBLISHED_DIR: publishedDir,
    EWS_CLIENT_DIST_DIR: path.join(ROOT_DIR, 'dist'),
    EWS_PUBLIC_URL: 'https://alerts.example.test/',
    INTERNAL_ALERT_TOKEN: token,
    NOTIFICATION_HASH_SECRET: 'smoke-hash-secret',
    NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    POSTMARK_SERVER_TOKEN: 'smoke-postmark-token',
    POSTMARK_FROM_EMAIL: 'alerts@example.test',
    TELNYX_API_KEY: 'smoke-telnyx-key',
    TELNYX_NUMBER: '+14155552671',
    TELNYX_PUBLIC_KEY: 'smoke-telnyx-public-key',
    STRIPE_SECRET_KEY: 'sk_test_smoke',
    STRIPE_WEBHOOK_SECRET: 'whsec_smoke',
    STRIPE_PRICE_ID: 'price_smoke',
    TELEGRAM_BOT_TOKEN: 'smoke-telegram-token',
    TELEGRAM_CHANNEL: 'alerts-channel',
    WEB_PUSH_VAPID_PUBLIC_KEY: vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY,
    WEB_PUSH_VAPID_PRIVATE_KEY: vapidEnv.WEB_PUSH_VAPID_PRIVATE_KEY,
    WEB_PUSH_CONTACT: vapidEnv.WEB_PUSH_CONTACT,
  };
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverExit = new Promise((resolve) => {
    server.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/api/health`, { timeoutMs: 20_000 });
    const noConsentLocalSignup = await fetch(`${baseUrl}/api/notifications/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+14155552671' }),
    });
    assert(noConsentLocalSignup.status === 400, `Local SMS signup without consent returned ${noConsentLocalSignup.status}.`);


    const signupResponse = await fetch(`${baseUrl}/api/notifications/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'smoke@example.com', wantsEmail: true }),
    });
    if (!signupResponse.ok) {
      throw new Error(`Signup failed with HTTP ${signupResponse.status}: ${await signupResponse.text()}`);
    }
    const signup = await signupResponse.json();
    assert(signup.managementPath, 'Signup did not return a management path.');

    const managePageUrl = new URL(signup.managementPath, baseUrl);
    const manageApiUrl = new URL('/api/manage/subscriber', baseUrl);
    manageApiUrl.search = managePageUrl.search;
    const manage = await waitForJson(manageApiUrl.toString());
    assert(manage.payload.subscriber.email === 'smoke@example.com', 'Management endpoint did not return the signed-up subscriber.');

    const pushKey = await waitForJson(`${baseUrl}/api/push/vapid-public-key`);
    assert(pushKey.payload.publicKey === vapidEnv.WEB_PUSH_VAPID_PUBLIC_KEY, 'Push public key endpoint did not return the configured VAPID key.');
    const pushSignup = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: pushSubscription }),
    });
    if (!pushSignup.ok) {
      throw new Error(`Push signup failed with HTTP ${pushSignup.status}: ${await pushSignup.text()}`);
    }
    const pushSignupPayload = await pushSignup.json();
    assert(pushSignupPayload.pushEnabled === true, 'Push signup endpoint did not enable browser push.');

    // Double opt-in: the email subscriber counts as active only after
    // confirming. Compute the documented confirm token (HMAC over
    // confirm:<channel>:<id>:<created_at>) and walk the live confirm route.
    const smokeDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    let emailSubscriber;
    try {
      emailSubscriber = smokeDb
        .prepare('SELECT id, created_at FROM notification_subscribers WHERE email_enabled = 1 ORDER BY id DESC LIMIT 1')
        .get();
    } finally {
      smokeDb.close();
    }
    assert(emailSubscriber, 'Signup did not create a subscriber row.');
    const confirmToken = nodeCrypto
      .createHmac('sha256', 'smoke-hash-secret')
      .update(`confirm:email:${emailSubscriber.id}:${emailSubscriber.created_at}`)
      .digest('hex');
    const confirmResponse = await fetch(
      `${baseUrl}/api/notifications/confirm?subscriber=${emailSubscriber.id}&channel=email&token=${confirmToken}`,
    );
    assert(confirmResponse.ok, `Email confirmation returned HTTP ${confirmResponse.status}.`);
    const confirmPayload = await confirmResponse.json();
    assert(confirmPayload.confirmed === true, 'Confirm endpoint did not confirm the email channel.');
    const badTokenResponse = await fetch(
      `${baseUrl}/api/notifications/confirm?subscriber=${emailSubscriber.id}&channel=email&token=${'0'.repeat(64)}`,
    );
    assert(badTokenResponse.status === 403, `Bad confirm token returned ${badTokenResponse.status}, not 403.`);

    const unauthorizedStatus = await fetch(`${baseUrl}/api/admin/local-pipeline-status`);
    assert(unauthorizedStatus.status === 401, `Pipeline status without auth returned ${unauthorizedStatus.status}, not 401.`);
    const authorized = await waitForJson(`${baseUrl}/api/admin/local-pipeline-status`, {
      fetchOptions: { headers: { authorization: `Bearer ${token}` } },
    });
    assert(authorized.payload.localDispatch.activeSubscriberCount === 2, 'Pipeline status did not count the active email and push subscribers.');
    assert(authorized.payload.feeds.eventSignals.itemCount === 1, 'Pipeline status did not summarize event signal records.');
    assert(authorized.payload.bridge.reason === 'smoke_seed', 'Pipeline status did not surface bridge health.');
    assert(authorized.payload.providerConfig.emailConfigured === true, 'Pipeline status did not report email as configured.');
    assert(authorized.payload.providerConfig.telnyxConfigured === true, 'Pipeline status did not report Telnyx as configured.');
    assert(authorized.payload.providerConfig.telegramEmergencyConfigured === true, 'Pipeline status did not report emergency Telegram as configured from TELEGRAM_CHANNEL.');
    assert(authorized.payload.providerConfig.webPushConfigured === true, 'Pipeline status did not report browser push as configured.');
    assert(authorized.payload.notificationCryptoConfigured === true, 'Pipeline status did not report notification crypto as configured.');

    const eventSignals = await waitForJson(`${baseUrl}/api/event-signals`);
    assert(eventSignals.payload.records.length === 1, 'Event signals API did not return the published record.');
    const alertsFeed = await waitForJson(`${baseUrl}/alerts.json`);
    assert(alertsFeed.payload.events.length === 1, 'Alerts JSON route did not return the published event.');


    await assertAlertEventBridgePosts(dbPath, token, path.join(tempRoot, 'bridge-post-status.json'));
    const bridgeRun = await execNode(
      ['scripts/bridge_alert_events.js', '--db', dbPath, '--limit', '1', '--url', '', '--status-path', bridgeStatusPath],
      { env: { ...process.env, EWS_ALERT_EVENTS_WEBHOOK_URL: '', INTERNAL_ALERT_TOKEN: token } },
    );
    const bridgeOutput = JSON.parse(bridgeRun.stdout.trim());
    const bridgeStatus = JSON.parse(fs.readFileSync(bridgeStatusPath, 'utf8'));
    assert(bridgeOutput.reason === 'missing_EWS_ALERT_EVENTS_WEBHOOK_URL', 'Bridge missing-url run did not report the expected reason.');
    assert(bridgeStatus.reason === bridgeOutput.reason, 'Bridge status file did not persist the latest result.');

    await assertTakeoffRateDetection();
    await assertAlertEventDetectionPreservesDispatchState();
    await assertSingleTakeoffDuringConcurrentAnomalySuppressed();
    await assertConcurrentAnomalyRequiresReadyBaseline();
    await assertLocalDispatchSkipsRawTakeoffTelemetry();
    console.log(JSON.stringify({ ok: true, baseUrl, tempRoot }));
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
    }
    const exit = await serverExit;
    if (exit.code !== 0 && exit.signal !== 'SIGTERM') {
      throw new Error(`Smoke server exited with ${exit.code || exit.signal}: ${serverOutput}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
