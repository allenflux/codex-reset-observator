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
  evaluateContextualBurstModelProspectively,
  type ContextualBurstModelEvaluationReport,
  type ContextualBurstContributionDelta,
} from "../lib/radar/prospectiveContextualBurstModelEvaluation";
import { toCodexRecoveryObservation, toResetExecutionEstimate } from "../lib/codexUsageRecoveryStore";
import { loadPredictionHistoryRows } from "./evaluateProspectiveProbabilityForecasts";

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // Missing local env files are surfaced in the report as unavailable data.
  }
}

function parseAsOf(args: string[]) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : undefined;
  const asOf = value ? new Date(value) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

async function loadProductionRandomBoundaries(asOf: Date): Promise<{
  boundaries: RecoveryResetBoundary[];
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

function formatMetric(metric: {
  count: number;
  brier: number;
  logLoss: number;
  averagePrediction: number;
  actualRate: number;
}) {
  return `n=${metric.count}, Brier=${metric.brier.toFixed(6)}, logLoss=${metric.logLoss.toFixed(6)}, avg=${metric.averagePrediction.toFixed(4)}, actual=${metric.actualRate.toFixed(4)}`;
}

function formatDelta(delta: ContextualBurstContributionDelta) {
  const value = (item: number | null) => item === null ? "unavailable" : item.toFixed(6);
  return `Brier24=${value(delta.brier24h)}, Brier48=${value(delta.brier48h)}, logLoss24=${value(delta.logLoss24h)}, logLoss48=${value(delta.logLoss48h)}`;
}

function writeMarkdown(report: ContextualBurstModelEvaluationReport) {
  const ablationNames = ["baseOnly", "noBurst", "noCircadian", "fullContext", "fullRaw"] as const;
  const lines = [
    "# Prospective Contextual Burst Probability Model Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- C v1 freeze at: ${report.freezeAt}`,
    `- C v2 freeze at: ${report.freezeAtV2}`,
    `- As of: ${report.asOf}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Target: ${report.targetDefinition}`,
    `- Saved forecasts: public=${report.forecastCounts.public}, A=${report.forecastCounts.a}, B=${report.forecastCounts.b}, C=${report.forecastCounts.c}, C v2=${report.forecastCounts.cV2}, comparable=${report.forecastCounts.comparable}`,
    `- Availability: A=${(report.availability.aRate * 100).toFixed(1)}%, B=${(report.availability.bRate * 100).toFixed(1)}%, C=${(report.availability.cRate * 100).toFixed(1)}%, C v2=${(report.availability.cV2Rate * 100).toFixed(1)}%, comparable=${(report.availability.comparableRate * 100).toFixed(1)}%, C ablations=${(report.availability.ablationRate * 100).toFixed(1)}%`,
    "",
    "## Daily first same-origin forecasts",
    "",
    `- Public 24h: ${formatMetric(report.models.public.metrics24h)}`,
    `- Public 48h: ${formatMetric(report.models.public.metrics48h)}`,
    `- A 24h: ${formatMetric(report.models.a.metrics24h)}`,
    `- A 48h: ${formatMetric(report.models.a.metrics48h)}`,
    `- B 24h: ${formatMetric(report.models.b.metrics24h)}`,
    `- B 48h: ${formatMetric(report.models.b.metrics48h)}`,
    `- C 24h: ${formatMetric(report.models.c.metrics24h)}`,
    `- C 48h: ${formatMetric(report.models.c.metrics48h)}`,
    `- C v2 24h: ${formatMetric(report.models.cV2.metrics24h)}`,
    `- C v2 48h: ${formatMetric(report.models.cV2.metrics48h)}`,
    "",
    "## C comparison",
    "",
    `- Target random resets: ${report.comparison.targetResetCount}`,
    `- Resolved: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Non-overlapping samples: 24h=${report.comparison.nonOverlapping24h}, 48h=${report.comparison.nonOverlapping48h}`,
    `- C minus Public: ${formatDelta(report.comparison.cMinusPublic)}`,
    `- C minus B: ${formatDelta(report.comparison.cMinusB)}`,
    "",
    "## C raw ablations",
    "",
    ...ablationNames.flatMap((name) => [
      `- ${name} 24h: ${formatMetric(report.ablations.models[name].metrics24h)}`,
      `- ${name} 48h: ${formatMetric(report.ablations.models[name].metrics48h)}`,
    ]),
    "",
    "## C v2 normalized ablations",
    "",
    ...Object.entries(report.normalizedAblations.models).flatMap(([name, model]) => [
      `- ${name} 24h: ${formatMetric(model.metrics24h)}`,
      `- ${name} 48h: ${formatMetric(model.metrics48h)}`,
    ]),
    "",
    "## Factor contribution deltas",
    "",
    `- noBurst minus fullContext: ${formatDelta(report.ablations.contributions.noBurstMinusFullContext)}`,
    `- noCircadian minus fullContext: ${formatDelta(report.ablations.contributions.noCircadianMinusFullContext)}`,
    `- fullContext minus fullRaw: ${formatDelta(report.ablations.contributions.fullContextMinusFullRaw)}`,
    "",
    "Positive noBurst/noCircadian deltas mean removing that factor made the score worse; negative deltas mean the ablated version scored better over the resolved sample.",
    "",
    "## Manual review gate",
    "",
    `- Auto publish: ${report.gate.autoPublish}`,
    `- Manual review only: ${report.gate.manualReviewOnly}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily: 24h=${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}, 48h=${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- Eligible for manual review: ${report.gate.eligibleForManualReview}`,
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

export function writeContextualBurstProspectiveReports(
  report: ContextualBurstModelEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-contextual-burst-model-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-contextual-burst-model-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionRandomBoundaries(asOf);
  const report = evaluateContextualBurstModelProspectively(history.rows, production.boundaries, asOf);
  const enrichedReport: ContextualBurstModelEvaluationReport = {
    ...report,
    notes: [
      ...report.notes,
      ...(history.rows.length === 0
        ? [`Prediction history availability: ${history.reason ?? "no saved rows"}`]
        : report.forecastCounts.c === 0
          ? ["Prediction history availability: no saved C forecast exists at or after the C freeze yet."]
          : report.forecastCounts.comparable === 0
            ? ["Prediction history availability: C exists, but no origin contains Public/A/B/C together yet."]
            : []),
      ...(production.reason ? [`Boundary availability: ${production.reason}`] : []),
      "Boundary source: Production Supabase recovery inputs normalized into RadarData; only random boundaries are passed to this evaluator.",
    ],
  };
  writeContextualBurstProspectiveReports(enrichedReport);
  console.log(JSON.stringify({
    status: enrichedReport.status,
    freezeAt: enrichedReport.freezeAt,
    evaluationStartAt: enrichedReport.evaluationStartAt,
    savedPublicForecasts: enrichedReport.forecastCounts.public,
    savedAForecasts: enrichedReport.forecastCounts.a,
    savedBForecasts: enrichedReport.forecastCounts.b,
    savedCForecasts: enrichedReport.forecastCounts.c,
    savedCV2Forecasts: enrichedReport.forecastCounts.cV2,
    comparableForecastRows: enrichedReport.forecastCounts.comparable,
    ablationRows: enrichedReport.availability.ablationRows,
    resolved24h: enrichedReport.comparison.resolved24h,
    resolved48h: enrichedReport.comparison.resolved48h,
    targetResetCount: enrichedReport.comparison.targetResetCount,
    backfilled: enrichedReport.backfilled,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateContextualBurstProbabilityModel.ts") {
  void main();
}
