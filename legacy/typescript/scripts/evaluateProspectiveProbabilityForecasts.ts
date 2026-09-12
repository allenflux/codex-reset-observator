import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  LEGACY_SHADOW_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  getShadowCompletedResetEvents,
  type ShadowResetEvent,
} from "../lib/radar/shadowProbability";
import { toCodexRecoveryObservation, toResetExecutionEstimate } from "../lib/codexUsageRecoveryStore";
import { getLocalRadarData, type RadarData } from "../lib/radar";
import { readTiboFormalAdoptions } from "../lib/radar/tiboFormalAdoptionStore";
import {
  evaluateProspectiveProbabilityForecasts,
  PROSPECTIVE_V2_MODEL_VERSION,
  type ProspectiveForecastRow,
  type ProspectiveMetric,
  type ProspectiveProbabilityEvaluationReport,
} from "../lib/radar/prospectiveProbabilityEvaluation";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";
import type { RegularResetEventRow } from "../lib/radar/regularResetSchedule";

export type PredictionHistoryRow = {
  logged_hour?: string | null;
  debug_info?: unknown;
  probability_24h?: number | null;
  probability_48h?: number | null;
};

export type PredictionHistoryLoadResult = {
  rows: Array<ProspectiveForecastRow>;
  reason: string | null;
};

export type ProductionCanonicalRadarDataLoadResult = {
  data: RadarData | null;
  reason: string | null;
};

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // Missing or unsupported local env files are handled as insufficient data.
  }
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toForecastRow(row: PredictionHistoryRow): ProspectiveForecastRow | null {
  const debugInfo = typeof row.debug_info === "string"
    ? (() => {
        try {
          return JSON.parse(row.debug_info) as unknown;
        } catch {
          return null;
        }
      })()
    : row.debug_info;
  const debugRecord = asRecord(debugInfo);
  const forecastsRecord = asRecord(debugRecord?.experimentalProbabilityForecasts);
  if (!forecastsRecord) return null;

  const forecasts = Object.fromEntries(
    Object.entries(forecastsRecord).flatMap(([key, value]) => {
      const forecast = asRecord(value);
      if (!forecast) return [];
      const generatedAt = typeof forecast?.generatedAt === "string"
        ? forecast.generatedAt
        : null;
      const probability24h = forecast?.probability24h;
      const probability48h = forecast?.probability48h;
      if (
        !generatedAt
        || parseTimestamp(generatedAt) === null
        || typeof probability24h !== "number"
        || !Number.isFinite(probability24h)
        || typeof probability48h !== "number"
        || !Number.isFinite(probability48h)
      ) {
        return [];
      }
      return [[key, {
        ...forecast,
        modelVersion: typeof forecast.modelVersion === "string" ? forecast.modelVersion : key,
        generatedAt,
        probability24h,
        probability48h,
      }]];
    }),
  ) as ProspectiveForecastRow["forecasts"];

  const generatedAt = typeof forecasts[LEGACY_SHADOW_PROBABILITY_MODEL_VERSION]?.generatedAt === "string"
    ? forecasts[LEGACY_SHADOW_PROBABILITY_MODEL_VERSION].generatedAt
    : typeof debugRecord?.calculated_at === "string"
      ? debugRecord.calculated_at
      : row.logged_hour ?? null;
  if (!generatedAt || parseTimestamp(generatedAt) === null) return null;

  const finalDisplayed = typeof row.probability_24h === "number"
    && Number.isFinite(row.probability_24h)
    && typeof row.probability_48h === "number"
    && Number.isFinite(row.probability_48h)
    ? {
        modelVersion: "published-final-displayed",
        generatedAt,
        probability24h: row.probability_24h,
        probability48h: row.probability_48h,
        officialNoticeOverride: forecasts[PUBLISHED_PROBABILITY_MODEL_VERSION]?.officialNoticeOverride === true,
        finalDisplaySpecialOverlay:
          asRecord(asRecord(debugRecord?.publishedProbabilityModel)?.majorModelReleaseAdjustment)?.active === true,
      }
    : undefined;

  return {
    loggedHour: row.logged_hour ?? null,
    generatedAt,
    forecasts,
    ...(finalDisplayed ? { finalDisplayed } : {}),
  };
}

export function parsePredictionHistoryRows(rows: Array<PredictionHistoryRow>) {
  return rows.flatMap((row) => {
    const parsed = toForecastRow(row);
    return parsed ? [parsed] : [];
  });
}

