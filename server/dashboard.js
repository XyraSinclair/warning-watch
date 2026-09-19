const {
  getMetaValue,
  getConcurrentCount,
  getLiveAircraft,
  getAllConcurrentMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
} = require("./db");
const { getDemoDashboard } = require("./demo-data");

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const MATCH_WINDOW_MS = 20 * 60 * 1000;
const HEATMAP_SOURCE = "adsbx_heatmap";
const HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status";
const META_SLOT_KEY = "adsbx_heatmap_slot_key";
const META_SAMPLED_AT = "adsbx_heatmap_sampled_at";
const META_URL = "adsbx_heatmap_url";
const META_CACHE_PATH = "adsbx_heatmap_cache_path";

const CONCURRENT_LOOKBACK_DAYS = 28;
const CONCURRENT_SLOT_HALF_LIFE_DAYS = 2;
const CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS = 3;
const CONCURRENT_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SHRINKAGE = 2;
const CONCURRENT_DAILY_SLOT_COUNT = 48;
const CONCURRENT_MIN_HISTORY_SAMPLES = 7 * CONCURRENT_DAILY_SLOT_COUNT;
const CONCURRENT_MIN_STD_DEV = 8;
const CONCURRENT_CALENDAR_LOOKBACK_DAYS = 366 * 3;
const CONCURRENT_CALENDAR_MIN_AGE_DAYS = 180;
const CONCURRENT_CALENDAR_NEIGHBOR_DAYS = 7;
const CONCURRENT_CALENDAR_DISTANCE_SCALE_DAYS = 2.5;
const CONCURRENT_CALENDAR_HALF_LIFE_DAYS = 366 * 2;
const CONCURRENT_CALENDAR_WEEKDAY_MISMATCH_WEIGHT = 0.6;
const CONCURRENT_CALENDAR_SHRINKAGE = 2;
const CONCURRENT_ANNUAL_RATIO_MODEL = "smoothed-prior-year-ratio";
const CONCURRENT_ANNUAL_RATIO_TIME_ZONE = "America/Los_Angeles";
const CONCURRENT_ANNUAL_RATIO_YEAR_LOOKBACK = 3;
const CONCURRENT_ANNUAL_RATIO_DAY_RADIUS = 2;
const CONCURRENT_ANNUAL_RATIO_SLOT_RADIUS = 5;
const CONCURRENT_ANNUAL_RATIO_DAY_SIGMA = 1.25;
const CONCURRENT_ANNUAL_RATIO_SLOT_SIGMA = 3.125;
const CONCURRENT_ANNUAL_RATIO_YEAR_HALF_LIFE = 2;
const CONCURRENT_ANNUAL_RATIO_SHRINKAGE = 1;
const CONCURRENT_ANNUAL_RATIO_MIN = 0.25;
const CONCURRENT_ANNUAL_RATIO_MAX = 2.25;
const CONCURRENT_WEEKLY_BASELINE_MODEL = "all-history-weekly-baseline";
const CONCURRENT_WEEKLY_BASELINE_TIME_ZONE = "America/Los_Angeles";
const CONCURRENT_WEEKLY_DAY_RATIO_MODEL = "weekly-baseline-prior-year-day-ratio";
const CONCURRENT_WEEKLY_US_HOLIDAY_MODEL = "weekly-baseline-us-holiday-adjusted";
const CONCURRENT_WEEKLY_SLOT_COUNT = 7 * CONCURRENT_DAILY_SLOT_COUNT;
const CONCURRENT_DENSE_HISTORY_GAP_MS = DAY_MS;
const CONCURRENT_DAILY_AVERAGE_MIN_SAMPLES = 36;
const CONCURRENT_DAY_RATIO_MIN = 0.25;
const CONCURRENT_DAY_RATIO_MAX = 2.25;
const CONCURRENT_US_HOLIDAY_WINDOW_DAYS = 2;
const CONCURRENT_US_HOLIDAY_OFFSET_SIGMA_DAYS = 0.35;
const CONCURRENT_US_HOLIDAY_SLOT_SIGMA_SLOTS = (60 * 60 * 1000) / HALF_HOUR_MS;
const CONCURRENT_US_HOLIDAY_YEAR_HALF_LIFE = 3;
const CONCURRENT_US_HOLIDAY_SHRINKAGE = 1;
const CONCURRENT_US_HOLIDAY_RATIO_MIN = 0.25;
const CONCURRENT_US_HOLIDAY_RATIO_MAX = 2.25;
const MIN_ALARM_SIGMA_THRESHOLD = 4;
const DEFAULT_ALARM_SIGMA_THRESHOLD = 7;
const ARCHIVE_DECIMAL_PLACES = 2;
const timeZonePartFormatters = new Map();

function getDefaultConcurrentPredictionOptions(cohort = null) {
  return {
    concurrentPredictionModel: CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
    weeklyBaselineTimeZone: CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
    signalCalibrationModel: cohort === "non_icao_untracked" ? "relative-count" : "absolute-count",
  };
}

function resolveConcurrentPredictionOptions(options = {}) {
  const defaults = getDefaultConcurrentPredictionOptions();
  return {
    ...defaults,
    ...options,
    concurrentPredictionModel: options.concurrentPredictionModel ?? defaults.concurrentPredictionModel,
    weeklyBaselineTimeZone: options.weeklyBaselineTimeZone ?? defaults.weeklyBaselineTimeZone,
  };
}

function mean(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function weightedMean(components) {
  const activeComponents = components.filter(
    (component) => component.weight > 0 && Number.isFinite(component.value),
  );
  if (!activeComponents.length) {
    return null;
  }

  const totalWeight = activeComponents.reduce((total, component) => total + component.weight, 0);
  return activeComponents.reduce((total, component) => total + component.weight * component.value, 0) / totalWeight;
}

function quantile(values, percentile) {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finiteValues.length) {
    return null;
  }

  const index = (finiteValues.length - 1) * percentile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const fraction = index - lowerIndex;
  return finiteValues[lowerIndex] + (finiteValues[upperIndex] - finiteValues[lowerIndex]) * fraction;
}

function median(values) {
  return quantile(values, 0.5);
}

function computeAlertLevel(sigmaShift, alarmSigmaThreshold) {
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  if (sigmaShift >= alarmSigmaThreshold) {
    return "alarm";
  }

  if (sigmaShift >= elevatedSigmaThreshold) {
    return "elevated";
  }

  return "normal";
}

function computeGaugeValue(sigmaShift, alarmSigmaThreshold) {
  if (!alarmSigmaThreshold) {
    return 0;
  }

  const clampedShift = Math.max(0, Math.min(alarmSigmaThreshold, sigmaShift));
  return Math.max(0, Math.min(1, clampedShift / alarmSigmaThreshold));
}

function computeEmergencyLevel(sigmaShift, alarmSigmaThreshold) {
  const normalizedSigma = Math.max(0, Number(sigmaShift || 0));
  if (!alarmSigmaThreshold) {
    return 1;
  }

  if (normalizedSigma >= alarmSigmaThreshold) {
    return 5;
  }

  return Math.min(4, Math.max(1, Math.floor((normalizedSigma / alarmSigmaThreshold) * 4) + 1));
}

function computeBaselineSignal(
  currentValue,
  baselineMean,
  baselineStdDev,
  alarmSigmaThreshold,
  signalCalibration = null,
) {
  const divergence = currentValue - baselineMean;
  const relativeCalibration = signalCalibration?.model === "relative-count";
  const calibrationScale = relativeCalibration ? Math.max(baselineMean, 1) : 1;
  const stdDevFloor = Number(signalCalibration?.stdDevFloor || 0) * calibrationScale;
  const positiveExcessScale = Number(signalCalibration?.positiveExcessScale || 0) * calibrationScale;
  const effectiveBaselineStdDev = Math.max(
    Number(baselineStdDev || 0),
    stdDevFloor,
    relativeCalibration ? Math.sqrt(calibrationScale) : 0,
  );

  if (!effectiveBaselineStdDev) {
    return {
      sigmaShift: 0,
      rawSigmaShift: 0,
      varianceAdjustedSigmaShift: 0,
      effectiveBaselineStdDev: 0,
      stdDevFloor,
      positiveExcessScale,
      absoluteExcessWeight: 1,
      gaugeValue: 0,
      alertLevel: "normal",
      emergencyLevel: 1,
    };
  }

  const rawSigmaShift = baselineStdDev ? divergence / baselineStdDev : 0;
  const varianceAdjustedSigmaShift = divergence / effectiveBaselineStdDev;
  const absoluteExcessWeight =
    divergence > 0 && positiveExcessScale > 0
      ? divergence / (divergence + positiveExcessScale)
      : 1;
  const sigmaShift =
    varianceAdjustedSigmaShift > 0
      ? varianceAdjustedSigmaShift * absoluteExcessWeight
      : varianceAdjustedSigmaShift;

  return {
    sigmaShift,
    rawSigmaShift,
    varianceAdjustedSigmaShift,
    effectiveBaselineStdDev,
    stdDevFloor,
    positiveExcessScale,
    absoluteExcessWeight,
    gaugeValue: computeGaugeValue(sigmaShift, alarmSigmaThreshold),
    alertLevel: computeAlertLevel(sigmaShift, alarmSigmaThreshold),
    emergencyLevel: computeEmergencyLevel(sigmaShift, alarmSigmaThreshold),
  };
}

