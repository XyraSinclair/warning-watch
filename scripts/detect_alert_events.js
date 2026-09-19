#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_TAKEOFF_RATE_MIN_DAYS = 7;
const DEFAULT_CONCURRENT_MIN_HISTORY_SAMPLES = 7 * 48;

function envNumber(name, fallback = null) {
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
}

function parseArgs(argv) {
  const args = {
    db: null,
    snapshot: null,
    cohort: null,
    eventsDb: null,
    anomalyLevel: Number(process.env.EWS_ANOMALY_ALERT_LEVEL || 5),
    takeoffBatchMin: Number(process.env.EWS_TAKEOFF_BATCH_MIN || 3),
    takeoffAnomalyLevel: Number(process.env.EWS_TAKEOFF_ANOMALY_LEVEL || 4),
    takeoffWindowMinutes: Number(process.env.EWS_TAKEOFF_WINDOW_MINUTES || 30),
    takeoffRateLookbackDays: Number(process.env.EWS_TAKEOFF_RATE_LOOKBACK_DAYS || 28),
    takeoffRateMinSamples: envNumber('EWS_TAKEOFF_RATE_MIN_SAMPLES'),
    takeoffRateMinDays: envNumber('EWS_TAKEOFF_RATE_MIN_DAYS', DEFAULT_TAKEOFF_RATE_MIN_DAYS),
    takeoffRateMinCount: Number(process.env.EWS_TAKEOFF_RATE_MIN_COUNT || 3),
    // Surprise at which a slot is recorded as an operator-surface event:
    // 2 = a 1-in-100 slot, about one every two days.
    takeoffRateSurprise: Number(process.env.EWS_TAKEOFF_RATE_SURPRISE || 2),
    // The takeoff-rate detector counts one consistent process: ground->air
    // transitions seen by the live slot ingester. Trace-backfilled events
    // (source adsbx_history, ~45x denser) must never enter the numerator or
    // the baseline, or every repair pass that touches the current window
    // manufactures a false critical.
    takeoffLiveSource: process.env.EWS_TAKEOFF_LIVE_SOURCE || 'adsbx_heatmap',
    // Tuned 2026-08-28 against 66d of box data with robust (median/MAD)
    // concurrent baselines: k=1.5 h=12 crit=20 fires high twice (the two
    // hottest real sustained days), never critical on history, while a 3x
    // exodus reaches S~13 within one hour and crosses critical soon after.
    cusumK: Number(process.env.EWS_CUSUM_K || 1.5),
    cusumThreshold: Number(process.env.EWS_CUSUM_THRESHOLD || 12),
    cusumCritical: Number(process.env.EWS_CUSUM_CRITICAL || 20),
    dataQualityMinRatio: Number(process.env.EWS_DATA_QUALITY_MIN_RATIO || 0.6),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--events-db') {
      args.eventsDb = argv[++index];
    } else if (value === '--snapshot') {
      args.snapshot = argv[++index];
    } else if (value === '--cohort') {
      args.cohort = argv[++index];
    } else if (value === '--anomaly-level') {
      args.anomalyLevel = Number(argv[++index]);
    } else if (value === '--takeoff-batch-min') {
      args.takeoffBatchMin = Number(argv[++index]);
    } else if (value === '--takeoff-anomaly-level') {
      args.takeoffAnomalyLevel = Number(argv[++index]);
    } else if (value === '--takeoff-window-minutes') {
      args.takeoffWindowMinutes = Number(argv[++index]);
    } else if (value === '--takeoff-rate-lookback-days') {
      args.takeoffRateLookbackDays = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-samples') {
      args.takeoffRateMinSamples = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-count') {
      args.takeoffRateMinCount = Number(argv[++index]);
    } else if (value === '--takeoff-rate-min-days') {
      args.takeoffRateMinDays = Number(argv[++index]);
    } else if (value === '--takeoff-rate-surprise') {
      args.takeoffRateSurprise = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!args.db || !args.snapshot || !args.cohort) {
    throw new Error('Usage: node scripts/detect_alert_events.js --db path [--events-db path] --snapshot path --cohort id');
  }

  args.eventsDb ||= args.db;

  return args;
}

