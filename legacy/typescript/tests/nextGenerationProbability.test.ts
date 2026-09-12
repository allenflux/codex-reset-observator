import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  NEXT_GENERATION_V3_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_FREEZE_POLICY,
  calculateNextGenerationBProbability,
  calculateNextGenerationBPostResetAgeCandidate,
  calculateNextGenerationSelectiveCalibrationProbability,
  calculateNextGenerationV3Probability,
  enforceNextGenerationHorizonCoherence,
  selectNextGenerationCalibrationRows,
} from "../lib/radar/nextGenerationProbability";
import { getLocalRadarData } from "../lib/radar";

test("next-generation model versions and freeze metadata are preregistered", () => {
  assert.equal(NEXT_GENERATION_A_MODEL_VERSION, "hazard-ensemble-logit-stack-v1");
  assert.equal(NEXT_GENERATION_B_MODEL_VERSION, "hazard-regime-random-continuous-calibrated-v1");
  assert.equal(NEXT_GENERATION_FREEZE_AT, "2026-08-21T03:27:00.000Z");
  assert.equal(
    NEXT_GENERATION_FREEZE_POLICY,
    "A single reset, miss, or new observation must not trigger retuning.",
  );
});

test("next-generation horizon coherence never lowers 24h", () => {
  assert.deepEqual(enforceNextGenerationHorizonCoherence(0.4, 0.2), {
    probability24h: 0.4,
    probability48h: 0.4,
    adjusted: true,
  });
  assert.deepEqual(enforceNextGenerationHorizonCoherence(0.2, 0.4), {
    probability24h: 0.2,
    probability48h: 0.4,
    adjusted: false,
  });
});

test("B calibration rows are freeze-boundary and JST daily-first only", () => {
  const rows = selectNextGenerationCalibrationRows([
    {
      generatedAt: "2026-08-21T03:26:59.000Z",
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: 0.1,
      rawProbability48h: 0.2,
      actual24h: true,
      actual48h: true,
    },
    {
      generatedAt: "2026-08-21T04:00:00.000Z",
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: 0.2,
      rawProbability48h: 0.3,
      actual24h: true,
      actual48h: true,
    },
    {
      generatedAt: "2026-08-21T04:30:00.000Z",
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: 0.3,
      rawProbability48h: 0.4,
      actual24h: true,
      actual48h: true,
    },
    {
      generatedAt: "2026-08-22T01:00:00.000Z",
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: 0.4,
      rawProbability48h: 0.5,
      actual24h: true,
      actual48h: true,
    },
  ], new Date("2026-08-23T02:00:00.000Z"), 24);

  assert.deepEqual(rows.map((row) => row.generatedAt), [
    "2026-08-21T04:00:00.000Z",
    "2026-08-22T01:00:00.000Z",
  ]);
  assert.deepEqual(
    selectNextGenerationCalibrationRows([
      {
        generatedAt: "2026-08-21T04:00:00.000Z",
        modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
        rawProbability24h: 0.2,
        rawProbability48h: 0.3,
        actual24h: true,
        actual48h: true,
      },
      {
        generatedAt: "2026-08-22T01:00:00.000Z",
        modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
        rawProbability24h: 0.4,
        rawProbability48h: 0.5,
        actual24h: true,
        actual48h: true,
      },
    ], new Date("2026-08-23T05:00:00.000Z"), 48).map((row) => row.generatedAt), [
      "2026-08-21T04:00:00.000Z",
    ],
  );
});

