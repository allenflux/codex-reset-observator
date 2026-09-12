import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import {
  buildRandomContinuousHazard,
  calculateRandomContinuousProbability,
  getPostResetRegimeMultiplierAtAge,
  integrateRandomContinuousHazard,
} from "../lib/radar/randomContinuousProbability";
import { getStrongTimedTeaserProbabilityFloor } from "../lib/radar/shadowProbability";
import {
  calculateNextGenerationBPostResetAgeCandidate,
  calculateNextGenerationBProbability,
} from "../lib/radar/nextGenerationProbability";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";
import type { WindowEventLike } from "../lib/radar/types";

const HOUR_MS = 60 * 60 * 1000;

function boundary(
  id: string,
  resetAt: string,
  isRandom = true,
  isRegular = false,
): RecoveryResetBoundary {
  return { id, resetAt, isRandom, isRegular, sourceIds: [id] };
}

function resetEvent(id: string, completedAt: string): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: "ランダムリセット",
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
  };
}

test("post-reset regime attenuation is flat before 24h and returns to full at 24h", () => {
  const fullMultiplier = 1.5;
  const oneSecondBeforeBoundary = 24 - (1 / 60 / 60);
  const expected = new Map([
    [0, 1],
    [3, 1],
    [6, 1],
    [12, 1],
    [20, 1],
    [24, 1.5],
    [30, 1.5],
    [36, 1.5],
    [48, 1.5],
  ]);

  for (const [ageHours, multiplier] of Array.from(expected.entries())) {
    assert.equal(
      getPostResetRegimeMultiplierAtAge(ageHours, fullMultiplier),
      multiplier,
    );
  }
  assert.equal(getPostResetRegimeMultiplierAtAge(oneSecondBeforeBoundary, fullMultiplier), 1);
  assert.equal(getPostResetRegimeMultiplierAtAge(60, fullMultiplier), fullMultiplier);
  assert.equal(getPostResetRegimeMultiplierAtAge(30, 0.5), 0.5);
});

test("the 24-hour boundary remains finite and horizon coherent", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z"),
    boundary("random-b", "2026-08-03T00:00:00.000Z"),
  ], now, { integrationStepMinutes: 10 });
  const ages = [24 - (1 / 60 / 60), 24];

  for (const ageHours of ages) {
    const probabilities = [12, 24, 48, 72].map((horizonHours) =>
      integrateRandomContinuousHazard(
        hazard,
        ageHours,
        horizonHours,
        1.75,
        getPostResetRegimeMultiplierAtAge,
      ));
    assert.ok(probabilities.every((probability) => Number.isFinite(probability)));
    assert.ok(probabilities[0] <= probabilities[1]);
    assert.ok(probabilities[1] <= probabilities[2]);
    assert.ok(probabilities[2] <= probabilities[3]);
  }
});

test("attenuation is applied at every continuous integration step", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z"),
    boundary("random-b", "2026-08-03T00:00:00.000Z"),
  ], now, { integrationStepMinutes: 60 });

  const noRegime24h = integrateRandomContinuousHazard(hazard, 0, 24, 1);
  const attenuated24h = integrateRandomContinuousHazard(
    hazard,
    0,
    24,
    1.5,
    getPostResetRegimeMultiplierAtAge,
  );
  assert.ok(Math.abs(attenuated24h - noRegime24h) < 1e-12);

  const noRegime48h = integrateRandomContinuousHazard(hazard, 0, 48, 1);
  const fullRegime48h = integrateRandomContinuousHazard(hazard, 0, 48, 1.5);
  const attenuated48h = integrateRandomContinuousHazard(
    hazard,
    0,
    48,
    1.5,
    getPostResetRegimeMultiplierAtAge,
  );
  assert.ok(noRegime48h < attenuated48h);
  assert.ok(attenuated48h < fullRegime48h);

  const attenuatedAfterBoundary = integrateRandomContinuousHazard(
    hazard,
    24,
    24,
    1.5,
    getPostResetRegimeMultiplierAtAge,
  );
  const fullAfterBoundary = integrateRandomContinuousHazard(hazard, 24, 24, 1.5);
  assert.ok(Math.abs(attenuatedAfterBoundary - fullAfterBoundary) < 1e-12);

  const sampledAges: number[] = [];
  integrateRandomContinuousHazard(
    hazard,
    0,
    48,
    1.5,
    (ageHours, regimeMultiplier) => {
      sampledAges.push(ageHours);
      return getPostResetRegimeMultiplierAtAge(ageHours, regimeMultiplier);
    },
  );
  assert.ok(sampledAges.some((ageHours) => ageHours < 24));
  assert.ok(sampledAges.some((ageHours) => ageHours >= 24));
});

