import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  evaluateNextGenerationModelsProspectively,
  selectComparableNextGenerationForecasts,
} from "../lib/radar/prospectiveNextGenerationModelEvaluation";

function row(generatedAt: string, probability = 0.2) {
  return {
    generatedAt,
    forecasts: {
      [CALIBRATED_SHADOW_MODEL_VERSION]: {
        modelVersion: CALIBRATED_SHADOW_MODEL_VERSION,
        generatedAt,
        probability24h: probability,
        probability48h: probability + 0.1,
      },
      [NEXT_GENERATION_A_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_A_MODEL_VERSION,
        generatedAt,
        probability24h: probability + 0.02,
        probability48h: probability + 0.1,
      },
      [NEXT_GENERATION_B_MODEL_VERSION]: {
        modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
        generatedAt,
        probability24h: probability + 0.01,
        probability48h: probability + 0.1,
      },
    },
  };
}

test("next-generation evaluation compares only same-origin A/B/public rows", () => {
  const rows = [
    row("2026-08-22T00:00:00.000Z"),
    row("2026-08-23T00:00:00.000Z", 0.3),
    row("2026-08-24T00:00:00.000Z", 0.4),
  ];
  const comparable = selectComparableNextGenerationForecasts(rows);
  assert.equal(comparable.length, 3);
  const report = evaluateNextGenerationModelsProspectively(
    rows,
    [
      { id: "random-1", resetAt: "2026-08-22T12:00:00.000Z" },
      { id: "regular-ignored", resetAt: "2026-08-23T12:00:00.000Z", isRandom: false },
    ],
    new Date("2026-08-26T00:00:00.000Z"),
  );

  assert.equal(report.evaluationMode, "prospective");
  assert.equal(report.backfilled, false);
  assert.equal(report.forecastCounts.comparable, 3);
  assert.equal(report.models.public.modelVersion, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(report.models.a.modelVersion, NEXT_GENERATION_A_MODEL_VERSION);
  assert.equal(report.models.b.modelVersion, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(report.comparison.targetResetCount, 1);
  assert.equal(report.comparison.resolved24h, 3);
  assert.equal(report.comparison.resolved48h, 3);
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.gate.manualReviewOnly, true);
});

test("evaluation does not use a partial origin or an unresolved horizon", () => {
  const complete = row("2026-08-22T00:00:00.000Z");
  const partial = row("2026-08-23T23:00:00.000Z");
  const missingB = row("2026-08-24T00:00:00.000Z");
  delete (missingB.forecasts as Record<string, unknown>)[NEXT_GENERATION_B_MODEL_VERSION];
  const report = evaluateNextGenerationModelsProspectively(
    [complete, partial, missingB],
    [],
    new Date("2026-08-24T12:00:00.000Z"),
  );

  assert.equal(report.forecastCounts.public, 3);
  assert.equal(report.forecastCounts.a, 3);
  assert.equal(report.forecastCounts.b, 2);
  assert.equal(report.forecastCounts.comparable, 2);
  assert.equal(report.comparison.resolved24h, 1);
  assert.equal(report.comparison.resolved48h, 1);
  assert.equal(report.status, "insufficient_data");

  const empty = evaluateNextGenerationModelsProspectively(
    [],
    [],
    new Date("2026-08-24T12:00:00.000Z"),
  );
  assert.equal(empty.comparison.pairwise.aMinusPublic.brier24h, null);
  assert.equal(empty.comparison.pairwise.bMinusPublic.logLoss48h, null);
});
