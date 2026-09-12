import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  BIN_PRIOR_EQUIVALENT_EXPOSURE_DAYS,
  HAZARD_BIN_HOURS,
  MAX_BASELINE_DAILY_PROBABILITY,
  MAX_TOTAL_ODDS_MULTIPLIER_24H,
  MAX_TOTAL_ODDS_MULTIPLIER_48H,
  MIN_BASELINE_DAILY_PROBABILITY,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { buildProbabilityDebugInfo } from "../lib/logProbability";
import {
  applyOddsMultiplier,
  buildShadowHazard,
  calculateShadowProbability,
  calculateShadowProbabilityForModel,
  calculateShadowSignalMultipliers,
  getShadowBaselineAgeHours,
  getShadowCompletedResetEvents,
  getShadowSignalInputs,
  integrateHazardProbability,
  oddsToProbability,
  probabilityToOdds,
  type ShadowResetEvent,
} from "../lib/radar/shadowProbability";
import {
  getLocalProbabilityCalculation,
  getLocalSignalEvaluation,
} from "../lib/radar/probability";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { ActiveOfficialNotice } from "../lib/radar/probability";
import type { RadarData, WindowEventLike } from "../lib/radar/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function resetEvent(
  id: string,
  completedAt: string,
  overrides: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: id,
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
    ...overrides,
  };
}

function localHistory<T>(history: WindowEventLike[], callback: () => T) {
  const original = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...history);
  try {
    return callback();
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...original);
  }
}

function event(id: string, resetAt: string): ShadowResetEvent {
  return { id, resetAt };
}

test("shadow event collection excludes future, pending, invalid, rejected, and non-target records", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const rejectedUrl = "https://x.com/thsottiaux/status/999";
  const events = getShadowCompletedResetEvents(
    {
      rejected_tibo_resets: [{
        tweet_id: "999",
        tweet_url: rejectedUrl,
        tweet_created_at: "2026-08-09T00:00:00.000Z",
      }],
    },
    now,
    [
      resetEvent("valid", "2026-08-08T00:00:00.000Z"),
      resetEvent("future", "2026-08-11T00:00:00.000Z"),
      resetEvent("pending", "2026-08-07T00:00:00.000Z", {
        status: "pending",
        kind: "window_opened",
        closed_at: null,
        completed_at: null,
      }),
      resetEvent("invalid", "not-a-date"),
      resetEvent("optional", "2026-08-06T00:00:00.000Z", {
        details: {
          cycleType: "ランダムリセット",
          reasonType: "詫びリセット",
          resetMethod: "任意リセット権配布",
          scope: "全有料プラン",
          noticeToExecution: "0分",
        },
      }),
      resetEvent("out-of-scope", "2026-08-07T12:00:00.000Z", {
        scope: "特定のユーザー",
        details: {
          cycleType: "ランダムリセット",
          reasonType: "詫びリセット",
          resetMethod: "強制リセット",
          scope: "特定のユーザー",
          noticeToExecution: "0分",
        },
      }),
      resetEvent("rejected", "2026-08-05T00:00:00.000Z", { source_url: rejectedUrl }),
    ],
  );

  assert.deepEqual(events.map((item) => item.id), ["optional", "valid"]);
});

test("shadow event collection deduplicates a static record and an accepted Tibo reset", () => {
  const resetAt = "2026-08-08T00:00:00.000Z";
  const sourceUrl = "https://x.com/thsottiaux/status/12345";
  const events = getShadowCompletedResetEvents(
    {
      formal_tibo_resets: [{
        tweet_id: "12345",
        text: "All Codex limits reset.",
        tweet_url: sourceUrl,
        tweet_created_at: resetAt,
        signal_type: "reset_executed",
        confidence: 0.99,
        verification_status: "confirmed",
      }],
    },
    new Date("2026-08-10T00:00:00.000Z"),
    [resetEvent("static", resetAt, { source_url: sourceUrl })],
  );

  assert.equal(events.length, 1);
});