function loadSnapshot(snapshotPath) {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function finiteNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
function hasReadyConcurrentBaseline(snapshot) {
  const current = snapshot.current || {};
  const composite = snapshot.signals?.composite || {};
  const explicitModelReady = composite.modelReady ?? current.modelReady;
  const sampleCount = finiteNumber(
    composite.weeklyBaselineSampleCount ??
      composite.baselineHistorySampleCount ??
      current.weeklyBaselineSampleCount ??
      current.baselineHistorySampleCount ??
      composite.historySampleCount ??
      current.historySampleCount,
    0,
  );
  const requiredSampleCount = Math.max(
    1,
    finiteNumber(
      composite.requiredHistorySampleCount ?? current.requiredHistorySampleCount,
      DEFAULT_CONCURRENT_MIN_HISTORY_SAMPLES,
    ),
  );
  return {
    ready: explicitModelReady === true && sampleCount >= requiredSampleCount,
    modelReady: explicitModelReady === true,
    sampleCount,
    requiredSampleCount,
  };
}


function parseIso(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} is not a valid ISO timestamp: ${value}`);
  }
  return parsed;
}

function isoOffset(value, offsetMs) {
  return new Date(parseIso(value, 'timestamp').getTime() + offsetMs).toISOString();
}

function medianOf(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median + MAD-derived sigma: a past anomaly in the lookback cannot drag the
// baseline the way it drags a plain mean/stddev. Sigma is floored at the
// Poisson noise floor sqrt(median) and at 1 so near-constant groups cannot
// produce runaway z-scores.
function robustStats(values) {
  const median = medianOf(values);
  const mad = medianOf(values.map((value) => Math.abs(value - median)));
  const rawSigma = 1.4826 * mad;
  return {
    median,
    rawSigma,
    sigma: Math.max(rawSigma, Math.sqrt(Math.max(median, 1)), 1),
    sampleCount: values.length,
  };
}

// "1-in-N" with two significant figures: 3.16 -> "1,500".
function formatOdds(surprise) {
  const odds = 10 ** Math.min(surprise, 15);
  const scale = 10 ** Math.max(0, Math.floor(Math.log10(odds)) - 1);
  return (Math.round(odds / scale) * scale).toLocaleString('en-US');
}

// "global_business_jet" -> "business-jet": alert copy is read by the public.
function cohortLabel(cohort) {
  return { global_business_jet: 'business-jet', global_military_aircraft: 'military', non_icao_untracked: 'non-ICAO' }[cohort]
    || String(cohort).replace(/_/g, ' ');
}

function formatDecimal(value, digits = 1) {
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

// Takeoffs per slot are small counts (1-14 on a normal day), so they are
// scored as counts, not as sigmas: a z-score reads "5 against 0.8 expected"
// as 4.2 sigma when it is ordinary night-time noise. Measured on the live
// record (52 days, 19 Sept 2026) the process is near-Poisson, dispersion
// 1.0-2.3 in every hour, and this tail is calibrated: nominal 0.1 / 0.01 /
// 0.001 occurred in 0.088 / 0.0088 / 0.0008 of slots.
//
// P(X >= count) for a count with mean `mean` and variance `dispersion * mean`:
// negative binomial, Poisson in the limit dispersion -> 1. The upper tail is
// summed directly so a probability of 1e-40 keeps its precision.
function countUpperTail(count, mean, dispersion) {
  if (!(count > 0)) return 1;
  const mu = Math.max(mean, 1e-9);
  const poisson = !(dispersion > 1 + 1e-6);
  const size = poisson ? 0 : mu / (dispersion - 1);
  const logFailure = poisson ? 0 : Math.log(1 - 1 / dispersion);
  let logTerm = poisson ? -mu : -size * Math.log(dispersion);
  let tail = 0;
  for (let index = 0; index < count + 5000; index += 1) {
    if (index >= count) {
      const term = Math.exp(logTerm);
      tail += term;
      if (index > mu && term < tail * 1e-17) break;
    }
    logTerm += poisson
      ? Math.log(mu / (index + 1))
      : Math.log((size + index) / (index + 1)) + logFailure;
  }
  return Math.min(1, Math.max(tail, Number.MIN_VALUE));
}

// Surprise = -log10 of the tail probability: 2 is a 1-in-100 slot, 4 a
// 1-in-10,000 slot. `baseline` is the buildTakeoffBaseline result.
function takeoffSurprise(count, baseline) {
  return -Math.log10(countUpperTail(count, baseline.expectedTakeoffCount, baseline.takeoffDispersion));
}

// A past burst or an ingest cold start (24 June 2026: twenty slots of 100-567
// "takeoffs") must not set the rate or the dispersion for the next 28 days.
function clipCounts(values) {
  const median = medianOf(values);
  const cap = median + 4 * Math.sqrt(Math.max(median, 1));
  return values.map((value) => Math.min(value, cap));
}

const SLOTS_PER_YEAR = 365 * 48;
// Public alerts this detector may raise per year, per tier. Everything below
// is derived from these three numbers.
const TAKEOFF_ALERT_BUDGET_PER_YEAR = { elevated: 12, high: 4, critical: 1 };
// A record shorter than this cannot certify the elevated rate, so it is not
// consulted; the calibrated model thresholds stand alone.
const TAKEOFF_RECORD_MIN_SAMPLES = Math.ceil(SLOTS_PER_YEAR / TAKEOFF_ALERT_BUDGET_PER_YEAR.elevated);
// The record guards against a miscalibrated model, which shifts the bulk of
// scores by a fraction of a decade. It may not lift a threshold by more than
// this many decades, or the first day of a real event would mute the second.
const TAKEOFF_RECORD_MAX_LIFT = 2;
// Second gate (see "How detection works" on the page): the public tiers need
// the stated magnitude, a 3x exodus, not only an improbable count.
const TAKEOFF_EXODUS_RATIO = 3;

function takeoffSeverity(surprise, ladder) {
  for (const severity of ['critical', 'high', 'elevated']) {
    if (surprise >= ladder.model[severity] && (!ladder.record || surprise > ladder.record[severity])) {
      return severity;
    }
  }
  return 'watch';
}

function ensureSlotScores(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('slot_scores')").all().map((column) => column.name);
  if (columns.includes('takeoff_rate_z')) {
    // Pre-19-Sept rows hold z-scores, not comparable with surprise. The
    // record is regenerated by `backtest_detector.js --write-scores`.
    db.exec('DROP TABLE slot_scores');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS slot_scores (
      cohort TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      takeoff_surprise REAL,
      count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cohort, sampled_at)
    )
  `);
}

function recordSlotScore(db, cohort, sampledAt, surprise, count) {
  db.prepare(`
    INSERT INTO slot_scores (cohort, sampled_at, takeoff_surprise, count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cohort, sampled_at) DO UPDATE SET
      takeoff_surprise = excluded.takeoff_surprise,
      count = excluded.count
  `).run(cohort, parseIso(sampledAt, 'sampledAt').toISOString(), surprise, count);
}

// Two thresholds per tier, and a slot must clear both. `model` is the budget
// turned into a tail probability (12 a year = p <= 12/17,520 = surprise 3.16).
// `record` is the same budget read off the trailing year of actual scores:
// strictly exceeding the k-th largest of n puts a new slot in the top k, a
// rate of k/(n+1) per slot, with k = floor(budget * n / slots-per-year) so
// the rate never exceeds the budget. While the record is too short to hold
// even one budgeted slot for a tier (k = 0), that tier must beat the maximum.
function takeoffModelThresholds() {
  return Object.fromEntries(Object.entries(TAKEOFF_ALERT_BUDGET_PER_YEAR).map(
    ([severity, perYear]) => [severity, -Math.log10(perYear / SLOTS_PER_YEAR)],
  ));
}