test("B cold start uses zero alpha and keeps the random clock across regular recovery", () => {
  const now = new Date("2026-08-22T03:00:00.000Z");
  const result = calculateNextGenerationBProbability(
    getLocalRadarData({ calculationNow: now }),
    { now, trainingRows: [], trainingReadStatus: "ok" },
  );

  assert.equal(result.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
  assert.equal(result.calibrationSampleCount24h, 0);
  assert.equal(result.calibrationSampleCount48h, 0);
  assert.ok(result.predictions.probability48h >= result.predictions.probability24h);
  assert.equal(result.randomContinuous.randomElapsedHours >= 0, true);
});

test("v3 keeps calibration as audit data but uses raw signal-adjusted horizons publicly", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const trainingRows = Array.from({ length: 10 }, (_, index) => ({
    generatedAt: new Date(Date.parse("2026-08-21T04:00:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
    rawProbability24h: 0.2,
    rawProbability48h: 0.3,
    actual24h: index === 0,
    actual48h: index === 0,
  }));
  const result = calculateNextGenerationV3Probability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: [],
      activeOfficialNotice: null,
      trainingRows,
      trainingReadStatus: "ok",
    },
  );

  assert.equal(result.modelVersion, NEXT_GENERATION_V3_MODEL_VERSION);
  assert.equal(result.publicCalibrationPolicy, "diagnostic-only");
  assert.ok(result.calibrationSampleCount24h > 0);
  assert.ok(result.calibrationSampleCount48h > 0);
  assert.equal(result.predictions.probability24h, result.rawProbability24h);
  assert.equal(result.predictions.probability48h, result.rawProbability48h);
});

test("existing B v1 and v2 keep the applied calibration policy", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const options = { now, staticHistory: [], activeOfficialNotice: null };
  assert.equal(
    calculateNextGenerationBProbability(getLocalRadarData({ calculationNow: now }), options).publicCalibrationPolicy,
    "apply",
  );
  assert.equal(
    (calculateNextGenerationV3Probability(getLocalRadarData({ calculationNow: now }), options).publicCalibrationPolicy),
    "diagnostic-only",
  );
});

test("v3 keeps the official notice timing policy and strong teaser floor", () => {
  const noticeNow = new Date("2026-08-04T00:00:00.000Z");
  const notice = {
    origin: "local" as const,
    id: "v3-notice",
    title: "Reset notice",
    summary: "Reset notice",
    observedAt: noticeNow.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(noticeNow.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const noticeResult = calculateNextGenerationV3Probability(
    getLocalRadarData({ calculationNow: noticeNow }),
    { now: noticeNow, activeOfficialNotice: notice, staticHistory: [], trainingRows: [] },
  );
  assert.equal(noticeResult.officialNoticeOverride.active, true);
  assert.equal(noticeResult.predictions.probability24h, 0.9);
  assert.equal(noticeResult.predictions.probability48h, 0.96);

  const floorNow = new Date("2026-08-28T07:00:00.000Z");
  const floorResult = calculateNextGenerationV3Probability(
    getLocalRadarData({
      calculationNow: floorNow,
      activeTiboSignals: [{
        tweet_id: "v3-strong-floor",
        signal_type: "teaser",
        text: "Reset button tomorrow.",
        tweet_created_at: "2026-08-28T06:00:00.000Z",
        teaser_strength: "strong",
        temporal_resolution_status: "resolved",
        expected_start_at: "2026-08-29T07:00:00.000Z",
        expected_end_at: "2026-08-29T07:00:00.000Z",
      }],
    }),
    { now: floorNow, activeOfficialNotice: null, staticHistory: [], trainingRows: [] },
  );
  assert.equal(floorResult.officialNoticeOverride.active, false);
  assert.ok(floorResult.predictions.probability24h >= 0.7);
  assert.ok(floorResult.predictions.probability48h >= 0.85);
});

test("v3 preserves the training-read error contract while exposing raw fallback probabilities", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const result = calculateNextGenerationV3Probability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      activeOfficialNotice: null,
      staticHistory: [],
      trainingRows: [],
      trainingReadStatus: "error",
    },
  );

  assert.equal(result.trainingReadStatus, "error");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, "prediction_history_training_query_failed");
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
  assert.equal(result.calibrationSampleCount24h, 0);
  assert.equal(result.calibrationSampleCount48h, 0);
  assert.equal(result.predictions.probability24h, result.rawProbability24h);
  assert.equal(result.predictions.probability48h, result.rawProbability48h);
});

