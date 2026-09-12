import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { buildNextGenerationExperimentalProbabilityForecasts } from "../lib/nextGenerationLogging";
import { getLocalRadarData } from "../lib/radar";
import {
  calculateNextGenerationBPostResetAgeCandidate,
  calculateNextGenerationBProbability,
} from "../lib/radar/nextGenerationProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";
import {
  PROSPECTIVE_PUBLISHED_ACTIVE_MODEL_VERSION,
  PROSPECTIVE_PUBLISHED_BASELINE_MODEL_VERSION,
  evaluatePublishedModelProspectively,
} from "../lib/radar/prospectivePublishedModelEvaluation";
import type { NextGenerationTrainingState } from "../lib/radar/nextGenerationTraining";

const V2_ADOPTION_BOUNDARY = "2026-09-01T08:00:00.000Z";
const HYBRID_ADOPTION_BOUNDARY = "2026-09-10T01:00:00.000Z";

function trainingState(): NextGenerationTrainingState {
  return {
    status: "ok",
    reason: null,
    bRows: [],
    aRows: [],
    cRows: [],
    cV2Rows: [],
    totalRows: 0,
    skipReasons: {
      pre_freeze: 0,
      missing_b_forecast: 0,
      invalid_b_forecast: 0,
      incomplete_a_components: 0,
      invalid_generated_at: 0,
    },
    backfill: false,
  };
}

function resetHistory(now: Date, ageHours: number) {
  return [{
    id: `post-reset-${ageHours}`,
    recordKind: "confirmed_global" as const,
    title: "ランダムリセット",
    kind: "reset_completed" as const,
    status: "closed" as const,
    resetAt: new Date(now.getTime() - ageHours * 60 * 60 * 1000).toISOString(),
    opened_at: new Date(now.getTime() - ageHours * 60 * 60 * 1000).toISOString(),
    closed_at: new Date(now.getTime() - ageHours * 60 * 60 * 1000).toISOString(),
    completed_at: new Date(now.getTime() - ageHours * 60 * 60 * 1000).toISOString(),
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  }];
}

