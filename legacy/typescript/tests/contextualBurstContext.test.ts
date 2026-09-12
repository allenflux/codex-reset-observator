import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_B_FROZEN_CONTINUOUS_CONFIG,
  NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG,
  NEXT_GENERATION_C_CONTEXT_PRIOR_STD_DEV,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_FREEZE_POLICY,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_FREEZE_POLICY,
  NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  NEXT_GENERATION_C_FROZEN_SIGNAL_CONFIG,
  NEXT_GENERATION_C_MAX_MULTIPLIER,
  NEXT_GENERATION_C_MINIMUM_EXPOSURE_CELLS,
  NEXT_GENERATION_C_MINIMUM_RANDOM_EVENTS,
  NEXT_GENERATION_C_MIN_MULTIPLIER,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  NEXT_GENERATION_C_SOLVER_BACKTRACKING_FACTOR,
  NEXT_GENERATION_C_SOLVER_INITIAL_STEP,
  NEXT_GENERATION_C_SOLVER_MAX_BACKTRACKING_STEPS,
  NEXT_GENERATION_C_SOLVER_MAX_ITERATIONS,
  NEXT_GENERATION_C_SOLVER_TOLERANCE,
} from "../data/shadowProbabilityConfig";
import {
  calculateCircadianNormalization,
  fitContextualBurstContext,
  getContextualBurstMultiplier,
  getContextualBurstRawFeatures,
  getPacificHourFeatures,
} from "../lib/radar/contextualBurstContext";
import {
  buildRandomContinuousHazard,
} from "../lib/radar/randomContinuousProbability";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";

const HOUR_MS = 60 * 60 * 1000;

function boundary(id: string, resetAt: string): RecoveryResetBoundary {
  return { id, resetAt, isRandom: true, isRegular: false, sourceIds: [id] };
}

test("C identity and frozen context constants match the preregistration", () => {
  assert.equal(NEXT_GENERATION_C_MODEL_VERSION, "hazard-contextual-burst-circadian-v1");
  assert.equal(NEXT_GENERATION_C_FREEZE_AT, "2026-08-22T06:15:00.000Z");
  assert.equal(
    NEXT_GENERATION_C_FREEZE_POLICY,
    "A single reset, miss, or new observation must not trigger retuning.",
  );
  assert.equal(NEXT_GENERATION_C_CONTEXT_PRIOR_STD_DEV, 0.5);
  assert.equal(NEXT_GENERATION_C_MINIMUM_RANDOM_EVENTS, 15);
  assert.equal(NEXT_GENERATION_C_MINIMUM_EXPOSURE_CELLS, 720);
  assert.equal(NEXT_GENERATION_C_MIN_MULTIPLIER, 0.5);
  assert.equal(NEXT_GENERATION_C_MAX_MULTIPLIER, 2);
  assert.equal(NEXT_GENERATION_C_SOLVER_MAX_ITERATIONS, 250);
  assert.equal(NEXT_GENERATION_C_SOLVER_TOLERANCE, 1e-7);
  assert.equal(NEXT_GENERATION_C_SOLVER_INITIAL_STEP, 1);
  assert.equal(NEXT_GENERATION_C_SOLVER_BACKTRACKING_FACTOR, 0.5);
  assert.equal(NEXT_GENERATION_C_SOLVER_MAX_BACKTRACKING_STEPS, 24);
});

test("C copies the frozen B Gaussian baseline and exactly reuses the frozen signal policy", () => {
  assert.deepEqual(NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG, NEXT_GENERATION_B_FROZEN_CONTINUOUS_CONFIG);
  assert.notEqual(NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG, NEXT_GENERATION_B_FROZEN_CONTINUOUS_CONFIG);
  assert.deepEqual(NEXT_GENERATION_C_FROZEN_SIGNAL_CONFIG, NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG);
});

test("Pacific hour features use America/Los_Angeles including DST", () => {
  const winterNoon = getPacificHourFeatures(new Date("2026-01-15T20:00:00.000Z"));
  const winterMidnight = getPacificHourFeatures(new Date("2026-01-15T08:00:00.000Z"));
  const summerNoon = getPacificHourFeatures(new Date("2026-07-15T19:00:00.000Z"));

  assert.ok(Math.abs(winterNoon.localHour - 12) < 1e-9);
  assert.ok(Math.abs(summerNoon.localHour - 12) < 1e-9);
  assert.ok(Math.abs(winterMidnight.localHour) < 1e-9);
  assert.ok(Math.abs(winterNoon.hourCos + winterMidnight.hourCos) < 1e-9);
  assert.ok(Math.abs(winterNoon.hourSin - winterMidnight.hourSin) < 1e-9);
});

test("72h burst count and previous interval use strict past-only events", () => {
  const at = new Date("2026-08-22T12:00:00.000Z");
  const features = getContextualBurstRawFeatures([
    new Date("2026-08-19T11:59:59.000Z"),
    new Date("2026-08-20T12:00:00.000Z"),
    new Date("2026-08-21T00:00:00.000Z"),
    new Date("2026-08-22T12:00:00.000Z"),
  ], at);

  assert.equal(features.randomResetCount72h, 2);
  assert.equal(features.previousRandomIntervalHours, 12);
});

function clusteredBoundaries() {
  let current = Date.parse("2026-01-01T16:00:00.000Z");
  const result = [boundary("random-0", new Date(current).toISOString())];
  const intervals = Array.from({ length: 8 }, () => [24, 24, 120]).flat();
  intervals.forEach((hours, index) => {
    current += hours * HOUR_MS;
    result.push(boundary(`random-${index + 1}`, new Date(current).toISOString()));
  });
  return { boundaries: result, lastTime: current };
}

