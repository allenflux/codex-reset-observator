import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import {
  getActiveOfficialNotice,
  getLastGlobalResetAt,
  getLocalProbabilityCalculation,
} from "../lib/radar/probability";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  getLastRandomRecoveryResetAt,
  getRecoveryResetEvents,
} from "../lib/radar/recoveryBoundary";
import type { ActiveTiboSignal, RadarData } from "../lib/radar/types";
import {
  combineResetHistory,
  getNoticeBackedHistoryInputs,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import type { CodexRecoveryObservation } from "../lib/codexUsageRecovery";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";

const RESET_AT = "2026-08-24T08:37:00.000Z";
const NOW = new Date("2026-08-24T09:00:00.000Z");
const OLD_NOTICE_AT = "2026-08-24T07:30:00.000Z";
const NEW_NOTICE_AT = "2026-08-24T08:50:00.000Z";

const recoveryObservation: CodexRecoveryObservation = {
  id: "monitor-only-recovery",
  sourceKey: "local-codex-app-server",
  observedAt: RESET_AT,
  previousObservedAt: "2026-08-24T08:33:00.000Z",
  previousUsedPercent: 100,
  currentUsedPercent: 0,
  previousResetsAt: 1788000000,
  currentResetsAt: 1788600000,
  cycleHint: "unexpected",
  confidence: "strong",
  status: "observed",
  matchedTiboTweetId: null,
};

const oldNotice: ActiveTiboSignal = {
  tweet_id: "old-official-notice",
  text: "The reset will land soon.",
  tweet_url: "https://x.com/thsottiaux/status/old-official-notice",
  signal_type: "official_notice",
  confidence: 0.99,
  verification_status: "auto_unverified",
  tweet_created_at: OLD_NOTICE_AT,
  expires_at: "2026-08-25T00:00:00.000Z",
};

const newNotice: ActiveTiboSignal = {
  tweet_id: "new-official-notice",
  text: "The next reset will land soon.",
  tweet_url: "https://x.com/thsottiaux/status/new-official-notice",
  signal_type: "official_notice",
  confidence: 0.99,
  verification_status: "auto_unverified",
  tweet_created_at: NEW_NOTICE_AT,
  expires_at: "2026-08-25T00:00:00.000Z",
};

const monitorOnlyEstimate: ResetExecutionEstimate = {
  resetEventKey: "tibo-reset-old-official-notice",
  displayExecutionAt: RESET_AT,
  executionTimeSource: "usage_observation",
  executionTimeConfidence: "high",
  executionTimePrecision: "approximate",
  executionWindowStartAt: recoveryObservation.previousObservedAt,
  executionWindowEndAt: RESET_AT,
  recoveryObservationId: recoveryObservation.id,
  recoveryPreviousObservedAt: recoveryObservation.previousObservedAt,
  recoveryObservedAt: RESET_AT,
  tiboAnnouncedAt: OLD_NOTICE_AT,
  tiboPrimaryTweetId: oldNotice.tweet_id,
  tiboSourceTweetIds: [oldNotice.tweet_id],
  officialNoticeTweetId: oldNotice.tweet_id,
  estimatorVersion: "usage-execution-v1",
};

function teaser(
  id: string,
  createdAt: string,
  teaserStrength: "strong" | "weak",
): ActiveTiboSignal {
  return {
    tweet_id: id,
    text: `${teaserStrength} reset teaser`,
    tweet_url: `https://x.com/thsottiaux/status/${id}`,
    signal_type: teaserStrength === "strong" ? "teaser" : "irrelevant",
    confidence: teaserStrength === "strong" ? 0.9 : 0.85,
    verification_status: "auto_unverified",
    tweet_created_at: createdAt,
    expires_at: "2026-08-25T00:00:00.000Z",
    teaser_strength: teaserStrength,
  };
}

function resolvedFutureTeaser(
  id: string,
  createdAt: string,
  teaserStrength: "strong" | "weak",
  expectedStartAt: string,
  expectedEndAt: string,
): ActiveTiboSignal {
  return {
    ...teaser(id, createdAt, teaserStrength),
    confidence: 0.95,
    expires_at: expectedEndAt,
    ai_temporal_direction: "future",
    ai_temporal_kind: "relative_day",
    temporal_precision: "range",
    expected_start_at: expectedStartAt,
    expected_end_at: expectedEndAt,
    temporal_resolution_status: "resolved",
  };
}

function resolvedFutureNotice(
  id: string,
  createdAt: string,
  expectedStartAt: string,
  expectedEndAt: string,
): ActiveTiboSignal {
  return {
    ...oldNotice,
    tweet_id: id,
    tweet_created_at: createdAt,
    text: "The next reset will happen tomorrow.",
    tweet_url: `https://x.com/thsottiaux/status/${id}`,
    expires_at: expectedEndAt,
    temporal_precision: "range",
    expected_start_at: expectedStartAt,
    expected_end_at: expectedEndAt,
    temporal_resolution_status: "resolved",
  };
}

function fixture(
  signals: ActiveTiboSignal[],
  calculationNow: Date = NOW,
  formalTiboResets: FormalTiboResetSignal[] = [],
): RadarData {
  return getLocalRadarData({
    calculationNow,
    activeTiboSignals: signals,
    recentTiboSignals: signals,
    formalTiboResets,
    codexRecoveryObservations: [recoveryObservation],
    resetExecutionEstimates: [monitorOnlyEstimate],
  });
}

const lateCompletion: FormalTiboResetSignal = {
  tweet_id: "late-reset-confirmation",
  text: "Usage limits have been reset for all paid users.",
  tweet_url: "https://x.com/thsottiaux/status/late-reset-confirmation",
  tweet_created_at: "2026-08-24T09:00:00.000Z",
  signal_type: "reset_executed",
  confidence: 0.98,
  verification_status: "confirmed",
  classification_source: "gemini",
  related_notice: oldNotice as any,
};

function assertMonitorOnlyBoundary(data: RadarData, calculationNow: Date = NOW) {
  assert.equal(
    getLastRandomRecoveryResetAt(data, calculationNow, []),
    RESET_AT,
  );
  assert.equal(getLastGlobalResetAt(data, calculationNow)?.toISOString(), RESET_AT);
  assert.equal(
    getRecoveryResetEvents(data, calculationNow, []).some(
      (boundary) => boundary.resetAt === RESET_AT && boundary.isRandom,
    ),
    true,
  );
  assert.equal(
    data.active_tibo_signals?.some((signal) => signal.signal_type === "reset_executed"),
    false,
  );
}

test("monitor-only reset consumes a pre-reset strong teaser in UI and probability", () => {
  const data = fixture([
    oldNotice,
    teaser("old-strong", "2026-08-24T08:00:00.000Z", "strong"),
  ]);
  assertMonitorOnlyBoundary(data);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  const calculation = getLocalProbabilityCalculation(data, { now: NOW });

  assert.equal(snapshot.resetTeaserStatus, "none");
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 0);
  assert.deepEqual(calculation.breakdown.contributions.teaserOrEvent, {
    probability24h: 0,
    probability48h: 0,
  });
  assert.equal(getActiveOfficialNotice(data, null, NOW), null);
  assert.equal(calculation.inputSnapshot.activeOfficialNotice, false);
});

