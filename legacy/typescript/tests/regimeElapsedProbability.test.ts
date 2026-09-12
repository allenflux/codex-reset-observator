import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import type { WindowEventLike } from "../lib/radar/types";
import {
  buildRegimeElapsedHazard,
  calculateRegimeDiagnostics,
  calculateRegimeElapsedProbability,
  getRegimeElapsedHazardAtAge,
  integrateRegimeElapsedHazard,
  OFFICIAL_NOTICE_TIMING_POLICY_VERSION,
} from "../lib/radar/regimeElapsedProbability";
import { getRecoveryResetEvents } from "../lib/radar/recoveryBoundary";
import { getPointInTimeRadarData } from "../lib/radar/prequentialCalibration";
import {
  ELAPSED_ONLY_MODEL_VERSION,
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
} from "../data/shadowProbabilityConfig";

function resetEvent(
  id: string,
  completedAt: string,
  cycleType: "ランダムリセット" | "定期リセット" = "ランダムリセット",
  overrides: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    recordKind: cycleType === "ランダムリセット" ? "confirmed_global" : "reference",
    title: cycleType === "ランダムリセット" ? "ランダムリセット" : "定期リセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType,
      reasonType: cycleType === "ランダムリセット" ? "詫びリセット" : "定期更新",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
    ...overrides,
  };
}

const NOW = new Date("2026-08-08T04:32:00.000Z");

test("random hard and broad Banked Reset are targets, while regular is boundary-only", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const boundaries = getRecoveryResetEvents(data, NOW, [
    resetEvent("random-hard", "2026-08-01T00:00:00.000Z"),
    resetEvent("regular", "2026-08-05T00:00:00.000Z", "定期リセット"),
    resetEvent("random-banked", "2026-08-07T00:00:00.000Z", "ランダムリセット", {
      recordKind: "banked_distribution",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "ご祝儀リセット",
        resetMethod: "任意リセット権配布",
        scope: "全有料プラン",
        noticeToExecution: "0分",
      },
    }),
  ]);

  assert.equal(boundaries.length, 3);
  assert.deepEqual(boundaries.map((boundary) => boundary.isRandom), [true, false, true]);
  assert.deepEqual(boundaries.map((boundary) => boundary.isRegular), [false, true, false]);
});

test("narrow, rejected, voided, pending, future, and invalid records are excluded", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const boundaries = getRecoveryResetEvents(data, NOW, [
    resetEvent("valid", "2026-08-01T00:00:00.000Z"),
    resetEvent("narrow", "2026-08-02T00:00:00.000Z", "定期リセット", { scope: "不具合対象ユーザー" }),
    resetEvent("rejected", "2026-08-03T00:00:00.000Z", "定期リセット", { status: "rejected" }),
    resetEvent("voided", "2026-08-04T00:00:00.000Z", "定期リセット", { status: "voided" }),
    resetEvent("pending", "2026-08-05T00:00:00.000Z", "定期リセット", {
      status: "pending",
      kind: "window_opened",
      closed_at: null,
      completed_at: null,
    }),
    resetEvent("future", "2026-08-09T00:00:00.000Z"),
    resetEvent("invalid", "not-a-date"),
  ]);

  assert.deepEqual(boundaries.map((boundary) => boundary.id), ["valid"]);
});

test("near-time regular and random records create separate recovery boundaries", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const boundaries = getRecoveryResetEvents(data, NOW, [
    resetEvent("regular", "2026-08-05T00:00:00.000Z", "定期リセット"),
    resetEvent("banked", "2026-08-05T00:04:00.000Z", "ランダムリセット", {
      recordKind: "banked_distribution",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "ご祝儀リセット",
        resetMethod: "任意リセット権配布",
        scope: "全有料プラン",
        noticeToExecution: "0分",
      },
    }),
  ]);

  assert.equal(boundaries.length, 2);
  assert.deepEqual(boundaries.map((boundary) => boundary.isRandom), [false, true]);
  assert.deepEqual(boundaries.map((boundary) => boundary.isRegular), [true, false]);
  assert.deepEqual(boundaries.map((boundary) => boundary.sourceIds.length), [1, 1]);
});

test("a regular boundary resets elapsed age without increasing random event count", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const boundaries = getRecoveryResetEvents(data, NOW, [
    resetEvent("random", "2026-08-01T00:00:00.000Z"),
    resetEvent("regular", "2026-08-08T03:32:00.000Z", "定期リセット"),
  ]);
  const result = calculateRegimeElapsedProbability(data, {
    now: NOW,
    staticHistory: [
      resetEvent("random", "2026-08-01T00:00:00.000Z"),
      resetEvent("regular", "2026-08-08T03:32:00.000Z", "定期リセット"),
    ],
    activeOfficialNotice: null,
  });

  assert.equal(boundaries.at(-1)?.isRegular, true);
  assert.ok(result.regimeElapsed.elapsedHours < 2);
  assert.equal(result.regimeElapsed.randomBoundaryCount, 1);
  assert.equal(result.regimeElapsed.regularBoundaryCount, 1);
});

