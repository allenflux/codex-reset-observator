import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "../lib/radar/recoveryBoundary";
import {
  evaluateRandomClockModelProspectively,
  type RandomClockProspectiveEvaluationReport,
} from "../lib/radar/prospectiveRandomClockModelEvaluation";
import { formatPublishedProspectiveMetric } from "../lib/radar/prospectivePublishedModelEvaluation";
import {
  loadFormalTiboResets,
  loadPredictionHistoryRows,
  loadRegularResetEvents,
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

function writeMarkdown(report: RandomClockProspectiveEvaluationReport) {
  const active24h = report.models.active.metrics24h;
  const active48h = report.models.active.metrics48h;
  const baseline24h = report.models.baseline.metrics24h;
  const baseline48h = report.models.baseline.metrics48h;
  const lines = [
    "# Prospective Random-Clock Shadow Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Shadow model: ${report.activeModelVersion}`,
    `- Public baseline: ${report.baselineModelVersion}`,
    `- Freeze at: ${report.freezeAt}`,
    `- As of: ${report.asOf}`,
    `- Saved forecasts: shadow=${report.forecastCounts.active}, public=${report.forecastCounts.baseline}, comparable=${report.forecastCounts.comparable}`,
    `- Source: ${report.source}`,
    `- Target definition: ${report.targetDefinition}`,
    "",
    "## Daily first forecast comparison",
    "",
    `### ${report.activeModelVersion}`,
    `- 24h: ${formatPublishedProspectiveMetric(active24h)}`,
    `- 48h: ${formatPublishedProspectiveMetric(active48h)}`,
    "",
    `### ${report.baselineModelVersion}`,
    `- 24h: ${formatPublishedProspectiveMetric(baseline24h)}`,
    `- 48h: ${formatPublishedProspectiveMetric(baseline48h)}`,
    "",
    "## Shadow minus public baseline",
    "",
    `- 24h Brier: ${report.comparison.activeMinusBaseline.brier24h ?? "unavailable"}`,
    `- 48h Brier: ${report.comparison.activeMinusBaseline.brier48h ?? "unavailable"}`,
    `- 24h Log loss: ${report.comparison.activeMinusBaseline.logLoss24h ?? "unavailable"}`,
    `- 48h Log loss: ${report.comparison.activeMinusBaseline.logLoss48h ?? "unavailable"}`,
    `- Resolved forecasts: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Positive random resets: 24h=${report.comparison.positiveCount24h}, 48h=${report.comparison.positiveCount48h}`,
    `- Target random reset count: ${report.comparison.targetResetCount}`,
    "",
    "## Manual review gate",
    "",
    `- Auto publish: ${report.gate.autoPublish}`,
    `- Manual review only: ${report.gate.manualReviewOnly}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily 24h: ${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}`,
    `- Resolved daily 48h: ${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- Eligible for manual review: ${report.gate.eligibleForManualReview}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function writeRandomClockProspectiveReports(
  report: RandomClockProspectiveEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-random-clock-model-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-random-clock-model-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

export function buildRandomClockBoundaries(
  formalTiboResets: Awaited<ReturnType<typeof loadFormalTiboResets>>,
  regularResetEvents: Awaited<ReturnType<typeof loadRegularResetEvents>>,
  asOf: Date,
): Array<RecoveryResetBoundary> {
  return getRecoveryResetEvents(
    {
      formal_tibo_resets: formalTiboResets,
      regular_reset_events: regularResetEvents,
    },
    asOf,
    LOCAL_RESET_HISTORY,
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const [formalTiboResets, regularResetEvents] = await Promise.all([
    loadFormalTiboResets(),
    loadRegularResetEvents(),
  ]);
  const boundaries = buildRandomClockBoundaries(formalTiboResets, regularResetEvents, asOf);
  const baseReport = evaluateRandomClockModelProspectively(history.rows, boundaries, asOf);
  const report = baseReport.forecastCounts.comparable === 0 && history.reason
    ? {
        ...baseReport,
        notes: [...baseReport.notes, `Data availability: ${history.reason}`],
      }
    : baseReport;
  writeRandomClockProspectiveReports(report);
  console.log(JSON.stringify({
    status: report.status,
    evaluationStartAt: report.evaluationStartAt,
    activeModelVersion: report.activeModelVersion,
    baselineModelVersion: report.baselineModelVersion,
    savedShadowForecasts: report.forecastCounts.active,
    savedPublicForecasts: report.forecastCounts.baseline,
    comparableForecastRows: report.forecastCounts.comparable,
    resolved24h: report.comparison.resolved24h,
    resolved48h: report.comparison.resolved48h,
    targetResetCount: report.comparison.targetResetCount,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateRandomClockModelProspectively.ts") {
  void main();
}
