import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
  RECENCY_H30_PROBABILITY_MODEL_VERSION,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  buildNextGenerationExperimentalProbabilityForecasts,
} from "../lib/nextGenerationLogging";
import {
  calculateNextGenerationSelectiveCalibrationProbability,
} from "../lib/radar/nextGenerationProbability";
import {
  evaluatePublishedModelProspectively,
  selectComparablePublishedForecasts,
} from "../lib/radar/prospectivePublishedModelEvaluation";
import type { ProspectiveForecastRow } from "../lib/radar/prospectiveProbabilityEvaluation";
import type { ExperimentalProbabilityForecasts } from "../lib/logProbability";
import type { NextGenerationTrainingState } from "../lib/radar/nextGenerationTraining";

function existingForecasts(): ExperimentalProbabilityForecasts {
  const entries: Array<[string, ExperimentalProbabilityForecasts[string]]> = [
    [CALIBRATED_SHADOW_MODEL_VERSION, 0.2],
    [REGIME_ELAPSED_FULL_MODEL_VERSION, 0.25],
    [RANDOM_ELAPSED_SHADOW_MODEL_VERSION, 0.3],
    [RECENCY_H30_PROBABILITY_MODEL_VERSION, 0.35],
  ].map(([modelVersion, probability]) => [modelVersion, {
    modelVersion,
    generatedAt: "2026-08-22T03:00:00.000Z",
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

test("logging adds B and exact five-component A without changing existing forecasts", () => {
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: new Date("2026-08-22T03:00:00.000Z") },
    existingForecasts: existingForecasts(),
    trainingState: state("ok"),
  });

  assert.ok(forecasts[NEXT_GENERATION_B_MODEL_VERSION]);
  assert.ok(forecasts[NEXT_GENERATION_A_MODEL_VERSION]);
  assert.deepEqual(
    forecasts[NEXT_GENERATION_A_MODEL_VERSION].componentModelVersions,
    [...NEXT_GENERATION_A_COMPONENT_VERSIONS],
  );
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION].trainingMode24h, "equal");
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION].trainingMode48h, "equal");
  assert.equal(forecasts[CALIBRATED_SHADOW_MODEL_VERSION].probability24h, 0.2);
});

test("training DB failure preserves B fallback audit and omits A", () => {
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: new Date("2026-08-22T03:00:00.000Z") },
    existingForecasts: existingForecasts(),
    trainingState: state("error"),
  });

  assert.equal(forecasts[NEXT_GENERATION_B_MODEL_VERSION].trainingReadStatus, "error");
  assert.equal(forecasts[NEXT_GENERATION_B_MODEL_VERSION].fallbackUsed, true);
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION], undefined);
});

test("logging does not create pre-freeze forecasts", () => {
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: new Date(new Date(NEXT_GENERATION_FREEZE_AT).getTime() - 1) },
    existingForecasts: existingForecasts(),
    trainingState: state("ok"),
  });
  assert.equal(forecasts[NEXT_GENERATION_B_MODEL_VERSION], undefined);
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION], undefined);
});

