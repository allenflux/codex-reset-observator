import {
  RANDOM_CONTINUOUS_SHADOW_FREEZE_AT,
  RANDOM_CONTINUOUS_SHADOW_FREEZE_POLICY,
  RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
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
  [key: string]: unknown;
};

export type RandomContinuousProspectiveEvaluationReport = {
  schemaVersion: "prospective-random-continuous-model-evaluation-v1";
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
  targetDefinition: typeof RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION;
  activeModelVersion: typeof RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION;
  baselineModelVersion: typeof RANDOM_ELAPSED_SHADOW_MODEL_VERSION;
  freezeAt: typeof RANDOM_CONTINUOUS_SHADOW_FREEZE_AT;
  evaluationStartAt: string | null;
  canonicalBoundaryCount: number;
  forecastCounts: {
    active: number;
    baseline: number;
    comparable: number;
  };
  comparison: {
    resolved24h: number;
    resolved48h: number;
    positiveCount24h: number;
    positiveCount48h: number;
    targetResetCount: number;
    activeMinusBaseline: {
      brier24h: number | null;
      brier48h: number | null;
      logLoss24h: number | null;
      logLoss48h: number | null;
    };
  };
  models: {
    active: ProspectiveModelEvaluation;
    baseline: ProspectiveModelEvaluation;
  };
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

export function selectComparableRandomContinuousForecasts(rows: Array<ProspectiveForecastRow>) {
  return rows.filter((row) =>
    isStoredForecast(row.forecasts[RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION])
    && isStoredForecast(row.forecasts[RANDOM_ELAPSED_SHADOW_MODEL_VERSION]),
  );
}

export function selectDailyFirstRandomContinuousForecasts(rows: Array<ProspectiveForecastRow>) {
  return selectDailyFirstForecasts(selectComparableRandomContinuousForecasts(rows));
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
    const forecast = row.forecasts[modelVersion];
    const generatedTime = timestamp(row.generatedAt);
    if (
      !isStoredForecast(forecast)
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

export function evaluateRandomContinuousModelProspectively(
  rows: Array<ProspectiveForecastRow>,
  boundaries: Array<RecoveryResetBoundary>,
  asOf: Date,
): RandomContinuousProspectiveEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");

  const freezeTime = timestamp(RANDOM_CONTINUOUS_SHADOW_FREEZE_AT);
  if (freezeTime === null) throw new RangeError("RANDOM_CONTINUOUS_SHADOW_FREEZE_AT must be a valid date");
  const isEligibleForecast = (row: ProspectiveForecastRow) => {
    const generatedAt = timestamp(row.generatedAt);
    return generatedAt !== null && generatedAt >= freezeTime && generatedAt <= asOf.getTime();
  };
  const comparableRows = selectComparableRandomContinuousForecasts(rows).filter(isEligibleForecast);
  const eligibleRows = rows.filter(isEligibleForecast);
  const knownBoundaries = boundaries.filter((boundary) => {
    const boundaryTime = timestamp(boundary.resetAt);
    return boundaryTime !== null && boundaryTime <= asOf.getTime();
  });
  const dailyRows = selectDailyFirstRandomContinuousForecasts(comparableRows);
  const active = createModelEvaluation(
    dailyRows,
    RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );
  const baseline = createModelEvaluation(
    dailyRows,
    RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
    knownBoundaries,
    asOf,
  );
  const evaluationStartAt = getFirstComparableForecastAt(comparableRows);
  const targetResetCount = getTargetResetCount(knownBoundaries, evaluationStartAt, asOf);
  const brier24h = difference(active.metrics24h.brier, baseline.metrics24h.brier, active.metrics24h.count);
  const brier48h = difference(active.metrics48h.brier, baseline.metrics48h.brier, active.metrics48h.count);
  const logLoss24h = difference(active.metrics24h.logLoss, baseline.metrics24h.logLoss, active.metrics24h.count);
  const logLoss48h = difference(active.metrics48h.logLoss, baseline.metrics48h.logLoss, active.metrics48h.count);
  const resolvedDaily24h = active.metrics24h.count;
  const resolvedDaily48h = active.metrics48h.count;
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

  return {
    schemaVersion: "prospective-random-continuous-model-evaluation-v1",
    status,
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    evaluationMode: "prospective",
    backfilled: false,
    source: "prediction_history.debug_info.experimentalProbabilityForecasts",
    targetDefinition: RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
    activeModelVersion: RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
    baselineModelVersion: RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
    freezeAt: RANDOM_CONTINUOUS_SHADOW_FREEZE_AT,
    evaluationStartAt,
    canonicalBoundaryCount: knownBoundaries.filter((boundary) => boundary.isRandom).length,
    forecastCounts: {
      active: eligibleRows.filter((row) => isStoredForecast(row.forecasts[RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION])).length,
      baseline: eligibleRows.filter((row) => isStoredForecast(row.forecasts[RANDOM_ELAPSED_SHADOW_MODEL_VERSION])).length,
      comparable: comparableRows.length,
    },
    comparison: {
      resolved24h: active.metrics24h.count,
      resolved48h: active.metrics48h.count,
      positiveCount24h: active.metrics24h.positiveCount,
      positiveCount48h: active.metrics48h.positiveCount,
      targetResetCount,
      activeMinusBaseline: {
        brier24h,
        brier48h,
        logLoss24h,
        logLoss48h,
      },
    },
    models: { active, baseline },
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
      "Only prediction_history rows containing both the continuous shadow and the existing coarse random shadow are compared.",
      `Rows before ${RANDOM_CONTINUOUS_SHADOW_FREEZE_AT} are excluded; no forecast is backfilled, regenerated, or relabeled.`,
      "The daily representative is the first saved forecast in each Asia/Tokyo calendar day.",
      "A regular-only boundary inside a scored horizon is censored; no-boundary horizons are negative and random boundaries are positive.",
      "The continuous and coarse random shadows use the same Production-equivalent recovery boundary set.",
      "Prospective results alone never auto-publish or retune a model; manual review is required.",
      `The continuous shadow parameters are frozen at ${RANDOM_CONTINUOUS_SHADOW_FREEZE_AT}; ${RANDOM_CONTINUOUS_SHADOW_FREEZE_POLICY}`,
    ],
  };
}