test("shadow event collection includes broad random distributions but excludes regular and narrow records", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const regular = resetEvent("regular", "2026-08-08T00:00:00.000Z", {
    details: {
      cycleType: "定期リセット",
      reasonType: "定期更新",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分（定期）",
    },
  });
  const random = resetEvent("random", "2026-08-09T00:00:00.000Z");
  const credit = resetEvent("credit", "2026-08-09T12:00:00.000Z", {
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  });
  const regularCredit = resetEvent("regular-credit", "2026-08-09T13:00:00.000Z", {
    details: {
      cycleType: "定期リセット",
      reasonType: "定期更新",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "0分（定期）",
    },
  });
  const narrowCredit = resetEvent("narrow-credit", "2026-08-09T14:00:00.000Z", {
    scope: "不具合対象ユーザー（約50万人）",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "任意リセット権配布",
      scope: "不具合対象ユーザー（約50万人）",
      noticeToExecution: "0分",
    },
  });
  const reference = resetEvent("reference", "2026-08-09T15:00:00.000Z", {
    recordKind: "reference",
  });

  const events = getShadowCompletedResetEvents(null, now, [
    regular,
    random,
    credit,
    regularCredit,
    narrowCredit,
    reference,
  ]);
  assert.deepEqual(events.map((item) => item.id), ["random", "credit"]);
});

test("canonical evaluation collection keeps distinct BANKED event keys sharing one notice source", () => {
  const sourceUrl = "https://x.com/thsottiaux/status/banked-notice";
  const first = resetEvent("banked-first", "2026-08-08T00:00:00.000Z", {
    recordKind: "banked_distribution",
    source_url: sourceUrl,
  });
  const second = resetEvent("banked-second", "2026-08-08T20:00:00.000Z", {
    recordKind: "banked_distribution",
    source_url: sourceUrl,
  });
  const now = new Date("2026-08-09T00:00:00.000Z");

  assert.deepEqual(
    getShadowCompletedResetEvents(null, now, [first, second]).map((item) => item.id),
    ["banked-first"],
  );
  assert.deepEqual(
    getShadowCompletedResetEvents(null, now, [first, second], {
      preserveDistinctCanonicalIds: true,
    }).map((item) => item.id),
    ["banked-first", "banked-second"],
  );
});

test("shadow event collection includes notice-backed authoritative usage execution", () => {
  const notice = {
    tweet_id: "notice-backed-reset",
    text: "We will reset the Codex usage limit for everyone today.",
    tweet_url: "https://x.com/thsottiaux/status/notice-backed-reset",
    tweet_created_at: "2026-08-08T00:00:00.000Z",
    signal_type: "official_notice" as const,
    confidence: 0.99,
    verification_status: "auto_unverified" as const,
  };
  const recovery = {
    id: "recovery-notice-backed",
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-08T04:00:00.000Z",
    previousObservedAt: "2026-08-08T03:00:00.000Z",
    previousUsedPercent: 100,
    currentUsedPercent: 0,
    previousResetsAt: Date.parse("2026-08-15T00:00:00.000Z") / 1000,
    currentResetsAt: Date.parse("2026-08-15T00:00:00.000Z") / 1000,
    cycleHint: "unexpected" as const,
    confidence: "strong" as const,
    status: "observed" as const,
    matchedTiboTweetId: notice.tweet_id,
    confirmedAt: null,
    createdAt: "2026-08-08T04:00:00.000Z",
    updatedAt: "2026-08-08T04:00:00.000Z",
  };
  const estimate = {
    resetEventKey: "notice-backed-reset-event",
    displayExecutionAt: "2026-08-08T04:10:00.000Z",
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: "2026-08-08T04:00:00.000Z",
    executionWindowEndAt: "2026-08-08T04:10:00.000Z",
    recoveryObservationId: recovery.id,
    recoveryPreviousObservedAt: recovery.previousObservedAt,
    recoveryObservedAt: recovery.observedAt,
    tiboAnnouncedAt: notice.tweet_created_at,
    tiboPrimaryTweetId: notice.tweet_id,
    tiboSourceTweetIds: [notice.tweet_id],
    officialNoticeTweetId: notice.tweet_id,
    officialNoticeAt: notice.tweet_created_at,
    estimatorVersion: "usage-execution-v1",
  };

  const events = getShadowCompletedResetEvents({
    recent_tibo_signals: [notice],
    active_tibo_signals: [notice],
    codex_recovery_observations: [recovery],
    reset_execution_estimates: [estimate],
  }, new Date("2026-08-08T05:00:00.000Z"), []);

  assert.deepEqual(events, [{
    id: estimate.resetEventKey,
    resetAt: estimate.displayExecutionAt,
  }]);
});

