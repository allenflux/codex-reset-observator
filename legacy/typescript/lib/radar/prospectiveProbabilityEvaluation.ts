import {
  getActualWithinHorizon,
} from "./prequentialCalibration";
import {
  CALIBRATED_SHADOW_ARCHIVED_MODEL_VERSIONS,
  CALIBRATED_SHADOW_MODEL_VERSION,
  LEGACY_SHADOW_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import type { ShadowResetEvent } from "./shadowProbability";

export const PROSPECTIVE_V2_MODEL_VERSION = LEGACY_SHADOW_PROBABILITY_MODEL_VERSION;
export const PROSPECTIVE_ACTIVE_MODEL_VERSION = PUBLISHED_PROBABILITY_MODEL_VERSION;
export const PROSPECTIVE_V4_MODEL_VERSION = CALIBRATED_SHADOW_MODEL_VERSION;
export const PROSPECTIVE_ARCHIVED_MODEL_VERSIONS = CALIBRATED_SHADOW_ARCHIVED_MODEL_VERSIONS;

export const PROSPECTIVE_GATE_THRESHOLDS = {
  targetResetCount: 5,
  resolvedDaily24h: 20,
  resolvedDaily48h: 15,
  maxLogLossWorsening: 0.05,
} as const;

export type ProspectiveStoredForecast = {
  modelVersion: string;
  generatedAt: string;
  probability24h: number;
  probability48h: number;
  [key: string]: unknown;
};

export type ProspectiveForecastRow = {
  loggedHour?: string | null;
  generatedAt: string;
  forecasts: Record<string, ProspectiveStoredForecast>;
  /** Top-level prediction_history values used by the public response. */
  finalDisplayed?: ProspectiveStoredForecast;
};

export type ProspectiveCalibrationBucket = {
  range: string;
  count: number;
  averagePrediction: number;
  actualRate: number;
};

export type ProspectiveMetric = {
  count: number;
  positiveCount: number;
  actualRate: number;
  averagePrediction: number;
  brier: number;
  logLoss: number;
  calibration: Array<ProspectiveCalibrationBucket>;
  periodStart: string | null;
  periodEnd: string | null;
  targetResetCount: number;
};

export type ProspectiveModelEvaluation = {
  modelVersion: string;
  metrics24h: ProspectiveMetric;
  metrics48h: ProspectiveMetric;
};

export type ProspectiveProbabilityEvaluationReport = {
  schemaVersion: "prospective-probability-evaluation-v1";
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
  targetDefinition: string;
  activeCandidateModel: typeof PROSPECTIVE_V4_MODEL_VERSION;
  archivedCandidateModels: readonly string[];
  evaluationStartAt: string | null;
  comparison: {
    resolved24h: number;
    resolved48h: number;
    targetResetCount: number;
    brierDifference24h: number | null;
    brierDifference48h: number | null;
    logLossDifference24h: number | null;
    logLossDifference48h: number | null;
  };
  models: {
    v2: ProspectiveModelEvaluation;
    v4: ProspectiveModelEvaluation;
  };
  gate: {
    autoPublish: false;
    thresholds: typeof PROSPECTIVE_GATE_THRESHOLDS;
    targetResetCount: number;
    resolvedDaily24h: number;
    resolvedDaily48h: number;
    brier24hNotWorse: boolean;
    brier48hNotWorse: boolean;
    oneHorizonClearlyImproved: boolean;
    logLossNotExtremelyWorse: boolean;
  };
  notes: string[];
};

const LOG_LOSS_EPSILON = 1e-12;

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getJstDayKey(value: string) {
  const time = timestamp(value);
  if (time === null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function selectDailyFirstForecasts(rows: Array<ProspectiveForecastRow>) {
  const sorted = rows
    .filter((row) => timestamp(row.generatedAt) !== null)
    .slice()
    .sort((left, right) => {
      const generatedDifference = timestamp(left.generatedAt)! - timestamp(right.generatedAt)!;
      if (generatedDifference !== 0) return generatedDifference;
      return (timestamp(left.loggedHour) ?? 0) - (timestamp(right.loggedHour) ?? 0);
    });
  const selected = new Map<string, ProspectiveForecastRow>();
  for (const row of sorted) {
    const dayKey = getJstDayKey(row.generatedAt);
    if (dayKey && !selected.has(dayKey)) {
      selected.set(dayKey, row);
    }
  }
  return Array.from(selected.values());
}

function getFirstComparableForecastAt(rows: Array<ProspectiveForecastRow>) {
  return rows
    .map((row) => ({ row, time: timestamp(row.generatedAt) }))
    .filter((item): item is { row: ProspectiveForecastRow; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time)
    .at(0)?.row.generatedAt ?? null;
}

function clampProbability(value: number) {
  return Number.isFinite(value)
    ? Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value))
    : 0.5;
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

function getResolvedRows(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  horizonHours: 24 | 48,
  events: Array<ShadowResetEvent>,
  asOf: Date,
) {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = row.forecasts[modelVersion];
    const generatedTime = timestamp(row.generatedAt);
    if (
      !forecast
      || generatedTime === null
      || !Number.isFinite(asOfTime)
      || generatedTime + horizonHours * 60 * 60 * 1000 > asOfTime
      || !Number.isFinite(forecast.probability24h)
      || !Number.isFinite(forecast.probability48h)
    ) {
      return [];
    }
    return [{
      generatedAt: row.generatedAt,
      prediction: horizonHours === 24 ? forecast.probability24h : forecast.probability48h,
      actual: Number(getActualWithinHorizon(events, row.generatedAt, horizonHours)),
    }];
  });
}

function calculateMetric(
  rows: Array<{ generatedAt: string; prediction: number; actual: number }>,
  events: Array<ShadowResetEvent>,
  horizonHours: 24 | 48,
): ProspectiveMetric {
  const values = rows.map((row) => ({
    prediction: Math.min(1, Math.max(0, row.prediction)),
    actual: row.actual,
  }));
  const targetResetIds = new Set(
    rows.flatMap((row) => {
      const originTime = timestamp(row.generatedAt);
      if (originTime === null) return [];
      const end = originTime + horizonHours * 60 * 60 * 1000;
      return events
        .filter((event) => {
          const eventTime = timestamp(event.resetAt);
          return eventTime !== null && eventTime > originTime && eventTime <= end;
        })
        .map((event) => event.id);
    }),
  );
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
    targetResetCount: targetResetIds.size,
  };
}

