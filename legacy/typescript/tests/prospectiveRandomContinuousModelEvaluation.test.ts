import assert from "node:assert/strict";
import test from "node:test";

import {
  RANDOM_CONTINUOUS_SHADOW_FREEZE_AT,
  RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  evaluateRandomContinuousModelProspectively,
  selectComparableRandomContinuousForecasts,
  selectDailyFirstRandomContinuousForecasts,
} from "../lib/radar/prospectiveRandomContinuousModelEvaluation";
import type { ProspectiveForecastRow } from "../lib/radar/prospectiveProbabilityEvaluation";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";

function row(generatedAt: string, continuous = true, coarse = true): ProspectiveForecastRow {
  const forecasts: ProspectiveForecastRow["forecasts"] = {};
  if (continuous) {
    forecasts[RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION] = {
      modelVersion: RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
      generatedAt,
      probability24h: 0.3,
      probability48h: 0.5,
    };
  }
  if (coarse) {
    forecasts[RANDOM_ELAPSED_SHADOW_MODEL_VERSION] = {
      modelVersion: RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
      generatedAt,
      probability24h: 0.25,
      probability48h: 0.45,
    };
  }
  return { generatedAt, loggedHour: generatedAt, forecasts };
}

function boundary(id: string, resetAt: string, isRandom: boolean, isRegular: boolean): RecoveryResetBoundary {
  return { id, resetAt, isRandom, isRegular, sourceIds: [id] };
}

test("only same-row continuous and coarse forecasts are comparable and daily-first", () => {
  const comparable = row("2026-08-19T00:00:00.000Z");
  assert.equal(selectComparableRandomContinuousForecasts([
    row("2026-08-18T00:00:00.000Z", true, false),
    comparable,
  ]).length, 1);
  assert.deepEqual(
    selectDailyFirstRandomContinuousForecasts([
      row("2026-08-19T00:00:00.000Z"),
      row("2026-08-19T01:00:00.000Z"),
      row("2026-08-20T00:00:00.000Z"),
    ]).map((item) => item.generatedAt),
    ["2026-08-19T00:00:00.000Z", "2026-08-20T00:00:00.000Z"],
  );
});

test("freeze excludes earlier rows without backfill and keeps the gate manual-only", () => {
  const report = evaluateRandomContinuousModelProspectively(
    [
      row("2026-08-18T16:14:20.999Z"),
      row(RANDOM_CONTINUOUS_SHADOW_FREEZE_AT),
      row("2026-08-19T00:00:00.000Z"),
    ],
    [],
    new Date("2026-08-21T00:00:00.000Z"),
  );

  assert.equal(report.backfilled, false);
  assert.equal(report.forecastCounts.active, 2);
  assert.equal(report.forecastCounts.baseline, 2);
  assert.equal(report.forecastCounts.comparable, 2);
  assert.equal(report.evaluationStartAt, RANDOM_CONTINUOUS_SHADOW_FREEZE_AT);
  assert.equal(report.status, "insufficient_data");
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.gate.manualReviewOnly, true);
});

test("regular-only horizons are censored and random boundaries are the only positives", () => {
  const report = evaluateRandomContinuousModelProspectively(
    [
      row("2026-08-19T00:00:00.000Z"),
      row("2026-08-20T00:00:00.000Z"),
    ],
    [
      boundary("regular", "2026-08-19T12:00:00.000Z", false, true),
      boundary("random", "2026-08-20T12:00:00.000Z", true, false),
    ],
    new Date("2026-08-22T00:00:00.000Z"),
  );

  assert.equal(report.comparison.resolved24h, 1);
  assert.equal(report.comparison.resolved48h, 1);
  assert.equal(report.comparison.positiveCount24h, 1);
  assert.equal(report.comparison.positiveCount48h, 1);
  assert.equal(report.comparison.targetResetCount, 1);
});
