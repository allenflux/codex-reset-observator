import {
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_TARGET_DEFINITION,
} from "@/data/shadowProbabilityConfig";
import { PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS } from "./prospectivePublishedModelEvaluation";
import {
  getRandomClockOutcome,
} from "./prospectiveRandomClockModelEvaluation";
import {
  selectDailyFirstForecasts,
  type ProspectiveForecastRow,
  type ProspectiveMetric,
  type ProspectiveModelEvaluation,
} from "./prospectiveProbabilityEvaluation";
import type { RecoveryResetBoundary } from "./recoveryBoundary";

const LOG_LOSS_EPSILON = 1e-12;
const HOUR_MS = 60 * 60 * 1000;

type StoredForecast = {
  modelVersion: string;
  generatedAt: string;
  probability24h: number;
  probability48h: number;
  randomElapsedHours?: number;
  [key: string]: unknown;
};

export type RandomBandwidthAgeBucket = "0-24h" | "24-48h" | "48-72h" | "72h+";

export type RandomBandwidthAgeBucketMetric = {
  count: number;
  positiveCount: number;
  averagePrediction: number;
  actualRate: number;
  brier: number;
};

export type RandomBandwidthProspectiveEvaluationReport = {
  schemaVersion: "prospective-random-bandwidth-truncation-evaluation-v1";
  status:
    | "insufficient_data"
    | "promising"
    | "no_meaningful_difference"
    | "worse"
    | "eligible_for_manual_review";
  generatedAt: string;
  asOf: string;
  evaluationMode: "prospective";
  backfilled: false;
  source: "prediction_history.debug_info.experimentalProbabilityForecasts";
  targetDefinition: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_TARGET_DEFINITION;
  activeModelVersion: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION;
  baselineModelVersion: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION;
  controlModelVersion: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION;
  challengerModelVersion: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION;
  freezeAt: typeof RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT;
  evaluationStartAt: string | null;
  canonicalBoundaryCount: number;
  forecastCounts: {
    control: number;
    challenger: number;
    comparable: number;
  };
  comparison: {
    resolved24h: number;
    resolved48h: number;
    positiveCount24h: number;
    positiveCount48h: number;
    targetResetCount: number;
    challengerMinusControl: {
      brier24h: number | null;
      brier48h: number | null;
      logLoss24h: number | null;
      logLoss48h: number | null;
    };
  };
  models: {
    control: ProspectiveModelEvaluation;
    challenger: ProspectiveModelEvaluation;
  };
  ageBuckets: Array<{
    ageBucket: RandomBandwidthAgeBucket;
    control: RandomBandwidthAgeBucketMetric;
    challenger: RandomBandwidthAgeBucketMetric;
  }>;
  gate: {
    autoPublish: false;
    manualReviewOnly: true;
    thresholds: typeof PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS;
    targetResetCount: number;
    resolvedDaily24h: number;
    resolvedDaily48h: number;
    brier24hNotWorse: boolean;
    brier48hNotWorse: boolean;
    logLossNotExtremelyWorse: boolean;
    eligibleForManualReview: boolean;
  };
  notes: string[];
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value: number) {
  return Number.isFinite(value)
    ? Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value))
    : 0.5;
}

function isStoredForecast(value: unknown): value is StoredForecast {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const forecast = value as Record<string, unknown>;
  return typeof forecast.modelVersion === "string"
    && typeof forecast.generatedAt === "string"
    && timestamp(forecast.generatedAt) !== null
    && typeof forecast.probability24h === "number"
    && Number.isFinite(forecast.probability24h)
    && typeof forecast.probability48h === "number"
    && Number.isFinite(forecast.probability48h);
}

export function getRandomBandwidthAgeBucket(ageHours: number): RandomBandwidthAgeBucket | null {
  if (!Number.isFinite(ageHours) || ageHours < 0) return null;
  if (ageHours < 24) return "0-24h";
  if (ageHours < 48) return "24-48h";
  if (ageHours < 72) return "48-72h";
  return "72h+";
}

function getForecast(row: ProspectiveForecastRow, modelVersion: string) {
  const value = row.forecasts[modelVersion];
  if (!isStoredForecast(value) || value.modelVersion !== modelVersion) return null;
  const rowTime = timestamp(row.generatedAt);
  const forecastTime = timestamp(value.generatedAt);
  return rowTime !== null && forecastTime === rowTime ? value : null;
}