function roundNumber(value, decimalPlaces) {
  if (!Number.isFinite(value) || Number.isInteger(value)) {
    return value;
  }

  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function encodeRuns(values) {
  const runs = [];
  for (const value of values) {
    const previous = runs[runs.length - 1];
    if (previous && previous[0] === value) {
      previous[1] += 1;
    } else {
      runs.push([value, 1]);
    }
  }

  return runs;
}

function buildTimestampDeltaRuns(records) {
  const deltas = [];
  for (let index = 1; index < records.length; index += 1) {
    const previousTimestamp = Date.parse(records[index - 1].sampledAt);
    const currentTimestamp = Date.parse(records[index].sampledAt);

    if (!Number.isFinite(previousTimestamp) || !Number.isFinite(currentTimestamp)) {
      return null;
    }

    deltas.push(currentTimestamp - previousTimestamp);
  }

  return encodeRuns(deltas);
}

function compactArchiveSeries(records) {
  if (!records.length) {
    return {
      v: 1,
      t0: null,
      tr: [],
      c: [],
      p: [],
      s: [],
      z: [],
    };
  }

  const timestampDeltaRuns = buildTimestampDeltaRuns(records);
  if (!timestampDeltaRuns) {
    return records.map((record) => ({
      sampledAt: record.sampledAt,
      concurrentCount: record.concurrentCount,
      predictedConcurrentCount: roundNumber(
        record.expectedConcurrentCount ?? record.predictedConcurrentCount,
        ARCHIVE_DECIMAL_PLACES,
      ),
      predictedConcurrentStdDev: roundNumber(
        record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev,
        ARCHIVE_DECIMAL_PLACES,
      ),
      sigmaShift: roundNumber(record.sigmaShift, ARCHIVE_DECIMAL_PLACES),
    }));
  }

  return {
    v: 1,
    t0: records[0].sampledAt,
    tr: timestampDeltaRuns,
    c: records.map((record) => record.concurrentCount),
    p: records.map((record) =>
      roundNumber(record.expectedConcurrentCount ?? record.predictedConcurrentCount, ARCHIVE_DECIMAL_PLACES),
    ),
    s: records.map((record) =>
      roundNumber(record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev, ARCHIVE_DECIMAL_PLACES),
    ),
    z: records.map((record) => roundNumber(record.sigmaShift, ARCHIVE_DECIMAL_PLACES)),
  };
}

function roundIsoToNearestHalfHour(referenceIso) {
  const timestamp = Date.parse(referenceIso);
  if (!Number.isFinite(timestamp)) {
    return referenceIso;
  }

  return new Date(Math.round(timestamp / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function normalizeSlot(slot) {
  return (slot + CONCURRENT_DAILY_SLOT_COUNT) % CONCURRENT_DAILY_SLOT_COUNT;
}

function getCircularSlotDistance(leftSlot, rightSlot) {
  const distance = Math.abs(normalizeSlot(leftSlot) - normalizeSlot(rightSlot));
  return Math.min(distance, CONCURRENT_DAILY_SLOT_COUNT - distance);
}

function getSlotFromIso(referenceIso) {
  const date = new Date(referenceIso);
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

function getWeekdayFromIso(referenceIso) {
  return new Date(referenceIso).getUTCDay();
}

function buildLocalDateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getWeekdayFromLocalDateParts(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCDay();
}

function getWeekSlotPartsFromIso(referenceIso, timeZone = null) {
  if (timeZone) {
    const parts = getTimeZoneCalendarParts(referenceIso, timeZone);
    const weekday = getWeekdayFromLocalDateParts(parts);
    if (!Number.isFinite(weekday) || !Number.isFinite(parts.slot)) {
      return null;
    }

    return {
      weekday,
      slot: parts.slot,
      weekSlot: weekday * CONCURRENT_DAILY_SLOT_COUNT + parts.slot,
    };
  }

  const weekday = getWeekdayFromIso(referenceIso);
  const slot = getSlotFromIso(referenceIso);
  if (!Number.isFinite(weekday) || !Number.isFinite(slot)) {
    return null;
  }

  return {
    weekday,
    slot,
    weekSlot: weekday * CONCURRENT_DAILY_SLOT_COUNT + slot,
  };
}

function getDayOfYearFromIso(referenceIso) {
  const date = new Date(referenceIso);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((dayStart - yearStart) / DAY_MS);
}

function getTimeZonePartFormatter(timeZone) {
  const resolvedTimeZone = timeZone || "UTC";
  if (!timeZonePartFormatters.has(resolvedTimeZone)) {
    timeZonePartFormatters.set(
      resolvedTimeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: resolvedTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }

  return timeZonePartFormatters.get(resolvedTimeZone);
}

function getTimeZoneCalendarParts(referenceIso, timeZone) {
  const formatter = getTimeZonePartFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(referenceIso))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  const hour = parts.hour === 24 ? 0 : parts.hour;
  const minute = parts.minute >= 30 ? 30 : 0;
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    slot,
  };
}

function getLocalDateKeyFromIso(referenceIso, timeZone) {
  const parts = getTimeZoneCalendarParts(referenceIso, timeZone);
  return buildLocalDateKey(parts.year, parts.month, parts.day);
}

function buildLocalDateSlotKey(year, month, day, slot) {
  return `${buildLocalDateKey(year, month, day)}-${String(normalizeSlot(slot)).padStart(2, "0")}`;
}

function buildLocalPartsSlotKey(parts) {
  return buildLocalDateSlotKey(parts.year, parts.month, parts.day, parts.slot);
}

function buildOffsetLocalPartsSlotKey(parts, yearOffset, dayOffset, slotOffset) {
  const offsetSlot = parts.slot + slotOffset;
  const dayCarry = Math.floor(offsetSlot / CONCURRENT_DAILY_SLOT_COUNT);
  const normalizedSlot = normalizeSlot(offsetSlot);
  const date = new Date(
    Date.UTC(parts.year - yearOffset, parts.month - 1, parts.day + dayOffset + dayCarry),
  );

  return buildLocalDateSlotKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    normalizedSlot,
  );
}

function getNeighborSlots(slot) {
  return [normalizeSlot(slot - 1), normalizeSlot(slot), normalizeSlot(slot + 1)];
}

function trimHistoryQueue(queue, cutoffTimestampMs) {
  while (queue.length && queue[0].timestampMs < cutoffTimestampMs) {
    queue.shift();
  }
}

function computeDecayedMean(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSum += weight * value;
  }

  return totalWeight ? weightedSum / totalWeight : null;
}

function computeDecayedRootMeanSquare(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSquareSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSquareSum += weight * value * value;
  }

  return totalWeight ? Math.sqrt(weightedSquareSum / totalWeight) : null;
}

function buildNeighborhoodValue(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  const [previousEntries, currentEntries, nextEntries] = entriesBySlot;
  const value = weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedMean(previousEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedMean(currentEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedMean(nextEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);

  const exactSampleCount = currentEntries.length;
  const effectiveSampleCount =
    currentEntries.length + neighborWeight * (previousEntries.length + nextEntries.length);

  return {
    value,
    exactSampleCount,
    effectiveSampleCount,
  };
}

function buildNeighborhoodScale(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  return weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[0], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedRootMeanSquare(entriesBySlot[1], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[2], referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);
}

function normalizeDayOfYear(dayOfYear) {
  return (dayOfYear + 366) % 366;
}

function calendarDistanceDays(leftDayOfYear, rightDayOfYear) {
  const directDistance = Math.abs(leftDayOfYear - rightDayOfYear);
  return Math.min(directDistance, 366 - directDistance);
}

function buildCalendarResidualAdjustment(state, referenceIso, referenceTimestampMs) {
  const referenceDayOfYear = getDayOfYearFromIso(referenceIso);
  const referenceWeekday = getWeekdayFromIso(referenceIso);
  const minAgeMs = CONCURRENT_CALENDAR_MIN_AGE_DAYS * DAY_MS;
  const maxAgeMs = CONCURRENT_CALENDAR_LOOKBACK_DAYS * DAY_MS;
  const decayLambda = Math.log(2) / CONCURRENT_CALENDAR_HALF_LIFE_DAYS;
  let totalWeight = 0;
  let weightedResidual = 0;
  let sampleCount = 0;

  for (
    let offset = -CONCURRENT_CALENDAR_NEIGHBOR_DAYS;
    offset <= CONCURRENT_CALENDAR_NEIGHBOR_DAYS;
    offset += 1
  ) {
    const bucket = state.calendarDayResidualHistory[normalizeDayOfYear(referenceDayOfYear + offset)];
    for (const entry of bucket) {
      const ageMs = referenceTimestampMs - entry.timestampMs;
      if (ageMs < minAgeMs || ageMs > maxAgeMs) {
        continue;
      }

      const distanceDays = calendarDistanceDays(entry.dayOfYear, referenceDayOfYear);
      if (distanceDays > CONCURRENT_CALENDAR_NEIGHBOR_DAYS) {
        continue;
      }

      const calendarWeight = Math.exp(
        -0.5 * (distanceDays / CONCURRENT_CALENDAR_DISTANCE_SCALE_DAYS) ** 2,
      );
      const ageWeight = Math.exp(-decayLambda * (ageMs / DAY_MS));
      const weekdayWeight =
        entry.weekday === referenceWeekday ? 1 : CONCURRENT_CALENDAR_WEEKDAY_MISMATCH_WEIGHT;
      const sampleWeight = Math.max(1, Math.sqrt(entry.sampleCount || 1));
      const weight = calendarWeight * ageWeight * weekdayWeight * sampleWeight;
      totalWeight += weight;
      weightedResidual += weight * entry.residual;
      sampleCount += 1;
    }
  }

  if (!totalWeight) {
    return {
      calendarAdjustment: 0,
      calendarSampleCount: 0,
      calendarEffectiveWeight: 0,
      calendarBlendWeight: 0,
    };
  }

  const calendarBlendWeight = Math.max(
    0,
    Math.min(1, totalWeight / (totalWeight + CONCURRENT_CALENDAR_SHRINKAGE)),
  );

  return {
    calendarAdjustment: weightedResidual / totalWeight,
    calendarSampleCount: sampleCount,
    calendarEffectiveWeight: totalWeight,
    calendarBlendWeight,
  };
}

function buildAnnualRatioAdjustment(state, referenceIso, baseExpectedConcurrentCount, options = {}) {
  if (
    options.concurrentPredictionModel !== CONCURRENT_ANNUAL_RATIO_MODEL ||
    !Number.isFinite(baseExpectedConcurrentCount) ||
    baseExpectedConcurrentCount <= 0
  ) {
    return null;
  }

  const referenceParts = getTimeZoneCalendarParts(
    referenceIso,
    options.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
  );
  const dayRadius = options.annualRatioDayRadius ?? CONCURRENT_ANNUAL_RATIO_DAY_RADIUS;
  const slotRadius = options.annualRatioSlotRadius ?? CONCURRENT_ANNUAL_RATIO_SLOT_RADIUS;
  const daySigma = options.annualRatioDaySigma ?? CONCURRENT_ANNUAL_RATIO_DAY_SIGMA;
  const slotSigma = options.annualRatioSlotSigma ?? CONCURRENT_ANNUAL_RATIO_SLOT_SIGMA;
  const yearLookback = options.annualRatioYearLookback ?? CONCURRENT_ANNUAL_RATIO_YEAR_LOOKBACK;
  const yearHalfLife = options.annualRatioYearHalfLife ?? CONCURRENT_ANNUAL_RATIO_YEAR_HALF_LIFE;
  const shrinkage = options.annualRatioShrinkage ?? CONCURRENT_ANNUAL_RATIO_SHRINKAGE;
  const minRatio = options.annualRatioMin ?? CONCURRENT_ANNUAL_RATIO_MIN;
  const maxRatio = options.annualRatioMax ?? CONCURRENT_ANNUAL_RATIO_MAX;
  const yearDecayLambda = Math.log(2) / Math.max(0.01, yearHalfLife);
  let totalWeight = 0;
  let weightedRatio = 0;
  let sampleCount = 0;

  for (let yearOffset = 1; yearOffset <= yearLookback; yearOffset += 1) {
    const yearWeight = Math.exp(-yearDecayLambda * (yearOffset - 1));
    for (let dayOffset = -dayRadius; dayOffset <= dayRadius; dayOffset += 1) {
      const dayWeight = Math.exp(-0.5 * (dayOffset / Math.max(0.01, daySigma)) ** 2);
      for (let slotOffset = -slotRadius; slotOffset <= slotRadius; slotOffset += 1) {
        const key = buildOffsetLocalPartsSlotKey(referenceParts, yearOffset, dayOffset, slotOffset);
        const entries = state.annualRatioHistory.get(key);
        if (!entries?.length) {
          continue;
        }

        const slotWeight = Math.exp(-0.5 * (slotOffset / Math.max(0.01, slotSigma)) ** 2);
        const weight = yearWeight * dayWeight * slotWeight;
        for (const entry of entries) {
          totalWeight += weight;
          weightedRatio += weight * entry.ratio;
          sampleCount += 1;
        }
      }
    }
  }

  if (!totalWeight) {
    return null;
  }

  const calendarBlendWeight = Math.max(0, Math.min(1, totalWeight / (totalWeight + shrinkage)));
  const ratio = Math.max(minRatio, Math.min(maxRatio, weightedRatio / totalWeight));
  const annualExpectedConcurrentCount = baseExpectedConcurrentCount * ratio;
  const calendarAdjustment = annualExpectedConcurrentCount - baseExpectedConcurrentCount;

  return {
    calendarAdjustment,
    calendarSampleCount: sampleCount,
    calendarEffectiveWeight: totalWeight,
    calendarBlendWeight,
    annualRatio: ratio,
    annualExpectedConcurrentCount,
  };
}

function trimRelevantHistories(state, weekday, slot, cutoffTimestampMs) {
  for (const neighborSlot of getNeighborSlots(slot)) {
    trimHistoryQueue(state.slotHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.slotResidualHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotHistory[weekday][neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotResidualHistory[weekday][neighborSlot], cutoffTimestampMs);
  }
}

function buildConcurrentPredictionFromState(referenceIso, concurrentCount, state, options = {}) {
  const canonicalReferenceIso = roundIsoToNearestHalfHour(referenceIso);
  const referenceTimestampMs = Date.parse(canonicalReferenceIso);
  if (!Number.isFinite(referenceTimestampMs)) {
    return {
      canonicalReferenceIso,
      modelReady: false,
      expectedConcurrentCount: Number(concurrentCount || 0),
      expectedConcurrentStdDev: CONCURRENT_MIN_STD_DEV,
      timeOfDayExpected: null,
      timeOfWeekExpected: null,
      timeOfDaySampleCount: 0,
      timeOfWeekSampleCount: 0,
      timeOfWeekBlendWeight: 0,
      sigmaShift: 0,
      divergence: 0,
    };
  }

  const slot = getSlotFromIso(canonicalReferenceIso);
  const weekday = getWeekdayFromIso(canonicalReferenceIso);
  const cutoffTimestampMs = referenceTimestampMs - CONCURRENT_LOOKBACK_DAYS * DAY_MS;
  trimRelevantHistories(state, weekday, slot, cutoffTimestampMs);

  const neighborSlots = getNeighborSlots(slot);
  const slotCountHistories = neighborSlots.map((neighborSlot) => state.slotHistory[neighborSlot]);
  const weekdaySlotCountHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotHistory[weekday][neighborSlot],
  );
  const slotResidualHistories = neighborSlots.map((neighborSlot) => state.slotResidualHistory[neighborSlot]);
  const weekdaySlotResidualHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotResidualHistory[weekday][neighborSlot],
  );

  const timeOfDayComponent = buildNeighborhoodValue(
    slotCountHistories,
    referenceTimestampMs,
    CONCURRENT_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );
  const timeOfWeekComponent = buildNeighborhoodValue(
    weekdaySlotCountHistories,
    referenceTimestampMs,
    CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );

  const timeOfDayResidualScale =
    buildNeighborhoodScale(
      slotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      slotCountHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );
  const timeOfWeekResidualScale =
    buildNeighborhoodScale(
      weekdaySlotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      weekdaySlotCountHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );

  const timeOfWeekBlendWeight = Math.max(
    0,
    Math.min(
      1,
      timeOfWeekComponent.effectiveSampleCount /
        (timeOfWeekComponent.effectiveSampleCount + CONCURRENT_WEEKDAY_SHRINKAGE),
    ),
  );
  const baseExpectedConcurrentCount =
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayComponent.value },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekComponent.value },
    ]) ?? Number(concurrentCount || 0);
  const residualCalendarAdjustment = buildCalendarResidualAdjustment(
    state,
    canonicalReferenceIso,
    referenceTimestampMs,
  );
  const annualRatioAdjustment = buildAnnualRatioAdjustment(
    state,
    canonicalReferenceIso,
    baseExpectedConcurrentCount,
    options,
  );
  const calendarAdjustment = annualRatioAdjustment || residualCalendarAdjustment;
  const expectedConcurrentCount =
    baseExpectedConcurrentCount +
    calendarAdjustment.calendarAdjustment * calendarAdjustment.calendarBlendWeight;
  const expectedConcurrentStdDev = Math.max(
    CONCURRENT_MIN_STD_DEV,
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayResidualScale },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekResidualScale },
    ]) ?? CONCURRENT_MIN_STD_DEV,
  );
  const modelReady =
    state.historySampleCount >= CONCURRENT_MIN_HISTORY_SAMPLES &&
    (Number.isFinite(timeOfDayComponent.value) || Number.isFinite(timeOfWeekComponent.value));
  const divergence = modelReady ? Number(concurrentCount || 0) - expectedConcurrentCount : 0;
  const calendarLearningResidual = modelReady
    ? Number(concurrentCount || 0) - baseExpectedConcurrentCount
    : 0;
  const sigmaShift = modelReady ? divergence / expectedConcurrentStdDev : 0;

  return {
    canonicalReferenceIso,
    modelReady,
    slot,
    weekday,
    timeOfDayExpected: timeOfDayComponent.value,
    timeOfWeekExpected: timeOfWeekComponent.value,
    timeOfDayResidualScale,
    timeOfWeekResidualScale,
    timeOfDaySampleCount: timeOfDayComponent.exactSampleCount,
    timeOfWeekSampleCount: timeOfWeekComponent.exactSampleCount,
    timeOfWeekBlendWeight,
    baseExpectedConcurrentCount,
    calendarAdjustment: calendarAdjustment.calendarAdjustment,
    calendarSampleCount: calendarAdjustment.calendarSampleCount,
    calendarEffectiveWeight: calendarAdjustment.calendarEffectiveWeight,
    calendarBlendWeight: calendarAdjustment.calendarBlendWeight,
    annualRatio: calendarAdjustment.annualRatio ?? null,
    annualExpectedConcurrentCount: calendarAdjustment.annualExpectedConcurrentCount ?? null,
    concurrentPredictionModel: options.concurrentPredictionModel || "calendar-residual",
    concurrentPredictionTimeZone: annualRatioAdjustment
      ? options.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE
      : null,
    expectedConcurrentCount: modelReady ? expectedConcurrentCount : Number(concurrentCount || 0),
    expectedConcurrentStdDev: modelReady ? expectedConcurrentStdDev : CONCURRENT_MIN_STD_DEV,
    calendarLearningResidual,
    sigmaShift,
    divergence,
  };
}

