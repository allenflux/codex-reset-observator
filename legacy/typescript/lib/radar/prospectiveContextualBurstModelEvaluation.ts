import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
} from "@/data/shadowProbabilityConfig";
import { getActualWithinHorizon } from "./prequentialCalibration";
import {
  selectDailyFirstForecasts,
  type ProspectiveCalibrationBucket,
  type ProspectiveForecastRow,
  type ProspectiveMetric,
  type ProspectiveModelEvaluation,
} from "./prospectiveProbabilityEvaluation";
import type { ShadowResetEvent } from "./shadowProbability";

const HOUR_MS = 60 * 60 * 1000;
const LOG_LOSS_EPSILON = 1e-12;

export const CONTEXTUAL_BURST_GATE_THRESHOLDS = {
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
  ablations?: unknown;
  [key: string]: unknown;
};

type TargetEvent = ShadowResetEvent & { isRandom?: boolean };
type AblationName = "baseOnly" | "noBurst" | "noCircadian" | "fullContext" | "fullRaw";
type NormalizedAblationName = "baseOnly" | "burstOnly" | "circadianNormalizedOnly" | "fullNormalizedContext";
type HorizonPair = { probability24h: number; probability48h: number };

export type ContextualBurstContributionDelta = {
  brier24h: number | null;
  brier48h: number | null;
  logLoss24h: number | null;
  logLoss48h: number | null;
};

export type ContextualBurstModelEvaluationReport = {
  schemaVersion: "prospective-contextual-burst-model-evaluation-v2";
  status: "insufficient_data" | "promising" | "worse" | "eligible_for_manual_review";
  generatedAt: string;
  asOf: string;
  evaluationMode: "prospective";
  backfilled: false;
  source: "prediction_history.debug_info.experimentalProbabilityForecasts";
  targetDefinition: typeof RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION;
  freezeAt: typeof NEXT_GENERATION_C_FREEZE_AT;
  freezeAtV2: typeof NEXT_GENERATION_C_V2_FREEZE_AT;
  evaluationStartAt: string | null;
  forecastCounts: {
    public: number;
    a: number;
    b: number;
    c: number;
    cV2: number;
    comparable: number;
  };
  availability: {
    aRate: number;
    bRate: number;
    cRate: number;
    cV2Rate: number;
    comparableRate: number;
    ablationRows: number;
    ablationRate: number;
    skipReasons: Record<string, number>;
  };
  comparison: {
    resolved24h: number;
    resolved48h: number;
    targetResetCount: number;
    nonOverlapping24h: number;
    nonOverlapping48h: number;
    cMinusPublic: ContextualBurstContributionDelta;
    cMinusB: ContextualBurstContributionDelta;
  };
  models: {
    public: ProspectiveModelEvaluation;
    a: ProspectiveModelEvaluation;
    b: ProspectiveModelEvaluation;
    c: ProspectiveModelEvaluation;
    cV2: ProspectiveModelEvaluation;
  };
  ablations: {
    models: Record<AblationName, ProspectiveModelEvaluation>;
    contributions: {
      noBurstMinusFullContext: ContextualBurstContributionDelta;
      noCircadianMinusFullContext: ContextualBurstContributionDelta;
      fullContextMinusFullRaw: ContextualBurstContributionDelta;
    };
  };
  normalizedAblations: {
    models: Record<NormalizedAblationName, ProspectiveModelEvaluation>;
  };
  gate: {
    autoPublish: false;
    manualReviewOnly: true;
    thresholds: typeof CONTEXTUAL_BURST_GATE_THRESHOLDS;
    targetResetCount: number;
    resolvedDaily24h: number;
    resolvedDaily48h: number;
    brier24hNotWorseThanPublic: boolean;
    brier48hNotWorseThanPublic: boolean;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStoredForecast(value: unknown, modelVersion: string): value is StoredForecast {
  const forecast = asRecord(value);
  return forecast !== null
    && forecast.modelVersion === modelVersion
    && typeof forecast.generatedAt === "string"
    && timestamp(forecast.generatedAt) !== null
    && isProbability(forecast.probability24h)
    && isProbability(forecast.probability48h);
}

function getNamedAblationPair(
  forecast: StoredForecast,
  field: "ablations" | "normalizedAblations",
  name: string,
): HorizonPair | null {
  const ablations = asRecord(forecast[field]);
  const pair = asRecord(ablations?.[name]);
  if (!pair || !isProbability(pair.probability24h) || !isProbability(pair.probability48h)) return null;
  return { probability24h: pair.probability24h, probability48h: pair.probability48h };
}

function getAblationPair(forecast: StoredForecast, name: AblationName): HorizonPair | null {
  return getNamedAblationPair(forecast, "ablations", name);
}

export function selectComparableContextualBurstForecasts(rows: ProspectiveForecastRow[]) {
  const freezeTime = timestamp(NEXT_GENERATION_C_FREEZE_AT)!;
  return rows.filter((row) => {
    const generated = timestamp(row.generatedAt);
    return generated !== null
      && generated >= freezeTime
      && isStoredForecast(row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION], CALIBRATED_SHADOW_MODEL_VERSION)
      && isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION)
      && isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION)
      && isStoredForecast(row.forecasts[NEXT_GENERATION_C_MODEL_VERSION], NEXT_GENERATION_C_MODEL_VERSION);
  });
}

