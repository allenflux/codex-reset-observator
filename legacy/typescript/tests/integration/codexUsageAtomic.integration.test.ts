import assert from "node:assert/strict";
import test from "node:test";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildCodexUsageAtomicWritePlan,
  buildResetExecutionEstimateWrite,
} from "../../lib/codexUsageAtomic";
import {
  CODEX_USAGE_SOURCE_KEY,
  type CodexRecoveryObservation,
  type CodexUsageSnapshot,
} from "../../lib/codexUsageRecovery";
import { buildResetExecutionEstimate } from "../../lib/radar/resetExecution";
import type { UsageMonitorState } from "../../lib/codexUsageMonitorCoverage";

const localUrl = process.env.SUPABASE_LOCAL_URL;
const localServiceRoleKey = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY;
const isConfigured = Boolean(localUrl && localServiceRoleKey);

function clientOrThrow() {
  if (!localUrl || !localServiceRoleKey) throw new Error("Local Supabase credentials are not configured");
  return createClient(localUrl, localServiceRoleKey, { auth: { persistSession: false } });
}

async function clearLocalWebhookData(client: SupabaseClient<any>) {
  // Delete FK dependents before their recovery observations; requests must also be
  // sequential because each PostgREST request commits independently.
  const deletes = [
    await client.from("reset_execution_estimates").delete().neq("reset_event_key", "__atomic_test_keep__"),
    await client.from("codex_recovery_observations").delete().eq("source_key", CODEX_USAGE_SOURCE_KEY),
    await client.from("regular_reset_events").delete().neq("schedule_key", "__atomic_test_keep__"),
    await client.from("codex_usage_monitor_state").delete().eq("source_key", CODEX_USAGE_SOURCE_KEY),
    await client.from("tibo_signals").delete().neq("tweet_id", "__atomic_test_keep__"),
  ];
  for (const result of deletes) assert.equal(result.error, null, result.error?.message);
}

function assertTimestampEqual(actual: string | null | undefined, expected: string) {
  assert.ok(actual);
  assert.equal(new Date(actual).toISOString(), new Date(expected).toISOString());
}

function baselineSnapshot(): CodexUsageSnapshot {
  return {
    observedAt: "2026-08-30T00:00:00.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 100,
    windowDurationMins: 10080,
    resetsAt: 1_788_000_000,
    bankedResetAvailableCount: 0,
  };
}

function recoverySnapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    observedAt: "2026-08-30T00:04:00.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 0,
    windowDurationMins: 10080,
    resetsAt: 1_788_604_800,
    bankedResetAvailableCount: 0,
    ...overrides,
  };
}

function monitorStateFromSnapshot(snapshot: CodexUsageSnapshot): UsageMonitorState {
  return {
    sourceKey: CODEX_USAGE_SOURCE_KEY,
    observedAt: snapshot.observedAt,
    receivedAt: snapshot.observedAt,
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    usedPercent: snapshot.usedPercent,
    windowDurationMins: snapshot.windowDurationMins,
    resetsAt: snapshot.resetsAt,
    coverageStartedAt: snapshot.observedAt,
    bankedResetAvailableCount: snapshot.bankedResetAvailableCount ?? null,
    lastBankedGrantAt: null,
  };
}

function recoveryObservation(snapshot: CodexUsageSnapshot, status: "observed" | "confirmed" = "observed"): CodexRecoveryObservation {
  return {
    sourceKey: CODEX_USAGE_SOURCE_KEY,
    observedAt: snapshot.observedAt,
    previousObservedAt: baselineSnapshot().observedAt,
    previousUsedPercent: 100,
    currentUsedPercent: snapshot.usedPercent,
    previousResetsAt: baselineSnapshot().resetsAt,
    currentResetsAt: snapshot.resetsAt,
    cycleHint: "unexpected",
    confidence: "strong",
    status,
    matchedTiboTweetId: status === "confirmed" ? "atomic-deferred-reset" : null,
    confirmedAt: status === "confirmed" ? "2026-08-30T00:04:01.000Z" : null,
  };
}

function estimateWrite(snapshot: CodexUsageSnapshot, observation: CodexRecoveryObservation, key: string) {
  const estimate = buildResetExecutionEstimate({
    resetEventKey: key,
    usageObservation: observation,
    isMonitorObserved: true,
    tiboAnnouncedAt: null,
    tiboPrimaryTweetId: null,
    tiboSourceTweetIds: [],
  });
  if (!estimate) throw new Error("Expected a usage estimate");
  return buildResetExecutionEstimateWrite(estimate, { monitorObserved: true });
}

