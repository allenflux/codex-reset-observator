import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
} from "@/data/shadowProbabilityConfig";
import {
  getActualWithinHorizon,
} from "./prequentialCalibration";
import {
  selectDailyFirstForecasts,
  type ProspectiveCalibrationBucket,
  type ProspectiveForecastRow,
  type ProspectiveMetric,
  type ProspectiveModelEvaluation,
} from "./prospectiveProbabilityEvaluation";
import type { ShadowResetEvent } from "./shadowProbability";

const LOG_LOSS_EPSILON = 1e-12;
const HOUR_MS = 60 * 60 * 1000;

export const NEXT_GENERATION_GATE_THRESHOLDS = {
  targetResetCount: 5,
  resolvedDaily24h: 20,
  resolvedDaily48h: 15,
  maxLogLossWorsening: 0.05,
} as const;

type StoredForecast = {
  modelVersion: string;
  generatedAt: string;
  probability24h: number;
  probability48h: number;
  [key: string]: unknown;
};

type NextGenerationTargetEvent = ShadowResetEvent & { isRandom?: boolean };

export type NextGenerationModelEvaluationReport = {
  schemaVersion: "prospective-next-generation-model-evaluation-v1";
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
  freezeAt: typeof NEXT_GENERATION_FREEZE_AT;
  evaluationStartAt: string | null;
  forecastCounts: {
    public: number;
    a: number;
    b: number;
    comparable: number;
  };
  comparison: {
    resolved24h: number;
    resolved48h: number;
    targetResetCount: number;
    pairwise: {
      aMinusPublic: {
        brier24h: number | null;
        brier48h: number | null;
        logLoss24h: number | null;
        logLoss48h: number | null;
      };
      bMinusPublic: {
        brier24h: number | null;
        brier48h: number | null;
        logLoss24h: number | null;
        logLoss48h: number | null;
      };
    };
    nonOverlapping24h: number;
    nonOverlapping48h: number;
  };
  models: {
    public: ProspectiveModelEvaluation;
    a: ProspectiveModelEvaluation;
    b: ProspectiveModelEvaluation;
  };
  availability: {
    aRate: number;
    bRate: number;
    comparableRate: number;
    skipReasons: Record<string, number>;
  };
  gate: {
    autoPublish: false;
    manualReviewOnly: true;
    thresholds: typeof NEXT_GENERATION_GATE_THRESHOLDS;
    targetResetCount: number;
    resolvedDaily24h: number;
    resolvedDaily48h: number;
    a: {
      brier24hNotWorse: boolean;
      brier48hNotWorse: boolean;
      logLossNotExtremelyWorse: boolean;
      eligibleForManualReview: boolean;
    };
    b: {
      brier24hNotWorse: boolean;
      brier48hNotWorse: boolean;
      logLossNotExtremelyWorse: boolean;
      eligibleForManualReview: boolean;
    };
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

function isStoredForecast(value: unknown, modelVersion: string): value is StoredForecast {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const forecast = value as Record<string, unknown>;
  return forecast.modelVersion === modelVersion
    && typeof forecast.generatedAt === "string"
    && timestamp(forecast.generatedAt) !== null
    && typeof forecast.probability24h === "number"
    && Number.isFinite(forecast.probability24h)
    && typeof forecast.probability48h === "number"
    && Number.isFinite(forecast.probability48h);
}

export function selectComparableNextGenerationForecasts(
  rows: Array<ProspectiveForecastRow>,
) {
  const freezeTime = timestamp(NEXT_GENERATION_FREEZE_AT)!;
  return rows.filter((row) => {
    const generatedTime = timestamp(row.generatedAt);
    return generatedTime !== null
      && generatedTime >= freezeTime
      && isStoredForecast(row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION], CALIBRATED_SHADOW_MODEL_VERSION)
      && isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION)
      && isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION);
  });
}

