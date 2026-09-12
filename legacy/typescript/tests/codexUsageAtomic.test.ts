import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexUsageAtomicWritePlan,
  buildResetExecutionEstimateWrite,
} from "../lib/codexUsageAtomic";

const previousState = {
  sourceKey: "local-codex-app-server",
  observedAt: "2026-08-30T00:00:00.000Z",
  receivedAt: "2026-08-30T00:00:01.000Z",
  limitId: "codex",
  planType: "plus",
  usedPercent: 100,
  windowDurationMins: 10080,
  resetsAt: 1_788_000_000,
  coverageStartedAt: "2026-08-29T23:55:00.000Z",
  bankedResetAvailableCount: 0,
  lastBankedGrantAt: null,
};

const snapshot = {
  observedAt: "2026-08-30T00:04:00.000Z",
  limitId: "codex" as const,
  planType: "plus",
  usedPercent: 0,
  windowDurationMins: 10080 as const,
  resetsAt: 1_788_604_800,
  bankedResetAvailableCount: 1,
};

const observation = {
  sourceKey: "local-codex-app-server",
  observedAt: snapshot.observedAt,
  previousObservedAt: previousState.observedAt,
  previousUsedPercent: 100,
  currentUsedPercent: 0,
  previousResetsAt: previousState.resetsAt,
  currentResetsAt: snapshot.resetsAt,
  cycleHint: "unexpected" as const,
  confidence: "strong" as const,
  status: "observed" as const,
  matchedTiboTweetId: null,
  confirmedAt: null,
};

test("builds one atomic plan for all related webhook writes", () => {
  const estimate = buildResetExecutionEstimateWrite({
    resetEventKey: "usage-reset-pending",
    displayExecutionAt: snapshot.observedAt,
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: previousState.observedAt,
    executionWindowEndAt: snapshot.observedAt,
    recoveryObservationId: null,
    recoveryPreviousObservedAt: previousState.observedAt,
    recoveryObservedAt: snapshot.observedAt,
    tiboAnnouncedAt: null,
    tiboPrimaryTweetId: null,
    tiboSourceTweetIds: [],
    officialNoticeTweetId: null,
    officialNoticeAt: null,
    estimatorVersion: "usage-execution-monitor-v1",
    manualOverrideAt: null,
    manualOverrideBy: null,
    manualOverrideReason: null,
    manualExecutionAt: null,
    manualExecutionPrecision: null,
  }, { monitorObserved: true });

  const plan = buildCodexUsageAtomicWritePlan({
    expectedPreviousObservedAt: previousState.observedAt,
    snapshot,
    receivedAt: "2026-08-30T00:04:01.000Z",
    previousState,
    observation,
    regularReset: {
      scheduledAt: "2026-08-30T00:00:00.000Z",
      completedAt: snapshot.observedAt,
    },
    executionEstimate: estimate,
    bankedDistribution: {
      resetEventKey: "banked-reset-notice",
      displayExecutionAt: snapshot.observedAt,
      tiboAnnouncedAt: "2026-08-29T23:00:00.000Z",
      tiboPrimaryTweetId: "banked-notice",
      tiboSourceTweetIds: ["banked-notice"],
      officialNoticeTweetId: "banked-notice",
      officialNoticeAt: "2026-08-29T23:00:00.000Z",
    },
    promotion: {
      tweetId: "deferred-reset",
      confidence: 0.98,
    },
  });

  assert.equal(plan.expected_previous_observed_at, previousState.observedAt);
  assert.equal(plan.observation?.observed_at, snapshot.observedAt);
  assert.equal(plan.regular_reset_event?.completed_at, snapshot.observedAt);
  assert.equal(plan.execution_estimate?.reset_event_key, "usage-reset-pending");
  assert.equal(plan.execution_estimate?.is_monitor_observed, true);
  assert.equal(plan.banked_distribution_estimate?.reset_event_key, "banked-reset-notice");
  assert.equal(plan.promotion?.tweet_id, "deferred-reset");
  assert.equal(plan.state.observed_at, snapshot.observedAt);
});
