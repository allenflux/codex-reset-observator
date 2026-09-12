import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { PUBLISHED_ELAPSED_MODEL_OPTIONS } from "../data/shadowProbabilityConfig";
import { readCodexRecoveryObservations, readResetExecutionEstimates } from "../lib/codexUsageRecoveryStore";
import type { CodexRecoveryObservation } from "../lib/codexUsageRecovery";
import {
  getCompletedResetAt,
  getLocalRadarData,
} from "../lib/radar";
import {
  getPointInTimeRadarData,
} from "../lib/radar/prequentialCalibration";
import {
  getRegimeElapsedProbabilityWithoutSignals,
} from "../lib/radar/regimeElapsedProbability";
import {
  associateTiboNotices,
} from "../lib/radarFetch";
import {
  combineResetHistory,
  getNoticeBackedHistoryInputs,
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
  type RejectedTiboResetSignal,
  type TiboNoticeSignal,
} from "../lib/radar/tiboHistory";
import {
  isEligibleRandomResetEvent,
} from "../lib/radar/resetEligibility";
import type {
  RadarData,
  WindowEventLike,
} from "../lib/radar/types";
import type { RegularResetEventRow } from "../lib/radar/regularResetSchedule";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";
import {
  buildRollingCommunicationRegime,
  classifyCommunicationEvent,
  productionCommunicationSignalValidity,
  seededPermutation,
  type CommunicationClassification,
  type CommunicationCoverage,
  type CommunicationSignalInput,
  type CommunicationType,
  type SignalValidityPolicy,
} from "../lib/radar/communicationRegime";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COVERAGE_LOOKBACK_MS = 15 * 60 * 1000;
const PERMUTATION_ITERATIONS = 100_000;
const PERMUTATION_SEED = 20260814;
const LOG_LOSS_EPSILON = 1e-12;
const STUDY_OUTPUT_DIR = "scratch/communication-regime-study";

type JsonRecord = Record<string, unknown>;

type RawTiboSignal = FormalTiboResetSignal & {
  source_timeline?: string | null;
};

type HeartbeatRow = {
  id?: string | null;
  session_id?: string | null;
  session_started_at?: string | null;
  last_heartbeat_at?: string | null;
  last_successful_parse_at?: string | null;
  last_scan_error?: string | null;
  last_page_reload_status?: string | null;
  last_page_reload_error?: string | null;
  heartbeat_count?: number | null;
  max_gap_seconds?: number | null;
  updated_at?: string | null;
  newest_seen_tweet_created_at?: string | null;
};

type CoverageInterval = {
  startAt: string;
  endAt: string;
  status: "confirmed";
  reason: string;
};

type Dataset = {
  signals: RawTiboSignal[];
  regularResetEvents: RegularResetEventRow[];
  recoveryObservations: CodexRecoveryObservation[];
  resetExecutionEstimates: ResetExecutionEstimate[];
  heartbeat: HeartbeatRow | null;
  sourceErrors: string[];
};

type CanonicalSnapshot = {
  data: RadarData;
  combinedHistory: WindowEventLike[];
};

type CommunicationEventRow = {
  eventId: string;
  completedAt: string;
  previousRandomResetAt: string | null;
  elapsedSincePreviousRandomHours: number | null;
  title: string;
  recordKind: string | null;
  cycleType: string | null;
  reasonType: string | null;
  resetMethod: string | null;
  scope: string | null;
  sourceUrl: string | null;
  sourceTweetIds: string[];
  classification: CommunicationClassification;
};

type CoverageExposure = {
  confirmedIntervals: CoverageInterval[];
  confirmedExposureHours: number;
  unknownExposureHours: number;
  excludedScanFailureHours: number;
  policy: string;
};

type Outcome = boolean | null;

type OriginRow = {
  origin: string;
  state: CommunicationType | null;
  regime: CommunicationType | null;
  actual24h: Outcome;
  actual48h: Outcome;
  baseline24h: number;
  baseline48h: number;
  predictions: Record<string, { probability24h: number; probability48h: number }>;
  leakageViolations: string[];
};

type MetricSummary = {
  resolvedCount: number;
  positiveCount: number;
  actualRate: number | null;
  meanPrediction: number | null;
  brier: number | null;
  logLoss: number | null;
  auc: number | null;
  calibration: Array<{
    range: string;
    count: number;
    meanPrediction: number;
    actualRate: number;
  }>;
};

type EventClassificationCounts = Record<CommunicationType, number>;

