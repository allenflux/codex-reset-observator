import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_B_MODEL_ADOPTION_AT,
  PUBLISHED_PROBABILITY_HISTORICAL_V4_ADOPTION_AT,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT,
  PUBLISHED_PROBABILITY_V4_ROLLBACK_AT,
  ELAPSED_ONLY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { buildNextGenerationExperimentalProbabilityForecasts } from "../lib/nextGenerationLogging";
import { getLocalRadarData } from "../lib/radar";
import {
  getPublishedProbabilityPeriodAt,
  calculatePublishedProbability,
  selectPublishedProbability,
} from "../lib/radar/publishedProbability";
import {
  evaluatePublishedModelProspectively,
  selectDailyFirstPublishedForecastsForPeriod,
} from "../lib/radar/prospectivePublishedModelEvaluation";
import { getLocalProbabilityCalculation } from "../lib/radar/probability";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";
import { PUBLISHED_ELAPSED_MODEL_OPTIONS } from "../data/shadowProbabilityConfig";
import type { NextGenerationTrainingState } from "../lib/radar/nextGenerationTraining";

const ROLLBACK_AT = "2026-09-11T01:00:00.000Z";

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

function comparableV3Row(generatedAt: string) {
  return {
    generatedAt,
    loggedHour: generatedAt,
    forecasts: {
      [NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
        generatedAt,
        probability24h: 0.2,
        probability48h: 0.4,
      },
      [NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
        generatedAt,
        probability24h: 0.3,
        probability48h: 0.5,
      },
    },
  };
}

test("corrective rollback rollout records a future boundary without changing the v3 identity", () => {
  assert.equal(PUBLISHED_PROBABILITY_V4_ROLLBACK_AT, "2026-09-11T02:20:00.000Z");
  assert.equal(PUBLISHED_PROBABILITY_HISTORICAL_V4_ADOPTION_AT, "2026-08-20T11:21:37.105Z");
  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
});

test("published model periods keep historical V4 and corrective V4 separate", () => {
  assert.equal(
    getPublishedProbabilityPeriodAt("2026-08-20T11:21:37.104Z", { rollbackAt: ROLLBACK_AT }),
    "historical-elapsed-v1",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt("2026-08-20T11:21:37.105Z", { rollbackAt: ROLLBACK_AT }),
    "historical-v4",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt("2026-08-23T02:03:59.999Z", { rollbackAt: ROLLBACK_AT }),
    "historical-v4",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt(PUBLISHED_PROBABILITY_B_MODEL_ADOPTION_AT, { rollbackAt: ROLLBACK_AT }),
    "b-v1",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt(PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT, { rollbackAt: ROLLBACK_AT }),
    "b-v2",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt(PUBLISHED_PROBABILITY_ADOPTION_AT!, { rollbackAt: ROLLBACK_AT }),
    "selective-v3",
  );
  assert.equal(
    getPublishedProbabilityPeriodAt(ROLLBACK_AT, { rollbackAt: ROLLBACK_AT }),
    "corrective-rollback-v4",
  );
});

test("published evaluator keeps old and corrective V4 periods as separate daily-first sets", () => {
  const rows = [
    { generatedAt: "2026-08-22T00:00:00.000Z", loggedHour: "2026-08-22T00:00:00.000Z", forecasts: {} },
    { generatedAt: "2026-09-11T02:00:00.000Z", loggedHour: "2026-09-11T02:00:00.000Z", forecasts: {} },
  ];
  const oldV4 = selectDailyFirstPublishedForecastsForPeriod(rows, "historical-v4", { rollbackAt: ROLLBACK_AT });
  const correctiveV4 = selectDailyFirstPublishedForecastsForPeriod(rows, "corrective-rollback-v4", { rollbackAt: ROLLBACK_AT });

  assert.deepEqual(oldV4.map((row) => row.generatedAt), ["2026-08-22T00:00:00.000Z"]);
  assert.deepEqual(correctiveV4.map((row) => row.generatedAt), ["2026-09-11T02:00:00.000Z"]);
});

test("published v3 evaluation ends at a future rollback boundary while the v3 shadow scoreboard continues", () => {
  const report = evaluatePublishedModelProspectively(
    [
      comparableV3Row("2026-09-10T05:00:00.000Z"),
      comparableV3Row("2026-09-11T02:00:00.000Z"),
    ],
    [],
    new Date("2026-09-12T00:00:00.000Z"),
    { rollbackAt: ROLLBACK_AT },
  );

  assert.equal(report.forecastCounts.comparable, 1);
  assert.equal(report.evaluationStartAt, "2026-09-10T05:00:00.000Z");
  assert.equal(report.scoreboard.dailyFirstOriginCount, 2);
  assert.match(report.notes.join("\n"), /rollback boundary/);
});