function getTakeoffLadder(db, cohort, observedAt) {
  ensureSlotScores(db);
  const model = takeoffModelThresholds();
  // Exclude the evaluated slot (including reruns) and future replay rows.
  const parameters = {
    cohort,
    start: isoOffset(observedAt, -365 * DAY_MS),
    end: parseIso(observedAt, 'observedAt').toISOString(),
  };
  const scores = db.prepare(`
    SELECT takeoff_surprise AS surprise
    FROM slot_scores
    WHERE cohort = @cohort AND sampled_at >= @start AND sampled_at < @end
      AND takeoff_surprise IS NOT NULL
    ORDER BY takeoff_surprise DESC
    LIMIT @limit
  `);
  const samples = db.prepare(`
    SELECT COUNT(*) AS samples
    FROM slot_scores
    WHERE cohort = @cohort AND sampled_at >= @start AND sampled_at < @end
      AND takeoff_surprise IS NOT NULL
  `).get(parameters).samples;
  const ladder = { budgetPerYear: TAKEOFF_ALERT_BUDGET_PER_YEAR, model, samples, record: null };
  if (samples >= TAKEOFF_RECORD_MIN_SAMPLES) {
    const top = scores.all({ ...parameters, limit: TAKEOFF_ALERT_BUDGET_PER_YEAR.elevated }).map((row) => row.surprise);
    ladder.record = Object.fromEntries(Object.entries(TAKEOFF_ALERT_BUDGET_PER_YEAR).map(([severity, perYear]) => {
      const k = Math.floor(perYear * samples / SLOTS_PER_YEAR);
      return [severity, Math.min(top[Math.max(k, 1) - 1], model[severity] + TAKEOFF_RECORD_MAX_LIFT)];
    }));
  }
  return ladder;
}

function getTakeoffWindow(observedAt, windowMinutes) {
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60 * 1000;
  const windowEnd = parseIso(observedAt, 'observedAt');
  const windowStart = new Date(windowEnd.getTime() - windowMs);
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs,
    windowMinutes: Math.round(windowMs / 60000),
  };
}

function defaultTakeoffRateMinSamples(windowMinutes) {
  const safeWindowMinutes = Math.max(1, Number(windowMinutes) || 30);
  return Math.ceil((DEFAULT_TAKEOFF_RATE_MIN_DAYS * 24 * 60) / safeWindowMinutes);
}

function severityForLevel(level) {
  if (level >= 5) return 'critical';
  if (level >= 4) return 'high';
  if (level >= 3) return 'elevated';
  return 'watch';
}

function findExistingEvent(db, event) {
  return db
    .prepare(`
      SELECT id, event_key AS eventKey, status
      FROM alert_events
      WHERE event_key = @eventKey
         OR (kind = @kind AND cohort = @cohort AND occurred_at = @occurredAt)
      ORDER BY CASE WHEN event_key = @eventKey THEN 0 ELSE 1 END
      LIMIT 1
    `)
    .get(event);
}

function updateExistingEvent(db, existing, event) {
  if (!existing) {
    return;
  }

  db.prepare(`
    UPDATE alert_events
    SET
      event_key = @eventKey,
      severity = @severity,
      title = @title,
      message = @message,
      payload_json = @payloadJson,
      status = CASE
        WHEN status IN ('processing', 'sent', 'no_recipients', 'partial', 'failed') THEN status
        ELSE @status
      END
    WHERE id = @id
  `).run({ ...event, id: existing.id });
}