function calibrateConcurrentAlarmThreshold(records) {
  if (!records.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - 365 * DAY_MS;
  const dailyPeaks = new Map();

  for (const record of records) {
    const sampledAtMs = Date.parse(record.sampledAt);
    if (!Number.isFinite(sampledAtMs) || sampledAtMs < lowerBound || !record.modelReady) {
      continue;
    }

    const day = record.sampledAt.slice(0, 10);
    dailyPeaks.set(day, Math.max(dailyPeaks.get(day) ?? -Infinity, record.sigmaShift));
  }

  const sortedPeaks = Array.from(dailyPeaks.values()).sort((left, right) => right - left);
  if (!sortedPeaks.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  if (sortedPeaks.length === 1) {
    return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil(sortedPeaks[0] * 10) / 10);
  }

  const secondHighestPeak = sortedPeaks[1];
  return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil((secondHighestPeak + 0.05) * 10) / 10);
}

function buildConcurrentSignalCalibration(records, model = "absolute-count") {
  const residuals = [];
  const positiveResiduals = [];
  const baselineStdDevs = [];
  const relativeCalibration = model === "relative-count";

  for (const record of records) {
    if (!record.modelReady) {
      continue;
    }

    const baselineMean = Number(record.expectedConcurrentCount || 0);
    const baselineStdDev = Number(record.expectedConcurrentStdDev || 0);
    const currentValue = Number(record.concurrentCount || 0);
    // Relative calibration prevents busy seasonal strata from setting an
    // absolute count floor that makes quiet non-ICAO strata unresponsive.
    const calibrationScale = relativeCalibration ? Math.max(baselineMean, 1) : 1;
    const residual = (currentValue - baselineMean) / calibrationScale;

    if (Number.isFinite(residual)) {
      residuals.push(residual);
      if (residual > 0) {
        positiveResiduals.push(residual);
      }
    }

    if (Number.isFinite(baselineStdDev) && baselineStdDev > 0) {
      baselineStdDevs.push(baselineStdDev / calibrationScale);
    }
  }

  const absoluteResiduals = residuals.map((residual) => Math.abs(residual));
  const stdDevFloor =
    median(relativeCalibration ? absoluteResiduals : absoluteResiduals.filter((residual) => residual > 0)) ??
    median(baselineStdDevs) ??
    0;
  const positiveExcessScale = median(positiveResiduals) ?? stdDevFloor;

  return {
    model,
    stdDevFloor,
    positiveExcessScale,
  };
}

// Robust location/scale (median + scaled MAD) instead of mean/stdDev.
// A weekly slot group holds one sample per week, so under a mean/variance
// accumulator a single extreme value — including a live exodus, whose own
// slot is present in its baseline group at scoring time — drags the mean
// toward itself and explodes the stdDev, self-dampening the very z-score
// that should fire (observed: a 3x injection scored sigma 2.4 instead of
// ~35). Median/MAD are immune to single-sample contamination, so no
// leave-one-out correction is needed and past anomalies stop poisoning
// baselines. Field names stay mean/stdDev for every downstream consumer.
function createCountAccumulator() {
  return {
    sampleCount: 0,
    values: [],
  };
}

