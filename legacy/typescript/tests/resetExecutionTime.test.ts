import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDisplayExecutionTime,
  type ResetExecutionEstimate,
} from "../lib/radar/resetExecution";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { CodexRecoveryObservation } from "../lib/codexUsageRecovery";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";
import { getLastGlobalResetAt } from "../lib/radar/probability";

const TIBO_ANNOUNCEMENT = "2026-08-11T00:27:44.000Z";

function recoveryObservation(
  overrides: Partial<CodexRecoveryObservation> = {},
): CodexRecoveryObservation {
  return {
    id: "recovery-1",
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-11T00:02:00.000Z",
    previousObservedAt: "2026-08-11T00:00:00.000Z",
    previousUsedPercent: 69,
    currentUsedPercent: 0,
    previousResetsAt: 1780000000,
    currentResetsAt: 1780600000,
    cycleHint: "unexpected",
    confidence: "medium",
    status: "confirmed",
    matchedTiboTweetId: "tibo-1",
    confirmedAt: "2026-08-11T00:28:00.000Z",
    ...overrides,
  };
}

function tiboReset(overrides: Partial<FormalTiboResetSignal> = {}): FormalTiboResetSignal {
  return {
    tweet_id: "tibo-1",
    text: "Usage limits have been reset for Codex and ChatGPT Work.",
    tweet_url: "https://x.com/thsottiaux/status/tibo-1",
    tweet_created_at: TIBO_ANNOUNCEMENT,
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "confirmed",
    classification_source: "gemini",
    ...overrides,
  };
}

test("confirmed matched recovery uses the observation window end without midpoint interpolation", () => {
  const decision = resolveDisplayExecutionTime({
    resetEventKey: "tibo-reset-tibo-1",
    tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
    tiboPrimaryTweetId: "tibo-1",
    tiboSourceTweetIds: ["tibo-1", "tibo-2"],
    usageObservation: recoveryObservation(),
  });

  assert.equal(decision.displayExecutionAt, "2026-08-11T00:02:00.000Z");
  assert.equal(decision.executionTimeSource, "usage_observation");
  assert.equal(decision.executionTimePrecision, "approximate");
  assert.equal(decision.executionWindowStartAt, "2026-08-11T00:00:00.000Z");
  assert.equal(decision.executionWindowEndAt, "2026-08-11T00:02:00.000Z");
  assert.notEqual(decision.displayExecutionAt, "2026-08-11T00:01:00.000Z");
});

test("manual override takes precedence over a matched usage observation", () => {
  const decision = resolveDisplayExecutionTime({
    resetEventKey: "tibo-reset-tibo-1",
    tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
    tiboPrimaryTweetId: "tibo-1",
    tiboSourceTweetIds: ["tibo-1"],
    usageObservation: recoveryObservation(),
    manualOverride: {
      manualExecutionAt: "2026-08-11T00:01:00.000Z",
      manualExecutionPrecision: "approximate",
      manualOverrideReason: "Independent operator confirmation",
      manualOverrideAt: "2026-08-11T01:00:00.000Z",
      manualOverrideBy: "operator",
    },
  });

  assert.equal(decision.displayExecutionAt, "2026-08-11T00:01:00.000Z");
  assert.equal(decision.executionTimeSource, "manual_override");
  assert.equal(decision.executionTimePrecision, "approximate");
});

test("a persisted manual override remains highest priority for later usage updates", () => {
  const decision = resolveDisplayExecutionTime({
    resetEventKey: "tibo-reset-tibo-1",
    tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
    tiboPrimaryTweetId: "tibo-1",
    tiboSourceTweetIds: ["tibo-1"],
    usageObservation: recoveryObservation(),
    persistedEstimate: {
      resetEventKey: "tibo-reset-tibo-1",
      displayExecutionAt: "2026-08-11T00:01:00.000Z",
      executionTimeSource: "manual_override",
      executionTimeConfidence: "high",
      executionTimePrecision: "approximate",
      recoveryObservationId: null,
      tiboSourceTweetIds: ["tibo-1"],
      estimatorVersion: "usage-execution-v1",
      manualOverrideAt: "2026-08-11T01:00:00.000Z",
      manualOverrideBy: "operator",
      manualOverrideReason: "Independent operator confirmation",
      manualExecutionAt: "2026-08-11T00:01:00.000Z",
      manualExecutionPrecision: "approximate",
    },
  });

  assert.equal(decision.displayExecutionAt, "2026-08-11T00:01:00.000Z");
  assert.equal(decision.executionTimeSource, "manual_override");
});

