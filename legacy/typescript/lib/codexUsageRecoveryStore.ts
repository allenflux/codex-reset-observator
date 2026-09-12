import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CODEX_USAGE_SOURCE_KEY,
  getPublicRecoveryObservation,
  isBankedResetAvailableCountGrant,
  type CodexRecoveryObservation,
  type CodexUsageSnapshot,
} from "./codexUsageRecovery";
import {
  getNextUsageMonitorCoverageStartedAt,
  type UsageMonitorState,
} from "./codexUsageMonitorCoverage";
import { getTiboClassificationSafetyDecision } from "./radar/classification";
import {
  buildResetExecutionEstimate,
  type ResetExecutionEstimate,
  type ResolveDisplayExecutionTimeInput,
} from "./radar/resetExecution";
import {
  BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
  BANKED_DISTRIBUTION_ESTIMATOR_VERSIONS,
} from "./radar/bankedReset";
import { createObservedRegularResetEventRow } from "./radar/regularResetSchedule";
import {
  findRelatedTiboNotices,
  selectRepresentativeTiboNotice,
  type FormalTiboResetSignal,
  type TiboNoticeSignal,
} from "./radar/tiboHistory";

export type CodexUsageMonitorStateRow = {
  source_key: string;
  observed_at: string;
  received_at: string;
  limit_id: string;
  plan_type: string;
  used_percent: number;
  window_duration_mins: number;
  resets_at: number;
  coverage_started_at: string | null;
  banked_reset_available_count?: number | null;
  last_banked_grant_at?: string | null;
  updated_at: string;
};