function insertAlertEvent(db, event) {
  const existing = findExistingEvent(db, event);
  if (existing) {
    updateExistingEvent(db, existing, event);
    return false;
  }

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
    ) VALUES (
      @kind,
      @severity,
      @cohort,
      @eventKey,
      @occurredAt,
      @title,
      @message,
      @payloadJson,
      @status
    )
  `).run(event);
  return true;
}

function getTakeoffEvents(db, cohort, observedAt, windowMinutes, liveSource) {
  const window = getTakeoffWindow(observedAt, windowMinutes);
  const rows = db
    .prepare(`
      SELECT
        id,
        hex,
        registration,
        label,
        observed_at AS observedAt,
        previous_observed_at AS previousObservedAt,
        lat,
        lon,
        altitude_ft AS altitudeFt,
        ground_speed_kt AS groundSpeedKt
      FROM takeoff_events
      WHERE cohort = ?
        AND source = ?
        AND CAST(strftime('%s', observed_at) AS INTEGER) > CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', observed_at) AS INTEGER) <= CAST(strftime('%s', ?) AS INTEGER)
      ORDER BY observed_at DESC, label ASC
    `)
    .all(cohort, liveSource, window.windowStart, window.windowEnd);
  const byHex = new Map();
  for (const row of rows) {
    if (!byHex.has(row.hex)) {
      byHex.set(row.hex, row);
    }
  }
  return {
    ...window,
    takeoffs: Array.from(byHex.values()).sort((left, right) => {
      const leftLabel = left.label || left.registration || left.hex;
      const rightLabel = right.label || right.registration || right.hex;
      return leftLabel.localeCompare(rightLabel);
    }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TAKEOFF_BASELINE_MIN_GROUP_SAMPLES = 6;

function takeoffDayClass(utcDay) {
  return utcDay === 0 || utcDay === 6 ? 'weekend' : 'weekday';
}

// Databases created before the provenance table (or opened read-only where
// schema.sql cannot run) simply have no provenance — the model then treats
// every slot as unknown-provenance, which is the pre-provenance behavior.
function hasIngestSlotsTable(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_slots'").get(),
  );
}

// Final-slice provenance is the takeoff clock. Concurrent metrics may instead
// carry an independently timed peak; joining through them loses valid zeroes.
// Like transition windows, the requested observation range is (start, end].
function loadTakeoffSlots(db, cohort, liveSource, start, end) {
  if (!hasIngestSlotsTable(db)) {
    return [];
  }
  // Require the time index: the covering uniqueness index otherwise permits a
  // cohort-wide scan for every slot on production-sized histories.
  const rows = db.prepare(`
    SELECT
      s.sampled_at AS sampledAt,
      s.source,
      s.total_aircraft AS totalAircraft,
      s.live_ingested AS liveIngested,
      (
        SELECT COUNT(DISTINCT t.hex)
        FROM takeoff_events t INDEXED BY idx_takeoff_events_cohort_time
        WHERE t.cohort = ?
          AND t.source = ?
          AND t.observed_at = s.sampled_at
      ) AS takeoffCount
    FROM ingest_slots s
    WHERE unixepoch(s.sampled_at) > unixepoch(?)
      AND unixepoch(s.sampled_at) <= unixepoch(?)
    ORDER BY unixepoch(s.sampled_at)
  `).all(cohort, liveSource, start, end);
  for (const row of rows) {
    row.sampledAtMs = parseIso(row.sampledAt, 'sampledAt').getTime();
  }
  return rows;
}

// Seasonal robust baseline for the live takeoff-rate process. Windows are
// grouped by (weekday-vs-weekend, slot-of-day) so a normal morning wave is
// compared against other mornings, not against the flat 24h average that made
// every busy morning read hot. Group statistics are median/MAD (robustStats).
// Tier ladder when a group is thin: (dayClass, slot) -> slot across all days
// -> global.
function getTakeoffRateStats(db, cohort, observedAt, options) {
  const window = getTakeoffWindow(observedAt, options.takeoffWindowMinutes);
  const lookbackStart = isoOffset(window.windowStart, -Math.max(1, options.takeoffRateLookbackDays) * DAY_MS);
  const rows = loadTakeoffSlots(db, cohort, options.takeoffLiveSource, lookbackStart, window.windowStart);

  return {
    ...buildTakeoffBaseline(rows, window, options),
    lookbackStart,
    lookbackDays: options.takeoffRateLookbackDays,
  };
}

// Pure baseline computation over prefetched rows
// [{ sampledAt, takeoffCount, liveIngested }] — shared by live detection and
// the backtest harness (which fetches the whole replay range once instead of
// re-querying per slot).
function buildTakeoffBaseline(rows, window, options) {
  // Only slots where the live snapshot process actually ran are valid
  // samples of the live takeoff process. Anything else — trace-backfilled
  // outages, pre-provenance laptop-era history — carries a structural zero
  // that dragged group medians to 0 and made the first backtest read normal
  // afternoons as 8-17 sigma. Strict gating means the model is simply not
  // ready until enough live-marked slots exist (calm-by-default).
  const usableRows = rows.filter((row) => Number(row.liveIngested) === 1);

  const bucketCounts = new Map();
  for (const row of usableRows) {
    const bucket = Math.floor(parseIso(row.sampledAt, 'sampledAt').getTime() / window.windowMs);
    bucketCounts.set(bucket, Number(bucketCounts.get(bucket) || 0) + Number(row.takeoffCount || 0));
  }

  const groups = new Map();
  const slotGroups = new Map();
  const allCounts = [];
  for (const [bucket, count] of bucketCounts) {
    const bucketStart = new Date(bucket * window.windowMs);
    const slotOfDay = Math.floor((bucket * window.windowMs) % DAY_MS / window.windowMs);
    const groupKey = `${takeoffDayClass(bucketStart.getUTCDay())}:${slotOfDay}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(count);
    if (!slotGroups.has(slotOfDay)) {
      slotGroups.set(slotOfDay, []);
    }
    slotGroups.get(slotOfDay).push(count);
    allCounts.push(count);
  }

  // Historical buckets are labeled by their observation/window end, not start.
  // Use the same clock here, including the day class across midnight.
  const windowEndDate = parseIso(window.windowEnd, 'windowEnd');
  const windowBucket = Math.floor(windowEndDate.getTime() / window.windowMs);
  const windowSlotOfDay = Math.floor((windowBucket * window.windowMs) % DAY_MS / window.windowMs);
  const windowDayClass = takeoffDayClass(windowEndDate.getUTCDay());
  const windowGroupKey = `${windowDayClass}:${windowSlotOfDay}`;

  let baselineTier = 'day_class_slot';
  let baselineValues = groups.get(windowGroupKey) || [];
  if (baselineValues.length < TAKEOFF_BASELINE_MIN_GROUP_SAMPLES) {
    baselineTier = 'slot';
    baselineValues = slotGroups.get(windowSlotOfDay) || [];
  }
  if (baselineValues.length < TAKEOFF_BASELINE_MIN_GROUP_SAMPLES) {
    baselineTier = 'global';
    baselineValues = allCounts;
  }
  // Rate: mean of the clipped group, with half a count of prior so a group of
  // zeros is a low rate, not an impossible one.
  const clippedBaseline = clipCounts(baselineValues);
  const expectedTakeoffCount = (clippedBaseline.reduce((sum, value) => sum + value, 0) + 0.5) / Math.max(clippedBaseline.length, 1);
  // Dispersion: Pearson chi-square pooled over every (day class, slot) group in
  // the lookback. One group of ~20 samples cannot estimate a variance; all of
  // them together can. Floored at 1, the Poisson limit.
  let chiSquare = 0;
  let degreesOfFreedom = 0;
  for (const values of groups.values()) {
    if (values.length < 3) continue;
    const clipped = clipCounts(values);
    const mean = clipped.reduce((sum, value) => sum + value, 0) / clipped.length;
    if (!(mean > 0)) continue;
    chiSquare += clipped.reduce((sum, value) => sum + (value - mean) ** 2, 0) / mean;
    degreesOfFreedom += clipped.length - 1;
  }
  const takeoffDispersion = degreesOfFreedom > 0 ? Math.max(1, chiSquare / degreesOfFreedom) : 1;

  const sampleDays = new Set(usableRows.map((row) => parseIso(row.sampledAt, 'sampledAt').toISOString().slice(0, 10)));
  const requiredSampleCount = Math.max(
    defaultTakeoffRateMinSamples(options.takeoffWindowMinutes),
    Number(options.takeoffRateMinSamples) || 0,
    1,
  );
  const requiredDayCount = Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(Number(options.takeoffRateLookbackDays) || 1)),
      Math.floor(Number(options.takeoffRateMinDays) || DEFAULT_TAKEOFF_RATE_MIN_DAYS),
    ),
  );
  const modelReady = allCounts.length >= requiredSampleCount && sampleDays.size >= requiredDayCount;
  return {
    model: 'takeoff-rate-seasonal-negbin',
    modelReady,
    sampleCount: allCounts.length,
    sampleDayCount: sampleDays.size,
    requiredSampleCount,
    requiredDayCount,
    expectedTakeoffCount,
    takeoffDispersion,
    baselineTier,
    baselineDayClass: windowDayClass,
    baselineSlotOfDay: windowSlotOfDay,
    baselineGroupSampleCount: baselineValues.length,
    nonLiveSlotsExcluded: rows.length - usableRows.length,
  };
}