test("rollback boundary selects valid V4 at the exact instant while still computing v3 shadow", () => {
  const before = new Date("2026-09-11T00:59:59.999Z");
  const exact = new Date(ROLLBACK_AT);
  const beforeResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: before }),
    { now: before, publishedV4RollbackAt: ROLLBACK_AT },
    { logFallback: false },
  );
  const exactResult = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: exact }),
    { now: exact, publishedV4RollbackAt: ROLLBACK_AT },
    { logFallback: false },
  );

  assert.equal(beforeResult.adoptedModel, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(exactResult.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(exactResult.nextGenerationB?.modelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.ok(exactResult.calibrated);
  assert.equal(exactResult.probability24h, exactResult.calibrated.probability24h);
  assert.equal(exactResult.probability48h, exactResult.calibrated.probability48h);
});

test("rollback hides a B/v3 shadow failure when valid calibrated V4 is selected", () => {
  const now = new Date(ROLLBACK_AT);
  const data = getLocalRadarData({ calculationNow: now });
  const current = calculatePublishedProbability(
    data,
    { now, publishedV4RollbackAt: ROLLBACK_AT },
    { logFallback: false },
  );
  const primary = getLocalProbabilityCalculation(data, { now });

  assert.ok(current.calibrated);
  assert.ok(current.stableShadow);

  const rollbackSelected = selectPublishedProbability(
    primary,
    current.calibrated,
    current.stableShadow,
    "next_generation_b_exception",
    null,
    current.rawShadow,
    null,
    { allowNextGenerationB: false },
  );
  assert.equal(rollbackSelected.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(rollbackSelected.source, "calibrated");
  assert.equal(rollbackSelected.fallbackReason, null);

  const rollbackInvalidShadowSelected = selectPublishedProbability(
    primary,
    current.calibrated,
    current.stableShadow,
    "next_generation_b_invalid_prediction",
    null,
    current.rawShadow,
    null,
    { allowNextGenerationB: false },
  );
  assert.equal(rollbackInvalidShadowSelected.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(rollbackInvalidShadowSelected.source, "calibrated");
  assert.equal(rollbackInvalidShadowSelected.fallbackReason, null);

  const preRollbackSelected = selectPublishedProbability(
    primary,
    current.calibrated,
    current.stableShadow,
    "next_generation_b_exception",
    null,
    current.rawShadow,
    null,
  );
  assert.equal(preRollbackSelected.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(preRollbackSelected.fallbackReason, "next_generation_b_exception");
});

test("rollback uses the calibrated V4 failure reason when shadow B/v3 also fails", () => {
  const now = new Date(ROLLBACK_AT);
  const data = getLocalRadarData({ calculationNow: now });
  const current = calculatePublishedProbability(
    data,
    { now, publishedV4RollbackAt: ROLLBACK_AT },
    { logFallback: false },
  );
  const primary = getLocalProbabilityCalculation(data, { now });

  assert.ok(current.calibrated);
  assert.ok(current.stableShadow);

  const invalidV4Selected = selectPublishedProbability(
    primary,
    { ...current.calibrated, probability24h: Number.NaN },
    current.stableShadow,
    "next_generation_b_invalid_prediction",
    null,
    current.rawShadow,
    null,
    { allowNextGenerationB: false },
  );
  assert.equal(invalidV4Selected.source, "stable-shadow-fallback");
  assert.equal(invalidV4Selected.fallbackReason, "calibrated_invalid_prediction");
  assert.notEqual(invalidV4Selected.fallbackReason, "next_generation_b_invalid_prediction");

  const fallbackV4Selected = selectPublishedProbability(
    primary,
    { ...current.calibrated, fallbackUsed: true },
    current.stableShadow,
    "next_generation_b_exception",
    null,
    current.rawShadow,
    null,
    { allowNextGenerationB: false },
  );
  assert.equal(fallbackV4Selected.source, "stable-shadow-fallback");
  assert.equal(fallbackV4Selected.fallbackReason, "calibrated_fallback");

  const exceptionV4Selected = selectPublishedProbability(
    primary,
    null,
    current.stableShadow,
    "next_generation_b_exception",
    null,
    current.rawShadow,
    null,
    { allowNextGenerationB: false },
  );
  assert.equal(exceptionV4Selected.source, "stable-shadow-fallback");
  assert.equal(exceptionV4Selected.fallbackReason, "calibrated_exception");
});

test("rollback does not select next-generation B when calibrated V4 is invalid", () => {
  const now = new Date("2026-09-11T02:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const current = calculatePublishedProbability(data, { now }, { logFallback: false });
  const calibrated = current.calibrated;
  const stableShadow = calculateRegimeElapsedProbability(data, { now }, PUBLISHED_ELAPSED_MODEL_OPTIONS);
  assert.ok(calibrated);
  assert.ok(current.nextGenerationB);

  const selected = selectPublishedProbability(
    getLocalProbabilityCalculation(data, { now }),
    { ...calibrated, probability24h: Number.NaN },
    stableShadow,
    "calibrated_invalid_prediction",
    current.rawShadow,
    current.rawShadow,
    current.nextGenerationB,
    { allowNextGenerationB: false },
  );

  assert.equal(selected.adoptedModel, ELAPSED_ONLY_MODEL_VERSION);
  assert.notEqual(selected.adoptedModel, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
});

test("experimental v3 logging remains available after a corrective rollback boundary", () => {
  const generatedAt = new Date("2026-09-11T02:00:00.000Z");
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: generatedAt },
    existingForecasts: {},
    trainingState: trainingState(),
  });

  assert.equal(forecasts[NEXT_GENERATION_B_MODEL_VERSION]?.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(
    forecasts[NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION]?.modelVersion,
    NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  );
  assert.equal(
    forecasts[NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION]?.modelVersion,
    NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  );
});