function calculateBrier(prediction: number, actual: boolean) {
  return (prediction - Number(actual)) ** 2;
}

function calculateLogLoss(prediction: number, actual: boolean) {
  const safePrediction = Math.min(1 - 1e-12, Math.max(1e-12, prediction));
  return -(Number(actual) * Math.log(safePrediction)
    + Number(!actual) * Math.log(1 - safePrediction));
}

test("prospective post-reset audit keeps plain outcomes separate from a strong teaser", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const hazard = buildRandomContinuousHazard([
    boundary("random-a", "2026-08-01T00:00:00.000Z"),
    boundary("random-b", "2026-08-03T00:00:00.000Z"),
  ], now, { integrationStepMinutes: 60 });
  const regimeMultiplier = 1.5;
  const fixture = [
    { id: "+2.5h negative", ageHours: 2.5, actual24h: false, actual48h: false, signal: "plain" },
    { id: "+2.8h negative", ageHours: 2.8, actual24h: false, actual48h: false, signal: "plain" },
    { id: "+6.1h negative", ageHours: 6.1, actual24h: false, actual48h: false, signal: "plain" },
    { id: "+8.3h positive with strong timed teaser", ageHours: 8.3, actual24h: true, actual48h: true, signal: "strong_timed_teaser" },
  ] as const;
  const forecasts = fixture.map((item) => ({
    ...item,
    current: {
      probability24h: integrateRandomContinuousHazard(hazard, item.ageHours, 24, regimeMultiplier),
      probability48h: integrateRandomContinuousHazard(hazard, item.ageHours, 48, regimeMultiplier),
    },
    candidate: {
      probability24h: integrateRandomContinuousHazard(
        hazard,
        item.ageHours,
        24,
        regimeMultiplier,
        getPostResetRegimeMultiplierAtAge,
      ),
      probability48h: integrateRandomContinuousHazard(
        hazard,
        item.ageHours,
        48,
        regimeMultiplier,
        getPostResetRegimeMultiplierAtAge,
      ),
    },
    elapsedOnly: {
      probability24h: integrateRandomContinuousHazard(hazard, item.ageHours, 24, 1),
      probability48h: integrateRandomContinuousHazard(hazard, item.ageHours, 48, 1),
    },
  }));

  assert.equal(forecasts.filter((item) => item.signal === "plain").length, 3);
  assert.equal(forecasts.filter((item) => item.signal === "strong_timed_teaser").length, 1);
  for (const item of forecasts) {
    for (const model of [item.current, item.candidate, item.elapsedOnly]) {
      assert.ok(Number.isFinite(model.probability24h));
      assert.ok(Number.isFinite(model.probability48h));
      assert.ok(model.probability24h <= model.probability48h);
    }
  }

  const plain24h = forecasts.filter((item) => item.signal === "plain").map((item) => ({
    prediction: item.candidate.probability24h,
    actual: item.actual24h,
  }));
  const teaser24h = forecasts.filter((item) => item.signal === "strong_timed_teaser").map((item) => ({
    prediction: item.candidate.probability24h,
    actual: item.actual24h,
  }));
  const plainMetrics = {
    brier: plain24h.reduce((sum, value) => sum + calculateBrier(value.prediction, value.actual), 0) / plain24h.length,
    logLoss: plain24h.reduce((sum, value) => sum + calculateLogLoss(value.prediction, value.actual), 0) / plain24h.length,
  };
  const teaserMetrics = {
    brier: calculateBrier(teaser24h[0].prediction, teaser24h[0].actual),
    logLoss: calculateLogLoss(teaser24h[0].prediction, teaser24h[0].actual),
  };
  assert.ok(Number.isFinite(plainMetrics.brier));
  assert.ok(Number.isFinite(plainMetrics.logLoss));
  assert.ok(Number.isFinite(teaserMetrics.brier));
  assert.ok(Number.isFinite(teaserMetrics.logLoss));
});