// L0 data-quality gate. The live ingester records how many aircraft the
// global feed carried in each slot (ingest_slots.total_aircraft) — a
// cohort-independent denominator. A collapsed feed shrinks every count, and
// the statistical layers would read that infrastructure failure as an
// anomaly (or mask a real one), so detection is suppressed instead and the
// degradation is surfaced as its own event.
//
// Statuses:
//   ok         - current slot is live and the feed volume is normal
//   degraded   - current slot is live but the feed carried under
//                dataQualityMinRatio x the recent same-slot median
//   stale_live - current slot came from trace backfill (live ingester did
//                not run); the takeoff-rate process has no data
//   unknown    - provenance, global total, or reference history is absent
function getDataQuality(db, observedAt, options) {
  if (!hasIngestSlotsTable(db)) {
    return { status: 'unknown', liveSlot: false };
  }
  const lookbackStart = isoOffset(observedAt, -14 * DAY_MS);
  const current = db
    .prepare(`
      SELECT source, total_aircraft AS totalAircraft, live_ingested AS liveIngested
      FROM ingest_slots
      WHERE CAST(strftime('%s', sampled_at) AS INTEGER) = CAST(strftime('%s', ?) AS INTEGER)
    `)
    .get(observedAt);
  const referenceRows = db
    .prepare(`
      SELECT sampled_at AS sampledAt, total_aircraft AS totalAircraft, live_ingested AS liveIngested
      FROM ingest_slots
      WHERE live_ingested = 1
        AND total_aircraft IS NOT NULL
        AND CAST(strftime('%s', sampled_at) AS INTEGER) >= CAST(strftime('%s', ?) AS INTEGER)
        AND CAST(strftime('%s', sampled_at) AS INTEGER) < CAST(strftime('%s', ?) AS INTEGER)
    `)
    .all(lookbackStart, observedAt);
  return buildDataQuality(current, referenceRows, observedAt, options);
}

// Shared by live detection and replay; unknown coverage is not a healthy feed.
function buildDataQuality(current, referenceRows, observedAt, options) {
  if (!current) {
    return { status: 'unknown', liveSlot: false };
  }
  if (Number(current.liveIngested) !== 1) {
    return { status: 'stale_live', liveSlot: false, slotSource: current.source };
  }
  const observedAtMs = parseIso(observedAt, 'observedAt').getTime();
  const lookbackStartMs = observedAtMs - 14 * DAY_MS;
  const windowMs = Math.max(1, Number(options.takeoffWindowMinutes) || 30) * 60 * 1000;
  const currentSlot = Math.floor((observedAtMs % DAY_MS) / windowMs);
  const reference = [];
  for (const row of referenceRows) {
    if (Number(row.liveIngested) !== 1 || row.totalAircraft == null || !Number.isFinite(Number(row.totalAircraft))) {
      continue;
    }
    const sampledAtMs = row.sampledAtMs ?? parseIso(row.sampledAt, 'sampledAt').getTime();
    if (sampledAtMs >= lookbackStartMs && sampledAtMs < observedAtMs &&
        Math.floor((sampledAtMs % DAY_MS) / windowMs) === currentSlot) {
      reference.push(Number(row.totalAircraft));
    }
  }
  const referenceMedian = medianOf(reference);
  const base = {
    liveSlot: true,
    currentTotal: current.totalAircraft == null ? null : Number(current.totalAircraft),
    referenceMedian,
    referenceCount: reference.length,
    minRatio: options.dataQualityMinRatio,
  };
  if (base.currentTotal == null || !Number.isFinite(base.currentTotal) || reference.length < 8) {
    return { ...base, status: 'unknown' };
  }
  if (base.currentTotal < options.dataQualityMinRatio * referenceMedian) {
    return { ...base, status: 'degraded' };
  }
  return { ...base, status: 'ok' };
}

// Sustained-shift detector: one-sided CUSUM over the concurrent model's
// sigma-shift, S <- max(0, S + clamp(z) - k). A slow exodus that never
// spikes past the instantaneous alarm threshold still accumulates here.
// State persists in meta so it survives process restarts; the step only
// advances when the sample timestamp advances, so re-runs are idempotent.
// Crossing cusumThreshold fires once (high), cusumCritical escalates once
// (critical); both re-arm after S falls below half the threshold.
// The pure accumulation law, shared with the backtest harness. The input
// shift is clamped so a single wild sample cannot teleport the accumulator.
function cusumStep(previousS, sigmaShift, k) {
  const clampedShift = Math.max(-4, Math.min(8, finiteNumber(sigmaShift)));
  return Math.max(0, finiteNumber(previousS) + clampedShift - k);
}