test("only a post-reset strong teaser remains active for UI and probability", () => {
  const data = fixture([
    oldNotice,
    teaser("old-strong", "2026-08-24T08:00:00.000Z", "strong"),
    teaser("new-strong", "2026-08-24T08:50:00.000Z", "strong"),
  ]);
  assertMonitorOnlyBoundary(data);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  const calculation = getLocalProbabilityCalculation(data, { now: NOW });

  assert.equal(snapshot.resetTeaserStatus, "strong");
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 1);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability24h > 0);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability48h > 0);
});

test("weak teaser strength uses the same monitor-only reset boundary", () => {
  const oldOnly = fixture([
    oldNotice,
    teaser("old-weak", "2026-08-24T08:00:00.000Z", "weak"),
  ]);
  assertMonitorOnlyBoundary(oldOnly);
  assert.equal(
    toPublicRadarSnapshot(oldOnly, "ja", { calculationNow: NOW }).resetTeaserStatus,
    "none",
  );

  const withNew = fixture([
    oldNotice,
    teaser("old-weak", "2026-08-24T08:00:00.000Z", "weak"),
    teaser("new-weak", "2026-08-24T08:50:00.000Z", "weak"),
  ]);
  assertMonitorOnlyBoundary(withNew);
  assert.equal(
    toPublicRadarSnapshot(withNew, "ja", { calculationNow: NOW }).resetTeaserStatus,
    "weak",
  );
});