test("elapsed-only publication keeps full regime diagnostics out of the effective probability", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const staticHistory = [
    resetEvent("old", "2026-06-01T00:00:00.000Z"),
    resetEvent("older", "2026-07-01T00:00:00.000Z"),
    resetEvent("a", "2026-08-01T00:00:00.000Z"),
    resetEvent("b", "2026-08-03T00:00:00.000Z"),
    resetEvent("c", "2026-08-05T00:00:00.000Z"),
  ];
  const full = calculateRegimeElapsedProbability(
    data,
    { now: NOW, staticHistory, activeOfficialNotice: null },
    PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  );
  const elapsedOnly = calculateRegimeElapsedProbability(
    data,
    { now: NOW, staticHistory, activeOfficialNotice: null },
    PUBLISHED_ELAPSED_MODEL_OPTIONS,
  );

  assert.equal(full.modelVersion, REGIME_ELAPSED_FULL_MODEL_VERSION);
  assert.equal(full.regimeElapsed.mode, "full");
  assert.equal(elapsedOnly.modelVersion, ELAPSED_ONLY_MODEL_VERSION);
  assert.equal(elapsedOnly.regimeElapsed.mode, "elapsed-only");
  assert.equal(elapsedOnly.regimeElapsed.effectiveRegimeMultiplier, 1);
  assert.ok(full.regimeElapsed.regime.regimeMultiplier > 1);
  assert.equal(
    elapsedOnly.regimeElapsed.regime.regimeMultiplier,
    full.regimeElapsed.regime.regimeMultiplier,
  );
  assert.notDeepEqual(elapsedOnly.predictions, full.predictions);
});