function loadOptionalLocalEnv() {
  try {
    const processWithLoader = process as typeof process & {
      loadEnvFile?: (path?: string) => void;
    };
    processWithLoader.loadEnvFile?.(".env.local");
  } catch {
    // The script reports missing configuration as insufficient data.
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: unknown): string | null {
  const parsed = parseTimestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const valueKey = key(value);
    if (seen.has(valueKey)) return false;
    seen.add(valueKey);
    return true;
  });
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function escapeCsv(value: unknown) {
  const text = value === null || typeof value === "undefined" ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeSignalType(value: unknown): RawTiboSignal["signal_type"] {
  if (value === "official_notice" || value === "reset_executed" || value === "teaser" || value === "irrelevant") {
    return value;
  }
  return "irrelevant";
}

function toRawSignal(value: unknown): RawTiboSignal | null {
  const record = asRecord(value);
  if (!record) return null;
  const tweetId = typeof record.tweet_id === "string" ? record.tweet_id : null;
  const createdAt = typeof record.tweet_created_at === "string" ? record.tweet_created_at : null;
  if (!tweetId || !createdAt) return null;

  return {
    tweet_id: tweetId,
    text: typeof record?.text === "string" ? record.text : "",
    tweet_url: typeof record?.tweet_url === "string" ? record.tweet_url : "",
    tweet_created_at: createdAt,
    detected_at: typeof record.detected_at === "string" ? record.detected_at : null,
    expires_at: typeof record.expires_at === "string" ? record.expires_at : null,
    signal_type: safeSignalType(record.signal_type),
    confidence: asNumber(record.confidence),
    verification_status:
      record.verification_status === "confirmed" || record.verification_status === "rejected"
        ? record.verification_status
        : "auto_unverified",
    classification_source: typeof record.classification_source === "string" ? record.classification_source : null,
    rule_signal_type: typeof record.rule_signal_type === "string" ? record.rule_signal_type as RawTiboSignal["rule_signal_type"] : null,
    ai_signal_type: typeof record.ai_signal_type === "string" ? record.ai_signal_type as RawTiboSignal["ai_signal_type"] : null,
    ai_classification_status: typeof record.ai_classification_status === "string" ? record.ai_classification_status : null,
    ai_reset_type_ja: typeof record.ai_reset_type_ja === "string" ? record.ai_reset_type_ja : null,
    ai_notice_to_execution: typeof record.ai_notice_to_execution === "string" ? record.ai_notice_to_execution : null,
    ai_temporal_precision: typeof record.ai_temporal_precision === "string" ? record.ai_temporal_precision as RawTiboSignal["ai_temporal_precision"] : null,
    expected_start_at: typeof record.expected_start_at === "string" ? record.expected_start_at : null,
    expected_end_at: typeof record.expected_end_at === "string" ? record.expected_end_at : null,
    temporal_resolution_status: typeof record.temporal_resolution_status === "string" ? record.temporal_resolution_status as RawTiboSignal["temporal_resolution_status"] : null,
    ai_teaser_strength: typeof record.ai_teaser_strength === "string" ? record.ai_teaser_strength as RawTiboSignal["ai_teaser_strength"] : null,
    is_reply: record.is_reply === true,
    is_quote: record.is_quote === true,
    source_timeline: record.source_timeline === "profile" || record.source_timeline === "with_replies"
      ? record.source_timeline
      : null,
  };
}

function toRecentSignal(signal: RawTiboSignal) {
  return {
    ...signal,
    teaser_strength: signal.ai_teaser_strength ?? null,
  };
}

function toNoticeSignal(signal: RawTiboSignal): TiboNoticeSignal | null {
  if (signal.is_reply === true) return null;
  if (signal.signal_type !== "official_notice" && signal.signal_type !== "teaser") return null;
  return {
    tweet_id: signal.tweet_id,
    text: signal.text,
    tweet_url: signal.tweet_url,
    tweet_created_at: signal.tweet_created_at,
    signal_type: signal.signal_type,
    confidence: signal.confidence,
    verification_status: signal.verification_status,
    expires_at: signal.expires_at ?? null,
    ai_temporal_precision: signal.ai_temporal_precision ?? null,
    expected_start_at: signal.expected_start_at ?? null,
    expected_end_at: signal.expected_end_at ?? null,
    temporal_resolution_status: signal.temporal_resolution_status ?? null,
  };
}

function toRejectedSignal(signal: RawTiboSignal): RejectedTiboResetSignal | null {
  if (signal.signal_type !== "reset_executed" || signal.is_reply === true || signal.verification_status !== "rejected") {
    return null;
  }
  return {
    tweet_id: signal.tweet_id,
    tweet_url: signal.tweet_url,
    tweet_created_at: signal.tweet_created_at,
  };
}

function toCommunicationSignal(signal: RawTiboSignal): CommunicationSignalInput {
  return {
    tweetId: signal.tweet_id,
    signalType: signal.signal_type,
    tweetCreatedAt: signal.tweet_created_at,
    availableAt: signal.detected_at ?? signal.tweet_created_at,
    confidence: signal.confidence,
    verificationStatus: signal.verification_status,
    isReply: signal.is_reply === true,
  };
}

function getAvailabilityTime(signal: RawTiboSignal) {
  return parseTimestamp(signal.detected_at ?? signal.tweet_created_at);
}

function buildRadarData(dataset: Dataset, calculationNow: Date): RadarData {
  const rawSignals = dataset.signals;
  const acceptedResets = rawSignals.filter((signal) => isFormalTiboResetSignal(signal));
  const notices = rawSignals
    .map(toNoticeSignal)
    .filter((signal): signal is TiboNoticeSignal => Boolean(signal));
  const formalResets = associateTiboNotices(acceptedResets, notices);
  const rejectedResets = rawSignals
    .map(toRejectedSignal)
    .filter((signal): signal is RejectedTiboResetSignal => Boolean(signal));
  const sourceState = dataset.sourceErrors.length > 0 ? "degraded" : "ok";

  return getLocalRadarData({
    checkedAt: calculationNow.toISOString(),
    calculationNow,
    dataHealth: {
      overall: sourceState,
      checkedAt: calculationNow.toISOString(),
      sources: {
        supabaseSignals: { state: sourceState },
        openAIStatus: { state: "ok" },
      },
    },
    activeTiboSignals: rawSignals.map(toRecentSignal) as RadarData["active_tibo_signals"],
    recentTiboSignals: rawSignals.map(toRecentSignal) as RadarData["recent_tibo_signals"],
    formalTiboResets: formalResets,
    rejectedTiboResets: rejectedResets,
    regularResetEvents: dataset.regularResetEvents,
    resetExecutionEstimates: dataset.resetExecutionEstimates,
    codexRecoveryObservations: dataset.recoveryObservations,
  });
}

function getPointInTimeDatasetData(dataset: Dataset, fullData: RadarData, origin: Date): RadarData | null {
  const pointInTime = getPointInTimeRadarData(fullData, origin);
  if (!pointInTime) return null;

  const originTime = origin.getTime();
  const availableSignals = dataset.signals.filter((signal) => {
    const availableAt = getAvailabilityTime(signal);
    return availableAt !== null && availableAt <= originTime;
  });
  const notices = availableSignals
    .map(toNoticeSignal)
    .filter((signal): signal is TiboNoticeSignal => Boolean(signal));
  const formalResets = associateTiboNotices(
    availableSignals.filter((signal) => isFormalTiboResetSignal(signal)),
    notices,
  );
  const rejectedResets = availableSignals
    .map(toRejectedSignal)
    .filter((signal): signal is RejectedTiboResetSignal => Boolean(signal));

  return {
    ...pointInTime,
    active_tibo_signals: availableSignals.map(toRecentSignal) as RadarData["active_tibo_signals"],
    recent_tibo_signals: availableSignals.map(toRecentSignal) as RadarData["recent_tibo_signals"],
    formal_tibo_resets: formalResets,
    rejected_tibo_resets: rejectedResets,
  };
}

function getAllNoticeSignals(data: RadarData) {
  const values = [
    ...(data.recent_tibo_signals ?? []),
    ...(data.active_tibo_signals ?? []),
  ];
  const notices = values.flatMap((signal) => {
    if (signal.signal_type !== "official_notice" && signal.signal_type !== "teaser") return [];
    return [{
      tweet_id: signal.tweet_id,
      text: signal.text ?? "",
      tweet_url: signal.tweet_url ?? "",
      tweet_created_at: signal.tweet_created_at,
      signal_type: signal.signal_type,
      confidence: signal.confidence ?? null,
      verification_status: signal.verification_status ?? "auto_unverified",
      expires_at: signal.expires_at ?? null,
      ai_temporal_precision: signal.ai_temporal_precision ?? null,
      expected_start_at: signal.expected_start_at ?? null,
      expected_end_at: signal.expected_end_at ?? null,
      temporal_resolution_status: signal.temporal_resolution_status ?? null,
    } satisfies TiboNoticeSignal];
  });
  return uniqueBy(notices, (signal) => signal.tweet_id);
}

function getCombinedHistory(data: RadarData) {
  const { recoveryObservations, estimates, identityContext } = getNoticeBackedHistoryInputs(data);
  return combineResetHistory(
    LOCAL_RESET_HISTORY,
    data.formal_tibo_resets ?? [],
    data.rejected_tibo_resets ?? [],
    data.regular_reset_events ?? [],
    getAllNoticeSignals(data),
    recoveryObservations,
    estimates,
    [],
    identityContext,
  );
}

function buildCoverageIntervals(row: HeartbeatRow | null, asOf: Date): CoverageInterval[] {
  if (!row) return [];
  const sessionStarted = parseTimestamp(row.session_started_at);
  const lastHeartbeat = parseTimestamp(row.last_heartbeat_at);
  const lastParse = parseTimestamp(row.last_successful_parse_at);
  const reportAt = parseTimestamp(row.updated_at) ?? lastHeartbeat;
  if (sessionStarted === null || lastHeartbeat === null || lastParse === null || reportAt === null) return [];
  if (row.last_scan_error !== null || (row.last_page_reload_status !== null && row.last_page_reload_status !== "success")) return [];
  // `updated_at` and `last_successful_parse_at` are written by adjacent
  // operations and can differ by a few milliseconds. The parse timestamp is
  // still part of the same current snapshot, so use the later of the two but
  // never extend beyond the report's as-of boundary.
  const endAt = Math.min(Math.max(reportAt, lastParse), asOf.getTime());
  const startAt = Math.max(sessionStarted, lastParse - COVERAGE_LOOKBACK_MS);
  if (endAt <= startAt || endAt < sessionStarted || lastParse > endAt) return [];

  return [{
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(endAt).toISOString(),
    status: "confirmed",
    reason: "bounded by the latest successful parse and the mutable heartbeat snapshot",
  }];
}

function coverageForInterval(
  intervals: CoverageInterval[],
  startTime: number,
  endTime: number,
): CommunicationCoverage {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return "unknown";
  const overlapping = intervals.some((interval) => {
    const start = parseTimestamp(interval.startAt);
    const end = parseTimestamp(interval.endAt);
    return start !== null && end !== null && start < endTime && end > startTime;
  });
  const covered = intervals.some((interval) => {
    const start = parseTimestamp(interval.startAt);
    const end = parseTimestamp(interval.endAt);
    return start !== null && end !== null && start <= startTime && end >= endTime;
  });
  if (covered) return "confirmed";
  return overlapping ? "insufficient" : "unknown";
}

function getEventCompletedTime(event: WindowEventLike) {
  return parseTimestamp(getCompletedResetAt(event));
}

function getEventId(event: WindowEventLike, index: number) {
  return event.id ?? event.source_url ?? `${event.title ?? "event"}-${index}`;
}

function classifyEvents(
  events: WindowEventLike[],
  signals: CommunicationSignalInput[],
  intervals: CoverageInterval[],
  nowTime: number,
  validityPolicy: SignalValidityPolicy = productionCommunicationSignalValidity,
) {
  const eligible = events
    .filter((event) => {
      const completedTime = getEventCompletedTime(event);
      return isEligibleRandomResetEvent(event, completedTime, nowTime);
    })
    .map((event, index) => ({ event, index, completedTime: getEventCompletedTime(event)! }))
    .sort((left, right) => left.completedTime - right.completedTime);

  const rows: CommunicationEventRow[] = [];
  let previousRandomResetTime: number | null = null;
  for (let index = 0; index < eligible.length; index += 1) {
    const item = eligible[index];
    const event = item.event;
    const completedAt = new Date(item.completedTime).toISOString();
    const coverageStart = previousRandomResetTime ?? item.completedTime - 48 * HOUR_MS;
    const classification = classifyCommunicationEvent(
      {
        eventId: getEventId(event, index),
        completedAt,
        legacyNoticeType: event.details?.noticeType ?? null,
        legacyOpenedAt: event.opened_at ?? null,
        legacyWindowMinutes: typeof event.window_minutes === "number" ? event.window_minutes : null,
      },
      signals,
      {
        previousRandomResetAt: previousRandomResetTime === null
          ? null
          : new Date(previousRandomResetTime).toISOString(),
        coverage: coverageForInterval(intervals, coverageStart, item.completedTime),
        validityPolicy,
      },
    );
    rows.push({
      eventId: getEventId(event, index),
      completedAt,
      previousRandomResetAt: previousRandomResetTime === null ? null : new Date(previousRandomResetTime).toISOString(),
      elapsedSincePreviousRandomHours: previousRandomResetTime === null
        ? null
        : (item.completedTime - previousRandomResetTime) / HOUR_MS,
      title: (typeof event.title === "object" && event.title !== null ? event.title.ja : event.title) ?? "",
      recordKind: event.recordKind ?? null,
      cycleType: event.details?.cycleType ?? null,
      reasonType: event.details?.reasonType ?? null,
      resetMethod: event.details?.resetMethod ?? null,
      scope: event.scope ?? event.details?.scope ?? null,
      sourceUrl: event.source_url ?? null,
      sourceTweetIds: event.sourceTweetIds ?? [],
      classification,
    });
    previousRandomResetTime = item.completedTime;
  }
  return rows;
}

function getCounts(rows: CommunicationEventRow[]): EventClassificationCounts {
  return rows.reduce<EventClassificationCounts>((counts, row) => {
    if (!row.classification.classificationUsable) return counts;
    counts[row.classification.primaryType] += 1;
    return counts;
  }, { formal_notice: 0, teaser: 0, silent: 0 });
}

function getShares(counts: EventClassificationCounts) {
  const total = counts.formal_notice + counts.teaser + counts.silent;
  return {
    formal_notice: total ? counts.formal_notice / total : null,
    teaser: total ? counts.teaser / total : null,
    silent: total ? counts.silent / total : null,
    usableCount: total,
  };
}

function getRuns(rows: CommunicationEventRow[]) {
  const usable = rows.filter((row) => row.classification.classificationUsable);
  const runs: Array<{ type: CommunicationType; length: number; startAt: string; endAt: string }> = [];
  for (const row of usable) {
    const previous = runs.at(-1);
    if (previous?.type === row.classification.primaryType) {
      previous.length += 1;
      previous.endAt = row.completedAt;
    } else {
      runs.push({
        type: row.classification.primaryType,
        length: 1,
        startAt: row.completedAt,
        endAt: row.completedAt,
      });
    }
  }
  return {
    runCount: runs.length,
    longestRun: runs.reduce((max, run) => Math.max(max, run.length), 0),
    runs,
  };
}

function getTransitionMatrix(rows: CommunicationEventRow[]) {
  const matrix: Record<CommunicationType, Record<CommunicationType, number>> = {
    formal_notice: { formal_notice: 0, teaser: 0, silent: 0 },
    teaser: { formal_notice: 0, teaser: 0, silent: 0 },
    silent: { formal_notice: 0, teaser: 0, silent: 0 },
  };
  const usable = rows.filter((row) => row.classification.classificationUsable);
  for (let index = 1; index < usable.length; index += 1) {
    const from = usable[index - 1].classification.primaryType;
    const to = usable[index].classification.primaryType;
    matrix[from][to] += 1;
  }
  return matrix;
}

function getTransitionProbabilities(matrix: Record<CommunicationType, Record<CommunicationType, number>>) {
  return Object.fromEntries(Object.entries(matrix).map(([from, values]) => {
    const total = Object.values(values).reduce((sum, count) => sum + count, 0);
    return [from, Object.fromEntries(Object.entries(values).map(([to, count]) => [to, total ? count / total : null]))];
  }));
}

function transitionEntropy(labels: CommunicationType[]) {
  if (labels.length < 2) return null;
  const matrix: Record<CommunicationType, Record<CommunicationType, number>> = {
    formal_notice: { formal_notice: 0, teaser: 0, silent: 0 },
    teaser: { formal_notice: 0, teaser: 0, silent: 0 },
    silent: { formal_notice: 0, teaser: 0, silent: 0 },
  };
  for (let index = 1; index < labels.length; index += 1) matrix[labels[index - 1]][labels[index]] += 1;
  let weightedEntropy = 0;
  let totalTransitions = 0;
  for (const values of Object.values(matrix)) {
    const total = Object.values(values).reduce((sum, count) => sum + count, 0);
    if (total === 0) continue;
    let rowEntropy = 0;
    for (const count of Object.values(values)) {
      if (count === 0) continue;
      const probability = count / total;
      rowEntropy -= probability * Math.log2(probability);
    }
    weightedEntropy += rowEntropy * total;
    totalTransitions += total;
  }
  return totalTransitions ? weightedEntropy / totalTransitions : null;
}

function getSequenceStats(labels: CommunicationType[]) {
  let sameAdjacent = 0;
  let formalTeaserAdjacent = 0;
  let longestRun = 0;
  let currentRun = 0;
  let previous: CommunicationType | null = null;
  for (const label of labels) {
    if (label === previous) {
      sameAdjacent += 1;
      currentRun += 1;
    } else {
      if (previous !== null && ((previous === "formal_notice" && label === "teaser") || (previous === "teaser" && label === "formal_notice"))) {
        formalTeaserAdjacent += 1;
      }
      currentRun = 1;
    }
    longestRun = Math.max(longestRun, currentRun);
    previous = label;
  }
  return { sameAdjacent, formalTeaserAdjacent, longestRun };
}

function permutationSummary(labels: CommunicationType[]) {
  if (labels.length < 2) {
    return {
      iterations: PERMUTATION_ITERATIONS,
      seed: PERMUTATION_SEED,
      observed: null,
      nullMean: null,
      pValue: null,
      note: "insufficient usable event labels",
    };
  }
  const observed = getSequenceStats(labels);
  let sameAtLeast = 0;
  let formalTeaserAtLeast = 0;
  let longestAtLeast = 0;
  let entropyAtLeast = 0;
  let sameSum = 0;
  let formalTeaserSum = 0;
  let longestSum = 0;
  let entropySum = 0;
  const observedEntropy = transitionEntropy(labels);
  for (let iteration = 0; iteration < PERMUTATION_ITERATIONS; iteration += 1) {
    const shuffled = seededPermutation(labels, PERMUTATION_SEED + iteration);
    const stats = getSequenceStats(shuffled);
    sameSum += stats.sameAdjacent;
    formalTeaserSum += stats.formalTeaserAdjacent;
    longestSum += stats.longestRun;
    const entropy = transitionEntropy(shuffled) ?? 0;
    entropySum += entropy;
    if (stats.sameAdjacent >= observed.sameAdjacent) sameAtLeast += 1;
    if (stats.formalTeaserAdjacent >= observed.formalTeaserAdjacent) formalTeaserAtLeast += 1;
    if (stats.longestRun >= observed.longestRun) longestAtLeast += 1;
    if ((observedEntropy ?? 0) >= entropy) entropyAtLeast += 1;
  }
  return {
    iterations: PERMUTATION_ITERATIONS,
    seed: PERMUTATION_SEED,
    observed,
    nullMean: {
      sameAdjacent: sameSum / PERMUTATION_ITERATIONS,
      formalTeaserAdjacent: formalTeaserSum / PERMUTATION_ITERATIONS,
      longestRun: longestSum / PERMUTATION_ITERATIONS,
      transitionEntropy: entropySum / PERMUTATION_ITERATIONS,
    },
    pValue: {
      sameAdjacent: (sameAtLeast + 1) / (PERMUTATION_ITERATIONS + 1),
      formalTeaserAdjacent: (formalTeaserAtLeast + 1) / (PERMUTATION_ITERATIONS + 1),
      longestRun: (longestAtLeast + 1) / (PERMUTATION_ITERATIONS + 1),
      transitionEntropy: (entropyAtLeast + 1) / (PERMUTATION_ITERATIONS + 1),
    },
    note: "fixed-seed permutation is descriptive only; no inferential claim is made",
  };
}

function quantile(sorted: number[], probability: number) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function numericSummary(values: number[]) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    mean,
    min: sorted[0],
    max: sorted.at(-1)!,
    standardDeviation: Math.sqrt(variance),
    p5: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  };
}