test("selective calibration uses the raw 24h base and calibrated 48h base", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const trainingRows = Array.from({ length: 10 }, (_, index) => ({
    generatedAt: new Date(Date.parse("2026-08-21T04:00:00.000Z") + index * 24 * 60 * 60 * 1000).toISOString(),
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
    rawProbability24h: 0.2,
    rawProbability48h: 0.3,
    actual24h: index === 0,
    actual48h: index === 0,
  }));
  const options = {
    now,
    staticHistory: [],
    activeOfficialNotice: null,
    trainingRows,
    trainingReadStatus: "ok" as const,
  };
  const hybrid = calculateNextGenerationSelectiveCalibrationProbability(
    getLocalRadarData({ calculationNow: now }),
    options,
  );
  const v2 = calculateNextGenerationBPostResetAgeCandidate(
    getLocalRadarData({ calculationNow: now }),
    options,
  );

  assert.equal(hybrid.modelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.deepEqual(hybrid.calibrationPolicy, {
    probability24h: "diagnostic-only",
    probability48h: "apply",
  });
  assert.equal(hybrid.publicCalibrationPolicy, "mixed");
  assert.ok(hybrid.calibrationSampleCount24h > 0);
  assert.ok(hybrid.calibrationSampleCount48h > 0);
  assert.equal(hybrid.predictions.probability24h, hybrid.rawProbability24h);
  assert.equal(hybrid.predictions.probability48h, v2.predictions.probability48h);
});

test("apply/apply records a calibration-stage horizon coherence adjustment", () => {
  const now = new Date("2026-09-10T12:00:00.000Z");
  const trainingRows = Array.from({ length: 12 }, (_, index) => ({
    generatedAt: new Date(now.getTime() - (index + 3) * 24 * 60 * 60 * 1000).toISOString(),
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
    rawProbability24h: 0.8,
    rawProbability48h: 0.8,
    actual24h: true,
    actual48h: false,
  }));
  const data = getLocalRadarData({ calculationNow: now });
  const options = {
    now,
    staticHistory: [],
    activeOfficialNotice: null,
    trainingRows,
    trainingReadStatus: "ok" as const,
  };
  const results = [
    calculateNextGenerationBProbability(data, options),
    calculateNextGenerationBPostResetAgeCandidate(data, options),
  ];

  for (const result of results) {
    assert.equal(result.predictions.probability48h, result.predictions.probability24h);
    assert.equal(result.horizonCoherenceAdjusted, true);
  }
});

test("coherence metadata stays false and public values stay stable without adjustment", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const options = {
    now,
    staticHistory: [],
    activeOfficialNotice: null,
    trainingRows: [],
    trainingReadStatus: "ok" as const,
  };
  const data = getLocalRadarData({ calculationNow: now });
  const expected = {
    probability12h: 0.048770575499286095,
    probability24h: 0.0951625819640407,
    probability48h: 0.18126924692201907,
    probability72h: 0.25918177931828335,
  };
  const results = [
    calculateNextGenerationBProbability(data, options),
    calculateNextGenerationBPostResetAgeCandidate(data, options),
    calculateNextGenerationSelectiveCalibrationProbability(data, options),
  ];

  for (const result of results) {
    assert.deepEqual(result.predictions, expected);
    assert.equal(result.horizonCoherenceAdjusted, false);
  }
});

test("B calibration selection keeps 24h and 48h horizon cutoffs strict", () => {
  const row = {
    generatedAt: "2026-08-21T04:00:00.000Z",
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
    rawProbability24h: 0.2,
    rawProbability48h: 0.3,
    actual24h: true,
    actual48h: false,
  };
  const asOf = new Date("2026-08-22T10:00:00.000Z");
  assert.equal(selectNextGenerationCalibrationRows([row], asOf, 24).length, 1);
  assert.equal(selectNextGenerationCalibrationRows([row], asOf, 48).length, 0);
});