function recoveryPlan(snapshot: CodexUsageSnapshot, previous: CodexUsageSnapshot, options: {
  observation?: CodexRecoveryObservation;
  estimate?: ReturnType<typeof buildResetExecutionEstimateWrite>;
  banked?: {
    resetEventKey: string;
    displayExecutionAt: string;
    tiboAnnouncedAt: string;
    tiboPrimaryTweetId: string;
    tiboSourceTweetIds: string[];
    officialNoticeTweetId: string;
    officialNoticeAt: string;
  };
  regular?: boolean;
  promotion?: boolean;
  stateSnapshot?: CodexUsageSnapshot;
} = {}) {
  return buildCodexUsageAtomicWritePlan({
    expectedPreviousObservedAt: previous.observedAt,
    snapshot: options.stateSnapshot ?? snapshot,
    receivedAt: "2026-08-30T00:04:01.000Z",
    previousState: monitorStateFromSnapshot(previous),
    observation: options.observation,
    executionEstimate: options.estimate,
    regularReset: options.regular
      ? { scheduledAt: "2026-08-30T00:00:00.000Z", completedAt: snapshot.observedAt }
      : undefined,
    bankedDistribution: options.banked,
    promotion: options.promotion
      ? { tweetId: "atomic-deferred-reset", confidence: 0.98 }
      : undefined,
  });
}

async function apply(client: SupabaseClient<any>, plan: ReturnType<typeof buildCodexUsageAtomicWritePlan>) {
  const result = await client.rpc("apply_codex_usage_webhook_write", { p_plan: plan });
  assert.equal(result.error, null, result.error?.message);
  return result.data as { status: string; retry_required: boolean; observation_id?: string | null };
}

async function count(client: SupabaseClient<any>, table: string, column: string, value: string) {
  const result = await client.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  assert.equal(result.error, null, result.error?.message);
  return result.count ?? 0;
}

async function seedBaseline(client: SupabaseClient<any>) {
  await apply(client, buildCodexUsageAtomicWritePlan({
    expectedPreviousObservedAt: null,
    snapshot: baselineSnapshot(),
    receivedAt: "2026-08-30T00:00:01.000Z",
    previousState: null,
  }));
}

test("atomic webhook success commits observation, regular event, estimate, promotion, and state", { skip: !isConfigured }, async () => {
  const client = clientOrThrow();
  await clearLocalWebhookData(client);
  try {
    await seedBaseline(client);
    const snapshot = recoverySnapshot();
    await client.from("tibo_signals").insert({
      tweet_id: "atomic-deferred-reset",
      signal_type: "irrelevant",
      text: "A deferred reset signal",
      tweet_url: "https://x.com/thsottiaux/status/atomic-deferred-reset",
      tweet_created_at: snapshot.observedAt,
      expires_at: "2026-09-01T00:00:00.000Z",
      confidence: 0.98,
      verification_status: "auto_unverified",
      is_reply: false,
    });
    const observation = recoveryObservation(snapshot, "confirmed");
    const data = await apply(client, recoveryPlan(snapshot, baselineSnapshot(), {
      observation,
      estimate: estimateWrite(snapshot, observation, "usage-reset-pending"),
      regular: true,
      promotion: true,
    }));
    assert.equal(data.status, "applied");
    assert.equal(await count(client, "codex_recovery_observations", "source_key", CODEX_USAGE_SOURCE_KEY), 1);
    assert.equal(await count(client, "regular_reset_events", "schedule_key", "weekly-regular-reset:2026-08-30T00:00:00.000Z"), 1);
    assert.equal(await count(client, "reset_execution_estimates", "reset_event_key", `usage-reset-${data.observation_id}`), 1);
    const state = await client.from("codex_usage_monitor_state").select("observed_at").eq("source_key", CODEX_USAGE_SOURCE_KEY).single();
    assert.equal(state.error, null, state.error?.message);
    assertTimestampEqual(state.data?.observed_at, snapshot.observedAt);
    const promoted = await client.from("tibo_signals").select("signal_type").eq("tweet_id", "atomic-deferred-reset").single();
    assert.equal(promoted.data?.signal_type, "reset_executed");
  } finally {
    await clearLocalWebhookData(client);
  }
});
test("a later write failure rolls back observation, regular event, estimate, and state", { skip: !isConfigured }, async () => {
  const client = clientOrThrow();
  await clearLocalWebhookData(client);
  try {
    await seedBaseline(client);
    const snapshot = recoverySnapshot();
    const observation = recoveryObservation(snapshot);
    const invalidEstimate = {
      ...estimateWrite(snapshot, observation, "atomic-rollback-estimate"),
      execution_time_source: "invalid_source" as never,
    };
    const result = await client.rpc("apply_codex_usage_webhook_write", {
      p_plan: recoveryPlan(snapshot, baselineSnapshot(), {
        observation,
        estimate: invalidEstimate,
        regular: true,
      }),
    });
    assert.notEqual(result.error, null);
    assert.equal(await count(client, "codex_recovery_observations", "source_key", CODEX_USAGE_SOURCE_KEY), 0);
    assert.equal(await count(client, "regular_reset_events", "schedule_key", "weekly-regular-reset:2026-08-30T00:00:00.000Z"), 0);
    assert.equal(await count(client, "reset_execution_estimates", "reset_event_key", "atomic-rollback-estimate"), 0);
    const state = await client.from("codex_usage_monitor_state").select("observed_at").eq("source_key", CODEX_USAGE_SOURCE_KEY).single();
    assertTimestampEqual(state.data?.observed_at, baselineSnapshot().observedAt);
  } finally {
    await clearLocalWebhookData(client);
  }
});