export async function loadPredictionHistoryRows(): Promise<PredictionHistoryLoadResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      rows: [],
      reason: "Supabase environment variables are not available to the evaluation process.",
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("prediction_history")
    .select("logged_hour,debug_info,probability_24h,probability_48h")
    .order("logged_hour", { ascending: true })
    .limit(10_000);
  if (error) {
    console.error("Prospective prediction history query failed", error.message);
    return {
      rows: [],
      reason: "The prediction_history query failed; no forecast rows were available.",
    };
  }
  const rows = parsePredictionHistoryRows((data ?? []) as Array<PredictionHistoryRow>);
  const comparableRows = rows.filter((row) =>
    row.forecasts[PROSPECTIVE_V2_MODEL_VERSION]
    && row.forecasts[CALIBRATED_SHADOW_MODEL_VERSION],
  );
  return {
    rows,
    reason: comparableRows.length === 0
      ? "No prediction_history rows contain both v2 and v4 experimental forecasts yet."
      : null,
  };
}

export async function loadFormalTiboResets(): Promise<Array<FormalTiboResetSignal>> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return [];

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from("tibo_signals")
      .select(
        "tweet_id,text,tweet_url,tweet_created_at,detected_at,expires_at,signal_type,confidence,verification_status,classification_source,ai_classification_status,ai_reset_type_ja,ai_notice_to_execution",
      )
      .in("signal_type", ["reset_executed"])
      .order("tweet_created_at", { ascending: true })
      .limit(1000);
    if (error) {
      console.error("Prospective Tibo reset query failed", error.message);
      return [];
    }
    return (data ?? []) as Array<FormalTiboResetSignal>;
  } catch (error) {
    console.error(
      "Prospective Tibo reset query failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

export async function loadProductionCanonicalRadarData(
  asOf: Date,
): Promise<ProductionCanonicalRadarDataLoadResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      data: null,
      reason: "Supabase environment variables are not available for canonical reset-history evaluation.",
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const [signals, regular, observations, estimates, adoptions] = await Promise.all([
    supabase
      .from("tibo_signals")
      .select("*")
      .order("tweet_created_at", { ascending: true })
      .limit(10_000),
    supabase
      .from("regular_reset_events")
      .select("*")
      .order("completed_at", { ascending: true })
      .limit(1_000),
    supabase
      .from("codex_recovery_observations")
      .select("*")
      .order("observed_at", { ascending: true })
      .limit(1_000),
    supabase
      .from("reset_execution_estimates")
      .select("*")
      .order("display_execution_at", { ascending: true })
      .limit(1_000),
    readTiboFormalAdoptions(supabase as never),
  ]);
  const errors = [signals.error, regular.error, observations.error, estimates.error, adoptions.error]
    .filter(Boolean);
  if (errors.length > 0) {
    return {
      data: null,
      reason: "One or more Production canonical reset-history queries failed.",
    };
  }

  const rawSignals = (signals.data ?? []) as Array<FormalTiboResetSignal>;
  const rejectedTiboResets = rawSignals.flatMap((signal) => {
    if (
      signal.signal_type !== "reset_executed"
      || signal.is_reply === true
      || (signal.confidence ?? 0) < 0.95
      || signal.verification_status !== "rejected"
    ) {
      return [];
    }
    return [{
      tweet_id: signal.tweet_id,
      tweet_url: signal.tweet_url,
      tweet_created_at: signal.tweet_created_at,
    }];
  });
  const data = getLocalRadarData({
    calculationNow: asOf,
    formalTiboResets: rawSignals,
    recentTiboSignals: rawSignals as never,
    activeTiboSignals: rawSignals as never,
    rejectedTiboResets,
    regularResetEvents: (regular.data ?? []) as never,
    codexRecoveryObservations: (observations.data ?? [])
      .map((row) => toCodexRecoveryObservation(row as never))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    resetExecutionEstimates: (estimates.data ?? [])
      .map((row) => toResetExecutionEstimate(row as never))
      .filter((row): row is NonNullable<typeof row> => row !== null),
    tiboFormalAdoptions: adoptions.ledgers,
  });
  return { data, reason: null };
}

export async function loadRegularResetEvents(): Promise<Array<RegularResetEventRow>> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return [];

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from("regular_reset_events")
      .select(
        "schedule_key,window_start_at,window_end_at,representative_at,scheduled_at,completed_at,cycle_type,reset_method,scope,record_kind,status,correction_reason,corrected_at",
      )
      .order("completed_at", { ascending: true })
      .limit(1000);
    if (error) {
      console.error("Prospective regular reset query failed", error.message);
      return [];
    }
    return (data ?? []) as Array<RegularResetEventRow>;
  } catch (error) {
    console.error(
      "Prospective regular reset query failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMetric(metric: ProspectiveMetric) {
  return `n=${metric.count}, positive=${metric.positiveCount}, actual=${formatPercent(metric.actualRate)}, mean=${formatPercent(metric.averagePrediction)}, Brier=${metric.brier.toFixed(4)}, logLoss=${metric.logLoss.toFixed(4)}, period=${metric.periodStart ?? "none"}..${metric.periodEnd ?? "none"}, resets=${metric.targetResetCount}`;
}

function writeMarkdown(report: ProspectiveProbabilityEvaluationReport) {
  const lines = [
    "# Prospective Probability Evaluation",
    "",
    `- Status: ${report.status}`,
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Evaluation start: ${report.evaluationStartAt ?? "not started"}`,
    `- Active candidate model: ${report.activeCandidateModel}`,
    `- Archived candidate models: ${report.archivedCandidateModels.join(", ") || "none"}`,
    `- As of: ${report.asOf}`,
    `- Source: ${report.source}`,
    `- Target definition: ${report.targetDefinition}`,
    "",
    "## Models",
    "",
    `### ${report.models.v2.modelVersion}`,
    `- 24h: ${formatMetric(report.models.v2.metrics24h)}`,
    `- 48h: ${formatMetric(report.models.v2.metrics48h)}`,
    "",
    `### ${report.models.v4.modelVersion}`,
    `- 24h: ${formatMetric(report.models.v4.metrics24h)}`,
    `- 48h: ${formatMetric(report.models.v4.metrics48h)}`,
    "",
    "## Difference versus v2",
    "",
    `- 24h Brier: ${report.comparison.brierDifference24h ?? "unavailable"}`,
    `- 48h Brier: ${report.comparison.brierDifference48h ?? "unavailable"}`,
    `- 24h Log loss: ${report.comparison.logLossDifference24h ?? "unavailable"}`,
    `- 48h Log loss: ${report.comparison.logLossDifference48h ?? "unavailable"}`,
    `- Resolved daily forecasts: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    `- Target reset count: ${report.comparison.targetResetCount}`,
    "",
    "## Adoption gate",
    "",
    `- Automatic publication: ${report.gate.autoPublish}`,
    `- Target resets: ${report.gate.targetResetCount}/${report.gate.thresholds.targetResetCount}`,
    `- Resolved daily 24h: ${report.gate.resolvedDaily24h}/${report.gate.thresholds.resolvedDaily24h}`,
    `- Resolved daily 48h: ${report.gate.resolvedDaily48h}/${report.gate.thresholds.resolvedDaily48h}`,
    `- 24h Brier not worse: ${report.gate.brier24hNotWorse}`,
    `- 48h Brier not worse: ${report.gate.brier48hNotWorse}`,
    `- One horizon clearly improved: ${report.gate.oneHorizonClearlyImproved}`,
    `- Log loss not extremely worse: ${report.gate.logLossNotExtremelyWorse}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
    `- The active public model is ${PUBLISHED_PROBABILITY_MODEL_VERSION}; this report retains the archived ${LEGACY_SHADOW_PROBABILITY_MODEL_VERSION} comparison.`,
  ];
  return `${lines.join("\n")}\n`;
}

export function writeProspectiveProbabilityReports(
  report: ProspectiveProbabilityEvaluationReport,
  reportsDirectory = join(process.cwd(), "reports"),
) {
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(
    join(reportsDirectory, "prospective-probability-evaluation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(reportsDirectory, "prospective-probability-evaluation.md"),
    writeMarkdown(report),
    "utf8",
  );
}

function parseAsOf(args: Array<string>) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : undefined;
  const asOf = value ? new Date(value) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const formalTiboResets = await loadFormalTiboResets();
  const events: Array<ShadowResetEvent> = getShadowCompletedResetEvents(
    { formal_tibo_resets: formalTiboResets },
    asOf,
    LOCAL_RESET_HISTORY,
  );
  const baseReport = evaluateProspectiveProbabilityForecasts(history.rows, events, asOf);
  const report = history.reason
    ? {
        ...baseReport,
        notes: [...baseReport.notes, `Data availability: ${history.reason}`],
      }
    : baseReport;
  writeProspectiveProbabilityReports(report);
  console.log(JSON.stringify({
    status: report.status,
    evaluationStartAt: report.evaluationStartAt,
    resolved24h: report.comparison.resolved24h,
    resolved48h: report.comparison.resolved48h,
    targetResetCount: report.comparison.targetResetCount,
  }, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluateProspectiveProbabilityForecasts.ts") {
  void main();
}