test("context fit learns finite burst/circadian factors from sufficient synthetic history", () => {
  const synthetic = clusteredBoundaries();
  const asOf = new Date(synthetic.lastTime + 96 * HOUR_MS);
  const hazard = buildRandomContinuousHazard(
    synthetic.boundaries,
    asOf,
    NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  );
  const fit = fitContextualBurstContext(synthetic.boundaries, asOf, hazard);

  assert.equal(fit.fallbackUsed, false);
  assert.equal(fit.solver.converged, true);
  assert.ok(fit.trainingEventCount >= NEXT_GENERATION_C_MINIMUM_RANDOM_EVENTS);
  assert.ok(fit.exposureCellCount >= NEXT_GENERATION_C_MINIMUM_EXPOSURE_CELLS);
  assert.equal(Object.values(fit.coefficients).every(Number.isFinite), true);

  const origin = new Date(synthetic.lastTime + 12 * HOUR_MS);
  const raw = getContextualBurstRawFeatures(
    synthetic.boundaries.map((item) => new Date(item.resetAt)),
    origin,
  );
  const full = getContextualBurstMultiplier(raw, fit, "full");
  const noBurst = getContextualBurstMultiplier(raw, fit, "noBurst");
  const noCircadian = getContextualBurstMultiplier(raw, fit, "noCircadian");
  assert.ok(full >= NEXT_GENERATION_C_MIN_MULTIPLIER && full <= NEXT_GENERATION_C_MAX_MULTIPLIER);
  assert.ok(noBurst >= NEXT_GENERATION_C_MIN_MULTIPLIER && noBurst <= NEXT_GENERATION_C_MAX_MULTIPLIER);
  assert.ok(noCircadian >= NEXT_GENERATION_C_MIN_MULTIPLIER && noCircadian <= NEXT_GENERATION_C_MAX_MULTIPLIER);
  assert.ok(
    Math.abs(fit.coefficients.count72)
      + Math.abs(fit.coefficients.previousInterval)
      + Math.abs(fit.coefficients.hourSin)
      + Math.abs(fit.coefficients.hourCos) > 1e-6,
  );
});

test("sparse context history falls back to neutral coefficients and multiplier", () => {
  const boundaries = [
    boundary("a", "2026-08-20T00:00:00.000Z"),
    boundary("b", "2026-08-21T00:00:00.000Z"),
    boundary("c", "2026-08-22T00:00:00.000Z"),
  ];
  const asOf = new Date("2026-08-22T12:00:00.000Z");
  const hazard = buildRandomContinuousHazard(boundaries, asOf, NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG);
  const fit = fitContextualBurstContext(boundaries, asOf, hazard);
  const raw = getContextualBurstRawFeatures(boundaries.map((item) => new Date(item.resetAt)), asOf);

  assert.equal(fit.fallbackUsed, true);
  assert.equal(fit.fallbackReason, "insufficient_context_history");
  assert.deepEqual(fit.coefficients, { count72: 0, previousInterval: 0, hourSin: 0, hourCos: 0 });
  assert.equal(getContextualBurstMultiplier(raw, fit), 1);
});

test("C v2 normalizes the clamped circadian cycle to unit mean", () => {
  const zero = calculateCircadianNormalization({
    hourSin: 0,
    hourCos: 0,
  });
  assert.equal(zero.constant, 1);
  assert.equal(zero.cycleMeanBeforeNormalization, 1);
  assert.equal(zero.cycleMeanAfterNormalization, 1);
  assert.equal(zero.fallbackReason, null);

  const normalized = calculateCircadianNormalization({
    hourSin: -0.7015,
    hourCos: -0.3591,
  });
  assert.ok(normalized.constant !== null && normalized.constant > 1);
  assert.ok(
    normalized.cycleMeanBeforeNormalization !== null
      && normalized.cycleMeanBeforeNormalization > 1,
  );
  assert.ok(Math.abs((normalized.cycleMeanAfterNormalization ?? 0) - 1) < 1e-9);
  assert.equal(normalized.fallbackReason, null);
});

test("C v2 keeps burst contribution unchanged while normalizing only circadian terms", () => {
  const raw = {
    randomResetCount72h: 1,
    previousRandomIntervalHours: 2,
    hourSin: 0.5,
    hourCos: 0.5,
  };
  const fit = {
    coefficients: { count72: 0.3, previousInterval: 0.2, hourSin: 0.4, hourCos: 0.1 },
    burstStats: {
      count72Mean: 0,
      count72StdDev: 1,
      previousIntervalMean: 0,
      previousIntervalStdDev: 1,
    },
    trainingEventCount: 20,
    exposureCellCount: 800,
    fallbackUsed: false,
    fallbackReason: null,
    solver: { converged: true, iterations: 1, objective: 0, reason: null },
  };
  const normalization = calculateCircadianNormalization(fit.coefficients);
  assert.equal(
    getContextualBurstMultiplier(raw, fit, "noCircadian", normalization),
    getContextualBurstMultiplier(raw, fit, "noCircadian"),
  );
});

test("C v2 has an independent model identity and freeze policy", () => {
  assert.equal(NEXT_GENERATION_C_MODEL_VERSION, "hazard-contextual-burst-circadian-v1");
  assert.equal(NEXT_GENERATION_C_V2_MODEL_VERSION, "hazard-contextual-burst-circadian-normalized-v2");
  assert.notEqual(NEXT_GENERATION_C_V2_FREEZE_AT, NEXT_GENERATION_C_FREEZE_AT);
  assert.equal(
    NEXT_GENERATION_C_V2_FREEZE_POLICY,
    "A single reset, miss, or new observation must not trigger retuning.",
  );
});
