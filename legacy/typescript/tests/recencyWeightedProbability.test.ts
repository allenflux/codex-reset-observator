import assert from "node:assert/strict";
import test from "node:test";

import {
  RECENCY_SHADOW_MODEL_CONFIG,
  calculateRecencyWeightedShadowProbability,
  getRecencyDecayWeight,
} from "../lib/radar/recencyWeightedProbability";
import {
  GLOBAL_PRIOR_EVENT_COUNT,
  GLOBAL_PRIOR_EXPOSURE_DAYS,
} from "../data/shadowProbabilityConfig";
import { buildShadowHazard, type ShadowResetEvent } from "../lib/radar/shadowProbability";
import { getLocalRadarData } from "../lib/radar";
import type { ActiveOfficialNotice } from "../lib/radar/probability";

const HOUR_MS = 60 * 60 * 1000;

function event(id: string, resetAt: string): ShadowResetEvent {
  return { id, resetAt };
}

test("recency weight is one half after one half-life", () => {
  assert.ok(Math.abs(getRecencyDecayWeight(14, 14) - 0.5) < 1e-12);
});

test("newer completed intervals receive more weight than older intervals", () => {
  const now = new Date("2026-03-01T00:00:00.000Z");
  const older = getRecencyDecayWeight(60, 30);
  const newer = getRecencyDecayWeight(5, 30);
  assert.ok(newer > older);

  const hazard = buildShadowHazard([
    event("old-start", "2025-12-31T00:00:00.000Z"),
    event("old-end", "2026-01-01T00:00:00.000Z"),
    event("new-end", "2026-02-25T00:00:00.000Z"),
  ], now, {
    completedIntervalWeight: ({ currentTime }) =>
      getRecencyDecayWeight((now.getTime() - currentTime) / (24 * HOUR_MS), 30),
  });

  assert.ok(hazard.weightedEventCount < hazard.observedEventCount);
  const weightedBinEvents = hazard.bins.reduce((sum, bin) => sum + bin.observedEvents, 0);
  assert.ok(weightedBinEvents < hazard.observedEventCount);
  assert.ok(weightedBinEvents > 0);
});

test("completed event and exposure use the same decay weight", () => {
  const now = new Date("2026-02-15T00:00:00.000Z");
  const intervalHours = 24;
  const weight = getRecencyDecayWeight(30, 30);
  const hazard = buildShadowHazard([
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-02T00:00:00.000Z"),
  ], now, {
    completedIntervalWeight: () => weight,
  });

  assert.equal(hazard.observedEventCount, 1);
  assert.ok(Math.abs(hazard.weightedEventCount - weight) < 1e-12);
  assert.ok(Math.abs(hazard.totalExposureHours - (intervalHours * weight + 44 * 24)) < 1e-9);
  assert.ok(Math.abs(hazard.weightedExposureHours - hazard.totalExposureHours) < 1e-12);
});

test("weighted exposure preserves every original segment of a 96-hour interval", () => {
  const now = new Date("2026-01-05T00:00:00.000Z");
  const hazard = buildShadowHazard([
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-05T00:00:00.000Z"),
  ], now, {
    completedIntervalWeight: () => 0.5,
  });

  assert.equal(hazard.completedIntervalCount, 1);
  assert.deepEqual(
    hazard.bins.slice(0, 4).map((bin) => bin.exposureHours),
    [12, 12, 12, 12],
  );
  assert.equal(hazard.bins[4].exposureHours, 0);
  assert.equal(hazard.bins[4].observedEvents, 0.5);
  assert.equal(hazard.weightedEventCount, 0.5);
});

test("global lambda uses the same recency weight for events and exposure", () => {
  const now = new Date("2026-01-05T00:00:00.000Z");
  const weighted = buildShadowHazard([
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-05T00:00:00.000Z"),
  ], now, {
    completedIntervalWeight: () => 0.5,
  });
  const priorExposureHours = GLOBAL_PRIOR_EXPOSURE_DAYS * 24;
  const effectiveEventCount = (
    weighted.globalLambdaPerHour * (weighted.totalExposureHours + priorExposureHours)
  ) - GLOBAL_PRIOR_EVENT_COUNT;
  const priorExcludedRate = effectiveEventCount / weighted.totalExposureHours;

  assert.ok(Math.abs(effectiveEventCount - weighted.weightedEventCount) < 1e-12);
  assert.ok(Math.abs(priorExcludedRate - (1 / 96)) < 1e-12);
});

test("invalid half-life is rejected", () => {
  assert.throws(() => getRecencyDecayWeight(1, 0), /half-life/i);
  assert.throws(() => getRecencyDecayWeight(1, Number.NaN), /half-life/i);
});

test("a very long half-life approaches the unweighted hazard", () => {
  const now = new Date("2026-02-15T00:00:00.000Z");
  const events = [
    event("a", "2026-01-01T00:00:00.000Z"),
    event("b", "2026-01-02T00:00:00.000Z"),
  ];
  const unweighted = buildShadowHazard(events, now);
  const nearlyUnweighted = buildShadowHazard(events, now, {
    completedIntervalWeight: ({ currentTime }) =>
      getRecencyDecayWeight((now.getTime() - currentTime) / (24 * HOUR_MS), 1_000_000),
  });

  assert.ok(Math.abs(nearlyUnweighted.globalLambdaPerHour - unweighted.globalLambdaPerHour) < 1e-7);
  assert.ok(Math.abs(nearlyUnweighted.totalExposureHours - unweighted.totalExposureHours) < 1e-3);
});

test("fixed recency models preserve ordered finite probabilities", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  assert.deepEqual(RECENCY_SHADOW_MODEL_CONFIG.map((item) => item.halfLifeDays), [14, 30, 60]);

  for (const { modelVersion, halfLifeDays } of RECENCY_SHADOW_MODEL_CONFIG) {
    const result = calculateRecencyWeightedShadowProbability(data, halfLifeDays, { now });
    assert.equal(result.modelVersion, modelVersion);
    assert.ok(Number.isFinite(result.predictions.probability24h));
    assert.ok(Number.isFinite(result.predictions.probability48h));
    assert.ok(result.predictions.probability24h >= 0);
    assert.ok(result.predictions.probability48h <= 1);
    assert.ok(result.predictions.probability48h >= result.predictions.probability24h);
  }
});

test("recency models preserve the official notice override", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const notice: ActiveOfficialNotice = {
    origin: "local",
    id: "recency-notice",
    title: "notice",
    summary: "notice",
    observedAt: now.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const result = calculateRecencyWeightedShadowProbability(
    getLocalRadarData({ calculationNow: now }),
    30,
    { now, activeOfficialNotice: notice },
  );

  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.equal(result.officialNoticeOverride.active, true);
});