export function selectNormalizedContextualBurstForecasts(rows: ProspectiveForecastRow[]) {
  const freezeTime = timestamp(NEXT_GENERATION_C_V2_FREEZE_AT)!;
  return rows.filter((row) => {
    const generated = timestamp(row.generatedAt);
    return generated !== null
      && generated >= freezeTime
      && isStoredForecast(
        row.forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION],
        NEXT_GENERATION_C_V2_MODEL_VERSION,
      );
  });
}

function calibrationBuckets(values: Array<{ prediction: number; actual: number }>): ProspectiveCalibrationBucket[] {
  return [0, 0.2, 0.4, 0.6, 0.8].map((lower) => {
    const upper = lower + 0.2;
    const selected = values.filter(({ prediction }) =>
      prediction >= lower && (prediction < upper || (upper === 1 && prediction <= upper)),
    );
    return {
      range: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      count: selected.length,
      averagePrediction: selected.length === 0
        ? 0
        : selected.reduce((sum, item) => sum + item.prediction, 0) / selected.length,
      actualRate: selected.length === 0
        ? 0
        : selected.reduce((sum, item) => sum + item.actual, 0) / selected.length,
    };
  });
}

function metric(
  rows: Array<{ generatedAt: string; prediction: number; actual: number }>,
  events: TargetEvent[],
  horizonHours: 24 | 48,
): ProspectiveMetric {
  const values = rows.map((row) => ({
    prediction: Math.min(1, Math.max(0, row.prediction)),
    actual: row.actual,
  }));
  const resetIds = new Set(rows.flatMap((row) => {
    const origin = timestamp(row.generatedAt);
    if (origin === null) return [];
    const end = origin + horizonHours * HOUR_MS;
    return events
      .filter((event) => {
        const time = timestamp(event.resetAt);
        return event.isRandom !== false && time !== null && time > origin && time <= end;
      })
      .map((event) => event.id);
  }));
  if (values.length === 0) {
    return {
      count: 0,
      positiveCount: 0,
      actualRate: 0,
      averagePrediction: 0,
      brier: 0,
      logLoss: 0,
      calibration: calibrationBuckets([]),
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
    calibration: calibrationBuckets(values),
    periodStart: rows[0]?.generatedAt ?? null,
    periodEnd: rows.at(-1)?.generatedAt ?? null,
    targetResetCount: resetIds.size,
  };
}

function resolvedModelRows(
  rows: ProspectiveForecastRow[],
  modelVersion: string,
  horizonHours: 24 | 48,
  events: TargetEvent[],
  asOf: Date,
) {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = row.forecasts[modelVersion];
    const origin = timestamp(row.generatedAt);
    if (
      !isStoredForecast(forecast, modelVersion)
      || origin === null
      || origin + horizonHours * HOUR_MS > asOfTime
    ) return [];
    return [{
      generatedAt: row.generatedAt,
      prediction: horizonHours === 24 ? forecast.probability24h : forecast.probability48h,
      actual: Number(getActualWithinHorizon(events.filter((event) => event.isRandom !== false), row.generatedAt, horizonHours)),
    }];
  });
}

function evaluateModel(
  rows: ProspectiveForecastRow[],
  modelVersion: string,
  events: TargetEvent[],
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion,
    metrics24h: metric(resolvedModelRows(rows, modelVersion, 24, events, asOf), events, 24),
    metrics48h: metric(resolvedModelRows(rows, modelVersion, 48, events, asOf), events, 48),
  };
}