test("promotion metadata names selective hybrid v3 with v2 as its previous and B v1 calibration source", () => {
  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(
    NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
    NEXT_GENERATION_B_MODEL_VERSION,
  );
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_AT, HYBRID_ADOPTION_BOUNDARY);
  assert.equal(PROSPECTIVE_PUBLISHED_ACTIVE_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(PROSPECTIVE_PUBLISHED_BASELINE_MODEL_VERSION, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
});

test("the hybrid v3 adoption boundary keeps v2 before it and selects hybrid at the boundary", () => {
  const before = new Date("2026-09-09T22:59:59.999Z");
  const exact = new Date(HYBRID_ADOPTION_BOUNDARY);

  const beforeResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: before }),
    { now: before, activeOfficialNotice: null },
    { logFallback: false },
  );
  const exactResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: exact }),
    { now: exact, activeOfficialNotice: null },
    { logFallback: false },
  );

  assert.equal(beforeResult.adoptedModel, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(beforeResult.nextGenerationB?.modelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(exactResult.nextGenerationB?.modelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(exactResult.adoptedModel, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
});

test("the historical v2 boundary preserves B v1 before it and v2 after it", () => {
  const boundaryTime = Date.parse(V2_ADOPTION_BOUNDARY);
  const before = new Date(boundaryTime - 1);
  const exact = new Date(boundaryTime);
  const after = new Date(boundaryTime + 1);
  const beforeResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: before }),
    { now: before, activeOfficialNotice: null },
    { logFallback: false },
  );
  const afterResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: after }),
    { now: after, activeOfficialNotice: null },
    { logFallback: false },
  );

  assert.equal(beforeResult.adoptedModel, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(beforeResult.nextGenerationB?.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  const exactResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: exact }),
    { now: exact, activeOfficialNotice: null },
    { logFallback: false },
  );
  assert.equal(exactResult.adoptedModel, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(exactResult.nextGenerationB?.modelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(afterResult.adoptedModel, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(afterResult.nextGenerationB?.modelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
});

test("v2 inherits B calibration and changes only post-reset age attenuation before 24h", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const options = {
    now,
    staticHistory: resetHistory(now, 12),
    activeOfficialNotice: null,
    trainingRows: [],
    trainingReadStatus: "ok" as const,
  };
  const b = calculateNextGenerationBProbability(data, options);
  const v2 = calculateNextGenerationBPostResetAgeCandidate(data, options);

  assert.notEqual(v2.predictions.probability24h, b.predictions.probability24h);
  assert.notEqual(v2.predictions.probability48h, b.predictions.probability48h);
  assert.equal(v2.alpha24h, b.alpha24h);
  assert.equal(v2.alpha48h, b.alpha48h);
  assert.equal(v2.calibrationSampleCount24h, b.calibrationSampleCount24h);
  assert.equal(v2.calibrationSampleCount48h, b.calibrationSampleCount48h);
  assert.equal(
    v2.calibrationTrainingModelVersion,
    NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  );
  assert.equal(v2.regimeMultiplierPolicyVersion, NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION);
});

test("v2 and B v1 agree once post-reset age reaches 24 hours", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const options = {
    now,
    staticHistory: resetHistory(now, 30),
    activeOfficialNotice: null,
    trainingRows: [],
    trainingReadStatus: "ok" as const,
  };
  const b = calculateNextGenerationBProbability(data, options);
  const v2 = calculateNextGenerationBPostResetAgeCandidate(data, options);

  assert.deepEqual(v2.predictions, b.predictions);
  assert.equal(v2.rawProbability24h, b.rawProbability24h);
  assert.equal(v2.rawProbability48h, b.rawProbability48h);
  assert.equal(v2.alpha24h, b.alpha24h);
  assert.equal(v2.alpha48h, b.alpha48h);
});

test("logging stores v2, selective hybrid, and the old B baseline at the same origin", () => {
  const generatedAt = new Date("2026-09-01T02:00:00.000Z");
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: generatedAt },
    existingForecasts: {},
    trainingState: trainingState(),
  });
  const active = forecasts[NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION];
  const baseline = forecasts[NEXT_GENERATION_B_MODEL_VERSION];
  const hybrid = forecasts[NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION];

  assert.ok(active);
  assert.ok(baseline);
  assert.ok(hybrid);
  assert.equal(active.generatedAt, baseline.generatedAt);
  assert.equal(active.modelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(baseline.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(hybrid.modelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(
    active.calibrationTrainingModelVersion,
    NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  );
  assert.equal(
    baseline.calibrationTrainingModelVersion,
    NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  );
});

test("prospective evaluation uses only post-boundary hybrid and v2 rows", () => {
  const before = "2026-09-09T22:00:00.000Z";
  const after = "2026-09-10T02:00:00.000Z";
  const row = (generatedAt: string) => ({
    generatedAt,
    loggedHour: generatedAt,
    forecasts: {
      [NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
        generatedAt,
        probability24h: 0.2,
        probability48h: 0.4,
      },
      [NEXT_GENERATION_B_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
        generatedAt,
        probability24h: 0.3,
        probability48h: 0.5,
      },
      [NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
        generatedAt,
        probability24h: 0.25,
        probability48h: 0.4,
      },
    },
  });
  const report = evaluatePublishedModelProspectively(
    [row(before), row(after)],
    [],
    new Date("2026-09-12T00:00:00.000Z"),
    { adoptionAt: HYBRID_ADOPTION_BOUNDARY },
  );

  assert.deepEqual(report.forecastCounts, { active: 1, baseline: 1, comparable: 1 });
  assert.equal(report.evaluationStartAt, after);
  assert.equal(report.activeModelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(report.baselineModelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
});
