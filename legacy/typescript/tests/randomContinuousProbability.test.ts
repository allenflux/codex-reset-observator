import assert from "node:assert/strict";
import test from "node:test";

import { PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS } from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";
import type { WindowEventLike } from "../lib/radar/types";
import {
  buildRandomContinuousHazard,
  calculateRandomContinuousProbability,
  getRandomContinuousHazardAtAge,
  integrateRandomContinuousHazard,
} from "../lib/radar/randomContinuousProbability";
import { getRandomElapsedBoundaries } from "../lib/radar/randomElapsedProbability";
import { calculateRandomElapsedProbability } from "../lib/radar/randomElapsedProbability";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";
import { getRecoveryResetEvents } from "../lib/radar/recoveryBoundary";

function boundary(
  id: string,
  resetAt: string,
  isRandom: boolean,
  isRegular: boolean,
): RecoveryResetBoundary {
  return { id, resetAt, isRandom, isRegular, sourceIds: [id] };
}

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

test("continuous hazard uses completed random intervals and right-censored current exposure only", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z", true, false),
    boundary("random-b", "2026-08-03T00:00:00.000Z", true, false),
  ], now);

  assert.deepEqual(hazard.eventAgesHours, [48]);
  assert.equal(hazard.completedIntervalCount, 1);
  assert.equal(hazard.censoredExposureHours, 24);
  assert.equal(hazard.totalExposureHours, 72);
  assert.equal(hazard.completedEventCount, 2);
  assert.equal(hazard.weightedEventCount, 1);
  assert.equal(hazard.exposureCells.length, 72);
  assert.equal(hazard.exposureCells.reduce((sum, cell) => sum + cell.eventCount, 0), 1);
});

test("continuous hazard preserves partial-hour exposure", () => {
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z", true, false),
    boundary("random-b", "2026-08-01T00:30:00.000Z", true, false),
  ], new Date("2026-08-01T01:00:00.000Z"));

  assert.equal(hazard.totalExposureHours, 1);
  assert.equal(hazard.exposureCells.reduce((sum, cell) => sum + cell.exposureHours, 0), 1);
  assert.equal(hazard.exposureCells.reduce((sum, cell) => sum + cell.eventCount, 0), 1);
});

function boundariesFromIntervals(intervals: number[]) {
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const boundaries = [boundary("random-0", new Date(time).toISOString(), true, false)];
  intervals.forEach((hours, index) => {
    time += hours * 60 * 60 * 1000;
    boundaries.push(boundary(`random-${index + 1}`, new Date(time).toISOString(), true, false));
  });
  return boundaries;
}

test("synthetic event clusters leave a lower continuous hazard in the 120-168h gap", () => {
  const hazard = buildRandomContinuousHazard(
    boundariesFromIntervals([96, 96, 108, 180, 192, 192, 204]),
    new Date("2026-01-20T00:00:00.000Z"),
  );

  assert.ok(getRandomContinuousHazardAtAge(hazard, 144) < getRandomContinuousHazardAtAge(hazard, 96));
  assert.ok(getRandomContinuousHazardAtAge(hazard, 144) < getRandomContinuousHazardAtAge(hazard, 192));
});

test("extending a censored current interval adds exposure without adding a 144h event", () => {
  const boundaries = boundariesFromIntervals([120]);
  const before = buildRandomContinuousHazard(
    boundaries,
    new Date("2026-01-11T00:00:00.000Z"),
  );
  const after = buildRandomContinuousHazard(
    boundaries,
    new Date("2026-01-12T06:00:00.000Z"),
  );

  assert.deepEqual(after.eventAgesHours, before.eventAgesHours);
  assert.equal(after.censoredExposureHours, 150);
  assert.ok(getRandomContinuousHazardAtAge(after, 144) <= getRandomContinuousHazardAtAge(before, 144));
});

test("regular boundaries do not split the random clock or become random events", () => {
  const now = new Date("2026-08-03T01:00:00.000Z");
  const history = [
    resetEvent("random-a", "2026-08-01T00:00:00.000Z"),
    resetEvent("regular", "2026-08-02T00:00:00.000Z", "定期リセット"),
    resetEvent("random-b", "2026-08-03T00:00:00.000Z"),
  ];
  const boundaries = getRecoveryResetEvents(getLocalRadarData({ calculationNow: now }), now, history);
  const randomBoundaries = getRandomElapsedBoundaries(boundaries);
  const hazard = buildRandomContinuousHazard(randomBoundaries, now);

  assert.equal(boundaries.filter((item) => item.isRegular).length, 1);
  assert.equal(randomBoundaries.length, 2);
  assert.deepEqual(hazard.eventAgesHours, [48]);
  assert.equal(hazard.completedIntervalCount, 1);
});