function addToCountAccumulator(accumulator, value) {
  if (!Number.isFinite(value)) {
    return;
  }

  accumulator.sampleCount += 1;
  accumulator.values.push(value);
}

function finalizeCountAccumulator(accumulator, fallbackMean = null, fallbackStdDev = null) {
  if (!accumulator.sampleCount) {
    return {
      mean: fallbackMean,
      stdDev: fallbackStdDev,
      sampleCount: 0,
    };
  }

  const location = median(accumulator.values);
  const scale =
    accumulator.sampleCount > 1
      ? 1.4826 * median(accumulator.values.map((value) => Math.abs(value - location)))
      : 0;

  return {
    mean: location,
    stdDev: scale,
    sampleCount: accumulator.sampleCount,
  };
}

function parseLocalDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getPreviousYearDateKey(dateKey) {
  const parts = parseLocalDateKey(dateKey);
  if (!parts) {
    return null;
  }

  const previousYear = parts.year - 1;
  const previousDay = Math.min(parts.day, getDaysInMonth(previousYear, parts.month));
  return buildLocalDateKey(previousYear, parts.month, previousDay);
}

function getDateOrdinalFromKey(dateKey) {
  const parts = parseLocalDateKey(dateKey);
  if (!parts) {
    return null;
  }

  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

function addDaysToLocalDateKey(dateKey, dayOffset) {
  const parts = parseLocalDateKey(dateKey);
  if (!parts) {
    return null;
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return buildLocalDateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getNthWeekdayOfMonth(year, month, weekday, nth) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstDay + 7) % 7) + (nth - 1) * 7;
  return buildLocalDateKey(year, month, day);
}

function getLastWeekdayOfMonth(year, month, weekday) {
  const lastDay = getDaysInMonth(year, month);
  const lastWeekday = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  const day = lastDay - ((lastWeekday - weekday + 7) % 7);
  return buildLocalDateKey(year, month, day);
}

function getUsHolidayDefinitionsForYear(year) {
  return [
    {
      id: "new_years",
      label: "New Year's",
      dateKey: buildLocalDateKey(year, 1, 1),
      maxOffsetDays: 3,
    },
    {
      id: "mlk_day",
      label: "MLK Day",
      dateKey: getNthWeekdayOfMonth(year, 1, 1, 3),
    },
    {
      id: "washingtons_birthday",
      label: "Washington's Birthday",
      dateKey: getNthWeekdayOfMonth(year, 2, 1, 3),
    },
    {
      id: "memorial_day",
      label: "Memorial Day",
      dateKey: getLastWeekdayOfMonth(year, 5, 1),
    },
    ...(year >= 2021
      ? [
          {
            id: "juneteenth",
            label: "Juneteenth",
            dateKey: buildLocalDateKey(year, 6, 19),
          },
        ]
      : []),
    {
      id: "independence_day",
      label: "4th of July",
      dateKey: buildLocalDateKey(year, 7, 4),
    },
    {
      id: "labor_day",
      label: "Labor Day",
      dateKey: getNthWeekdayOfMonth(year, 9, 1, 1),
    },
    {
      id: "columbus_day",
      label: "Columbus Day",
      dateKey: getNthWeekdayOfMonth(year, 10, 1, 2),
    },
    {
      id: "veterans_day",
      label: "Veterans Day",
      dateKey: buildLocalDateKey(year, 11, 11),
    },
    {
      id: "thanksgiving",
      label: "Thanksgiving",
      dateKey: getNthWeekdayOfMonth(year, 11, 4, 4),
      maxOffsetDays: 3,
    },
    {
      id: "christmas",
      label: "Christmas",
      dateKey: buildLocalDateKey(year, 12, 25),
    },
  ];
}

function findUsHolidayProximity(dateKey, windowDays = CONCURRENT_US_HOLIDAY_WINDOW_DAYS) {
  const parts = parseLocalDateKey(dateKey);
  const dateOrdinal = getDateOrdinalFromKey(dateKey);
  if (!parts || dateOrdinal == null) {
    return null;
  }

  let closestHoliday = null;
  for (const year of [parts.year - 1, parts.year, parts.year + 1]) {
    for (const holiday of getUsHolidayDefinitionsForYear(year)) {
      const holidayOrdinal = getDateOrdinalFromKey(holiday.dateKey);
      const offsetDays = dateOrdinal - holidayOrdinal;
      const minOffsetDays = holiday.minOffsetDays ?? -windowDays;
      const maxOffsetDays = holiday.maxOffsetDays ?? windowDays;
      if (offsetDays < minOffsetDays || offsetDays > maxOffsetDays) {
        continue;
      }

      if (
        !closestHoliday ||
        Math.abs(offsetDays) < Math.abs(closestHoliday.offsetDays) ||
        (Math.abs(offsetDays) === Math.abs(closestHoliday.offsetDays) &&
          holiday.dateKey < closestHoliday.holidayDateKey)
      ) {
        closestHoliday = {
          id: holiday.id,
          label: holiday.label,
          holidayDateKey: holiday.dateKey,
          offsetDays,
        };
      }
    }
  }

  return closestHoliday;
}

function isUsHolidayWindowIso(referenceIso, timeZone, windowDays) {
  const dateKey = getLocalDateKeyFromIso(referenceIso, timeZone);
  return Boolean(findUsHolidayProximity(dateKey, windowDays));
}

function buildDenseHistorySegment(normalizedRows) {
  if (!normalizedRows.length) {
    return {
      rows: [],
      startIndex: 0,
      endIndex: -1,
      startMs: null,
      endMs: null,
      cadenceMs: null,
      gapThresholdMs: CONCURRENT_DENSE_HISTORY_GAP_MS,
    };
  }

  const timestamps = normalizedRows.map((row) => Date.parse(row.sampledAt));
  const positiveDeltas = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    if (Number.isFinite(delta) && delta > 0) {
      positiveDeltas.push(delta);
    }
  }

  const cadenceMs = median(positiveDeltas) ?? HALF_HOUR_MS;
  const gapThresholdMs = Math.max(CONCURRENT_DENSE_HISTORY_GAP_MS, cadenceMs * 2);
  const segments = [];
  let startIndex = 0;

  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    if (!Number.isFinite(delta) || delta > gapThresholdMs) {
      segments.push({
        startIndex,
        endIndex: index - 1,
        startMs: timestamps[startIndex],
        endMs: timestamps[index - 1],
        sampleCount: index - startIndex,
      });
      startIndex = index;
    }
  }

  segments.push({
    startIndex,
    endIndex: normalizedRows.length - 1,
    startMs: timestamps[startIndex],
    endMs: timestamps[normalizedRows.length - 1],
    sampleCount: normalizedRows.length - startIndex,
  });

  const selectedSegment = segments.reduce((best, segment) => {
    if (!best) {
      return segment;
    }

    if (segment.sampleCount > best.sampleCount) {
      return segment;
    }

    if (segment.sampleCount === best.sampleCount && segment.endMs > best.endMs) {
      return segment;
    }

    return best;
  }, null);

  return {
    ...selectedSegment,
    rows: normalizedRows.slice(selectedSegment.startIndex, selectedSegment.endIndex + 1),
    cadenceMs,
    gapThresholdMs,
  };
}

function buildDailyAverageStats(normalizedRows, timeZone) {
  const dayAccumulators = new Map();

  for (const row of normalizedRows) {
    const canonicalRowIso = roundIsoToNearestHalfHour(row.sampledAt);
    const parts = getTimeZoneCalendarParts(canonicalRowIso, timeZone);
    const dayKey = buildLocalDateKey(parts.year, parts.month, parts.day);
    const weekday = getWeekdayFromLocalDateParts(parts);
    const accumulator = dayAccumulators.get(dayKey) || {
      ...createCountAccumulator(),
      dayKey,
      weekday,
    };
    addToCountAccumulator(accumulator, row.concurrentCount);
    dayAccumulators.set(dayKey, accumulator);
  }

  const dailyAveragesByDate = new Map();
  const weekdayDayAccumulators = Array.from({ length: 7 }, createCountAccumulator);

  for (const [dayKey, accumulator] of dayAccumulators) {
    const stats = finalizeCountAccumulator(accumulator);
    const dailyStats = {
      dayKey,
      weekday: accumulator.weekday,
      mean: stats.mean,
      stdDev: stats.stdDev,
      sampleCount: stats.sampleCount,
    };
    dailyAveragesByDate.set(dayKey, dailyStats);

    if (
      dailyStats.sampleCount >= CONCURRENT_DAILY_AVERAGE_MIN_SAMPLES &&
      Number.isFinite(dailyStats.mean)
    ) {
      addToCountAccumulator(weekdayDayAccumulators[dailyStats.weekday], dailyStats.mean);
    }
  }

  const weekdayDayAverages = weekdayDayAccumulators.map((accumulator) =>
    finalizeCountAccumulator(accumulator),
  );

  return {
    dailyAveragesByDate,
    weekdayDayAverages,
  };
}

function buildPriorYearDayRatioAdjustment(referenceIso, state) {
  const dateKey = getLocalDateKeyFromIso(referenceIso, state.weeklyBaselineTimeZone);
  const priorYearDateKey = getPreviousYearDateKey(dateKey);
  const priorYearDayAverage = state.dailyAveragesByDate?.get(priorYearDateKey);

  if (
    !priorYearDayAverage ||
    priorYearDayAverage.sampleCount < state.dailyAverageMinSamples ||
    !Number.isFinite(priorYearDayAverage.mean) ||
    priorYearDayAverage.mean <= 0
  ) {
    return {
      dateKey,
      priorYearDateKey,
      dailyRatio: 1,
      rawDailyRatio: null,
      dailyRatioReady: false,
      priorYearDayAverage: priorYearDayAverage?.mean ?? null,
      priorYearDaySampleCount: priorYearDayAverage?.sampleCount ?? 0,
      priorYearWeekdayAverage: null,
      priorYearWeekdayDailySampleCount: 0,
    };
  }

  const priorYearWeekdayAverage = state.weekdayDayAverages?.[priorYearDayAverage.weekday];
  if (
    !priorYearWeekdayAverage ||
    !Number.isFinite(priorYearWeekdayAverage.mean) ||
    priorYearWeekdayAverage.mean <= 0
  ) {
    return {
      dateKey,
      priorYearDateKey,
      dailyRatio: 1,
      rawDailyRatio: null,
      dailyRatioReady: false,
      priorYearDayAverage: priorYearDayAverage.mean,
      priorYearDaySampleCount: priorYearDayAverage.sampleCount,
      priorYearWeekdayAverage: priorYearWeekdayAverage?.mean ?? null,
      priorYearWeekdayDailySampleCount: priorYearWeekdayAverage?.sampleCount ?? 0,
    };
  }

  const rawDailyRatio = priorYearDayAverage.mean / priorYearWeekdayAverage.mean;
  const dailyRatio = Math.max(
    state.dayRatioMin,
    Math.min(state.dayRatioMax, rawDailyRatio),
  );

  return {
    dateKey,
    priorYearDateKey,
    dailyRatio,
    rawDailyRatio,
    dailyRatioReady: true,
    priorYearDayAverage: priorYearDayAverage.mean,
    priorYearDaySampleCount: priorYearDayAverage.sampleCount,
    priorYearWeekdayAverage: priorYearWeekdayAverage.mean,
    priorYearWeekdayDailySampleCount: priorYearWeekdayAverage.sampleCount,
  };
}