function elapsedStats(rows: CommunicationEventRow[]) {
  const byType: Record<CommunicationType, number[]> = {
    formal_notice: [],
    teaser: [],
    silent: [],
  };
  for (const row of rows) {
    if (!row.classification.classificationUsable || row.elapsedSincePreviousRandomHours === null) continue;
    byType[row.classification.primaryType].push(row.elapsedSincePreviousRandomHours);
  }
  return Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, numericSummary(values)]));
}

function signalTimingSummary(rows: CommunicationEventRow[]) {
  const byType: Record<CommunicationType, number[]> = {
    formal_notice: [],
    teaser: [],
    silent: [],
  };
  for (const row of rows) {
    if (!row.classification.classificationUsable || row.classification.signalToExecutionHours === null) continue;
    byType[row.classification.primaryType].push(row.classification.signalToExecutionHours);
  }
  return Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, numericSummary(values)]));
}

function permutationMedianDifference(left: number[], right: number[], iterations = PERMUTATION_ITERATIONS) {
  if (left.length === 0 || right.length === 0) return null;
  const observed = (quantile(left.slice().sort((a, b) => a - b), 0.5) ?? 0) -
    (quantile(right.slice().sort((a, b) => a - b), 0.5) ?? 0);
  const combined = [...left, ...right];
  let exceedances = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const shuffled = seededPermutation(combined, PERMUTATION_SEED + 1000 + iteration);
    const shuffledLeft = shuffled.slice(0, left.length).sort((a, b) => a - b);
    const shuffledRight = shuffled.slice(left.length).sort((a, b) => a - b);
    const difference = (quantile(shuffledLeft, 0.5) ?? 0) - (quantile(shuffledRight, 0.5) ?? 0);
    if (Math.abs(difference) >= Math.abs(observed)) exceedances += 1;
  }
  return {
    observedMedianDifference: observed,
    iterations,
    seed: PERMUTATION_SEED + 1000,
    pValue: (exceedances + 1) / (iterations + 1),
    note: "exploratory permutation; the 72-hour split was not tuned from this result",
  };
}

function logCombination(n: number, k: number) {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  const m = Math.min(k, n - k);
  let result = 0;
  for (let index = 1; index <= m; index += 1) {
    result += Math.log(n - m + index) - Math.log(index);
  }
  return result;
}

function fisherExactTwoSided(a: number, b: number, c: number, d: number) {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  const observedLog = logCombination(row1, a) + logCombination(row2, c) - logCombination(total, col1);
  let probability = 0;
  for (let x = Math.max(0, col1 - row2); x <= Math.min(row1, col1); x += 1) {
    const logProbability = logCombination(row1, x) + logCombination(row2, col1 - x) - logCombination(total, col1);
    if (logProbability <= observedLog + 1e-12) probability += Math.exp(logProbability);
  }
  const corrected = [a, b, c, d].map((value) => value + 0.5);
  const correctedOdds = (corrected[0] * corrected[3]) / (corrected[1] * corrected[2]);
  const riskRatio = (a / Math.max(1, a + b)) / (c / Math.max(1, c + d));
  return {
    pValue: Math.min(1, probability),
    oddsRatioHaldane: correctedOdds,
    riskRatioWithZeroCellFloor: riskRatio,
    zeroCellCorrection: "Haldane-Anscombe +0.5 for odds ratio; risk ratio uses a one-count denominator floor only for zero-cell display",
  };
}