test("a future teaser remains active when its forecast window starts after a long monitor window", () => {
  const longObservation: CodexRecoveryObservation = {
    ...recoveryObservation,
    previousObservedAt: "2026-08-24T07:00:00.000Z",
  };
  const longEstimate: ResetExecutionEstimate = {
    ...monitorOnlyEstimate,
    executionWindowStartAt: longObservation.previousObservedAt,
    recoveryPreviousObservedAt: longObservation.previousObservedAt,
  };
  const future = resolvedFutureTeaser(
    "future-after-reset",
    "2026-08-24T08:00:00.000Z",
    "strong",
    "2026-08-25T08:00:00.000Z",
    "2026-08-26T08:00:00.000Z",
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [future],
    recentTiboSignals: [future],
    codexRecoveryObservations: [longObservation],
    resetExecutionEstimates: [longEstimate],
  });

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  const calculation = getLocalProbabilityCalculation(data, { now: NOW });

  assert.equal(snapshot.resetTeaserStatus, "strong");
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 1);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability24h > 0);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability48h > 0);
});

test("a future teaser whose forecast window overlaps the monitor reset remains consumed", () => {
  const overlapping = resolvedFutureTeaser(
    "overlapping-reset-window",
    "2026-08-24T08:00:00.000Z",
    "strong",
    "2026-08-24T08:35:00.000Z",
    "2026-08-24T10:00:00.000Z",
  );
  const data = fixture([overlapping]);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  const calculation = getLocalProbabilityCalculation(data, { now: NOW });

  assert.equal(snapshot.resetTeaserStatus, "none");
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 0);
});

test("future official notices use the forecast window instead of post distance", () => {
  const future = resolvedFutureNotice(
    "future-official-after-reset",
    "2026-08-24T08:00:00.000Z",
    "2026-08-25T08:00:00.000Z",
    "2026-08-26T08:00:00.000Z",
  );
  const data = fixture([future]);

  assert.equal(getActiveOfficialNotice(data, null, NOW)?.id, future.tweet_id);
  const executionWindow = {
    executionWindowStartAt: "2026-08-24T08:33:00.000Z",
    executionWindowEndAt: RESET_AT,
  };
  assert.equal(
    getActiveOfficialNotice(data, null, NOW, undefined, executionWindow, true),
    null,
  );

  const overlapping = resolvedFutureNotice(
    "overlapping-official-window",
    "2026-08-24T08:00:00.000Z",
    "2026-08-24T08:35:00.000Z",
    "2026-08-24T10:00:00.000Z",
  );
  assert.equal(getActiveOfficialNotice(fixture([overlapping]), null, NOW), null);
  assert.equal(
    getActiveOfficialNotice(
      fixture([overlapping]),
      null,
      NOW,
      undefined,
      executionWindow,
      true,
    )?.id,
    overlapping.tweet_id,
  );
});

test("insertion order does not change the future teaser boundary result", () => {
  const future = resolvedFutureTeaser(
    "future-order-independent",
    "2026-08-24T08:00:00.000Z",
    "weak",
    "2026-08-25T08:00:00.000Z",
    "2026-08-26T08:00:00.000Z",
  );
  const old = teaser("old-order-independent", "2026-08-24T08:10:00.000Z", "strong");
  const first = toPublicRadarSnapshot(
    fixture([future, old]),
    "ja",
    { calculationNow: NOW },
  );
  const second = toPublicRadarSnapshot(
    fixture([old, future]),
    "ja",
    { calculationNow: NOW },
  );

  assert.equal(first.resetTeaserStatus, "weak");
  assert.equal(second.resetTeaserStatus, "weak");
});

test("an old official notice is consumed, while a post-reset notice starts the next cycle", () => {
  const oldData = fixture([oldNotice]);
  assertMonitorOnlyBoundary(oldData);
  assert.equal(getActiveOfficialNotice(oldData, null, NOW), null);
  const oldCalculation = getLocalProbabilityCalculation(oldData, { now: NOW });
  assert.equal(oldCalculation.breakdown.officialNoticeOverride.active, false);

  const newData = fixture([oldNotice, newNotice]);
  assertMonitorOnlyBoundary(newData);
  assert.equal(getActiveOfficialNotice(newData, null, NOW)?.id, newNotice.tweet_id);
  const newCalculation = getLocalProbabilityCalculation(newData, { now: NOW });
  assert.equal(newCalculation.breakdown.officialNoticeOverride.active, true);
  assert.equal(newCalculation.probability24h, 0.9);
  assert.equal(newCalculation.probability48h, 0.96);
});

