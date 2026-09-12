import {
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import { getActualWithinHorizon } from "./prequentialCalibration";
import {
  selectDailyFirstForecasts,
  type ProspectiveForecastRow,
  type ProspectiveStoredForecast,
} from "./prospectiveProbabilityEvaluation";
import type { ShadowResetEvent } from "./shadowProbability";
import {
  readPublishedV3FeatureSnapshot,
  type PublishedV3FeatureSnapshot,
} from "./publishedV3FeatureSnapshot";

const HOUR_MS = 60 * 60 * 1000;
const LOG_LOSS_EPSILON = 1e-12;
const WILSON_Z = 1.96;

export const PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT = 5;

export type ProspectiveScoreboardSampleStatus = "sufficient" | "insufficient_sample";

export type ProspectiveScoreboardReliabilityBin = {
  range: string;
  count: number;
  averagePrediction: number;
  actualRate: number;
};

export type ProspectiveScoreboardMetric = {
  sampleStatus: ProspectiveScoreboardSampleStatus;
  count: number;
  positiveCount: number;
  actualPositiveRate: number | null;
  meanPredictedProbability: number | null;
  bias: number | null;
  brier: number | null;
  logLoss: number | null;
  falseHigh: number;
  falseLow: number;
  falseHighRate: number | null;
  falseLowRate: number | null;
  sharpness: number | null;
  reliabilityBins: Array<ProspectiveScoreboardReliabilityBin>;
  positiveRateWilson95: { lower: number; upper: number } | null;
  periodStart: string | null;
  periodEnd: string | null;
  targetResetCount: number;
};

export type PublishedV3ScoreboardFeature = Partial<PublishedV3FeatureSnapshot>;

export type PublishedV3ScoreboardSegment = {
  sampleStatus: ProspectiveScoreboardSampleStatus;
  originCount: number;
  metrics24h: ProspectiveScoreboardMetric;
  metrics48h: ProspectiveScoreboardMetric;
};

export type PublishedV3RegressionComparison = {
  sampleStatus: ProspectiveScoreboardSampleStatus;
  comparableOriginCount: number;
  publishedV3: ProspectiveScoreboardMetric;
  rawSignalAdjusted: ProspectiveScoreboardMetric;
  v2StyleCalibrated: ProspectiveScoreboardMetric;
};

export type PublishedV3ProspectiveScoreboard = {
  schemaVersion: "published-v3-prospective-scoreboard-v1";
  evaluationMode: "prospective";
  backfilled: false;
  modelVersion: string;
  previousModelVersion: string;
  adoptionAt: string | null;
  dailyFirstOriginCount: number;
  dailyFirstOrigins: string[];
  metrics: {
    publishedV3: {
      metrics24h: ProspectiveScoreboardMetric;
      metrics48h: ProspectiveScoreboardMetric;
    };
  };
  comparisons: {
    rawSignalAdjusted24h: {
      source: "saved-v3.rawProbability24h";
      comparableOriginCount: number;
      metric: ProspectiveScoreboardMetric;
    };
    v2StyleCalibrated24h: {
      source: "saved-v2.same-origin.probability24h";
      comparableOriginCount: number;
      metric: ProspectiveScoreboardMetric;
    };
    v2Policy48h: {
      source: "saved-v2.same-origin.probability48h";
      comparableOriginCount: number;
      metric: ProspectiveScoreboardMetric;
      exactlyMatchesPublished: boolean | null;
      maxAbsoluteDifference: number | null;
    };
    regressionDiagnosis24h: PublishedV3RegressionComparison;
  };
  gate: {
    status: "not_enough_prospective_data" | "sufficient_prospective_data";
    thresholds: {
      resolved24h: 20;
      resolved48h: 15;
      targetResets: 5;
    };
    resolved24h: number;
    resolved48h: number;
    targetResetCount: number;
    resolved24hMet: boolean;
    resolved48hMet: boolean;
    targetResetsMet: boolean;
    allMet: boolean;
    v4ResearchEligible: boolean;
  };
  segments: {
    officialNoticeOverride: {
      yes: PublishedV3ScoreboardSegment;
      no: PublishedV3ScoreboardSegment;
    };
    resetAge: {
      "0-24h": PublishedV3ScoreboardSegment;
      "24-48h": PublishedV3ScoreboardSegment;
      "48-72h": PublishedV3ScoreboardSegment;
      ">72h": PublishedV3ScoreboardSegment;
      unknown: PublishedV3ScoreboardSegment;
    };
    bankedEventWithin48h: {
      yes: PublishedV3ScoreboardSegment;
      no: PublishedV3ScoreboardSegment;
      unknown: PublishedV3ScoreboardSegment;
    };
    usableTiboSignal: {
      yes: PublishedV3ScoreboardSegment;
      no: PublishedV3ScoreboardSegment;
      unknown: PublishedV3ScoreboardSegment;
    };
    statusIncident: {
      yes: PublishedV3ScoreboardSegment;
      no: PublishedV3ScoreboardSegment;
      unknown: PublishedV3ScoreboardSegment;
    };
  };
  recommendation: "keep_v3" | "investigate" | "eligible_for_v4_research";
  warnings: string[];
  notes: string[];
};

export type PublishedV3ProspectiveScoreboardOptions = {
  activeModelVersion?: string;
  previousModelVersion?: string;
  adoptionAt?: string | null;
  adoptionBoundaryPending?: boolean;
  features?: Record<string, PublishedV3ScoreboardFeature>;
};

type ScoreboardValue = {
  generatedAt: string;
  prediction: number;
  actual: number;
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clampForLogLoss(value: number) {
  return Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value));
}