function elapsedAnalysis(rows: CommunicationEventRow[]) {
  const usable = rows.filter((row) => row.classification.classificationUsable && row.elapsedSincePreviousRandomHours !== null);
  const teaser = usable.filter((row) => row.classification.primaryType === "teaser");
  const nonTeaser = usable.filter((row) => row.classification.primaryType !== "teaser");
  const within72 = (row: CommunicationEventRow) => (row.elapsedSincePreviousRandomHours ?? Infinity) <= 72;
  const table = {
    teaserWithin72h: teaser.filter(within72).length,
    teaserOver72h: teaser.filter((row) => !within72(row)).length,
    nonTeaserWithin72h: nonTeaser.filter(within72).length,
    nonTeaserOver72h: nonTeaser.filter((row) => !within72(row)).length,
  };
  const formal = usable.filter((row) => row.classification.primaryType === "formal_notice");
  const silent = usable.filter((row) => row.classification.primaryType === "silent");
  const values = (selected: CommunicationEventRow[]) => selected.flatMap((row) => row.elapsedSincePreviousRandomHours === null ? [] : [row.elapsedSincePreviousRandomHours]);
  return {
    byType: elapsedStats(rows),
    within72h: {
      table,
      fisherExact: fisherExactTwoSided(table.teaserWithin72h, table.teaserOver72h, table.nonTeaserWithin72h, table.nonTeaserOver72h),
    },
    teaserVsNonTeaserMedianPermutation: permutationMedianDifference(values(teaser), values(nonTeaser)),
    formalVsSilentMedianPermutation: permutationMedianDifference(values(formal), values(silent)),
    note: "The 72-hour boundary is exploratory and is not treated as a confirmatory p-value.",
  };
}

function localTimeBreakdown(rows: CommunicationEventRow[]) {
  const zones = ["Asia/Tokyo", "America/Los_Angeles"];
  return Object.fromEntries(zones.map((timeZone) => {
    const byHour = Array.from({ length: 24 }, () => 0);
    const byWeekday = Array.from({ length: 7 }, () => 0);
    const hoursByType: Record<CommunicationType, number[]> = {
      formal_notice: [],
      teaser: [],
      silent: [],
    };
    for (const row of rows) {
      if (!row.classification.classificationUsable) continue;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        weekday: "short",
        hour12: false,
      }).formatToParts(new Date(row.completedAt));
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "");
      const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
      const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
      if (Number.isInteger(hour) && hour >= 0 && hour < 24) byHour[hour] += 1;
      if (weekdayIndex >= 0) byWeekday[weekdayIndex] += 1;
      if (Number.isInteger(hour) && hour >= 0 && hour < 24) hoursByType[row.classification.primaryType].push(hour);
    }
    const localStats = Object.fromEntries(Object.entries(hoursByType).map(([type, hours]) => {
      const count = hours.length;
      return [type, {
        count,
        medianHour: quantile(hours.slice().sort((a, b) => a - b), 0.5),
        amCount: hours.filter((hour) => hour < 12).length,
        pmCount: hours.filter((hour) => hour >= 12).length,
        before12Count: hours.filter((hour) => hour < 12).length,
        atOrAfter12Count: hours.filter((hour) => hour >= 12).length,
        before10Count: hours.filter((hour) => hour < 10).length,
        atOrAfter10Count: hours.filter((hour) => hour >= 10).length,
      }];
    }));
    return [timeZone, { byHour, byWeekday, byType: localStats }];
  }));
}

function periodBreakdown(rows: CommunicationEventRow[]) {
  const usable = rows.filter((row) => row.classification.classificationUsable);
  const periods = [
    { name: "early", rows: usable.slice(0, Math.ceil(usable.length / 3)) },
    { name: "middle", rows: usable.slice(Math.ceil(usable.length / 3), Math.ceil((usable.length * 2) / 3)) },
    { name: "recent", rows: usable.slice(Math.ceil((usable.length * 2) / 3)) },
  ];
  const summaries = periods.map(({ name, rows: periodRows }) => ({
    name,
    startAt: periodRows[0]?.completedAt ?? null,
    endAt: periodRows.at(-1)?.completedAt ?? null,
    count: periodRows.length,
    counts: getCounts(periodRows),
    shares: getShares(getCounts(periodRows)),
  }));
  const candidates = [] as Array<{ splitAfterIndex: number; leftAt: string; rightAt: string; distributionDifference: number }>;
  for (let split = 1; split < usable.length; split += 1) {
    const left = getShares(getCounts(usable.slice(0, split)));
    const right = getShares(getCounts(usable.slice(split)));
    const difference = ["formal_notice", "teaser", "silent"].reduce((sum, key) => {
      const leftValue = left[key as keyof typeof left];
      const rightValue = right[key as keyof typeof right];
      return sum + Math.abs((typeof leftValue === "number" ? leftValue : 0) - (typeof rightValue === "number" ? rightValue : 0));
    }, 0);
    candidates.push({
      splitAfterIndex: split,
      leftAt: usable[split - 1].completedAt,
      rightAt: usable[split].completedAt,
      distributionDifference: difference,
    });
  }
  return {
    periods: summaries,
    changePointCandidates: candidates.sort((left, right) => right.distributionDifference - left.distributionDifference).slice(0, 3),
    note: "early/middle/recent are descriptive index slices; change-point candidates are not used as predictive features",
  };
}

function regimeCandidates(rows: CommunicationEventRow[]) {
  const usable = rows.filter((row) => row.classification.classificationUsable);
  const definitions = [
    { name: "last-3-majority", window: 3, method: "majority" as const },
    { name: "last-5-majority", window: 5, method: "majority" as const },
    { name: "ewma-window-5", window: 5, method: "ewma" as const },
  ];
  return definitions.map((definition) => {
    const sequence = usable.map((_, index) => buildRollingCommunicationRegime(usable.map((row) => row.classification), index, definition).dominantType);
    const counts = sequence.reduce<Record<string, number>>((result, value) => {
      const key = value ?? "insufficient_prior_events";
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});
    return { ...definition, sequence, counts, note: "research-only candidate; no definition is selected for Production" };
  });
}

function markovMetrics(labels: CommunicationType[]) {
  const types: CommunicationType[] = ["formal_notice", "teaser", "silent"];
  const score = (predictions: Array<{ probabilities: Record<CommunicationType, number>; actual: CommunicationType }>) => {
    if (predictions.length === 0) return { count: 0, logLoss: null, brierLike: null, accuracy: null };
    let logLoss = 0;
    let brierLike = 0;
    let correct = 0;
    for (const prediction of predictions) {
      const p = Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, prediction.probabilities[prediction.actual]));
      logLoss -= Math.log(p);
      brierLike += types.reduce((sum, type) => sum + (prediction.probabilities[type] - Number(type === prediction.actual)) ** 2, 0);
      if (Object.entries(prediction.probabilities).sort((left, right) => right[1] - left[1])[0]?.[0] === prediction.actual) correct += 1;
    }
    return { count: predictions.length, logLoss: logLoss / predictions.length, brierLike: brierLike / predictions.length, accuracy: correct / predictions.length };
  };
  const prequential: Array<{ probabilities: Record<CommunicationType, number>; actual: CommunicationType }> = [];
  const loo: Array<{ probabilities: Record<CommunicationType, number>; actual: CommunicationType }> = [];
  const fit = (training: CommunicationType[], previous: CommunicationType | null) => {
    const counts = { formal_notice: 1, teaser: 1, silent: 1 } as Record<CommunicationType, number>;
    for (const value of training) counts[value] += 1;
    if (previous !== null) {
      const transitionCounts = { formal_notice: 1, teaser: 1, silent: 1 } as Record<CommunicationType, number>;
      const transitionTotal = 3;
      for (let index = 1; index < training.length; index += 1) {
        if (training[index - 1] === previous) {
          transitionCounts[training[index]] += 1;
        }
      }
      const denominator = transitionTotal + training.filter((_, index) => index > 0 && training[index - 1] === previous).length;
      return types.reduce<Record<CommunicationType, number>>((result, type) => {
        result[type] = transitionCounts[type] / denominator;
        return result;
      }, { formal_notice: 0, teaser: 0, silent: 0 });
    }
    const denominator = training.length + types.length;
    return types.reduce<Record<CommunicationType, number>>((result, type) => {
      result[type] = counts[type] / denominator;
      return result;
    }, { formal_notice: 0, teaser: 0, silent: 0 });
  };
  for (let index = 0; index < labels.length; index += 1) {
    const previous = index > 0 ? labels[index - 1] : null;
    prequential.push({ probabilities: fit(labels.slice(0, index), previous), actual: labels[index] });
    loo.push({ probabilities: fit(labels.filter((_, candidateIndex) => candidateIndex !== index), previous), actual: labels[index] });
  }
  return {
    prequential: score(prequential),
    looDiagnosticOnly: { ...score(loo), usesFutureRowsForEarlyOrigins: true, prospective: false, oos: false },
    baselineDescription: "Laplace/Dirichlet-smoothed global multinomial share",
    transitionDescription: "First-order previous-type conditional transition with Laplace smoothing",
  };
}

function reasonBreakdown(rows: CommunicationEventRow[]) {
  const result: Record<string, EventClassificationCounts> = {};
  for (const row of rows) {
    if (!row.classification.classificationUsable) continue;
    const reason = row.reasonType ?? "unknown";
    result[reason] ??= { formal_notice: 0, teaser: 0, silent: 0 };
    result[reason][row.classification.primaryType] += 1;
  }
  return result;
}