test("unconfirmed, rejected, or mismatched observations fall back to the Tibo announcement", () => {
  for (const usageObservation of [
    recoveryObservation({ status: "observed" }),
    recoveryObservation({ status: "rejected" }),
    recoveryObservation({ matchedTiboTweetId: "another-reset" }),
  ]) {
    const decision = resolveDisplayExecutionTime({
      resetEventKey: "tibo-reset-tibo-1",
      tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
      tiboPrimaryTweetId: "tibo-1",
      tiboSourceTweetIds: ["tibo-1", "tibo-2"],
      usageObservation,
    });

    assert.equal(decision.displayExecutionAt, TIBO_ANNOUNCEMENT);
    assert.equal(decision.executionTimeSource, "tibo_announcement_fallback");
    assert.equal(decision.executionTimePrecision, "announcement_fallback");
  }
});

test("persisted execution estimate can be resolved without exposing usage details", () => {
  const estimate: ResetExecutionEstimate = {
    resetEventKey: "tibo-reset-tibo-1",
    displayExecutionAt: "2026-08-11T00:02:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-08-11T00:00:00.000Z",
    executionWindowEndAt: "2026-08-11T00:02:00.000Z",
    recoveryObservationId: "recovery-1",
    recoveryPreviousObservedAt: "2026-08-11T00:00:00.000Z",
    recoveryObservedAt: "2026-08-11T00:02:00.000Z",
    tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
    tiboPrimaryTweetId: "tibo-1",
    tiboSourceTweetIds: ["tibo-1", "tibo-2"],
    estimatorVersion: "usage-execution-v1",
  };

  const decision = resolveDisplayExecutionTime({
    resetEventKey: "tibo-reset-tibo-1",
    tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
    tiboPrimaryTweetId: "tibo-1",
    tiboSourceTweetIds: ["tibo-1", "tibo-2"],
    persistedEstimate: estimate,
  });

  assert.equal(decision.displayExecutionAt, estimate.displayExecutionAt);
  assert.equal(decision.executionTimeSource, "usage_observation");
});

test("display-only execution estimate changes history time but not published probabilities", () => {
  const now = new Date("2026-08-11T01:00:00.000Z");
  const base = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: [tiboReset()],
  });
  const withEstimate = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: [tiboReset()],
    resetExecutionEstimates: [{
      resetEventKey: "tibo-reset-tibo-1",
      displayExecutionAt: "2026-08-11T00:02:00.000Z",
      executionTimeSource: "usage_observation",
      executionTimeConfidence: "high",
      executionTimePrecision: "approximate",
      executionWindowStartAt: "2026-08-11T00:00:00.000Z",
      executionWindowEndAt: "2026-08-11T00:02:00.000Z",
      recoveryObservationId: "recovery-1",
      recoveryPreviousObservedAt: "2026-08-11T00:00:00.000Z",
      recoveryObservedAt: "2026-08-11T00:02:00.000Z",
      tiboAnnouncedAt: TIBO_ANNOUNCEMENT,
      tiboPrimaryTweetId: "tibo-1",
      tiboSourceTweetIds: ["tibo-1"],
      estimatorVersion: "usage-execution-v1",
    }],
  });

  const baseSnapshot = toPublicRadarSnapshot(base, "ja", { calculationNow: now });
  const estimateSnapshot = toPublicRadarSnapshot(withEstimate, "ja", { calculationNow: now });
  const estimateHistoryItem = estimateSnapshot.viewModel.recentHistory.find(
    (item) => item.key === "tibo-reset-tibo-1",
  );
  assert.equal(estimateHistoryItem?.resetAt, "2026-08-11T00:02:00.000Z");
  assert.equal(estimateHistoryItem?.executionTimePrecision, "approximate");
  assert.equal(baseSnapshot.viewModel.probability24h, estimateSnapshot.viewModel.probability24h);
  assert.equal(baseSnapshot.viewModel.probability48h, estimateSnapshot.viewModel.probability48h);
  assert.equal(getLastGlobalResetAt(withEstimate, now)?.toISOString(), TIBO_ANNOUNCEMENT);
  assert.doesNotMatch(JSON.stringify(estimateSnapshot), /usedPercent|resetsAt|planType|recoveryObservationId/);
});