function buildUsHolidaySlotEffectEntries(normalizedRows, state) {
  const slotHolidayAccumulators = new Map();

  for (const row of normalizedRows) {
    const canonicalRowIso = roundIsoToNearestHalfHour(row.sampledAt);
    const dateKey = getLocalDateKeyFromIso(canonicalRowIso, state.weeklyBaselineTimeZone);
    const holiday = findUsHolidayProximity(dateKey, state.holidayWindowDays);
    if (!holiday) {
      continue;
    }

    const weekSlotParts = getWeekSlotPartsFromIso(canonicalRowIso, state.weeklyBaselineTimeZone);
    const slotStats = weekSlotParts == null ? null : state.weeklySlotStats[weekSlotParts.weekSlot];
    const baseExpectedConcurrentCount = Number.isFinite(slotStats?.mean)
      ? slotStats.mean
      : state.globalMean;
    if (!Number.isFinite(baseExpectedConcurrentCount) || baseExpectedConcurrentCount <= 0) {
      continue;
    }

    const key = `${holiday.id}:${holiday.holidayDateKey}:${holiday.offsetDays}:${weekSlotParts.slot}`;
    const accumulator = slotHolidayAccumulators.get(key) || {
      holidayId: holiday.id,
      holidayLabel: holiday.label,
      holidayDateKey: holiday.holidayDateKey,
      holidayOccurrenceOrdinal: getDateOrdinalFromKey(holiday.holidayDateKey),
      dateKey,
      offsetDays: holiday.offsetDays,
      slot: weekSlotParts.slot,
      sampleCount: 0,
      actualSum: 0,
      baseSum: 0,
    };
    accumulator.sampleCount += 1;
    accumulator.actualSum += row.concurrentCount;
    accumulator.baseSum += baseExpectedConcurrentCount;
    slotHolidayAccumulators.set(key, accumulator);
  }

  const entriesByHoliday = new Map();
  for (const accumulator of slotHolidayAccumulators.values()) {
    if (
      accumulator.sampleCount < 1 ||
      !Number.isFinite(accumulator.baseSum) ||
      accumulator.baseSum <= 0
    ) {
      continue;
    }

    const entry = {
      ...accumulator,
      actualSlotAverage: accumulator.actualSum / accumulator.sampleCount,
      baseSlotAverage: accumulator.baseSum / accumulator.sampleCount,
      ratio: accumulator.actualSum / accumulator.baseSum,
    };
    const entries = entriesByHoliday.get(entry.holidayId) || [];
    entries.push(entry);
    entriesByHoliday.set(entry.holidayId, entries);
  }

  for (const entries of entriesByHoliday.values()) {
    entries.sort(
      (left, right) =>
        left.holidayOccurrenceOrdinal - right.holidayOccurrenceOrdinal ||
        left.offsetDays - right.offsetDays ||
        left.slot - right.slot,
    );
  }

  return entriesByHoliday;
}

function buildUsHolidayAdjustment(referenceIso, state) {
  const dateKey = getLocalDateKeyFromIso(referenceIso, state.weeklyBaselineTimeZone);
  const holiday = findUsHolidayProximity(dateKey, state.holidayWindowDays);
  if (!holiday) {
    return null;
  }

  const weekSlotParts = getWeekSlotPartsFromIso(referenceIso, state.weeklyBaselineTimeZone);
  if (!weekSlotParts) {
    return null;
  }

  const targetOccurrenceOrdinal = getDateOrdinalFromKey(holiday.holidayDateKey);
  const entries = state.holidayEffectEntriesByHoliday?.get(holiday.id) || [];
  const yearDecayLambda = Math.log(2) / Math.max(0.01, state.holidayYearHalfLife);
  let totalWeight = 0;
  let weightedRatio = 0;
  let weightedRatioSquares = 0;
  let sampleCount = 0;

  for (const entry of entries) {
    if (entry.holidayOccurrenceOrdinal >= targetOccurrenceOrdinal) {
      continue;
    }

    const offsetDistance = holiday.offsetDays - entry.offsetDays;
    const offsetWeight = Math.exp(
      -0.5 * (offsetDistance / Math.max(0.01, state.holidayOffsetSigmaDays)) ** 2,
    );
    const slotDistance = getCircularSlotDistance(weekSlotParts.slot, entry.slot);
    const slotWeight = Math.exp(
      -0.5 * (slotDistance / Math.max(0.01, state.holidaySlotSigmaSlots)) ** 2,
    );
    const yearDistance = Math.max(
      0,
      (targetOccurrenceOrdinal - entry.holidayOccurrenceOrdinal) / 365.25,
    );
    const yearWeight = Math.exp(-yearDecayLambda * Math.max(0, yearDistance - 1));
    const sampleWeight = Math.sqrt(Math.max(1, entry.sampleCount));
    const weight = offsetWeight * slotWeight * yearWeight * sampleWeight;
    totalWeight += weight;
    weightedRatio += weight * entry.ratio;
    weightedRatioSquares += weight * entry.ratio * entry.ratio;
    sampleCount += entry.sampleCount;
  }

  if (!totalWeight) {
    return {
      ...holiday,
      dateKey,
      holidayRatio: 1,
      rawHolidayRatio: null,
      holidayRatioReady: false,
      holidaySampleCount: 0,
      holidayEffectiveWeight: 0,
      holidayBlendWeight: 0,
      holidaySlot: weekSlotParts.slot,
      holidayRatioStdDev: 0,
    };
  }

  const averageRatio = weightedRatio / totalWeight;
  const ratioVariance = Math.max(0, weightedRatioSquares / totalWeight - averageRatio * averageRatio);
  const rawHolidayRatioStdDev = Math.sqrt(ratioVariance);
  const holidayBlendWeight = Math.max(
    0,
    Math.min(1, totalWeight / (totalWeight + state.holidayShrinkage)),
  );
  const rawHolidayRatio = averageRatio;
  const holidayRatio = Math.max(
    state.holidayRatioMin,
    Math.min(state.holidayRatioMax, 1 + holidayBlendWeight * (rawHolidayRatio - 1)),
  );
  const holidayRatioStdDev = holidayBlendWeight * rawHolidayRatioStdDev;

  return {
    ...holiday,
    dateKey,
    holidayRatio,
    rawHolidayRatio,
    holidayRatioReady: true,
    holidaySampleCount: sampleCount,
    holidayEffectiveWeight: totalWeight,
    holidayBlendWeight,
    holidaySlot: weekSlotParts.slot,
    holidayRatioStdDev,
  };
}