function silentCoverageAudit(rows: CommunicationEventRow[]) {
  const silentRows = rows.filter((row) => row.classification.primaryType === "silent");
  return {
    totalSilentPlaceholderRows: silentRows.length,
    usableSilentRows: silentRows.filter((row) => row.classification.classificationUsable).length,
    byCoverage: silentRows.reduce<Record<string, number>>((result, row) => {
      const key = row.classification.coverage;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {}),
    byProvenance: silentRows.reduce<Record<string, number>>((result, row) => {
      const key = row.classification.provenance;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {}),
    note: "A silent placeholder with unknown/insufficient coverage is not evidence of a true silent event.",
  };
}

function observedLegacyAgreementAudit(rows: CommunicationEventRow[]) {
  const comparable = rows.filter((row) => row.classification.observedType !== null && row.classification.legacyType !== null);
  return {
    comparableCount: comparable.length,
    agreementCount: comparable.filter((row) => row.classification.legacyAgreement === true).length,
    disagreementCount: comparable.filter((row) => row.classification.legacyAgreement === false).length,
    disagreements: comparable
      .filter((row) => row.classification.legacyAgreement === false)
      .map((row) => ({ eventId: row.eventId, completedAt: row.completedAt, observedType: row.classification.observedType, legacyType: row.classification.legacyType })),
  };
}

function recentHighConfidenceSubset(rows: CommunicationEventRow[], asOfTime: number) {
  const cutoff = asOfTime - 30 * DAY_MS;
  const recent = rows.filter((row) => parseTimestamp(row.completedAt)! >= cutoff);
  const highConfidence = recent.filter((row) => row.classification.classificationUsable && (
    row.classification.provenance === "observed_signal" || row.classification.coverage === "confirmed"
  ));
  return {
    cutoff: new Date(cutoff).toISOString(),
    recentEventCount: recent.length,
    highConfidenceEventCount: highConfidence.length,
    counts: getCounts(highConfidence),
    shares: getShares(getCounts(highConfidence)),
    eventIds: highConfidence.map((row) => row.eventId),
    note: "Recent subset is descriptive and not used to retune or publish any model.",
  };
}

function signalTimingRows(rows: CommunicationEventRow[]) {
  return rows
    .filter((row) => row.classification.classificationUsable && row.classification.signalToExecutionHours !== null)
    .map((row) => ({
      eventId: row.eventId,
      completedAt: row.completedAt,
      type: row.classification.primaryType,
      provenance: row.classification.provenance,
      signalToExecutionHours: row.classification.signalToExecutionHours,
      legacySignalAtUsable: row.classification.legacySignalAtUsable,
    }));
}

function isRegularEvent(event: WindowEventLike) {
  return event.recordKind === "regular_completed" || event.details?.cycleType === "定期リセット";
}

function eventIsRandom(event: WindowEventLike, nowTime: number) {
  const completedTime = getEventCompletedTime(event);
  return isEligibleRandomResetEvent(event, completedTime, nowTime);
}

function outcomeAt(
  originTime: number,
  horizonHours: number,
  history: WindowEventLike[],
  asOfTime: number,
): Outcome {
  const endTime = originTime + horizonHours * HOUR_MS;
  if (endTime > asOfTime) return null;
  const candidates = history.flatMap((event) => {
    const completedTime = getEventCompletedTime(event);
    if (completedTime === null || completedTime <= originTime || completedTime > endTime) return [];
    return [{ event, completedTime }];
  }).sort((left, right) => left.completedTime - right.completedTime);
  if (candidates.length === 0) return false;
  const firstTime = candidates[0].completedTime;
  const firstBoundary = candidates.filter((candidate) => candidate.completedTime === firstTime);
  if (firstBoundary.some((candidate) => eventIsRandom(candidate.event, asOfTime))) return true;
  if (firstBoundary.some((candidate) => isRegularEvent(candidate.event))) return null;
  return false;
}

function latestRandomResetAt(history: WindowEventLike[], originTime: number, asOfTime: number) {
  return history
    .flatMap((event) => {
      const completedTime = getEventCompletedTime(event);
      return completedTime !== null && completedTime <= originTime && eventIsRandom(event, asOfTime)
        ? [completedTime]
        : [];
    })
    .sort((left, right) => right - left)[0] ?? null;
}

function stateAtOrigin(
  originTime: number,
  history: WindowEventLike[],
  signals: RawTiboSignal[],
  asOfTime: number,
  coverage: CommunicationCoverage,
) {
  const latestRandom = latestRandomResetAt(history, originTime, asOfTime);
  const candidates = signals
    .filter((signal) => {
      const created = parseTimestamp(signal.tweet_created_at);
      const available = getAvailabilityTime(signal);
      return created !== null && available !== null && created < originTime && available <= originTime &&
        (latestRandom === null || created > latestRandom) &&
        productionCommunicationSignalValidity(toCommunicationSignal(signal));
    })
    .sort((left, right) => {
      const leftPriority = left.signal_type === "official_notice" ? 0 : 1;
      const rightPriority = right.signal_type === "official_notice" ? 0 : 1;
      return leftPriority - rightPriority || parseTimestamp(right.tweet_created_at)! - parseTimestamp(left.tweet_created_at)!;
    });
  if (candidates.some((signal) => signal.signal_type === "official_notice")) return "formal_notice" as const;
  if (candidates.some((signal) => signal.signal_type === "teaser")) return "teaser" as const;
  return coverage === "confirmed" ? "silent" as const : null;
}

function buildOrigins(asOfTime: number, intervals: CoverageInterval[], stepHours: number) {
  if (intervals.length === 0) return [];
  const start = Math.min(...intervals.map((interval) => parseTimestamp(interval.startAt)!));
  const end = asOfTime - 48 * HOUR_MS;
  const origins: string[] = [];
  const first = Math.ceil(start / (stepHours * HOUR_MS)) * stepHours * HOUR_MS;
  for (let cursor = first; cursor <= end; cursor += stepHours * HOUR_MS) {
    const covered = intervals.some((interval) => parseTimestamp(interval.startAt)! <= cursor && parseTimestamp(interval.endAt)! >= cursor);
    if (covered) origins.push(new Date(cursor).toISOString());
  }
  return origins;
}

function buildExposureSummary(
  intervals: CoverageInterval[],
  asOfTime: number,
  history: WindowEventLike[],
  signals: RawTiboSignal[],
) : CoverageExposure & { byState: Record<string, number> } {
  const byState: Record<string, number> = { formal_notice: 0, teaser: 0, silent: 0, unknown: 0 };
  let confirmedExposureHours = 0;
  for (const interval of intervals) {
    const start = parseTimestamp(interval.startAt)!;
    const end = Math.min(parseTimestamp(interval.endAt)!, asOfTime);
    const boundaries = [start, end, ...history.flatMap((event) => {
      const time = getEventCompletedTime(event);
      return time !== null && time > start && time < end ? [time] : [];
    })].sort((left, right) => left - right);
    for (let index = 1; index < boundaries.length; index += 1) {
      const segmentStart = boundaries[index - 1];
      const segmentEnd = boundaries[index];
      if (segmentEnd <= segmentStart) continue;
      const mid = segmentStart + (segmentEnd - segmentStart) / 2;
      const state = stateAtOrigin(mid, history, signals, asOfTime, "confirmed") ?? "unknown";
      const hours = (segmentEnd - segmentStart) / HOUR_MS;
      byState[state] += hours;
      confirmedExposureHours += hours;
    }
  }
  return {
    confirmedIntervals: intervals,
    confirmedExposureHours,
    unknownExposureHours: 0,
    excludedScanFailureHours: 0,
    policy: "Only bounded intervals immediately preceding the latest successful parse are confirmed; mutable session state is never projected backward across unrecorded scan history.",
    byState,
  };
}

function clampProbability(value: number) {
  return Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, value));
}

function applyOddsRatio(probability: number, ratio: number | null) {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return probability;
  const p = clampProbability(probability);
  const odds = p / (1 - p);
  const adjusted = odds * Math.min(4, Math.max(0.25, ratio));
  return adjusted / (1 + adjusted);
}

function rateRatio(rows: OriginRow[], state: CommunicationType | null, horizon: 24 | 48) {
  const eligible = rows.filter((row) => row.state === state && (horizon === 24 ? row.actual24h : row.actual48h) !== null);
  const all = rows.filter((row) => (horizon === 24 ? row.actual24h : row.actual48h) !== null);
  if (eligible.length === 0 || all.length === 0) return null;
  const positive = eligible.filter((row) => (horizon === 24 ? row.actual24h : row.actual48h) === true).length;
  const allPositive = all.filter((row) => (horizon === 24 ? row.actual24h : row.actual48h) === true).length;
  const stateRate = (positive + 1) / (eligible.length + 2);
  const allRate = (allPositive + 1) / (all.length + 2);
  return (stateRate / (1 - stateRate)) / (allRate / (1 - allRate));
}

function buildLooRows(rows: OriginRow[]) {
  return rows.map((row) => {
    const referenceRows = rows.filter((candidate) => candidate.origin !== row.origin);
    const stateRatio24 = rateRatio(referenceRows, row.state, 24);
    const stateRatio48 = rateRatio(referenceRows, row.state, 48);
    const regimeRatio24 = rateRatio(referenceRows, row.regime, 24);
    const regimeRatio48 = rateRatio(referenceRows, row.regime, 48);
    return {
      ...row,
      predictions: {
        baseline: row.predictions.baseline,
        currentSignal: {
          probability24h: applyOddsRatio(row.baseline24h, stateRatio24),
          probability48h: applyOddsRatio(row.baseline48h, stateRatio48),
        },
        priorRegime: {
          probability24h: applyOddsRatio(row.baseline24h, regimeRatio24),
          probability48h: applyOddsRatio(row.baseline48h, regimeRatio48),
        },
        signalAndRegime: {
          probability24h: applyOddsRatio(applyOddsRatio(row.baseline24h, stateRatio24), regimeRatio24),
          probability48h: applyOddsRatio(applyOddsRatio(row.baseline48h, stateRatio48), regimeRatio48),
        },
      },
    };
  });
}