test("continuous and coarse random shadows share boundary, regime, signal, and notice inputs", () => {
  const now = new Date("2026-08-03T01:00:00.000Z");
  const history = [
    resetEvent("random-a", "2026-08-01T00:00:00.000Z"),
    resetEvent("regular", "2026-08-02T00:00:00.000Z", "定期リセット"),
    resetEvent("random-b", "2026-08-03T00:00:00.000Z"),
  ];
  const data = getLocalRadarData({ calculationNow: now });
  const continuous = calculateRandomContinuousProbability(data, {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
  });
  const coarse = calculateRandomElapsedProbability(data, {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
  });

  assert.deepEqual(continuous.randomContinuous.randomBoundaryIds, ["random-a", "random-b"]);
  assert.equal(continuous.randomContinuous.randomBoundaryCount, coarse.randomElapsed.randomBoundaryCount);
  assert.equal(continuous.randomContinuous.regularBoundaryCount, coarse.randomElapsed.regularBoundaryCount);
  assert.equal(continuous.randomContinuous.latestRandomResetAt, coarse.randomElapsed.latestRandomResetAt);
  assert.equal(continuous.randomContinuous.regimeMultiplier, coarse.randomElapsed.regime.regimeMultiplier);
  assert.deepEqual(continuous.multipliers, coarse.multipliers);
  assert.deepEqual(continuous.officialNoticeOverride, coarse.officialNoticeOverride);
});

test("random shadows reuse a supplied regime-elapsed result", () => {
  const now = new Date("2026-08-03T01:00:00.000Z");
  const options = {
    now,
    activeOfficialNotice: null,
  };
  const data = getLocalRadarData({ calculationNow: now });
  const regimeElapsed = calculateRegimeElapsedProbability(
    data,
    options,
    PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  );
  const supplied = {
    ...regimeElapsed,
    multipliers: {
      ...regimeElapsed.multipliers,
      combinedAfterCap: {
        ...regimeElapsed.multipliers.combinedAfterCap,
        probability24h: regimeElapsed.multipliers.combinedAfterCap.probability24h + 0.1,
        probability48h: regimeElapsed.multipliers.combinedAfterCap.probability48h + 0.1,
      },
    },
    regimeElapsed: {
      ...regimeElapsed.regimeElapsed,
      regime: {
        ...regimeElapsed.regimeElapsed.regime,
        regimeMultiplier: regimeElapsed.regimeElapsed.regime.regimeMultiplier + 0.1,
      },
    },
  };

  const continuous = calculateRandomContinuousProbability(data, options, supplied);
  const coarse = calculateRandomElapsedProbability(data, options, {}, supplied);

  assert.deepEqual(continuous.multipliers, supplied.multipliers);
  assert.equal(
    continuous.randomContinuous.regimeMultiplier,
    supplied.regimeElapsed.regime.regimeMultiplier,
  );
  assert.deepEqual(coarse.multipliers, supplied.multipliers);
  assert.equal(
    coarse.randomElapsed.regime.regimeMultiplier,
    supplied.regimeElapsed.regime.regimeMultiplier,
  );
});

test("continuous integration is finite, smooth across adjacent ages, and horizon-monotone", () => {
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z", true, false),
    boundary("random-b", "2026-08-03T00:00:00.000Z", true, false),
  ], new Date("2026-08-04T00:00:00.000Z"));
  const at95 = getRandomContinuousHazardAtAge(hazard, 95);
  const at96 = getRandomContinuousHazardAtAge(hazard, 96);
  const probabilities = [12, 24, 48, 72].map((horizon) =>
    integrateRandomContinuousHazard(hazard, 24, horizon, 1.25),
  );

  assert.ok(Number.isFinite(at95));
  assert.ok(Number.isFinite(at96));
  assert.ok(Math.abs(at96 - at95) < 0.001);
  assert.ok(probabilities.every((value) => Number.isFinite(value)));
  assert.ok(probabilities[0] <= probabilities[1]);
  assert.ok(probabilities[1] <= probabilities[2]);
  assert.ok(probabilities[2] <= probabilities[3]);
});

test("continuous shadow calculation does not change the published probability", () => {
  const now = new Date("2026-08-03T01:00:00.000Z");
  const history = [
    resetEvent("random-a", "2026-08-01T00:00:00.000Z"),
    resetEvent("random-b", "2026-08-03T00:00:00.000Z"),
  ];
  const data = getLocalRadarData({ calculationNow: now });
  const before = calculatePublishedProbability(data, { now }, { logFallback: false });
  const continuous = calculateRandomContinuousProbability(data, {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
  });
  const after = calculatePublishedProbability(data, { now }, { logFallback: false });

  assert.equal(continuous.modelVersion, "hazard-regime-random-continuous-v1");
  assert.deepEqual(after, before);
});

test("continuous shadow preserves the existing official notice override", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
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
  const result = calculateRandomContinuousProbability(getLocalRadarData({ calculationNow: now }), {
    now,
    activeOfficialNotice: notice,
  });

  assert.equal(result.officialNoticeOverride.active, true);
  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.ok(result.predictions.probability12h <= result.predictions.probability24h);
  assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
  assert.ok(result.predictions.probability48h <= result.predictions.probability72h);
});