// First-year calendar gate: inside a US-holiday window the calendar model
// has not yet learned (zero prior samples, effective weight 0), CUSUM
// freezes — holiday travel waves are genuine week-scale sustained shifts
// (Thanksgiving 2025 replayed as sigma 3-5 for days, Christmas sigma 7-9)
// that would burn ~9 false criticals in year one. The instantaneous
// channel, whose threshold self-calibrates over the year's own peaks, and
// the takeoff channel both stay fully armed through the window. The gate
// self-expires: once a prior year's holiday samples exist, the calendar
// ratio explains the wave, effective weight rises, and CUSUM runs through
// holidays normally.
function isUnlearnedHolidayWindow(holidayId, holidayEffectiveWeight) {
  return Boolean(holidayId) && !(Number(holidayEffectiveWeight) > 0);
}

function updateCusumState(db, cohort, occurredAt, sigmaShift, options) {
  const key = `cusum_state:${cohort}`;
  let state = { s: 0, lastSampledAt: null, armedHigh: true, armedCritical: true };
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (row) {
    try {
      state = { ...state, ...JSON.parse(row.value) };
    } catch {
      // Corrupt state resets to a fresh accumulator rather than crashing detection.
    }
  }
  const nowMs = parseIso(occurredAt, 'occurredAt').getTime();
  const lastMs = state.lastSampledAt ? Date.parse(state.lastSampledAt) : null;
  if (Number.isFinite(lastMs) && nowMs <= lastMs) {
    return { state, advanced: false, crossings: [] };
  }

  if (options.freeze) {
    // Unlearned holiday window: hold S and advance the clock so the frozen
    // span neither accumulates nor decays, and re-runs stay idempotent.
    const frozenState = { ...state, lastSampledAt: occurredAt };
    db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(frozenState));
    return { state: frozenState, advanced: true, frozen: true, crossings: [] };
  }

  const nextS = cusumStep(state.s, sigmaShift, options.cusumK);
  const crossings = [];
  let armedHigh = state.armedHigh !== false;
  let armedCritical = state.armedCritical !== false;
  if (armedCritical && nextS >= options.cusumCritical) {
    crossings.push('critical');
    armedCritical = false;
    armedHigh = false;
  } else if (armedHigh && nextS >= options.cusumThreshold) {
    crossings.push('high');
    armedHigh = false;
  }
  if (nextS < options.cusumThreshold / 2) {
    armedHigh = true;
    armedCritical = true;
  }
  const nextState = { s: nextS, lastSampledAt: occurredAt, armedHigh, armedCritical };
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(nextState));
  return { state: nextState, advanced: true, crossings };
}

function compactAircraftList(takeoffs) {
  const sample = [];
  const seen = new Set();
  for (const event of takeoffs) {
    const identifier = event.registration || event.hex.toUpperCase();
    const label = event.label && event.label !== identifier ? event.label : null;
    const aircraft = [identifier, label].filter(Boolean).join(' · ');
    if (seen.has(aircraft)) {
      continue;
    }
    seen.add(aircraft);
    sample.push(aircraft);
    if (sample.length >= 10) {
      break;
    }
  }
  return sample;
}