test("production-like post-boundary logging preserves selective hybrid v3, v2, v1, and Candidate A with shared origin", () => {
  const generatedAt = new Date("2026-09-10T05:00:00.000Z");
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: generatedAt },
    existingForecasts: existingForecasts(),
    trainingState: state("ok"),
  });

  const v1 = forecasts[NEXT_GENERATION_B_MODEL_VERSION];
  const v2 = forecasts[NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION];
  const v3 = forecasts[NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION];
  const a = forecasts[NEXT_GENERATION_A_MODEL_VERSION];

  // 2. Fix: selective v3 key is in saved targets
  assert.ok(v3, "selective hybrid v3 present in saved forecasts");
  // 3. v2 coexists under same origin
  assert.ok(v2, "v2 present");
  assert.equal(v3.generatedAt, v2.generatedAt, "v3 and v2 share generatedAt");
  // 4. v1 preserved
  assert.ok(v1, "v1 preserved");
  assert.equal(v3.generatedAt, v1.generatedAt, "v3 and v1 share generatedAt");
  // Candidate A also present alongside
  assert.ok(a, "Candidate A present alongside v3");

  // 5. v3 modelVersion matches key
  assert.equal(v3.modelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  // 6. generatedAt is logging origin
  assert.equal(v3.generatedAt, generatedAt.toISOString());
  assert.equal(v3.featureSnapshot?.featureSnapshotVersion, "v1");
  assert.equal(v1.featureSnapshot, undefined);
  assert.equal(v2.featureSnapshot, undefined);

  // 7. probability24h/48h finite and in [0, 1]
  assert.ok(Number.isFinite(v3.probability24h) && v3.probability24h >= 0 && v3.probability24h <= 1);
  assert.ok(Number.isFinite(v3.probability48h) && v3.probability48h >= 0 && v3.probability48h <= 1);

  // 8. 12h <= 24h <= 48h <= 72h monotonic coherence maintained
  assert.ok(Number.isFinite(v3.probability12h) && v3.probability12h! >= 0 && v3.probability12h! <= 1);
  assert.ok(Number.isFinite(v3.probability72h) && v3.probability72h! >= 0 && v3.probability72h! <= 1);
  assert.ok(v3.probability12h! <= v3.probability24h, "12h <= 24h");
  assert.ok(v3.probability24h <= v3.probability48h, "24h <= 48h");
  assert.ok(v3.probability48h <= v3.probability72h!, "48h <= 72h");

  // 9. trainingReadStatus and fallback semantics preserved (status: ok)
  assert.equal(v3.trainingReadStatus, "ok");
  assert.equal(v3.fallbackUsed, false);
  assert.equal(v3.fallbackReason, null);

  // 12. public v3 probability calculation matches logged forecast values
  const directCalc = calculateNextGenerationSelectiveCalibrationProbability(null, {
    now: generatedAt,
    trainingRows: [],
    trainingReadStatus: "ok",
  });
  assert.equal(v3.probability24h, directCalc.predictions.probability24h);
  assert.equal(v3.probability48h, directCalc.predictions.probability48h);
  assert.equal(v3.probability12h, directCalc.predictions.probability12h);
  assert.equal(v3.probability72h, directCalc.predictions.probability72h);
});

test("training error preserves fallback semantics for selective hybrid v3 in logging", () => {
  const generatedAt = new Date("2026-09-10T05:00:00.000Z");
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: generatedAt },
    existingForecasts: existingForecasts(),
    trainingState: state("error"),
  });

  const v3 = forecasts[NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION];
  assert.ok(v3, "selective hybrid v3 present even when training error triggers fallback");
  assert.equal(v3.trainingReadStatus, "error");
  assert.equal(v3.fallbackUsed, true);
  assert.equal(v3.fallbackReason, "prediction_history_training_query_failed");
  // Candidate A omitted due to training error
  assert.equal(forecasts[NEXT_GENERATION_A_MODEL_VERSION], undefined);
});

test("prospective evaluator reads post-boundary logged rows as comparable active v3 + baseline v2", () => {
  const postBoundaryAt = "2026-09-10T05:00:00.000Z";
  const postBoundaryForecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: new Date(postBoundaryAt) },
    existingForecasts: existingForecasts(),
    trainingState: state("ok"),
  });

  const postBoundaryRow: ProspectiveForecastRow = {
    generatedAt: postBoundaryAt,
    loggedHour: postBoundaryAt,
    forecasts: postBoundaryForecasts,
  };

  // 11. Prospective evaluator can read post-boundary row as active + baseline comparable
  const comparableRows = selectComparablePublishedForecasts([postBoundaryRow]);
  assert.equal(comparableRows.length, 1, "post-boundary row is comparable");

  const report = evaluatePublishedModelProspectively(
    [postBoundaryRow],
    [],
    new Date("2026-09-12T00:00:00.000Z"),
  );
  assert.equal(report.activeModelVersion, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(report.baselineModelVersion, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(report.forecastCounts.comparable, 1);
  assert.equal(report.forecastCounts.active, 1);
  assert.equal(report.forecastCounts.baseline, 1);
  assert.equal(report.evaluationStartAt, postBoundaryAt);
});

test("pre-boundary historical rows are not reclassified as active v3", () => {
  // 10. pre-boundary rows remain v2 and are not scored as post-boundary active v3
  const preBoundaryAt = "2026-09-09T21:00:00.000Z";
  const preBoundaryRow: ProspectiveForecastRow = {
    generatedAt: preBoundaryAt,
    loggedHour: preBoundaryAt,
    forecasts: {
      [NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
        generatedAt: preBoundaryAt,
        probability24h: 0.2,
        probability48h: 0.4,
      },
      [NEXT_GENERATION_B_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
        generatedAt: preBoundaryAt,
        probability24h: 0.3,
        probability48h: 0.5,
      },
    },
  };

  const report = evaluatePublishedModelProspectively(
    [preBoundaryRow],
    [],
    new Date("2026-09-12T00:00:00.000Z"),
  );
  // Pre-boundary row is before PUBLISHED_PROBABILITY_ADOPTION_AT, so comparable count is 0
  assert.equal(report.forecastCounts.comparable, 0);
  assert.equal(report.evaluationStartAt, null);
});
