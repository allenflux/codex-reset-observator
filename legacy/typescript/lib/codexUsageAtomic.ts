import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CODEX_USAGE_SOURCE_KEY,
  type CodexRecoveryObservation,
  type CodexUsageSnapshot,
} from "./codexUsageRecovery";
import {
  getNextUsageMonitorCoverageStartedAt,
  type UsageMonitorState,
} from "./codexUsageMonitorCoverage";
import {
  type BankedDistributionEstimateInput,
  type CodexUsageMonitorStateRow,
} from "./codexUsageRecoveryStore";
import {
  type ResetExecutionEstimate,
} from "./radar/resetExecution";
import { getNextUsageMonitorLastBankedGrantAt } from "./codexUsageRecoveryStore";
import { createObservedRegularResetEventRow } from "./radar/regularResetSchedule";

export const CODEX_USAGE_ATOMIC_RPC = "apply_codex_usage_webhook_write";

export type CodexUsageAtomicStateWrite = Pick<
  CodexUsageMonitorStateRow,
  | "source_key"
  | "observed_at"
  | "received_at"
  | "limit_id"
  | "plan_type"
  | "used_percent"
  | "window_duration_mins"
  | "resets_at"
  | "coverage_started_at"
  | "banked_reset_available_count"
  | "last_banked_grant_at"
  | "updated_at"
>;

export type CodexUsageAtomicObservationWrite = {
  source_key: string;
  observed_at: string;
  previous_observed_at: string | null;
  previous_used_percent: number;
  current_used_percent: number;
  previous_resets_at: number;
  current_resets_at: number;
  cycle_hint: CodexRecoveryObservation["cycleHint"];
  confidence: CodexRecoveryObservation["confidence"];
  status: CodexRecoveryObservation["status"];
  matched_tibo_tweet_id: string | null;
  confirmed_at: string | null;
  updated_at: string;
};

export type CodexUsageAtomicEstimateWrite = {
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
  is_monitor_observed?: boolean;
};

export type CodexUsageAtomicBankedWrite = {
  reset_event_key: string;
  display_execution_at: string;
  tibo_announced_at: string;
  tibo_primary_tweet_id: string;
  tibo_source_tweet_ids: string[];
  official_notice_tweet_id: string;
  official_notice_at: string;
};

export type CodexUsageAtomicPromotion = {
  tweet_id: string;
  confidence: number;
  classification_reason: string;
};

export type CodexUsageAtomicWritePlan = {
  source_key: typeof CODEX_USAGE_SOURCE_KEY;
  expected_previous_observed_at: string | null;
  state: CodexUsageAtomicStateWrite;
  observation?: CodexUsageAtomicObservationWrite;
  regular_reset_event?: ReturnType<typeof createObservedRegularResetEventRow>;
  execution_estimate?: CodexUsageAtomicEstimateWrite;
  banked_distribution_estimate?: CodexUsageAtomicBankedWrite;
  promotion?: CodexUsageAtomicPromotion;
};

export type CodexUsageAtomicWriteResult = {
  status: "applied" | "stale";
  retryRequired: boolean;
  observationId?: string | null;
};

function toNullableTimestamp(value: string | null | undefined) {
  return value ?? null;
}

export function buildCodexUsageMonitorStateWrite(
  snapshot: CodexUsageSnapshot,
  receivedAt: string,
  previousState: UsageMonitorState | null | undefined,
): CodexUsageAtomicStateWrite {
  const bankedResetAvailableCount = snapshot.bankedResetAvailableCount !== undefined
    ? snapshot.bankedResetAvailableCount
    : previousState?.bankedResetAvailableCount !== undefined
      ? previousState.bankedResetAvailableCount
      : null;

  return {
    source_key: CODEX_USAGE_SOURCE_KEY,
    observed_at: snapshot.observedAt,
    received_at: receivedAt,
    limit_id: snapshot.limitId,
    plan_type: snapshot.planType,
    used_percent: snapshot.usedPercent,
    window_duration_mins: snapshot.windowDurationMins,
    resets_at: snapshot.resetsAt,
    coverage_started_at: getNextUsageMonitorCoverageStartedAt(previousState, snapshot),
    banked_reset_available_count: bankedResetAvailableCount,
    last_banked_grant_at: getNextUsageMonitorLastBankedGrantAt(previousState, snapshot),
    updated_at: receivedAt,
  };
}

export function buildCodexRecoveryObservationWrite(
  observation: Omit<CodexRecoveryObservation, "id" | "createdAt" | "updatedAt"> | CodexRecoveryObservation,
): CodexUsageAtomicObservationWrite {
  const updatedAt = ("updatedAt" in observation ? observation.updatedAt : null) ??
    observation.confirmedAt ?? observation.observedAt;
  return {
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
    updated_at: updatedAt,
  };
}

