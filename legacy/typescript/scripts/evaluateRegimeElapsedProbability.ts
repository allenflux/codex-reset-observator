import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  ELAPSED_ONLY_MODEL_VERSION,
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  RECENCY_H30_PROBABILITY_MODEL_VERSION,
  REGIME_ELAPSED_BIN_SCHEME_CANDIDATES,
  REGIME_ELAPSED_PRIOR_EXPOSURE_DAY_CANDIDATES,
  REGIME_ELAPSED_RATIO_EXPONENT_CANDIDATES,
  REGIME_ELAPSED_REGIME_HALF_LIFE_CANDIDATES,
} from "../data/shadowProbabilityConfig";
import { fetchCurrentRadarData } from "../lib/radarFetch";
import type { RadarData } from "../lib/radar/types";
import { calculateRecencyWeightedShadowProbability } from "../lib/radar/recencyWeightedProbability";
import { calculateConstantHazardBenchmark } from "../lib/radar/evaluationProbabilityModels";
import {
  calculateShadowProbability,
  type ShadowProbabilityHorizons,
} from "../lib/radar/shadowProbability";
import {
  calculateRegimeElapsedProbability,
  type RegimeElapsedBinScheme,
  type RegimeElapsedModelOptions,
  type RegimeElapsedMode,
} from "../lib/radar/regimeElapsedProbability";
import {
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "../lib/radar/recoveryBoundary";
import { getPointInTimeLocalObservationSignals } from "../lib/radar/calibratedShadowProbability";
import { getPointInTimeRadarData } from "../lib/radar/prequentialCalibration";
import type { ShadowResetEvent } from "../lib/radar/shadowProbability";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SIX_HOUR_MS = 6 * HOUR_MS;
const LOG_LOSS_EPSILON = 1e-12;
const BOOTSTRAP_ITERATIONS = 1_000;
const BOOTSTRAP_SEED = 20260808;
const DEFAULT_AS_OF = "2026-08-08T04:27:00.000Z";
export const EVALUATION_INPUT_MODE = "production-point-in-time" as const;
export const FUTURE_LEAKAGE_POLICY_VERSION = "availability-timestamps-v1" as const;

export const REGIME_ELAPSED_EVALUATION_REPORT_BASENAME =
  "probability-model-evaluation-regime-elapsed-v1";
export const REGIME_ANALYSIS_REPORT_BASENAME = "reset-regime-analysis";

export type EvaluationOutcome = boolean | null;

export type RegimeEvaluationRow = {
  recordedAt: string;
  probability24h: number;
  probability48h: number;
  actual24h: EvaluationOutcome;
  actual48h: EvaluationOutcome;
};

export type CalibrationBucket = {
  range: string;
  count: number;
  averagePrediction: number;
  actualRate: number;
};

export type MetricSummary = {
  count: number;
  positiveCount: number;
  actualRate: number;
  averagePrediction: number;
  brier: number;
  logLoss: number;
  predictionStandardDeviation: number;
  min: number;
  max: number;
  quantiles: {
    p5: number;
    p25: number;
    median: number;
    p75: number;
    p95: number;
  };
  auc: number | null;
  calibration: CalibrationBucket[];
};

export type OutcomeSummary = {
  originCount: number;
  scored24h: number;
  censored24h: number;
  positive24h: number;
  scored48h: number;
  censored48h: number;
  positive48h: number;
};

export type RegimeElapsedCandidateConfig = {
  binScheme: RegimeElapsedBinScheme;
  priorExposureDays: number;
  regimeHalfLifeDays: number;
  regimeRatioExponent: number;
};

export type CandidateScore = {
  key: string;
  config: RegimeElapsedCandidateConfig;
  scoredCount24h: number;
  scoredCount48h: number;
  brier24h: number | null;
  brier48h: number | null;
};

export type BootstrapSummary = {
  seed: number;
  iterations: number;
  lower: number;
  median: number;
  upper: number;
};

type ModelKey =
  | "current-h30-r3"
  | "constant-hazard"
  | "elapsed-only"
  | "regime-only"
  | "regime-elapsed";

type ModelEvaluation = {
  modelVersion: string;
  mode: ModelKey;
  metrics24h: MetricSummary;
  metrics48h: MetricSummary;
  nonOverlapping24h: MetricSummary;
  nonOverlapping48h: MetricSummary;
  differenceVsCurrent: {
    brier24h: number;
    brier48h: number;
    logLoss24h: number;
    logLoss48h: number;
    bootstrap24h: BootstrapSummary | null;
    bootstrap48h: BootstrapSummary | null;
  } | null;
};

type RegimeEventAudit = {
  id: string;
  resetAt: string;
  rolling7dCount: number;
  rolling14dCount: number;
  intervalsSincePreviousHours: number | null;
  ewmaRates: Record<string, {
    recentWeightedEventCount: number;
    recentWeightedExposureDays: number;
    recentRatePerDay: number;
    longTermRatePerDay: number;
    rawRateRatio: number;
    regimeMultiplier: number;
  }>;
};

type RegularPhaseSummary = {
  boundaryAt: string;
  phase: "pre-24..0h" | "post-0..24h" | "post-24..48h";
  originCount: number;
  scoredCount: number;
  censoredCount: number;
  positiveCount: number;
  actualRate: number | null;
  averagePrediction: number | null;
  brier: number | null;
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value: number) {
  return Number.isFinite(value)
    ? Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value))
    : LOG_LOSS_EPSILON;
}

function quantile(values: number[], probability: number) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function createCalibration(values: Array<{ prediction: number; actual: number }>) {
  return [0, 0.2, 0.4, 0.6, 0.8].map((lower) => {
    const upper = lower + 0.2;
    const bucket = values.filter(({ prediction }) =>
      prediction >= lower && prediction < upper,
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
    } satisfies CalibrationBucket;
  });
}

