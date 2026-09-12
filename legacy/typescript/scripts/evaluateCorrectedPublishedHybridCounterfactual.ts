import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT } from "../data/shadowProbabilityConfig";
import {
  evaluateSavedArtifactHybridCounterfactual,
  type PublishedProspectiveMetric,
  type SavedArtifactHybridCounterfactualEvaluation,
} from "../lib/radar/prospectivePublishedModelEvaluation";
import { getShadowCompletedResetEvents } from "../lib/radar/shadowProbability";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  loadPredictionHistoryRows,
  loadProductionCanonicalRadarData,
} from "./evaluateProspectiveProbabilityForecasts";

const EXCLUDED_FALSE_POSITIVE_EVENT_ID =
  "usage-reset-512a8b31-e43e-4f91-b5e6-7023b87e80ec";
const REPORT_STEM = "prospective-published-hybrid-counterfactual-corrected-20260910";

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // Missing or unsupported local env files are reported by the loaders.
  }
}

function parseAsOf(args: Array<string>) {
  const index = args.indexOf("--as-of");
  const value = index >= 0 ? args[index + 1] : undefined;
  const asOf = value ? new Date(value) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${value}`);
  return asOf;
}

function formatNumber(value: number | null) {
  return value === null ? "unavailable" : value.toFixed(6);
}

function formatMetric(metric: PublishedProspectiveMetric) {
  return [
    `n=${metric.count}`,
    `positive=${metric.positiveCount}`,
    `actual=${formatNumber(metric.actualRate)}`,
    `mean=${formatNumber(metric.averagePrediction)}`,
    `bias=${formatNumber(metric.bias)}`,
    `brier=${formatNumber(metric.brier)}`,
    `logLoss=${formatNumber(metric.logLoss)}`,
  ].join(", ");
}

function writeMarkdown(
  report: SavedArtifactHybridCounterfactualEvaluation & {
    historyRowCount: number;
    falsePositiveEventExcluded: boolean;
    pointInTimeReplay: { usedForDecision: false; status: "diagnostic-only-not-used" };
  },
) {
  const lines = [
    "# Corrected Published Hybrid Evaluation",
    "",
    "This report is a saved-artifact retrospective counterfactual, not a prospective result.",
    "The historical report is intentionally left unchanged.",
    "",
    `- Evaluation mode: ${report.evaluationMode}`,
    `- Backfilled: ${report.backfilled}`,
    `- Generated at: ${report.generatedAt}`,
    `- As of: ${report.asOf}`,
    `- Historical adoption boundary: ${report.adoptionAt ?? "none"}`,
    `- Prediction history rows loaded: ${report.historyRowCount}`,
    `- Comparable saved rows: ${report.comparableRowCount}`,
    `- Daily-first origins: ${report.dailyOriginCount}`,
    `- Source model: ${report.sourceModelVersion}`,
    `- Companion model for comparable selection: ${report.companionModelVersion}`,
    `- Counterfactual model: ${report.hybridModelVersion}`,
    `- Point-in-time replay: ${report.pointInTimeReplay.status}; used for decision=${report.pointInTimeReplay.usedForDecision}`,
    "",
    "## Canonical truth audit",
    "",
    `- Excluded false-positive event: \`${EXCLUDED_FALSE_POSITIVE_EVENT_ID}\``,
    `- False-positive event absent from canonical truth: ${report.falsePositiveEventExcluded}`,
    `- Canonical random reset events after historical boundary: ${report.canonicalRandomResetEvents.length}`,
    ...(report.canonicalRandomResetEvents.length === 0
      ? ["- Events: none"]
      : report.canonicalRandomResetEvents.map((event) => `- ${event.id}: ${event.resetAt}`)),
    "",
    "## Saved-artifact retrospective counterfactual",
    "",
    `### Current v2 (${report.sourceModelVersion})`,
    `- 24h: ${formatMetric(report.models.v2.metrics24h)}`,
    `- 48h: ${formatMetric(report.models.v2.metrics48h)}`,
    "",
    `### Selective hybrid v3 (${report.hybridModelVersion})`,
    `- 24h: ${formatMetric(report.models.hybrid.metrics24h)}`,
    `- 48h: ${formatMetric(report.models.hybrid.metrics48h)}`,
    "",
    "### Hybrid minus v2",
    `- 24h Brier: ${formatNumber(report.comparison.brierHybridMinusV2.probability24h)}`,
    `- 48h Brier: ${formatNumber(report.comparison.brierHybridMinusV2.probability48h)}`,
    `- 24h Log loss: ${formatNumber(report.comparison.logLossHybridMinusV2.probability24h)}`,
    `- 48h Log loss: ${formatNumber(report.comparison.logLossHybridMinusV2.probability48h)}`,
    `- Target reset count: ${report.targetResetCount}`,
    `- Resolved horizons: 24h=${report.comparison.resolved24h}, 48h=${report.comparison.resolved48h}`,
    "",
    "## Per-origin diagnostics",
    "",
    "| origin | actual 24h | v2 24h | hybrid 24h | v2 48h | hybrid 48h | notice override | coherence |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...report.perOrigin.map((origin) =>
      `| ${origin.origin} | ${origin.actual24h ?? "unresolved"} | ${origin.v2Probability24h.toFixed(6)} | ${origin.hybridProbability24h.toFixed(6)} | ${origin.v2Probability48h.toFixed(6)} | ${origin.hybridProbability48h.toFixed(6)} | ${origin.officialNoticeOverride} | ${origin.hybridCoherenceAdjusted} |`),
    "",
    "## Saved-artifact audit",
    "",
    `- Coherence-adjusted origins: ${report.savedArtifactAudit.originsWithCoherenceAdjustment.length === 0 ? "none" : report.savedArtifactAudit.originsWithCoherenceAdjustment.join(", ")}`,
    `- Unexplained saved-final mismatches: ${report.savedArtifactAudit.originsWithUnexplainedSavedFinalMismatch.length === 0 ? "none" : JSON.stringify(report.savedArtifactAudit.originsWithUnexplainedSavedFinalMismatch)}`,
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  loadOptionalLocalEnv();
  const asOf = parseAsOf(process.argv.slice(2));
  const history = await loadPredictionHistoryRows();
  const production = await loadProductionCanonicalRadarData(asOf);
  if (!production.data) throw new Error(production.reason ?? "canonical data unavailable");
  const events = getShadowCompletedResetEvents(
    production.data,
    asOf,
    LOCAL_RESET_HISTORY,
    { preserveDistinctCanonicalIds: true },
  );
  const evaluation = evaluateSavedArtifactHybridCounterfactual(
    history.rows,
    events,
    asOf,
    { adoptionAt: PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT },
  );
  const falsePositiveEventExcluded = !events.some(
    (event) => event.id === EXCLUDED_FALSE_POSITIVE_EVENT_ID,
  );
  if (!falsePositiveEventExcluded) {
    throw new Error(`Canonical truth unexpectedly contains excluded event ${EXCLUDED_FALSE_POSITIVE_EVENT_ID}`);
  }
  const report = {
    ...evaluation,
    historyRowCount: history.rows.length,
    falsePositiveEventExcluded,
    pointInTimeReplay: {
      usedForDecision: false as const,
      status: "diagnostic-only-not-used" as const,
    },
  };
  const reportsDirectory = join(process.cwd(), "reports");
  mkdirSync(reportsDirectory, { recursive: true });
  writeFileSync(join(reportsDirectory, `${REPORT_STEM}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(reportsDirectory, `${REPORT_STEM}.md`), writeMarkdown(report), "utf8");
  console.log(JSON.stringify({
    report: REPORT_STEM,
    falsePositiveEventExcluded,
    canonicalRandomResetEvents: report.canonicalRandomResetEvents,
    historyRowCount: report.historyRowCount,
    comparableRowCount: report.comparableRowCount,
    dailyOriginCount: report.dailyOriginCount,
    v2: report.models.v2,
    hybrid: report.models.hybrid,
    comparison: report.comparison,
    coherenceOrigins: report.savedArtifactAudit.originsWithCoherenceAdjustment,
    unexplainedSavedFinalMismatch: report.savedArtifactAudit.originsWithUnexplainedSavedFinalMismatch,
  }, null, 2));
}

void main();
