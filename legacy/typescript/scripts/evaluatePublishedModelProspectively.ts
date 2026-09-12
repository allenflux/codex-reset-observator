import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
} from "../data/shadowProbabilityConfig";
import {
  getShadowCompletedResetEvents,
  type ShadowResetEvent,
} from "../lib/radar/shadowProbability";
import {
  calculateNextGenerationSelectiveCalibrationProbability,
  calculateNextGenerationV3Probability,
  type NextGenerationBCalculationOptions,
  type NextGenerationBResult,
  type NextGenerationCalibrationRow,
} from "../lib/radar/nextGenerationProbability";
import type { RadarData } from "../lib/radar";
import { getActualWithinHorizon, getPointInTimeRadarData } from "../lib/radar/prequentialCalibration";
import {
  evaluatePublishedModelProspectively,
  buildSavedArtifactHybridForecast,
  PROSPECTIVE_PUBLISHED_ACTIVE_MODEL_VERSION,
  PROSPECTIVE_PUBLISHED_BASELINE_MODEL_VERSION,
  selectDailyFirstPublishedForecasts,
  selectDailyFirstForecastsForModelPair,
  formatPublishedProspectiveMetric,
  type PublishedProspectiveEvaluationReport,
} from "../lib/radar/prospectivePublishedModelEvaluation";
import {
  readPublishedV3FeatureSnapshot,
  type PublishedV3FeatureSnapshot,
} from "../lib/radar/publishedV3FeatureSnapshot";
import type { PublishedV3ScoreboardFeature } from "../lib/radar/prospectiveV3Scoreboard";
import type { ProspectiveForecastRow, ProspectiveStoredForecast } from "../lib/radar/prospectiveProbabilityEvaluation";
import {
  loadProductionCanonicalRadarData,
  loadPredictionHistoryRows,
} from "./evaluateProspectiveProbabilityForecasts";

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // Missing or unsupported local env files are reported as insufficient data.
  }
}

function parseAsOf(args: Array<string>) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : undefined;
  const asOf = value ? new Date(value) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

function formatPostResetDiagnosticMetric(metric: PublishedProspectiveEvaluationReport["postResetDiagnostic"]["metrics24h"]) {
  const value = (number: number | null) => number === null ? "unavailable" : number.toFixed(4);
  return [
    `n=${metric.sampleCount}`,
    `positive=${metric.positiveCount}`,
    `activeMean=${value(metric.activeMeanPrediction)}`,
    `baselineMean=${value(metric.baselineMeanPrediction)}`,
    `activeBrier=${value(metric.activeBrier)}`,
    `baselineBrier=${value(metric.baselineBrier)}`,
    `brierDelta=${value(metric.brierDelta)}`,
    `activeLogLoss=${value(metric.activeLogLoss)}`,
    `baselineLogLoss=${value(metric.baselineLogLoss)}`,
    `logLossDelta=${value(metric.logLossDelta)}`,
    `meanProbabilityDelta=${value(metric.meanProbabilityDelta)}`,
  ].join(", ");
}

function formatUnifiedSeries(
  name: string,
  series: PublishedProspectiveEvaluationReport["unifiedComparison"]["series"][keyof PublishedProspectiveEvaluationReport["unifiedComparison"]["series"]],
) {
  return [
    `### ${name}`,
    `- Source: ${series.source}`,
    `- 24h: ${formatPublishedProspectiveMetric(series.metrics24h)}`,
    `- 48h: ${formatPublishedProspectiveMetric(series.metrics48h)}`,
  ];
}

