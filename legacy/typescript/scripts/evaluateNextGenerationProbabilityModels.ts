import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getLocalRadarData } from "../lib/radar";
import {
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "../lib/radar/recoveryBoundary";
import {
  evaluateNextGenerationModelsProspectively,
  type NextGenerationModelEvaluationReport,
} from "../lib/radar/prospectiveNextGenerationModelEvaluation";
import { toCodexRecoveryObservation, toResetExecutionEstimate } from "../lib/codexUsageRecoveryStore";
import { loadPredictionHistoryRows } from "./evaluateProspectiveProbabilityForecasts";

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // Missing local env files are reported as insufficient data.
  }
}

function parseAsOf(args: Array<string>) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : undefined;
  const asOf = value ? new Date(value) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

async function loadProductionRandomBoundaries(asOf: Date): Promise<{
  boundaries: Array<RecoveryResetBoundary>;
  reason: string | null;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return { boundaries: [], reason: "Supabase environment variables are not available." };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const [signals, regular, observations, estimates] = await Promise.all([
    supabase.from("tibo_signals").select("*").order("tweet_created_at", { ascending: true }).limit(10_000),
    supabase.from("regular_reset_events").select("*").order("completed_at", { ascending: true }).limit(1_000),
    supabase.from("codex_recovery_observations").select("*").order("observed_at", { ascending: true }).limit(1_000),
    supabase.from("reset_execution_estimates").select("*").order("display_execution_at", { ascending: true }).limit(1_000),
  ]);
  if ([signals.error, regular.error, observations.error, estimates.error].some(Boolean)) {
    return { boundaries: [], reason: "One or more Production recovery-source queries failed." };
  }

  const data = getLocalRadarData({
    calculationNow: asOf,
    formalTiboResets: (signals.data ?? []) as never,
    recentTiboSignals: (signals.data ?? []) as never,
    activeTiboSignals: (signals.data ?? []) as never,
    regularResetEvents: (regular.data ?? []) as never,
    codexRecoveryObservations: (observations.data ?? [])
      .map((row) => toCodexRecoveryObservation(row as never))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    resetExecutionEstimates: (estimates.data ?? [])
      .map((row) => toResetExecutionEstimate(row as never))
      .filter((row): row is NonNullable<typeof row> => row !== null),
  });
  return {
    boundaries: getRecoveryResetEvents(data, asOf, LOCAL_RESET_HISTORY)
      .filter((boundary) => boundary.isRandom),
    reason: null,
  };
}

function formatMetric(metric: { count: number; brier: number; logLoss: number; averagePrediction: number; actualRate: number }) {
  return `n=${metric.count}, Brier=${metric.brier.toFixed(6)}, logLoss=${metric.logLoss.toFixed(6)}, avg=${metric.averagePrediction.toFixed(4)}, actual=${metric.actualRate.toFixed(4)}`;
}

function writeMarkdown(report: NextGenerationModelEvaluationReport) {
  const lines = [
    "# Prospective Next-Generation Probability Model Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Freeze at: ${report.freezeAt}`,
    `- As of: ${report.asOf}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Target: ${report.targetDefinition}`,
    `- Saved forecasts: public=${report.forecastCounts.public}, A=${report.forecastCounts.a}, B=${report.forecastCounts.b}, comparable=${report.forecastCounts.comparable}`,
    `- Availability: A=${(report.availability.aRate * 100).toFixed(1)}%, B=${(report.availability.bRate * 100).toFixed(1)}%, comparable=${(report.availability.comparableRate * 100).toFixed(1)}%`,
    "",
    "## Daily first comparable forecasts",
    "",
    `- Public 24h: ${formatMetric(report.models.public.metrics24h)}`,
    `- Public 48h: ${formatMetric(report.models.public.metrics48h)}`,
    `- A 24h: ${formatMetric(report.models.a.metrics24h)}`,
    `- A 48h: ${formatMetric(report.models.a.metrics48h)}`,
    `- B 24h: ${formatMetric(report.models.b.metrics24h)}`,
    `- B 48h: ${formatMetric(report.models.b.metrics48h)}`,
    "",
    "## Comparison",
    "",
    `- Target random resets: ${report.comparison.targetResetCount}`,
    `- Resolved: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Non-overlapping samples: 24h=${report.comparison.nonOverlapping24h}, 48h=${report.comparison.nonOverlapping48h}`,
    `- A minus public Brier: 24h=${report.comparison.pairwise.aMinusPublic.brier24h ?? "unavailable"}, 48h=${report.comparison.pairwise.aMinusPublic.brier48h ?? "unavailable"}`,
    `- B minus public Brier: 24h=${report.comparison.pairwise.bMinusPublic.brier24h ?? "unavailable"}, 48h=${report.comparison.pairwise.bMinusPublic.brier48h ?? "unavailable"}`,
    `- A minus public log loss: 24h=${report.comparison.pairwise.aMinusPublic.logLoss24h ?? "unavailable"}, 48h=${report.comparison.pairwise.aMinusPublic.logLoss48h ?? "unavailable"}`,
    `- B minus public log loss: 24h=${report.comparison.pairwise.bMinusPublic.logLoss24h ?? "unavailable"}, 48h=${report.comparison.pairwise.bMinusPublic.logLoss48h ?? "unavailable"}`,
    "",
    "## Manual review gate",
    "",
    `- Auto publish: ${report.gate.autoPublish}`,
    `- Manual review only: ${report.gate.manualReviewOnly}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily: 24h=${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}, 48h=${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- A eligible: ${report.gate.a.eligibleForManualReview}`,
    `- B eligible: ${report.gate.b.eligibleForManualReview}`,
    "",
    "## Skip reasons",
    "",
    ...Object.entries(report.availability.skipReasons).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function writeNextGenerationProspectiveReports(
  report: NextGenerationModelEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-next-generation-model-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-next-generation-model-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionRandomBoundaries(asOf);
  const report = evaluateNextGenerationModelsProspectively(history.rows, production.boundaries, asOf);
  const enrichedReport = {
    ...report,
    notes: [
      ...report.notes,
      ...(history.rows.length === 0 && history.reason?.includes("environment")
        ? [`Prediction history availability: ${history.reason}`]
        : history.rows.length === 0 && history.reason?.includes("query")
          ? [`Prediction history availability: ${history.reason}`]
          : report.forecastCounts.comparable === 0
            ? ["Prediction history availability: no row contains the public model and both exact next-generation forecasts at the same origin yet."]
            : []),
      ...(production.reason ? [`Boundary availability: ${production.reason}`] : []),
      "Boundary source: Production Supabase recovery inputs normalized into RadarData; only random boundaries are passed to this evaluator.",
    ],
  };
  writeNextGenerationProspectiveReports(enrichedReport);
  console.log(JSON.stringify({
    status: enrichedReport.status,
    freezeAt: enrichedReport.freezeAt,
    evaluationStartAt: enrichedReport.evaluationStartAt,
    savedPublicForecasts: enrichedReport.forecastCounts.public,
    savedAForecasts: enrichedReport.forecastCounts.a,
    savedBForecasts: enrichedReport.forecastCounts.b,
    comparableForecastRows: enrichedReport.forecastCounts.comparable,
    resolved24h: enrichedReport.comparison.resolved24h,
    resolved48h: enrichedReport.comparison.resolved48h,
    targetResetCount: enrichedReport.comparison.targetResetCount,
    backfilled: enrichedReport.backfilled,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateNextGenerationProbabilityModels.ts") {
  void main();
}
