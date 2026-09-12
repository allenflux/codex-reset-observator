import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_FREEZE_AT,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  evaluateRandomClockModelProspectively,
  getRandomClockOutcome,
  selectComparableRandomClockForecasts,
  selectDailyFirstRandomClockForecasts,
} from "../lib/radar/prospectiveRandomClockModelEvaluation";
import type { ProspectiveForecastRow } from "../lib/radar/prospectiveProbabilityEvaluation";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";

function row(
  generatedAt: string,
  includeRandom = true,
  includePublic = true,
): ProspectiveForecastRow {
  const forecasts: ProspectiveForecastRow["forecasts"] = {};
  if (includeRandom) {
    forecasts[RANDOM_ELAPSED_SHADOW_MODEL_VERSION] = {
      modelVersion: RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
      generatedAt,
      probability24h: 0.3,
      probability48h: 0.5,
    };
  }
  if (includePublic) {
    forecasts[PUBLISHED_PROBABILITY_MODEL_VERSION] = {
      modelVersion: PUBLISHED_PROBABILITY_MODEL_VERSION,
      generatedAt,
      probability24h: 0.25,
      probability48h: 0.45,
    };
  }
  return { generatedAt, loggedHour: generatedAt, forecasts };
}

function boundary(
  id: string,
  resetAt: string,
  isRandom: boolean,
  isRegular: boolean,
): RecoveryResetBoundary {
  return { id, resetAt, isRandom, isRegular, sourceIds: [id] };
}

test("only rows containing both random-clock and public forecasts are comparable", () => {
  const preShadow = row("2026-08-01T00:00:00.000Z", false, true);
  const comparable = row("2026-08-02T00:00:00.000Z");

  assert.deepEqual(
    selectComparableRandomClockForecasts([preShadow, comparable]).map((item) => item.generatedAt),
    [comparable.generatedAt],
  );
  assert.deepEqual(
    selectDailyFirstRandomClockForecasts([
      comparable,
      row("2026-08-02T01:00:00.000Z"),
      row("2026-08-03T00:00:00.000Z"),
    ]).map((item) => item.generatedAt),
    [comparable.generatedAt, "2026-08-03T00:00:00.000Z"],
  );
});

test("regular-only horizons are censored while random and no-event horizons are scored", () => {
  const origin = "2026-08-01T00:00:00.000Z";
  assert.equal(
    getRandomClockOutcome([boundary("regular", "2026-08-01T12:00:00.000Z", false, true)], origin, 24),
    null,
  );
  assert.equal(
    getRandomClockOutcome([
      boundary("regular", "2026-08-01T12:00:00.000Z", false, true),
      boundary("random", "2026-08-01T18:00:00.000Z", true, false),
    ], origin, 24),
    null,
  );
  assert.equal(
    getRandomClockOutcome([
      boundary("random", "2026-08-01T12:00:00.000Z", true, false),
      boundary("regular", "2026-08-01T18:00:00.000Z", false, true),
    ], origin, 24),
    true,
  );
  assert.equal(getRandomClockOutcome([], origin, 24), false);
});

test("prospective comparison excludes unresolved horizons and never enables automatic publication", () => {
  const report = evaluateRandomClockModelProspectively(
    [row("2026-08-11T19:00:00.000Z"), row("2026-08-13T00:00:00.000Z")],
    [boundary("regular", "2026-08-12T07:00:00.000Z", false, true)],
    new Date("2026-08-15T01:00:00.000Z"),
  );

  assert.equal(report.evaluationStartAt, "2026-08-11T19:00:00.000Z");
  assert.equal(report.comparison.resolved24h, 1);
  assert.equal(report.comparison.resolved48h, 1);
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.backfilled, false);
  assert.equal(report.activeModelVersion, RANDOM_ELAPSED_SHADOW_MODEL_VERSION);
  assert.equal(report.baselineModelVersion, PUBLISHED_PROBABILITY_MODEL_VERSION);
});

test("prospective comparison ignores boundaries after the as-of time", () => {
  const report = evaluateRandomClockModelProspectively(
    [row("2026-08-11T19:00:00.000Z")],
    [boundary("future-random", "2026-08-13T00:00:00.000Z", true, false)],
    new Date("2026-08-12T20:00:00.000Z"),
  );

  assert.equal(report.comparison.resolved24h, 1);
  assert.equal(report.comparison.positiveCount24h, 0);
  assert.equal(report.comparison.targetResetCount, 0);
});

test("freeze timestamp is fixed, not in the future, and excludes earlier rows without backfill", () => {
  assert.equal(RANDOM_ELAPSED_SHADOW_FREEZE_AT, "2026-08-11T18:38:51.000Z");
  assert.ok(
    new Date(RANDOM_ELAPSED_SHADOW_FREEZE_AT).getTime()
      <= new Date("2026-08-12T03:45:00+09:00").getTime(),
  );

  const report = evaluateRandomClockModelProspectively(
    [
      row("2026-08-11T18:38:50.999Z"),
      row("2026-08-11T18:38:51.000Z"),
      row("2026-08-12T00:00:00.000Z"),
    ],
    [],
    new Date("2026-08-14T01:00:00.000Z"),
  );

  assert.equal(report.backfilled, false);
  assert.equal(report.forecastCounts.active, 2);
  assert.equal(report.forecastCounts.baseline, 2);
  assert.equal(report.forecastCounts.comparable, 2);
  assert.equal(report.evaluationStartAt, "2026-08-11T18:38:51.000Z");
  assert.equal(report.status, "insufficient_data");
  assert.equal(report.activeModelVersion, RANDOM_ELAPSED_SHADOW_MODEL_VERSION);
  assert.equal(report.baselineModelVersion, PUBLISHED_PROBABILITY_MODEL_VERSION);
});

test("zero random-clock rows remain insufficient_data without altering public-only rows", () => {
  const report = evaluateRandomClockModelProspectively(
    [row("2026-08-11T19:00:00.000Z", false, true)],
    [],
    new Date("2026-08-12T20:00:00.000Z"),
  );

  assert.equal(report.status, "insufficient_data");
  assert.equal(report.forecastCounts.active, 0);
  assert.equal(report.forecastCounts.baseline, 1);
  assert.equal(report.forecastCounts.comparable, 0);
  assert.equal(report.backfilled, false);
});

test("random target labels remain positive when a same-time boundary has both flags", () => {
  assert.equal(
    getRandomClockOutcome([
      boundary("same", "2026-08-01T12:00:00.000Z", true, true),
    ],
    "2026-08-01T00:00:00.000Z",
    24),
    true,
  );
});