function formatUnifiedSubset(
  name: string,
  subset: PublishedProspectiveEvaluationReport["unifiedComparison"]["subsets"][keyof PublishedProspectiveEvaluationReport["unifiedComparison"]["subsets"]],
) {
  return [
    `### ${name}`,
    `- Origins: ${subset.originCount}`,
    `- 24h v2: ${formatPublishedProspectiveMetric(subset.series.currentV2.metrics24h)}`,
    `- 24h fully uncalibrated: ${formatPublishedProspectiveMetric(subset.series.v3.metrics24h)}`,
    `- 24h hybrid: ${formatPublishedProspectiveMetric(subset.series.hybrid.metrics24h)}`,
    `- 48h v2: ${formatPublishedProspectiveMetric(subset.series.currentV2.metrics48h)}`,
    `- 48h fully uncalibrated: ${formatPublishedProspectiveMetric(subset.series.v3.metrics48h)}`,
    `- 48h hybrid: ${formatPublishedProspectiveMetric(subset.series.hybrid.metrics48h)}`,
  ];
}

function formatUnifiedOriginDiagnostic(
  origin: PublishedProspectiveEvaluationReport["unifiedComparison"]["perOrigin"][number],
) {
  return [
    `#### ${origin.origin}`,
    `- 24h actual=${origin.actual24h ?? "unresolved"}, predictions=${JSON.stringify(origin.probabilities24h)}, Brier=${JSON.stringify(origin.brierContributions24h)}`,
    `- 48h actual=${origin.actual48h ?? "unresolved"}, predictions=${JSON.stringify(origin.probabilities48h)}, Brier=${JSON.stringify(origin.brierContributions48h)}`,
    `- officialNotice=${origin.officialNotice}, finalDisplayOverlay=${origin.finalDisplayOverlay}, postReset0To24h=${origin.postReset0To24h}`,
  ];
}

type ScoreboardMetric = PublishedProspectiveEvaluationReport["scoreboard"]["metrics"]["publishedV3"]["metrics24h"];
type ScoreboardSegment = PublishedProspectiveEvaluationReport["scoreboard"]["segments"]["officialNoticeOverride"]["yes"];

function formatScoreboardMetric(metric: ScoreboardMetric) {
  const number = (value: number | null) => value === null ? "unavailable" : value.toFixed(4);
  const interval = metric.positiveRateWilson95 === null
    ? "unavailable"
    : `${metric.positiveRateWilson95.lower.toFixed(4)}-${metric.positiveRateWilson95.upper.toFixed(4)}`;
  const reliability = metric.reliabilityBins
    .map((bin) => `${bin.range}:${bin.count}/${bin.averagePrediction.toFixed(4)}/${bin.actualRate.toFixed(4)}`)
    .join(";");
  return [
    `n=${metric.count}`,
    `status=${metric.sampleStatus}`,
    `positive=${metric.positiveCount}`,
    `actualRate=${number(metric.actualPositiveRate)}`,
    `mean=${number(metric.meanPredictedProbability)}`,
    `bias=${number(metric.bias)}`,
    `brier=${number(metric.brier)}`,
    `logLoss=${number(metric.logLoss)}`,
    `falseHigh=${metric.falseHigh}`,
    `falseLow=${metric.falseLow}`,
    `falseHighRate=${number(metric.falseHighRate)}`,
    `falseLowRate=${number(metric.falseLowRate)}`,
    `sharpness=${number(metric.sharpness)}`,
    `wilson95=${interval}`,
    `reliability=${reliability}`,
  ].join(", ");
}

