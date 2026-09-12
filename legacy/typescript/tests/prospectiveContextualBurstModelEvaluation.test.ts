import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  evaluateContextualBurstModelProspectively,
  selectComparableContextualBurstForecasts,
  selectNormalizedContextualBurstForecasts,
} from "../lib/radar/prospectiveContextualBurstModelEvaluation";

function forecast(modelVersion: string, generatedAt: string, p24: number, p48: number) {
  return {
    modelVersion,
    generatedAt,
    probability24h: p24,
    probability48h: p48,
  };
}

function row(
  generatedAt: string,
  options: { includeC?: boolean; includeAblations?: boolean } = {},
) {
  const includeC = options.includeC ?? true;
  const includeAblations = options.includeAblations ?? true;
  const forecasts: Record<string, any> = {
    [CALIBRATED_SHADOW_MODEL_VERSION]: forecast(
      CALIBRATED_SHADOW_MODEL_VERSION,
      generatedAt,
      0.5,
      0.6,
    ),
    [NEXT_GENERATION_A_MODEL_VERSION]: forecast(
      NEXT_GENERATION_A_MODEL_VERSION,
      generatedAt,
      0.55,
      0.65,
    ),
    [NEXT_GENERATION_B_MODEL_VERSION]: forecast(
      NEXT_GENERATION_B_MODEL_VERSION,
      generatedAt,
      0.6,
      0.7,
    ),
  };
  if (includeC) {
    forecasts[NEXT_GENERATION_C_MODEL_VERSION] = {
      ...forecast(NEXT_GENERATION_C_MODEL_VERSION, generatedAt, 0.8, 0.85),
      ...(includeAblations
        ? {
            ablations: {
              baseOnly: { probability24h: 0.4, probability48h: 0.5 },
              noBurst: { probability24h: 0.2, probability48h: 0.3 },
              noCircadian: { probability24h: 0.6, probability48h: 0.7 },
              fullContext: { probability24h: 0.8, probability48h: 0.85 },
              fullRaw: { probability24h: 0.82, probability48h: 0.87 },
            },
          }
        : {}),
    };
  }
  return { generatedAt, forecasts };
}

function normalizedRow(generatedAt: string) {
  const result = row(generatedAt);
  result.forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION] = {
    ...forecast(NEXT_GENERATION_C_V2_MODEL_VERSION, generatedAt, 0.7, 0.75),
    normalizedAblations: {
      baseOnly: { probability24h: 0.4, probability48h: 0.5 },
      burstOnly: { probability24h: 0.5, probability48h: 0.6 },
      circadianNormalizedOnly: { probability24h: 0.6, probability48h: 0.7 },
      fullNormalizedContext: { probability24h: 0.7, probability48h: 0.75 },
    },
  };
  return result;
}

test("formal C evaluation uses only same-origin Current/A/B/C rows", () => {
  const complete = row("2026-08-22T07:00:00.000Z");
  const missingC = row("2026-08-23T07:00:00.000Z", { includeC: false });
  const comparable = selectComparableContextualBurstForecasts([complete, missingC]);
  assert.deepEqual(comparable.map((item) => item.generatedAt), [complete.generatedAt]);

  const report = evaluateContextualBurstModelProspectively(
    [complete, missingC],
    [
      { id: "random-positive", resetAt: "2026-08-22T12:00:00.000Z" },
      { id: "regular-ignored", resetAt: "2026-08-23T12:00:00.000Z", isRandom: false },
    ],
    new Date("2026-08-25T12:00:00.000Z"),
  );

  assert.equal(report.forecastCounts.public, 2);
  assert.equal(report.forecastCounts.a, 2);
  assert.equal(report.forecastCounts.b, 2);
  assert.equal(report.forecastCounts.c, 1);
  assert.equal(report.forecastCounts.comparable, 1);
  assert.equal(report.models.c.metrics24h.count, 1);
  assert.equal(report.models.c.metrics24h.positiveCount, 1);
  assert.equal(report.comparison.targetResetCount, 1);
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.gate.manualReviewOnly, true);
});

test("regular-only events never create a positive C label", () => {
  const generatedAt = "2026-08-22T07:00:00.000Z";
  const report = evaluateContextualBurstModelProspectively(
    [row(generatedAt)],
    [{ id: "regular-only", resetAt: "2026-08-22T12:00:00.000Z", isRandom: false }],
    new Date("2026-08-25T12:00:00.000Z"),
  );

  assert.equal(report.models.c.metrics24h.count, 1);
  assert.equal(report.models.c.metrics24h.positiveCount, 0);
  assert.equal(report.models.c.metrics48h.positiveCount, 0);
  assert.equal(report.comparison.targetResetCount, 0);
});

test("ablation deltas show burst benefit when fullContext predicts the positive better", () => {
  const generatedAt = "2026-08-22T07:00:00.000Z";
  const report = evaluateContextualBurstModelProspectively(
    [row(generatedAt)],
    [{ id: "random-positive", resetAt: "2026-08-22T12:00:00.000Z" }],
    new Date("2026-08-25T12:00:00.000Z"),
  );

  const delta = report.ablations.contributions.noBurstMinusFullContext;
  assert.ok((delta.brier24h ?? 0) > 0);
  assert.ok((delta.brier48h ?? 0) > 0);
  assert.ok((delta.logLoss24h ?? 0) > 0);
  assert.ok((delta.logLoss48h ?? 0) > 0);
  assert.equal(report.availability.ablationRows, 1);
  assert.equal(report.availability.ablationRate, 1);
});

test("missing C ablations reduce ablation availability without invalidating the main C forecast", () => {
  const withAblations = row("2026-08-22T07:00:00.000Z");
  const withoutAblations = row("2026-08-23T07:00:00.000Z", { includeAblations: false });
  const report = evaluateContextualBurstModelProspectively(
    [withAblations, withoutAblations],
    [],
    new Date("2026-08-26T12:00:00.000Z"),
  );

  assert.equal(report.forecastCounts.c, 2);
  assert.equal(report.forecastCounts.comparable, 2);
  assert.equal(report.models.c.metrics24h.count, 2);
  assert.equal(report.availability.ablationRows, 1);
  assert.equal(report.availability.ablationRate, 0.5);
  assert.equal(report.ablations.models.fullContext.metrics24h.count, 1);
});

test("C v2 evaluation is freeze-bound and keeps normalized ablations separate", () => {
  const before = normalizedRow(new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) - 1).toISOString());
  const after = normalizedRow(new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 60 * 60 * 1000).toISOString());
  assert.deepEqual(selectNormalizedContextualBurstForecasts([before, after]).map((item) => item.generatedAt), [after.generatedAt]);

  const report = evaluateContextualBurstModelProspectively(
    [before, after],
    [],
    new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 49 * 60 * 60 * 1000),
  );

  assert.equal(report.schemaVersion, "prospective-contextual-burst-model-evaluation-v2");
  assert.equal(report.forecastCounts.cV2, 1);
  assert.equal(report.models.cV2.metrics24h.count, 1);
  assert.equal(report.normalizedAblations.models.baseOnly.metrics24h.count, 1);
  assert.equal(report.normalizedAblations.models.fullNormalizedContext.metrics48h.count, 1);
});
