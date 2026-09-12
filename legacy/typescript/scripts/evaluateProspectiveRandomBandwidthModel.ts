import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { loadPredictionHistoryRows } from "./evaluateProspectiveProbabilityForecasts";
import { loadProductionBoundaries } from "./evaluateRandomContinuousModelProspectively";
import {
  evaluateRandomBandwidthTruncationModelProspectively,
  type RandomBandwidthProspectiveEvaluationReport,
} from "../lib/radar/prospectiveRandomBandwidthModelEvaluation";

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

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(metric: {
  count: number;
  positiveCount: number;
  actualRate: number;
  averagePrediction: number;
  brier: number;
  logLoss: number;
}) {
  return `n=${metric.count}, positive=${metric.positiveCount}, actual=${formatPercent(metric.actualRate)}, mean=${formatPercent(metric.averagePrediction)}, Brier=${metric.brier.toFixed(4)}, logLoss=${metric.logLoss.toFixed(4)}`;
}

function writeMarkdown(report: RandomBandwidthProspectiveEvaluationReport) {
  const lines = [
    "# Prospective Random Bandwidth/Truncation Shadow Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Control: ${report.controlModelVersion}`,
    `- Challenger: ${report.challengerModelVersion}`,
    `- Freeze at: ${report.freezeAt}`,
    `- As of: ${report.asOf}`,
    `- Canonical random boundaries: ${report.canonicalBoundaryCount}`,
    `- Saved forecasts: control=${report.forecastCounts.control}, challenger=${report.forecastCounts.challenger}, comparable=${report.forecastCounts.comparable}`,
    `- Source: ${report.source}`,
    "",
    "## Overall comparison",
    "",
    `- Control 24h: ${formatMetric(report.models.control.metrics24h)}`,
    `- Challenger 24h: ${formatMetric(report.models.challenger.metrics24h)}`,
    `- Control 48h: ${formatMetric(report.models.control.metrics48h)}`,
    `- Challenger 48h: ${formatMetric(report.models.challenger.metrics48h)}`,
    `- Challenger minus control 24h Brier: ${report.comparison.challengerMinusControl.brier24h ?? "unavailable"}`,
    `- Challenger minus control 48h Brier: ${report.comparison.challengerMinusControl.brier48h ?? "unavailable"}`,
    `- Challenger minus control 24h Log Loss: ${report.comparison.challengerMinusControl.logLoss24h ?? "unavailable"}`,
    `- Challenger minus control 48h Log Loss: ${report.comparison.challengerMinusControl.logLoss48h ?? "unavailable"}`,
    `- Resolved daily forecasts: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Positive random resets: 24h=${report.comparison.positiveCount24h}, 48h=${report.comparison.positiveCount48h}`,
    `- Target random reset count: ${report.comparison.targetResetCount}`,
    "",
    "## Age buckets",
    "",
    ...report.ageBuckets.flatMap((bucket) => [
      `### ${bucket.ageBucket}`,
      `- Control: n=${bucket.control.count}, positive=${bucket.control.positiveCount}, actual=${formatPercent(bucket.control.actualRate)}, mean=${formatPercent(bucket.control.averagePrediction)}, Brier=${bucket.control.brier.toFixed(4)}`,
      `- Challenger: n=${bucket.challenger.count}, positive=${bucket.challenger.positiveCount}, actual=${formatPercent(bucket.challenger.actualRate)}, mean=${formatPercent(bucket.challenger.averagePrediction)}, Brier=${bucket.challenger.brier.toFixed(4)}`,
      "",
    ]),
    "## Manual review gate",
    "",
    `- Auto publish: ${report.gate.autoPublish}`,
    `- Manual review only: ${report.gate.manualReviewOnly}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily 24h: ${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}`,
    `- Resolved daily 48h: ${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- 24h Brier not worse: ${report.gate.brier24hNotWorse}`,
    `- 48h Brier not worse: ${report.gate.brier48hNotWorse}`,
    `- Log loss not extremely worse: ${report.gate.logLossNotExtremelyWorse}`,
    `- Eligible for manual review: ${report.gate.eligibleForManualReview}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function writeRandomBandwidthProspectiveReports(
  report: RandomBandwidthProspectiveEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-random-bandwidth-truncation-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-random-bandwidth-truncation-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionBoundaries(asOf);
  const baseReport = evaluateRandomBandwidthTruncationModelProspectively(
    history.rows,
    production.boundaries,
    asOf,
  );
  const report = {
    ...baseReport,
    notes: [
      ...baseReport.notes,
      ...(history.rows.length === 0 && history.reason
        ? [`Prediction history availability: ${history.reason}`]
        : []),
      ...(production.reason ? [`Boundary availability: ${production.reason}`] : []),
      "Boundary source: Production Supabase recovery inputs normalized into RadarData; local static history is not synchronized or backfilled.",
    ],
  };
  writeRandomBandwidthProspectiveReports(report);
  console.log(JSON.stringify({
    status: report.status,
    freezeAt: report.freezeAt,
    evaluationStartAt: report.evaluationStartAt,
    controlModelVersion: report.controlModelVersion,
    challengerModelVersion: report.challengerModelVersion,
    canonicalRandomBoundaryCount: report.canonicalBoundaryCount,
    savedControlForecasts: report.forecastCounts.control,
    savedChallengerForecasts: report.forecastCounts.challenger,
    comparableForecastRows: report.forecastCounts.comparable,
    resolved24h: report.comparison.resolved24h,
    resolved48h: report.comparison.resolved48h,
    targetResetCount: report.comparison.targetResetCount,
    backfilled: report.backfilled,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateProspectiveRandomBandwidthModel.ts") {
  void main();
}