test("hazard intervals ignore the period before the first event and use censored exposure after the last event", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const hazard = buildShadowHazard([
    event("a", "2026-08-01T00:00:00.000Z"),
    event("b", "2026-08-03T00:00:00.000Z"),
  ], now);

  assert.equal(hazard.completedIntervalCount, 1);
  assert.equal(hazard.observedEventCount, 1);
  assert.equal(hazard.totalExposureHours, 9.5 * 24);
  assert.equal(hazard.bins[0].exposureHours, 48);
  assert.equal(hazard.bins[1].exposureHours, 48);
  assert.equal(hazard.bins[7].exposureHours, 12);
});

test("hazard uses 24-hour bins and a 168-hour tail", () => {
  const hazard = buildShadowHazard([
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-11T00:00:00.000Z"),
  ], new Date("2026-01-11T12:00:00.000Z"));

  assert.equal(HAZARD_BIN_HOURS, 24);
  assert.equal(hazard.bins.length, 8);
  assert.deepEqual(hazard.bins.map((bin) => [bin.startHour, bin.endHour]), [
    [0, 24], [24, 48], [48, 72], [72, 96], [96, 120], [120, 144], [144, 168], [168, null],
  ]);
  assert.equal(hazard.bins[7].observedEvents, 1);
});

test("unit recency weighting is an exact v2 regression", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const defaultResult = calculateShadowProbability(data, { now });
  const unitWeightResult = calculateShadowProbabilityForModel(
    data,
    { now },
    { hazardOptions: { completedIntervalWeight: () => 1 } },
  );

  assert.equal(unitWeightResult.hazard.globalLambdaPerHour, defaultResult.hazard.globalLambdaPerHour);
  assert.deepEqual(unitWeightResult.hazard.bins, defaultResult.hazard.bins);
  assert.equal(unitWeightResult.hazard.observedEventCount, defaultResult.hazard.observedEventCount);
  assert.equal(unitWeightResult.hazard.weightedEventCount, defaultResult.hazard.weightedEventCount);
  assert.equal(unitWeightResult.baseline.probability24h, defaultResult.baseline.probability24h);
  assert.equal(unitWeightResult.baseline.probability48h, defaultResult.baseline.probability48h);
  assert.deepEqual(unitWeightResult.predictions, defaultResult.predictions);
});

test("Bayesian smoothing keeps each implied daily probability inside the safety range", () => {
  const hazard = buildShadowHazard([
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-02T00:00:00.000Z"),
  ], new Date("2026-01-02T01:00:00.000Z"));

  assert.equal(BIN_PRIOR_EQUIVALENT_EXPOSURE_DAYS, 20);
  for (const bin of hazard.bins) {
    assert.ok(bin.impliedDailyProbability >= MIN_BASELINE_DAILY_PROBABILITY);
    assert.ok(bin.impliedDailyProbability <= MAX_BASELINE_DAILY_PROBABILITY);
    assert.ok(bin.posteriorLambdaPerHour > 0);
  }
});

