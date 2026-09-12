import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_FREEZE_AT,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import type { WindowEventLike } from "../lib/radar/types";
import {
  buildRandomElapsedHazard,
  calculateRandomElapsedProbability,
} from "../lib/radar/randomElapsedProbability";
import {
  buildRegimeElapsedHazard,
  calculateRegimeElapsedProbability,
} from "../lib/radar/regimeElapsedProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";
import { getRecoveryResetEvents } from "../lib/radar/recoveryBoundary";

function resetEvent(
  id: string,
  completedAt: string,
  cycleType: "ランダムリセット" | "定期リセット" = "ランダムリセット",
): WindowEventLike {
  return {
    id,
    recordKind: cycleType === "ランダムリセット" ? "confirmed_global" : "regular_completed",
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
  };
}

const HISTORY = [
  resetEvent("random-a", "2026-08-01T00:00:00.000Z"),
  resetEvent("regular", "2026-08-06T00:00:00.000Z", "定期リセット"),
  resetEvent("random-b", "2026-08-08T00:00:00.000Z"),
];

const NOW_AFTER_REGULAR = new Date("2026-08-06T01:00:00.000Z");

function getBoundaries(now: Date = NOW_AFTER_REGULAR) {
  return getRecoveryResetEvents(getLocalRadarData({ calculationNow: now }), now, HISTORY);
}

test("random clock keeps elapsed age through a regular recovery boundary", () => {
  const boundaries = getBoundaries();
  const random = buildRandomElapsedHazard(boundaries, NOW_AFTER_REGULAR);
  const recovery = buildRegimeElapsedHazard(boundaries, NOW_AFTER_REGULAR);

  assert.equal(random.completedIntervalCount, 0);
  assert.equal(random.observedEventCount, 0);
  assert.equal(recovery.completedIntervalCount, 1);
  assert.ok(random.totalExposureHours > 120);
});

test("random clock uses the next random boundary as the event endpoint", () => {
  const now = new Date("2026-08-08T01:00:00.000Z");
  const boundaries = getBoundaries(now);
  const random = buildRandomElapsedHazard(boundaries, now);
  const recovery = buildRegimeElapsedHazard(boundaries, now);

  assert.equal(random.completedIntervalCount, 1);
  assert.equal(random.observedEventCount, 1);
  assert.equal(recovery.completedIntervalCount, 2);
  assert.equal(recovery.observedEventCount, 1);
});

test("random shadow audit exposes both clocks and keeps regime and signal inputs aligned", () => {
  const now = NOW_AFTER_REGULAR;
  const data = getLocalRadarData({ calculationNow: now });
  const publicResult = calculateRegimeElapsedProbability(data, {
    now,
    staticHistory: HISTORY,
    activeOfficialNotice: null,
  });
  const randomResult = calculateRandomElapsedProbability(data, {
    now,
    staticHistory: HISTORY,
    activeOfficialNotice: null,
  });

  assert.equal(randomResult.modelVersion, RANDOM_ELAPSED_SHADOW_MODEL_VERSION);
  assert.equal(randomResult.randomElapsed.freezeAt, RANDOM_ELAPSED_SHADOW_FREEZE_AT);
  assert.ok(randomResult.randomElapsed.randomElapsedHours > 120);
  assert.ok(randomResult.randomElapsed.recoveryElapsedHours < 2);
  assert.equal(
    randomResult.randomElapsed.regime.regimeMultiplier,
    publicResult.regimeElapsed.regime.regimeMultiplier,
  );
  assert.deepEqual(randomResult.multipliers, publicResult.multipliers);
  assert.equal(randomResult.randomElapsed.randomBoundaryCount, 1);
  assert.equal(randomResult.randomElapsed.regularBoundaryCount, 1);
});

test("random shadow resets its clock after a random event", () => {
  const now = new Date("2026-08-08T01:00:00.000Z");
  const result = calculateRandomElapsedProbability(getLocalRadarData({ calculationNow: now }), {
    now,
    staticHistory: HISTORY,
    activeOfficialNotice: null,
  });

  assert.ok(result.randomElapsed.randomElapsedHours < 2);
  assert.ok(result.randomElapsed.recoveryElapsedHours < 2);
});

test("random shadow preserves target separation from the adopted calibrated public model", () => {
  const now = new Date("2026-08-06T01:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const before = calculateRegimeElapsedProbability(data, {
    now,
    staticHistory: HISTORY,
    activeOfficialNotice: null,
  });
  const random = calculateRandomElapsedProbability(data, {
    now,
    staticHistory: HISTORY,
    activeOfficialNotice: null,
  });
  const published = calculatePublishedProbability(data, { now }, { logFallback: false });
  const publicClock = calculateRegimeElapsedProbability(
    data,
    { now },
    PUBLISHED_ELAPSED_MODEL_OPTIONS,
  );

  assert.notEqual(random.modelVersion, before.modelVersion);
  assert.match(random.targetDefinition, /random reset.*regular resets remain recovery boundaries/i);
  assert.ok(before.predictions.probability24h >= 0);
  assert.ok(before.predictions.probability48h >= before.predictions.probability24h);
  assert.equal(published.adoptedModel, "hazard-odds-v4-logit-calibrated-prequential-v3");
  assert.equal(published.source, "calibrated");
  assert.equal(published.probability24h, published.calibrated?.probability24h);
  assert.equal(published.probability48h, published.calibrated?.probability48h);
  assert.notEqual(published.probability24h, publicClock.predictions.probability24h);
  assert.notEqual(published.probability48h, publicClock.predictions.probability48h);
});