test("forecast integration smoothly crosses elapsed bins", () => {
  const boundaries = [
    { id: "start", resetAt: "2026-08-01T00:00:00.000Z", isRandom: false, isRegular: true, sourceIds: ["start"] },
    { id: "event", resetAt: "2026-08-02T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["event"] },
  ];
  const hazard = buildRegimeElapsedHazard(boundaries, new Date("2026-08-02T00:00:00.000Z"), { binScheme: "A" });
  const atBinStart = getRegimeElapsedHazardAtAge(hazard, 12);
  const atBinMiddle = getRegimeElapsedHazardAtAge(hazard, 18);
  const atBinEnd = getRegimeElapsedHazardAtAge(hazard, 24);
  const crossed = integrateRegimeElapsedHazard(hazard, 20, 24);

  assert.ok(crossed > 0);
  assert.equal(atBinStart, hazard.bins[1].posteriorLambdaPerHour);
  assert.equal(atBinEnd, hazard.bins[2].posteriorLambdaPerHour);
  assert.ok(
    atBinMiddle >= Math.min(atBinStart, atBinEnd) &&
    atBinMiddle <= Math.max(atBinStart, atBinEnd),
  );
});

test("future boundaries cannot change a point-in-time regime or elapsed prediction", () => {
  const history = [
    resetEvent("first", "2026-07-01T00:00:00.000Z"),
    resetEvent("second", "2026-08-01T00:00:00.000Z"),
  ];
  const data = getLocalRadarData({ calculationNow: NOW });
  const before = calculateRegimeElapsedProbability(data, {
    now: NOW,
    staticHistory: history,
    activeOfficialNotice: null,
  });
  const after = calculateRegimeElapsedProbability(data, {
    now: NOW,
    staticHistory: [...history, resetEvent("future", "2026-08-20T00:00:00.000Z")],
    activeOfficialNotice: null,
  });

  assert.deepEqual(after.predictions, before.predictions);
  assert.deepEqual(after.regimeElapsed.regime, before.regimeElapsed.regime);
});

test("future persisted regular reset rows are excluded from point-in-time origins", () => {
  const regularReset = {
    schedule_key: "weekly:2026-08-08",
    window_start_at: "2026-08-08T03:30:00.000Z",
    window_end_at: "2026-08-08T03:45:00.000Z",
    representative_at: "2026-08-08T03:32:00.000Z",
    scheduled_at: "2026-08-08T03:32:00.000Z",
    completed_at: "2026-08-08T03:32:00.000Z",
    cycle_type: "定期リセット" as const,
    reset_method: "強制リセット",
    scope: "任意リセット未使用アカウント",
    record_kind: "regular_completed" as const,
    status: "completed" as const,
  };
  const data = getLocalRadarData({
    calculationNow: NOW,
    regularResetEvents: [regularReset],
  });
  const before = getPointInTimeRadarData(data, new Date("2026-08-08T03:31:59.000Z"));
  const after = getPointInTimeRadarData(data, new Date("2026-08-08T03:32:00.000Z"));

  assert.equal(before?.regular_reset_events?.length, 0);
  assert.equal(after?.regular_reset_events?.length, 1);
});

test("regime intensity decays after a quiet period and rises in a recent cluster", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const quiet = calculateRegimeDiagnostics([
    { id: "old", resetAt: "2026-07-01T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["old"] },
  ], NOW, { regimeHalfLifeDays: 3, minRegimeMultiplier: 0.1 });
  const hot = calculateRegimeDiagnostics([
    { id: "old", resetAt: "2026-06-01T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["old"] },
    { id: "older", resetAt: "2026-07-01T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["older"] },
    { id: "a", resetAt: "2026-08-01T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["a"] },
    { id: "b", resetAt: "2026-08-03T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["b"] },
    { id: "c", resetAt: "2026-08-05T00:00:00.000Z", isRandom: true, isRegular: false, sourceIds: ["c"] },
  ], NOW, { regimeHalfLifeDays: 3, minRegimeMultiplier: 0.1 });

  assert.ok(quiet.recentWeightedEventCount < hot.recentWeightedEventCount);
  assert.ok(quiet.rawRateRatio < hot.rawRateRatio);
  assert.ok(hot.regimeMultiplier > quiet.regimeMultiplier);
});

test("pre-reset teaser strength does not boost after a regular recovery boundary", () => {
  const staticHistory = [
    resetEvent("random", "2026-08-01T00:00:00.000Z"),
    resetEvent("regular", "2026-08-08T03:32:00.000Z", "定期リセット"),
  ];
  const oldTeaser = {
    tweet_id: "old-teaser",
    signal_type: "irrelevant" as const,
    tweet_created_at: "2026-08-08T01:00:00.000Z",
    verification_status: "auto_unverified" as const,
    teaser_strength: "strong" as const,
    is_reply: false,
  };
  const newTeaser = {
    ...oldTeaser,
    tweet_id: "new-teaser",
    tweet_created_at: "2026-08-08T04:00:00.000Z",
  };
  const base = getLocalRadarData({ calculationNow: NOW });
  const before = calculateRegimeElapsedProbability(base, {
    now: NOW,
    staticHistory,
    activeOfficialNotice: null,
  });
  const old = calculateRegimeElapsedProbability({ ...base, recent_tibo_signals: [oldTeaser] }, {
    now: NOW,
    staticHistory,
    activeOfficialNotice: null,
  });
  const current = calculateRegimeElapsedProbability({ ...base, recent_tibo_signals: [newTeaser] }, {
    now: NOW,
    staticHistory,
    activeOfficialNotice: null,
  });

  assert.equal(old.predictions.probability24h, before.predictions.probability24h);
  assert.ok(current.predictions.probability24h > before.predictions.probability24h);
});

test("official notice override and horizon monotonicity remain intact", () => {
  const now = new Date("2026-08-08T04:32:00.000Z");
  const notice = {
    origin: "local" as const,
    id: "notice",
    title: "notice",
    summary: "notice",
    observedAt: now.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const result = calculateRegimeElapsedProbability(
    getLocalRadarData({ calculationNow: now }),
    { now, activeOfficialNotice: notice },
  );

  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.ok(result.predictions.probability12h <= result.predictions.probability24h);
  assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
  assert.ok(result.predictions.probability48h <= result.predictions.probability72h);
});

test("resolved future notice uses partial horizon coverage instead of a fixed override", () => {
  const now = new Date("2026-08-08T20:34:50.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const baseline = calculateRegimeElapsedProbability(data, {
    now,
    activeOfficialNotice: null,
  });
  const notice = {
    origin: "dynamic" as const,
    id: "monday-notice",
    title: "I'll do another performative reset on Monday",
    summary: "I'll do another performative reset on Monday",
    observedAt: "2026-08-08T20:34:50.000Z",
    expectedAt: "2026-08-10T07:00:00.000Z",
    expectedEndAt: "2026-08-11T07:00:00.000Z",
    expiresAt: "2026-08-11T09:00:00.000Z",
    source: null,
    sourceLabel: "Tibo",
    temporalPrecision: "day" as const,
    temporalConfidence: 0.95,
    temporalResolutionStatus: "resolved" as const,
    temporalTimezone: "America/Los_Angeles",
  };
  const result = calculateRegimeElapsedProbability(data, {
    now,
    activeOfficialNotice: notice,
  });

  assert.equal(result.regimeElapsed.officialNoticeTimingPolicyVersion, OFFICIAL_NOTICE_TIMING_POLICY_VERSION);
  assert.equal(OFFICIAL_NOTICE_TIMING_POLICY_VERSION, "official-notice-window-v3");
  assert.ok(
    Math.abs(
      result.predictions.probability24h - baseline.predictions.probability24h,
    ) < 1e-12,
  );
  assert.ok(result.predictions.probability48h > baseline.predictions.probability48h);
  assert.ok(result.predictions.probability48h < 0.96);
  assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
});