test("zero-event hazard data returns a finite safe curve", () => {
  const hazard = buildShadowHazard([], new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(hazard.completedIntervalCount, 0);
  assert.ok(Number.isFinite(hazard.globalLambdaPerHour));
  assert.ok(hazard.bins.every((bin) => Number.isFinite(bin.posteriorLambdaPerHour)));
});

test("the same hazard curve produces ordered continuous 24-hour and 48-hour probabilities", () => {
  const events = [
    event("a", "2026-08-01T00:00:00.000Z"),
    event("b", "2026-08-04T12:00:00.000Z"),
  ];
  const hazard = buildShadowHazard(events, new Date("2026-08-04T12:00:00.000Z"));
  const p24 = integrateHazardProbability(hazard, 0, 24);
  const p12 = integrateHazardProbability(hazard, 0, 12);
  const p48 = integrateHazardProbability(hazard, 0, 48);
  const p72 = integrateHazardProbability(hazard, 0, 72);
  const justBefore = integrateHazardProbability(hazard, 47.999, 24);
  const justAfter = integrateHazardProbability(hazard, 48.001, 24);

  assert.ok(p12 >= 0 && p12 <= 1);
  assert.ok(p12 <= p24);
  assert.ok(p24 >= 0 && p24 <= 1);
  assert.ok(p48 >= p24 && p48 <= 1);
  assert.ok(Number.isFinite(p72));
  assert.ok(p72 >= p48 && p72 <= 1);
  assert.ok(Math.abs(justAfter - justBefore) < 0.02);
});

test("hazard probability is independent of JST date boundaries", () => {
  const events = [
    event("a", "2026-08-01T00:00:00.000Z"),
    event("b", "2026-08-04T00:00:00.000Z"),
  ];
  const hazard = buildShadowHazard(events, new Date("2026-08-04T00:00:00.000Z"));
  const beforeJstMidnight = integrateHazardProbability(hazard, 71.99, 24);
  const afterJstMidnight = integrateHazardProbability(hazard, 72.01, 24);
  assert.ok(Math.abs(afterJstMidnight - beforeJstMidnight) < 0.02);
});

test("odds conversion and multiplier one are exact inverses", () => {
  for (const probability of [0, 0.01, 0.2, 0.5, 0.99, 1]) {
    assert.ok(Math.abs(oddsToProbability(probabilityToOdds(probability)) - probability) < 1e-12);
    assert.equal(applyOddsMultiplier(probability, 1), probability);
  }
});

test("signal multipliers use the specified conservative caps", () => {
  const multipliers = calculateShadowSignalMultipliers({
    recentResetCount7d: 3,
    regularResetProximity: 1,
    teaserScore: 1,
    normalizedStatusScore: 1,
    officialIncidentHintCount: 2,
    officialUpdateCount: 2,
    communityScore: 1,
    usageLimitAnomalyScore: 1,
    complaintPressure: "high",
  });

  assert.equal(multipliers.recentResetMomentum.probability24h, 1);
  assert.equal(multipliers.regularResetProximity.probability24h, 1);
  assert.equal(multipliers.teaser.probability24h, 1.8);
  assert.equal(multipliers.teaser.probability48h, 2.2);
  assert.equal(multipliers.statusSignal.probability24h, 1.5);
  assert.equal(multipliers.statusSignal.probability48h, 1.7);
  assert.equal(multipliers.complaintPressure.probability24h, 1.25);
  assert.ok(multipliers.combinedBeforeCap.probability24h > MAX_TOTAL_ODDS_MULTIPLIER_24H);
  assert.equal(multipliers.combinedAfterCap.probability24h, MAX_TOTAL_ODDS_MULTIPLIER_24H);
  assert.equal(multipliers.combinedAfterCap.probability48h, MAX_TOTAL_ODDS_MULTIPLIER_48H);
});

test("single incident hints and two official updates use bounded multipliers", () => {
  const multipliers = calculateShadowSignalMultipliers({
    recentResetCount7d: 0,
    regularResetProximity: 0,
    teaserScore: 0,
    normalizedStatusScore: 0,
    officialIncidentHintCount: 1,
    officialUpdateCount: 4,
    communityScore: 0,
    usageLimitAnomalyScore: 0,
    complaintPressure: "low",
  });

  assert.deepEqual(multipliers.officialIncidentHint, { probability24h: 1.75, probability48h: 1.9 });
  assert.deepEqual(multipliers.officialUpdate, { probability24h: 1.4, probability48h: 1.5 });
  assert.equal(multipliers.recentResetMomentum.probability24h, 1);
  assert.equal(multipliers.complaintPressure.probability24h, 1);
});

test("increasing a signal multiplier cannot reduce adjusted probability", () => {
  assert.ok(applyOddsMultiplier(0.2, 2) >= applyOddsMultiplier(0.2, 1));
  assert.ok(applyOddsMultiplier(0.8, 3) >= applyOddsMultiplier(0.8, 2));
});

test("shadow calculation uses official notice override without changing primary", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const notice: ActiveOfficialNotice = {
    origin: "local",
    id: "notice",
    title: "notice",
    summary: "notice",
    observedAt: now.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const data = getLocalRadarData({ calculationNow: now });
  const primary = getLocalProbabilityCalculation(data, { now, activeOfficialNotice: notice });
  const shadow = calculateShadowProbability(data, {
    now,
    activeOfficialNotice: notice,
  });

  assert.equal(primary.probability24h, 0.9);
  assert.equal(primary.probability48h, 0.96);
  assert.equal(shadow.predictions.probability24h, 0.9);
  assert.equal(shadow.predictions.probability48h, 0.96);
  assert.equal(shadow.predictions.probability12h, 1 - Math.pow(1 - 0.9, 12 / 24));
  assert.equal(shadow.predictions.probability72h, 1 - Math.pow(1 - 0.96, 72 / 48));
  assert.equal(shadow.officialNoticeOverride.probability72h, 1 - Math.pow(1 - 0.96, 72 / 48));
  assert.equal(shadow.officialNoticeOverride.probability12h, 1 - Math.pow(1 - 0.9, 12 / 24));
  assert.equal(shadow.officialNoticeOverride.active, true);
});

test("shadow calculation discovers the same active official notice when no override is passed", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "notice-default",
      signal_type: "official_notice",
      text: "Reset within 24 hours",
      tweet_url: "https://x.com/thsottiaux/status/123456",
      tweet_created_at: new Date(now.getTime() - HOUR_MS).toISOString(),
      expires_at: new Date(now.getTime() + DAY_MS).toISOString(),
      confidence: 0.99,
      verification_status: "auto_unverified",
    }],
  });

  const result = calculateShadowProbability(data, { now });
  assert.equal(result.officialNoticeOverride.active, true);
  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.equal(result.predictions.probability12h, 1 - Math.pow(1 - 0.9, 12 / 24));
  assert.equal(result.predictions.probability72h, 1 - Math.pow(1 - 0.96, 72 / 48));
});