function buildWeeklyBaselinePrediction(referenceIso, concurrentCount, state) {
  const canonicalReferenceIso = roundIsoToNearestHalfHour(referenceIso);
  const timestampMs = Date.parse(canonicalReferenceIso);
  const fallbackCount = Number(concurrentCount || 0);
  if (!Number.isFinite(timestampMs)) {
    return {
      canonicalReferenceIso,
      modelReady: false,
      expectedConcurrentCount: fallbackCount,
      expectedConcurrentStdDev: 0,
      timeOfDayExpected: null,
      timeOfWeekExpected: null,
      timeOfDaySampleCount: 0,
      timeOfWeekSampleCount: 0,
      timeOfWeekBlendWeight: 0,
      sigmaShift: 0,
      divergence: 0,
    };
  }

  const weekSlotParts = getWeekSlotPartsFromIso(canonicalReferenceIso, state.weeklyBaselineTimeZone);
  const slotStats = weekSlotParts == null ? null : state.weeklySlotStats[weekSlotParts.weekSlot];
  const expectedConcurrentCount = Number.isFinite(slotStats?.mean)
    ? slotStats.mean
    : state.globalMean ?? fallbackCount;
  const expectedConcurrentStdDev = Number.isFinite(slotStats?.stdDev)
    ? slotStats.stdDev
    : state.globalStdDev ?? 0;
  const dayRatioAdjustment =
    state.concurrentPredictionModel === CONCURRENT_WEEKLY_DAY_RATIO_MODEL
      ? buildPriorYearDayRatioAdjustment(canonicalReferenceIso, state)
      : null;
  const holidayAdjustment =
    state.concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
      ? buildUsHolidayAdjustment(canonicalReferenceIso, state)
      : null;
  const calendarRatio = dayRatioAdjustment?.dailyRatio ?? holidayAdjustment?.holidayRatio ?? 1;
  const calendarRatioStdDev = holidayAdjustment?.holidayRatioStdDev ?? 0;
  const scaledExpectedConcurrentCount = expectedConcurrentCount * calendarRatio;
  const scaledExpectedConcurrentStdDev = Math.sqrt(
    (expectedConcurrentStdDev * calendarRatio) ** 2 +
      (expectedConcurrentCount * calendarRatioStdDev) ** 2,
  );
  const modelReady =
    state.weeklyBaselineSampleCount >= CONCURRENT_MIN_HISTORY_SAMPLES &&
    Boolean(slotStats?.sampleCount);
  const divergence = modelReady ? fallbackCount - scaledExpectedConcurrentCount : 0;
  const sigmaShift =
    modelReady && scaledExpectedConcurrentStdDev ? divergence / scaledExpectedConcurrentStdDev : 0;

  return {
    canonicalReferenceIso,
    modelReady,
    slot: weekSlotParts?.slot,
    weekday: weekSlotParts?.weekday,
    weekSlot: weekSlotParts?.weekSlot,
    timeOfDayExpected: null,
    timeOfWeekExpected: expectedConcurrentCount,
    timeOfDaySampleCount: 0,
    timeOfWeekSampleCount: slotStats?.sampleCount ?? 0,
    timeOfWeekBlendWeight: modelReady ? 1 : 0,
    baseExpectedConcurrentCount: expectedConcurrentCount,
    calendarAdjustment: scaledExpectedConcurrentCount - expectedConcurrentCount,
    calendarSampleCount:
      dayRatioAdjustment?.priorYearDaySampleCount ?? holidayAdjustment?.holidaySampleCount ?? 0,
    calendarEffectiveWeight:
      dayRatioAdjustment?.dailyRatioReady ? 1 : holidayAdjustment?.holidayEffectiveWeight ?? 0,
    calendarBlendWeight:
      dayRatioAdjustment?.dailyRatioReady ? 1 : holidayAdjustment?.holidayBlendWeight ?? 0,
    annualRatio: null,
    annualExpectedConcurrentCount: null,
    dailyRatio: dayRatioAdjustment?.dailyRatio ?? null,
    rawDailyRatio: dayRatioAdjustment?.rawDailyRatio ?? null,
    dailyRatioReady: dayRatioAdjustment?.dailyRatioReady ?? false,
    priorYearDateKey: dayRatioAdjustment?.priorYearDateKey ?? null,
    priorYearDayAverage: dayRatioAdjustment?.priorYearDayAverage ?? null,
    priorYearDaySampleCount: dayRatioAdjustment?.priorYearDaySampleCount ?? 0,
    priorYearWeekdayAverage: dayRatioAdjustment?.priorYearWeekdayAverage ?? null,
    priorYearWeekdayDailySampleCount: dayRatioAdjustment?.priorYearWeekdayDailySampleCount ?? 0,
    holidayId: holidayAdjustment?.id ?? null,
    holidayLabel: holidayAdjustment?.label ?? null,
    holidayDateKey: holidayAdjustment?.holidayDateKey ?? null,
    holidayOffsetDays: holidayAdjustment?.offsetDays ?? null,
    holidaySlot: holidayAdjustment?.holidaySlot ?? null,
    holidayRatio: holidayAdjustment?.holidayRatio ?? null,
    rawHolidayRatio: holidayAdjustment?.rawHolidayRatio ?? null,
    holidayRatioStdDev: holidayAdjustment?.holidayRatioStdDev ?? null,
    holidayRatioReady: holidayAdjustment?.holidayRatioReady ?? false,
    holidaySampleCount: holidayAdjustment?.holidaySampleCount ?? 0,
    holidayEffectiveWeight: holidayAdjustment?.holidayEffectiveWeight ?? 0,
    holidayBlendWeight: holidayAdjustment?.holidayBlendWeight ?? 0,
    concurrentPredictionModel: state.concurrentPredictionModel,
    concurrentPredictionTimeZone: state.weeklyBaselineTimeZone,
    expectedConcurrentCount: modelReady ? scaledExpectedConcurrentCount : fallbackCount,
    expectedConcurrentStdDev: modelReady ? scaledExpectedConcurrentStdDev : 0,
    weeklySampleCount: slotStats?.sampleCount ?? 0,
    historySampleCount: state.historySampleCount,
    baselineHistorySampleCount: state.baselineHistorySampleCount,
    weeklyBaselineSampleCount: state.weeklyBaselineSampleCount,
    requiredHistorySampleCount: CONCURRENT_MIN_HISTORY_SAMPLES,
    calendarLearningResidual: 0,
    sigmaShift,
    divergence,
  };
}

function buildWeeklyBaselinePredictionContext(normalizedRows, options = {}) {
  const weeklyBaselineTimeZone =
    options.weeklyBaselineTimeZone ?? CONCURRENT_WEEKLY_BASELINE_TIME_ZONE;
  const concurrentPredictionModel =
    options.concurrentPredictionModel === CONCURRENT_WEEKLY_DAY_RATIO_MODEL
      ? CONCURRENT_WEEKLY_DAY_RATIO_MODEL
      : options.concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
        ? CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
      : CONCURRENT_WEEKLY_BASELINE_MODEL;
  const holidayWindowDays = options.holidayWindowDays ?? CONCURRENT_US_HOLIDAY_WINDOW_DAYS;
  const denseHistorySegment = buildDenseHistorySegment(normalizedRows);
  const denseHistoryRows = denseHistorySegment.rows;
  const nonHolidayDenseHistoryRows =
    concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
      ? denseHistoryRows.filter((row) =>
          !isUsHolidayWindowIso(
            roundIsoToNearestHalfHour(row.sampledAt),
            weeklyBaselineTimeZone,
            holidayWindowDays,
          ),
        )
      : denseHistoryRows;
  const weeklyBaselineRows = nonHolidayDenseHistoryRows.length
    ? nonHolidayDenseHistoryRows
    : denseHistoryRows;
  const weeklyAccumulators = Array.from({ length: CONCURRENT_WEEKLY_SLOT_COUNT }, createCountAccumulator);
  const globalAccumulator = createCountAccumulator();

  for (const row of weeklyBaselineRows) {
    const canonicalRowIso = roundIsoToNearestHalfHour(row.sampledAt);
    const weekSlotParts = getWeekSlotPartsFromIso(canonicalRowIso, weeklyBaselineTimeZone);
    if (weekSlotParts == null) {
      continue;
    }

    addToCountAccumulator(weeklyAccumulators[weekSlotParts.weekSlot], row.concurrentCount);
    addToCountAccumulator(globalAccumulator, row.concurrentCount);
  }

  const globalStats = finalizeCountAccumulator(globalAccumulator, 0, 0);
  const weeklySlotStats = weeklyAccumulators.map((accumulator) =>
    finalizeCountAccumulator(accumulator, globalStats.mean, globalStats.stdDev),
  );
  const dailyAverageStats =
    concurrentPredictionModel === CONCURRENT_WEEKLY_DAY_RATIO_MODEL
      ? buildDailyAverageStats(denseHistoryRows, weeklyBaselineTimeZone)
      : {
          dailyAveragesByDate: new Map(),
          weekdayDayAverages: Array.from({ length: 7 }, () => finalizeCountAccumulator(createCountAccumulator())),
        };
  const state = {
    concurrentPredictionModel,
    weeklyBaselineTimeZone,
    weeklySlotStats,
    dailyAveragesByDate: dailyAverageStats.dailyAveragesByDate,
    weekdayDayAverages: dailyAverageStats.weekdayDayAverages,
    dailyAverageMinSamples: options.dailyAverageMinSamples ?? CONCURRENT_DAILY_AVERAGE_MIN_SAMPLES,
    dayRatioMin: options.dayRatioMin ?? CONCURRENT_DAY_RATIO_MIN,
    dayRatioMax: options.dayRatioMax ?? CONCURRENT_DAY_RATIO_MAX,
    holidayWindowDays,
    holidayOffsetSigmaDays: options.holidayOffsetSigmaDays ?? CONCURRENT_US_HOLIDAY_OFFSET_SIGMA_DAYS,
    holidaySlotSigmaSlots: options.holidaySlotSigmaSlots ?? CONCURRENT_US_HOLIDAY_SLOT_SIGMA_SLOTS,
    holidayYearHalfLife: options.holidayYearHalfLife ?? CONCURRENT_US_HOLIDAY_YEAR_HALF_LIFE,
    holidayShrinkage: options.holidayShrinkage ?? CONCURRENT_US_HOLIDAY_SHRINKAGE,
    holidayRatioMin: options.holidayRatioMin ?? CONCURRENT_US_HOLIDAY_RATIO_MIN,
    holidayRatioMax: options.holidayRatioMax ?? CONCURRENT_US_HOLIDAY_RATIO_MAX,
    globalMean: globalStats.mean,
    globalStdDev: globalStats.stdDev,
    historySampleCount: normalizedRows.length,
    baselineHistorySampleCount: denseHistoryRows.length,
    weeklyBaselineSampleCount: weeklyBaselineRows.length,
    denseHistoryStartedAt: denseHistoryRows[0]?.sampledAt ?? null,
    denseHistoryEndedAt: denseHistoryRows[denseHistoryRows.length - 1]?.sampledAt ?? null,
    alarmSigmaThreshold: DEFAULT_ALARM_SIGMA_THRESHOLD,
  };
  state.holidayEffectEntriesByHoliday =
    concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
      ? buildUsHolidaySlotEffectEntries(normalizedRows, state)
      : new Map();
  const provisionalRecords = normalizedRows.map((row) => ({
    sampledAt: row.sampledAt,
    concurrentCount: row.concurrentCount,
    ...buildWeeklyBaselinePrediction(row.sampledAt, row.concurrentCount, state),
  }));
  const denseProvisionalRecords = provisionalRecords.filter((record) => {
    const timestampMs = Date.parse(record.sampledAt);
    return (
      Number.isFinite(timestampMs) &&
      Number.isFinite(denseHistorySegment.startMs) &&
      Number.isFinite(denseHistorySegment.endMs) &&
      timestampMs >= denseHistorySegment.startMs &&
      timestampMs <= denseHistorySegment.endMs
    );
  });
  const signalCalibration = buildConcurrentSignalCalibration(
    denseProvisionalRecords.length ? denseProvisionalRecords : provisionalRecords,
    options.signalCalibrationModel,
  );
  state.signalCalibration = signalCalibration;
  const scoredProvisionalRecords = provisionalRecords.map((record) => {
    const signal = computeBaselineSignal(
      Number(record.concurrentCount || 0),
      Number(record.expectedConcurrentCount || 0),
      Number(record.expectedConcurrentStdDev || 0),
      DEFAULT_ALARM_SIGMA_THRESHOLD,
      signalCalibration,
    );
    return {
      ...record,
      ...signal,
      effectiveConcurrentStdDev: signal.effectiveBaselineStdDev,
    };
  });
  const alarmSigmaThreshold = calibrateConcurrentAlarmThreshold(scoredProvisionalRecords);
  state.alarmSigmaThreshold = alarmSigmaThreshold;
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  const records = provisionalRecords.map((record) => {
    const signal = computeBaselineSignal(
      Number(record.concurrentCount || 0),
      Number(record.expectedConcurrentCount || 0),
      Number(record.expectedConcurrentStdDev || 0),
      alarmSigmaThreshold,
      signalCalibration,
    );
    return {
      ...record,
      ...signal,
      effectiveConcurrentStdDev: signal.effectiveBaselineStdDev,
    };
  });
  const bySampledAt = new Map(records.map((record) => [record.sampledAt, record]));

  return {
    records,
    bySampledAt,
    alarmSigmaThreshold,
    elevatedSigmaThreshold,
    state,
    signalCalibration,
    concurrentPredictionModel,
  };
}

