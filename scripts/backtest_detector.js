#!/usr/bin/env node

// Backtest harness for the detection stack (ROADMAP Phase 1 acceptance).
//
// Replays history through the same code paths production uses:
//   - concurrent model: buildConcurrentPredictionContext scores every
//     historical slot with the calibrated alarm threshold (note: baselines
//     and calibration see the full history, exactly as the live gauge's
//     calibration does — this is the model's own view of its past, not a
//     strict walk-forward)
//   - CUSUM: the shared cusumStep law over the scored sigma-shift sequence
//   - takeoff-rate model: strict walk-forward — getTakeoffRateStats at each
//     slot only reads data before that slot
//   - --inject-exodus: multiplies the trailing hour's concurrent counts and
//     verifies the model reaches emergency level 5 within 60 minutes
//     (the "3x exodus fires critical" exit criterion)
//
// Output: JSON frequency tables — what would have fired, how often, and on
// which days. The acceptance question is legibility: does the alarm budget
// match intent (~1 critical/year of concurrent alarm, takeoff highs rare)?
//
// Usage:
//   node scripts/backtest_detector.js --db data/ews-main.sqlite --cohort global_business_jet
//     [--takeoff-days 30] [--inject-exodus] [--inject-factor 3]
//     [--write-scores]   record every replayed slot's score in slot_scores
//                        (walk-forward, so each score is what live detection
//                        would have computed at that moment)

const path = require('node:path');
const Database = require('better-sqlite3');

const {
  buildTakeoffBaseline,
  loadTakeoffSlots,
  buildDataQuality,
  getTakeoffWindow,
  takeoffSurprise,
  takeoffSeverity,
  takeoffModelThresholds,
  ensureSlotScores,
  recordSlotScore,
  TAKEOFF_ALERT_BUDGET_PER_YEAR,
  TAKEOFF_EXODUS_RATIO,
  cusumStep,
  isUnlearnedHolidayWindow,
} = require('./detect_alert_events');
const {
  buildConcurrentPredictionContext,
  CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  getDefaultConcurrentPredictionOptions,
} = require('../server/dashboard');

function parseArgs(argv) {
  const args = {
    db: null,
    cohort: null,
    takeoffDays: Number(process.env.EWS_BACKTEST_TAKEOFF_DAYS || 30),
    injectExodus: false,
    injectFactor: 3,
    takeoffWindowMinutes: Number(process.env.EWS_TAKEOFF_WINDOW_MINUTES || 30),
    takeoffRateLookbackDays: Number(process.env.EWS_TAKEOFF_RATE_LOOKBACK_DAYS || 28),
    takeoffRateMinCount: Number(process.env.EWS_TAKEOFF_RATE_MIN_COUNT || 3),
    takeoffRateSurprise: Number(process.env.EWS_TAKEOFF_RATE_SURPRISE || 2),
    writeScores: false,
    takeoffLiveSource: process.env.EWS_TAKEOFF_LIVE_SOURCE || 'adsbx_heatmap',
    dataQualityMinRatio: Number(process.env.EWS_DATA_QUALITY_MIN_RATIO || 0.6),
    cusumK: Number(process.env.EWS_CUSUM_K || 1.5),
    cusumThreshold: Number(process.env.EWS_CUSUM_THRESHOLD || 12),
    cusumCritical: Number(process.env.EWS_CUSUM_CRITICAL || 20),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') args.db = argv[++index];
    else if (value === '--cohort') args.cohort = argv[++index];
    else if (value === '--takeoff-days') args.takeoffDays = Number(argv[++index]);
    else if (value === '--write-scores') args.writeScores = true;
    else if (value === '--inject-exodus') args.injectExodus = true;
    else if (value === '--inject-factor') args.injectFactor = Number(argv[++index]);
    else if (value === '--assert') args.assert = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.db || !args.cohort) {
    throw new Error('Usage: node scripts/backtest_detector.js --db path --cohort id [--takeoff-days n] [--inject-exodus]');
  }
  return args;
}