export function selectComparableRandomBandwidthForecasts(rows: Array<ProspectiveForecastRow>) {
  return rows.filter((row) => {
    const control = getForecast(row, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION);
    const challenger = getForecast(row, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION);
    return control !== null
      && challenger !== null
      && timestamp(control.generatedAt) === timestamp(challenger.generatedAt);
  });
}

export function selectDailyFirstRandomBandwidthForecasts(rows: Array<ProspectiveForecastRow>) {
  return selectDailyFirstForecasts(selectComparableRandomBandwidthForecasts(rows));
}

function getResolvedRows(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  horizonHours: 24 | 48,
  boundaries: Array<RecoveryResetBoundary>,
  asOf: Date,
) {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = getForecast(row, modelVersion);
    const generatedTime = timestamp(row.generatedAt);
    if (
      forecast === null
      || generatedTime === null
      || !Number.isFinite(asOfTime)
      || generatedTime + horizonHours * HOUR_MS > asOfTime
    ) {
      return [];
    }
    const actual = getRandomClockOutcome(boundaries, row.generatedAt, horizonHours);
    if (actual === null) return [];
    const endTime = generatedTime + horizonHours * HOUR_MS;
    const targetIds = boundaries
      .filter((boundary) => {
        const boundaryTime = timestamp(boundary.resetAt);
        return boundary.isRandom
          && boundaryTime !== null
          && boundaryTime > generatedTime
          && boundaryTime <= endTime;
      })
      .map((boundary) => boundary.id);
    return [{
      generatedAt: row.generatedAt,
      prediction: horizonHours === 24 ? forecast.probability24h : forecast.probability48h,
      actual: Number(actual),
      targetIds,
      randomElapsedHours: typeof forecast.randomElapsedHours === "number"
        ? forecast.randomElapsedHours
        : null,
    }];
  });
}

function getCalibrationBuckets(values: Array<{ prediction: number; actual: number }>) {
  return [0, 0.2, 0.4, 0.6, 0.8].map((lower) => {
    const upper = lower + 0.2;
    const bucket = values.filter(({ prediction }) =>
      prediction >= lower && (prediction < upper || (upper === 1 && prediction <= upper)),
    );
    return {
      range: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      count: bucket.length,
      averagePrediction: bucket.length === 0
        ? 0
        : bucket.reduce((sum, value) => sum + value.prediction, 0) / bucket.length,
      actualRate: bucket.length === 0
        ? 0
        : bucket.reduce((sum, value) => sum + value.actual, 0) / bucket.length,
    };
  });
}

function calculateMetric(
  rows: Array<{ generatedAt: string; prediction: number; actual: number; targetIds: string[] }>,
): ProspectiveMetric {
  const values = rows.map((row) => ({
    prediction: Math.min(1, Math.max(0, row.prediction)),
    actual: row.actual,
  }));
  if (values.length === 0) {
    return {
      count: 0,
      positiveCount: 0,
      actualRate: 0,
      averagePrediction: 0,
      brier: 0,
      logLoss: 0,
      calibration: getCalibrationBuckets([]),
      periodStart: null,
      periodEnd: null,
      targetResetCount: 0,
    };
  }
  return {
    count: values.length,
    positiveCount: values.reduce((sum, value) => sum + value.actual, 0),
    actualRate: values.reduce((sum, value) => sum + value.actual, 0) / values.length,
    averagePrediction: values.reduce((sum, value) => sum + value.prediction, 0) / values.length,
    brier: values.reduce((sum, value) => sum + (value.prediction - value.actual) ** 2, 0) / values.length,
    logLoss: values.reduce((sum, value) => {
      const prediction = clampProbability(value.prediction);
      return sum - (value.actual * Math.log(prediction) + (1 - value.actual) * Math.log(1 - prediction));
    }, 0) / values.length,
    calibration: getCalibrationBuckets(values),
    periodStart: rows[0].generatedAt,
    periodEnd: rows.at(-1)?.generatedAt ?? null,
    targetResetCount: new Set(rows.flatMap((row) => row.targetIds)).size,
  };
}