test("the age-attenuated B candidate has a distinct version and is the configured public model", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const history = [resetEvent("random-a", new Date(now.getTime() - 12 * HOUR_MS).toISOString())];
  const data = getLocalRadarData({ calculationNow: now });
  const options = {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
    trainingRows: [],
  };

  const current = calculateNextGenerationBProbability(data, options);
  const candidate = calculateNextGenerationBPostResetAgeCandidate(data, options);

  assert.equal(current.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(candidate.modelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(
    candidate.regimeMultiplierPolicyVersion,
    NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  );
  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
});

test("the candidate preserves the existing signal multiplier policy", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const staticHistory = [resetEvent("random-a", "2026-08-04T12:00:00.000Z")];
  const signal = {
    tweet_id: "timed-strong-teaser",
    signal_type: "teaser" as const,
    text: "Reset button tomorrow.",
    tweet_url: "https://x.com/thsottiaux/status/timed-strong-teaser",
    tweet_created_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-08-06T03:00:00.000Z",
    confidence: 0.9,
    verification_status: "confirmed" as const,
    teaser_strength: "strong" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "day" as const,
    temporal_confidence: 1,
    expected_start_at: "2026-08-05T18:00:00.000Z",
    expected_end_at: "2026-08-05T18:00:00.000Z",
  };
  const baseData = getLocalRadarData({ calculationNow: now });
  const signaledData = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [signal],
  });
  const options = {
    now,
    staticHistory,
    activeOfficialNotice: null,
    trainingRows: [],
  };

  const baseline = calculateNextGenerationBPostResetAgeCandidate(baseData, options);
  const signaled = calculateNextGenerationBPostResetAgeCandidate(signaledData, options);
  const existingFloor = getStrongTimedTeaserProbabilityFloor(
    signaledData,
    now,
    Date.parse("2026-08-04T12:00:00.000Z"),
  );
  assert.ok(signaled.predictions.probability24h > baseline.predictions.probability24h);
  assert.ok(signaled.predictions.probability48h > baseline.predictions.probability48h);
  assert.ok(existingFloor);
  assert.ok(signaled.predictions.probability24h >= existingFloor.probability24h);
  assert.ok(signaled.predictions.probability48h >= existingFloor.probability48h);
});

test("the candidate preserves the official notice override and 72-hour coherence", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const notice = {
    origin: "local" as const,
    id: "notice",
    title: "notice",
    summary: "notice",
    observedAt: now.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const result = calculateNextGenerationBPostResetAgeCandidate(
    getLocalRadarData({ calculationNow: now }),
    { now, activeOfficialNotice: notice, trainingRows: [] },
  );

  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.ok(Number.isFinite(result.predictions.probability72h));
  assert.ok(result.predictions.probability12h <= result.predictions.probability24h);
  assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
  assert.ok(result.predictions.probability48h <= result.predictions.probability72h);
});

test("the age candidate remains a research comparison and does not change the existing continuous shadow entry point", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const history = [resetEvent("random-a", "2026-08-10T00:00:00.000Z")];
  const result = calculateRandomContinuousProbability(
    getLocalRadarData({ calculationNow: now }),
    { now, staticHistory: history, activeOfficialNotice: null },
  );

  assert.equal(result.modelVersion, "hazard-regime-random-continuous-v1");
  assert.equal(result.randomContinuous.effectiveRegimeMultiplier, result.randomContinuous.regimeMultiplier);
});