function calculateAuc(values: Array<{ prediction: number; actual: number }>) {
  const positives = values.filter((value) => value.actual === 1);
  const negatives = values.filter((value) => value.actual === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.prediction > negative.prediction) wins += 1;
      else if (positive.prediction === negative.prediction) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

function getScoredValues(rows: RegimeEvaluationRow[], horizon: "24h" | "48h") {
  return rows.flatMap((row) => {
    const actual = horizon === "24h" ? row.actual24h : row.actual48h;
    if (actual === null) return [];
    return [{
      prediction: Math.min(1, Math.max(0, horizon === "24h" ? row.probability24h : row.probability48h)),
      actual: Number(actual),
    }];
  });
}

export function summarizeOutcomes(rows: RegimeEvaluationRow[]): OutcomeSummary {
  return {
    originCount: rows.length,
    scored24h: rows.filter((row) => row.actual24h !== null).length,
    censored24h: rows.filter((row) => row.actual24h === null).length,
    positive24h: rows.filter((row) => row.actual24h === true).length,
    scored48h: rows.filter((row) => row.actual48h !== null).length,
    censored48h: rows.filter((row) => row.actual48h === null).length,
    positive48h: rows.filter((row) => row.actual48h === true).length,
  };
}

function summarizeSelectedOutcomes(
  rows: RegimeEvaluationRow[],
  origins24h: Set<string>,
  origins48h: Set<string>,
): OutcomeSummary {
  return {
    originCount: new Set([...Array.from(origins24h), ...Array.from(origins48h)]).size,
    scored24h: rows.filter((row) => origins24h.has(row.recordedAt) && row.actual24h !== null).length,
    censored24h: rows.filter((row) => origins24h.has(row.recordedAt) && row.actual24h === null).length,
    positive24h: rows.filter((row) => origins24h.has(row.recordedAt) && row.actual24h === true).length,
    scored48h: rows.filter((row) => origins48h.has(row.recordedAt) && row.actual48h !== null).length,
    censored48h: rows.filter((row) => origins48h.has(row.recordedAt) && row.actual48h === null).length,
    positive48h: rows.filter((row) => origins48h.has(row.recordedAt) && row.actual48h === true).length,
  };
}

export function calculateMetric(
  rows: RegimeEvaluationRow[],
  horizon: "24h" | "48h",
): MetricSummary {
  const values = getScoredValues(rows, horizon);
  if (values.length === 0) {
    return {
      count: 0,
      positiveCount: 0,
      actualRate: 0,
      averagePrediction: 0,
      brier: 0,
      logLoss: 0,
      predictionStandardDeviation: 0,
      min: 0,
      max: 0,
      quantiles: { p5: 0, p25: 0, median: 0, p75: 0, p95: 0 },
      auc: null,
      calibration: createCalibration([]),
    };
  }
  const predictions = values.map((value) => value.prediction);
  const mean = predictions.reduce((sum, value) => sum + value, 0) / predictions.length;
  return {
    count: values.length,
    positiveCount: values.reduce((sum, value) => sum + value.actual, 0),
    actualRate: values.reduce((sum, value) => sum + value.actual, 0) / values.length,
    averagePrediction: mean,
    brier: values.reduce((sum, value) => sum + (value.prediction - value.actual) ** 2, 0) / values.length,
    logLoss: values.reduce((sum, value) => {
      const prediction = clampProbability(value.prediction);
      return sum - (value.actual * Math.log(prediction) + (1 - value.actual) * Math.log(1 - prediction));
    }, 0) / values.length,
    predictionStandardDeviation: Math.sqrt(
      predictions.reduce((sum, value) => sum + (value - mean) ** 2, 0) / predictions.length,
    ),
    min: Math.min(...predictions),
    max: Math.max(...predictions),
    quantiles: {
      p5: quantile(predictions, 0.05),
      p25: quantile(predictions, 0.25),
      median: quantile(predictions, 0.5),
      p75: quantile(predictions, 0.75),
      p95: quantile(predictions, 0.95),
    },
    auc: calculateAuc(values),
    calibration: createCalibration(values),
  };
}

function sortByTime<T extends { recordedAt: string }>(rows: T[]) {
  return rows.slice().sort((left, right) => timestamp(left.recordedAt)! - timestamp(right.recordedAt)!);
}

export function selectNonOverlappingOrigins(origins: string[], horizonHours: number) {
  const sorted = origins
    .map((origin) => ({ origin, time: timestamp(origin) }))
    .filter((item): item is { origin: string; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time);
  const result: string[] = [];
  let lastTime: number | null = null;
  for (const item of sorted) {
    if (lastTime === null || item.time - lastTime >= horizonHours * HOUR_MS) {
      result.push(item.origin);
      lastTime = item.time;
    }
  }
  return result;
}

export function createSixHourOrigins(
  events: ShadowResetEvent[],
  asOf: string,
  minimumCompletedIntervals = 5,
  latestHorizonHours = 48,
) {
  const asOfTime = timestamp(asOf);
  const sorted = events
    .map((event) => ({ event, time: timestamp(event.resetAt) }))
    .filter((item): item is { event: ShadowResetEvent; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time);
  const firstEligible = sorted[minimumCompletedIntervals];
  if (asOfTime === null || !firstEligible) return [];
  const firstOrigin = Math.ceil(firstEligible.time / SIX_HOUR_MS) * SIX_HOUR_MS;
  const lastOrigin = asOfTime - latestHorizonHours * HOUR_MS;
  const origins: string[] = [];
  for (let current = firstOrigin; current <= lastOrigin; current += SIX_HOUR_MS) {
    origins.push(new Date(current).toISOString());
  }
  return origins;
}

export function getCensorAwareOutcome(
  boundaries: RecoveryResetBoundary[],
  origin: string,
  horizonHours: number,
): EvaluationOutcome {
  const originTime = timestamp(origin);
  if (originTime === null || horizonHours <= 0) return null;
  const end = originTime + horizonHours * HOUR_MS;
  const withinHorizon = boundaries.filter((boundary) => {
    const boundaryTime = timestamp(boundary.resetAt);
    return boundaryTime !== null && boundaryTime > originTime && boundaryTime <= end;
  });
  if (withinHorizon.some((boundary) => boundary.isRandom)) return true;
  if (withinHorizon.some((boundary) => boundary.isRegular)) return null;
  return false;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function calculateBrierDifference(
  candidate: RegimeEvaluationRow[],
  current: RegimeEvaluationRow[],
  horizon: "24h" | "48h",
) {
  const currentByOrigin = new Map(current.map((row) => [row.recordedAt, row]));
  const pairs = candidate.flatMap((row) => {
    const other = currentByOrigin.get(row.recordedAt);
    const actual = horizon === "24h" ? row.actual24h : row.actual48h;
    const otherActual = horizon === "24h" ? other?.actual24h : other?.actual48h;
    if (!other || actual === null || otherActual === null || actual === undefined || otherActual === undefined) return [];
    const prediction = horizon === "24h" ? row.probability24h : row.probability48h;
    const otherPrediction = horizon === "24h" ? other.probability24h : other.probability48h;
    return [{ prediction, otherPrediction, actual: Number(actual) }];
  });
  if (pairs.length === 0) return null;
  return pairs.reduce((sum, pair) => sum + (pair.prediction - pair.actual) ** 2 - (pair.otherPrediction - pair.actual) ** 2, 0) / pairs.length;
}

export function calculateBootstrapDifference(
  candidate: RegimeEvaluationRow[],
  current: RegimeEvaluationRow[],
  horizon: "24h" | "48h",
  seed = BOOTSTRAP_SEED,
  iterations = BOOTSTRAP_ITERATIONS,
): BootstrapSummary | null {
  const currentByOrigin = new Map(current.map((row) => [row.recordedAt, row]));
  const pairs = sortByTime(candidate).flatMap((row) => {
    const other = currentByOrigin.get(row.recordedAt);
    const actual = horizon === "24h" ? row.actual24h : row.actual48h;
    const otherActual = horizon === "24h" ? other?.actual24h : other?.actual48h;
    return other && actual !== null && actual !== undefined && otherActual !== null && otherActual !== undefined
      ? [{ row, other }]
      : [];
  });
  if (pairs.length === 0) return null;
  const blocks: Array<typeof pairs> = [];
  for (let index = 0; index < pairs.length; index += 7) blocks.push(pairs.slice(index, index + 7));
  const random = seededRandom(seed);
  const differences: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: typeof pairs = [];
    while (sample.length < pairs.length) sample.push(...blocks[Math.floor(random() * blocks.length)]);
    const candidateRows = sample.slice(0, pairs.length).map((pair) => pair.row);
    const currentRows = sample.slice(0, pairs.length).map((pair) => pair.other);
    const difference = calculateBrierDifference(candidateRows, currentRows, horizon);
    if (difference !== null) differences.push(difference);
  }
  differences.sort((left, right) => left - right);
  return {
    seed,
    iterations: differences.length,
    lower: quantile(differences, 0.025),
    median: quantile(differences, 0.5),
    upper: quantile(differences, 0.975),
  };
}

function configKey(config: RegimeElapsedCandidateConfig) {
  return `${config.binScheme}|prior=${config.priorExposureDays}|half=${config.regimeHalfLifeDays}|exp=${config.regimeRatioExponent}`;
}

export function getCandidateConfigurations(): Array<RegimeElapsedCandidateConfig> {
  return REGIME_ELAPSED_BIN_SCHEME_CANDIDATES.flatMap((binScheme) =>
    REGIME_ELAPSED_PRIOR_EXPOSURE_DAY_CANDIDATES.flatMap((priorExposureDays) =>
      REGIME_ELAPSED_REGIME_HALF_LIFE_CANDIDATES.flatMap((regimeHalfLifeDays) =>
        REGIME_ELAPSED_RATIO_EXPONENT_CANDIDATES.map((regimeRatioExponent) => ({
          binScheme,
          priorExposureDays,
          regimeHalfLifeDays,
          regimeRatioExponent,
        })),
      ),
    ),
  );
}

function candidateScore(rows: RegimeEvaluationRow[]) {
  const metric24h = calculateMetric(rows, "24h");
  const metric48h = calculateMetric(rows, "48h");
  const score24h = metric24h.count === 0 ? null : metric24h.brier;
  const score48h = metric48h.count === 0 ? null : metric48h.brier;
  return {
    count24h: metric24h.count,
    count48h: metric48h.count,
    brier24h: score24h,
    brier48h: score48h,
  };
}

export function selectPrequentialCandidate(
  candidates: Array<{ key: string; rows: RegimeEvaluationRow[] }>,
  fallbackKey: string,
) {
  const ranked = candidates
    .map((candidate) => {
      const score = candidateScore(candidate.rows);
      const values = [score.brier24h, score.brier48h].filter((value): value is number => value !== null);
      return {
        key: candidate.key,
        score: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    })
    .filter((candidate): candidate is { key: string; score: number } => candidate.score !== null)
    .sort((left, right) => left.score - right.score);
  return ranked[0]?.key ?? fallbackKey;
}

function modelOptions(origin: Date, config: RegimeElapsedCandidateConfig, mode: RegimeElapsedMode): RegimeElapsedModelOptions & {
  now: Date;
} {
  return {
    now: origin,
    mode,
    binScheme: config.binScheme,
    priorExposureDays: config.priorExposureDays,
    regimeHalfLifeDays: config.regimeHalfLifeDays,
    regimeRatioExponent: config.regimeRatioExponent,
    minRegimeMultiplier: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.minRegimeMultiplier,
    maxRegimeMultiplier: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.maxRegimeMultiplier,
  };
}

function pointInTimeOptions(origin: Date) {
  return {
    now: origin,
    staticHistory: LOCAL_RESET_HISTORY,
    regularResetExpectedAt: null,
    activeOfficialNotice: undefined,
    localObservationSignals: getPointInTimeLocalObservationSignals(origin),
  } as const;
}

function getPrediction(
  mode: ModelKey,
  data: RadarData,
  origin: Date,
  config: RegimeElapsedCandidateConfig,
): Pick<ShadowProbabilityHorizons, "probability24h" | "probability48h"> {
  const options = pointInTimeOptions(origin);
  if (mode === "current-h30-r3") {
    const result = calculateRecencyWeightedShadowProbability(data, 30, options);
    return result.predictions;
  }
  const shadow = calculateShadowProbability(data, options);
  if (mode === "constant-hazard") return calculateConstantHazardBenchmark(shadow).predictions;
  const result = calculateRegimeElapsedProbability(data, options, modelOptions(origin, config, mode === "regime-only" ? "regime-only" : mode === "elapsed-only" ? "elapsed-only" : "full"));
  return result.predictions;
}

function makeModelRows(
  sourceData: RadarData,
  origins: string[],
  mode: ModelKey,
  config: RegimeElapsedCandidateConfig,
  labelBoundaries: RecoveryResetBoundary[],
): RegimeEvaluationRow[] {
  return origins.map((recordedAt) => {
    const origin = new Date(recordedAt);
    const data = getPointInTimeRadarData(sourceData, origin);
    if (!data) throw new Error(`Unable to project RadarData at origin ${recordedAt}`);
    const prediction = getPrediction(mode, data, origin, config);
    return {
      recordedAt,
      probability24h: prediction.probability24h,
      probability48h: prediction.probability48h,
      actual24h: getCensorAwareOutcome(labelBoundaries, recordedAt, 24),
      actual48h: getCensorAwareOutcome(labelBoundaries, recordedAt, 48),
    };
  });
}

function makePrequentialModelRows(
  sourceData: RadarData,
  selectionAudit: Array<{ origin: string; selectedKey: string }>,
  mode: ModelKey,
  candidates: RegimeElapsedCandidateConfig[],
  fallbackConfig: RegimeElapsedCandidateConfig,
  labelBoundaries: RecoveryResetBoundary[],
): RegimeEvaluationRow[] {
  const configsByKey = new Map(candidates.map((config) => [configKey(config), config]));
  return selectionAudit.map(({ origin: recordedAt, selectedKey }) => {
    const origin = new Date(recordedAt);
    const data = getPointInTimeRadarData(sourceData, origin);
    if (!data) throw new Error(`Unable to project RadarData at origin ${recordedAt}`);
    const config = configsByKey.get(selectedKey) ?? fallbackConfig;
    const prediction = getPrediction(mode, data, origin, config);
    return {
      recordedAt,
      probability24h: prediction.probability24h,
      probability48h: prediction.probability48h,
      actual24h: getCensorAwareOutcome(labelBoundaries, recordedAt, 24),
      actual48h: getCensorAwareOutcome(labelBoundaries, recordedAt, 48),
    };
  });
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(metric: MetricSummary) {
  return `n=${metric.count}, actual=${formatPercent(metric.actualRate)}, mean=${formatPercent(metric.averagePrediction)}, Brier=${metric.brier.toFixed(4)}, logLoss=${metric.logLoss.toFixed(4)}, AUC=${metric.auc === null ? "n/a" : metric.auc.toFixed(4)}, sd=${metric.predictionStandardDeviation.toFixed(4)}, range=${formatPercent(metric.min)}-${formatPercent(metric.max)}`;
}

function buildModelEvaluation(
  modelVersion: string,
  mode: ModelKey,
  rows: RegimeEvaluationRow[],
  nonOverlapping24h: Set<string>,
  nonOverlapping48h: Set<string>,
  current: ModelEvaluation | null,
): ModelEvaluation {
  const evaluation: ModelEvaluation = {
    modelVersion,
    mode,
    metrics24h: calculateMetric(rows, "24h"),
    metrics48h: calculateMetric(rows, "48h"),
    nonOverlapping24h: calculateMetric(rows.filter((row) => nonOverlapping24h.has(row.recordedAt)), "24h"),
    nonOverlapping48h: calculateMetric(rows.filter((row) => nonOverlapping48h.has(row.recordedAt)), "48h"),
    differenceVsCurrent: null,
  };
  if (current) {
    evaluation.differenceVsCurrent = {
      brier24h: evaluation.metrics24h.brier - current.metrics24h.brier,
      brier48h: evaluation.metrics48h.brier - current.metrics48h.brier,
      logLoss24h: evaluation.metrics24h.logLoss - current.metrics24h.logLoss,
      logLoss48h: evaluation.metrics48h.logLoss - current.metrics48h.logLoss,
      bootstrap24h: calculateBootstrapDifference(rows, currentRowsFor(current), "24h"),
      bootstrap48h: calculateBootstrapDifference(rows, currentRowsFor(current), "48h"),
    };
  }
  return evaluation;
}

// The evaluation object keeps the current rows attached without exposing them
// in the report JSON. This avoids duplicating all origin rows in every model.
const evaluationRows = new WeakMap<ModelEvaluation, RegimeEvaluationRow[]>();
function currentRowsFor(evaluation: ModelEvaluation) {
  return evaluationRows.get(evaluation) ?? [];
}

function buildRegimeEventAudit(
  randomEvents: ShadowResetEvent[],
): RegimeEventAudit[] {
  const sorted = randomEvents
    .map((event) => ({ event, time: timestamp(event.resetAt) }))
    .filter((item): item is { event: ShadowResetEvent; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time);
  const halfLives = REGIME_ELAPSED_REGIME_HALF_LIFE_CANDIDATES;
  return sorted.map(({ event, time }, index) => {
    const previousTime = sorted[index - 1]?.time ?? null;
    const rolling7dCount = sorted.filter((item) => item.time > time - 7 * DAY_MS && item.time <= time).length;
    const rolling14dCount = sorted.filter((item) => item.time > time - 14 * DAY_MS && item.time <= time).length;
    const ewmaRates = Object.fromEntries(halfLives.map((halfLifeDays) => {
      const diagnostics = calculateRegimeElapsedProbability(
        null,
        { now: new Date(time), staticHistory: LOCAL_RESET_HISTORY, activeOfficialNotice: null },
        { mode: "full", regimeHalfLifeDays: halfLifeDays },
      ).regimeElapsed.regime;
      return [String(halfLifeDays), {
        recentWeightedEventCount: diagnostics.recentWeightedEventCount,
        recentWeightedExposureDays: diagnostics.recentWeightedExposureDays,
        recentRatePerDay: diagnostics.recentRatePerDay,
        longTermRatePerDay: diagnostics.longTermRatePerDay,
        rawRateRatio: diagnostics.rawRateRatio,
        regimeMultiplier: diagnostics.regimeMultiplier,
      }];
    }));
    return {
      id: event.id,
      resetAt: event.resetAt,
      rolling7dCount,
      rolling14dCount,
      intervalsSincePreviousHours: previousTime === null ? null : (time - previousTime) / HOUR_MS,
      ewmaRates,
    };
  });
}

export function evaluateRegimeElapsedProbability(sourceData: RadarData, asOf: Date) {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const randomEvents = makeRandomEvents(sourceData, asOf);
  const boundaries = getRecoveryResetEvents(sourceData, asOf, LOCAL_RESET_HISTORY);
  const origins = createSixHourOrigins(randomEvents, asOf.toISOString());
  const nonOverlapping24hOrigins = selectNonOverlappingOrigins(origins, 24);
  const nonOverlapping48hOrigins = selectNonOverlappingOrigins(origins, 48);
  const nonOverlapping24h = new Set(nonOverlapping24hOrigins);
  const nonOverlapping48h = new Set(nonOverlapping48hOrigins);
  const fallbackConfig: RegimeElapsedCandidateConfig = {
    binScheme: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.binScheme,
    priorExposureDays: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.priorExposureDays,
    regimeHalfLifeDays: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.regimeHalfLifeDays,
    regimeRatioExponent: PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS.regimeRatioExponent,
  };
  const candidates = getCandidateConfigurations();
  const candidateRows = new Map<string, RegimeEvaluationRow[]>(candidates.map((config) => [configKey(config), []]));
  const candidateSelectionCounts = new Map<string, number>();
  const selectionAudit: Array<{ origin: string; selectedKey: string; candidateCount: number }> = [];
  for (const recordedAt of origins) {
    const selectedKey = selectPrequentialCandidate(
      Array.from(candidateRows, ([key, rows]) => ({ key, rows })),
      configKey(fallbackConfig),
    );
    candidateSelectionCounts.set(selectedKey, (candidateSelectionCounts.get(selectedKey) ?? 0) + 1);
    selectionAudit.push({ origin: recordedAt, selectedKey, candidateCount: candidates.length });
    const origin = new Date(recordedAt);
    const data = getPointInTimeRadarData(sourceData, origin);
    if (!data) throw new Error(`Unable to project RadarData at origin ${recordedAt}`);
    for (const config of candidates) {
      const key = configKey(config);
      const prediction = getPrediction("regime-elapsed", data, origin, config);
      candidateRows.get(key)!.push({
        recordedAt,
        probability24h: prediction.probability24h,
        probability48h: prediction.probability48h,
        actual24h: getCensorAwareOutcome(boundaries, recordedAt, 24),
        actual48h: getCensorAwareOutcome(boundaries, recordedAt, 48),
      });
    }
  }
  const selectedKey = Array.from(candidateSelectionCounts.entries())
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? configKey(fallbackConfig);
  const selectedConfig = candidates.find((config) => configKey(config) === selectedKey) ?? fallbackConfig;
  const currentRows = makeModelRows(sourceData, origins, "current-h30-r3", fallbackConfig, boundaries);
  const constantRows = makeModelRows(sourceData, origins, "constant-hazard", fallbackConfig, boundaries);
  const selectedOrigins = selectionAudit.map(({ origin, selectedKey }) => ({ origin, selectedKey }));
  const elapsedRows = makePrequentialModelRows(sourceData, selectedOrigins, "elapsed-only", candidates, fallbackConfig, boundaries);
  const regimeRows = makePrequentialModelRows(sourceData, selectedOrigins, "regime-only", candidates, fallbackConfig, boundaries);
  const fullRows = makePrequentialModelRows(sourceData, selectedOrigins, "regime-elapsed", candidates, fallbackConfig, boundaries);
  const outcomeSummary = summarizeOutcomes(currentRows);
  const nonOverlappingOutcomeSummary = summarizeSelectedOutcomes(currentRows, nonOverlapping24h, nonOverlapping48h);
  const currentModel = buildModelEvaluation(RECENCY_H30_PROBABILITY_MODEL_VERSION, "current-h30-r3", currentRows, nonOverlapping24h, nonOverlapping48h, null);
  evaluationRows.set(currentModel, currentRows);
  const models = [
    currentModel,
    buildModelEvaluation("benchmark-constant-hazard-v1", "constant-hazard", constantRows, nonOverlapping24h, nonOverlapping48h, currentModel),
    buildModelEvaluation(ELAPSED_ONLY_MODEL_VERSION, "elapsed-only", elapsedRows, nonOverlapping24h, nonOverlapping48h, currentModel),
    buildModelEvaluation("hazard-regime-elapsed-v1-regime-only", "regime-only", regimeRows, nonOverlapping24h, nonOverlapping48h, currentModel),
    buildModelEvaluation(REGIME_ELAPSED_FULL_MODEL_VERSION, "regime-elapsed", fullRows, nonOverlapping24h, nonOverlapping48h, currentModel),
  ];
  for (const model of models) evaluationRows.set(model, model === currentModel ? currentRows : model.mode === "constant-hazard" ? constantRows : model.mode === "elapsed-only" ? elapsedRows : model.mode === "regime-only" ? regimeRows : fullRows);

  const snapshotOptions = pointInTimeOptions(asOf);
  const oldSnapshot = calculateRecencyWeightedShadowProbability(sourceData, 30, snapshotOptions);
  const elapsedOnlySnapshot = calculateRegimeElapsedProbability(
    sourceData,
    snapshotOptions,
    PUBLISHED_ELAPSED_MODEL_OPTIONS,
  );
  const fullRegimeSnapshot = calculateRegimeElapsedProbability(
    sourceData,
    snapshotOptions,
    PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  );
  const boundariesForAudit = getRecoveryResetEvents(sourceData, asOf, LOCAL_RESET_HISTORY);
  const regimeAnalysis = {
    schemaVersion: "reset-regime-analysis-v2",
    asOf: asOf.toISOString(),
    inputMode: EVALUATION_INPUT_MODE,
    sourceAsOf: asOf.toISOString(),
    futureLeakagePolicyVersion: FUTURE_LEAKAGE_POLICY_VERSION,
    backfilled: false,
    targetDefinition: "Broad-scope random reset: confirmed global hard reset or broad Banked Reset distribution; regular reset is a recovery boundary only.",
    randomEvents: randomEvents.map((event) => ({ id: event.id, resetAt: event.resetAt })),
    recoveryBoundaries: boundariesForAudit,
    eventAudit: buildRegimeEventAudit(randomEvents),
    current: fullRegimeSnapshot.regimeElapsed.regime,
    currentElapsedHours: fullRegimeSnapshot.regimeElapsed.elapsedHours,
    resetIntervalsHours: buildResetIntervals(randomEvents),
    densitySummary: buildDensitySummary(randomEvents, asOf),
    hotNormalDiagnostic: "inconclusive",
    notes: [
      "Rolling counts and EWMA rates are descriptive diagnostics, not a post-hoc hot/normal rule used by the model.",
      "The sample is small and the GPT-5.6 high-density period was identified after inspecting the history; this is a post-hoc selection limitation.",
      "Regular boundaries reset elapsed exposure but never increase the random event or regime event count.",
    ],
  };
  const evaluationReport = {
    schemaVersion: "probability-model-evaluation-regime-elapsed-v2",
    generatedAt: asOf.toISOString(),
    asOf: asOf.toISOString(),
    inputMode: EVALUATION_INPUT_MODE,
    sourceAsOf: asOf.toISOString(),
    sourceDataCheckedAt: sourceData.checked_at ?? null,
    futureLeakagePolicyVersion: FUTURE_LEAKAGE_POLICY_VERSION,
    backfilled: false,
    evaluationMode: "walk-forward-prequential",
    originSpacingHours: 6,
    originCount: origins.length,
    origins,
    nonOverlapping24hOrigins: nonOverlapping24hOrigins,
    nonOverlapping48hOrigins: nonOverlapping48hOrigins,
    targetDefinition: regimeAnalysis.targetDefinition,
    eventCount: randomEvents.length,
    recoveryBoundaryCount: boundaries.length,
    labelSummary: outcomeSummary,
    nonOverlappingLabelSummary: nonOverlappingOutcomeSummary,
    selectedConfiguration: {
      ...selectedConfig,
      selectionKey: selectedKey,
      selectionCounts: Object.fromEntries(candidateSelectionCounts),
      candidateCount: candidates.length,
      selectionAuditTail: selectionAudit.slice(-20),
    },
    candidateScores: candidates.map((config) => {
      const rows = candidateRows.get(configKey(config)) ?? [];
      const score = candidateScore(rows);
      return {
        key: configKey(config),
        config,
        scoredCount24h: score.count24h,
        scoredCount48h: score.count48h,
        brier24h: score.brier24h,
        brier48h: score.brier48h,
      } satisfies CandidateScore;
    }).sort((left, right) => (left.brier24h ?? Infinity) + (left.brier48h ?? Infinity) - ((right.brier24h ?? Infinity) + (right.brier48h ?? Infinity))).slice(0, 20),
    models,
    currentSnapshot: {
      latestRandomResetAt: elapsedOnlySnapshot.regimeElapsed.latestRandomResetAt,
      latestRecoveryResetAt: elapsedOnlySnapshot.regimeElapsed.latestRecoveryResetAt,
      elapsedHours: elapsedOnlySnapshot.regimeElapsed.elapsedHours,
      oldH30R3: {
        modelVersion: oldSnapshot.modelVersion,
        predictions: oldSnapshot.predictions,
        regime: null,
      },
      elapsedOnly: elapsedOnlySnapshot.predictions,
      regimeOnly: calculateRegimeElapsedProbability(sourceData, snapshotOptions, { ...selectedConfig, mode: "regime-only" }).predictions,
      fullRegimeShadow: {
        modelVersion: fullRegimeSnapshot.modelVersion,
        predictions: fullRegimeSnapshot.predictions,
        regimeDiagnostics: fullRegimeSnapshot.regimeElapsed.regime,
      },
      newModel: {
        modelVersion: elapsedOnlySnapshot.modelVersion,
        predictions: elapsedOnlySnapshot.predictions,
        rawPredictions: elapsedOnlySnapshot.predictions,
        regimeDiagnostics: elapsedOnlySnapshot.regimeElapsed.regime,
        effectiveRegimeMultiplier: elapsedOnlySnapshot.regimeElapsed.effectiveRegimeMultiplier,
        elapsedHazardBins: elapsedOnlySnapshot.regimeElapsed.bins,
        signalMultipliers: elapsedOnlySnapshot.multipliers,
      },
    },
    regularPhaseDiagnostics: {
      modelVersion: ELAPSED_ONLY_MODEL_VERSION,
      horizon: "24h",
      phases: buildRegularPhaseDiagnostics(elapsedRows, boundaries),
      note: "Origins whose horizon crosses a regular recovery boundary without a random event are censored and excluded from scored metrics.",
    },
    regularBoundaryAudit: elapsedOnlySnapshot.regimeElapsed.boundaryAudit,
    notes: [
      "All model predictions are generated from point-in-time projected data at each 6-hour origin.",
      "A horizon with a regular recovery boundary and no random event is censored rather than scored as a simple negative.",
      "The 24-hour and 48-hour non-overlapping subsets are lower-sample references; overlapping 6-hour origins are dependent.",
      "The selected configuration is chosen from past-origin scores only; no future label is used at the origin where a choice is made.",
      `This historical evaluation reports ${ELAPSED_ONLY_MODEL_VERSION}; the calibrated public model is evaluated through the prospective prediction_history path. ${REGIME_ELAPSED_FULL_MODEL_VERSION} remains the full-regime shadow and ${RECENCY_H30_PROBABILITY_MODEL_VERSION} remains the comparison and fallback model.`,
      "The published model uses elapsed-only hazard with an effective regime multiplier of 1; full regime diagnostics remain shadow-only.",
      `The current model uses bin scheme ${selectedConfig.binScheme}, prior exposure ${selectedConfig.priorExposureDays} days, regime half-life ${selectedConfig.regimeHalfLifeDays} days, and ratio exponent ${selectedConfig.regimeRatioExponent}.`,
      "No fixed 14%/27% display cap is included in these predictions.",
    ],
  };
  return { evaluationReport, regimeAnalysis };
}

function makeRandomEvents(data: RadarData, asOf: Date) {
  const result = calculateRegimeElapsedProbability(data, {
    now: asOf,
    staticHistory: LOCAL_RESET_HISTORY,
    activeOfficialNotice: null,
  });
  return result.regimeElapsed.boundaryAudit
    .filter((item) => item.randomEligible && item.resetAt)
    .map((item) => ({ id: item.id, resetAt: item.resetAt! } satisfies ShadowResetEvent));
}

function buildResetIntervals(events: ShadowResetEvent[]) {
  const sorted = events
    .map((event) => ({ event, time: timestamp(event.resetAt) }))
    .filter((item): item is { event: ShadowResetEvent; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time);
  return sorted.map((item, index) => ({
    from: sorted[index - 1]?.event.resetAt ?? null,
    to: item.event.resetAt,
    hours: sorted[index - 1] ? (item.time - sorted[index - 1].time) / HOUR_MS : null,
  }));
}

function buildDensitySummary(events: ShadowResetEvent[], asOf: Date) {
  const asOfTime = asOf.getTime();
  const rolling = [7, 14].map((days) => {
    const counts = events.flatMap((event) => {
      const time = timestamp(event.resetAt);
      return time === null || time > asOfTime ? [] : [events.filter((candidate) => {
        const candidateTime = timestamp(candidate.resetAt);
        return candidateTime !== null && candidateTime <= time && candidateTime > time - days * DAY_MS;
      }).length];
    });
    return {
      days,
      maxCount: counts.length === 0 ? 0 : Math.max(...counts),
      minCount: counts.length === 0 ? 0 : Math.min(...counts),
      latestCount: counts.at(-1) ?? 0,
    };
  });
  return {
    rolling,
    gpt56HighDensityPeriod: "Descriptive label only: the mid-July GPT-5.6 period contains the highest observed short-window concentration in this snapshot.",
    afterAugustFirst: "The post-2026-08-01 interval is short and does not support a stable normal-regime estimate.",
  };
}

function buildRegularPhaseDiagnostics(
  rows: RegimeEvaluationRow[],
  boundaries: RecoveryResetBoundary[],
): RegularPhaseSummary[] {
  const phases: Array<RegularPhaseSummary["phase"]> = [
    "pre-24..0h",
    "post-0..24h",
    "post-24..48h",
  ];
  const offsets: Record<RegularPhaseSummary["phase"], [number, number]> = {
    "pre-24..0h": [-24, 0],
    "post-0..24h": [0, 24],
    "post-24..48h": [24, 48],
  };

  return boundaries
    .filter((boundary) => boundary.isRegular)
    .flatMap((boundary) => {
      const boundaryTime = timestamp(boundary.resetAt);
      if (boundaryTime === null) return [];
      return phases.map((phase) => {
        const [startHours, endHours] = offsets[phase];
        const phaseRows = rows.filter((row) => {
          const originTime = timestamp(row.recordedAt);
          return originTime !== null &&
            originTime >= boundaryTime + startHours * HOUR_MS &&
            originTime < boundaryTime + endHours * HOUR_MS;
        });
        const metric = calculateMetric(phaseRows, "24h");
        return {
          boundaryAt: boundary.resetAt,
          phase,
          originCount: phaseRows.length,
          scoredCount: metric.count,
          censoredCount: phaseRows.filter((row) => row.actual24h === null).length,
          positiveCount: metric.positiveCount,
          actualRate: metric.count === 0 ? null : metric.actualRate,
          averagePrediction: phaseRows.length === 0
            ? null
            : phaseRows.reduce((sum, row) => sum + row.probability24h, 0) / phaseRows.length,
          brier: metric.count === 0 ? null : metric.brier,
        } satisfies RegularPhaseSummary;
      });
    });
}

function writeMarkdown(evaluationReport: ReturnType<typeof evaluateRegimeElapsedProbability>["evaluationReport"], regimeAnalysis: ReturnType<typeof evaluateRegimeElapsedProbability>["regimeAnalysis"]) {
  const lines = [
    "# Reset Regime × Elapsed Probability Evaluation",
    "",
    `- model: ${ELAPSED_ONLY_MODEL_VERSION}`,
    `- asOf: ${evaluationReport.asOf}`,
    `- input mode: ${evaluationReport.inputMode}`,
    `- source asOf: ${evaluationReport.sourceAsOf}`,
    `- source checkedAt: ${evaluationReport.sourceDataCheckedAt ?? "unknown"}`,
    `- future leakage policy: ${evaluationReport.futureLeakagePolicyVersion}`,
    `- backfilled: ${evaluationReport.backfilled}`,
    `- mode: ${evaluationReport.evaluationMode}`,
    `- origins: ${evaluationReport.originCount} (every ${evaluationReport.originSpacingHours}h)`,
    `- target events: ${evaluationReport.eventCount}`,
    `- recovery boundaries: ${evaluationReport.recoveryBoundaryCount}`,
    `- labels: 24h scored=${evaluationReport.labelSummary.scored24h}, censored=${evaluationReport.labelSummary.censored24h}; 48h scored=${evaluationReport.labelSummary.scored48h}, censored=${evaluationReport.labelSummary.censored48h}`,
    `- non-overlap labels: 24h scored=${evaluationReport.nonOverlappingLabelSummary.scored24h}, censored=${evaluationReport.nonOverlappingLabelSummary.censored24h}; 48h scored=${evaluationReport.nonOverlappingLabelSummary.scored48h}, censored=${evaluationReport.nonOverlappingLabelSummary.censored48h}`,
    `- selected bins/prior/half-life: ${evaluationReport.selectedConfiguration.binScheme} / ${evaluationReport.selectedConfiguration.priorExposureDays}d / ${evaluationReport.selectedConfiguration.regimeHalfLifeDays}d`,
    "",
    "## Current snapshot",
    "",
    `- latest random reset: ${evaluationReport.currentSnapshot.latestRandomResetAt ?? "none"}`,
    `- latest recovery boundary: ${evaluationReport.currentSnapshot.latestRecoveryResetAt ?? "none"}`,
    `- elapsed since recovery boundary: ${evaluationReport.currentSnapshot.elapsedHours.toFixed(2)}h`,
    `- old h30-r3: ${formatPrediction(evaluationReport.currentSnapshot.oldH30R3.predictions)}`,
    `- elapsed-only: ${formatPrediction(evaluationReport.currentSnapshot.elapsedOnly)}`,
    `- regime-only: ${formatPrediction(evaluationReport.currentSnapshot.regimeOnly)}`,
    `- new model: ${formatPrediction(evaluationReport.currentSnapshot.newModel.predictions)}`,
    `- regime diagnostics: ${JSON.stringify(evaluationReport.currentSnapshot.newModel.regimeDiagnostics)}`,
    "",
    "## Metrics",
    "",
    "| Model | 24h Brier | 48h Brier | 24h log loss | 48h log loss | non-overlap 24h n | non-overlap 48h n |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...evaluationReport.models.map((model) => `| ${model.modelVersion} | ${model.metrics24h.brier.toFixed(4)} | ${model.metrics48h.brier.toFixed(4)} | ${model.metrics24h.logLoss.toFixed(4)} | ${model.metrics48h.logLoss.toFixed(4)} | ${model.nonOverlapping24h.count} | ${model.nonOverlapping48h.count} |`),
    "",
    ...evaluationReport.models.flatMap((model) => [
      `### ${model.modelVersion}`,
      "",
      `- 24h: ${formatMetric(model.metrics24h)}`,
      `- 48h: ${formatMetric(model.metrics48h)}`,
      `- non-overlap 24h: ${formatMetric(model.nonOverlapping24h)}`,
      `- non-overlap 48h: ${formatMetric(model.nonOverlapping48h)}`,
      `- difference vs current: ${model.differenceVsCurrent ? JSON.stringify(model.differenceVsCurrent) : "baseline"}`,
      "",
    ]),
    "## Regime diagnostics",
    "",
    `- hot/normal diagnostic: ${regimeAnalysis.hotNormalDiagnostic}`,
    `- rolling density: ${JSON.stringify(regimeAnalysis.densitySummary)}`,
    `- random reset intervals: ${JSON.stringify(regimeAnalysis.resetIntervalsHours)}`,
    `- regular phase diagnostics: ${JSON.stringify(evaluationReport.regularPhaseDiagnostics)}`,
    "",
    "## Candidate selection",
    "",
    `- candidate count: ${evaluationReport.selectedConfiguration.candidateCount}`,
    `- selected key: ${evaluationReport.selectedConfiguration.selectionKey}`,
    `- selection counts: ${JSON.stringify(evaluationReport.selectedConfiguration.selectionCounts)}`,
    ...evaluationReport.candidateScores.slice(0, 10).map((candidate) => `- ${candidate.key}: 24h Brier=${candidate.brier24h ?? "n/a"}, 48h Brier=${candidate.brier48h ?? "n/a"}`),
    "",
    "## Limitations",
    "",
    ...evaluationReport.notes.map((note) => `- ${note}`),
    ...regimeAnalysis.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

function writeRegimeMarkdown(regimeAnalysis: ReturnType<typeof evaluateRegimeElapsedProbability>["regimeAnalysis"]) {
  const lines = [
    "# Reset Regime Analysis",
    "",
    `- schema: ${regimeAnalysis.schemaVersion}`,
    `- asOf: ${regimeAnalysis.asOf}`,
    `- input mode: ${regimeAnalysis.inputMode}`,
    `- source asOf: ${regimeAnalysis.sourceAsOf}`,
    `- future leakage policy: ${regimeAnalysis.futureLeakagePolicyVersion}`,
    `- backfilled: ${regimeAnalysis.backfilled}`,
    `- target: ${regimeAnalysis.targetDefinition}`,
    `- random events: ${regimeAnalysis.randomEvents.length}`,
    `- recovery boundaries: ${regimeAnalysis.recoveryBoundaries.length}`,
    `- current elapsed hours: ${regimeAnalysis.currentElapsedHours.toFixed(2)}`,
    `- hot/normal diagnostic: ${regimeAnalysis.hotNormalDiagnostic}`,
    "",
    "## Current regime diagnostics",
    "",
    "```json",
    JSON.stringify(regimeAnalysis.current, null, 2),
    "```",
    "",
    "## Random reset events",
    "",
    ...regimeAnalysis.randomEvents.map((event) => `- ${event.resetAt} (${event.id})`),
    "",
    "## Recovery boundaries",
    "",
    ...regimeAnalysis.recoveryBoundaries.map((boundary) => `- ${boundary.resetAt}: random=${boundary.isRandom}, regular=${boundary.isRegular}, id=${boundary.id}`),
    "",
    "## Density and intervals",
    "",
    `- rolling density: ${JSON.stringify(regimeAnalysis.densitySummary)}`,
    `- reset intervals: ${JSON.stringify(regimeAnalysis.resetIntervalsHours)}`,
    "",
    "## Notes",
    "",
    ...regimeAnalysis.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

function formatPrediction(predictions: Pick<ShadowProbabilityHorizons, "probability12h" | "probability24h" | "probability48h" | "probability72h">) {
  return `12h=${formatPercent(predictions.probability12h)}, 24h=${formatPercent(predictions.probability24h)}, 48h=${formatPercent(predictions.probability48h)}, 72h=${formatPercent(predictions.probability72h)}`;
}

export function writeReports(
  report: ReturnType<typeof evaluateRegimeElapsedProbability>,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(join(reportsDirectory, `${REGIME_ELAPSED_EVALUATION_REPORT_BASENAME}.json`), `${JSON.stringify(report.evaluationReport, null, 2)}\n`, "utf8");
  writeFileSync(join(reportsDirectory, `${REGIME_ELAPSED_EVALUATION_REPORT_BASENAME}.md`), writeMarkdown(report.evaluationReport, report.regimeAnalysis), "utf8");
  writeFileSync(join(reportsDirectory, `${REGIME_ANALYSIS_REPORT_BASENAME}.json`), `${JSON.stringify(report.regimeAnalysis, null, 2)}\n`, "utf8");
  writeFileSync(join(reportsDirectory, `${REGIME_ANALYSIS_REPORT_BASENAME}.md`), writeRegimeMarkdown(report.regimeAnalysis), "utf8");
}

function parseAsOf(args: string[]) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : DEFAULT_AS_OF;
  if (!value) throw new Error("--as-of requires an ISO timestamp");
  const asOf = new Date(value);
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

async function loadProductionEvaluationSource(asOf: Date) {
  const sourceData = await fetchCurrentRadarData({
    cache: "no-store",
    calculationNow: asOf,
    bypassCache: true,
  });
  if (sourceData.data_health?.overall !== "ok") {
    throw new Error("Production-like evaluation source is unavailable or degraded");
  }
  return sourceData;
}

async function main() {
  const asOf = parseAsOf(process.argv.slice(2));
  const sourceData = await loadProductionEvaluationSource(asOf);
  const report = evaluateRegimeElapsedProbability(sourceData, asOf);
  writeReports(report);
  console.log(JSON.stringify({
    asOf: report.evaluationReport.asOf,
    originCount: report.evaluationReport.originCount,
    eventCount: report.evaluationReport.eventCount,
    recoveryBoundaryCount: report.evaluationReport.recoveryBoundaryCount,
    selectedConfiguration: report.evaluationReport.selectedConfiguration,
    models: report.evaluationReport.models.map((model) => ({
      modelVersion: model.modelVersion,
      brier24h: model.metrics24h.brier,
      brier48h: model.metrics48h.brier,
      logLoss24h: model.metrics24h.logLoss,
      logLoss48h: model.metrics48h.logLoss,
    })),
    currentSnapshot: report.evaluationReport.currentSnapshot,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateRegimeElapsedProbability.ts") {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production-like evaluation failed");
    process.exitCode = 1;
  });
}