function isStoredForecast(value: unknown): value is ProspectiveStoredForecast {
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

function getFiniteProbability(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function isSameOrigin(row: ProspectiveForecastRow, forecast: ProspectiveStoredForecast) {
  const rowTime = timestamp(row.generatedAt);
  const forecastTime = timestamp(forecast.generatedAt);
  return rowTime !== null && forecastTime !== null && rowTime === forecastTime;
}

function getReliabilityBins(values: Array<{ prediction: number; actual: number }>) {
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

function getWilsonInterval(positiveCount: number, count: number) {
  if (count === 0) return null;
  const zSquared = WILSON_Z ** 2;
  const proportion = positiveCount / count;
  const denominator = 1 + zSquared / count;
  const centre = (proportion + zSquared / (2 * count)) / denominator;
  const margin = WILSON_Z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * count)) / count,
  ) / denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

function getTargetResetIds(
  rows: Array<{ generatedAt: string }>,
  horizonHours: 24 | 48,
  events: Array<ShadowResetEvent>,
) {
  return new Set(
    rows.flatMap((row) => {
      const originTime = timestamp(row.generatedAt);
      if (originTime === null) return [];
      const end = originTime + horizonHours * HOUR_MS;
      return events
        .filter((event) => {
          const eventTime = timestamp(event.resetAt);
          return eventTime !== null && eventTime > originTime && eventTime <= end;
        })
        .map((event) => event.id);
    }),
  );
}

function calculateMetric(
  values: Array<ScoreboardValue>,
  events: Array<ShadowResetEvent>,
  horizonHours: 24 | 48,
): ProspectiveScoreboardMetric {
  const predictions = values.map((value) => clampProbability(value.prediction));
  const positiveCount = values.reduce((sum, value) => sum + value.actual, 0);
  const targetResetCount = getTargetResetIds(values, horizonHours, events).size;
  if (values.length === 0) {
    return {
      sampleStatus: "insufficient_sample",
      count: 0,
      positiveCount: 0,
      actualPositiveRate: null,
      meanPredictedProbability: null,
      bias: null,
      brier: null,
      logLoss: null,
      falseHigh: 0,
      falseLow: 0,
      falseHighRate: null,
      falseLowRate: null,
      sharpness: null,
      reliabilityBins: getReliabilityBins([]),
      positiveRateWilson95: null,
      periodStart: null,
      periodEnd: null,
      targetResetCount,
    };
  }

  const actualRate = positiveCount / values.length;
  const meanPrediction = predictions.reduce((sum, value) => sum + value, 0) / values.length;
  const brier = values.reduce((sum, value, index) =>
    sum + (predictions[index] - value.actual) ** 2, 0) / values.length;
  const logLoss = values.reduce((sum, value, index) => {
    const prediction = clampForLogLoss(predictions[index]);
    return sum - (value.actual * Math.log(prediction) + (1 - value.actual) * Math.log(1 - prediction));
  }, 0) / values.length;
  const falseHigh = values.reduce((sum, value, index) =>
    sum + (predictions[index] >= 0.5 && value.actual === 0 ? 1 : 0), 0);
  const falseLow = values.reduce((sum, value, index) =>
    sum + (predictions[index] < 0.5 && value.actual === 1 ? 1 : 0), 0);
  const sharpness = Math.sqrt(
    predictions.reduce((sum, prediction) => sum + (prediction - meanPrediction) ** 2, 0) / values.length,
  );

  return {
    sampleStatus: values.length >= PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT
      ? "sufficient"
      : "insufficient_sample",
    count: values.length,
    positiveCount,
    actualPositiveRate: actualRate,
    meanPredictedProbability: meanPrediction,
    bias: meanPrediction - actualRate,
    brier,
    logLoss,
    falseHigh,
    falseLow,
    falseHighRate: falseHigh / values.length,
    falseLowRate: falseLow / values.length,
    sharpness,
    reliabilityBins: getReliabilityBins(values.map((value, index) => ({
      prediction: predictions[index],
      actual: value.actual,
    }))),
    positiveRateWilson95: getWilsonInterval(positiveCount, values.length),
    periodStart: values[0].generatedAt,
    periodEnd: values.at(-1)?.generatedAt ?? null,
    targetResetCount,
  };
}

function getResolvedValues(
  rows: Array<ProspectiveForecastRow>,
  getPrediction: (row: ProspectiveForecastRow) => number | null,
  horizonHours: 24 | 48,
  events: Array<ShadowResetEvent>,
  asOfTime: number,
) {
  return rows.flatMap((row) => {
    const generatedTime = timestamp(row.generatedAt);
    const prediction = getPrediction(row);
    if (
      generatedTime === null
      || generatedTime + horizonHours * HOUR_MS > asOfTime
      || prediction === null
    ) {
      return [];
    }
    return [{
      generatedAt: row.generatedAt,
      prediction,
      actual: Number(getActualWithinHorizon(events, row.generatedAt, horizonHours)),
    }];
  });
}

function isResolvedWithinHorizon(
  row: ProspectiveForecastRow,
  horizonHours: 24 | 48,
  asOfTime: number,
) {
  const generatedTime = timestamp(row.generatedAt);
  return generatedTime !== null && generatedTime + horizonHours * HOUR_MS <= asOfTime;
}

function createSegment(
  rows: Array<ProspectiveForecastRow>,
  getActiveForecast: (row: ProspectiveForecastRow) => ProspectiveStoredForecast,
  events: Array<ShadowResetEvent>,
  asOfTime: number,
): PublishedV3ScoreboardSegment {
  const metrics24h = calculateMetric(
    getResolvedValues(rows, (row) => getActiveForecast(row).probability24h, 24, events, asOfTime),
    events,
    24,
  );
  const metrics48h = calculateMetric(
    getResolvedValues(rows, (row) => getActiveForecast(row).probability48h, 48, events, asOfTime),
    events,
    48,
  );
  return {
    sampleStatus: rows.length >= PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT
      ? "sufficient"
      : "insufficient_sample",
    originCount: rows.length,
    metrics24h,
    metrics48h,
  };
}

function createBooleanSegments(
  rows: Array<ProspectiveForecastRow>,
  getValue: (row: ProspectiveForecastRow) => boolean | null,
  getActiveForecast: (row: ProspectiveForecastRow) => ProspectiveStoredForecast,
  events: Array<ShadowResetEvent>,
  asOfTime: number,
) {
  const group = (expected: boolean | null) => createSegment(
    rows.filter((row) => getValue(row) === expected),
    getActiveForecast,
    events,
    asOfTime,
  );
  return {
    yes: group(true),
    no: group(false),
    unknown: group(null),
  };
}

function getResetAgeBucket(forecast: ProspectiveStoredForecast) {
  const age = typeof forecast.elapsedHoursSinceRandom === "number"
    ? forecast.elapsedHoursSinceRandom
    : typeof forecast.randomElapsedHours === "number"
      ? forecast.randomElapsedHours
      : null;
  if (age === null || !Number.isFinite(age) || age < 0) return "unknown" as const;
  if (age <= 24) return "0-24h" as const;
  if (age <= 48) return "24-48h" as const;
  if (age <= 72) return "48-72h" as const;
  return ">72h" as const;
}

function getTargetResetCount(
  events: Array<ShadowResetEvent>,
  firstOrigin: string | null,
  asOfTime: number,
) {
  const start = timestamp(firstOrigin);
  if (start === null) return 0;
  return new Set(
    events
      .filter((event) => {
        const eventTime = timestamp(event.resetAt);
        return eventTime !== null && eventTime > start && eventTime <= asOfTime;
      })
      .map((event) => event.id),
  ).size;
}

function hasPublishedRegression(
  published: ProspectiveScoreboardMetric,
  raw: ProspectiveScoreboardMetric,
  v2: ProspectiveScoreboardMetric,
) {
  const brierRegression = published.brier !== null
    && raw.brier !== null
    && v2.brier !== null
    && published.brier > raw.brier
    && published.brier > v2.brier;
  const logLossRegression = published.logLoss !== null
    && raw.logLoss !== null
    && v2.logLoss !== null
    && published.logLoss > raw.logLoss
    && published.logLoss > v2.logLoss;
  return brierRegression || logLossRegression;
}

export function buildPublishedV3ProspectiveScoreboard(
  rows: Array<ProspectiveForecastRow>,
  events: Array<ShadowResetEvent>,
  asOf: Date,
  options: PublishedV3ProspectiveScoreboardOptions = {},
): PublishedV3ProspectiveScoreboard {
  const activeModelVersion = options.activeModelVersion ?? PUBLISHED_PROBABILITY_MODEL_VERSION;
  const previousModelVersion = options.previousModelVersion ?? PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION;
  const adoptionAt = options.adoptionAt === undefined
    ? PUBLISHED_PROBABILITY_ADOPTION_AT
    : options.adoptionAt;
  const adoptionTime = timestamp(adoptionAt);
  const asOfTime = asOf.getTime();
  if (!Number.isFinite(asOfTime)) throw new RangeError("asOf must be a valid date");
  if (adoptionAt !== null && adoptionTime === null) {
    throw new RangeError("adoptionAt must be a valid timestamp or null");
  }

  const eligibleRows = options.adoptionBoundaryPending
    ? []
    : rows.filter((row) => {
        const generatedTime = timestamp(row.generatedAt);
        return generatedTime !== null
          && generatedTime <= asOfTime
          && (adoptionTime === null || generatedTime >= adoptionTime!)
          && isStoredForecast(row.forecasts[activeModelVersion]);
      });
  const dailyRows = selectDailyFirstForecasts(eligibleRows);
  const getActiveForecast = (row: ProspectiveForecastRow) => {
    const forecast = row.forecasts[activeModelVersion];
    if (!isStoredForecast(forecast)) throw new TypeError("Scoreboard row is missing its active forecast");
    return forecast;
  };
  const publishedMetrics24h = calculateMetric(
    getResolvedValues(dailyRows, (row) => getActiveForecast(row).probability24h, 24, events, asOfTime),
    events,
    24,
  );
  const publishedMetrics48h = calculateMetric(
    getResolvedValues(dailyRows, (row) => getActiveForecast(row).probability48h, 48, events, asOfTime),
    events,
    48,
  );
  const rawRows = dailyRows.filter((row) => getFiniteProbability(getActiveForecast(row).rawProbability24h) !== null);
  const rawMetric = calculateMetric(
    getResolvedValues(rawRows, (row) => getFiniteProbability(getActiveForecast(row).rawProbability24h), 24, events, asOfTime),
    events,
    24,
  );
  const v2Rows = dailyRows.filter((row) => {
    const previous = row.forecasts[previousModelVersion];
    return isStoredForecast(previous) && isSameOrigin(row, previous);
  });
  const v2StyleMetric = calculateMetric(
    getResolvedValues(v2Rows, (row) => row.forecasts[previousModelVersion]?.probability24h ?? null, 24, events, asOfTime),
    events,
    24,
  );
  const v2Policy48Metric = calculateMetric(
    getResolvedValues(v2Rows, (row) => row.forecasts[previousModelVersion]?.probability48h ?? null, 48, events, asOfTime),
    events,
    48,
  );
  const regressionRows = dailyRows.filter((row) => {
    const active = getActiveForecast(row);
    const previous = row.forecasts[previousModelVersion];
    return getFiniteProbability(active.rawProbability24h) !== null
      && isSameOrigin(row, active)
      && isStoredForecast(previous)
      && isSameOrigin(row, previous)
      && getFiniteProbability(active.probability24h) !== null
      && getFiniteProbability(previous.probability24h) !== null
      && isResolvedWithinHorizon(row, 24, asOfTime);
  });
  const regressionPublishedMetric = calculateMetric(
    getResolvedValues(regressionRows, (row) => getActiveForecast(row).probability24h, 24, events, asOfTime),
    events,
    24,
  );
  const regressionRawMetric = calculateMetric(
    getResolvedValues(regressionRows, (row) => getFiniteProbability(getActiveForecast(row).rawProbability24h), 24, events, asOfTime),
    events,
    24,
  );
  const regressionV2Metric = calculateMetric(
    getResolvedValues(regressionRows, (row) => getFiniteProbability(row.forecasts[previousModelVersion]?.probability24h), 24, events, asOfTime),
    events,
    24,
  );
  const regressionComparison: PublishedV3RegressionComparison = {
    sampleStatus: regressionRows.length >= PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT
      ? "sufficient"
      : "insufficient_sample",
    comparableOriginCount: regressionRows.length,
    publishedV3: regressionPublishedMetric,
    rawSignalAdjusted: regressionRawMetric,
    v2StyleCalibrated: regressionV2Metric,
  };
  const v2Differences = v2Rows.map((row) => {
    const active = getActiveForecast(row);
    const previous = row.forecasts[previousModelVersion];
    if (!isStoredForecast(previous)) return null;
    return Math.abs(active.probability48h - previous.probability48h);
  }).filter((value): value is number => value !== null);
  const exactlyMatchesPublished = v2Differences.length === 0
    ? null
    : v2Differences.every((value) => value <= 1e-12);
  const maxAbsoluteDifference = v2Differences.length === 0 ? null : Math.max(...v2Differences);

  const features = options.features;
  const getSavedFeatureSnapshot = (row: ProspectiveForecastRow) =>
    readPublishedV3FeatureSnapshot(getActiveForecast(row).featureSnapshot);
  const getBooleanFeature = (
    key: keyof PublishedV3ScoreboardFeature,
    row: ProspectiveForecastRow,
  ): boolean | null => {
    const savedSnapshot = getSavedFeatureSnapshot(row);
    if (savedSnapshot) {
      const savedValue = savedSnapshot[key as keyof PublishedV3FeatureSnapshot];
      return typeof savedValue === "boolean" ? savedValue : null;
    }
    const value = features?.[row.generatedAt]?.[key];
    return typeof value === "boolean" ? value : null;
  };
  const ageGroup = (expected: ReturnType<typeof getResetAgeBucket>, row: ProspectiveForecastRow) =>
    getResetAgeBucket(getActiveForecast(row)) === expected;
  const resetAge = {
    "0-24h": createSegment(dailyRows.filter((row) => ageGroup("0-24h", row)), getActiveForecast, events, asOfTime),
    "24-48h": createSegment(dailyRows.filter((row) => ageGroup("24-48h", row)), getActiveForecast, events, asOfTime),
    "48-72h": createSegment(dailyRows.filter((row) => ageGroup("48-72h", row)), getActiveForecast, events, asOfTime),
    ">72h": createSegment(dailyRows.filter((row) => ageGroup(">72h", row)), getActiveForecast, events, asOfTime),
    unknown: createSegment(dailyRows.filter((row) => ageGroup("unknown", row)), getActiveForecast, events, asOfTime),
  };
  const segments = {
    officialNoticeOverride: {
      yes: createSegment(
        dailyRows.filter((row) => getActiveForecast(row).officialNoticeOverride === true),
        getActiveForecast,
        events,
        asOfTime,
      ),
      no: createSegment(
        dailyRows.filter((row) => getActiveForecast(row).officialNoticeOverride !== true),
        getActiveForecast,
        events,
        asOfTime,
      ),
    },
    resetAge,
    bankedEventWithin48h: createBooleanSegments(
      dailyRows,
      (row) => getBooleanFeature("bankedEventWithin48h", row),
      getActiveForecast,
      events,
      asOfTime,
    ),
    usableTiboSignal: createBooleanSegments(
      dailyRows,
      (row) => getBooleanFeature("usableTiboSignal", row),
      getActiveForecast,
      events,
      asOfTime,
    ),
    statusIncident: createBooleanSegments(
      dailyRows,
      (row) => getBooleanFeature("statusIncident", row),
      getActiveForecast,
      events,
      asOfTime,
    ),
  };

  const firstOrigin = dailyRows[0]?.generatedAt ?? null;
  const targetResetCount = getTargetResetCount(events, firstOrigin, asOfTime);
  const resolved24h = publishedMetrics24h.count;
  const resolved48h = publishedMetrics48h.count;
  const resolved24hMet = resolved24h >= 20;
  const resolved48hMet = resolved48h >= 15;
  const targetResetsMet = targetResetCount >= 5;
  const allMet = resolved24hMet && resolved48hMet && targetResetsMet;
  const regression = regressionRows.length >= PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT
    && hasPublishedRegression(regressionPublishedMetric, regressionRawMetric, regressionV2Metric);
  const recommendation = !allMet
    ? "keep_v3" as const
    : regression
      ? "investigate" as const
      : "eligible_for_v4_research" as const;
  const warnings: string[] = [];
  if (!resolved24hMet) warnings.push(`24h resolved sample is below the minimum 20 (actual: ${resolved24h}).`);
  if (!resolved48hMet) warnings.push(`48h resolved sample is below the minimum 15 (actual: ${resolved48h}).`);
  if (!targetResetsMet) warnings.push(`Target reset sample is below the minimum 5 (actual: ${targetResetCount}).`);
  const savedFeatureSnapshotCount = dailyRows.filter((row) => getSavedFeatureSnapshot(row) !== null).length;
  if (!features && savedFeatureSnapshotCount === 0) {
    warnings.push("PIT segment features were not supplied; feature-dependent segments are reported as unknown.");
  }
  if (v2Rows.length === 0) warnings.push("No saved same-origin v2 values were available for the requested comparison.");
  if (regressionRows.length < PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT) {
    warnings.push("Insufficient same-origin 24h comparison sample for regression diagnosis.");
  }
  if (!allMet) warnings.push("The scoreboard is not eligible to recommend v4 research until all prospective sample gates are met.");
  if (regression) warnings.push("Published v3 is worse than both saved raw and saved v2 24h comparisons on the available same-origin sample; investigate without changing the gate.");

  return {
    schemaVersion: "published-v3-prospective-scoreboard-v1",
    evaluationMode: "prospective",
    backfilled: false,
    modelVersion: activeModelVersion,
    previousModelVersion,
    adoptionAt,
    dailyFirstOriginCount: dailyRows.length,
    dailyFirstOrigins: dailyRows.map((row) => row.generatedAt),
    metrics: {
      publishedV3: {
        metrics24h: publishedMetrics24h,
        metrics48h: publishedMetrics48h,
      },
    },
    comparisons: {
      rawSignalAdjusted24h: {
        source: "saved-v3.rawProbability24h",
        comparableOriginCount: rawRows.length,
        metric: rawMetric,
      },
      v2StyleCalibrated24h: {
        source: "saved-v2.same-origin.probability24h",
        comparableOriginCount: v2Rows.length,
        metric: v2StyleMetric,
      },
      v2Policy48h: {
        source: "saved-v2.same-origin.probability48h",
        comparableOriginCount: v2Rows.length,
        metric: v2Policy48Metric,
        exactlyMatchesPublished,
        maxAbsoluteDifference,
      },
      regressionDiagnosis24h: regressionComparison,
    },
    gate: {
      status: allMet ? "sufficient_prospective_data" : "not_enough_prospective_data",
      thresholds: { resolved24h: 20, resolved48h: 15, targetResets: 5 },
      resolved24h,
      resolved48h,
      targetResetCount,
      resolved24hMet,
      resolved48hMet,
      targetResetsMet,
      allMet,
      v4ResearchEligible: allMet,
    },
    segments: {
      officialNoticeOverride: segments.officialNoticeOverride,
      resetAge,
      bankedEventWithin48h: segments.bankedEventWithin48h,
      usableTiboSignal: segments.usableTiboSignal,
      statusIncident: segments.statusIncident,
    },
    recommendation,
    warnings,
    notes: [
      "This scoreboard uses only saved prospective prediction artifacts at or after the configured v3 adoption boundary; rows are never backfilled, relabeled, or rewritten.",
      "Daily-first means the earliest saved v3 forecast in each Asia/Tokyo calendar day; unresolved 24h and 48h horizons are excluded from their respective metrics.",
      "False-high is prediction >= 0.5 with actual 0; false-low is prediction < 0.5 with actual 1. Sharpness is the population standard deviation of saved predictions.",
      `Segments with fewer than ${PROSPECTIVE_V3_SCOREBOARD_SEGMENT_MIN_SAMPLE_COUNT} daily origins are marked insufficient_sample and never affect the gate or recommendation.`,
      "The v2-style 24h comparison uses saved same-origin v2 probability24h only; it never refits calibration from future data.",
      "The 48h v2 policy comparison uses saved same-origin probability48h. Equality is reported explicitly when the values match; no artificial difference is created.",
      "Feature-dependent segments require point-in-time projected feature metadata supplied by the evaluator; missing features remain unknown rather than being inferred as false.",
      "The gate is a sample sufficiency gate, not an automatic publication or rollback decision. eligible_for_v4_research means only that enough prospective data exists to begin a separate research review.",
    ],
  };
}