function getResolvedRows(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  horizonHours: 24 | 48,
  events: Array<NextGenerationTargetEvent>,
  asOf: Date,
) {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = row.forecasts[modelVersion];
    const generatedTime = timestamp(row.generatedAt);
    if (
      !isStoredForecast(forecast, modelVersion)
      || generatedTime === null
      || generatedTime + horizonHours * HOUR_MS > asOfTime
    ) return [];
    return [{
      generatedAt: row.generatedAt,
      prediction: horizonHours === 24 ? forecast.probability24h : forecast.probability48h,
      actual: Number(getActualWithinHorizon(events, row.generatedAt, horizonHours)),
    }];
  });
}

function getCalibrationBuckets(values: Array<{ prediction: number; actual: number }>): Array<ProspectiveCalibrationBucket> {
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
  rows: Array<{ generatedAt: string; prediction: number; actual: number }>,
  events: Array<NextGenerationTargetEvent>,
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
      const endTime = originTime + horizonHours * HOUR_MS;
      return events
        .filter((event) => {
          const eventTime = timestamp(event.resetAt);
          return eventTime !== null && eventTime > originTime && eventTime <= endTime;
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
    periodStart: rows[0]?.generatedAt ?? null,
    periodEnd: rows.at(-1)?.generatedAt ?? null,
    targetResetCount: targetResetIds.size,
  };
}

function evaluateModel(
  rows: Array<ProspectiveForecastRow>,
  modelVersion: string,
  events: Array<NextGenerationTargetEvent>,
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion,
    metrics24h: calculateMetric(getResolvedRows(rows, modelVersion, 24, events, asOf), events, 24),
    metrics48h: calculateMetric(getResolvedRows(rows, modelVersion, 48, events, asOf), events, 48),
  };
}

function difference(
  candidate: number,
  current: number,
  candidateCount = 1,
  currentCount = 1,
) {
  return candidateCount > 0
    && currentCount > 0
    && Number.isFinite(candidate)
    && Number.isFinite(current)
    ? candidate - current
    : null;
}

function getNonOverlappingCount(rows: Array<ProspectiveForecastRow>, horizonHours: 24 | 48) {
  let lastEnd = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const row of rows.slice().sort((left, right) => timestamp(left.generatedAt)! - timestamp(right.generatedAt)!)) {
    const start = timestamp(row.generatedAt);
    if (start === null || start < lastEnd) continue;
    count += 1;
    lastEnd = start + horizonHours * HOUR_MS;
  }
  return count;
}

function getGate(
  evaluation: { metrics24h: ProspectiveMetric; metrics48h: ProspectiveMetric },
  publicEvaluation: { metrics24h: ProspectiveMetric; metrics48h: ProspectiveMetric },
  targetResetCount: number,
) {
  const brier24h = difference(evaluation.metrics24h.brier, publicEvaluation.metrics24h.brier, evaluation.metrics24h.count, publicEvaluation.metrics24h.count);
  const brier48h = difference(evaluation.metrics48h.brier, publicEvaluation.metrics48h.brier, evaluation.metrics48h.count, publicEvaluation.metrics48h.count);
  const logLoss24h = difference(evaluation.metrics24h.logLoss, publicEvaluation.metrics24h.logLoss, evaluation.metrics24h.count, publicEvaluation.metrics24h.count);
  const logLoss48h = difference(evaluation.metrics48h.logLoss, publicEvaluation.metrics48h.logLoss, evaluation.metrics48h.count, publicEvaluation.metrics48h.count);
  const enoughData = targetResetCount >= NEXT_GENERATION_GATE_THRESHOLDS.targetResetCount
    && evaluation.metrics24h.count >= NEXT_GENERATION_GATE_THRESHOLDS.resolvedDaily24h
    && evaluation.metrics48h.count >= NEXT_GENERATION_GATE_THRESHOLDS.resolvedDaily48h;
  const brier24hNotWorse = brier24h !== null && brier24h <= 0;
  const brier48hNotWorse = brier48h !== null && brier48h <= 0;
  const logLossNotExtremelyWorse = (logLoss24h ?? 0) <= NEXT_GENERATION_GATE_THRESHOLDS.maxLogLossWorsening
    && (logLoss48h ?? 0) <= NEXT_GENERATION_GATE_THRESHOLDS.maxLogLossWorsening;
  return {
    brier24hNotWorse,
    brier48hNotWorse,
    logLossNotExtremelyWorse,
    eligibleForManualReview: enoughData && brier24hNotWorse && brier48hNotWorse && logLossNotExtremelyWorse,
  };
}