function buildConcurrentPredictionContext(rows, options = {}) {
  const resolvedOptions = resolveConcurrentPredictionOptions(options);
  const normalizedRows = rows.map((row) => ({
    sampledAt: row.sampledAt,
    concurrentCount: Number(row.concurrentCount || 0),
  })).sort((left, right) => Date.parse(left.sampledAt) - Date.parse(right.sampledAt));

  if (
    resolvedOptions.concurrentPredictionModel === CONCURRENT_WEEKLY_BASELINE_MODEL ||
    resolvedOptions.concurrentPredictionModel === CONCURRENT_WEEKLY_DAY_RATIO_MODEL ||
    resolvedOptions.concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
  ) {
    return buildWeeklyBaselinePredictionContext(normalizedRows, resolvedOptions);
  }

  const state = {
    slotHistory: Array.from({ length: CONCURRENT_DAILY_SLOT_COUNT }, () => []),
    weekdaySlotHistory: Array.from({ length: 7 }, () =>
      Array.from({ length: CONCURRENT_DAILY_SLOT_COUNT }, () => []),
    ),
    slotResidualHistory: Array.from({ length: CONCURRENT_DAILY_SLOT_COUNT }, () => []),
    weekdaySlotResidualHistory: Array.from({ length: 7 }, () =>
      Array.from({ length: CONCURRENT_DAILY_SLOT_COUNT }, () => []),
    ),
    calendarDayResidualHistory: Array.from({ length: 366 }, () => []),
    annualRatioHistory: new Map(),
    historySampleCount: 0,
    alarmSigmaThreshold: DEFAULT_ALARM_SIGMA_THRESHOLD,
  };
  const provisionalRecords = [];
  let pendingCalendarDay = null;
  let pendingCalendarResiduals = [];

  function flushPendingCalendarDay() {
    if (!pendingCalendarDay || !pendingCalendarResiduals.length) {
      pendingCalendarDay = null;
      pendingCalendarResiduals = [];
      return;
    }

    const residual = mean(pendingCalendarResiduals);
    if (Number.isFinite(residual)) {
      state.calendarDayResidualHistory[pendingCalendarDay.dayOfYear].push({
        ...pendingCalendarDay,
        residual,
        sampleCount: pendingCalendarResiduals.length,
      });
    }

    pendingCalendarDay = null;
    pendingCalendarResiduals = [];
  }

  for (const row of normalizedRows) {
    const canonicalRowIso = roundIsoToNearestHalfHour(row.sampledAt);
    const rowDayKey = canonicalRowIso.slice(0, 10);
    if (pendingCalendarDay && pendingCalendarDay.dayKey !== rowDayKey) {
      flushPendingCalendarDay();
    }
    if (!pendingCalendarDay) {
      const timestampMs = Date.parse(canonicalRowIso);
      pendingCalendarDay = {
        dayKey: rowDayKey,
        timestampMs,
        dayOfYear: getDayOfYearFromIso(canonicalRowIso),
        weekday: getWeekdayFromIso(canonicalRowIso),
      };
    }

    const prediction = buildConcurrentPredictionFromState(row.sampledAt, row.concurrentCount, state, resolvedOptions);
    provisionalRecords.push({
      sampledAt: row.sampledAt,
      concurrentCount: row.concurrentCount,
      ...prediction,
    });

    const timestampMs = Date.parse(row.sampledAt);
    const historyEntry = {
      timestampMs,
      count: row.concurrentCount,
    };
    state.slotHistory[prediction.slot].push(historyEntry);
    state.weekdaySlotHistory[prediction.weekday][prediction.slot].push(historyEntry);

    if (prediction.modelReady) {
      const residualEntry = {
        timestampMs,
        residual: prediction.divergence,
      };
      state.slotResidualHistory[prediction.slot].push(residualEntry);
      state.weekdaySlotResidualHistory[prediction.weekday][prediction.slot].push(residualEntry);
    }

    if (prediction.modelReady && Number.isFinite(prediction.calendarLearningResidual)) {
      pendingCalendarResiduals.push(prediction.calendarLearningResidual);
    }

    if (
      prediction.modelReady &&
      Number.isFinite(prediction.baseExpectedConcurrentCount) &&
      prediction.baseExpectedConcurrentCount > 0
    ) {
      const annualRatioKey = buildLocalPartsSlotKey(
        getTimeZoneCalendarParts(
          prediction.canonicalReferenceIso,
          resolvedOptions.annualRatioTimeZone || CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
        ),
      );
      const annualRatioEntries = state.annualRatioHistory.get(annualRatioKey) || [];
      annualRatioEntries.push({
        timestampMs,
        ratio: row.concurrentCount / prediction.baseExpectedConcurrentCount,
      });
      state.annualRatioHistory.set(annualRatioKey, annualRatioEntries);
    }

    state.historySampleCount += 1;
  }
  flushPendingCalendarDay();

  const alarmSigmaThreshold = calibrateConcurrentAlarmThreshold(provisionalRecords);
  state.alarmSigmaThreshold = alarmSigmaThreshold;
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  const records = provisionalRecords.map((record) => ({
    ...record,
    ...computeBaselineSignal(
      Number(record.concurrentCount || 0),
      Number(record.expectedConcurrentCount || 0),
      Number(record.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
      alarmSigmaThreshold,
    ),
  }));
  const bySampledAt = new Map(records.map((record) => [record.sampledAt, record]));

  return {
    records,
    bySampledAt,
    alarmSigmaThreshold,
    elevatedSigmaThreshold,
    state,
  };
}

function getNearestConcurrentRecord(context, referenceIso) {
  const exactMatch = context.bySampledAt.get(referenceIso);
  if (exactMatch) {
    return exactMatch;
  }

  const referenceTimestamp = Date.parse(referenceIso);
  if (!Number.isFinite(referenceTimestamp)) {
    return null;
  }

  let nearestRecord = null;
  let nearestDifferenceMs = Number.POSITIVE_INFINITY;
  for (const record of context.records) {
    const differenceMs = Math.abs(Date.parse(record.sampledAt) - referenceTimestamp);
    if (differenceMs < nearestDifferenceMs) {
      nearestDifferenceMs = differenceMs;
      nearestRecord = record;
    }
  }

  return nearestDifferenceMs <= MATCH_WINDOW_MS ? nearestRecord : null;
}

function computeConcurrentPredictionModel(
  referenceIso,
  concurrentCount,
  concurrentContext = null,
  options = {},
) {
  const resolvedOptions = resolveConcurrentPredictionOptions(options);
  const context = concurrentContext || buildConcurrentPredictionContext(getAllConcurrentMetrics(), resolvedOptions);
  const referenceRecord = getNearestConcurrentRecord(context, referenceIso);

  if (referenceRecord) {
    const resolvedConcurrentCount = Number(concurrentCount ?? referenceRecord.concurrentCount ?? 0);
    const compositeSignal = computeBaselineSignal(
      resolvedConcurrentCount,
      Number(referenceRecord.expectedConcurrentCount || 0),
      Number(referenceRecord.expectedConcurrentStdDev ?? 0),
      context.alarmSigmaThreshold,
      context.signalCalibration,
    );

    return {
      ...referenceRecord,
      concurrentCount: resolvedConcurrentCount,
      divergence: resolvedConcurrentCount - Number(referenceRecord.expectedConcurrentCount || 0),
      sigmaShift: compositeSignal.sigmaShift,
      rawSigmaShift: compositeSignal.rawSigmaShift,
      varianceAdjustedSigmaShift: compositeSignal.varianceAdjustedSigmaShift,
      effectiveConcurrentStdDev: compositeSignal.effectiveBaselineStdDev,
      absoluteExcessWeight: compositeSignal.absoluteExcessWeight,
      gaugeValue: compositeSignal.gaugeValue,
      alertLevel: compositeSignal.alertLevel,
      emergencyLevel: compositeSignal.emergencyLevel,
      alarmSigmaThreshold: context.alarmSigmaThreshold,
      elevatedSigmaThreshold: context.elevatedSigmaThreshold,
      compositeSignal,
    };
  }

  if (
    context.concurrentPredictionModel === CONCURRENT_WEEKLY_BASELINE_MODEL ||
    context.concurrentPredictionModel === CONCURRENT_WEEKLY_DAY_RATIO_MODEL ||
    context.concurrentPredictionModel === CONCURRENT_WEEKLY_US_HOLIDAY_MODEL
  ) {
    const prediction = buildWeeklyBaselinePrediction(referenceIso, concurrentCount, context.state);
    const compositeSignal = computeBaselineSignal(
      Number(concurrentCount || 0),
      Number(prediction.expectedConcurrentCount || 0),
      Number(prediction.expectedConcurrentStdDev || 0),
      context.alarmSigmaThreshold,
      context.signalCalibration,
    );

    return {
      ...prediction,
      sigmaShift: compositeSignal.sigmaShift,
      rawSigmaShift: compositeSignal.rawSigmaShift,
      varianceAdjustedSigmaShift: compositeSignal.varianceAdjustedSigmaShift,
      effectiveConcurrentStdDev: compositeSignal.effectiveBaselineStdDev,
      absoluteExcessWeight: compositeSignal.absoluteExcessWeight,
      alarmSigmaThreshold: context.alarmSigmaThreshold,
      elevatedSigmaThreshold: context.elevatedSigmaThreshold,
      compositeSignal,
    };
  }

  const prediction = buildConcurrentPredictionFromState(referenceIso, concurrentCount, context.state, resolvedOptions);
  const compositeSignal = computeBaselineSignal(
    Number(concurrentCount || 0),
    Number(prediction.expectedConcurrentCount || 0),
    Number(prediction.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
    context.alarmSigmaThreshold,
  );

  return {
    ...prediction,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    elevatedSigmaThreshold: context.elevatedSigmaThreshold,
    compositeSignal,
  };
}

function parseSavedHeatmapStatus() {
  const savedValue = getMetaValue(HEATMAP_STATUS_META_KEY);
  if (!savedValue) {
    return null;
  }

  try {
    return JSON.parse(savedValue);
  } catch {
    return null;
  }
}

function buildStoredHeatmapStatus(overrides = {}) {
  const savedStatus = parseSavedHeatmapStatus() || {};
  delete savedStatus.rolling24hCount;
  return {
    provider: HEATMAP_SOURCE,
    providerLabel: "ADS-B Exchange heatmap",
    cadenceMinutes: 30,
    refreshing: false,
    nextRefreshAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    usedCache: null,
    matchedCount: null,
    airborneCount: null,
    concurrentCount: null,
    ...savedStatus,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    ...overrides,
  };
}

function getTrailingConcurrentRecords(records, days = 365) {
  if (!records.length) {
    return [];
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - days * DAY_MS;
  return records.filter((record) => Date.parse(record.sampledAt) >= lowerBound);
}

function buildHolidayWindows(records) {
  const windowsByHoliday = new Map();

  for (const record of records) {
    if (
      record.concurrentPredictionModel !== CONCURRENT_WEEKLY_US_HOLIDAY_MODEL ||
      !record.holidayRatioReady ||
      !record.holidayId ||
      !record.holidayDateKey
    ) {
      continue;
    }

    const timestamp = Date.parse(record.sampledAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    const key = `${record.holidayId}:${record.holidayDateKey}`;
    const existing = windowsByHoliday.get(key) || {
      id: record.holidayId,
      label: record.holidayLabel,
      holidayDateKey: record.holidayDateKey,
      startsAtMs: timestamp,
      endsAtMs: timestamp + HALF_HOUR_MS,
      minOffsetDays: record.holidayOffsetDays,
      maxOffsetDays: record.holidayOffsetDays,
      weightedRatioSum: 0,
      ratioSampleCount: 0,
    };
    existing.startsAtMs = Math.min(existing.startsAtMs, timestamp);
    existing.endsAtMs = Math.max(existing.endsAtMs, timestamp + HALF_HOUR_MS);
    existing.minOffsetDays = Math.min(existing.minOffsetDays, record.holidayOffsetDays);
    existing.maxOffsetDays = Math.max(existing.maxOffsetDays, record.holidayOffsetDays);
    if (Number.isFinite(record.holidayRatio)) {
      existing.weightedRatioSum += record.holidayRatio;
      existing.ratioSampleCount += 1;
    }
    windowsByHoliday.set(key, existing);
  }

  return Array.from(windowsByHoliday.values())
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
    .map((window) => ({
      id: window.id,
      label: window.label,
      holidayDateKey: window.holidayDateKey,
      startsAt: new Date(window.startsAtMs).toISOString(),
      endsAt: new Date(window.endsAtMs).toISOString(),
      minOffsetDays: window.minOffsetDays,
      maxOffsetDays: window.maxOffsetDays,
      averageRatio: window.ratioSampleCount
        ? roundNumber(window.weightedRatioSum / window.ratioSampleCount, 3)
        : null,
    }));
}

function buildDashboardPayload({
  liveStatus: liveStatusOverride = null,
  concurrentPredictionOptions = {},
} = {}) {
  const resolvedConcurrentPredictionOptions = resolveConcurrentPredictionOptions(concurrentPredictionOptions);
  const tracking = getTrackingSummary();
  const liveStatus = buildStoredHeatmapStatus(liveStatusOverride || {});
  const referenceIso = liveStatus.latestSampledAt || new Date().toISOString();
  const concurrentCount = getConcurrentCount(HEATMAP_SOURCE);
  const concurrentHistory = getAllConcurrentMetrics();
  const concurrentContext = buildConcurrentPredictionContext(concurrentHistory, resolvedConcurrentPredictionOptions);
  const currentModel = computeConcurrentPredictionModel(
    referenceIso,
    concurrentCount,
    concurrentContext,
    resolvedConcurrentPredictionOptions,
  );
  const trailingConcurrentRecords = getTrailingConcurrentRecords(concurrentContext.records);
  const archiveSeries = compactArchiveSeries(trailingConcurrentRecords);

  return {
    mode: tracking.configured ? "configured" : "empty",
    warning: tracking.configured ? null : tracking.reason,
    cohort: tracking,
    watchlist: tracking,
    // The payload is public: the cache path is a server filesystem location.
    liveStatus: {
      ...liveStatus,
      cachePath: undefined,
      concurrentCount,
    },
    current: {
      asOf: referenceIso,
      concurrentCount,
      baselineMean: currentModel.expectedConcurrentCount,
      baselineStdDev: currentModel.expectedConcurrentStdDev,
      effectiveBaselineStdDev:
        currentModel.effectiveConcurrentStdDev ?? currentModel.compositeSignal.effectiveBaselineStdDev,
      zScore: currentModel.compositeSignal.sigmaShift,
      rawZScore: currentModel.compositeSignal.rawSigmaShift,
      varianceAdjustedZScore: currentModel.compositeSignal.varianceAdjustedSigmaShift,
      absoluteExcessWeight: currentModel.compositeSignal.absoluteExcessWeight,
      gaugeValue: currentModel.compositeSignal.gaugeValue,
      modelReady: currentModel.modelReady === true,
      alertLevel: currentModel.modelReady === true ? currentModel.compositeSignal.alertLevel : "normal",
      emergencyLevel: currentModel.modelReady === true ? currentModel.compositeSignal.emergencyLevel : 1,
      alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
      elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
      historySampleCount: currentModel.historySampleCount,
      baselineHistorySampleCount: currentModel.baselineHistorySampleCount,
      weeklyBaselineSampleCount: currentModel.weeklyBaselineSampleCount,
      requiredHistorySampleCount: currentModel.requiredHistorySampleCount,
    },
    signals: {
      composite: {
        asOf: referenceIso,
        actualConcurrentCount: concurrentCount,
        modelReady: currentModel.modelReady === true,
        expectedConcurrentCount: currentModel.expectedConcurrentCount,
        expectedConcurrentStdDev: currentModel.expectedConcurrentStdDev,
        effectiveConcurrentStdDev:
          currentModel.effectiveConcurrentStdDev ?? currentModel.compositeSignal.effectiveBaselineStdDev,
        rawSigmaShift: currentModel.compositeSignal.rawSigmaShift,
        varianceAdjustedSigmaShift: currentModel.compositeSignal.varianceAdjustedSigmaShift,
        absoluteExcessWeight: currentModel.compositeSignal.absoluteExcessWeight,
        signalCalibrationModel: concurrentContext.signalCalibration?.model,
        signalStdDevFloor: currentModel.compositeSignal.stdDevFloor,
        signalPositiveExcessScale: currentModel.compositeSignal.positiveExcessScale,
        timeOfDayExpected: currentModel.timeOfDayExpected,
        timeOfWeekExpected: currentModel.timeOfWeekExpected,
        calendarAdjustment: currentModel.calendarAdjustment,
        calendarSampleCount: currentModel.calendarSampleCount,
        calendarEffectiveWeight: currentModel.calendarEffectiveWeight,
        calendarBlendWeight: currentModel.calendarBlendWeight,
        annualRatio: currentModel.annualRatio,
        annualExpectedConcurrentCount: currentModel.annualExpectedConcurrentCount,
        dailyRatio: currentModel.dailyRatio,
        rawDailyRatio: currentModel.rawDailyRatio,
        dailyRatioReady: currentModel.dailyRatioReady,
        priorYearDateKey: currentModel.priorYearDateKey,
        priorYearDayAverage: currentModel.priorYearDayAverage,
        priorYearDaySampleCount: currentModel.priorYearDaySampleCount,
        priorYearWeekdayAverage: currentModel.priorYearWeekdayAverage,
        priorYearWeekdayDailySampleCount: currentModel.priorYearWeekdayDailySampleCount,
        holidayId: currentModel.holidayId,
        holidayLabel: currentModel.holidayLabel,
        holidayDateKey: currentModel.holidayDateKey,
        holidayOffsetDays: currentModel.holidayOffsetDays,
        holidaySlot: currentModel.holidaySlot,
        holidayRatio: currentModel.holidayRatio,
        rawHolidayRatio: currentModel.rawHolidayRatio,
        holidayRatioStdDev: currentModel.holidayRatioStdDev,
        holidayRatioReady: currentModel.holidayRatioReady,
        holidaySampleCount: currentModel.holidaySampleCount,
        holidayEffectiveWeight: currentModel.holidayEffectiveWeight,
        holidayBlendWeight: currentModel.holidayBlendWeight,
        concurrentPredictionModel: currentModel.concurrentPredictionModel,
        concurrentPredictionTimeZone: currentModel.concurrentPredictionTimeZone,
        weeklySampleCount: currentModel.weeklySampleCount,
        timeOfDaySampleCount: currentModel.timeOfDaySampleCount,
        timeOfWeekSampleCount: currentModel.timeOfWeekSampleCount,
        historySampleCount: currentModel.historySampleCount,
        baselineHistorySampleCount: currentModel.baselineHistorySampleCount,
        weeklyBaselineSampleCount: currentModel.weeklyBaselineSampleCount,
        requiredHistorySampleCount: currentModel.requiredHistorySampleCount,
        timeOfWeekBlendWeight: currentModel.timeOfWeekBlendWeight,
        sigmaShift: currentModel.compositeSignal.sigmaShift,
        gaugeValue: currentModel.compositeSignal.gaugeValue,
        alertLevel: currentModel.modelReady === true ? currentModel.compositeSignal.alertLevel : "normal",
        emergencyLevel: currentModel.modelReady === true ? currentModel.compositeSignal.emergencyLevel : 1,
        alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
        elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
      },
    },
    liveAircraft: getLiveAircraft(HEATMAP_SOURCE),
    trends: {
      archive: archiveSeries,
      holidayWindows: buildHolidayWindows(trailingConcurrentRecords),
    },
  };
}

function buildDashboardSnapshot({
  liveStatus = null,
  snapshotGeneratedAt = new Date().toISOString(),
  concurrentPredictionOptions = {},
} = {}) {
  const trackedCount = getTrackedAircraftCount();
  const hasAnyHistoricalData = getAllConcurrentMetrics().length > 0;
  const onlyDemoData = areAllTrackedAircraftDemo();

  if ((!trackedCount && !hasAnyHistoricalData) || onlyDemoData) {
    const demoDashboard = getDemoDashboard();
    return {
      ...demoDashboard,
      trends: {
        ...demoDashboard.trends,
        archive: compactArchiveSeries(demoDashboard.trends?.archive ?? []),
      },
      snapshotGeneratedAt,
    };
  }

  return {
    ...buildDashboardPayload({ liveStatus, concurrentPredictionOptions }),
    snapshotGeneratedAt,
  };
}

module.exports = {
  buildDashboardPayload,
  buildDashboardSnapshot,
  buildStoredHeatmapStatus,
  buildConcurrentPredictionContext,
  computeConcurrentPredictionModel,
  getDefaultConcurrentPredictionOptions,
  CONCURRENT_ANNUAL_RATIO_MODEL,
  CONCURRENT_ANNUAL_RATIO_TIME_ZONE,
  CONCURRENT_WEEKLY_BASELINE_MODEL,
  CONCURRENT_WEEKLY_BASELINE_TIME_ZONE,
  CONCURRENT_WEEKLY_DAY_RATIO_MODEL,
  CONCURRENT_WEEKLY_US_HOLIDAY_MODEL,
  HEATMAP_SOURCE,
};