export function buildResetExecutionEstimateWrite(
  estimate: ResetExecutionEstimate,
  options: { monitorObserved?: boolean } = {},
): CodexUsageAtomicEstimateWrite {
  return {
    reset_event_key: estimate.resetEventKey,
    display_execution_at: estimate.displayExecutionAt,
    execution_time_source: estimate.executionTimeSource,
    execution_time_confidence: estimate.executionTimeConfidence,
    execution_time_precision: estimate.executionTimePrecision,
    execution_window_start_at: toNullableTimestamp(estimate.executionWindowStartAt),
    execution_window_end_at: toNullableTimestamp(estimate.executionWindowEndAt),
    recovery_observation_id: toNullableTimestamp(estimate.recoveryObservationId),
    recovery_previous_observed_at: toNullableTimestamp(estimate.recoveryPreviousObservedAt),
    recovery_observed_at: toNullableTimestamp(estimate.recoveryObservedAt),
    tibo_announced_at: toNullableTimestamp(estimate.tiboAnnouncedAt),
    tibo_primary_tweet_id: estimate.tiboPrimaryTweetId ?? null,
    tibo_source_tweet_ids: Array.from(new Set(estimate.tiboSourceTweetIds)),
    official_notice_tweet_id: estimate.officialNoticeTweetId ?? null,
    official_notice_at: toNullableTimestamp(estimate.officialNoticeAt),
    estimator_version: estimate.estimatorVersion,
    manual_override_at: toNullableTimestamp(estimate.manualOverrideAt),
    manual_override_by: estimate.manualOverrideBy ?? null,
    manual_override_reason: estimate.manualOverrideReason ?? null,
    manual_execution_at: toNullableTimestamp(estimate.manualExecutionAt),
    manual_execution_precision: estimate.manualExecutionPrecision ?? null,
    ...(options.monitorObserved ? { is_monitor_observed: true } : {}),
  };
}

export function buildBankedDistributionEstimateWrite(
  input: BankedDistributionEstimateInput,
): CodexUsageAtomicBankedWrite {
  return {
    reset_event_key: input.resetEventKey,
    display_execution_at: input.displayExecutionAt,
    tibo_announced_at: input.tiboAnnouncedAt,
    tibo_primary_tweet_id: input.tiboPrimaryTweetId,
    tibo_source_tweet_ids: Array.from(new Set(input.tiboSourceTweetIds)),
    official_notice_tweet_id: input.officialNoticeTweetId,
    official_notice_at: input.officialNoticeAt,
  };
}

export function buildCodexUsageAtomicWritePlan(input: {
  expectedPreviousObservedAt: string | null;
  snapshot: CodexUsageSnapshot;
  receivedAt: string;
  previousState: UsageMonitorState | null | undefined;
  observation?: Omit<CodexRecoveryObservation, "id" | "createdAt" | "updatedAt"> | CodexRecoveryObservation;
  regularReset?: { scheduledAt: string; completedAt: string };
  executionEstimate?: CodexUsageAtomicEstimateWrite | null;
  bankedDistribution?: BankedDistributionEstimateInput | null;
  promotion?: { tweetId: string; confidence: number; classificationReason?: string };
}): CodexUsageAtomicWritePlan {
  const plan: CodexUsageAtomicWritePlan = {
    source_key: CODEX_USAGE_SOURCE_KEY,
    expected_previous_observed_at: input.expectedPreviousObservedAt,
    state: buildCodexUsageMonitorStateWrite(input.snapshot, input.receivedAt, input.previousState),
  };

  if (input.observation) {
    plan.observation = buildCodexRecoveryObservationWrite(input.observation);
  }
  if (input.regularReset) {
    plan.regular_reset_event = createObservedRegularResetEventRow(
      input.regularReset.scheduledAt,
      input.regularReset.completedAt,
    );
  }
  if (input.executionEstimate) {
    plan.execution_estimate = input.executionEstimate;
  }
  if (input.bankedDistribution) {
    plan.banked_distribution_estimate = buildBankedDistributionEstimateWrite(input.bankedDistribution);
  }
  if (input.promotion) {
    plan.promotion = {
      tweet_id: input.promotion.tweetId,
      confidence: input.promotion.confidence,
      classification_reason: input.promotion.classificationReason ??
        "Usage Monitorで意味のあるquota recoveryが確認されたため、正式resetとして採用しました。",
    };
  }
  return plan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function applyCodexUsageAtomicWrite(
  client: SupabaseClient<any>,
  plan: CodexUsageAtomicWritePlan,
): Promise<{ result: CodexUsageAtomicWriteResult | null; error: unknown }> {
  const response = await client.rpc(CODEX_USAGE_ATOMIC_RPC, { p_plan: plan });
  if (response.error) return { result: null, error: response.error };
  if (!isRecord(response.data) || (response.data.status !== "applied" && response.data.status !== "stale")) {
    return { result: null, error: new Error("Atomic Codex usage RPC returned an invalid result") };
  }
  return {
    result: {
      status: response.data.status,
      retryRequired: response.data.retry_required === true,
      observationId: typeof response.data.observation_id === "string" ? response.data.observation_id : null,
    },
    error: null,
  };
}