function resolvedAblationRows(
  rows: ProspectiveForecastRow[],
  name: string,
  horizonHours: 24 | 48,
  events: TargetEvent[],
  asOf: Date,
  modelVersion = NEXT_GENERATION_C_MODEL_VERSION,
  field: "ablations" | "normalizedAblations" = "ablations",
) {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = row.forecasts[modelVersion];
    const origin = timestamp(row.generatedAt);
    if (!isStoredForecast(forecast, modelVersion) || origin === null) return [];
    const pair = getNamedAblationPair(forecast, field, name);
    if (!pair || origin + horizonHours * HOUR_MS > asOfTime) return [];
    return [{
      generatedAt: row.generatedAt,
      prediction: horizonHours === 24 ? pair.probability24h : pair.probability48h,
      actual: Number(getActualWithinHorizon(events.filter((event) => event.isRandom !== false), row.generatedAt, horizonHours)),
    }];
  });
}

function evaluateAblation(
  rows: ProspectiveForecastRow[],
  name: AblationName,
  events: TargetEvent[],
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion: `c-ablation:${name}`,
    metrics24h: metric(resolvedAblationRows(rows, name, 24, events, asOf), events, 24),
    metrics48h: metric(resolvedAblationRows(rows, name, 48, events, asOf), events, 48),
  };
}

function evaluateNormalizedAblation(
  rows: ProspectiveForecastRow[],
  name: NormalizedAblationName,
  events: TargetEvent[],
  asOf: Date,
): ProspectiveModelEvaluation {
  return {
    modelVersion: `c-v2-ablation:${name}`,
    metrics24h: metric(
      resolvedAblationRows(
        rows,
        name,
        24,
        events,
        asOf,
        NEXT_GENERATION_C_V2_MODEL_VERSION,
        "normalizedAblations",
      ),
      events,
      24,
    ),
    metrics48h: metric(
      resolvedAblationRows(
        rows,
        name,
        48,
        events,
        asOf,
        NEXT_GENERATION_C_V2_MODEL_VERSION,
        "normalizedAblations",
      ),
      events,
      48,
    ),
  };
}

function difference(
  left: ProspectiveModelEvaluation,
  right: ProspectiveModelEvaluation,
): ContextualBurstContributionDelta {
  const available = (a: ProspectiveMetric, b: ProspectiveMetric) => a.count > 0 && b.count > 0;
  return {
    brier24h: available(left.metrics24h, right.metrics24h) ? left.metrics24h.brier - right.metrics24h.brier : null,
    brier48h: available(left.metrics48h, right.metrics48h) ? left.metrics48h.brier - right.metrics48h.brier : null,
    logLoss24h: available(left.metrics24h, right.metrics24h) ? left.metrics24h.logLoss - right.metrics24h.logLoss : null,
    logLoss48h: available(left.metrics48h, right.metrics48h) ? left.metrics48h.logLoss - right.metrics48h.logLoss : null,
  };
}