function buildEvents({
  db,
  snapshot,
  cohort,
  anomalyLevel,
  takeoffBatchMin,
  takeoffAnomalyLevel,
  takeoffWindowMinutes,
  takeoffRateLookbackDays,
  takeoffRateMinSamples,
  takeoffRateMinDays,
  takeoffRateMinCount,
  takeoffRateSurprise,
  takeoffLiveSource,
  cusumK,
  cusumThreshold,
  cusumCritical,
  dataQualityMinRatio,
}) {
  const occurredAt = snapshot.current?.asOf || snapshot.liveStatus?.latestSampledAt;
  if (!occurredAt) {
    throw new Error(`Snapshot for ${cohort} does not include an observation time.`);
  }

  const emergencyLevel = Math.round(finiteNumber(snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel, 1));
  const concurrentCount = finiteNumber(snapshot.current?.concurrentCount);
  const expectedCount = finiteNumber(snapshot.current?.baselineMean ?? snapshot.signals?.composite?.expectedConcurrentCount);
  const zScore = finiteNumber(snapshot.current?.zScore ?? snapshot.signals?.composite?.sigmaShift);
  const concurrentBaseline = hasReadyConcurrentBaseline(snapshot);
  const dataQuality = getDataQuality(db, occurredAt, { takeoffWindowMinutes, takeoffLiveSource, dataQualityMinRatio });
  // degraded: the feed itself collapsed — every statistical layer is blind,
  // suppress them all and surface the degradation instead.
  // stale_live: the live ingester did not produce the current slot, so only
  // the takeoff-rate process (which is defined by that ingester) is mute;
  // the concurrent model still sees real counts from the trace backfill.
  const feedDegraded = dataQuality.status === 'degraded';
  const takeoffScoringActive = !feedDegraded && dataQuality.status !== 'stale_live';
  const takeoffWindow = getTakeoffEvents(db, cohort, occurredAt, takeoffWindowMinutes, takeoffLiveSource);
  const takeoffs = takeoffWindow.takeoffs;
  const takeoffRateStats = getTakeoffRateStats(db, cohort, occurredAt, {
    takeoffWindowMinutes,
    takeoffRateLookbackDays,
    takeoffRateMinSamples,
    takeoffRateMinDays,
    takeoffLiveSource,
  });
  const surprise = takeoffSurprise(takeoffs.length, takeoffRateStats);
  const ladder = getTakeoffLadder(db, cohort, occurredAt);
  // A slot scored on an unready baseline would seed the record with noise.
  if (takeoffScoringActive && takeoffRateStats.modelReady) {
    recordSlotScore(db, cohort, occurredAt, surprise, takeoffs.length);
  }
  const takeoffUnusual = takeoffScoringActive && takeoffRateStats.modelReady && surprise >= takeoffRateSurprise;
  const takeoffMagnitude = takeoffs.length >= Math.max(takeoffRateMinCount, TAKEOFF_EXODUS_RATIO * takeoffRateStats.expectedTakeoffCount);
  const label = cohortLabel(cohort);
  const aircraft = compactAircraftList(takeoffs);
  const events = [];

  if (feedDegraded) {
    events.push({
      kind: 'data_quality',
      severity: 'watch',
      cohort,
      eventKey: `data_quality:${cohort}:${occurredAt}`,
      occurredAt,
      title: 'Ingest feed degraded — detection suppressed for this slot',
      message: `The upstream feed carried ${Math.round(dataQuality.currentTotal).toLocaleString()} aircraft vs a recent same-slot median of ${Math.round(dataQuality.referenceMedian).toLocaleString()}; anomaly scoring for ${label} aircraft is suppressed until feed volume recovers.`,
      payloadJson: JSON.stringify({
        signalFamily: 'data_quality',
        cohort,
        occurredAt,
        currentTotal: dataQuality.currentTotal,
        referenceMedian: dataQuality.referenceMedian,
        referenceCount: dataQuality.referenceCount,
        minRatio: dataQuality.minRatio,
      }),
      status: 'observed',
    });
  }

  if (takeoffs.length >= takeoffBatchMin) {
    events.push({
      kind: 'takeoff_batch',
      severity: 'watch',
      cohort,
      eventKey: `takeoff_batch:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} tracked aircraft became airborne`,
      message: `${takeoffs.length} tracked ${label} aircraft became airborne within ${takeoffWindow.windowMinutes} minutes ending ${occurredAt}.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_batch',
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        takeoffCount: takeoffs.length,
        aircraft,
      }),
      status: 'observed',
    });
  }

  if (takeoffUnusual) {
    events.push({
      kind: 'takeoff_rate_anomaly',
      // Two gates: improbable under the baseline, and a 3x exodus in absolute terms.
      severity: takeoffMagnitude ? takeoffSeverity(surprise, ladder) : 'watch',
      cohort,
      eventKey: `takeoff_rate_anomaly:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} takeoffs vs ${formatDecimal(takeoffRateStats.expectedTakeoffCount)} expected`,
      message: `${takeoffs.length} ${label} takeoffs in ${takeoffWindow.windowMinutes} minutes against ${formatDecimal(takeoffRateStats.expectedTakeoffCount)} expected for this half-hour: about a 1-in-${formatOdds(surprise)} slot under the last ${takeoffRateLookbackDays} days' pattern. A public alert needs ${TAKEOFF_EXODUS_RATIO}x the expected count and a 1-in-${formatOdds(ladder.model.elevated)} slot or rarer.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_rate',
        model: takeoffRateStats.model,
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        takeoffCount: takeoffs.length,
        expectedTakeoffCount: takeoffRateStats.expectedTakeoffCount,
        takeoffDispersion: takeoffRateStats.takeoffDispersion,
        baselineTier: takeoffRateStats.baselineTier,
        baselineDayClass: takeoffRateStats.baselineDayClass,
        baselineSlotOfDay: takeoffRateStats.baselineSlotOfDay,
        baselineGroupSampleCount: takeoffRateStats.baselineGroupSampleCount,
        takeoffSurprise: surprise,
        takeoffSurpriseThreshold: takeoffRateSurprise,
        takeoffRateMinCount,
        exodusRatio: TAKEOFF_EXODUS_RATIO,
        magnitudeGate: takeoffMagnitude,
        ladder,
        sampleCount: takeoffRateStats.sampleCount,
        sampleDayCount: takeoffRateStats.sampleDayCount,
        requiredSampleCount: takeoffRateStats.requiredSampleCount,
        requiredDayCount: takeoffRateStats.requiredDayCount,
        lookbackStart: takeoffRateStats.lookbackStart,
        lookbackDays: takeoffRateStats.lookbackDays,
        aircraft,
      }),
      status: 'pending',
    });
  }

  if (!feedDegraded && concurrentBaseline.ready && emergencyLevel >= anomalyLevel) {
    events.push({
      kind: 'statistical_anomaly',
      severity: severityForLevel(emergencyLevel),
      cohort,
      eventKey: `statistical_anomaly:${cohort}:${occurredAt}`,
      occurredAt,
      title: `Emergency level ${emergencyLevel} aircraft activity anomaly`,
      message: `${Math.round(concurrentCount).toLocaleString()} ${label} aircraft airborne against ${Math.round(expectedCount).toLocaleString()} expected for this half-hour (level ${emergencyLevel} of 5).`,
      payloadJson: JSON.stringify({
        signalFamily: 'concurrent_count',
        cohort,
        occurredAt,
        emergencyLevel,
        concurrentCount,
        expectedCount,
        zScore,
        concurrentModelReady: concurrentBaseline.modelReady,
        concurrentSampleCount: concurrentBaseline.sampleCount,
        concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
      }),
      status: 'pending',
    });
  }

  // Agreement rule: the concurrent count is anomalous AND the takeoff count is
  // itself unusual. (Until 19 Sept 2026 the takeoff side was "at least three
  // took off", true of almost every daytime slot, so this rule only lowered
  // the concurrent bar from level 5 to 4.)
  if (!feedDegraded && concurrentBaseline.ready && takeoffUnusual && emergencyLevel >= takeoffAnomalyLevel) {
    events.push({
      kind: 'takeoff_anomaly',
      severity: severityForLevel(emergencyLevel),
      cohort,
      eventKey: `takeoff_anomaly:${cohort}:${takeoffWindow.windowStart}:${takeoffWindow.windowEnd}`,
      occurredAt,
      title: `${takeoffs.length} takeoffs while airborne count is at level ${emergencyLevel}`,
      message: `${takeoffs.length} ${label} takeoffs in ${takeoffWindow.windowMinutes} minutes against ${formatDecimal(takeoffRateStats.expectedTakeoffCount)} expected (about a 1-in-${formatOdds(surprise)} slot), while ${Math.round(concurrentCount).toLocaleString()} were airborne against ${Math.round(expectedCount).toLocaleString()} expected. Two measurements agree.`,
      payloadJson: JSON.stringify({
        signalFamily: 'takeoff_during_concurrent_anomaly',
        cohort,
        occurredAt,
        windowStart: takeoffWindow.windowStart,
        windowEnd: takeoffWindow.windowEnd,
        windowMinutes: takeoffWindow.windowMinutes,
        emergencyLevel,
        takeoffCount: takeoffs.length,
        expectedTakeoffCount: takeoffRateStats.expectedTakeoffCount,
        takeoffSurprise: surprise,
        concurrentCount,
        expectedCount,
        zScore,
        concurrentModelReady: concurrentBaseline.modelReady,
        concurrentSampleCount: concurrentBaseline.sampleCount,
        concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
        aircraft,
      }),
      status: 'pending',
    });
  }

  let cusum = { state: null, advanced: false, crossings: [] };
  if (!feedDegraded && concurrentBaseline.ready) {
    const composite = snapshot.signals?.composite || {};
    cusum = updateCusumState(db, cohort, occurredAt, zScore, {
      cusumK,
      cusumThreshold,
      cusumCritical,
      freeze: isUnlearnedHolidayWindow(composite.holidayId, composite.holidayEffectiveWeight),
    });
    for (const severity of cusum.crossings) {
      const threshold = severity === 'critical' ? cusumCritical : cusumThreshold;
      events.push({
        kind: 'sustained_shift',
        severity,
        cohort,
        eventKey: `sustained_shift:${cohort}:${severity}:${occurredAt}`,
        occurredAt,
        title: 'Sustained above-baseline aircraft activity',
        message: `${label} aircraft airborne: cumulative deviation ${formatDecimal(cusum.state.s)} >= ${formatDecimal(threshold)} threshold (drift allowance ${formatDecimal(cusumK, 2)}σ per slot).`,
        payloadJson: JSON.stringify({
          signalFamily: 'sustained_shift',
          cohort,
          occurredAt,
          cusum: cusum.state.s,
          cusumK,
          cusumThreshold,
          cusumCritical,
          sigmaShift: zScore,
          concurrentCount,
          expectedCount,
        }),
        status: 'pending',
      });
    }
  }

  return {
    events,
    dataQuality,
    cusum: cusum.state
      ? { s: cusum.state.s, advanced: cusum.advanced, frozen: cusum.frozen === true, crossings: cusum.crossings }
      : null,
    takeoffCount: takeoffs.length,
    takeoffSurprise: surprise,
    takeoffRateModelReady: takeoffRateStats.modelReady,
    takeoffRateSampleCount: takeoffRateStats.sampleCount,
    takeoffRateSampleDayCount: takeoffRateStats.sampleDayCount,
    takeoffRateRequiredSampleCount: takeoffRateStats.requiredSampleCount,
    takeoffRateRequiredDayCount: takeoffRateStats.requiredDayCount,
    concurrentModelReady: concurrentBaseline.modelReady,
    concurrentSampleCount: concurrentBaseline.sampleCount,
    concurrentRequiredSampleCount: concurrentBaseline.requiredSampleCount,
    emergencyLevel,
    occurredAt,
    windowStart: takeoffWindow.windowStart,
    windowEnd: takeoffWindow.windowEnd,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const sourceDbPath = path.resolve(args.db);
  const eventsDbPath = path.resolve(args.eventsDb);
  const sourceDb = new Database(sourceDbPath);
  const eventsDb = eventsDbPath === sourceDbPath ? sourceDb : new Database(eventsDbPath);
  sourceDb.pragma('busy_timeout = 30000');
  if (eventsDb !== sourceDb) {
    eventsDb.pragma('busy_timeout = 30000');
  }
  try {
    const schema = fs.readFileSync(path.resolve(__dirname, '..', 'schema.sql'), 'utf8');
    sourceDb.exec(schema);
    if (eventsDb !== sourceDb) {
      eventsDb.exec(schema);
    }
    const snapshot = loadSnapshot(path.resolve(args.snapshot));
    const result = buildEvents({ ...args, db: sourceDb, snapshot });
    const transaction = eventsDb.transaction((events) => events.filter((event) => insertAlertEvent(eventsDb, event)).length);
    const inserted = transaction(result.events);
    console.log(JSON.stringify({
      ok: true,
      cohort: args.cohort,
      occurredAt: result.occurredAt,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      emergencyLevel: result.emergencyLevel,
      takeoffCount: result.takeoffCount,
      takeoffRateModelReady: result.takeoffRateModelReady,
      takeoffRateSampleCount: result.takeoffRateSampleCount,
      takeoffRateSampleDayCount: result.takeoffRateSampleDayCount,
      takeoffRateRequiredSampleCount: result.takeoffRateRequiredSampleCount,
      takeoffRateRequiredDayCount: result.takeoffRateRequiredDayCount,
      takeoffSurprise: result.takeoffSurprise,
      dataQuality: result.dataQuality?.status,
      cusum: result.cusum,
      candidateEvents: result.events.length,
      insertedEvents: inserted,
      eventsDb: eventsDbPath,
    }));
  } finally {
    if (eventsDb !== sourceDb) {
      eventsDb.close();
    }
    sourceDb.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getTakeoffRateStats,
  buildTakeoffBaseline,
  loadTakeoffSlots,
  buildDataQuality,
  getTakeoffEvents,
  getTakeoffWindow,
  getDataQuality,
  takeoffSurprise,
  takeoffSeverity,
  takeoffModelThresholds,
  ensureSlotScores,
  recordSlotScore,
  TAKEOFF_ALERT_BUDGET_PER_YEAR,
  TAKEOFF_EXODUS_RATIO,
  severityForLevel,
  cusumStep,
  isUnlearnedHolidayWindow,
  robustStats,
  medianOf,
  parseArgs,
};
