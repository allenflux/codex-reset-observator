import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  LOCAL_MODEL_UPDATED_AT,
  LOCAL_RESET_HISTORY,
} from "../data/resetHistory";
import {
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  ELAPSED_ONLY_MODEL_VERSION,
  RECENCY_SHADOW_MODEL_CONFIG,
  SHADOW_PROBABILITY_MODEL_VERSION,
  SHADOW_TARGET_DEFINITION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import {
  calculateRecencyWeightedShadowProbability,
} from "../lib/radar/recencyWeightedProbability";
import {
  calculateConstantHazardBenchmark,
  calculatePrequentialLogitCalibration,
  PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
  PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
  type PrequentialCalibrationAudit,
} from "../lib/radar/evaluationProbabilityModels";
import {
  calculateShadowProbability,
  getShadowCompletedResetEvents,
  type ShadowResetEvent,
} from "../lib/radar/shadowProbability";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";
import {
  createPrequentialOrigins,
  getActualWithinHorizon as getSharedActualWithinHorizon,
  getPointInTimeRadarData,
} from "../lib/radar/prequentialCalibration";
import { getPointInTimeLocalObservationSignals } from "../lib/radar/calibratedShadowProbability";

const HOUR_MS = 60 * 60 * 1000;
const BLOCK_DAYS = 7;
const BOOTSTRAP_ITERATIONS = 2_000;
const BOOTSTRAP_SEED = 20260804;
const LOG_LOSS_EPSILON = 1e-12;

export const CONSTANT_HAZARD_MODEL_VERSION = "benchmark-constant-hazard-v1";
export const CALIBRATED_V2_MODEL_VERSION = "benchmark-v2-logit-calibrated-prequential-v1";
export const PROBABILITY_MODEL_EVALUATION_REPORT_BASENAME =
  "probability-model-evaluation-random-inclusive";

export type EvaluationRow = {
  recordedAt: string;
  probability24h: number;
  probability48h: number;
  actual24h: boolean;
  actual48h: boolean;
};

export type CalibrationBucket = {
  range: string;
  lower: number;
  upper: number;
  count: number;
  averagePrediction: number;
  actualRate: number;
};

export type MetricSummary = {
  count: number;
  actualRate: number;
  averagePrediction: number;
  brier: number;
  logLoss: number;
  calibration: Array<CalibrationBucket>;
};

export type BootstrapSummary = {
  seed: number;
  blockDays: number;
  iterations: number;
  lower: number;
  median: number;
  upper: number;
};

export type ModelClassification =
  | "baseline"
  | "clearly_better"
  | "promising_but_inconclusive"
  | "no_meaningful_difference"
  | "worse";

export type ProbabilityModelDefinition = {
  modelVersion: string;
  halfLifeDays: number | null;
  kind: "shadow" | "constant_hazard" | "prequential_calibrated" | "recency" | "regime_elapsed";
};

export type ModelEvaluation = {
  modelVersion: string;
  halfLifeDays: number | null;
  kind: ProbabilityModelDefinition["kind"];
  classification: ModelClassification;
  metrics24h: MetricSummary;
  metrics48h: MetricSummary;
  nonOverlapping48h: MetricSummary;
  differenceVsCurrent: {
    brier24h: number;
    brier48h: number;
    logLoss24h: number;
    logLoss48h: number;
    bootstrap24h: BootstrapSummary;
    bootstrap48h: BootstrapSummary;
  } | null;
  nonOverlapping48hDifferenceVsCurrent: {
    brier: number;
    logLoss: number;
  } | null;
};

export type LabelSummary = {
  originCount: number;
  positive24h: number;
  positive48h: number;
};

export type EventContribution = {
  eventId: string;
  resetAt: string;
  positiveOrigins24h: number;
  positiveOrigins48h: number;
};

export type EvaluationDiagnostics = {
  ageStructure:
    | "age_structure_not_supported"
    | "age_structure_inconclusive"
    | "age_structure_supported"
    | "mixed_or_inconclusive";
  calibration:
    | "underprediction_calibration_signal"
    | "calibration_inconclusive"
    | "calibration_worse"
    | "mixed_or_inconclusive";
  constantHazardClassification: Exclude<ModelClassification, "baseline">;
  calibratedV2Classification: Exclude<ModelClassification, "baseline">;
  nonOverlapping48h: {
    constantHazardDirection: "better" | "worse" | "same" | "mixed";
    calibratedV2Direction: "better" | "worse" | "same" | "mixed";
  };
};

export type ProbabilityModelEvaluationReport = {
  schemaVersion: "probability-model-evaluation-v2";
  asOf: string;
  generatedAt: string;
  targetDefinition: string;
  eventCount: number;
  completedIntervalCount: number;
  observationPeriod: {
    start: string | null;
    end: string;
  };
  originCount: number;
  origins: string[];
  nonOverlapping48hOriginCount: number;
  nonOverlapping48hOrigins: string[];
  labelSummary: LabelSummary;
  nonOverlapping48hLabelSummary: LabelSummary;
  eventContributions: Array<EventContribution>;
  models: Array<ModelEvaluation>;
  prequentialCalibration: {
    priorStdDev: number;
    minimumSamples: number;
    origins: Array<PrequentialCalibrationAudit>;
    final: PrequentialCalibrationAudit | null;
  };
  diagnostics: EvaluationDiagnostics;
  notes: string[];
};

export type EventPartition = {
  training: Array<ShadowResetEvent>;
  future: Array<ShadowResetEvent>;
};

function timestamp(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function sortEvents(events: Array<ShadowResetEvent>) {
  return events
    .map((event) => ({ event, time: timestamp(event.resetAt) }))
    .filter((item): item is { event: ShadowResetEvent; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time)
    .map((item) => item.event);
}

export function partitionEventsAtOrigin(
  events: Array<ShadowResetEvent>,
  origin: string,
  asOf?: string,
): EventPartition {
  const originTime = timestamp(origin);
  const asOfTime = asOf === undefined ? Number.POSITIVE_INFINITY : timestamp(asOf);
  if (originTime === null || asOfTime === null || asOfTime < originTime) {
    throw new RangeError("origin and asOf must be valid, ordered timestamps");
  }

  const sorted = sortEvents(events);
  return {
    training: sorted.filter((event) => timestamp(event.resetAt)! <= originTime),
    future: sorted.filter((event) => {
      const eventTime = timestamp(event.resetAt)!;
      return eventTime > originTime && eventTime <= asOfTime;
    }),
  };
}

export function getActualWithinHorizon(
  events: Array<ShadowResetEvent>,
  origin: string,
  horizonHours: number,
) {
  return getSharedActualWithinHorizon(events, origin, horizonHours);
}

export function calculateEventContributions(
  events: Array<ShadowResetEvent>,
  origins: Array<string>,
): Array<EventContribution> {
  return sortEvents(events).map((event) => ({
    eventId: event.id,
    resetAt: event.resetAt,
    positiveOrigins24h: origins.filter((origin) =>
      getActualWithinHorizon([event], origin, 24),
    ).length,
    positiveOrigins48h: origins.filter((origin) =>
      getActualWithinHorizon([event], origin, 48),
    ).length,
  }));
}

export function createWalkForwardOrigins(
  events: Array<ShadowResetEvent>,
  asOf: string,
  minimumCompletedIntervals?: number,
) {
  return createPrequentialOrigins(events, asOf, minimumCompletedIntervals);
}

export function selectNonOverlappingOrigins(
  origins: Array<string>,
  horizonHours = 48,
) {
  if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
    throw new RangeError("horizonHours must be a positive number");
  }
  const sorted = origins
    .map((origin) => ({ origin, time: timestamp(origin) }))
    .filter((item): item is { origin: string; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time);
  const selected: string[] = [];
  let lastSelectedTime: number | null = null;
  const horizonMs = horizonHours * HOUR_MS;
  for (const item of sorted) {
    if (lastSelectedTime === null || item.time - lastSelectedTime >= horizonMs) {
      selected.push(item.origin);
      lastSelectedTime = item.time;
    }
  }
  return selected;
}

function clampProbability(value: number) {
  return Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value));
}

function getPeriodValues(rows: Array<EvaluationRow>, period: "24h" | "48h") {
  return rows.map((row) => ({
    prediction: period === "24h" ? row.probability24h : row.probability48h,
    actual: period === "24h" ? Number(row.actual24h) : Number(row.actual48h),
  }));
}

export function calculateMetric(
  rows: Array<EvaluationRow>,
  period: "24h" | "48h",
): MetricSummary {
  const values = getPeriodValues(rows, period);
  const buckets = [0, 0.2, 0.4, 0.6, 0.8].map((lower) => {
    const upper = lower + 0.2;
    const valuesInBucket = values.filter(({ prediction }) =>
      prediction >= lower && (prediction < upper || (upper === 1 && prediction <= upper)),
    );
    return {
      range: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      lower,
      upper,
      count: valuesInBucket.length,
      averagePrediction: valuesInBucket.length === 0
        ? 0
        : valuesInBucket.reduce((sum, value) => sum + value.prediction, 0) / valuesInBucket.length,
      actualRate: valuesInBucket.length === 0
        ? 0
        : valuesInBucket.reduce((sum, value) => sum + value.actual, 0) / valuesInBucket.length,
    } satisfies CalibrationBucket;
  });

  if (values.length === 0) {
    return {
      count: 0,
      actualRate: 0,
      averagePrediction: 0,
      brier: 0,
      logLoss: 0,
      calibration: buckets,
    };
  }

  return {
    count: values.length,
    actualRate: values.reduce((sum, value) => sum + value.actual, 0) / values.length,
    averagePrediction: values.reduce((sum, value) => sum + value.prediction, 0) / values.length,
    brier: values.reduce((sum, value) => (sum + (value.prediction - value.actual) ** 2), 0) / values.length,
    logLoss: values.reduce((sum, value) => {
      const prediction = clampProbability(value.prediction);
      return sum - (value.actual * Math.log(prediction) + (1 - value.actual) * Math.log(1 - prediction));
    }, 0) / values.length,
    calibration: buckets,
  };
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function calculateBrierDifference(
  candidateRows: Array<EvaluationRow>,
  currentRows: Array<EvaluationRow>,
  period: "24h" | "48h",
) {
  const candidateValues = getPeriodValues(candidateRows, period);
  const currentValues = getPeriodValues(currentRows, period);
  if (candidateValues.length !== currentValues.length || candidateValues.length === 0) return 0;
  return candidateValues.reduce(
    (sum, candidate, index) =>
      sum + (candidate.prediction - candidate.actual) ** 2 -
        (currentValues[index].prediction - currentValues[index].actual) ** 2,
    0,
  ) / candidateValues.length;
}

export function calculateBlockBootstrapDifference(
  candidateRows: Array<EvaluationRow>,
  currentRows: Array<EvaluationRow>,
  period: "24h" | "48h",
  seed: number,
  iterations: number = BOOTSTRAP_ITERATIONS,
): BootstrapSummary {
  if (candidateRows.length !== currentRows.length || candidateRows.length === 0) {
    return { seed, blockDays: BLOCK_DAYS, iterations: 0, lower: 0, median: 0, upper: 0 };
  }

  const sortedCandidate = candidateRows.slice().sort((left, right) => timestamp(left.recordedAt)! - timestamp(right.recordedAt)!);
  const sortedCurrent = currentRows.slice().sort((left, right) => timestamp(left.recordedAt)! - timestamp(right.recordedAt)!);
  const blocks: Array<{ candidate: Array<EvaluationRow>; current: Array<EvaluationRow> }> = [];
  for (let index = 0; index < sortedCandidate.length; index += BLOCK_DAYS) {
    blocks.push({
      candidate: sortedCandidate.slice(index, index + BLOCK_DAYS),
      current: sortedCurrent.slice(index, index + BLOCK_DAYS),
    });
  }

  const random = createSeededRandom(seed);
  const differences: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidateSample: Array<EvaluationRow> = [];
    const currentSample: Array<EvaluationRow> = [];
    while (candidateSample.length < sortedCandidate.length) {
      const block = blocks[Math.floor(random() * blocks.length)];
      candidateSample.push(...block.candidate);
      currentSample.push(...block.current);
    }
    differences.push(calculateBrierDifference(
      candidateSample.slice(0, sortedCandidate.length),
      currentSample.slice(0, sortedCurrent.length),
      period,
    ));
  }

  differences.sort((left, right) => left - right);
  const percentile = (value: number) => {
    const position = (differences.length - 1) * value;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return differences[lower];
    return differences[lower] + (differences[upper] - differences[lower]) * (position - lower);
  };
  return {
    seed,
    blockDays: BLOCK_DAYS,
    iterations,
    lower: percentile(0.025),
    median: percentile(0.5),
    upper: percentile(0.975),
  };
}

export function classifyModelResult(input: {
  brier24h: number;
  brier48h: number;
  currentBrier24h: number;
  currentBrier48h: number;
  bootstrap24h: Pick<BootstrapSummary, "lower" | "upper">;
  bootstrap48h: Pick<BootstrapSummary, "lower" | "upper">;
}): Exclude<ModelClassification, "baseline"> {
  const nonWorse = input.brier24h <= input.currentBrier24h && input.brier48h <= input.currentBrier48h;
  const clearlySeparated = input.bootstrap24h.upper < 0 && input.bootstrap48h.upper < 0;
  if (nonWorse && clearlySeparated) return "clearly_better";

  const worseBoth = input.brier24h > input.currentBrier24h && input.brier48h > input.currentBrier48h;
  const clearlyWorse = input.bootstrap24h.lower > 0 && input.bootstrap48h.lower > 0;
  if (worseBoth && clearlyWorse) return "worse";

  const tinyDifference = Math.max(
    Math.abs(input.brier24h - input.currentBrier24h),
    Math.abs(input.brier48h - input.currentBrier48h),
  ) < 0.01;
  return tinyDifference ? "no_meaningful_difference" : "promising_but_inconclusive";
}

const MODEL_DEFINITIONS: Array<ProbabilityModelDefinition> = [
  {
    modelVersion: ELAPSED_ONLY_MODEL_VERSION,
    halfLifeDays: null,
    kind: "regime_elapsed",
  },
  { modelVersion: SHADOW_PROBABILITY_MODEL_VERSION, halfLifeDays: null, kind: "shadow" },
  { modelVersion: CONSTANT_HAZARD_MODEL_VERSION, halfLifeDays: null, kind: "constant_hazard" },
  { modelVersion: CALIBRATED_V2_MODEL_VERSION, halfLifeDays: null, kind: "prequential_calibrated" },
  ...RECENCY_SHADOW_MODEL_CONFIG
    .map(({ modelVersion, halfLifeDays }) => ({
      modelVersion,
      halfLifeDays,
      kind: "recency" as const,
    })),
];

const BASE_MODEL_DEFINITIONS = MODEL_DEFINITIONS.filter(
  (model) => model.kind !== "prequential_calibrated",
);

function getModelPrediction(
  model: ProbabilityModelDefinition,
  data: ReturnType<typeof getLocalRadarData>,
  origin: Date,
  shadowResult = calculateShadowProbability(data, {
    now: origin,
    staticHistory: LOCAL_RESET_HISTORY,
    regularResetExpectedAt: null,
    activeOfficialNotice: undefined,
    localObservationSignals: getPointInTimeLocalObservationSignals(origin),
  }),
) {
  const options = {
    now: origin,
    staticHistory: LOCAL_RESET_HISTORY,
    regularResetExpectedAt: null,
    activeOfficialNotice: undefined,
    localObservationSignals: getPointInTimeLocalObservationSignals(origin),
  } as const;
  if (model.kind === "shadow") {
    return shadowResult.predictions;
  }
  if (model.kind === "constant_hazard") {
    return calculateConstantHazardBenchmark(shadowResult).predictions;
  }
  if (model.kind === "regime_elapsed") {
    return calculateRegimeElapsedProbability(
      data,
      options,
      PUBLISHED_ELAPSED_MODEL_OPTIONS,
    ).predictions;
  }
  if (model.halfLifeDays !== null) {
    return calculateRecencyWeightedShadowProbability(data, model.halfLifeDays, options).predictions;
  }
  throw new Error(`unsupported direct model prediction: ${model.modelVersion}`);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(metric: MetricSummary) {
  return `n=${metric.count}, actual=${formatPercent(metric.actualRate)}, mean=${formatPercent(metric.averagePrediction)}, Brier=${metric.brier.toFixed(4)}, logLoss=${metric.logLoss.toFixed(4)}`;
}

function formatCalibration(metric: MetricSummary) {
  return metric.calibration
    .map((bucket) => `${bucket.range}: n=${bucket.count}, mean=${formatPercent(bucket.averagePrediction)}, actual=${formatPercent(bucket.actualRate)}`)
    .join("; ");
}

function summarizeLabels(rows: Array<EvaluationRow>): LabelSummary {
  return {
    originCount: rows.length,
    positive24h: rows.filter((row) => row.actual24h).length,
    positive48h: rows.filter((row) => row.actual48h).length,
  };
}

function getBrierDirection(
  candidate: MetricSummary,
  current: MetricSummary,
): "better" | "worse" | "same" | "mixed" {
  const differences = [candidate.brier - current.brier, candidate.logLoss - current.logLoss];
  const hasBetter = differences.some((difference) => difference < 0);
  const hasWorse = differences.some((difference) => difference > 0);
  if (hasBetter && hasWorse) return "mixed";
  if (hasBetter) return "better";
  if (hasWorse) return "worse";
  return "same";
}

function getDiagnosticDirection(
  candidate: ModelEvaluation,
  current: ModelEvaluation,
): "better" | "worse" | "same" | "mixed" {
  return getBrierDirection(candidate.metrics24h, current.metrics24h) === "mixed"
    || getBrierDirection(candidate.metrics48h, current.metrics48h) === "mixed"
    ? "mixed"
    : getBrierDirection(candidate.metrics24h, current.metrics24h) === "better"
      && getBrierDirection(candidate.metrics48h, current.metrics48h) === "better"
      ? "better"
      : getBrierDirection(candidate.metrics24h, current.metrics24h) === "worse"
        && getBrierDirection(candidate.metrics48h, current.metrics48h) === "worse"
        ? "worse"
        : "same";
}

function buildStructureDiagnostic(
  constantHazard: ModelEvaluation,
  current: ModelEvaluation,
  nonOverlappingDirection: "better" | "worse" | "same" | "mixed",
): EvaluationDiagnostics["ageStructure"] {
  if (constantHazard.classification === "clearly_better") {
    return "age_structure_not_supported";
  }
  if (constantHazard.classification === "worse") {
    return "age_structure_supported";
  }
  const dailyDirection = getDiagnosticDirection(constantHazard, current);
  if (dailyDirection === "mixed" || nonOverlappingDirection === "mixed") {
    return "mixed_or_inconclusive";
  }
  return "age_structure_inconclusive";
}

function buildCalibrationDiagnostic(
  calibratedV2: ModelEvaluation,
  current: ModelEvaluation,
  nonOverlappingDirection: "better" | "worse" | "same" | "mixed",
): EvaluationDiagnostics["calibration"] {
  if (calibratedV2.classification === "clearly_better") {
    return "underprediction_calibration_signal";
  }
  if (calibratedV2.classification === "worse") {
    return "calibration_worse";
  }
  const dailyDirection = getDiagnosticDirection(calibratedV2, current);
  if (dailyDirection === "mixed" || nonOverlappingDirection === "mixed") {
    return "mixed_or_inconclusive";
  }
  return "calibration_inconclusive";
}

function writeMarkdown(report: ProbabilityModelEvaluationReport) {
  const lines = [
    "# Probability Model Evaluation",
    "",
    `- asOf: ${report.asOf}`,
    `- Target events: ${report.eventCount}`,
    `- Completed intervals: ${report.completedIntervalCount}`,
    `- Origins: ${report.originCount}`,
    `- Observation period: ${report.observationPeriod.start ?? "unavailable"} to ${report.observationPeriod.end}`,
    `- Non-overlapping 48h origins: ${report.nonOverlapping48hOriginCount}`,
    "",
    "## Models",
    "",
    "| Model | Half-life | Classification | 24h Brier | 48h Brier |",
    "| --- | ---: | --- | ---: | ---: |",
  ];
  for (const model of report.models) {
    lines.push(`| ${model.modelVersion} | ${model.halfLifeDays ?? "none"} | ${model.classification} | ${model.metrics24h.brier.toFixed(4)} | ${model.metrics48h.brier.toFixed(4)} |`);
  }

  lines.push("", "## Metrics", "");
  for (const model of report.models) {
    lines.push(`### ${model.modelVersion}`, "", `- 24h: ${formatMetric(model.metrics24h)}`, `- 48h: ${formatMetric(model.metrics48h)}`);
    lines.push(`- 24h calibration: ${formatCalibration(model.metrics24h)}`);
    lines.push(`- 48h calibration: ${formatCalibration(model.metrics48h)}`);
    if (model.differenceVsCurrent) {
      const difference = model.differenceVsCurrent;
      lines.push(
        `- Difference vs current Brier: 24h ${(difference.brier24h >= 0 ? "+" : "") + difference.brier24h.toFixed(4)}, 48h ${(difference.brier48h >= 0 ? "+" : "") + difference.brier48h.toFixed(4)}`,
        `- 24h block bootstrap 95% CI: [${difference.bootstrap24h.lower.toFixed(4)}, ${difference.bootstrap24h.upper.toFixed(4)}]`,
        `- 48h block bootstrap 95% CI: [${difference.bootstrap48h.lower.toFixed(4)}, ${difference.bootstrap48h.upper.toFixed(4)}]`,
      );
    }
    lines.push(`- Non-overlapping 48h: ${formatMetric(model.nonOverlapping48h)}`);
    if (model.nonOverlapping48hDifferenceVsCurrent) {
      lines.push(
        `- Non-overlapping 48h difference vs public model: Brier ${(model.nonOverlapping48hDifferenceVsCurrent.brier >= 0 ? "+" : "") + model.nonOverlapping48hDifferenceVsCurrent.brier.toFixed(4)}, logLoss ${(model.nonOverlapping48hDifferenceVsCurrent.logLoss >= 0 ? "+" : "") + model.nonOverlapping48hDifferenceVsCurrent.logLoss.toFixed(4)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Diagnostics",
    "",
    `- Age structure: ${report.diagnostics.ageStructure}`,
    `- Calibration: ${report.diagnostics.calibration}`,
    `- Constant hazard daily comparison: ${report.diagnostics.constantHazardClassification}`,
    `- Calibrated v2 daily comparison: ${report.diagnostics.calibratedV2Classification}`,
    `- Non-overlapping 48h direction: constant=${report.diagnostics.nonOverlapping48h.constantHazardDirection}, calibrated=${report.diagnostics.nonOverlapping48h.calibratedV2Direction}`,
    "",
    "## Label and event contribution",
    "",
    `- Daily labels: 24h positive=${report.labelSummary.positive24h}/${report.labelSummary.originCount}, 48h positive=${report.labelSummary.positive48h}/${report.labelSummary.originCount}`,
    `- Non-overlapping 48h labels: positive=${report.nonOverlapping48hLabelSummary.positive48h}/${report.nonOverlapping48hLabelSummary.originCount}`,
    "",
    "| Event | Reset at | Positive daily origins (24h) | Positive daily origins (48h) |",
    "| --- | --- | ---: | ---: |",
    ...report.eventContributions.map((contribution) =>
      `| ${contribution.eventId} | ${contribution.resetAt} | ${contribution.positiveOrigins24h} | ${contribution.positiveOrigins48h} |`,
    ),
    "",
    "## Prequential calibration",
    "",
    `- Prior: Normal(0, ${report.prequentialCalibration.priorStdDev}^2)` ,
    `- Minimum samples: ${report.prequentialCalibration.minimumSamples}`,
    `- Final audit: ${report.prequentialCalibration.final
      ? `alpha24h=${report.prequentialCalibration.final.alpha24h.toFixed(6)}, alpha48h=${report.prequentialCalibration.final.alpha48h.toFixed(6)}, samples24h=${report.prequentialCalibration.final.calibrationSampleCount24h}, samples48h=${report.prequentialCalibration.final.calibrationSampleCount48h}`
      : "unavailable"}`,
    "",
    "## Notes",
    "",
    `- ${report.notes.join("\n- ")}`,
    "- Daily evaluation origins overlap, so daily metric differences are not independent.",
    "- The non-overlapping 48h section is a lower-sample reference analysis.",
    `- This historical comparison uses ${ELAPSED_ONLY_MODEL_VERSION}; the calibrated public model is evaluated only from prospective prediction_history rows. ${SHADOW_PROBABILITY_MODEL_VERSION} remains the unweighted comparison baseline.`,
    "- Benchmark results do not change API responses, UI, DTOs, Supabase, or stored Shadow forecasts.",
    "- No automatic winner is selected from an inconclusive result.",
  );
  return `${lines.join("\n")}\n`;
}

export function evaluateProbabilityModels(asOf: Date = new Date(LOCAL_MODEL_UPDATED_AT)) {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const asOfIso = asOf.toISOString();
  const allEvents = getShadowCompletedResetEvents(null, asOf, LOCAL_RESET_HISTORY);
  const origins = createWalkForwardOrigins(allEvents, asOfIso);
  const nonOverlapping48hOrigins = selectNonOverlappingOrigins(origins, 48);
  const nonOverlappingOriginSet = new Set(nonOverlapping48hOrigins);
  const rowsByModel = new Map<string, Array<EvaluationRow>>(
    MODEL_DEFINITIONS.map((model) => [model.modelVersion, []]),
  );
  const prequentialCalibrationAudits: Array<PrequentialCalibrationAudit> = [];
  const sourceData = getLocalRadarData({ calculationNow: asOf });

  for (const recordedAt of origins) {
    const origin = new Date(recordedAt);
    const data = getPointInTimeRadarData(sourceData, origin) ?? getLocalRadarData({ calculationNow: origin });
    const actual24h = getActualWithinHorizon(allEvents, recordedAt, 24);
    const actual48h = getActualWithinHorizon(allEvents, recordedAt, 48);
    const previousBaseRows = rowsByModel.get(SHADOW_PROBABILITY_MODEL_VERSION)!.slice();
    const shadow = calculateShadowProbability(data, {
      now: origin,
      staticHistory: LOCAL_RESET_HISTORY,
      regularResetExpectedAt: null,
      activeOfficialNotice: undefined,
      localObservationSignals: getPointInTimeLocalObservationSignals(origin),
    });

    for (const model of BASE_MODEL_DEFINITIONS) {
      const prediction = getModelPrediction(model, data, origin, shadow);
      rowsByModel.get(model.modelVersion)!.push({
        recordedAt,
        probability24h: prediction.probability24h,
        probability48h: prediction.probability48h,
        actual24h,
        actual48h,
      });
    }

    const currentBaseRow = rowsByModel.get(SHADOW_PROBABILITY_MODEL_VERSION)!.at(-1)!;
    const calibrationAudit = calculatePrequentialLogitCalibration(currentBaseRow, previousBaseRows);
    prequentialCalibrationAudits.push(calibrationAudit);
    rowsByModel.get(CALIBRATED_V2_MODEL_VERSION)!.push({
      recordedAt,
      probability24h: calibrationAudit.calibratedProbability24h,
      probability48h: calibrationAudit.calibratedProbability48h,
      actual24h,
      actual48h,
    });
  }

  const currentRows = rowsByModel.get(ELAPSED_ONLY_MODEL_VERSION) ?? [];
  const currentNonOverlappingRows = currentRows.filter((row) => nonOverlappingOriginSet.has(row.recordedAt));
  const current24h = calculateMetric(currentRows, "24h");
  const current48h = calculateMetric(currentRows, "48h");
  const currentNonOverlapping48h = calculateMetric(currentNonOverlappingRows, "48h");
  const models = MODEL_DEFINITIONS.map((model): ModelEvaluation => {
    const rows = rowsByModel.get(model.modelVersion) ?? [];
    const nonOverlappingRows = rows.filter((row) => nonOverlappingOriginSet.has(row.recordedAt));
    const metrics24h = calculateMetric(rows, "24h");
    const metrics48h = calculateMetric(rows, "48h");
    const nonOverlapping48h = calculateMetric(nonOverlappingRows, "48h");
    if (model.modelVersion === ELAPSED_ONLY_MODEL_VERSION) {
      return {
        modelVersion: model.modelVersion,
        halfLifeDays: model.halfLifeDays,
        kind: model.kind,
        classification: "baseline",
        metrics24h,
        metrics48h,
        nonOverlapping48h,
        differenceVsCurrent: null,
        nonOverlapping48hDifferenceVsCurrent: null,
      };
    }
    const bootstrap24h = calculateBlockBootstrapDifference(rows, currentRows, "24h", BOOTSTRAP_SEED);
    const bootstrap48h = calculateBlockBootstrapDifference(rows, currentRows, "48h", BOOTSTRAP_SEED);
    return {
      modelVersion: model.modelVersion,
      halfLifeDays: model.halfLifeDays,
      kind: model.kind,
      classification: classifyModelResult({
        brier24h: metrics24h.brier,
        brier48h: metrics48h.brier,
        currentBrier24h: current24h.brier,
        currentBrier48h: current48h.brier,
        bootstrap24h,
        bootstrap48h,
      }),
      metrics24h,
      metrics48h,
      nonOverlapping48h,
      differenceVsCurrent: {
        brier24h: metrics24h.brier - current24h.brier,
        brier48h: metrics48h.brier - current48h.brier,
        logLoss24h: metrics24h.logLoss - current24h.logLoss,
        logLoss48h: metrics48h.logLoss - current48h.logLoss,
        bootstrap24h,
        bootstrap48h,
      },
      nonOverlapping48hDifferenceVsCurrent: {
        brier: nonOverlapping48h.brier - currentNonOverlapping48h.brier,
        logLoss: nonOverlapping48h.logLoss - currentNonOverlapping48h.logLoss,
      },
    };
  });

  const currentModel = models.find((model) => model.modelVersion === ELAPSED_ONLY_MODEL_VERSION)!;
  const constantHazardModel = models.find((model) => model.modelVersion === CONSTANT_HAZARD_MODEL_VERSION)!;
  const calibratedV2Model = models.find((model) => model.modelVersion === CALIBRATED_V2_MODEL_VERSION)!;
  const constantDirection = getBrierDirection(constantHazardModel.nonOverlapping48h, currentModel.nonOverlapping48h);
  const calibratedDirection = getBrierDirection(calibratedV2Model.nonOverlapping48h, currentModel.nonOverlapping48h);
  const labelSummary = summarizeLabels(currentRows);
  const nonOverlapping48hLabelSummary = summarizeLabels(currentNonOverlappingRows);
  const report: ProbabilityModelEvaluationReport = {
    schemaVersion: "probability-model-evaluation-v2",
    asOf: asOfIso,
    generatedAt: asOfIso,
    targetDefinition: SHADOW_TARGET_DEFINITION,
    eventCount: allEvents.length,
    completedIntervalCount: Math.max(0, allEvents.length - 1),
    observationPeriod: {
      start: allEvents[0]?.resetAt ?? null,
      end: asOfIso,
    },
    originCount: origins.length,
    origins,
    nonOverlapping48hOriginCount: nonOverlapping48hOrigins.length,
    nonOverlapping48hOrigins,
    labelSummary,
    nonOverlapping48hLabelSummary,
    eventContributions: calculateEventContributions(allEvents, origins),
    models,
    prequentialCalibration: {
      priorStdDev: PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
      minimumSamples: PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
      origins: prequentialCalibrationAudits,
      final: prequentialCalibrationAudits.at(-1) ?? null,
    },
    diagnostics: {
      ageStructure: buildStructureDiagnostic(
        constantHazardModel,
        currentModel,
        constantDirection,
      ),
      calibration: buildCalibrationDiagnostic(
        calibratedV2Model,
        currentModel,
        calibratedDirection,
      ),
      constantHazardClassification: constantHazardModel.classification as Exclude<ModelClassification, "baseline">,
      calibratedV2Classification: calibratedV2Model.classification as Exclude<ModelClassification, "baseline">,
      nonOverlapping48h: {
        constantHazardDirection: constantDirection,
        calibratedV2Direction: calibratedDirection,
      },
    },
    notes: [
      "Models use the same target event definition and signal multiplier path as the public probability model.",
      "The constant hazard benchmark uses the v2 global lambda and censored exposure without age bins.",
      "Prequential calibration uses only pastOrigin + horizon <= currentOrigin, a fixed Normal(0, 0.5^2) prior, and a minimum of 10 confirmed samples.",
      `The fixed bootstrap seed is ${BOOTSTRAP_SEED} with ${BLOCK_DAYS}-day blocks and ${BOOTSTRAP_ITERATIONS} iterations for overlapping daily comparisons.`,
      `There are ${allEvents.length} target events and ${Math.max(0, allEvents.length - 1)} completed intervals available as of ${asOfIso}.`,
      "Benchmark models are evaluation-only and are not written to experimentalProbabilityForecasts or used by the public model.",
    ],
  };
  return report;
}

export function writeProbabilityModelEvaluationReports(
  report: ProbabilityModelEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, `${PROBABILITY_MODEL_EVALUATION_REPORT_BASENAME}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, `${PROBABILITY_MODEL_EVALUATION_REPORT_BASENAME}.md`),
    writeMarkdown(report),
    "utf8",
  );
}

function parseAsOf(args: Array<string>) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : LOCAL_MODEL_UPDATED_AT;
  if (!value) throw new Error("--as-of requires an ISO timestamp");
  const asOf = new Date(value);
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

function main() {
  const report = evaluateProbabilityModels(parseAsOf(process.argv.slice(2)));
  writeProbabilityModelEvaluationReports(report);
  console.log(JSON.stringify({
    asOf: report.asOf,
    eventCount: report.eventCount,
    completedIntervalCount: report.completedIntervalCount,
    originCount: report.originCount,
    models: report.models.map((model) => ({
      modelVersion: model.modelVersion,
      classification: model.classification,
      brier24h: model.metrics24h.brier,
      brier48h: model.metrics48h.brier,
      differenceVsCurrent: model.differenceVsCurrent,
    })),
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateProbabilityModels.ts") {
  main();
}