function nonOverlappingCount(rows: ProspectiveForecastRow[], horizonHours: 24 | 48) {
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

export function evaluateContextualBurstModelProspectively(
  rows: ProspectiveForecastRow[],
  events: TargetEvent[],
  asOf: Date,
): ContextualBurstModelEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const targetEvents = events.filter((event) => event.isRandom !== false);
  const freezeTime = timestamp(NEXT_GENERATION_C_FREEZE_AT)!;
  const eligibleRows = rows.filter((row) => {
    const generated = timestamp(row.generatedAt);
    return generated !== null && generated >= freezeTime && generated <= asOf.getTime();
  });
  const comparableRows = selectComparableContextualBurstForecasts(eligibleRows);
  const dailyComparable = selectDailyFirstForecasts(comparableRows);
  const cV2Rows = selectNormalizedContextualBurstForecasts(eligibleRows);
  const dailyCV2 = selectDailyFirstForecasts(cV2Rows);
  const cRows = eligibleRows.filter((row) =>
    isStoredForecast(row.forecasts[NEXT_GENERATION_C_MODEL_VERSION], NEXT_GENERATION_C_MODEL_VERSION),
  );
  const ablationRows = cRows.filter((row) => {
    const forecast = row.forecasts[NEXT_GENERATION_C_MODEL_VERSION] as StoredForecast;
    return (["baseOnly", "noBurst", "noCircadian", "fullContext", "fullRaw"] as AblationName[])
      .every((name) => getAblationPair(forecast, name) !== null);
  });
  const dailyAblationRows = selectDailyFirstForecasts(ablationRows);
  const normalizedAblationRows = cV2Rows.filter((row) => {
    const forecast = row.forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION] as StoredForecast;
    return (["baseOnly", "burstOnly", "circadianNormalizedOnly", "fullNormalizedContext"] as NormalizedAblationName[])
      .every((name) => getNamedAblationPair(forecast, "normalizedAblations", name) !== null);
  });
  const dailyNormalizedAblationRows = selectDailyFirstForecasts(normalizedAblationRows);

  const publicEvaluation = evaluateModel(dailyComparable, CALIBRATED_SHADOW_MODEL_VERSION, targetEvents, asOf);
  const aEvaluation = evaluateModel(dailyComparable, NEXT_GENERATION_A_MODEL_VERSION, targetEvents, asOf);
  const bEvaluation = evaluateModel(dailyComparable, NEXT_GENERATION_B_MODEL_VERSION, targetEvents, asOf);
  const cEvaluation = evaluateModel(dailyComparable, NEXT_GENERATION_C_MODEL_VERSION, targetEvents, asOf);
  const cV2Evaluation = evaluateModel(dailyCV2, NEXT_GENERATION_C_V2_MODEL_VERSION, targetEvents, asOf);
  const ablationModels = Object.fromEntries(
    (["baseOnly", "noBurst", "noCircadian", "fullContext", "fullRaw"] as AblationName[])
      .map((name) => [name, evaluateAblation(dailyAblationRows, name, targetEvents, asOf)]),
  ) as Record<AblationName, ProspectiveModelEvaluation>;
  const normalizedAblationModels = Object.fromEntries(
    (["baseOnly", "burstOnly", "circadianNormalizedOnly", "fullNormalizedContext"] as NormalizedAblationName[])
      .map((name) => [
        name,
        evaluateNormalizedAblation(dailyNormalizedAblationRows, name, targetEvents, asOf),
      ]),
  ) as Record<NormalizedAblationName, ProspectiveModelEvaluation>;

  const evaluationStartAt = dailyComparable[0]?.generatedAt ?? null;
  const evaluationStartTime = timestamp(evaluationStartAt);
  const targetResetCount = evaluationStartTime === null
    ? 0
    : new Set(targetEvents.filter((event) => {
        const time = timestamp(event.resetAt);
        return time !== null && time > evaluationStartTime && time <= asOf.getTime();
      }).map((event) => event.id)).size;

  const cMinusPublic = difference(cEvaluation, publicEvaluation);
  const cMinusB = difference(cEvaluation, bEvaluation);
  const enoughData = targetResetCount >= CONTEXTUAL_BURST_GATE_THRESHOLDS.targetResetCount
    && cEvaluation.metrics24h.count >= CONTEXTUAL_BURST_GATE_THRESHOLDS.resolvedDaily24h
    && cEvaluation.metrics48h.count >= CONTEXTUAL_BURST_GATE_THRESHOLDS.resolvedDaily48h;
  const brier24hNotWorseThanPublic = cMinusPublic.brier24h !== null && cMinusPublic.brier24h <= 0;
  const brier48hNotWorseThanPublic = cMinusPublic.brier48h !== null && cMinusPublic.brier48h <= 0;
  const logLossNotExtremelyWorse = (cMinusPublic.logLoss24h ?? 0) <= CONTEXTUAL_BURST_GATE_THRESHOLDS.maxLogLossWorsening
    && (cMinusPublic.logLoss48h ?? 0) <= CONTEXTUAL_BURST_GATE_THRESHOLDS.maxLogLossWorsening;
  const eligibleForManualReview = enoughData
    && brier24hNotWorseThanPublic
    && brier48hNotWorseThanPublic
    && logLossNotExtremelyWorse;
  const status = !enoughData
    ? "insufficient_data"
    : eligibleForManualReview
      ? "eligible_for_manual_review"
      : (cMinusPublic.brier24h ?? 0) > 0 && (cMinusPublic.brier48h ?? 0) > 0
        ? "worse"
        : "promising";

  const total = eligibleRows.length;
  const countVersion = (version: string) => eligibleRows.filter((row) => isStoredForecast(row.forecasts[version], version)).length;
  const skipReasons: Record<string, number> = {};
  for (const row of eligibleRows) {
    if (!isStoredForecast(row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION], CALIBRATED_SHADOW_MODEL_VERSION)) skipReasons.missing_public = (skipReasons.missing_public ?? 0) + 1;
    if (!isStoredForecast(row.forecasts[NEXT_GENERATION_A_MODEL_VERSION], NEXT_GENERATION_A_MODEL_VERSION)) skipReasons.missing_a = (skipReasons.missing_a ?? 0) + 1;
    if (!isStoredForecast(row.forecasts[NEXT_GENERATION_B_MODEL_VERSION], NEXT_GENERATION_B_MODEL_VERSION)) skipReasons.missing_b = (skipReasons.missing_b ?? 0) + 1;
    if (!isStoredForecast(row.forecasts[NEXT_GENERATION_C_MODEL_VERSION], NEXT_GENERATION_C_MODEL_VERSION)) skipReasons.missing_c = (skipReasons.missing_c ?? 0) + 1;
    if (!isStoredForecast(row.forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION], NEXT_GENERATION_C_V2_MODEL_VERSION)) skipReasons.missing_c_v2 = (skipReasons.missing_c_v2 ?? 0) + 1;
  }

  return {
    schemaVersion: "prospective-contextual-burst-model-evaluation-v2",
    status,
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    evaluationMode: "prospective",
    backfilled: false,
    source: "prediction_history.debug_info.experimentalProbabilityForecasts",
    targetDefinition: RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
    freezeAt: NEXT_GENERATION_C_FREEZE_AT,
    freezeAtV2: NEXT_GENERATION_C_V2_FREEZE_AT,
    evaluationStartAt,
    forecastCounts: {
      public: countVersion(CALIBRATED_SHADOW_MODEL_VERSION),
      a: countVersion(NEXT_GENERATION_A_MODEL_VERSION),
      b: countVersion(NEXT_GENERATION_B_MODEL_VERSION),
      c: countVersion(NEXT_GENERATION_C_MODEL_VERSION),
      cV2: cV2Rows.length,
      comparable: comparableRows.length,
    },
    availability: {
      aRate: total === 0 ? 0 : countVersion(NEXT_GENERATION_A_MODEL_VERSION) / total,
      bRate: total === 0 ? 0 : countVersion(NEXT_GENERATION_B_MODEL_VERSION) / total,
      cRate: total === 0 ? 0 : countVersion(NEXT_GENERATION_C_MODEL_VERSION) / total,
      cV2Rate: total === 0 ? 0 : cV2Rows.length / total,
      comparableRate: total === 0 ? 0 : comparableRows.length / total,
      ablationRows: ablationRows.length,
      ablationRate: cRows.length === 0 ? 0 : ablationRows.length / cRows.length,
      skipReasons,
    },
    comparison: {
      resolved24h: cEvaluation.metrics24h.count,
      resolved48h: cEvaluation.metrics48h.count,
      targetResetCount,
      nonOverlapping24h: nonOverlappingCount(dailyComparable, 24),
      nonOverlapping48h: nonOverlappingCount(dailyComparable, 48),
      cMinusPublic,
      cMinusB,
    },
    models: {
      public: publicEvaluation,
      a: aEvaluation,
      b: bEvaluation,
      c: cEvaluation,
      cV2: cV2Evaluation,
    },
    ablations: {
      models: ablationModels,
      contributions: {
        noBurstMinusFullContext: difference(ablationModels.noBurst, ablationModels.fullContext),
        noCircadianMinusFullContext: difference(ablationModels.noCircadian, ablationModels.fullContext),
        fullContextMinusFullRaw: difference(ablationModels.fullContext, ablationModels.fullRaw),
      },
    },
    normalizedAblations: {
      models: normalizedAblationModels,
    },
    gate: {
      autoPublish: false,
      manualReviewOnly: true,
      thresholds: CONTEXTUAL_BURST_GATE_THRESHOLDS,
      targetResetCount,
      resolvedDaily24h: cEvaluation.metrics24h.count,
      resolvedDaily48h: cEvaluation.metrics48h.count,
      brier24hNotWorseThanPublic,
      brier48hNotWorseThanPublic,
      logLossNotExtremelyWorse,
      eligibleForManualReview,
    },
    notes: [
      "C is evaluated only from actually saved post-freeze forecasts; no C forecast is backfilled.",
      "Formal Current/A/B/C scores use same-origin rows before JST daily-first selection.",
      "C ablations exclude calibration and official-notice override; fullRaw includes only ordinary semantic signals on top of fullContext.",
      "Missing C ablation audit reduces ablation availability but does not invalidate the main C forecast.",
      "Passing the gate never changes the public model automatically; manual review remains required.",
    ],
  };
}