function calculateAgeMetric(
  rows: Array<{ prediction: number; actual: number }>,
): RandomBandwidthAgeBucketMetric {
  if (rows.length === 0) {
    return {
      count: 0,
      positiveCount: 0,
      averagePrediction: 0,
      actualRate: 0,
      brier: 0,
    };
  }
  const values = rows.map((row) => ({
    prediction: Math.min(1, Math.max(0, row.prediction)),
    actual: row.actual,
  }));
  return {
    count: values.length,
    positiveCount: values.reduce((sum, value) => sum + value.actual, 0),
    averagePrediction: values.reduce((sum, value) => sum + value.prediction, 0) / values.length,
    actualRate: values.reduce((sum, value) => sum + value.actual, 0) / values.length,
    brier: values.reduce((sum, value) => sum + (value.prediction - value.actual) ** 2, 0) / values.length,
  };
}

function createModelEvaluation(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  boundaries: Array<RecoveryResetBoundary>,
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion,
    metrics24h: calculateMetric(getResolvedRows(rows, modelVersion, 24, boundaries, asOf)),
    metrics48h: calculateMetric(getResolvedRows(rows, modelVersion, 48, boundaries, asOf)),
  };
}

function getFirstComparableForecastAt(rows: Array<ProspectiveForecastRow>) {
  return rows
    .map((row) => ({ row, time: timestamp(row.generatedAt) }))
    .filter((item): item is { row: ProspectiveForecastRow; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time)
    .at(0)?.row.generatedAt ?? null;
}

function getTargetResetCount(
  boundaries: Array<RecoveryResetBoundary>,
  evaluationStartAt: string | null,
  asOf: Date,
) {
  const start = timestamp(evaluationStartAt);
  if (start === null) return 0;
  return new Set(
    boundaries
      .filter((boundary) => {
        const time = timestamp(boundary.resetAt);
        return boundary.isRandom && time !== null && time > start && time <= asOf.getTime();
      })
      .map((boundary) => boundary.id),
  ).size;
}

function difference(active: number, baseline: number, count: number) {
  return count > 0 && Number.isFinite(active) && Number.isFinite(baseline)
    ? active - baseline
    : null;
}

function getForecastCounts(rows: Array<ProspectiveForecastRow>, modelVersion: string) {
  return rows.filter((row) => getForecast(row, modelVersion) !== null).length;
}

function getAgeBucketMetrics(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  boundaries: Array<RecoveryResetBoundary>,
  asOf: Date,
) {
  const resolvedRows = getResolvedRows(rows, modelVersion, 24, boundaries, asOf);
  const buckets: RandomBandwidthAgeBucket[] = ["0-24h", "24-48h", "48-72h", "72h+"];
  return buckets.map((ageBucket) => ({
    ageBucket,
    values: resolvedRows
      .filter((row) => getRandomBandwidthAgeBucket(row.randomElapsedHours ?? Number.NaN) === ageBucket)
      .map((row) => ({ prediction: row.prediction, actual: row.actual })),
  }));
}

export function evaluateRandomBandwidthTruncationModelProspectively(
  rows: Array<ProspectiveForecastRow>,
  boundaries: Array<RecoveryResetBoundary>,
  asOf: Date,
): RandomBandwidthProspectiveEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");

  const freezeTime = timestamp(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT);
  if (freezeTime === null) {
    throw new RangeError("RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT must be a valid date");
  }
  const isEligibleForecast = (row: ProspectiveForecastRow) => {
    const generatedAt = timestamp(row.generatedAt);
    return generatedAt !== null && generatedAt >= freezeTime && generatedAt <= asOf.getTime();
  };
  const eligibleRows = rows.filter(isEligibleForecast);
  const comparableRows = selectComparableRandomBandwidthForecasts(eligibleRows);
  const dailyRows = selectDailyFirstRandomBandwidthForecasts(comparableRows);
  const knownBoundaries = boundaries.filter((boundary) => {
    const boundaryTime = timestamp(boundary.resetAt);
    return boundaryTime !== null && boundaryTime <= asOf.getTime();
  });
  const control = createModelEvaluation(
    dailyRows,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );
  const challenger = createModelEvaluation(
    dailyRows,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );
  const evaluationStartAt = getFirstComparableForecastAt(comparableRows);
  const targetResetCount = getTargetResetCount(knownBoundaries, evaluationStartAt, asOf);
  const brier24h = difference(challenger.metrics24h.brier, control.metrics24h.brier, challenger.metrics24h.count);
  const brier48h = difference(challenger.metrics48h.brier, control.metrics48h.brier, challenger.metrics48h.count);
  const logLoss24h = difference(challenger.metrics24h.logLoss, control.metrics24h.logLoss, challenger.metrics24h.count);
  const logLoss48h = difference(challenger.metrics48h.logLoss, control.metrics48h.logLoss, challenger.metrics48h.count);
  const resolvedDaily24h = challenger.metrics24h.count;
  const resolvedDaily48h = challenger.metrics48h.count;
  const enoughData = targetResetCount >= PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS.targetResetCount
    && resolvedDaily24h >= PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS.resolvedDaily24h
    && resolvedDaily48h >= PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS.resolvedDaily48h;
  const brier24hNotWorse = brier24h !== null && brier24h <= 0;
  const brier48hNotWorse = brier48h !== null && brier48h <= 0;
  const logLossNotExtremelyWorse = (logLoss24h ?? 0) <= PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS.maxLogLossWorsening
    && (logLoss48h ?? 0) <= PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS.maxLogLossWorsening;
  const eligibleForManualReview = enoughData
    && brier24hNotWorse
    && brier48hNotWorse
    && logLossNotExtremelyWorse;
  const bothWorse = (brier24h ?? 0) > 0 && (brier48h ?? 0) > 0;
  const smallDifference = Math.max(Math.abs(brier24h ?? 0), Math.abs(brier48h ?? 0)) < 0.01;
  const status = !enoughData
    ? "insufficient_data"
    : eligibleForManualReview
      ? "eligible_for_manual_review"
      : bothWorse
        ? "worse"
        : smallDifference
          ? "no_meaningful_difference"
          : "promising";
  const controlAgeBuckets = getAgeBucketMetrics(
    dailyRows,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );
  const challengerAgeBuckets = getAgeBucketMetrics(
    dailyRows,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );

  return {
    schemaVersion: "prospective-random-bandwidth-truncation-evaluation-v1",
    status,
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    evaluationMode: "prospective",
    backfilled: false,
    source: "prediction_history.debug_info.experimentalProbabilityForecasts",
    targetDefinition: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_TARGET_DEFINITION,
    activeModelVersion: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
    baselineModelVersion: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
    controlModelVersion: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
    challengerModelVersion: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
    freezeAt: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
    evaluationStartAt,
    canonicalBoundaryCount: knownBoundaries.filter((boundary) => boundary.isRandom).length,
    forecastCounts: {
      control: getForecastCounts(eligibleRows, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION),
      challenger: getForecastCounts(eligibleRows, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION),
      comparable: comparableRows.length,
    },
    comparison: {
      resolved24h: challenger.metrics24h.count,
      resolved48h: challenger.metrics48h.count,
      positiveCount24h: challenger.metrics24h.positiveCount,
      positiveCount48h: challenger.metrics48h.positiveCount,
      targetResetCount,
      challengerMinusControl: {
        brier24h,
        brier48h,
        logLoss24h,
        logLoss48h,
      },
    },
    models: { control, challenger },
    ageBuckets: controlAgeBuckets.map((bucket, index) => ({
      ageBucket: bucket.ageBucket,
      control: calculateAgeMetric(bucket.values),
      challenger: calculateAgeMetric(challengerAgeBuckets[index].values),
    })),
    gate: {
      autoPublish: false,
      manualReviewOnly: true,
      thresholds: PROSPECTIVE_PUBLISHED_GATE_THRESHOLDS,
      targetResetCount,
      resolvedDaily24h,
      resolvedDaily48h,
      brier24hNotWorse,
      brier48hNotWorse,
      logLossNotExtremelyWorse,
      eligibleForManualReview,
    },
    notes: [
      "The 24/72 raw Gaussian arm is the preregistered control; the 18/54 raw Gaussian arm is the fixed challenger.",
      `Rows before ${RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT} are excluded; no forecast is backfilled, regenerated, or relabeled.`,
      "Only rows containing both raw forecasts at the same saved origin are compared.",
      "The daily representative is the first saved forecast in each Asia/Tokyo calendar day.",
      "A regular-only boundary inside a scored horizon is censored; no-boundary horizons are negative and random boundaries are positive.",
      "Age buckets are diagnostic only; sample counts are always reported and are not used for retuning.",
      "Neither arm applies B v1/v2 calibration; the pair shares the existing post-reset-age, signal, and notice policies.",
      "Prospective results never auto-publish or change parameters; manual review is required.",
      RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
    ],
  };
}