function tally(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function loadConcurrentRows(db) {
  return db
    .prepare('SELECT sampled_at AS sampledAt, concurrent_count AS concurrentCount FROM concurrent_metrics ORDER BY sampled_at ASC')
    .all();
}

function scoreConcurrent(rows, args) {
  return buildConcurrentPredictionContext(rows, {
    ...getDefaultConcurrentPredictionOptions(args.cohort),
    weeklyBaselineTimeZone: process.env.EWS_MODEL_TIME_ZONE || CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  });
}

function concurrentReplay(context) {
  const ready = context.records.filter((record) => record.modelReady);
  const dailyPeaks = new Map();
  for (const record of ready) {
    const day = record.sampledAt.slice(0, 10);
    const current = dailyPeaks.get(day);
    if (!current || record.sigmaShift > current.sigmaShift) {
      dailyPeaks.set(day, record);
    }
  }
  const peaks = Array.from(dailyPeaks.entries())
    .map(([day, record]) => ({
      day,
      sigmaShift: +record.sigmaShift.toFixed(2),
      emergencyLevel: record.emergencyLevel,
      alertLevel: record.alertLevel,
      concurrentCount: record.concurrentCount,
      expected: Math.round(record.expectedConcurrentCount),
    }))
    .sort((left, right) => right.sigmaShift - left.sigmaShift);
  const dayPeakLevels = Array.from(dailyPeaks.values()).map((record) => record.emergencyLevel);
  return {
    scoredSlots: ready.length,
    scoredDays: dailyPeaks.size,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    emergencyLevelFrequency: tally(ready.map((record) => record.emergencyLevel)),
    alertLevelFrequency: tally(ready.map((record) => record.alertLevel)),
    level5Days: dayPeakLevels.filter((level) => level >= 5).length,
    level4PlusDays: dayPeakLevels.filter((level) => level >= 4).length,
    hottestDays: peaks.slice(0, 10),
  };
}

function cusumReplay(context, args) {
  const ready = context.records.filter((record) => record.modelReady);
  let s = 0;
  let peakS = 0;
  let armedHigh = true;
  let armedCritical = true;
  const crossings = [];
  let frozenSlots = 0;
  for (const record of ready) {
    // Same first-year calendar gate as the live path: unlearned holiday
    // windows freeze the accumulator instead of integrating travel waves.
    if (isUnlearnedHolidayWindow(record.holidayId, record.holidayEffectiveWeight)) {
      frozenSlots += 1;
      continue;
    }
    s = cusumStep(s, record.sigmaShift, args.cusumK);
    peakS = Math.max(peakS, s);
    if (armedCritical && s >= args.cusumCritical) {
      crossings.push({ severity: 'critical', sampledAt: record.sampledAt, s: +s.toFixed(2) });
      armedCritical = false;
      armedHigh = false;
    } else if (armedHigh && s >= args.cusumThreshold) {
      crossings.push({ severity: 'high', sampledAt: record.sampledAt, s: +s.toFixed(2) });
      armedHigh = false;
    }
    if (s < args.cusumThreshold / 2) {
      armedHigh = true;
      armedCritical = true;
    }
  }
  return {
    scoredSlots: ready.length,
    frozenSlots,
    k: args.cusumK,
    threshold: args.cusumThreshold,
    critical: args.cusumCritical,
    peakS: +peakS.toFixed(2),
    crossingCount: crossings.length,
    crossings: crossings.slice(0, 20),
  };
}

// Strict walk-forward: at each historical slot, both the numerator (window
// takeoffs) and the baseline only see data before/at that slot — the same
// view live detection had at that moment. One query fetches the whole
// replay range plus lookback; the shared buildTakeoffBaseline pure function
// then scores each slot in memory.
function takeoffReplay(db, args) {
  const lookbackDays = Math.max(1, args.takeoffRateLookbackDays);
  const replayDays = Math.max(1, args.takeoffDays);
  const now = Date.now();
  const rows = loadTakeoffSlots(
    db, args.cohort, args.takeoffLiveSource,
    new Date(now - (Math.max(lookbackDays, 14) + replayDays) * 24 * 60 * 60 * 1000 -
      Math.max(1, args.takeoffWindowMinutes) * 60 * 1000).toISOString(),
    new Date(now).toISOString(),
  );
  const replayStartMs = now - replayDays * 24 * 60 * 60 * 1000;
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const options = {
    takeoffWindowMinutes: args.takeoffWindowMinutes,
    takeoffRateMinSamples: null,
    takeoffRateMinDays: null,
    takeoffRateLookbackDays: lookbackDays,
    takeoffLiveSource: args.takeoffLiveSource,
  };
  const dataQualityFrequency = {};
  const slots = rows.filter((row) => row.sampledAtMs >= replayStartMs);
  // Replay judges the model thresholds alone: the record guard can only raise
  // a threshold, so this is the upper bound on what the live detector raises.
  const ladder = { model: takeoffModelThresholds(), record: null };
  const fired = [];
  const candidates = [];
  const surprises = [];
  const scored = [];
  let readySlots = 0;
  let lowerIndex = 0;
  let upperIndex = 0;
  for (const slot of slots) {
    const quality = buildDataQuality(slot, rows, slot.sampledAt, args);
    dataQualityFrequency[quality.status] = (dataQualityFrequency[quality.status] || 0) + 1;
    if (quality.status === 'stale_live' || quality.status === 'degraded') {
      continue;
    }
    const window = getTakeoffWindow(slot.sampledAt, args.takeoffWindowMinutes);
    const windowStartMs = Date.parse(window.windowStart);
    while (upperIndex < rows.length && rows[upperIndex].sampledAtMs <= windowStartMs) {
      upperIndex += 1;
    }
    while (lowerIndex < rows.length && rows[lowerIndex].sampledAtMs <= windowStartMs - lookbackMs) {
      lowerIndex += 1;
    }
    const stats = buildTakeoffBaseline(rows.slice(lowerIndex, upperIndex), window, options);
    if (!stats.modelReady) {
      continue;
    }
    readySlots += 1;
    // Live-process events sit exactly on slot timestamps, so the window
    // count ending at this slot is the slot's own live count.
    const count = Number(slot.takeoffCount || 0);
    const surprise = takeoffSurprise(count, stats);
    surprises.push(surprise);
    scored.push({ sampledAt: slot.sampledAt, surprise, count });
    if (surprise < args.takeoffRateSurprise) {
      continue;
    }
    // Same two gates as live detection.
    const magnitude = count >= Math.max(args.takeoffRateMinCount, TAKEOFF_EXODUS_RATIO * stats.expectedTakeoffCount);
    const event = {
      sampledAt: slot.sampledAt,
      count,
      expected: +stats.expectedTakeoffCount.toFixed(1),
      dispersion: +stats.takeoffDispersion.toFixed(2),
      surprise: +surprise.toFixed(2),
      severity: magnitude ? takeoffSeverity(surprise, ladder) : 'watch',
      tier: stats.baselineTier,
    };
    candidates.push(event);
    if (event.severity !== 'watch') {
      fired.push(event);
    }
  }
  if (args.writeScores) {
    ensureSlotScores(db);
    db.transaction(() => {
      for (const row of scored) recordSlotScore(db, args.cohort, row.sampledAt, row.surprise, row.count);
    })();
  }
  surprises.sort((left, right) => left - right);
  const quantileOf = (fraction) => (surprises.length ? +surprises[Math.min(surprises.length - 1, Math.floor(fraction * surprises.length))].toFixed(2) : null);
  // The thresholds are only as good as the tail probability behind them:
  // a 1-in-100 score must occur in about 1 slot in 100.
  const observedAt = (decades) => (surprises.length ? surprises.filter((value) => value >= decades).length / surprises.length : 0);
  return {
    replayedDays: args.takeoffDays,
    slots: slots.length,
    readySlots,
    dataQualityFrequency,
    surpriseQuantiles: { p50: quantileOf(0.5), p90: quantileOf(0.9), p99: quantileOf(0.99), max: quantileOf(1) },
    calibration: { nominal01: +observedAt(1).toFixed(4), nominal001: +observedAt(2).toFixed(4), nominal0001: +observedAt(3).toFixed(4) },
    modelThresholds: ladder.model,
    scoresWritten: args.writeScores ? scored.length : 0,
    candidateCount: candidates.length,
    firedCount: fired.length,
    severityFrequency: tally(fired.map((event) => event.severity)),
    fired: fired.slice(0, 20),
    topCandidates: [...candidates].sort((left, right) => right.surprise - left.surprise).slice(0, 8),
  };
}

// Synthetic acceptance test: multiply the trailing two hours' concurrent
// counts (in memory) and replay the full detector against them. The
// detection contract this asserts (see OPERATIONS.md "Instrument bounds"):
// a sustained 3x exodus reaches HIGH within 60 minutes and CRITICAL within
// 120 minutes. A single 30-min slot at 3x reads ~9-10 sigma, which the
// self-calibrated alarm line (2nd-hottest real day + margin, ~11 sigma on a
// full year) deliberately does not treat as critical — the hottest real
// holiday waves reach 11-12 sigma. What separates a real exodus from a
// holiday wave is sustain, and CUSUM accumulates it past critical inside
// two hours. Instantaneous level 5 stays possible for larger excursions.
function injectExodus(rows, args) {
  const slotMinutes = Math.max(1, args.takeoffWindowMinutes);
  const injectedSlotCount = Math.max(1, Math.round(120 / slotMinutes));
  const injected = rows.map((row, index) => (
    index >= rows.length - injectedSlotCount
      ? { ...row, concurrentCount: Math.round(Number(row.concurrentCount) * args.injectFactor) }
      : { ...row }
  ));
  const context = scoreConcurrent(injected, args);
  const injectedRecords = context.records.slice(-injectedSlotCount);
  // Replay CUSUM over the whole scored sequence so pre-injection state is
  // realistic, then note when each severity is first reached inside the
  // injection window (by either channel: instantaneous level or CUSUM).
  let cusumS = 0;
  const preInjectionCount = context.records.length - injectedRecords.length;
  let firstHigh = null;
  let firstCritical = null;
  context.records.forEach((record, index) => {
    cusumS = cusumStep(cusumS, record.sigmaShift, args.cusumK);
    if (index < preInjectionCount) return;
    const minutesIn = (index - preInjectionCount + 1) * slotMinutes;
    if (!firstHigh && (record.emergencyLevel >= 4 || cusumS >= args.cusumThreshold)) {
      firstHigh = { sampledAt: record.sampledAt, minutesIn, cusumS: +cusumS.toFixed(2) };
    }
    if (!firstCritical && (record.emergencyLevel >= 5 || cusumS >= args.cusumCritical)) {
      firstCritical = { sampledAt: record.sampledAt, minutesIn, cusumS: +cusumS.toFixed(2) };
    }
  });
  return {
    injectFactor: args.injectFactor,
    injectedSlots: injectedSlotCount,
    records: injectedRecords.map((record) => ({
      sampledAt: record.sampledAt,
      concurrentCount: record.concurrentCount,
      expected: Math.round(record.expectedConcurrentCount || 0),
      sigmaShift: +Number(record.sigmaShift || 0).toFixed(2),
      emergencyLevel: record.emergencyLevel,
      alertLevel: record.alertLevel,
      modelReady: record.modelReady,
    })),
    highWithin60Min: Boolean(firstHigh && firstHigh.minutesIn <= 60),
    criticalWithin120Min: Boolean(firstCritical && firstCritical.minutesIn <= 120),
    firstHighAt: firstHigh?.sampledAt ?? null,
    firstHighMinutes: firstHigh?.minutesIn ?? null,
    firstCriticalAt: firstCritical?.sampledAt ?? null,
    firstCriticalMinutes: firstCritical?.minutesIn ?? null,
    cusumAfterInjection: +cusumS.toFixed(2),
  };
}

// The instrument's alarm limits, made executable (bounds documented with
// rationale in OPERATIONS.md "Instrument bounds"). Rates are normalized to
// the replayed span so the same limits hold as history deepens. Any
// violation exits non-zero, which the nightly selftest timer surfaces
// through status.js -> ops watchdog: if data drift or a code change pushes
// the detector out of spec, the box pages a human within a day.
function assertBounds(report, args) {
  const cusumDays = report.cusum.scoredSlots / 48;
  const concurrentDays = report.concurrent.scoredDays || 1;
  const cusumCriticals = report.cusum.crossings.filter((c) => c.severity === 'critical').length;
  const bounds = [
    {
      name: 'injected 3x exodus reaches high within 60 min',
      ok: !args.injectExodus || report.injectedExodus.highWithin60Min === true,
    },
    {
      name: 'injected 3x exodus fires critical within 120 min',
      ok: !args.injectExodus || report.injectedExodus.criticalWithin120Min === true,
    },
    {
      name: 'takeoff replay: zero critical fires on real history',
      ok: !(report.takeoffRate.severityFrequency.critical > 0),
    },
    {
      // Public-tier firings against the stated budget, plus two of Poisson
      // slack so one ordinary month cannot fail the instrument.
      name: `takeoff replay: ${report.takeoffRate.firedCount} public alerts in ${args.takeoffDays}d <= ${TAKEOFF_ALERT_BUDGET_PER_YEAR.elevated}/yr budget`,
      ok: report.takeoffRate.firedCount <= Math.ceil(args.takeoffDays * TAKEOFF_ALERT_BUDGET_PER_YEAR.elevated / 365) + 2,
    },
    {
      name: `takeoff replay: 1-in-100 scores occurred in ${(report.takeoffRate.calibration.nominal001 * 100).toFixed(2)}% of slots (calibrated if <= 2%)`,
      ok: report.takeoffRate.calibration.nominal001 <= 0.02,
    },
    {
      name: `takeoff replay: ${report.takeoffRate.readySlots} scoreable slots >= 336 (instrument warm)`,
      ok: report.takeoffRate.readySlots >= 336,
    },
    {
      name: `cusum: ${report.cusum.crossingCount} crossings <= 1.5/30d`,
      ok: report.cusum.crossingCount <= Math.ceil(cusumDays / 20),
    },
    {
      name: `cusum: ${cusumCriticals} critical crossings <= 0.5/30d`,
      ok: cusumCriticals <= Math.ceil(cusumDays / 60),
    },
    {
      name: `concurrent: ${report.concurrent.level5Days} level-5 days <= 1/30d`,
      ok: report.concurrent.level5Days <= Math.ceil(concurrentDays / 30),
    },
    {
      name: `concurrent: ${report.concurrent.level4PlusDays} level>=4 days <= 2/30d`,
      ok: report.concurrent.level4PlusDays <= Math.ceil(concurrentDays / 15),
    },
  ];
  return { passed: bounds.every((bound) => bound.ok), bounds };
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(path.resolve(args.db), { readonly: !args.writeScores, fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    const rows = loadConcurrentRows(db);
    const context = scoreConcurrent(rows, args);
    const report = {
      ok: true,
      cohort: args.cohort,
      db: path.resolve(args.db),
      historyStart: rows[0]?.sampledAt ?? null,
      historyEnd: rows[rows.length - 1]?.sampledAt ?? null,
      historySlots: rows.length,
      concurrent: concurrentReplay(context),
      cusum: cusumReplay(context, args),
      takeoffRate: takeoffReplay(db, args),
      injectedExodus: args.injectExodus ? injectExodus(rows, args) : null,
    };
    if (args.assert) {
      report.assert = assertBounds(report, args);
      report.ok = report.assert.passed;
    }
    console.log(JSON.stringify(report, null, 2));
    if (args.assert && !report.assert.passed) {
      process.exit(2);
    }
  } finally {
    db.close();
  }
}

main();
