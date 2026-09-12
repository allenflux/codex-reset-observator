import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  RECENCY_H30_PROBABILITY_MODEL_VERSION,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import type { ExperimentalProbabilityForecasts } from "../lib/logProbability";
import { buildNextGenerationExperimentalProbabilityForecasts } from "../lib/nextGenerationLogging";
import type { NextGenerationTrainingState } from "../lib/radar/nextGenerationTraining";

function existingForecasts(generatedAt: string): ExperimentalProbabilityForecasts {
  const entries: Array<[string, ExperimentalProbabilityForecasts[string]]> = [
    [CALIBRATED_SHADOW_MODEL_VERSION, 0.2],
    [REGIME_ELAPSED_FULL_MODEL_VERSION, 0.25],
    [RANDOM_ELAPSED_SHADOW_MODEL_VERSION, 0.3],
    [RECENCY_H30_PROBABILITY_MODEL_VERSION, 0.35],
  ].map(([modelVersion, probability]) => [modelVersion, {
    modelVersion,
    generatedAt,
    probability24h: probability,
    probability48h: Number(probability) + 0.1,
    halfLifeDays: null,
    completedEventCount: 10,
    completedIntervalCount: 9,
    weightedEventCount: 10,
    weightedExposureDays: 20,
    baseline24h: probability,
    baseline48h: Number(probability) + 0.1,
    combinedSignalMultiplier24h: 1,
    combinedSignalMultiplier48h: 1,
    officialNoticeOverride: false,
    targetDefinition: "completed broad random reset",
  }] as [string, ExperimentalProbabilityForecasts[string]]);
  return Object.fromEntries(entries);
}

function state(status: "ok" | "error"): NextGenerationTrainingState {
  return {
    status,
    reason: status === "error" ? "prediction_history query failed" : null,
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

test("C starts only at its own freeze and never changes A v1 components", () => {
  const before = new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) - 1);
  const after = new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) + 60_000);
  const beforeForecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: before },
    existingForecasts: existingForecasts(before.toISOString()),
    trainingState: state("ok"),
  });
  const afterForecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: after },
    existingForecasts: existingForecasts(after.toISOString()),
    trainingState: state("ok"),
  });

  assert.equal(beforeForecasts[NEXT_GENERATION_C_MODEL_VERSION], undefined);
  assert.ok(beforeForecasts[NEXT_GENERATION_B_MODEL_VERSION]);
  assert.ok(beforeForecasts[NEXT_GENERATION_A_MODEL_VERSION]);
  assert.ok(afterForecasts[NEXT_GENERATION_C_MODEL_VERSION]);
  assert.deepEqual(
    afterForecasts[NEXT_GENERATION_A_MODEL_VERSION].componentModelVersions,
    [...NEXT_GENERATION_A_COMPONENT_VERSIONS],
  );
  assert.equal(
    (afterForecasts[NEXT_GENERATION_A_MODEL_VERSION].componentModelVersions as readonly string[] | undefined)
      ?.includes(NEXT_GENERATION_C_MODEL_VERSION),
    false,
  );
});

test("C persists context and ablation audit without mutating existing forecast objects", () => {
  const now = new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) + 60_000);
  const existing = existingForecasts(now.toISOString());
  const publicBefore = structuredClone(existing[CALIBRATED_SHADOW_MODEL_VERSION]);
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now },
    existingForecasts: existing,
    trainingState: state("ok"),
  });
  const c = forecasts[NEXT_GENERATION_C_MODEL_VERSION] as any;

  assert.equal(c.modelVersion, NEXT_GENERATION_C_MODEL_VERSION);
  assert.equal(c.nextGenerationRole, "candidate-c");
  assert.equal(typeof c.randomResetCount72h, "number");
  assert.ok("previousRandomIntervalHours" in c);
  assert.equal(typeof c.hourSin, "number");
  assert.equal(typeof c.hourCos, "number");
  assert.equal(typeof c.contextCoefficients, "object");
  assert.equal(typeof c.burstStats, "object");
  assert.equal(typeof c.contextSolver, "object");
  assert.equal(typeof c.ablations, "object");
  assert.equal(typeof c.ablations.baseOnly.probability24h, "number");
  assert.equal(typeof c.ablations.fullRaw.probability48h, "number");
  assert.deepEqual(existing[CALIBRATED_SHADOW_MODEL_VERSION], publicBefore);
});

test("training DB failure keeps C with zero calibration while existing A rule still omits A", () => {
  const now = new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) + 60_000);
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now },
    existingForecasts: existingForecasts(now.toISOString()),
    trainingState: state("error"),
  });
  const c = forecasts[NEXT_GENERATION_C_MODEL_VERSION] as any;

  assert.ok(forecasts[NEXT_GENERATION_B_MODEL_VERSION]);
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION], undefined);
  assert.ok(c);
  assert.equal(c.trainingReadStatus, "error");
  assert.equal(c.alpha24h, 0);
  assert.equal(c.alpha48h, 0);
});

test("logging adds C v2 only after its own freeze and preserves C v1", () => {
  const now = new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 60_000);
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now, staticHistory: [], activeOfficialNotice: null },
    existingForecasts: existingForecasts(now.toISOString()),
    trainingState: state("ok"),
  });

  const cV1 = forecasts[NEXT_GENERATION_C_MODEL_VERSION] as Record<string, unknown>;
  const cV2 = forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION] as Record<string, unknown>;
  assert.ok(cV1);
  assert.ok(cV2);
  assert.equal(cV1.nextGenerationRole, "candidate-c");
  assert.equal(cV2.nextGenerationRole, "candidate-c-v2");
  assert.equal(cV2.modelVersion, NEXT_GENERATION_C_V2_MODEL_VERSION);
  assert.equal(typeof cV2.circadianNormalizationConstant, "number");
  assert.equal(typeof cV2.circadianCycleMeanBeforeNormalization, "number");
  assert.equal(typeof cV2.circadianCycleMeanAfterNormalization, "number");
  assert.equal(typeof cV2.contextCoefficients, "object");
  assert.equal(typeof cV2.ablations, "object");
  assert.equal(typeof cV2.normalizedAblations, "object");
});