function calculateAuc(pairs: Array<{ prediction: number; actual: boolean }>) {
  const positives = pairs.filter((pair) => pair.actual);
  const negatives = pairs.filter((pair) => !pair.actual);
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.prediction > negative.prediction) wins += 1;
      else if (positive.prediction === negative.prediction) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

function metricSummary(rows: OriginRow[], model: string, horizon: 24 | 48): MetricSummary {
  const scored = rows.flatMap((row) => {
    const actual = horizon === 24 ? row.actual24h : row.actual48h;
    const prediction = row.predictions[model]?.[horizon === 24 ? "probability24h" : "probability48h"];
    return actual === null || typeof prediction !== "number" ? [] : [{ actual, prediction }];
  });
  if (scored.length === 0) {
    return { resolvedCount: 0, positiveCount: 0, actualRate: null, meanPrediction: null, brier: null, logLoss: null, auc: null, calibration: [] };
  }
  const buckets = [
    { min: 0, max: 0.2, label: "0-20%" },
    { min: 0.2, max: 0.4, label: "20-40%" },
    { min: 0.4, max: 0.6, label: "40-60%" },
    { min: 0.6, max: 0.8, label: "60-80%" },
    { min: 0.8, max: 1.01, label: "80-100%" },
  ];
  const calibration = buckets.flatMap((bucket) => {
    const values = scored.filter((item) => item.prediction >= bucket.min && item.prediction < bucket.max);
    if (values.length === 0) return [];
    return [{
      range: bucket.label,
      count: values.length,
      meanPrediction: values.reduce((sum, item) => sum + item.prediction, 0) / values.length,
      actualRate: values.filter((item) => item.actual).length / values.length,
    }];
  });
  const positiveCount = scored.filter((item) => item.actual).length;
  return {
    resolvedCount: scored.length,
    positiveCount,
    actualRate: positiveCount / scored.length,
    meanPrediction: scored.reduce((sum, item) => sum + item.prediction, 0) / scored.length,
    brier: scored.reduce((sum, item) => sum + (item.prediction - Number(item.actual)) ** 2, 0) / scored.length,
    logLoss: scored.reduce((sum, item) => {
      const p = clampProbability(item.prediction);
      return sum - (item.actual ? Math.log(p) : Math.log(1 - p));
    }, 0) / scored.length,
    auc: calculateAuc(scored),
    calibration,
  };
}

function buildShadowRows(
  dataset: Dataset,
  fullData: RadarData,
  history: WindowEventLike[],
  intervals: CoverageInterval[],
  origins: string[],
  asOfTime: number,
) {
  const rows: OriginRow[] = [];
  for (const origin of origins) {
    const originTime = parseTimestamp(origin)!;
    const originDate = new Date(originTime);
    const pointData = getPointInTimeDatasetData(dataset, fullData, originDate);
    if (!pointData) continue;
    const pointHistory = getCombinedHistory(pointData);
    const pointCoverage = coverageForInterval(intervals, originTime - HOUR_MS, originTime);
    const state = stateAtOrigin(originTime, history, dataset.signals, asOfTime, pointCoverage);
    const pointSignals = dataset.signals
      .filter((signal) => (getAvailabilityTime(signal) ?? Infinity) <= originTime)
      .map(toCommunicationSignal);
    const pointEvents = classifyEvents(pointHistory, pointSignals, intervals, originTime);
    const regime = buildRollingCommunicationRegime(
      pointEvents.filter((row) => row.classification.classificationUsable).map((row) => row.classification),
      pointEvents.filter((row) => row.classification.classificationUsable).length,
      { window: 6, method: "ewma" },
    ).dominantType;
    const baseline = getRegimeElapsedProbabilityWithoutSignals(
      pointData,
      { now: originDate, activeOfficialNotice: null, staticHistory: LOCAL_RESET_HISTORY },
      PUBLISHED_ELAPSED_MODEL_OPTIONS,
    );
    const priorRows = rows.filter((row) => parseTimestamp(row.origin)! < originTime);
    const stateRatio24 = rateRatio(priorRows, state, 24);
    const stateRatio48 = rateRatio(priorRows, state, 48);
    const regimeRatio24 = rateRatio(priorRows, regime, 24);
    const regimeRatio48 = rateRatio(priorRows, regime, 48);
    const predictions = {
      baseline: {
        probability24h: baseline.probability24h,
        probability48h: baseline.probability48h,
      },
      currentSignal: {
        probability24h: applyOddsRatio(baseline.probability24h, stateRatio24),
        probability48h: applyOddsRatio(baseline.probability48h, stateRatio48),
      },
      priorRegime: {
        probability24h: applyOddsRatio(baseline.probability24h, regimeRatio24),
        probability48h: applyOddsRatio(baseline.probability48h, regimeRatio48),
      },
      signalAndRegime: {
        probability24h: applyOddsRatio(applyOddsRatio(baseline.probability24h, stateRatio24), regimeRatio24),
        probability48h: applyOddsRatio(applyOddsRatio(baseline.probability48h, stateRatio48), regimeRatio48),
      },
    };
    const leakageViolations: string[] = [];
    for (const signal of pointData.recent_tibo_signals ?? []) {
      const availableAt = parseTimestamp(signal.detected_at ?? signal.tweet_created_at);
      if (availableAt === null || availableAt > originTime) leakageViolations.push(`signal:${signal.tweet_id}`);
    }
    for (const estimate of pointData.reset_execution_estimates ?? []) {
      if ((parseTimestamp(estimate.createdAt) ?? Infinity) > originTime) leakageViolations.push(`estimate:${estimate.resetEventKey}`);
    }
    rows.push({
      origin,
      state,
      regime,
      actual24h: outcomeAt(originTime, 24, history, asOfTime),
      actual48h: outcomeAt(originTime, 48, history, asOfTime),
      baseline24h: baseline.probability24h,
      baseline48h: baseline.probability48h,
      predictions,
      leakageViolations,
    });
  }
  return rows;
}

function sensitivityRows(
  events: WindowEventLike[],
  signals: CommunicationSignalInput[],
  intervals: CoverageInterval[],
  asOfTime: number,
) {
  const policies: Array<{ name: string; policy: SignalValidityPolicy }> = [
    { name: "production", policy: productionCommunicationSignalValidity },
    {
      name: "permissive-sensitivity",
      policy: (signal) => signal.verificationStatus !== "rejected" && !signal.isReply &&
        ((signal.signalType === "official_notice" && (signal.confidence ?? 0) >= 0.9) ||
          (signal.signalType === "teaser" && (signal.confidence ?? 0) >= 0.7)),
    },
    {
      name: "strict-sensitivity",
      policy: (signal) => signal.verificationStatus !== "rejected" && !signal.isReply &&
        ((signal.signalType === "official_notice" && (signal.confidence ?? 0) >= 0.99) ||
          (signal.signalType === "teaser" && (signal.confidence ?? 0) >= 0.9)),
    },
  ];
  return policies.map(({ name, policy }) => {
    const rows = classifyEvents(events, signals, intervals, asOfTime, policy);
    const counts = getCounts(rows);
    return { name, counts, shares: getShares(counts), usableEvents: rows.filter((row) => row.classification.classificationUsable).length };
  });
}

function buildCanonicalSnapshot(dataset: Dataset, asOf: Date): CanonicalSnapshot {
  const data = buildRadarData(dataset, asOf);
  return { data, combinedHistory: getCombinedHistory(data) };
}

async function loadDataset(): Promise<Dataset> {
  loadOptionalLocalEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      signals: [],
      regularResetEvents: [],
      recoveryObservations: [],
      resetExecutionEstimates: [],
      heartbeat: null,
      sourceErrors: ["Supabase environment variables are not available."],
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const sourceErrors: string[] = [];
  const signalColumns = "tweet_id,text,tweet_url,tweet_created_at,detected_at,expires_at,signal_type,confidence,verification_status,classification_source,rule_signal_type,ai_signal_type,ai_classification_status,ai_reset_type_ja,ai_notice_to_execution,ai_teaser_strength,ai_temporal_precision,expected_start_at,expected_end_at,temporal_resolution_status,is_reply,is_quote,source_timeline";
  let signalResult: { data: unknown[] | null; error: unknown | null } = await supabase.from("tibo_signals").select(signalColumns).order("tweet_created_at", { ascending: true }).limit(5000) as unknown as { data: unknown[] | null; error: unknown | null };
  if (signalResult.error) {
    sourceErrors.push("tibo_signals query failed with the full research column set.");
    signalResult = await supabase.from("tibo_signals").select("tweet_id,text,tweet_url,tweet_created_at,detected_at,expires_at,signal_type,confidence,verification_status,classification_source,is_reply").order("tweet_created_at", { ascending: true }).limit(5000) as unknown as { data: unknown[] | null; error: unknown | null };
  }
  if (signalResult.error) sourceErrors.push("tibo_signals fallback query failed.");

  const regularResult = await supabase
    .from("regular_reset_events")
    .select("schedule_key,window_start_at,window_end_at,representative_at,scheduled_at,completed_at,cycle_type,reset_method,scope,record_kind,status,correction_reason,corrected_at")
    .order("completed_at", { ascending: true })
    .limit(1000);
  if (regularResult.error) sourceErrors.push("regular_reset_events query failed.");

  const heartbeatResult = await supabase
    .from("tibo_heartbeat")
    .select("id,session_id,session_started_at,last_heartbeat_at,last_successful_parse_at,last_scan_error,last_page_reload_status,last_page_reload_error,heartbeat_count,max_gap_seconds,updated_at,newest_seen_tweet_created_at")
    .eq("id", "main")
    .maybeSingle();
  if (heartbeatResult.error) sourceErrors.push("tibo_heartbeat query failed; historical coverage is unknown.");

  const observationsResult = await readCodexRecoveryObservations(supabase as SupabaseClient<any>);
  if (observationsResult.error) sourceErrors.push("codex_recovery_observations query failed.");
  const estimatesResult = await readResetExecutionEstimates(supabase as SupabaseClient<any>);
  if (estimatesResult.error) sourceErrors.push("reset_execution_estimates query failed.");

  return {
    signals: (signalResult.data ?? []).flatMap((value) => {
      const signal = toRawSignal(value);
      return signal ? [signal] : [];
    }),
    regularResetEvents: (regularResult.data ?? []) as RegularResetEventRow[],
    recoveryObservations: observationsResult.rows,
    resetExecutionEstimates: estimatesResult.rows,
    heartbeat: (heartbeatResult.data ?? null) as HeartbeatRow | null,
    sourceErrors,
  };
}