export type CodexRecoveryObservationRow = {
  id: string;
  source_key: string;
  observed_at: string;
  previous_observed_at: string | null;
  previous_used_percent: number;
  current_used_percent: number;
  previous_resets_at: number;
  current_resets_at: number;
  cycle_hint: "regular" | "unexpected" | "unknown";
  confidence: "strong" | "medium";
  status: "observed" | "confirmed" | "rejected";
  matched_tibo_tweet_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ResetExecutionEstimateRow = {
  id: string;
  reset_event_key: string;
  display_execution_at: string;
  execution_time_source: ResetExecutionEstimate["executionTimeSource"];
  execution_time_confidence: ResetExecutionEstimate["executionTimeConfidence"];
  execution_time_precision: ResetExecutionEstimate["executionTimePrecision"];
  execution_window_start_at: string | null;
  execution_window_end_at: string | null;
  recovery_observation_id: string | null;
  recovery_previous_observed_at: string | null;
  recovery_observed_at: string | null;
  tibo_announced_at: string | null;
  tibo_primary_tweet_id: string | null;
  tibo_source_tweet_ids: string[];
  official_notice_tweet_id: string | null;
  official_notice_at: string | null;
  estimator_version: string;
  manual_override_at: string | null;
  manual_override_by: string | null;
  manual_override_reason: string | null;
  manual_execution_at: string | null;
  manual_execution_precision: ResetExecutionEstimate["manualExecutionPrecision"];
  created_at: string;
  updated_at: string;
};

const STATE_COLUMNS = "source_key,observed_at,received_at,limit_id,plan_type,used_percent,window_duration_mins,resets_at,coverage_started_at,banked_reset_available_count,last_banked_grant_at,updated_at";
const LEGACY_COVERAGE_STATE_COLUMNS = "source_key,observed_at,received_at,limit_id,plan_type,used_percent,window_duration_mins,resets_at,coverage_started_at,updated_at";
const LEGACY_STATE_COLUMNS = "source_key,observed_at,received_at,limit_id,plan_type,used_percent,window_duration_mins,resets_at,updated_at";
const OBSERVATION_COLUMNS = "id,source_key,observed_at,previous_observed_at,previous_used_percent,current_used_percent,previous_resets_at,current_resets_at,cycle_hint,confidence,status,matched_tibo_tweet_id,confirmed_at,created_at,updated_at";
const EXECUTION_ESTIMATE_COLUMNS = "id,reset_event_key,display_execution_at,execution_time_source,execution_time_confidence,execution_time_precision,execution_window_start_at,execution_window_end_at,recovery_observation_id,recovery_previous_observed_at,recovery_observed_at,tibo_announced_at,tibo_primary_tweet_id,tibo_source_tweet_ids,official_notice_tweet_id,official_notice_at,estimator_version,manual_override_at,manual_override_by,manual_override_reason,manual_execution_at,manual_execution_precision,created_at,updated_at";

function isMissingBankedColumnError(
  error: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
) {
  return Boolean(
    error &&
      (error.code === "42703" || error.code === "PGRST204") &&
      /banked_reset_available_count|last_banked_grant_at/i.test(`${error.message ?? ""} ${error.details ?? ""}`),
  );
}

function isMissingCoverageColumnError(
  error: { code?: string | null; message?: string | null; details?: string | null } | null | undefined,
) {
  return Boolean(
    error &&
      (error.code === "42703" || error.code === "PGRST204") &&
      /coverage_started_at/i.test(`${error.message ?? ""} ${error.details ?? ""}`),
  );
}

export async function insertObservedRegularResetEvent(
  client: SupabaseClient<any>,
  scheduledAt: string,
  completedAt: string,
) {
  const row = createObservedRegularResetEventRow(scheduledAt, completedAt);
  const result = await client
    .from("regular_reset_events")
    .upsert(row, { onConflict: "schedule_key", ignoreDuplicates: true });
  return result.error;
}

export function toCodexUsageMonitorState(
  row: CodexUsageMonitorStateRow | null | undefined,
): UsageMonitorState | null {
  if (!row) return null;
  return {
    sourceKey: row.source_key,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    limitId: row.limit_id,
    planType: row.plan_type,
    usedPercent: row.used_percent,
    windowDurationMins: row.window_duration_mins,
    resetsAt: row.resets_at,
    coverageStartedAt: row.coverage_started_at ?? null,
    bankedResetAvailableCount: typeof row.banked_reset_available_count === "number"
      ? row.banked_reset_available_count
      : row.banked_reset_available_count === null
        ? null
        : undefined,
    lastBankedGrantAt: row.last_banked_grant_at ?? null,
  };
}

export function toCodexUsageSnapshot(row: CodexUsageMonitorStateRow | null | undefined): CodexUsageSnapshot | null {
  if (!row || row.source_key !== CODEX_USAGE_SOURCE_KEY) return null;
  if (row.limit_id && row.limit_id !== "codex") return null;
  if (row.window_duration_mins !== 10080 || !Number.isFinite(row.used_percent) || !Number.isInteger(row.resets_at)) return null;
  return {
    observedAt: row.observed_at,
    limitId: "codex",
    planType: row.plan_type ?? "plus",
    usedPercent: row.used_percent,
    windowDurationMins: 10080,
    resetsAt: row.resets_at,
    bankedResetAvailableCount: typeof row.banked_reset_available_count === "number"
      ? row.banked_reset_available_count
      : row.banked_reset_available_count === null
        ? null
        : undefined,
    lastBankedGrantAt: row.last_banked_grant_at ?? null,
  };
}

export function toCodexRecoveryObservation(row: CodexRecoveryObservationRow | null | undefined): CodexRecoveryObservation | null {
  if (!row || row.source_key !== CODEX_USAGE_SOURCE_KEY) return null;
  if (![
    "regular",
    "unexpected",
    "unknown",
  ].includes(row.cycle_hint)) return null;
  if (!(row.confidence === "strong" || row.confidence === "medium")) return null;
  if (!(row.status === "observed" || row.status === "confirmed" || row.status === "rejected")) return null;
  return {
    id: row.id,
    sourceKey: row.source_key,
    observedAt: row.observed_at,
    previousObservedAt: row.previous_observed_at,
    previousUsedPercent: row.previous_used_percent,
    currentUsedPercent: row.current_used_percent,
    previousResetsAt: row.previous_resets_at,
    currentResetsAt: row.current_resets_at,
    cycleHint: row.cycle_hint,
    confidence: row.confidence,
    status: row.status,
    matchedTiboTweetId: row.matched_tibo_tweet_id,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toResetExecutionEstimate(
  row: ResetExecutionEstimateRow | null | undefined,
): ResetExecutionEstimate | null {
  if (!row || typeof row.reset_event_key !== "string" || !row.display_execution_at) return null;
  if (!Array.isArray(row.tibo_source_tweet_ids)) return null;
  return {
    resetEventKey: row.reset_event_key,
    displayExecutionAt: row.display_execution_at,
    executionTimeSource: row.execution_time_source,
    executionTimeConfidence: row.execution_time_confidence,
    executionTimePrecision: row.execution_time_precision,
    executionWindowStartAt: row.execution_window_start_at,
    executionWindowEndAt: row.execution_window_end_at,
    recoveryObservationId: row.recovery_observation_id,
    recoveryPreviousObservedAt: row.recovery_previous_observed_at,
    recoveryObservedAt: row.recovery_observed_at,
    tiboAnnouncedAt: row.tibo_announced_at,
    tiboPrimaryTweetId: row.tibo_primary_tweet_id,
    tiboSourceTweetIds: row.tibo_source_tweet_ids,
    officialNoticeTweetId: row.official_notice_tweet_id,
    officialNoticeAt: row.official_notice_at,
    estimatorVersion: row.estimator_version,
    manualOverrideAt: row.manual_override_at,
    manualOverrideBy: row.manual_override_by,
    manualOverrideReason: row.manual_override_reason,
    manualExecutionAt: row.manual_execution_at,
    manualExecutionPrecision: row.manual_execution_precision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getNextUsageMonitorLastBankedGrantAt(
  previousState: UsageMonitorState | null | undefined,
  snapshot: CodexUsageSnapshot,
): string | null {
  const prevCount = previousState?.bankedResetAvailableCount;
  const currCount = snapshot.bankedResetAvailableCount;

  const isCountIncreased = isBankedResetAvailableCountGrant(prevCount, currCount);

  if (isCountIncreased) {
    return snapshot.observedAt;
  }

  if (snapshot.lastBankedGrantAt) {
    return snapshot.lastBankedGrantAt;
  }

  return previousState?.lastBankedGrantAt ?? null;
}

export type LatestBankedGrant = {
  resetEventKey: string | null;
  observedAt: string | null;
};

export async function findLatestBankedGrant(
  client: SupabaseClient<any>,
  observedAt: string,
  officialNoticeTweetId?: string | null,
): Promise<LatestBankedGrant | null> {
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time)) return null;

  let query = client
    .from("reset_execution_estimates")
    .select("reset_event_key,display_execution_at,created_at,tibo_announced_at,official_notice_tweet_id,official_notice_at")
    .in("estimator_version", [...BANKED_DISTRIBUTION_ESTIMATOR_VERSIONS])
    .lte("display_execution_at", observedAt)
  if (officialNoticeTweetId) {
    query = query.eq("official_notice_tweet_id", officialNoticeTweetId);
  }
  const result = await query
    .order("display_execution_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error || !result.data) {
    return null;
  }

  return {
    resetEventKey: typeof result.data.reset_event_key === "string"
      ? result.data.reset_event_key
      : null,
    observedAt: result.data.display_execution_at ?? result.data.created_at ?? null,
  };
}

export async function findLatestBankedGrantAt(
  client: SupabaseClient<any>,
  observedAt: string,
): Promise<string | null> {
  return (await findLatestBankedGrant(client, observedAt))?.observedAt ?? null;
}

export async function readCodexUsageMonitorState(client: SupabaseClient<any>) {
  let result = await client
    .from("codex_usage_monitor_state")
    .select(STATE_COLUMNS)
    .eq("source_key", CODEX_USAGE_SOURCE_KEY)
    .maybeSingle();

  if (isMissingBankedColumnError(result.error)) {
    result = await client
      .from("codex_usage_monitor_state")
      .select(LEGACY_COVERAGE_STATE_COLUMNS)
      .eq("source_key", CODEX_USAGE_SOURCE_KEY)
      .maybeSingle();
  }

  if (isMissingCoverageColumnError(result.error)) {
    result = await client
      .from("codex_usage_monitor_state")
      .select(LEGACY_STATE_COLUMNS)
      .eq("source_key", CODEX_USAGE_SOURCE_KEY)
      .maybeSingle();
  }

  return {
    row: toCodexUsageSnapshot(result.data as CodexUsageMonitorStateRow | null),
    state: toCodexUsageMonitorState(result.data as CodexUsageMonitorStateRow | null),
    error: result.error,
  };
}

export async function upsertCodexUsageMonitorState(
  client: SupabaseClient<any>,
  snapshot: CodexUsageSnapshot,
  receivedAt: string,
  previousState: UsageMonitorState | null | undefined = null,
) {
  const coverageStartedAt = getNextUsageMonitorCoverageStartedAt(previousState, snapshot);
  const lastBankedGrantAt = getNextUsageMonitorLastBankedGrantAt(previousState, snapshot);
  const bankedResetAvailableCount = snapshot.bankedResetAvailableCount !== undefined
    ? snapshot.bankedResetAvailableCount
    : previousState?.bankedResetAvailableCount !== undefined
      ? previousState.bankedResetAvailableCount
      : null;

  const payload = {
    source_key: CODEX_USAGE_SOURCE_KEY,
    observed_at: snapshot.observedAt,
    received_at: receivedAt,
    limit_id: snapshot.limitId,
    plan_type: snapshot.planType,
    used_percent: snapshot.usedPercent,
    window_duration_mins: snapshot.windowDurationMins,
    resets_at: snapshot.resetsAt,
    coverage_started_at: coverageStartedAt,
    banked_reset_available_count: bankedResetAvailableCount,
    last_banked_grant_at: lastBankedGrantAt,
    updated_at: receivedAt,
  };
  const legacyCoveragePayload = {
    source_key: CODEX_USAGE_SOURCE_KEY,
    observed_at: snapshot.observedAt,
    received_at: receivedAt,
    limit_id: snapshot.limitId,
    plan_type: snapshot.planType,
    used_percent: snapshot.usedPercent,
    window_duration_mins: snapshot.windowDurationMins,
    resets_at: snapshot.resetsAt,
    coverage_started_at: coverageStartedAt,
    updated_at: receivedAt,
  };
  const legacyPayload = {
    source_key: CODEX_USAGE_SOURCE_KEY,
    observed_at: snapshot.observedAt,
    received_at: receivedAt,
    limit_id: snapshot.limitId,
    plan_type: snapshot.planType,
    used_percent: snapshot.usedPercent,
    window_duration_mins: snapshot.windowDurationMins,
    resets_at: snapshot.resetsAt,
    updated_at: receivedAt,
  };

  let writePayload: typeof payload | typeof legacyCoveragePayload | typeof legacyPayload = payload;
  let insertResult = await client
    .from("codex_usage_monitor_state")
    .upsert(payload, { onConflict: "source_key", ignoreDuplicates: true });
  if (isMissingBankedColumnError(insertResult.error)) {
    writePayload = legacyCoveragePayload;
    insertResult = await client
      .from("codex_usage_monitor_state")
      .upsert(legacyCoveragePayload, { onConflict: "source_key", ignoreDuplicates: true });
  }
  if (isMissingCoverageColumnError(insertResult.error)) {
    writePayload = legacyPayload;
    insertResult = await client
      .from("codex_usage_monitor_state")
      .upsert(legacyPayload, { onConflict: "source_key", ignoreDuplicates: true });
  }
  if (insertResult.error) return insertResult.error;

  let updateResult = await client
    .from("codex_usage_monitor_state")
    .update(writePayload)
    .eq("source_key", CODEX_USAGE_SOURCE_KEY)
    .lt("observed_at", snapshot.observedAt);
  if (writePayload === payload && isMissingBankedColumnError(updateResult.error)) {
    writePayload = legacyCoveragePayload;
    updateResult = await client
      .from("codex_usage_monitor_state")
      .update(legacyCoveragePayload)
      .eq("source_key", CODEX_USAGE_SOURCE_KEY)
      .lt("observed_at", snapshot.observedAt);
  }
  if (writePayload === legacyCoveragePayload && isMissingCoverageColumnError(updateResult.error)) {
    writePayload = legacyPayload;
    updateResult = await client
      .from("codex_usage_monitor_state")
      .update(legacyPayload)
      .eq("source_key", CODEX_USAGE_SOURCE_KEY)
      .lt("observed_at", snapshot.observedAt);
  }
  if (updateResult.error) return updateResult.error;
  return null;
}

export async function insertCodexRecoveryObservation(
  client: SupabaseClient<any>,
  observation: Omit<CodexRecoveryObservation, "id" | "createdAt" | "updatedAt">,
) {
  const result = await client
    .from("codex_recovery_observations")
    .upsert({
      source_key: observation.sourceKey,
      observed_at: observation.observedAt,
      previous_observed_at: observation.previousObservedAt ?? null,
      previous_used_percent: observation.previousUsedPercent,
      current_used_percent: observation.currentUsedPercent,
      previous_resets_at: observation.previousResetsAt,
      current_resets_at: observation.currentResetsAt,
      cycle_hint: observation.cycleHint,
      confidence: observation.confidence,
      status: observation.status,
      matched_tibo_tweet_id: observation.matchedTiboTweetId ?? null,
      confirmed_at: observation.confirmedAt ?? null,
      updated_at: observation.confirmedAt ?? observation.observedAt,
    }, { onConflict: "source_key,observed_at,current_resets_at" })
    .select(OBSERVATION_COLUMNS)
    .maybeSingle();
  return {
    observation: toCodexRecoveryObservation(result.data as CodexRecoveryObservationRow | null),
    error: result.error,
  };
}

export async function findRecentFormalTiboReset(
  client: SupabaseClient<any>,
  observedAt: string,
  matchWindowMs: number,
) {
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time)) {
    return { tweetId: null, tweetCreatedAt: null, needsPromotion: false, confidence: null, error: null };
  }

  const result = await client
    .from("tibo_signals")
    .select("tweet_id,text,tweet_created_at,signal_type,confidence,verification_status,classification_source,rule_signal_type,rule_confidence,ai_signal_type,ai_confidence,is_reply")
    .or("signal_type.eq.reset_executed,rule_signal_type.eq.reset_executed,ai_signal_type.eq.reset_executed")
    .eq("is_reply", false)
    .neq("verification_status", "rejected")
    .gte("tweet_created_at", new Date(time - matchWindowMs).toISOString())
    .lte("tweet_created_at", new Date(time + matchWindowMs).toISOString())
    .order("tweet_created_at", { ascending: true })
    .limit(20);

  if (result.error) {
    return { tweetId: null, tweetCreatedAt: null, needsPromotion: false, confidence: null, error: result.error };
  }

  const candidates = (result.data ?? [])
    .filter((row) => {
      if (typeof row.tweet_id !== "string" || typeof row.tweet_created_at !== "string") return false;
      if (getTiboClassificationSafetyDecision(String(row.text ?? ""), "reset_executed").signalType !== "reset_executed") {
        return false;
      }

      const finalReset = row.signal_type === "reset_executed" && Number(row.confidence) >= 0.95;
      const deferredReset = row.signal_type === "irrelevant" && (
        (row.ai_signal_type === "reset_executed" && Number(row.ai_confidence) >= 0.95) ||
        (row.rule_signal_type === "reset_executed" && Number(row.rule_confidence) >= 0.95)
      );
      return finalReset || deferredReset;
    })
    .sort((left, right) => Math.abs(Date.parse(left.tweet_created_at) - time) - Math.abs(Date.parse(right.tweet_created_at) - time));
  const candidate = candidates[0];
  return {
    tweetId: candidate?.tweet_id ?? null,
    tweetCreatedAt: candidate?.tweet_created_at ?? null,
    needsPromotion: candidate?.signal_type === "irrelevant",
    confidence: candidate
      ? candidate.signal_type === "irrelevant"
        ? candidate.ai_signal_type === "reset_executed"
          ? Number(candidate.ai_confidence)
          : Number(candidate.rule_confidence)
        : Number(candidate.confidence)
      : null,
    error: null,
  };
}

export async function findNearestCodexRecoveryObservation(
  client: SupabaseClient<any>,
  tiboTweetCreatedAt: string,
  matchWindowMs: number,
) {
  const time = Date.parse(tiboTweetCreatedAt);
  if (!Number.isFinite(time)) return { observation: null, error: null };

  const result = await client
    .from("codex_recovery_observations")
    .select(OBSERVATION_COLUMNS)
    .in("status", ["observed", "confirmed"])
    .eq("cycle_hint", "unexpected")
    .gte("observed_at", new Date(time - matchWindowMs).toISOString())
    .lte("observed_at", new Date(time + matchWindowMs).toISOString())
    .order("observed_at", { ascending: true })
    .limit(20);

  if (result.error) return { observation: null, error: result.error };

  const candidates = (result.data ?? [])
    .map((row) => toCodexRecoveryObservation(row as CodexRecoveryObservationRow))
    .filter((row): row is CodexRecoveryObservation => Boolean(row))
    .sort((left, right) => Math.abs(Date.parse(left.observedAt) - time) - Math.abs(Date.parse(right.observedAt) - time));

  return { observation: candidates[0] ?? null, error: null };
}

export async function promoteDeferredTiboReset(
  client: SupabaseClient<any>,
  tweetId: string,
  confidence: number,
) {
  return client
    .from("tibo_signals")
    .update({
      signal_type: "reset_executed",
      confidence,
      classification_reason: "Usage Monitorで意味のあるquota recoveryが確認されたため、正式resetとして採用しました。",
    })
    .eq("tweet_id", tweetId)
    .eq("signal_type", "irrelevant")
    .neq("verification_status", "rejected");
}

export async function confirmNearestCodexRecoveryObservation(
  client: SupabaseClient<any>,
  tiboTweetId: string,
  tiboTweetCreatedAt: string,
  matchWindowMs: number,
  confirmedAt: string,
  tiboTweetIds: readonly string[] = [tiboTweetId],
) {
  const time = Date.parse(tiboTweetCreatedAt);
  if (!Number.isFinite(time)) return { matched: false, observation: null, error: null };

  const result = await client
    .from("codex_recovery_observations")
    .select(OBSERVATION_COLUMNS)
    .eq("source_key", CODEX_USAGE_SOURCE_KEY)
    .eq("status", "observed")
    .eq("cycle_hint", "unexpected")
    .gte("observed_at", new Date(time - matchWindowMs).toISOString())
    .lte("observed_at", new Date(time + matchWindowMs).toISOString())
    .order("observed_at", { ascending: true })
    .limit(20);

  if (result.error) return { matched: false, observation: null, error: result.error };

  const candidates = (result.data ?? [])
    .map((row) => toCodexRecoveryObservation(row as CodexRecoveryObservationRow))
    .filter((row): row is CodexRecoveryObservation => Boolean(row && (row.confidence === "strong" || row.confidence === "medium")))
    .sort((left, right) => Math.abs(Date.parse(left.observedAt) - time) - Math.abs(Date.parse(right.observedAt) - time));
  const nearest = candidates[0];
  if (!nearest?.id) {
    const confirmedResult = await client
      .from("codex_recovery_observations")
      .select(OBSERVATION_COLUMNS)
      .eq("source_key", CODEX_USAGE_SOURCE_KEY)
      .eq("status", "confirmed")
      .eq("cycle_hint", "unexpected")
      .order("observed_at", { ascending: false })
      .limit(100);
    if (confirmedResult.error) {
      return { matched: false, observation: null, error: confirmedResult.error };
    }

    const confirmed = (confirmedResult.data ?? [])
      .map((row) => toCodexRecoveryObservation(row as CodexRecoveryObservationRow))
      .filter((row): row is CodexRecoveryObservation => Boolean(row))
      .filter((row) => {
        const observedTime = Date.parse(row.observedAt);
        const matchedTiboTweetId = row.matchedTiboTweetId?.trim() || null;
        return tiboTweetIds.includes(matchedTiboTweetId ?? "") ||
          (!matchedTiboTweetId && Number.isFinite(observedTime) && Math.abs(observedTime - time) <= matchWindowMs);
      })
      .sort((left, right) => Math.abs(Date.parse(left.observedAt) - time) - Math.abs(Date.parse(right.observedAt) - time));

    return {
      matched: Boolean(confirmed[0]),
      observation: confirmed[0] ?? null,
      error: null,
    };
  }

  const update = await client
    .from("codex_recovery_observations")
    .update({
      status: "confirmed",
      matched_tibo_tweet_id: tiboTweetId,
      confirmed_at: confirmedAt,
      updated_at: confirmedAt,
    })
    .eq("id", nearest.id)
    .eq("status", "observed")
    .select(OBSERVATION_COLUMNS)
    .maybeSingle();
  if (update.error) {
    return { matched: false, observation: null, error: update.error };
  }

  const updatedObservation = toCodexRecoveryObservation(
    update.data as CodexRecoveryObservationRow | null,
  );
  if (updatedObservation) {
    return {
      matched: true,
      observation: updatedObservation,
      error: null,
    };
  }

  // A zero-row CAS result means another request won the observation. Re-read
  // the same recovery event before treating the confirmation as successful.
  const currentResult = await client
    .from("codex_recovery_observations")
    .select(OBSERVATION_COLUMNS)
    .eq("id", nearest.id)
    .maybeSingle();
  if (currentResult.error) {
    return { matched: false, observation: null, error: currentResult.error };
  }
  const currentObservation = toCodexRecoveryObservation(
    currentResult.data as CodexRecoveryObservationRow | null,
  );
  if (
    currentObservation?.status === "confirmed" &&
    tiboTweetIds.includes(currentObservation.matchedTiboTweetId ?? "")
  ) {
    return {
      matched: true,
      observation: currentObservation,
      error: null,
    };
  }

  return {
    matched: false,
    observation: null,
    error: new Error("Recovery observation confirmation lost its CAS race"),
  };
}

export async function findFormalTiboResetCluster(
  client: SupabaseClient<any>,
  tiboTweetId: string,
  tiboTweetCreatedAt: string,
  clusterWindowMs = 5 * 60 * 1000,
  promotionCandidate?: {
    tweet_id: string;
    tweet_created_at: string;
    confidence: number;
  },
) {
  const time = Date.parse(tiboTweetCreatedAt);
  const fallback = (error: unknown = null) => ({
    primaryTweetId: tiboTweetId,
    representativeTweetId: tiboTweetId,
    representativeNoticeId: null,
    representativeNoticeAt: null,
    sourceTweetIds: [tiboTweetId],
    announcedAt: tiboTweetCreatedAt,
    error,
  });
  if (!Number.isFinite(time)) {
    return fallback();
  }

  const result = await client
    .from("tibo_signals")
    .select("tweet_id,tweet_created_at,signal_type,confidence,verification_status,is_reply")
    .eq("signal_type", "reset_executed")
    .eq("is_reply", false)
    .neq("verification_status", "rejected")
    .gte("tweet_created_at", new Date(time - clusterWindowMs).toISOString())
    .lte("tweet_created_at", new Date(time + clusterWindowMs).toISOString())
    .order("tweet_created_at", { ascending: true })
    .limit(20);

  if (result.error) {
    return fallback(result.error);
  }

  const candidates = [
    ...(result.data ?? []),
    ...(promotionCandidate
      ? [{
          tweet_id: promotionCandidate.tweet_id,
          tweet_created_at: promotionCandidate.tweet_created_at,
          confidence: promotionCandidate.confidence,
        }]
      : []),
  ]
    .filter((row) =>
      typeof row.tweet_id === "string" &&
      typeof row.tweet_created_at === "string" &&
      Number(row.confidence) >= 0.95,
    )
    .sort((left, right) => Date.parse(left.tweet_created_at) - Date.parse(right.tweet_created_at));
  const primary = candidates[0] ?? {
    tweet_id: tiboTweetId,
    tweet_created_at: tiboTweetCreatedAt,
  };

  const noticeResult = await client
    .from("tibo_signals")
    .select("tweet_id,text,tweet_url,tweet_created_at,signal_type,confidence,verification_status,is_reply,expires_at,ai_temporal_expression,ai_temporal_kind,ai_temporal_precision,ai_temporal_timezone,temporal_expression,temporal_kind,temporal_precision,temporal_timezone,temporal_confidence,temporal_resolution_source,expected_start_at,expected_end_at,temporal_resolution_status")
    .eq("signal_type", "official_notice")
    .eq("is_reply", false)
    .neq("verification_status", "rejected")
    .gte("tweet_created_at", new Date(time - 48 * 60 * 60 * 1000).toISOString())
    .lt("tweet_created_at", new Date(time).toISOString())
    .order("tweet_created_at", { ascending: true })
    .limit(100);
  if (noticeResult.error) return fallback(noticeResult.error);

  const notices = (noticeResult.data ?? [])
    .filter((row) =>
      typeof row.tweet_id === "string" &&
      typeof row.text === "string" &&
      typeof row.tweet_url === "string" &&
      typeof row.tweet_created_at === "string",
    )
    .map((row): TiboNoticeSignal => ({
      tweet_id: row.tweet_id,
      text: row.text,
      tweet_url: row.tweet_url,
      tweet_created_at: row.tweet_created_at,
      signal_type: "official_notice",
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      verification_status: row.verification_status === "confirmed" || row.verification_status === "rejected"
        ? row.verification_status
        : "auto_unverified",
      expires_at: row.expires_at ?? null,
      ai_temporal_expression: row.ai_temporal_expression ?? null,
      ai_temporal_kind: row.ai_temporal_kind ?? null,
      ai_temporal_precision: row.ai_temporal_precision ?? null,
      ai_temporal_timezone: row.ai_temporal_timezone ?? null,
      temporal_expression: row.temporal_expression ?? null,
      temporal_kind: row.temporal_kind ?? null,
      temporal_precision: row.temporal_precision ?? null,
      temporal_timezone: row.temporal_timezone ?? null,
      temporal_confidence: row.temporal_confidence ?? null,
      temporal_resolution_source: row.temporal_resolution_source ?? null,
      expected_start_at: row.expected_start_at ?? null,
      expected_end_at: row.expected_end_at ?? null,
      temporal_resolution_status: row.temporal_resolution_status ?? null,
    }));
  const resetSignal = {
    tweet_id: tiboTweetId,
    text: "",
    tweet_url: `https://x.com/thsottiaux/status/${tiboTweetId}`,
    tweet_created_at: tiboTweetCreatedAt,
    signal_type: "reset_executed" as const,
    confidence: 1,
    verification_status: "auto_unverified" as const,
  } satisfies FormalTiboResetSignal;
  const relatedNotices = findRelatedTiboNotices(resetSignal, notices);
  const representativeNotice = selectRepresentativeTiboNotice(relatedNotices);
  const timestampByTweetId = new Map<string, number>([
    ...candidates.map((row) => [row.tweet_id, Date.parse(row.tweet_created_at)] as const),
    ...relatedNotices.map((notice) => [notice.tweet_id, Date.parse(notice.tweet_created_at)] as const),
    [tiboTweetId, time],
  ]);
  const sourceTweetIds = Array.from(new Set([
    ...relatedNotices.map((notice) => notice.tweet_id),
    ...candidates.map((row) => row.tweet_id),
    tiboTweetId,
  ])).sort((left, right) =>
    (timestampByTweetId.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (timestampByTweetId.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right),
  );

  return {
    primaryTweetId: primary.tweet_id,
    representativeTweetId: representativeNotice?.tweet_id ?? primary.tweet_id,
    representativeNoticeId: representativeNotice?.tweet_id ?? null,
    representativeNoticeAt: representativeNotice?.tweet_created_at ?? null,
    sourceTweetIds,
    announcedAt: relatedNotices[0]?.tweet_created_at ?? primary.tweet_created_at,
    error: null,
  };
}

export async function upsertResetExecutionEstimate(
  client: SupabaseClient<any>,
  input: ResolveDisplayExecutionTimeInput & {
    officialNoticeTweetId?: string | null;
    officialNoticeAt?: string | null;
  },
) {
  let existingResult = await client
    .from("reset_execution_estimates")
    .select(EXECUTION_ESTIMATE_COLUMNS)
    .eq("reset_event_key", input.resetEventKey)
    .maybeSingle();
  if (existingResult.error) {
    return { estimate: null, error: existingResult.error };
  }

  if (!existingResult.data && input.usageObservation?.id) {
    existingResult = await client
      .from("reset_execution_estimates")
      .select(EXECUTION_ESTIMATE_COLUMNS)
      .eq("recovery_observation_id", input.usageObservation.id)
      .maybeSingle();
    if (existingResult.error) {
      return { estimate: null, error: existingResult.error };
    }
  }

  if (!existingResult.data && (input.tiboSourceTweetIds ?? []).length > 0) {
    existingResult = await client
      .from("reset_execution_estimates")
      .select(EXECUTION_ESTIMATE_COLUMNS)
      .overlaps("tibo_source_tweet_ids", input.tiboSourceTweetIds!)
      .limit(1)
      .maybeSingle();
    if (existingResult.error) {
      return { estimate: null, error: existingResult.error };
    }
  }

  const existingRow = existingResult.data as ResetExecutionEstimateRow | null;
  const existingEstimate = toResetExecutionEstimate(
    existingRow,
  );
  const stableInput = existingEstimate
    ? {
        ...input,
        resetEventKey: existingEstimate.resetEventKey,
        tiboAnnouncedAt: existingEstimate.tiboAnnouncedAt ?? input.tiboAnnouncedAt,
        tiboPrimaryTweetId: existingEstimate.tiboPrimaryTweetId ?? input.tiboPrimaryTweetId,
        officialNoticeTweetId: existingEstimate.officialNoticeTweetId ?? input.officialNoticeTweetId,
        officialNoticeAt: existingEstimate.officialNoticeAt ?? input.officialNoticeAt,
        tiboSourceTweetIds: Array.from(new Set([
          ...(input.tiboSourceTweetIds ?? []),
          ...existingEstimate.tiboSourceTweetIds,
        ])),
      }
    : input;
  const estimate = buildResetExecutionEstimate({
    ...stableInput,
    persistedEstimate: input.persistedEstimate ?? existingEstimate,
  });
  if (!estimate) return { estimate: null, error: null };

  const values = {
      reset_event_key: estimate.resetEventKey,
      display_execution_at: estimate.displayExecutionAt,
      execution_time_source: estimate.executionTimeSource,
      execution_time_confidence: estimate.executionTimeConfidence,
      execution_time_precision: estimate.executionTimePrecision,
      execution_window_start_at: estimate.executionWindowStartAt,
      execution_window_end_at: estimate.executionWindowEndAt,
      recovery_observation_id: estimate.recoveryObservationId,
      recovery_previous_observed_at: estimate.recoveryPreviousObservedAt,
      recovery_observed_at: estimate.recoveryObservedAt,
      tibo_announced_at: estimate.tiboAnnouncedAt,
      tibo_primary_tweet_id: existingEstimate?.tiboPrimaryTweetId ?? estimate.tiboPrimaryTweetId,
      tibo_source_tweet_ids: estimate.tiboSourceTweetIds,
      official_notice_tweet_id: estimate.officialNoticeTweetId,
      official_notice_at: estimate.officialNoticeAt,
      estimator_version: estimate.estimatorVersion,
      manual_override_at: estimate.manualOverrideAt,
      manual_override_by: estimate.manualOverrideBy,
      manual_override_reason: estimate.manualOverrideReason,
      manual_execution_at: estimate.manualExecutionAt,
      manual_execution_precision: estimate.manualExecutionPrecision,
      updated_at: new Date().toISOString(),
    };
  const result = existingRow?.id
    ? await client
        .from("reset_execution_estimates")
        .update(values)
        .eq("id", existingRow.id)
        .select(EXECUTION_ESTIMATE_COLUMNS)
        .maybeSingle()
    : await client
        .from("reset_execution_estimates")
        .upsert(values, {
          onConflict: estimate.recoveryObservationId ? "recovery_observation_id" : "reset_event_key",
        })
        .select(EXECUTION_ESTIMATE_COLUMNS)
        .maybeSingle();

  if (result.error) {
    return { estimate: null, error: result.error };
  }

  return {
    estimate: toResetExecutionEstimate(result.data as ResetExecutionEstimateRow | null) ?? estimate,
    error: null,
  };
}

export type BankedDistributionEstimateInput = {
  resetEventKey: string;
  displayExecutionAt: string;
  tiboAnnouncedAt: string;
  tiboPrimaryTweetId: string;
  tiboSourceTweetIds: string[];
  officialNoticeTweetId: string;
  officialNoticeAt: string;
};

/**
 * Persist one corroborated BANKED observation in the existing execution
 * estimate table. Notice metadata may be enriched by later duplicate grants;
 * the observed execution time remains first-writer-wins. The row is deliberately separate from recovery estimates:
 * it has no recovery observation and remains approximate because app-server
 * exposes no grant timestamp.
 */
export async function upsertBankedDistributionEstimate(
  client: SupabaseClient<any>,
  input: BankedDistributionEstimateInput,
) {
  let existingResult = await client
    .from("reset_execution_estimates")
    .select(EXECUTION_ESTIMATE_COLUMNS)
    .eq("reset_event_key", input.resetEventKey)
    .maybeSingle();
  if (existingResult.error) return { estimate: null, error: existingResult.error, inserted: false };

  if (!existingResult.data && input.tiboSourceTweetIds.length > 0) {
    existingResult = await client
      .from("reset_execution_estimates")
      .select(EXECUTION_ESTIMATE_COLUMNS)
      .overlaps("tibo_source_tweet_ids", input.tiboSourceTweetIds)
      .limit(1)
      .maybeSingle();
    if (existingResult.error) return { estimate: null, error: existingResult.error, inserted: false };
  }

  const existingEstimate = toResetExecutionEstimate(
    existingResult.data as ResetExecutionEstimateRow | null,
  );
  if (existingEstimate) {
    const sourceTweetIds = Array.from(new Set([
      ...input.tiboSourceTweetIds,
      ...existingEstimate.tiboSourceTweetIds,
    ]));
    const existingAnnouncedAt = Date.parse(existingEstimate.tiboAnnouncedAt ?? "");
    const inputAnnouncedAt = Date.parse(input.tiboAnnouncedAt);
    const tiboAnnouncedAt = Number.isFinite(existingAnnouncedAt) && Number.isFinite(inputAnnouncedAt)
      ? new Date(Math.min(existingAnnouncedAt, inputAnnouncedAt)).toISOString()
      : input.tiboAnnouncedAt;
    const values = {
      tibo_announced_at: tiboAnnouncedAt,
      tibo_primary_tweet_id: input.tiboPrimaryTweetId,
      tibo_source_tweet_ids: sourceTweetIds,
      official_notice_tweet_id: input.officialNoticeTweetId,
      official_notice_at: input.officialNoticeAt,
      estimator_version: BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
      updated_at: new Date().toISOString(),
    };
    const updateResult = existingResult.data?.id
      ? await client
          .from("reset_execution_estimates")
          .update(values)
          .eq("id", existingResult.data.id)
          .select(EXECUTION_ESTIMATE_COLUMNS)
          .maybeSingle()
      : { data: null, error: null };
    return {
      estimate: toResetExecutionEstimate(updateResult.data as ResetExecutionEstimateRow | null) ?? {
        ...existingEstimate,
        tiboAnnouncedAt,
        tiboPrimaryTweetId: input.tiboPrimaryTweetId,
        tiboSourceTweetIds: sourceTweetIds,
        officialNoticeTweetId: input.officialNoticeTweetId,
        officialNoticeAt: input.officialNoticeAt,
      },
      error: updateResult.error,
      inserted: false,
    };
  }

  const values = {
    reset_event_key: input.resetEventKey,
    display_execution_at: input.displayExecutionAt,
    execution_time_source: "usage_observation" as const,
    execution_time_confidence: "high" as const,
    execution_time_precision: "approximate" as const,
    execution_window_start_at: null,
    execution_window_end_at: null,
    recovery_observation_id: null,
    recovery_previous_observed_at: null,
    recovery_observed_at: null,
    tibo_announced_at: input.tiboAnnouncedAt,
    tibo_primary_tweet_id: input.tiboPrimaryTweetId,
    tibo_source_tweet_ids: Array.from(new Set(input.tiboSourceTweetIds)),
    official_notice_tweet_id: input.officialNoticeTweetId,
    official_notice_at: input.officialNoticeAt,
    estimator_version: BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
    manual_override_at: null,
    manual_override_by: null,
    manual_override_reason: null,
    manual_execution_at: null,
    manual_execution_precision: null,
    updated_at: new Date().toISOString(),
  };
  const result = await client
    .from("reset_execution_estimates")
    .upsert(values, { onConflict: "reset_event_key", ignoreDuplicates: true })
    .select(EXECUTION_ESTIMATE_COLUMNS)
    .maybeSingle();

  return {
    estimate: toResetExecutionEstimate(result.data as ResetExecutionEstimateRow | null) ?? {
      resetEventKey: input.resetEventKey,
      displayExecutionAt: input.displayExecutionAt,
      executionTimeSource: "usage_observation" as const,
      executionTimeConfidence: "high" as const,
      executionTimePrecision: "approximate" as const,
      executionWindowStartAt: null,
      executionWindowEndAt: null,
      recoveryObservationId: null,
      recoveryPreviousObservedAt: null,
      recoveryObservedAt: null,
      tiboAnnouncedAt: input.tiboAnnouncedAt,
      tiboPrimaryTweetId: input.tiboPrimaryTweetId,
      tiboSourceTweetIds: Array.from(new Set(input.tiboSourceTweetIds)),
      officialNoticeTweetId: input.officialNoticeTweetId,
      officialNoticeAt: input.officialNoticeAt,
      estimatorVersion: BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
    },
    error: result.error,
    inserted: !result.error,
  };
}

export async function readResetExecutionEstimates(client: SupabaseClient<any>) {
  const result = await client
    .from("reset_execution_estimates")
    .select(EXECUTION_ESTIMATE_COLUMNS)
    .order("display_execution_at", { ascending: false })
    .limit(2000);

  return {
    rows: (result.data ?? [])
      .map((row) => toResetExecutionEstimate(row as ResetExecutionEstimateRow))
      .filter((row): row is ResetExecutionEstimate => Boolean(row)),
    error: result.error,
  };
}

export async function fetchPublicCodexRecoveryObservation(
  client: SupabaseClient<any>,
  now: Date,
) {
  const result = await client
    .from("codex_recovery_observations")
    .select(OBSERVATION_COLUMNS)
    .eq("source_key", CODEX_USAGE_SOURCE_KEY)
    .eq("status", "observed")
    .eq("confidence", "strong")
    .neq("cycle_hint", "regular")
    .order("observed_at", { ascending: false })
    .limit(20);

  if (result.error) return { data: null, error: result.error };

  for (const row of result.data ?? []) {
    const observation = toCodexRecoveryObservation(row as CodexRecoveryObservationRow);
    const publicObservation = getPublicRecoveryObservation(observation, now);
    if (publicObservation) return { data: publicObservation, error: null };
  }

  return { data: null, error: null };
}

export async function readCodexRecoveryObservations(client: SupabaseClient<any>) {
  const result = await client
    .from("codex_recovery_observations")
    .select(OBSERVATION_COLUMNS)
    .eq("source_key", CODEX_USAGE_SOURCE_KEY)
    .eq("status", "observed")
    .eq("confidence", "strong")
    .neq("cycle_hint", "regular")
    .order("observed_at", { ascending: false })
    .limit(20);

  return {
    rows: (result.data ?? [])
      .map((row) => toCodexRecoveryObservation(row as CodexRecoveryObservationRow))
      .filter((row): row is CodexRecoveryObservation => Boolean(row)),
    error: result.error,
  };
}
