import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  LOCAL_MODEL_UPDATED_AT,
  LOCAL_RESET_HISTORY,
} from "../data/resetHistory";
import {
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import {
  buildShadowHazard,
  calculateShadowProbability,
  getShadowCompletedResetEvents,
  type ShadowProbabilityHorizons,
} from "../lib/radar/shadowProbability";
import {
  BOUNDARY_CENSORED_MODEL_VERSION,
  calculateBoundaryCensoredProbability,
  collectBoundaryCensoredBoundaries,
  getBoundaryCensoredHorizonOutcome,
  type BoundaryRegularAudit,
} from "../lib/radar/boundaryCensoredProbability";
import { getCompletedResetTimestamp } from "../lib/radar/probability";
import type { WindowEventLike } from "../lib/radar/types";
import {
  calculateMetric,
  createWalkForwardOrigins,
  type EvaluationRow,
  type MetricSummary,
} from "./evaluateProbabilityModels";
import { getPointInTimeLocalObservationSignals } from "../lib/radar/calibratedShadowProbability";
import { getPointInTimeRadarData } from "../lib/radar/prequentialCalibration";

export const BOUNDARY_CENSORED_REPORT_BASENAME = "probability-model-evaluation-boundary-censored";
export const BOUNDARY_CENSORED_REPORT_SCHEMA = "boundary-censored-evaluation-v1" as const;

type Horizon = 24 | 48;

export type CensoredMetricSummary = {
  scoredCount: number;
  censoredCount: number;
  metric: MetricSummary;
};

export type BoundaryCensoredModelEvaluation = {
  modelVersion: string;
  classification: "baseline" | "better" | "worse" | "mixed" | "same";
  metrics24h: CensoredMetricSummary;
  metrics48h: CensoredMetricSummary;
  differenceVsCurrent: {
    brier24h: number;
    brier48h: number;
    logLoss24h: number;
    logLoss48h: number;
  } | null;
};

export type BoundaryCensoredProbabilityEvaluationReport = {
  schemaVersion: typeof BOUNDARY_CENSORED_REPORT_SCHEMA;
  evaluationMethod: "walk_forward_prequential";
  asOf: string;
  generatedAt: string;
  currentModelVersion: string;
  candidateModelVersion: typeof BOUNDARY_CENSORED_MODEL_VERSION;
  targetDefinition: string;
  eventCount: number;
  boundaryCount: number;
  acceptedRegularBoundaries: BoundaryRegularAudit[];
  excludedRegularBoundaries: BoundaryRegularAudit[];
  intervalSummary: {
    currentCompletedEventIntervalCount: number;
    currentTotalExposureDays: number;
    candidateCompletedEventIntervalCount: number;
    candidateCensoredIntervalCount: number;
    candidateTotalExposureDays: number;
    candidateCurrentRightCensoredHours: number;
  };
  originCount: number;
  origins: string[];
  models: {
    current: BoundaryCensoredModelEvaluation;
    candidate: BoundaryCensoredModelEvaluation;
  };
  fixedTimeComparison: {
    at: string;
    lastRandomResetAt: string | null;
    lastBoundaryAt: string | null;
    currentAgeHours: number;
    candidateAgeHours: number;
    current: ShadowProbabilityHorizons;
    candidate: ShadowProbabilityHorizons;
    difference: ShadowProbabilityHorizons;
  };
  notes: string[];
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function historyThroughOrigin(history: Array<WindowEventLike>, origin: Date) {
  const originTime = origin.getTime();
  return history.filter((item) => {
    const completedAt = getCompletedResetTimestamp(item);
    return completedAt !== null && completedAt <= originTime;
  });
}

function predictionOptions(origin: Date, staticHistory: Array<WindowEventLike>) {
  return {
    now: origin,
    staticHistory,
    regularResetExpectedAt: null,
    activeOfficialNotice: undefined,
    localObservationSignals: getPointInTimeLocalObservationSignals(origin),
  } as const;
}

function createHorizonRow(
  origin: string,
  horizon: Horizon,
  probability: number,
  actual: boolean,
): EvaluationRow {
  return {
    recordedAt: origin,
    probability24h: horizon === 24 ? probability : 0,
    probability48h: horizon === 48 ? probability : 0,
    actual24h: horizon === 24 ? actual : false,
    actual48h: horizon === 48 ? actual : false,
  };
}

function summarizeHorizon(
  rows: Array<EvaluationRow>,
  censoredCount: number,
  horizon: Horizon,
): CensoredMetricSummary {
  return {
    scoredCount: rows.length,
    censoredCount,
    metric: calculateMetric(rows, horizon === 24 ? "24h" : "48h"),
  };
}

function classifyCandidate(
  current: { metrics24h: CensoredMetricSummary; metrics48h: CensoredMetricSummary },
  candidate: { metrics24h: CensoredMetricSummary; metrics48h: CensoredMetricSummary },
): BoundaryCensoredModelEvaluation["classification"] {
  const differences = [
    candidate.metrics24h.metric.brier - current.metrics24h.metric.brier,
    candidate.metrics48h.metric.brier - current.metrics48h.metric.brier,
    candidate.metrics24h.metric.logLoss - current.metrics24h.metric.logLoss,
    candidate.metrics48h.metric.logLoss - current.metrics48h.metric.logLoss,
  ];
  const hasBetter = differences.some((difference) => difference < 0);
  const hasWorse = differences.some((difference) => difference > 0);
  if (!hasBetter && !hasWorse) return "same";
  if (hasBetter && !hasWorse) return "better";
  if (hasWorse && !hasBetter) return "worse";
  return "mixed";
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(value: CensoredMetricSummary) {
  return `scored=${value.scoredCount}, censored=${value.censoredCount}, Brier=${value.metric.brier.toFixed(4)}, logLoss=${value.metric.logLoss.toFixed(4)}`;
}

function formatAudit(audit: BoundaryRegularAudit) {
  return `| ${audit.id} | ${audit.resetAt ?? "unknown"} | ${audit.recordKind ?? "unknown"} | ${audit.scope ?? "unknown"} | ${audit.included ? "yes" : "no"} | ${audit.reason} |`;
}

function writeMarkdown(report: BoundaryCensoredProbabilityEvaluationReport) {
  const candidate = report.models.candidate;
  const current = report.models.current;
  const lines = [
    "# Random Boundary-Censored Probability Evaluation",
    "",
    `- Evaluation: ${report.evaluationMethod} (no backfill; future boundaries are used only for censor-aware labels)`,
    `- asOf: ${report.asOf}`,
    `- Current model: ${report.currentModelVersion}`,
    `- Candidate model: ${report.candidateModelVersion}`,
    `- Random event count: ${report.eventCount}`,
    `- Boundary count: ${report.boundaryCount}`,
    `- Origins: ${report.originCount}`,
    "",
    "## Interval construction",
    "",
    `- Current event intervals: ${report.intervalSummary.currentCompletedEventIntervalCount}`,
    `- Current exposure days: ${report.intervalSummary.currentTotalExposureDays.toFixed(2)}`,
    `- Candidate event intervals: ${report.intervalSummary.candidateCompletedEventIntervalCount}`,
    `- Candidate censored intervals: ${report.intervalSummary.candidateCensoredIntervalCount}`,
    `- Candidate exposure days: ${report.intervalSummary.candidateTotalExposureDays.toFixed(2)}`,
    `- Candidate current right-censored hours: ${report.intervalSummary.candidateCurrentRightCensoredHours.toFixed(2)}`,
    "",
    "## Regular boundaries",
    "",
    "| ID | Reset at | Record kind | Scope | Included | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.acceptedRegularBoundaries.map(formatAudit),
    ...report.excludedRegularBoundaries.map(formatAudit),
    "",
    "## Evaluation",
    "",
    `- Current 24h: ${formatMetric(current.metrics24h)}`,
    `- Candidate 24h: ${formatMetric(candidate.metrics24h)}`,
    `- Current 48h: ${formatMetric(current.metrics48h)}`,
    `- Candidate 48h: ${formatMetric(candidate.metrics48h)}`,
    `- Candidate classification: ${candidate.classification}`,
    `- Brier difference (candidate-current): 24h ${candidate.differenceVsCurrent?.brier24h.toFixed(4) ?? "n/a"}, 48h ${candidate.differenceVsCurrent?.brier48h.toFixed(4) ?? "n/a"}`,
    `- Log loss difference (candidate-current): 24h ${candidate.differenceVsCurrent?.logLoss24h.toFixed(4) ?? "n/a"}, 48h ${candidate.differenceVsCurrent?.logLoss48h.toFixed(4) ?? "n/a"}`,
    "",
    "## Fixed-time comparison",
    "",
    `- At: ${report.fixedTimeComparison.at}`,
    `- Last random reset: ${report.fixedTimeComparison.lastRandomResetAt ?? "none"}`,
    `- Last broad boundary: ${report.fixedTimeComparison.lastBoundaryAt ?? "none"}`,
    `- Current age: ${report.fixedTimeComparison.currentAgeHours.toFixed(2)}h`,
    `- Candidate age: ${report.fixedTimeComparison.candidateAgeHours.toFixed(2)}h`,
    `- Current 12h / 24h / 48h / 72h: ${formatPercent(report.fixedTimeComparison.current.probability12h)} / ${formatPercent(report.fixedTimeComparison.current.probability24h)} / ${formatPercent(report.fixedTimeComparison.current.probability48h)} / ${formatPercent(report.fixedTimeComparison.current.probability72h)}`,
    `- Candidate 12h / 24h / 48h / 72h: ${formatPercent(report.fixedTimeComparison.candidate.probability12h)} / ${formatPercent(report.fixedTimeComparison.candidate.probability24h)} / ${formatPercent(report.fixedTimeComparison.candidate.probability48h)} / ${formatPercent(report.fixedTimeComparison.candidate.probability72h)}`,
    `- Difference (candidate-current): ${formatPercent(report.fixedTimeComparison.difference.probability12h)} / ${formatPercent(report.fixedTimeComparison.difference.probability24h)} / ${formatPercent(report.fixedTimeComparison.difference.probability48h)} / ${formatPercent(report.fixedTimeComparison.difference.probability72h)}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

function getModelEvaluation(
  modelVersion: string,
  rows24h: Array<EvaluationRow>,
  censored24h: number,
  rows48h: Array<EvaluationRow>,
  censored48h: number,
  classification: BoundaryCensoredModelEvaluation["classification"],
  differenceVsCurrent: BoundaryCensoredModelEvaluation["differenceVsCurrent"],
): BoundaryCensoredModelEvaluation {
  return {
    modelVersion,
    classification,
    metrics24h: summarizeHorizon(rows24h, censored24h, 24),
    metrics48h: summarizeHorizon(rows48h, censored48h, 48),
    differenceVsCurrent,
  };
}

export function evaluateBoundaryCensoredProbability(
  asOf: Date = new Date(LOCAL_MODEL_UPDATED_AT),
): BoundaryCensoredProbabilityEvaluationReport {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("asOf must be a valid date");
  const asOfIso = asOf.toISOString();
  const sourceData = getLocalRadarData({ calculationNow: asOf });
  const allRandomEvents = getShadowCompletedResetEvents(null, asOf, LOCAL_RESET_HISTORY);
  const collection = collectBoundaryCensoredBoundaries(null, asOf, LOCAL_RESET_HISTORY);
  const origins = createWalkForwardOrigins(allRandomEvents, asOfIso);
  const currentRows24h: EvaluationRow[] = [];
  const currentRows48h: EvaluationRow[] = [];
  const candidateRows24h: EvaluationRow[] = [];
  const candidateRows48h: EvaluationRow[] = [];
  let censored24h = 0;
  let censored48h = 0;

  for (const recordedAt of origins) {
    const origin = new Date(recordedAt);
    const data = getPointInTimeRadarData(sourceData, origin) ?? getLocalRadarData({ calculationNow: origin });
    const staticHistory = historyThroughOrigin(LOCAL_RESET_HISTORY, origin);
    const options = predictionOptions(origin, staticHistory);
    const current = calculateShadowProbability(data, options);
    const candidate = calculateBoundaryCensoredProbability(data, options);
    const outcome24h = getBoundaryCensoredHorizonOutcome(collection.boundaries, origin, 24);
    const outcome48h = getBoundaryCensoredHorizonOutcome(collection.boundaries, origin, 48);

    if (outcome24h === "censored") {
      censored24h += 1;
    } else {
      const actual = outcome24h === "event";
      currentRows24h.push(createHorizonRow(recordedAt, 24, current.predictions.probability24h, actual));
      candidateRows24h.push(createHorizonRow(recordedAt, 24, candidate.predictions.probability24h, actual));
    }
    if (outcome48h === "censored") {
      censored48h += 1;
    } else {
      const actual = outcome48h === "event";
      currentRows48h.push(createHorizonRow(recordedAt, 48, current.predictions.probability48h, actual));
      candidateRows48h.push(createHorizonRow(recordedAt, 48, candidate.predictions.probability48h, actual));
    }
  }

  const currentMetrics = {
    metrics24h: summarizeHorizon(currentRows24h, censored24h, 24),
    metrics48h: summarizeHorizon(currentRows48h, censored48h, 48),
  };
  const candidateMetrics = {
    metrics24h: summarizeHorizon(candidateRows24h, censored24h, 24),
    metrics48h: summarizeHorizon(candidateRows48h, censored48h, 48),
  };
  const currentModelEvaluation = getModelEvaluation(
    SHADOW_PROBABILITY_MODEL_VERSION,
    currentRows24h,
    censored24h,
    currentRows48h,
    censored48h,
    "baseline",
    null,
  );
  const candidateClassification = classifyCandidate(currentMetrics, candidateMetrics);
  const candidateModelEvaluation = getModelEvaluation(
    BOUNDARY_CENSORED_MODEL_VERSION,
    candidateRows24h,
    censored24h,
    candidateRows48h,
    censored48h,
    candidateClassification,
    {
      brier24h: candidateMetrics.metrics24h.metric.brier - currentMetrics.metrics24h.metric.brier,
      brier48h: candidateMetrics.metrics48h.metric.brier - currentMetrics.metrics48h.metric.brier,
      logLoss24h: candidateMetrics.metrics24h.metric.logLoss - currentMetrics.metrics24h.metric.logLoss,
      logLoss48h: candidateMetrics.metrics48h.metric.logLoss - currentMetrics.metrics48h.metric.logLoss,
    },
  );

  const currentFixed = calculateShadowProbability(sourceData, {
    now: asOf,
    staticHistory: LOCAL_RESET_HISTORY,
    activeOfficialNotice: undefined,
    regularResetExpectedAt: null,
    localObservationSignals: getPointInTimeLocalObservationSignals(asOf),
  });
  const candidateFixed = calculateBoundaryCensoredProbability(sourceData, {
    now: asOf,
    staticHistory: LOCAL_RESET_HISTORY,
    activeOfficialNotice: undefined,
    regularResetExpectedAt: null,
    localObservationSignals: getPointInTimeLocalObservationSignals(asOf),
  });
  const fixedDifference = {
    probability12h: candidateFixed.predictions.probability12h - currentFixed.predictions.probability12h,
    probability24h: candidateFixed.predictions.probability24h - currentFixed.predictions.probability24h,
    probability48h: candidateFixed.predictions.probability48h - currentFixed.predictions.probability48h,
    probability72h: candidateFixed.predictions.probability72h - currentFixed.predictions.probability72h,
  };
  const currentHazard = buildShadowHazard(allRandomEvents, asOf);
  const lastRandomResetAt = allRandomEvents.at(-1)?.resetAt ?? null;
  const lastRandomResetTime = timestamp(lastRandomResetAt);

  return {
    schemaVersion: BOUNDARY_CENSORED_REPORT_SCHEMA,
    evaluationMethod: "walk_forward_prequential",
    asOf: asOfIso,
    generatedAt: asOfIso,
    currentModelVersion: currentModelEvaluation.modelVersion,
    candidateModelVersion: BOUNDARY_CENSORED_MODEL_VERSION,
    targetDefinition: "The current random-inclusive target definition is used for events; regular boundaries are not target events.",
    eventCount: collection.randomEvents.length,
    boundaryCount: collection.boundaries.length,
    acceptedRegularBoundaries: collection.acceptedRegularAudits,
    excludedRegularBoundaries: collection.excludedRegularBoundaries,
    intervalSummary: {
      currentCompletedEventIntervalCount: currentHazard.completedIntervalCount,
      currentTotalExposureDays: currentHazard.totalExposureDays,
      candidateCompletedEventIntervalCount: candidateFixed.hazard.completedEventIntervalCount,
      candidateCensoredIntervalCount: candidateFixed.hazard.censoredIntervalCount,
      candidateTotalExposureDays: candidateFixed.hazard.totalExposureDays,
      candidateCurrentRightCensoredHours: candidateFixed.hazard.currentRightCensoredHours,
    },
    originCount: origins.length,
    origins,
    models: {
      current: currentModelEvaluation,
      candidate: candidateModelEvaluation,
    },
    fixedTimeComparison: {
      at: asOfIso,
      lastRandomResetAt: candidateFixed.audit.lastRandomResetAt,
      lastBoundaryAt: candidateFixed.audit.lastBoundaryAt,
      currentAgeHours: lastRandomResetTime === null
        ? 0
        : Math.max(0, (asOf.getTime() - lastRandomResetTime) / (60 * 60 * 1000)),
      candidateAgeHours: candidateFixed.audit.currentAgeHours,
      current: {
        probability12h: currentFixed.predictions.probability12h,
        probability24h: currentFixed.predictions.probability24h,
        probability48h: currentFixed.predictions.probability48h,
        probability72h: currentFixed.predictions.probability72h,
      },
      candidate: candidateFixed.predictions,
      difference: fixedDifference,
    },
    notes: [
      "The candidate treats each accepted broad regular reset as a boundary and right-censors the interval at that boundary without incrementing random event count.",
      "A regular boundary inside a scored horizon is censored rather than scored as a simple negative; current and candidate use the same scored origins.",
      "The model calculations use only history available at each origin; future records are used only to create censor-aware evaluation labels.",
      `The public model is ${PUBLISHED_PROBABILITY_MODEL_VERSION}; this report compares the boundary candidate with the unweighted ${SHADOW_PROBABILITY_MODEL_VERSION} baseline.`,
    ],
  };
}

export function writeBoundaryCensoredReports(
  report: BoundaryCensoredProbabilityEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, `${BOUNDARY_CENSORED_REPORT_BASENAME}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, `${BOUNDARY_CENSORED_REPORT_BASENAME}.md`),
    writeMarkdown(report),
    "utf8",
  );
}

function parseAsOf(args: string[]) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : LOCAL_MODEL_UPDATED_AT;
  if (!value) throw new Error("--as-of requires an ISO timestamp");
  const asOf = new Date(value);
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

function main() {
  const report = evaluateBoundaryCensoredProbability(parseAsOf(process.argv.slice(2)));
  writeBoundaryCensoredReports(report);
  console.log(JSON.stringify({
    asOf: report.asOf,
    eventCount: report.eventCount,
    boundaryCount: report.boundaryCount,
    originCount: report.originCount,
    candidateClassification: report.models.candidate.classification,
    current24hBrier: report.models.current.metrics24h.metric.brier,
    candidate24hBrier: report.models.candidate.metrics24h.metric.brier,
    current48hBrier: report.models.current.metrics48h.metric.brier,
    candidate48hBrier: report.models.candidate.metrics48h.metric.brier,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateBoundaryCensoredProbability.ts") {
  main();
}