function getAsOfArgument() {
  const index = process.argv.indexOf("--as-of");
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && parseTimestamp(value) !== null ? new Date(parseTimestamp(value)!).toISOString() : new Date().toISOString();
}

function getOutputDirectoryArgument() {
  const index = process.argv.indexOf("--output-dir");
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && !value.startsWith("-") ? value : STUDY_OUTPUT_DIR;
}

function writeReports(report: JsonRecord, events: CommunicationEventRow[], transition: unknown, permutation: unknown, shadow: unknown, outputDirArgument = STUDY_OUTPUT_DIR) {
  const outputDir = join(process.cwd(), outputDirArgument);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDir, "permutation.json"), `${JSON.stringify(permutation, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDir, "shadow-evaluation.json"), `${JSON.stringify(shadow, null, 2)}\n`, "utf8");
  const eventHeader = ["event_id", "completed_at", "previous_random_reset_at", "elapsed_since_previous_random_hours", "title", "record_kind", "cycle_type", "reason_type", "reset_method", "scope", "source_url", "primary_type", "provenance", "classification_usable", "coverage", "observed_type", "legacy_type", "legacy_agreement", "legacy_signal_at_usable", "signal_to_execution_hours", "observed_signal_ids", "source_tweet_ids"];
  const eventLines = events.map((event) => [
    event.eventId,
    event.completedAt,
    event.previousRandomResetAt,
    event.elapsedSincePreviousRandomHours,
    event.title,
    event.recordKind,
    event.cycleType,
    event.reasonType,
    event.resetMethod,
    event.scope,
    event.sourceUrl,
    event.classification.primaryType,
    event.classification.provenance,
    event.classification.classificationUsable,
    event.classification.coverage,
    event.classification.observedType,
    event.classification.legacyType,
    event.classification.legacyAgreement,
    event.classification.legacySignalAtUsable,
    event.classification.signalToExecutionHours,
    event.classification.observedSignalIds.join("|"),
    event.sourceTweetIds.join("|"),
  ].map(escapeCsv).join(","));
  writeFileSync(join(outputDir, "events.csv"), `${eventHeader.join(",")}\n${eventLines.join("\n")}\n`, "utf8");
  const transitionLines = Object.entries(transition as Record<string, Record<string, number>>).flatMap(([from, values]) => Object.entries(values).map(([to, count]) => `${escapeCsv(from)},${escapeCsv(to)},${count}`));
  writeFileSync(join(outputDir, "transition.csv"), `from,to,count\n${transitionLines.join("\n")}\n`, "utf8");

  const md = [
    "# Tibo communication regime shadow study",
    "",
    `Generated at: ${String(report.generatedAt)}`,
    `As of: ${String(report.asOf)}`,
    "",
    "> Research-only analysis. It does not change the published probability model, UI, API, database, Gemini classification, or reset history.",
    "",
    "## Design safeguards",
    "",
    "- Primary classification uses Production signal validity policy; threshold variants are sensitivity analyses only.",
    "- Events with no observed signal and no legacy label under unknown coverage are retained as audit rows but excluded from communication shares and transitions.",
    "- The primary shadow evaluation is rolling/prequential and point-in-time. LOO is diagnostic-only and is explicitly not called prospective/OOS.",
    "- Parameter tuning from study outcomes is disabled; candidate features are shadow-only.",
    "- Coverage denominator uses only confirmed heartbeat coverage intervals. Unknown or scan-failure periods are excluded, not treated as silent.",
    "",
    "## Dataset and canonical history",
    "",
    "```json",
    JSON.stringify(report.dataset, null, 2),
    "```",
    "",
    "## Communication labels",
    "",
    "```json",
    JSON.stringify(report.communication, null, 2),
    "```",
    "",
    "## Coverage and denominator",
    "",
    "```json",
    JSON.stringify(report.coverage, null, 2),
    "```",
    "",
    "## Conditional reset outcomes",
    "",
    "```json",
    JSON.stringify(report.conditionalOutcomes, null, 2),
    "```",
    "",
    "## Shadow-only feature evaluation",
    "",
    "```json",
    JSON.stringify(report.shadowEvaluation, null, 2),
    "```",
    "",
    "## Leakage audit",
    "",
    "```json",
    JSON.stringify(report.leakageAudit, null, 2),
    "```",
    "",
    "## Conclusions and limits",
    "",
    "```json",
    JSON.stringify(report.conclusions, null, 2),
    "```",
    "",
    "## Production behavior",
    "",
    "The study uses the existing history/eligibility helpers and read-only Supabase queries. No public probability calculation or public DTO is called with the research labels.",
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "report.md"), `${md}\n`, "utf8");
}