test("shadow official notice probabilities follow a resolved schedule window per horizon", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const notice = (startHours: number, endHours = startHours): ActiveOfficialNotice => ({
    origin: "dynamic",
    id: `scheduled-notice-${startHours}`,
    title: "Scheduled reset",
    summary: "Scheduled reset",
    observedAt: now.toISOString(),
    expectedAt: new Date(now.getTime() + startHours * HOUR_MS).toISOString(),
    expectedEndAt: new Date(now.getTime() + endHours * HOUR_MS).toISOString(),
    expiresAt: new Date(now.getTime() + 72 * HOUR_MS).toISOString(),
    source: null,
    sourceLabel: "test",
    temporalPrecision: "exact_time",
    temporalConfidence: 1,
    temporalResolutionStatus: "resolved",
  });

  const within24 = calculateShadowProbability(data, {
    now,
    activeOfficialNotice: notice(6),
  });
  assert.equal(within24.predictions.probability24h, 0.9);
  assert.equal(within24.predictions.probability48h, 0.96);

  const within48Only = calculateShadowProbability(data, {
    now,
    activeOfficialNotice: notice(34),
  });
  assert.notEqual(within48Only.predictions.probability24h, 0.9);
  assert.equal(within48Only.predictions.probability48h, 0.96);
  assert.ok(within48Only.predictions.probability24h < within48Only.predictions.probability48h);

  const outside48 = calculateShadowProbability(data, {
    now,
    activeOfficialNotice: notice(60),
  });
  assert.notEqual(outside48.predictions.probability24h, 0.9);
  assert.notEqual(outside48.predictions.probability48h, 0.96);
});