export function evaluateNextGenerationModelsProspectively(
  rows: Array<ProspectiveForecastRow>,
  events: Array<NextGenerationTargetEvent>,
  asOf: Date,
): NextGenerationModelEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const targetEvents = events.filter((event) => event.isRandom !== false);
  const freezeTime = timestamp(NEXT_GENERATION_FREEZE_AT)!;
  const eligibleRows = rows.filter((row) => {
    const generatedTime = timestamp(row.generatedAt);
    return generatedTime !== null && generatedTime >= freezeTime && generatedTime <= asOf.getTime();
  });
  const comparableRows = selectComparableNextGenerationForecasts(eligibleRows);
  const dailyRows = selectDailyFirstForecasts(comparableRows);
  const publicEvaluation = evaluateModel(dailyRows, CALIBRATED_SHADOW_MODEL_VERSION, targetEvents, asOf);
  const aEvaluation = evaluateModel(dailyRows, NEXT_GENERATION_A_MODEL_VERSION, targetEvents, asOf);
  const bEvaluation = evaluateModel(dailyRows, NEXT_GENERATION_B_MODEL_VERSION, targetEvents, asOf);
  const evaluationStartAt = dailyRows[0]?.generatedAt ?? null;
  const evaluationStartTime = timestamp(evaluationStartAt);
  const targetResetCount = evaluationStartTime === null
    ? 0
    : new Set(targetEvents.filter((event) => {
        const eventTime = timestamp(event.resetAt);
        return eventTime !== null && eventTime > evaluationStartTime && eventTime <= asOf.getTime();
      }).map((event) => event.id)).size;
  const aGate = getGate(aEvaluation, publicEvaluation, targetResetCount);
  const bGate = getGate(bEvaluation, publicEvaluation, targetResetCount);
  const skipReasons: Record<string, number> = {};
  for (const row of eligibleRows) {
    const hasPublic = isStoredForecast(row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION], CALIBRATED_SHADOW_MODEL_VERSION);
    const hasA = isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION);
    const hasB = isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION);
    if (!hasPublic) skipReasons.missing_public = (skipReasons.missing_public ?? 0) + 1;
    if (!hasA) skipReasons.missing_a = (skipReasons.missing_a ?? 0) + 1;
    if (!hasB) skipReasons.missing_b = (skipReasons.missing_b ?? 0) + 1;
  }
  const candidateHasEnoughData = targetResetCount >= NEXT_GENERATION_GATE_THRESHOLDS.targetResetCount
    && publicEvaluation.metrics24h.count >= NEXT_GENERATION_GATE_THRESHOLDS.resolvedDaily24h
    && publicEvaluation.metrics48h.count >= NEXT_GENERATION_GATE_THRESHOLDS.resolvedDaily48h;
  const anyEligible = aGate.eligibleForManualReview || bGate.eligibleForManualReview;
  const bothWorse = [aEvaluation, bEvaluation].every((evaluation) =>
    evaluation.metrics24h.brier > publicEvaluation.metrics24h.brier
    && evaluation.metrics48h.brier > publicEvaluation.metrics48h.brier,
  );
  const status = !candidateHasEnoughData
    ? "insufficient_data"
    : anyEligible
      ? "eligible_for_manual_review"
      : bothWorse
        ? "worse"
        : "promising";
  const total = eligibleRows.length;
  return {
    schemaVersion: "prospective-next-generation-model-evaluation-v1",
    status,
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    evaluationMode: "prospective",
    backfilled: false,
    source: "prediction_history.debug_info.experimentalProbabilityForecasts",
    targetDefinition: RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
    freezeAt: NEXT_GENERATION_FREEZE_AT,
    evaluationStartAt,
    forecastCounts: {
      public: eligibleRows.filter((row) => isStoredForecast(row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION], CALIBRATED_SHADOW_MODEL_VERSION)).length,
      a: eligibleRows.filter((row) => isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION)).length,
      b: eligibleRows.filter((row) => isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION)).length,
      comparable: comparableRows.length,
    },
    comparison: {
      resolved24h: publicEvaluation.metrics24h.count,
      resolved48h: publicEvaluation.metrics48h.count,
      targetResetCount,
      pairwise: {
        aMinusPublic: {
          brier24h: difference(aEvaluation.metrics24h.brier, publicEvaluation.metrics24h.brier, aEvaluation.metrics24h.count, publicEvaluation.metrics24h.count),
          brier48h: difference(aEvaluation.metrics48h.brier, publicEvaluation.metrics48h.brier, aEvaluation.metrics48h.count, publicEvaluation.metrics48h.count),
          logLoss24h: difference(aEvaluation.metrics24h.logLoss, publicEvaluation.metrics24h.logLoss, aEvaluation.metrics24h.count, publicEvaluation.metrics24h.count),
          logLoss48h: difference(aEvaluation.metrics48h.logLoss, publicEvaluation.metrics48h.logLoss, aEvaluation.metrics48h.count, publicEvaluation.metrics48h.count),
        },
        bMinusPublic: {
          brier24h: difference(bEvaluation.metrics24h.brier, publicEvaluation.metrics24h.brier, bEvaluation.metrics24h.count, publicEvaluation.metrics24h.count),
          brier48h: difference(bEvaluation.metrics48h.brier, publicEvaluation.metrics48h.brier, bEvaluation.metrics48h.count, publicEvaluation.metrics48h.count),
          logLoss24h: difference(bEvaluation.metrics24h.logLoss, publicEvaluation.metrics24h.logLoss, bEvaluation.metrics24h.count, publicEvaluation.metrics24h.count),
          logLoss48h: difference(bEvaluation.metrics48h.logLoss, publicEvaluation.metrics48h.logLoss, bEvaluation.metrics48h.count, publicEvaluation.metrics48h.count),
        },
      },
      nonOverlapping24h: getNonOverlappingCount(dailyRows, 24),
      nonOverlapping48h: getNonOverlappingCount(dailyRows, 48),
    },
    models: {
      public: publicEvaluation,
      a: aEvaluation,
      b: bEvaluation,
    },
    availability: {
      aRate: total === 0 ? 0 : (eligibleRows.filter((row) => isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION)).length / total),
      bRate: total === 0 ? 0 : (eligibleRows.filter((row) => isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION)).length / total),
      comparableRate: total === 0 ? 0 : comparableRows.length / total,
      skipReasons,
    },
    gate: {
      autoPublish: false,
      manualReviewOnly: true,
      thresholds: NEXT_GENERATION_GATE_THRESHOLDS,
      targetResetCount,
      resolvedDaily24h: publicEvaluation.metrics24h.count,
      resolvedDaily48h: publicEvaluation.metrics48h.count,
      a: aGate,
      b: bGate,
    },
    notes: [
      "Only prediction_history rows containing the public model and both exact next-generation models at the same origin are compared.",
      `Rows before ${NEXT_GENERATION_FREEZE_AT} are excluded; no forecast is backfilled, regenerated, or relabeled.`,
      "The primary sample is the first comparable forecast in each Asia/Tokyo calendar day.",
      "Only broad eligible random reset boundaries are targets; regular resets are neither targets nor censoring events.",
      "Gate results are manual-review diagnostics only and never auto-publish or retune a model.",
    ],
  };
}