test("resending one plan is idempotent and does not duplicate rows", { skip: !isConfigured }, async () => {
  const client = clientOrThrow();
  await clearLocalWebhookData(client);
  try {
    await seedBaseline(client);
    const snapshot = recoverySnapshot();
    const observation = recoveryObservation(snapshot);
    const plan = recoveryPlan(snapshot, baselineSnapshot(), {
      observation,
      estimate: estimateWrite(snapshot, observation, "atomic-idempotent-estimate"),
    });
    const first = await apply(client, plan);
    const second = await apply(client, plan);
    assert.equal(first.status, "applied");
    assert.equal(second.status, "stale");
    assert.equal(second.retry_required, false);
    assert.equal(await count(client, "codex_recovery_observations", "source_key", CODEX_USAGE_SOURCE_KEY), 1);
    assert.ok(first.observation_id);
    assert.equal(await count(client, "reset_execution_estimates", "reset_event_key", `usage-reset-${first.observation_id}`), 1);
  } finally {
    await clearLocalWebhookData(client);
  }
});

test("a stale compare-and-swap plan performs no side writes or state regression", { skip: !isConfigured }, async () => {
  const client = clientOrThrow();
  await clearLocalWebhookData(client);
  try {
    await seedBaseline(client);
    const snapshot = recoverySnapshot({ observedAt: "2026-08-30T00:05:00.000Z" });
    const observation = recoveryObservation(snapshot);
    const stalePlan = buildCodexUsageAtomicWritePlan({
      expectedPreviousObservedAt: null,
      snapshot,
      receivedAt: "2026-08-30T00:05:01.000Z",
      previousState: null,
      observation,
      executionEstimate: estimateWrite(snapshot, observation, "atomic-stale-estimate"),
    });
    const result = await apply(client, stalePlan);
    assert.equal(result.status, "stale");
    assert.equal(result.retry_required, true);
    assert.equal(await count(client, "codex_recovery_observations", "source_key", CODEX_USAGE_SOURCE_KEY), 0);
    const state = await client.from("codex_usage_monitor_state").select("observed_at").eq("source_key", CODEX_USAGE_SOURCE_KEY).single();
    assertTimestampEqual(state.data?.observed_at, baselineSnapshot().observedAt);
  } finally {
    await clearLocalWebhookData(client);
  }
});

test("BANKED estimate and state roll back together when the later state write fails", { skip: !isConfigured }, async () => {
  const client = clientOrThrow();
  await clearLocalWebhookData(client);
  try {
    await seedBaseline(client);
    const snapshot = recoverySnapshot({ usedPercent: 100, bankedResetAvailableCount: 1 });
    const invalidState = recoverySnapshot({ usedPercent: 101, bankedResetAvailableCount: 1 });
    const plan = recoveryPlan(snapshot, baselineSnapshot(), {
      stateSnapshot: invalidState,
      banked: {
        resetEventKey: "atomic-banked-rollback",
        displayExecutionAt: snapshot.observedAt,
        tiboAnnouncedAt: "2026-08-29T23:00:00.000Z",
        tiboPrimaryTweetId: "atomic-banked-notice",
        tiboSourceTweetIds: ["atomic-banked-notice"],
        officialNoticeTweetId: "atomic-banked-notice",
        officialNoticeAt: "2026-08-29T23:00:00.000Z",
      },
    });
    const result = await client.rpc("apply_codex_usage_webhook_write", { p_plan: plan });
    assert.notEqual(result.error, null);
    assert.equal(await count(client, "reset_execution_estimates", "reset_event_key", "atomic-banked-rollback"), 0);
    const state = await client.from("codex_usage_monitor_state").select("observed_at,used_percent").eq("source_key", CODEX_USAGE_SOURCE_KEY).single();
    assertTimestampEqual(state.data?.observed_at, baselineSnapshot().observedAt);
    assert.equal(state.data?.used_percent, 100);
  } finally {
    await clearLocalWebhookData(client);
  }
});