test("shadow official notice schedule boundaries are inclusive and respect a crossing window", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const makeNotice = (startHours: number, endHours = startHours): ActiveOfficialNotice => ({
    origin: "dynamic",
    id: `boundary-notice-${startHours}-${endHours}`,
    title: "Scheduled reset",
    summary: "Scheduled reset",
    observedAt: now.toISOString(),
    expectedAt: new Date(now.getTime() + startHours * HOUR_MS).toISOString(),
    expectedEndAt: new Date(now.getTime() + endHours * HOUR_MS).toISOString(),
    expiresAt: new Date(now.getTime() + 72 * HOUR_MS).toISOString(),
    source: null,
    sourceLabel: "test",
    temporalPrecision: "exact_time",
    temporalConfidence: 1,
    temporalResolutionStatus: "resolved",
  });

  const at24 = calculateShadowProbability(data, { now, activeOfficialNotice: makeNotice(24) });
  assert.equal(at24.predictions.probability24h, 0.9);
  assert.equal(at24.predictions.probability48h, 0.96);

  const at48 = calculateShadowProbability(data, { now, activeOfficialNotice: makeNotice(48) });
  assert.notEqual(at48.predictions.probability24h, 0.9);
  assert.equal(at48.predictions.probability48h, 0.96);

  const crossing = calculateShadowProbability(data, {
    now,
    activeOfficialNotice: makeNotice(20, 28),
  });
  assert.equal(crossing.predictions.probability24h, 0.9);
  assert.equal(crossing.predictions.probability48h, 0.96);
});

test("72-hour shadow probability integrates the hazard and reuses the 48-hour multiplier", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const result = calculateShadowProbability(
    data,
    { now, activeOfficialNotice: null },
  );

  assert.equal(
    result.baseline.probability72h,
    integrateHazardProbability(result.hazard, getShadowBaselineAgeHours(data, now), 72),
  );
  assert.equal(
    result.predictions.probability72h,
    applyOddsMultiplier(
      result.baseline.probability72h,
      result.multipliers.combinedAfterCap.probability48h,
    ),
  );
  assert.equal("probability72h" in result.multipliers.combinedAfterCap, false);
});

test("running shadow calculation leaves the current primary calculation unchanged", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const before = getLocalProbabilityCalculation(data, { now });
  calculateShadowProbability(data, { now });
  const after = getLocalProbabilityCalculation(data, { now });
  assert.deepEqual(after, before);
  assert.ok(after.probability48h >= after.probability24h);
});

test("shadow confidence is low for the current small sample", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const result = calculateShadowProbability(getLocalRadarData({ calculationNow: now }), { now });
  assert.equal(result.modelVersion, SHADOW_PROBABILITY_MODEL_VERSION);
  assert.equal(result.confidence.level, "low");
});

test("shadow confidence becomes medium only after the interval and exposure floors", () => {
  const history = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index * 5));
    return resetEvent(`long-${index}`, date.toISOString());
  });
  const now = new Date("2025-06-10T00:00:00.000Z");
  localHistory(history, () => {
    const result = calculateShadowProbability(getLocalRadarData({ calculationNow: now }), { now });
    assert.equal(result.confidence.completedIntervalCount, 30);
    assert.ok(result.confidence.totalExposureDays >= 120);
    assert.equal(result.confidence.level, "medium");
  });
});