test("monitor-only recovery is a random boundary without any reset_executed signal", () => {
  const data = fixture([oldNotice]);
  assertMonitorOnlyBoundary(data);
  assert.equal(
    data.active_tibo_signals?.filter((signal) => signal.signal_type === "reset_executed").length,
    0,
  );
  assert.equal(data.reset_execution_estimates?.[0]?.executionTimeSource, "usage_observation");
  assert.equal(data.reset_execution_estimates?.[0]?.recoveryObservationId, recoveryObservation.id);
});

test("late reset_executed confirmation does not consume a post-reset strong teaser or notice", () => {
  const calculationNow = new Date("2026-08-24T09:10:00.000Z");
  const data = fixture(
    [
      oldNotice,
      newNotice,
      teaser("old-strong-late", "2026-08-24T08:00:00.000Z", "strong"),
      teaser("new-strong-late", "2026-08-24T08:50:00.000Z", "strong"),
    ],
    calculationNow,
    [lateCompletion],
  );
  assertMonitorOnlyBoundary(data, calculationNow);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow });
  const calculation = getLocalProbabilityCalculation(data, { now: calculationNow });
  const teaserCalculation = getLocalProbabilityCalculation(data, {
    now: calculationNow,
    activeOfficialNotice: null,
  });

  assert.equal(snapshot.resetTeaserStatus, "strong");
  assert.equal(getActiveOfficialNotice(data, null, calculationNow)?.id, newNotice.tweet_id);
  assert.equal(calculation.breakdown.officialNoticeOverride.active, true);
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 1);
  assert.equal(teaserCalculation.inputSnapshot.activeTeaserCount, 1);
  assert.ok(teaserCalculation.breakdown.contributions.teaserOrEvent.probability24h > 0);
  assert.ok(teaserCalculation.breakdown.contributions.teaserOrEvent.probability48h > 0);
});

test("late reset_executed confirmation does not consume a post-reset weak teaser", () => {
  const calculationNow = new Date("2026-08-24T09:10:00.000Z");
  const data = fixture(
    [
      oldNotice,
      teaser("old-weak-late", "2026-08-24T08:00:00.000Z", "weak"),
      teaser("new-weak-late", "2026-08-24T08:50:00.000Z", "weak"),
    ],
    calculationNow,
    [lateCompletion],
  );
  assertMonitorOnlyBoundary(data, calculationNow);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow });

  assert.equal(snapshot.resetTeaserStatus, "weak");
});

test("monitor boundary merges a late composite completion while preserving its secondary teaser", () => {
  const calculationNow = new Date("2026-08-24T10:00:00.000Z");
  const compositeCompletion: FormalTiboResetSignal = {
    ...lateCompletion,
    tweet_id: "late-composite-confirmation",
    tweet_created_at: "2026-08-24T09:46:00.000Z",
    text: "Reset is done. Might press the reset button again tomorrow.",
    secondary_signal: {
      signalType: "teaser",
      teaserStrength: "strong",
      confidence: 0.96,
      evidenceQuote: "Might press the reset button again tomorrow",
      reasonJa: "次回resetを強く示唆する別の未来部分です。",
      expiresAt: "2026-08-25T09:46:00.000Z",
      temporal: null,
    },
  };
  const data = fixture(
    [
      oldNotice,
      teaser("old-composite", "2026-08-24T08:00:00.000Z", "strong"),
      compositeCompletion as unknown as ActiveTiboSignal,
    ],
    calculationNow,
    [compositeCompletion],
  );

  const boundaries = getRecoveryResetEvents(data, calculationNow, []);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0]?.resetAt, RESET_AT);
  assert.equal(boundaries[0]?.isRandom, true);

  const historyInputs = getNoticeBackedHistoryInputs(data);
  const combinedHistory = combineResetHistory(
    [],
    [compositeCompletion],
    [],
    [],
    historyInputs.noticeSignals,
    historyInputs.recoveryObservations,
    historyInputs.estimates,
  );
  assert.equal(combinedHistory.length, 1);
  assert.equal(combinedHistory[0]?.completed_at, RESET_AT);

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow });
  const calculation = getLocalProbabilityCalculation(data, { now: calculationNow });
  assert.equal(snapshot.lastRandomResetAt, RESET_AT);
  assert.equal(snapshot.resetTeaserStatus, "strong");
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 1);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability24h > 0);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability48h > 0);
});