function formatScoreboardSegment(name: string, segment: ScoreboardSegment) {
  return [
    `### ${name}`,
    `- Origins: ${segment.originCount}`,
    `- 24h: ${formatScoreboardMetric(segment.metrics24h)}`,
    `- 48h: ${formatScoreboardMetric(segment.metrics48h)}`,
  ];
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isFiniteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function buildProspectiveScoreboardFeatures(
  rows: Array<ProspectiveForecastRow>,
  _data?: RadarData | null,
): Record<string, PublishedV3ScoreboardFeature> {
  return Object.fromEntries(rows.flatMap((row) => {
    const forecast = row.forecasts[PROSPECTIVE_PUBLISHED_ACTIVE_MODEL_VERSION];
    const snapshot = readPublishedV3FeatureSnapshot(forecast?.featureSnapshot);
    return snapshot
      ? [[row.generatedAt, snapshot satisfies PublishedV3FeatureSnapshot]]
      : [];
  }));
}

function buildV3TrainingRows(
  rows: Array<ProspectiveForecastRow>,
  events: Array<ShadowResetEvent>,
  asOf: Date,
): Array<NextGenerationCalibrationRow> {
  const asOfTime = asOf.getTime();
  return rows.flatMap((row) => {
    const forecast = row.forecasts[NEXT_GENERATION_B_MODEL_VERSION];
    const generatedAt = forecast?.generatedAt;
    const generatedTime = parseTimestamp(generatedAt);
    if (
      !forecast
      || forecast.modelVersion !== NEXT_GENERATION_B_MODEL_VERSION
      || generatedAt === undefined
      || generatedTime === null
      || generatedTime < parseTimestamp(NEXT_GENERATION_FREEZE_AT)!
      || generatedTime >= asOfTime
      || !isFiniteProbability(forecast.rawProbability24h)
      || !isFiniteProbability(forecast.rawProbability48h)
    ) {
      return [];
    }
    return [{
      generatedAt,
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: forecast.rawProbability24h,
      rawProbability48h: forecast.rawProbability48h,
      actual24h: generatedTime + 24 * 60 * 60 * 1000 <= asOfTime
        ? getActualWithinHorizon(events, generatedAt, 24)
        : undefined,
      actual48h: generatedTime + 48 * 60 * 60 * 1000 <= asOfTime
        ? getActualWithinHorizon(events, generatedAt, 48)
        : undefined,
    }];
  });
}

function toRetrospectiveStoredForecast(
  result: NextGenerationBResult,
): ProspectiveStoredForecast {
  return {
    modelVersion: result.modelVersion,
    generatedAt: result.calculatedAt,
    probability24h: result.predictions.probability24h,
    probability48h: result.predictions.probability48h,
    rawProbability24h: result.rawProbability24h,
    rawProbability48h: result.rawProbability48h,
    alpha24h: result.alpha24h,
    alpha48h: result.alpha48h,
    calibrationSampleCount24h: result.calibrationSampleCount24h,
    calibrationSampleCount48h: result.calibrationSampleCount48h,
    positiveCalibrationCount24h: result.positiveCalibrationCount24h,
    positiveCalibrationCount48h: result.positiveCalibrationCount48h,
    lastResolvedOrigin24h: result.lastResolvedOrigin24h,
    lastResolvedOrigin48h: result.lastResolvedOrigin48h,
    publicCalibrationPolicy: result.publicCalibrationPolicy,
    calibrationPolicy: result.calibrationPolicy,
    officialNoticeOverride: result.officialNoticeOverride.active,
    latestRandomResetAt: result.randomContinuous.latestRandomResetAt,
    elapsedHoursSinceRandom: result.randomContinuous.randomElapsedHours,
    randomElapsedHours: result.randomContinuous.randomElapsedHours,
    latestRecoveryResetAt: result.randomContinuous.latestRecoveryResetAt,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
    trainingReadStatus: result.trainingReadStatus,
    pointInTimeProjectionVersion: "getPointInTimeRadarData",
  };
}

type RetrospectiveCandidateCalculator = (
  data: RadarData,
  options: NextGenerationBCalculationOptions,
) => NextGenerationBResult;

function buildRetrospectiveCandidateForecasts(
  rows: Array<ProspectiveForecastRow>,
  data: RadarData | null,
  events: Array<ShadowResetEvent>,
  asOf: Date,
  calculate: RetrospectiveCandidateCalculator,
): Record<string, ProspectiveStoredForecast> {
  if (!data) return {};
  const adoptionTime = parseTimestamp(PUBLISHED_PROBABILITY_ADOPTION_AT);
  const comparableDailyRows = rows.filter((row) => {
    const generatedTime = parseTimestamp(row.generatedAt);
    return generatedTime !== null
      && generatedTime <= asOf.getTime()
      && (adoptionTime === null || generatedTime >= adoptionTime!);
  });
  const trainingRows = buildV3TrainingRows(rows, events, asOf);
  const dailyRows = selectDailyFirstPublishedForecasts(comparableDailyRows);
  return Object.fromEntries(
    dailyRows.flatMap((row) => {
      const generatedTime = parseTimestamp(row.generatedAt);
      if (generatedTime === null) return [];
      const pointInTimeData = getPointInTimeRadarData(data, new Date(generatedTime));
      if (!pointInTimeData) return [];
      const result = calculate(pointInTimeData, {
        now: new Date(generatedTime),
        staticHistory: LOCAL_RESET_HISTORY,
        trainingRows,
        trainingReadStatus: "ok",
      });
      return [[row.generatedAt, toRetrospectiveStoredForecast(result)] as const];
    }),
  );
}

function buildRetrospectiveV3Forecasts(
  rows: Array<ProspectiveForecastRow>,
  data: RadarData | null,
  events: Array<ShadowResetEvent>,
  asOf: Date,
) {
  return buildRetrospectiveCandidateForecasts(
    rows,
    data,
    events,
    asOf,
    calculateNextGenerationV3Probability,
  );
}

function buildRetrospectiveHybridForecasts(
  rows: Array<ProspectiveForecastRow>,
  data: RadarData | null,
  events: Array<ShadowResetEvent>,
  asOf: Date,
) {
  return buildRetrospectiveCandidateForecasts(
    rows,
    data,
    events,
    asOf,
    calculateNextGenerationSelectiveCalibrationProbability,
  );
}

function buildSavedArtifactHybridForecasts(
  rows: Array<ProspectiveForecastRow>,
  asOf: Date,
) {
  const sourceModelVersion = NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION;
  const companionModelVersion = NEXT_GENERATION_B_MODEL_VERSION;
  const adoptionTime = parseTimestamp(PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT);
  const comparableRows = rows.filter((row) => {
    const generatedTime = parseTimestamp(row.generatedAt);
    return generatedTime !== null
      && generatedTime <= asOf.getTime()
      && row.forecasts[sourceModelVersion]
      && row.forecasts[companionModelVersion]
      && (adoptionTime === null || generatedTime >= adoptionTime!);
  });
  const dailyRows = selectDailyFirstForecastsForModelPair(
    comparableRows,
    sourceModelVersion,
    companionModelVersion,
  );
  const forecasts: Record<string, ProspectiveStoredForecast> = {};
  const audits: Record<string, ReturnType<typeof buildSavedArtifactHybridForecast>["audit"]> = {};
  for (const row of dailyRows) {
    const savedV2 = row.forecasts[sourceModelVersion];
    if (
      !savedV2
      || savedV2.modelVersion !== sourceModelVersion
      || !isFiniteProbability(savedV2.rawProbability24h)
      || !isFiniteProbability(savedV2.rawProbability48h)
    ) {
      continue;
    }
    const built = buildSavedArtifactHybridForecast(savedV2);
    forecasts[row.generatedAt] = built.forecast;
    audits[row.generatedAt] = built.audit;
  }
  return { forecasts, audits };
}

function writeMarkdown(report: PublishedProspectiveEvaluationReport) {
  const active24h = report.models.active.metrics24h;
  const active48h = report.models.active.metrics48h;
  const baseline24h = report.models.baseline.metrics24h;
  const baseline48h = report.models.baseline.metrics48h;
  const lines = [
    "# Prospective Published Model Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Active model: ${report.activeModelVersion}`,
    `- Baseline model: ${report.baselineModelVersion}`,
    `- As of: ${report.asOf}`,
    `- Saved forecasts: active=${report.forecastCounts.active}, baseline=${report.forecastCounts.baseline}, comparable=${report.forecastCounts.comparable}`,
    `- Source: ${report.source}`,
    `- Target definition: ${report.targetDefinition}`,
    "",
    "## Primary prospective evaluation",
    "",
    "### Canonical random reset truth",
    `- Post-adoption canonical random reset events: ${report.canonicalRandomResetEvents.length}`,
    ...(report.canonicalRandomResetEvents.length === 0
      ? ["- Events: none"]
      : report.canonicalRandomResetEvents.map((event) => `- ${event.id}: ${event.resetAt}`)),
    "",
    "### Daily first forecast comparison",
    "",
    `### ${report.activeModelVersion}`,
    `- 24h: ${formatPublishedProspectiveMetric(active24h)}`,
    `- 48h: ${formatPublishedProspectiveMetric(active48h)}`,
    "",
    `### ${report.baselineModelVersion}`,
    `- 24h: ${formatPublishedProspectiveMetric(baseline24h)}`,
    `- 48h: ${formatPublishedProspectiveMetric(baseline48h)}`,
    "",
    "### Active minus baseline",
    "",
    `- 24h Brier: ${report.comparison.activeMinusBaseline.brier24h ?? "unavailable"}`,
    `- 48h Brier: ${report.comparison.activeMinusBaseline.brier48h ?? "unavailable"}`,
    `- 24h Log loss: ${report.comparison.activeMinusBaseline.logLoss24h ?? "unavailable"}`,
    `- 48h Log loss: ${report.comparison.activeMinusBaseline.logLoss48h ?? "unavailable"}`,
    `- Resolved forecasts: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Positive forecasts: 24h=${report.comparison.positiveCount24h}, 48h=${report.comparison.positiveCount48h}`,
    `- Target random reset count: ${report.comparison.targetResetCount}`,
    "",
    "## V3 prospective scoreboard",
    "",
    "This scoreboard is prospective-only and uses daily-first saved v3 origins at or after the adoption boundary. It does not rewrite historical rows, backfill missing forecasts, or change probability calculations.",
    `- Scoreboard status: ${report.scoreboard.gate.status}`,
    `- Diagnostic recommendation: ${report.scoreboard.recommendation}`,
    `- Daily-first origins: ${report.scoreboard.dailyFirstOriginCount}`,
    `- Gate progress: 24h=${report.scoreboard.gate.resolved24h}/${report.scoreboard.gate.thresholds.resolved24h}, 48h=${report.scoreboard.gate.resolved48h}/${report.scoreboard.gate.thresholds.resolved48h}, target resets=${report.scoreboard.gate.targetResetCount}/${report.scoreboard.gate.thresholds.targetResets}`,
    `- Gate met: ${report.scoreboard.gate.allMet}`,
    `- v4 research eligible: ${report.scoreboard.gate.v4ResearchEligible}`,
    "- Segments below the minimum sample size are marked `insufficient_sample` and do not affect the gate or recommendation.",
    "- A gate status of `not_enough_prospective_data` does not recommend v4 research.",
    "",
    "### Published v3 metrics",
    `- 24h: ${formatScoreboardMetric(report.scoreboard.metrics.publishedV3.metrics24h)}`,
    `- 48h: ${formatScoreboardMetric(report.scoreboard.metrics.publishedV3.metrics48h)}`,
    "",
    "### Same-origin comparisons",
    `- Raw signal-adjusted 24h (${report.scoreboard.comparisons.rawSignalAdjusted24h.source}): ${formatScoreboardMetric(report.scoreboard.comparisons.rawSignalAdjusted24h.metric)}`,
    `- v2-style calibrated 24h (${report.scoreboard.comparisons.v2StyleCalibrated24h.source}): ${formatScoreboardMetric(report.scoreboard.comparisons.v2StyleCalibrated24h.metric)}`,
    `- v2-policy 48h (${report.scoreboard.comparisons.v2Policy48h.source}): ${formatScoreboardMetric(report.scoreboard.comparisons.v2Policy48h.metric)}`,
    `- v2-policy 48h exactly matches published v3: ${report.scoreboard.comparisons.v2Policy48h.exactlyMatchesPublished ?? "unavailable"}`,
    `- v2-policy 48h maximum absolute difference: ${report.scoreboard.comparisons.v2Policy48h.maxAbsoluteDifference ?? "unavailable"}`,
    "",
    "### Common-origin regression diagnosis",
    "This regression diagnosis uses one shared daily-first 24h origin set with finite v3 raw, same-origin v2, and resolved labels. It is separate from the headline coverage metrics and cannot emit `investigate` below five common origins.",
    `- Common origins: ${report.scoreboard.comparisons.regressionDiagnosis24h.comparableOriginCount}`,
    `- Sample status: ${report.scoreboard.comparisons.regressionDiagnosis24h.sampleStatus}`,
    `- Published v3: ${formatScoreboardMetric(report.scoreboard.comparisons.regressionDiagnosis24h.publishedV3)}`,
    `- Raw signal-adjusted: ${formatScoreboardMetric(report.scoreboard.comparisons.regressionDiagnosis24h.rawSignalAdjusted)}`,
    `- v2-style calibrated: ${formatScoreboardMetric(report.scoreboard.comparisons.regressionDiagnosis24h.v2StyleCalibrated)}`,
    "",
    "### Segment diagnostics",
    ...formatScoreboardSegment("Official notice override: yes", report.scoreboard.segments.officialNoticeOverride.yes),
    ...formatScoreboardSegment("Official notice override: no", report.scoreboard.segments.officialNoticeOverride.no),
    ...formatScoreboardSegment("Reset age: 0-24h", report.scoreboard.segments.resetAge["0-24h"]),
    ...formatScoreboardSegment("Reset age: 24-48h", report.scoreboard.segments.resetAge["24-48h"]),
    ...formatScoreboardSegment("Reset age: 48-72h", report.scoreboard.segments.resetAge["48-72h"]),
    ...formatScoreboardSegment("Reset age: >72h", report.scoreboard.segments.resetAge[">72h"]),
    ...formatScoreboardSegment("Reset age: unknown", report.scoreboard.segments.resetAge.unknown),
    ...formatScoreboardSegment("BANKED event within 48h: yes", report.scoreboard.segments.bankedEventWithin48h.yes),
    ...formatScoreboardSegment("BANKED event within 48h: no", report.scoreboard.segments.bankedEventWithin48h.no),
    ...formatScoreboardSegment("BANKED event within 48h: unknown", report.scoreboard.segments.bankedEventWithin48h.unknown),
    ...formatScoreboardSegment("Usable Tibo signal: yes", report.scoreboard.segments.usableTiboSignal.yes),
    ...formatScoreboardSegment("Usable Tibo signal: no", report.scoreboard.segments.usableTiboSignal.no),
    ...formatScoreboardSegment("Usable Tibo signal: unknown", report.scoreboard.segments.usableTiboSignal.unknown),
    ...formatScoreboardSegment("Status incident: yes", report.scoreboard.segments.statusIncident.yes),
    ...formatScoreboardSegment("Status incident: no", report.scoreboard.segments.statusIncident.no),
    ...formatScoreboardSegment("Status incident: unknown", report.scoreboard.segments.statusIncident.unknown),
    "",
    "### Scoreboard notes",
    ...report.scoreboard.warnings.map((warning) => `- Warning: ${warning}`),
    ...report.scoreboard.notes.map((note) => `- ${note}`),
    "",
    "## Unified model comparison (retrospective diagnostics)",
    "",
    "The saved-artifact hybrid is the primary retrospective counterfactual: its 24h/48h values are reconstructed from the saved v2 artifact. The point-in-time hybrid replay is retained as a separate diagnostic because its original training/input snapshot cannot be reproduced exactly. Neither retrospective series affects the primary gate or status.",
    `- Shared origins: ${report.unifiedComparison.originCount}`,
    `- Origin timestamps: ${report.unifiedComparison.origins.length > 0 ? report.unifiedComparison.origins.join(", ") : "none"}`,
    ...formatUnifiedSeries("Final displayed", report.unifiedComparison.series.finalDisplayed),
    "",
    ...formatUnifiedSeries("v3 uncalibrated post-reset-age candidate", report.unifiedComparison.series.v3),
    "",
    ...formatUnifiedSeries("Selective-calibration hybrid candidate (saved artifact)", report.unifiedComparison.series.hybrid),
    "",
    ...(report.unifiedComparison.hybridReplay === null
      ? ["### Selective-calibration hybrid candidate (point-in-time replay)", "- unavailable", ""]
      : [...formatUnifiedSeries("Selective-calibration hybrid candidate (point-in-time replay)", report.unifiedComparison.hybridReplay), ""]),
    ...formatUnifiedSeries("Current v2 calibrated", report.unifiedComparison.series.currentV2),
    "",
    ...formatUnifiedSeries("Raw continuous", report.unifiedComparison.series.rawContinuous),
    "",
    ...formatUnifiedSeries("v1 calibrated", report.unifiedComparison.series.v1),
    "",
    "### Delta versus current v2",
    `- Final displayed: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.finalDisplayed)}`,
    `- Hybrid saved artifact: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.hybrid)}`,
    `- Hybrid point-in-time replay: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.hybridReplay)}`,
    `- v3: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.v3)}`,
    `- Raw continuous: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.rawContinuous)}`,
    `- v1: ${JSON.stringify(report.unifiedComparison.deltaVsCurrentV2.v1)}`,
    "",
    "### Per-origin diagnostics",
    "",
    ...(report.unifiedComparison.perOrigin.length === 0
      ? ["- Origins: none"]
      : report.unifiedComparison.perOrigin.flatMap((origin) => [...formatUnifiedOriginDiagnostic(origin), ""])),
    "### Unified diagnostic subsets",
    ...formatUnifiedSubset("No official notice", report.unifiedComparison.subsets.noOfficialNotice),
    "",
    ...formatUnifiedSubset("No final-display special overlay", report.unifiedComparison.subsets.noFinalDisplaySpecialOverlay),
    "",
    ...formatUnifiedSubset("Official notice override active", report.unifiedComparison.subsets.noticeOverrideActive),
    "",
    ...formatUnifiedSubset("Latest random reset at 0-24h", report.unifiedComparison.subsets.latestRandomReset0To24h),
    "",
    "### Saved-artifact hybrid audit",
    `- Source: ${report.unifiedComparison.savedArtifactHybridAudit.source}`,
    `- Audited origins: ${report.unifiedComparison.savedArtifactHybridAudit.origins.length}`,
    `- Origins with counterfactual coherence adjustment: ${report.unifiedComparison.savedArtifactHybridAudit.originsWithCoherenceAdjustment.length > 0 ? report.unifiedComparison.savedArtifactHybridAudit.originsWithCoherenceAdjustment.join(", ") : "none"}`,
    `- Origins with unexplained saved-final mismatch: ${report.unifiedComparison.savedArtifactHybridAudit.originsWithUnexplainedSavedFinalMismatch.length > 0 ? JSON.stringify(report.unifiedComparison.savedArtifactHybridAudit.originsWithUnexplainedSavedFinalMismatch) : "none"}`,
    "",
    "### Manual review gate",
    "",
    `- Auto publish: ${report.gate.autoPublish}`,
    `- Manual review only: ${report.gate.manualReviewOnly}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily 24h: ${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}`,
    `- Resolved daily 48h: ${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- Eligible for manual review: ${report.gate.eligibleForManualReview}`,
    "",
    "## Post-reset 0-24h diagnostic",
    "",
    "This is a separate descriptive diagnostic comparing the active post-reset-age model with the v1 baseline. It never affects the primary gate, status, manual-review eligibility, model selection, or publication.",
    `- All eligible saved origins: ${report.postResetDiagnostic.allEligibleOriginCount}`,
    `- Representative origins (first comparable origin per canonical reset): ${report.postResetDiagnostic.representativeOriginCount}`,
    ...(report.postResetDiagnostic.representativeOrigins.length === 0
      ? ["- Representative origins: none"]
      : report.postResetDiagnostic.representativeOrigins.map((origin) =>
        `- ${origin.resetId}: reset=${origin.resetAt}, forecast=${origin.generatedAt}`)),
    "",
    "### 24h",
    `- ${formatPostResetDiagnosticMetric(report.postResetDiagnostic.metrics24h)}`,
    "",
    "### 48h",
    `- ${formatPostResetDiagnosticMetric(report.postResetDiagnostic.metrics48h)}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function writePublishedProspectiveReports(
  report: PublishedProspectiveEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-published-model-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-published-model-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionCanonicalRadarData(asOf);
  const events: Array<ShadowResetEvent> = production.data
    ? getShadowCompletedResetEvents(production.data, asOf, LOCAL_RESET_HISTORY, {
        preserveDistinctCanonicalIds: true,
      })
    : [];
  const v3Forecasts = buildRetrospectiveV3Forecasts(history.rows, production.data, events, asOf);
  const hybridReplayForecasts = buildRetrospectiveHybridForecasts(history.rows, production.data, events, asOf);
  const savedArtifactHybrid = buildSavedArtifactHybridForecasts(history.rows, asOf);
  const scoreboardFeatures = buildProspectiveScoreboardFeatures(history.rows, production.data);
  const baseReport = evaluatePublishedModelProspectively(history.rows, events, asOf, {
    v3Forecasts,
    hybridForecasts: savedArtifactHybrid.forecasts,
    hybridReplayForecasts,
    savedArtifactHybridAudits: savedArtifactHybrid.audits,
    scoreboardFeatures,
  });
  const availabilityNotes: string[] = [];
  if (baseReport.forecastCounts.comparable === 0) {
    availabilityNotes.push(
      history.reason?.includes("environment") || history.reason?.includes("query")
        ? history.reason
        : `No prediction_history rows contain both the published ${PROSPECTIVE_PUBLISHED_ACTIVE_MODEL_VERSION} and ${PROSPECTIVE_PUBLISHED_BASELINE_MODEL_VERSION} forecasts yet.`,
    );
  }
  if (production.reason) availabilityNotes.push(production.reason);
  const report = availabilityNotes.length > 0
    ? { ...baseReport, notes: [...baseReport.notes, ...availabilityNotes.map((note) => `Data availability: ${note}`)] }
    : baseReport;
  writePublishedProspectiveReports(report);
  console.log(JSON.stringify({
    status: report.status,
    evaluationStartAt: report.evaluationStartAt,
    activeModelVersion: report.activeModelVersion,
    baselineModelVersion: report.baselineModelVersion,
    savedActiveForecasts: report.forecastCounts.active,
    savedBaselineForecasts: report.forecastCounts.baseline,
    comparableForecastRows: report.forecastCounts.comparable,
    resolved24h: report.comparison.resolved24h,
    resolved48h: report.comparison.resolved48h,
    targetResetCount: report.comparison.targetResetCount,
    scoreboard: {
      status: report.scoreboard.gate.status,
      recommendation: report.scoreboard.recommendation,
      dailyFirstOriginCount: report.scoreboard.dailyFirstOriginCount,
      gate: report.scoreboard.gate,
      metrics24h: report.scoreboard.metrics.publishedV3.metrics24h,
      metrics48h: report.scoreboard.metrics.publishedV3.metrics48h,
    },
    canonicalRandomResetEvents: report.canonicalRandomResetEvents,
    postResetDiagnostic: {
      allEligibleOriginCount: report.postResetDiagnostic.allEligibleOriginCount,
      representativeOriginCount: report.postResetDiagnostic.representativeOriginCount,
      metrics24hSampleCount: report.postResetDiagnostic.metrics24h.sampleCount,
      metrics48hSampleCount: report.postResetDiagnostic.metrics48h.sampleCount,
    },
    unifiedComparison: {
      sharedOriginCount: report.unifiedComparison.originCount,
      v3ForecastCount: v3Forecasts ? Object.keys(v3Forecasts).length : 0,
      hybridForecastCount: Object.keys(savedArtifactHybrid.forecasts).length,
      hybridReplayForecastCount: hybridReplayForecasts ? Object.keys(hybridReplayForecasts).length : 0,
      v3Metrics24h: report.unifiedComparison.series.v3.metrics24h,
      v3Metrics48h: report.unifiedComparison.series.v3.metrics48h,
      hybridMetrics24h: report.unifiedComparison.series.hybrid.metrics24h,
      hybridMetrics48h: report.unifiedComparison.series.hybrid.metrics48h,
    },
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluatePublishedModelProspectively.ts") {
  void main();
}