test("shadow result is stored in debug_info without changing the primary audit shape", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const primary = getLocalProbabilityCalculation(data, { now });
  const shadow = calculateShadowProbability(data, { now });
  const debugInfo = buildProbabilityDebugInfo({ existing: true }, primary, now.toISOString(), now, shadow);
  const serialized = JSON.stringify(debugInfo);

  assert.equal((debugInfo.probabilityModel as { version: string }).version, primary.modelVersion);
  assert.equal((debugInfo.shadowProbabilityModel as { modelVersion: string }).modelVersion, SHADOW_PROBABILITY_MODEL_VERSION);
  assert.doesNotMatch(serialized, /api[_-]?key|secret|authorization|tweet text/i);
});

test("shadow internals do not cross the public DTO boundary", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const internal = getLocalRadarData({ calculationNow: now });
  const publicSnapshot = toPublicRadarSnapshot(internal, "en", { calculationNow: now });
  const serialized = JSON.stringify(publicSnapshot);

  assert.doesNotMatch(serialized, /hazard-odds-v3-random-inclusive|hazard-odds-v2-random-only|posteriorLambdaPerHour|shadowProbabilityModel|combinedAfterCap/);
});

test("shadow result has no post content or secret-like fields", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const result = calculateShadowProbability({
    ...getLocalRadarData({ calculationNow: now }),
    active_tibo_signals: [{
      tweet_id: "private",
      signal_type: "teaser",
      text: "private tweet text",
      tweet_created_at: new Date(now.getTime() - HOUR_MS).toISOString(),
      confidence: 0.9,
      verification_status: "auto_unverified",
    }],
  }, { now });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private tweet text|api[_-]?key|secret|authorization/i);
});


test("resolved teaser timing moves teaser weight into overlapping forecast horizons", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "timed-teaser-48-only",
      signal_type: "teaser",
      text: "Might use the reset button tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/123456789",
      tweet_created_at: new Date(now.getTime() - HOUR_MS).toISOString(),
      expires_at: new Date(now.getTime() + 60 * HOUR_MS).toISOString(),
      confidence: 0.9,
      verification_status: "confirmed",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "exact_time",
      temporal_confidence: 1,
      expected_start_at: new Date(now.getTime() + 30 * HOUR_MS).toISOString(),
      expected_end_at: new Date(now.getTime() + 30 * HOUR_MS).toISOString(),
    }],
  });
  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);

  assert.equal(inputs.teaserScore24h, 0);
  assert.ok((inputs.teaserScore48h ?? 0) > 0);
  assert.equal(multipliers.teaser.probability24h, 1);
  assert.ok(multipliers.teaser.probability48h > 1);
});

test("untimed formal teasers keep the existing horizon boost behavior", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "untimed-teaser",
      signal_type: "teaser",
      text: "Might use the reset button soon.",
      tweet_url: "https://x.com/thsottiaux/status/987654321",
      tweet_created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
      confidence: 0.9,
      verification_status: "confirmed",
      is_reply: false,
    }],
  });
  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);

  assert.equal(inputs.teaserScore24h, 1);
  assert.equal(inputs.teaserScore48h, 1);
  assert.equal(multipliers.teaser.probability24h, 1.8);
  assert.equal(multipliers.teaser.probability48h, 2.2);
});


test("resolved timed teasers do not decay just because the post gets older inside the hinted window", () => {
  const signal = {
    tweet_id: "timed-no-age-decay",
    signal_type: "teaser" as const,
    text: "Reset button tomorrow.",
    tweet_url: "https://x.com/thsottiaux/status/timed-no-age-decay",
    tweet_created_at: "2026-08-04T00:00:00.000Z",
    expires_at: "2026-08-06T03:00:00.000Z",
    confidence: 0.9,
    verification_status: "confirmed" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "day" as const,
    temporal_confidence: 1,
    expected_start_at: "2026-08-05T00:00:00.000Z",
    expected_end_at: "2026-08-06T00:00:00.000Z",
  };

  for (const now of [
    new Date("2026-08-05T01:00:00.000Z"),
    new Date("2026-08-05T12:00:00.000Z"),
    new Date("2026-08-05T23:00:00.000Z"),
  ]) {
    const data = getLocalRadarData({ calculationNow: now, activeTiboSignals: [signal] });
    const evaluation = getLocalSignalEvaluation(data, now);
    const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
    const multipliers = calculateShadowSignalMultipliers(inputs);
    assert.equal(inputs.teaserScore24h, 1);
    assert.equal(inputs.teaserScore48h, 1);
    assert.equal(multipliers.teaser.probability24h, 1.8);
    assert.equal(multipliers.teaser.probability48h, 2.2);
  }
});