function createModelEvaluation(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  events: Array<ShadowResetEvent>,
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion,
    metrics24h: calculateMetric(getResolvedRows(rows, modelVersion, 24, events, asOf), events, 24),
    metrics48h: calculateMetric(getResolvedRows(rows, modelVersion, 48, events, asOf), events, 48),
  };
}

function getDifference(candidate: number, current: number) {
  return Number.isFinite(candidate) && Number.isFinite(current)
    ? candidate - current
    : null;
}

export function evaluateProspectiveProbabilityForecasts(
  rows: Array<ProspectiveForecastRow>,
  events: Array<ShadowResetEvent>,
  asOf: Date,
): ProspectiveProbabilityEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const comparableRows = rows.filter((row) =>
    row.forecasts[PROSPECTIVE_V2_MODEL_VERSION]
    && row.forecasts[PROSPECTIVE_V4_MODEL_VERSION],
  );
  const dailyRows = selectDailyFirstForecasts(comparableRows);
  const v2 = createModelEvaluation(dailyRows, PROSPECTIVE_V2_MODEL_VERSION, events, asOf);
  const v4 = createModelEvaluation(dailyRows, PROSPECTIVE_V4_MODEL_VERSION, events, asOf);
  const evaluationStartAt = getFirstComparableForecastAt(comparableRows);
  const evaluationStartTime = timestamp(evaluationStartAt);
  const targetResetCount = evaluationStartTime === null
    ? 0
    : new Set(
        events
          .filter((event) => {
            const eventTime = timestamp(event.resetAt);
            return eventTime !== null
              && eventTime > evaluationStartTime
              && eventTime <= asOf.getTime();
          })
          .map((event) => event.id),
      ).size;
  const resolvedDaily24h = v2.metrics24h.count;
  const resolvedDaily48h = v2.metrics48h.count;
  const brierDifference24h = getDifference(v4.metrics24h.brier, v2.metrics24h.brier);
  const brierDifference48h = getDifference(v4.metrics48h.brier, v2.metrics48h.brier);
  const logLossDifference24h = getDifference(v4.metrics24h.logLoss, v2.metrics24h.logLoss);
  const logLossDifference48h = getDifference(v4.metrics48h.logLoss, v2.metrics48h.logLoss);
  const enoughData = targetResetCount >= PROSPECTIVE_GATE_THRESHOLDS.targetResetCount
    && resolvedDaily24h >= PROSPECTIVE_GATE_THRESHOLDS.resolvedDaily24h
    && resolvedDaily48h >= PROSPECTIVE_GATE_THRESHOLDS.resolvedDaily48h;
  const brier24hNotWorse = brierDifference24h !== null && brierDifference24h <= 0;
  const brier48hNotWorse = brierDifference48h !== null && brierDifference48h <= 0;
  const oneHorizonClearlyImproved = (brierDifference24h ?? 0) < -0.01 || (brierDifference48h ?? 0) < -0.01;
  const logLossNotExtremelyWorse = (logLossDifference24h ?? 0) <= PROSPECTIVE_GATE_THRESHOLDS.maxLogLossWorsening
    && (logLossDifference48h ?? 0) <= PROSPECTIVE_GATE_THRESHOLDS.maxLogLossWorsening;
  const eligibleForManualReview = enoughData
    && brier24hNotWorse
    && brier48hNotWorse
    && oneHorizonClearlyImproved
    && logLossNotExtremelyWorse;
  const bothWorse = (brierDifference24h ?? 0) > 0 && (brierDifference48h ?? 0) > 0;
  const smallDifference = Math.max(Math.abs(brierDifference24h ?? 0), Math.abs(brierDifference48h ?? 0)) < 0.01;
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
    schemaVersion: "prospective-probability-evaluation-v1",
    status,
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    evaluationMode: "prospective",
    backfilled: false,
    source: "prediction_history.debug_info.experimentalProbabilityForecasts",
    targetDefinition: `Same random-reset target definition as ${PROSPECTIVE_ACTIVE_MODEL_VERSION}; this archived comparison reads ${PROSPECTIVE_V2_MODEL_VERSION} rows where available.`,
    activeCandidateModel: PROSPECTIVE_V4_MODEL_VERSION,
    archivedCandidateModels: PROSPECTIVE_ARCHIVED_MODEL_VERSIONS,
    evaluationStartAt,
    comparison: {
      resolved24h: resolvedDaily24h,
      resolved48h: resolvedDaily48h,
      targetResetCount,
      brierDifference24h,
      brierDifference48h,
      logLossDifference24h,
      logLossDifference48h,
    },
    models: { v2, v4 },
    gate: {
      autoPublish: false,
      thresholds: PROSPECTIVE_GATE_THRESHOLDS,
      targetResetCount,
      resolvedDaily24h,
      resolvedDaily48h,
      brier24hNotWorse,
      brier48hNotWorse,
      oneHorizonClearlyImproved,
      logLossNotExtremelyWorse,
    },
    notes: [
      "This is a prospective evaluation of forecasts saved after the active v4-v2 deployment point.",
      "Existing prediction_history rows are not backfilled or relabeled as v4 forecasts.",
      "Rows are filtered to the active v2 and v4 candidates before selecting the first saved forecast per Asia/Tokyo calendar day.",
      `Archived candidate models are excluded from the active comparison: ${PROSPECTIVE_ARCHIVED_MODEL_VERSIONS.join(", ")}.`,
      "Passing the gate never changes the public model automatically; manual review is required.",
    ],
  };
}

export { getActualWithinHorizon };