async function main() {
  const asOf = new Date(getAsOfArgument());
  const outputDirectory = getOutputDirectoryArgument();
  const asOfTime = asOf.getTime();
  const dataset = await loadDataset();
  const canonical = buildCanonicalSnapshot(dataset, asOf);
  const communicationSignals = dataset.signals.map(toCommunicationSignal);
  const intervals = buildCoverageIntervals(dataset.heartbeat, asOf);
  const eventRows = classifyEvents(canonical.combinedHistory, communicationSignals, intervals, asOfTime);
  const usableEventRows = eventRows.filter((row) => row.classification.classificationUsable);
  const counts = getCounts(eventRows);
  const shares = getShares(counts);
  const eligibleRandomEventCount = eventRows.length;
  const originsDaily = buildOrigins(asOfTime, intervals, 24);
  const originsSixHour = buildOrigins(asOfTime, intervals, 6);
  const shadowRowsDaily = buildShadowRows(dataset, canonical.data, canonical.combinedHistory, intervals, originsDaily, asOfTime);
  const shadowRowsSixHour = buildShadowRows(dataset, canonical.data, canonical.combinedHistory, intervals, originsSixHour, asOfTime);
  const exposure = buildExposureSummary(intervals, asOfTime, canonical.combinedHistory, dataset.signals);
  const transitionMatrix = getTransitionMatrix(eventRows);
  const permutation = permutationSummary(usableEventRows.map((row) => row.classification.primaryType));
  const sensitivity = sensitivityRows(canonical.combinedHistory, communicationSignals, intervals, asOfTime);
  const sequence = usableEventRows.map((row) => ({
    eventId: row.eventId,
    completedAt: row.completedAt,
    communicationType: row.classification.primaryType,
    provenance: row.classification.provenance,
    coverage: row.classification.coverage,
  }));
  const markov = markovMetrics(usableEventRows.map((row) => row.classification.primaryType));
  const period = periodBreakdown(eventRows);
  const regimes = regimeCandidates(eventRows);
  const elapsed = elapsedAnalysis(eventRows);
  const recentSubset = recentHighConfidenceSubset(eventRows, asOfTime);
  const allLeakageViolations = [...shadowRowsDaily, ...shadowRowsSixHour].flatMap((row) => row.leakageViolations);
  const metricModels = ["baseline", "currentSignal", "priorRegime", "signalAndRegime"];
  const shadowMetricsDaily = Object.fromEntries(metricModels.map((model) => [model, {
    daily: { h24: metricSummary(shadowRowsDaily, model, 24), h48: metricSummary(shadowRowsDaily, model, 48) },
  }]));
  const shadowMetricsSixHour = Object.fromEntries(metricModels.map((model) => [model, {
    sixHourDiagnostic: { h24: metricSummary(shadowRowsSixHour, model, 24), h48: metricSummary(shadowRowsSixHour, model, 48) },
  }]));
  const looRows = buildLooRows(shadowRowsDaily);
  const looMetrics = Object.fromEntries(metricModels.map((model) => [model, {
    h24: metricSummary(looRows, model, 24),
    h48: metricSummary(looRows, model, 48),
  }]));
  const report: JsonRecord = {
    studyVersion: "communication-regime-shadow-v1",
    communicationRegimeStudyVersion: "communication-regime-shadow-v1",
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    sourceAsOf: asOf.toISOString(),
    backfilled: false,
    outputs: ["report.json", "report.md", "events.csv", "transition.csv", "permutation.json", "shadow-evaluation.json"].map((name) => join(outputDirectory, name)),
    status: shadowRowsDaily.length === 0 ? "insufficient_data" : "research_only",
    dataset: {
      rawTiboSignalCount: dataset.signals.length,
      rawResetExecutedSignalCount: dataset.signals.filter((signal) => signal.signal_type === "reset_executed").length,
      regularResetEventCount: dataset.regularResetEvents.length,
      recoveryObservationCount: dataset.recoveryObservations.length,
      resetExecutionEstimateCount: dataset.resetExecutionEstimates.length,
      canonicalHistoryCount: canonical.combinedHistory.length,
      eligibleRandomResetEventCount: eligibleRandomEventCount,
      staticLocalHistoryCount: LOCAL_RESET_HISTORY.length,
      formalTiboResetSignalIds: dataset.signals.filter((signal) => isFormalTiboResetSignal(signal)).map((signal) => signal.tweet_id),
      regularBoundaryList: dataset.regularResetEvents.map((row) => ({ scheduleKey: row.schedule_key, completedAt: row.completed_at, recordKind: row.record_kind, status: row.status })),
      resetExecutionEstimateList: dataset.resetExecutionEstimates.map((estimate) => ({ resetEventKey: estimate.resetEventKey, displayExecutionAt: estimate.displayExecutionAt, createdAt: estimate.createdAt ?? null, updatedAt: estimate.updatedAt ?? null })),
      dynamicNoticeBackedHistory: canonical.combinedHistory
        .filter((event) => event.presentation === "notice_backed_recovery")
        .map((event) => ({ id: event.id ?? null, completedAt: getCompletedResetAt(event), sourceTweetIds: event.sourceTweetIds ?? [] })),
      pointInTimeAvailabilityPolicy: "signal detected_at ?? tweet_created_at; execution estimates created_at/updated_at; regular events use existing prequential helper; static history is filtered by existing recovery-boundary helper",
      dedupe: {
        rawTiboSignalRows: dataset.signals.length,
        uniqueTweetIds: new Set(dataset.signals.map((signal) => signal.tweet_id)).size,
        canonicalHistoryRows: canonical.combinedHistory.length,
        eligibleRandomRows: eligibleRandomEventCount,
      },
      sourceErrors: dataset.sourceErrors,
      staticLocalHistoryUsed: true,
      dynamicSupabaseHistoryUsed: true,
    },
    communication: {
      primaryValidityPolicy: "Production policy: official_notice confidence >= 0.95; teaser confidence >= 0.80; rejected/replies excluded.",
      provenance: { observed_signal: eventRows.filter((row) => row.classification.provenance === "observed_signal").length, legacy_history: eventRows.filter((row) => row.classification.provenance === "legacy_history").length },
      classificationUsableCount: usableEventRows.length,
      classificationExcludedForUnknownCoverageCount: eventRows.length - usableEventRows.length,
      counts,
      shares,
      chronologicalSequence: sequence,
      transitionMatrix,
      transitionProbabilities: getTransitionProbabilities(transitionMatrix),
      runs: getRuns(eventRows),
      permutation,
      elapsedHours: elapsed.byType,
      elapsedAnalysis: elapsed,
      signalToExecution: signalTimingRows(eventRows),
      signalToExecutionSummary: signalTimingSummary(eventRows),
      localTime: localTimeBreakdown(eventRows),
      reasonType: reasonBreakdown(eventRows),
      silentCoverageAudit: silentCoverageAudit(eventRows),
      observedLegacyAgreement: observedLegacyAgreementAudit(eventRows),
      directTransitions: {
        formalNoticeToTeaser: transitionMatrix.formal_notice.teaser,
        teaserToFormalNotice: transitionMatrix.teaser.formal_notice,
      },
      periodConfounding: period,
      markov,
      communicationRegimeCandidates: regimes,
      recentHighConfidenceSubset: recentSubset,
      sensitivity,
      thresholdTuning: "forbidden; variants are predeclared sensitivity analyses only",
    },
    coverage: {
      heartbeatSnapshot: dataset.heartbeat ? {
        sessionStartedAt: dataset.heartbeat.session_started_at ?? null,
        lastHeartbeatAt: dataset.heartbeat.last_heartbeat_at ?? null,
        lastSuccessfulParseAt: dataset.heartbeat.last_successful_parse_at ?? null,
        lastScanError: dataset.heartbeat.last_scan_error ?? null,
        lastPageReloadStatus: dataset.heartbeat.last_page_reload_status ?? null,
        updatedAt: dataset.heartbeat.updated_at ?? null,
      } : null,
      confirmedIntervals: intervals,
      confirmedIntervalCount: intervals.length,
      policy: exposure.policy,
      confirmedExposureHours: exposure.confirmedExposureHours,
      unknownExposureHours: exposure.unknownExposureHours,
      excludedScanFailureHours: exposure.excludedScanFailureHours,
      byCommunicationStateExposureHours: exposure.byState,
      nonResetExposureDenominatorIncludesOnlyConfirmedCoverage: true,
      note: "tibo_heartbeat is a mutable single-row snapshot; no historical heartbeat/parse series was treated as retrospective coverage.",
    },
    conditionalOutcomes: {
      dailyOriginsJstStyle: { originCount: originsDaily.length, rows: shadowRowsDaily.length },
      sixHourOverlappingDiagnostic: { originCount: originsSixHour.length, rows: shadowRowsSixHour.length, overlapping: true },
      horizon24h: summarizeConditionalOutcomes(shadowRowsDaily, 24),
      horizon48h: summarizeConditionalOutcomes(shadowRowsDaily, 48),
      targetRandomResetCount: eligibleRandomEventCount,
      regularOnlyBoundariesAreCensored: true,
      coverageUnknownOriginsExcluded: true,
      confidenceIntervals: "Not estimated because no confirmed daily origins were available; no synthetic interval is reported.",
    },
    shadowEvaluation: {
      primary: "prequential/rolling point-in-time",
      dailyMetrics: shadowMetricsDaily,
      sixHourDiagnosticMetrics: shadowMetricsSixHour,
      looDiagnosticOnly: {
        usesFutureRowsForEarlyOrigins: true,
        isProspective: false,
        isOos: false,
        metrics: looMetrics,
      },
      features: {
        baseline: "published hazard-elapsed-v1 baseline without research communication adjustment",
        currentSignal: "state-conditioned empirical odds adjustment fitted only from prior confirmed origins",
        priorRegime: "rolling communication regime empirical odds adjustment fitted only from prior confirmed origins",
        signalAndRegime: "combined research-only adjustment; no production parameter reuse/change",
      },
      parameterTuning: false,
      insufficientDataReason: shadowRowsDaily.length === 0 ? "No daily origins were covered by the conservative heartbeat coverage policy." : null,
      bestShadowFeature: shadowRowsDaily.length === 0 ? null : metricModels
        .map((model) => ({ model, brier24h: metricSummary(shadowRowsDaily, model, 24).brier, brier48h: metricSummary(shadowRowsDaily, model, 48).brier }))
        .filter((entry) => entry.brier24h !== null && entry.brier48h !== null)
        .sort((left, right) => (left.brier24h! + left.brier48h!) - (right.brier24h! + right.brier48h!))[0]?.model ?? null,
    },
    leakageAudit: {
      policy: "availability-timestamps-v1",
      violations: uniqueBy(allLeakageViolations, (value) => value),
      violationCount: allLeakageViolations.length,
      futureSignalRowsExcludedByDetectedAt: true,
      futureEstimateRowsExcludedByCreatedAtAndUpdatedAt: true,
      futureRegularRowsExcludedByExistingPointInTimeHelper: true,
      futureStaticHistoryFilteredByExistingRecoveryBoundaryHelper: true,
      noBackfill: true,
    },
    productionSafety: {
      publishedProbabilityModelUntouched: true,
      publicDtoUntouched: true,
      databaseWrites: false,
      geminiCalls: false,
      uiChanges: false,
      automaticPublishOrRetune: false,
    },
    conclusions: {
      observedPatterns: [
        "The usable event sequence and observed/legacy provenance are descriptive only.",
        "No coverage-confirmed non-reset denominator or prequential scoring sample was available in this run.",
      ],
      likelyConfoundedOrUnresolved: [
        "Calendar period, historical ingestion coverage, and signal validity are not separable with the current snapshot-only heartbeat history.",
      ],
      productionRecommendation: "Do not connect communicationType or regime to the published model; continue shadow collection after historical heartbeat coverage is available.",
    },
  };

  writeReports(report, eventRows, transitionMatrix, permutation, report.shadowEvaluation, outputDirectory);
  console.log(JSON.stringify({
    outputDir: outputDirectory,
    status: report.status,
    asOf: report.asOf,
    rawSignals: dataset.signals.length,
    canonicalHistory: canonical.combinedHistory.length,
      eligibleRandomResetEvents: eligibleRandomEventCount,
    communicationCounts: counts,
    usableCommunicationEvents: usableEventRows.length,
    confirmedCoverageIntervals: intervals.length,
    dailyOrigins: originsDaily.length,
    dailyResolved24h: metricSummary(shadowRowsDaily, "baseline", 24).resolvedCount,
    dailyResolved48h: metricSummary(shadowRowsDaily, "baseline", 48).resolvedCount,
    databaseWrites: false,
  }, null, 2));
}

function summarizeConditionalOutcomes(rows: OriginRow[], horizon: 24 | 48) {
  const states: Array<CommunicationType | "unknown"> = ["formal_notice", "teaser", "silent", "unknown"];
  return Object.fromEntries(states.map((state) => {
    const selected = rows.filter((row) => (row.state ?? "unknown") === state);
    const values = selected.map((row) => horizon === 24 ? row.actual24h : row.actual48h).filter((value): value is boolean => value !== null);
    return [state, {
      exposureOriginCount: selected.length,
      resolvedCount: values.length,
      positiveCount: values.filter(Boolean).length,
      actualRate: values.length ? values.filter(Boolean).length / values.length : null,
    }];
  }));
}

main().catch((error) => {
  console.error("Communication regime study failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