test("resolved timed teaser weight fades through the three-hour grace instead of falling off a cliff", () => {
  const now = new Date("2026-08-06T01:30:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "timed-grace",
      signal_type: "teaser",
      text: "Reset button tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/timed-grace",
      tweet_created_at: "2026-08-04T00:00:00.000Z",
      expires_at: "2026-08-06T03:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "day",
      temporal_confidence: 1,
      expected_start_at: "2026-08-05T00:00:00.000Z",
      expected_end_at: "2026-08-06T00:00:00.000Z",
    }],
  });
  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);
  assert.equal(inputs.teaserScore24h, 0.5);
  assert.equal(inputs.teaserScore48h, 0.5);
  assert.equal(multipliers.teaser.probability24h, 1.4);
  assert.equal(multipliers.teaser.probability48h, 1.6);
});


test("timed formal teaser strength compounds with the formal teaser slot", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "timed-formal-strong",
      signal_type: "teaser",
      text: "Reset button tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/timed-formal-strong",
      tweet_created_at: "2026-08-04T00:00:00.000Z",
      expires_at: "2026-08-06T03:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      teaser_strength: "strong",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "day",
      temporal_confidence: 1,
      expected_start_at: "2026-08-05T00:00:00.000Z",
      expected_end_at: "2026-08-06T00:00:00.000Z",
    }],
  });

  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);

  assert.equal(inputs.teaserScore24h, 1);
  assert.equal(inputs.teaserScore48h, 1);
  assert.equal(multipliers.teaser.probability24h, 1.8);
  assert.equal(multipliers.teaser.probability48h, 2.2);
  assert.equal(multipliers.teaserStrength.probability24h, 1.6);
  assert.equal(multipliers.teaserStrength.probability48h, 1.6);
  assert.ok(Math.abs(multipliers.combinedBeforeCap.probability24h - 2.88) < 1e-12);
  assert.ok(Math.abs(multipliers.combinedBeforeCap.probability48h - 3.52) < 1e-12);
});

test("timed formal weak teaser gets only the bounded weak strength increment", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "timed-formal-weak",
      signal_type: "teaser",
      text: "Maybe reset tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/timed-formal-weak",
      tweet_created_at: "2026-08-04T00:00:00.000Z",
      expires_at: "2026-08-06T03:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      teaser_strength: "weak",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "day",
      temporal_confidence: 1,
      expected_start_at: "2026-08-05T00:00:00.000Z",
      expected_end_at: "2026-08-06T00:00:00.000Z",
    }],
  });

  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);

  assert.equal(multipliers.teaserStrength.probability24h, 1.15);
  assert.equal(multipliers.teaserStrength.probability48h, 1.2);
});

test("untimed formal strong teaser does not receive the timed strength increment", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "untimed-formal-strong",
      signal_type: "teaser",
      text: "Reset button soon.",
      tweet_url: "https://x.com/thsottiaux/status/untimed-formal-strong",
      tweet_created_at: now.toISOString(),
      expires_at: "2026-08-06T12:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      teaser_strength: "strong",
      is_reply: false,
    }],
  });

  const evaluation = getLocalSignalEvaluation(data, now);
  const inputs = getShadowSignalInputs(data, now, evaluation, null, null, true, []);
  const multipliers = calculateShadowSignalMultipliers(inputs);

  assert.equal(multipliers.teaserStrength.probability24h, 1);
  assert.equal(multipliers.teaserStrength.probability48h, 1);
});
