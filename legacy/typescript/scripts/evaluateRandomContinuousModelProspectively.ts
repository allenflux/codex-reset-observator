import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { toCodexRecoveryObservation, toResetExecutionEstimate } from "../lib/codexUsageRecoveryStore";
import { getLocalRadarData } from "../lib/radar";
import {
  evaluateRandomContinuousModelProspectively,
  type RandomContinuousProspectiveEvaluationReport,
} from "../lib/radar/prospectiveRandomContinuousModelEvaluation";
import { getRecoveryResetEvents, type RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";
import { formatPublishedProspectiveMetric } from "../lib/radar/prospectivePublishedModelEvaluation";
import {
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

export async function loadProductionBoundaries(asOf: Date): Promise<{
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
  const errors = [signals.error, regular.error, observations.error, estimates.error].filter(Boolean);
  if (errors.length > 0) {
    return {
      boundaries: [],
      reason: "One or more Production recovery-source queries failed.",
    };
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
    boundaries: getRecoveryResetEvents(data, asOf, LOCAL_RESET_HISTORY),
    reason: null,
  };
}

function writeMarkdown(report: RandomContinuousProspectiveEvaluationReport) {
  const active24h = report.models.active.metrics24h;
  const active48h = report.models.active.metrics48h;
  const baseline24h = report.models.baseline.metrics24h;
  const baseline48h = report.models.baseline.metrics48h;
  const lines = [
    "# Prospective Random Continuous Shadow Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Active model: ${report.activeModelVersion}`,
    `- Baseline model: ${report.baselineModelVersion}`,
    `- Freeze at: ${report.freezeAt}`,
    `- As of: ${report.asOf}`,
    `- Canonical random boundaries: ${report.canonicalBoundaryCount}`,
    `- Saved forecasts: active=${report.forecastCounts.active}, baseline=${report.forecastCounts.baseline}, comparable=${report.forecastCounts.comparable}`,
    `- Source: ${report.source}`,
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
    "## Active minus baseline",
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

export function writeRandomContinuousProspectiveReports(
  report: RandomContinuousProspectiveEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-random-continuous-model-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-random-continuous-model-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionBoundaries(asOf);
  const baseReport = evaluateRandomContinuousModelProspectively(
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
  writeRandomContinuousProspectiveReports(report);
  console.log(JSON.stringify({
    status: report.status,
    freezeAt: report.freezeAt,
    evaluationStartAt: report.evaluationStartAt,
    activeModelVersion: report.activeModelVersion,
    baselineModelVersion: report.baselineModelVersion,
    canonicalRandomBoundaryCount: report.canonicalBoundaryCount,
    savedActiveForecasts: report.forecastCounts.active,
    savedBaselineForecasts: report.forecastCounts.baseline,
    comparableForecastRows: report.forecastCounts.comparable,
    resolved24h: report.comparison.resolved24h,
    resolved48h: report.comparison.resolved48h,
    targetResetCount: report.comparison.targetResetCount,
    backfilled: report.backfilled,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateRandomContinuousModelProspectively.ts") {
  void main();
}
