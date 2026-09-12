import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBlockBootstrapDifference,
  calculateMetric,
  calculateEventContributions,
  classifyModelResult,
  createWalkForwardOrigins,
  evaluateProbabilityModels,
  getActualWithinHorizon,
  partitionEventsAtOrigin,
  selectNonOverlappingOrigins,
  CALIBRATED_V2_MODEL_VERSION,
  CONSTANT_HAZARD_MODEL_VERSION,
  type ProbabilityModelEvaluationReport,
  type EvaluationRow,
} from "../scripts/evaluateProbabilityModels";
import {
  calculateConstantHazardBenchmark,
  calculatePrequentialLogitCalibration,
  getConstantHazardBaseline,
} from "../lib/radar/evaluationProbabilityModels";
import {
  buildShadowHazard,
  applyOddsMultiplier,
  calculateShadowProbability,
  type ShadowResetEvent,
} from "../lib/radar/shadowProbability";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  ELAPSED_ONLY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";

function event(id: string, resetAt: string): ShadowResetEvent {
  return { id, resetAt };
}

test("events at the origin are training data and later events are labels only", () => {
  const origin = "2026-08-01T00:00:00.000Z";
  const events = [
    event("before", "2026-07-31T23:59:59.999Z"),
    event("at-origin", origin),
    event("after", "2026-08-01T00:00:00.001Z"),
    event("at-24h", "2026-08-02T00:00:00.000Z"),
    event("at-48h", "2026-08-03T00:00:00.000Z"),
    event("after-as-of", "2026-08-04T00:00:00.000Z"),
  ];
  const split = partitionEventsAtOrigin(events, origin, "2026-08-03T12:00:00.000Z");

  assert.deepEqual(split.training.map((item) => item.id), ["before", "at-origin"]);
  assert.deepEqual(split.future.map((item) => item.id), ["after", "at-24h", "at-48h"]);
  assert.equal(getActualWithinHorizon(events, origin, 24), true);
  assert.equal(getActualWithinHorizon(events, origin, 48), true);
  assert.equal(getActualWithinHorizon([event("only-48h", "2026-08-03T00:00:00.000Z")], origin, 24), false);
});

test("walk-forward origins start only after five completed intervals and at JST midnight", () => {
  const events = Array.from({ length: 7 }, (_, index) =>
    event(`event-${index}`, `2026-06-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
  );
  const origins = createWalkForwardOrigins(events, "2026-06-15T12:00:00.000Z");

  assert.ok(origins.length > 0);
  assert.equal(origins[0], "2026-06-06T15:00:00.000Z");
  assert.ok(origins.every((origin) => origin.endsWith("T15:00:00.000Z")));
});

test("metric calculation reports brier, log loss, rate, mean, and all calibration buckets", () => {
  const rows: Array<EvaluationRow> = [
    { recordedAt: "2026-08-01T00:00:00.000Z", probability24h: 0.2, probability48h: 0.4, actual24h: false, actual48h: true },
    { recordedAt: "2026-08-02T00:00:00.000Z", probability24h: 0.8, probability48h: 0.6, actual24h: true, actual48h: false },
  ];
  const metric = calculateMetric(rows, "24h");

  assert.equal(metric.count, 2);
  assert.equal(metric.actualRate, 0.5);
  assert.equal(metric.averagePrediction, 0.5);
  assert.ok(Math.abs(metric.brier - 0.04) < 1e-12);
  assert.ok(metric.logLoss > 0);
  assert.deepEqual(metric.calibration.map((bucket) => bucket.range), [
    "0-20%", "20-40%", "40-60%", "60-80%", "80-100%",
  ]);
  assert.equal(metric.calibration.reduce((sum, bucket) => sum + bucket.count, 0), 2);
});

test("block bootstrap is deterministic for a fixed seed", () => {
  const current: Array<EvaluationRow> = Array.from({ length: 14 }, (_, index) => ({
    recordedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    probability24h: 0.2,
    probability48h: 0.3,
    actual24h: index % 3 === 0,
    actual48h: index % 4 === 0,
  }));
  const candidate = current.map((row) => ({ ...row, probability24h: 0.25, probability48h: 0.35 }));
  const first = calculateBlockBootstrapDifference(candidate, current, "24h", 20260804, 128);
  const second = calculateBlockBootstrapDifference(candidate, current, "24h", 20260804, 128);

  assert.deepEqual(first, second);
  assert.equal(first.blockDays, 7);
  assert.equal(first.iterations, 128);
  assert.ok(first.lower <= first.upper);
});

test("model recommendation does not declare a winner when either horizon interval crosses zero", () => {
  const result = classifyModelResult({
    brier24h: 0.01,
    brier48h: 0.02,
    currentBrier24h: 0.02,
    currentBrier48h: 0.03,
    bootstrap24h: { lower: -0.01, upper: 0.02 },
    bootstrap48h: { lower: 0.005, upper: 0.02 },
  });

  assert.equal(result, "promising_but_inconclusive");
});

test("constant hazard uses one age-independent rate and includes censored exposure", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const hazard = buildShadowHazard([
    event("a", "2026-08-01T00:00:00.000Z"),
    event("b", "2026-08-03T00:00:00.000Z"),
  ], now);

  assert.ok(hazard.totalExposureHours > 48);
  assert.equal(
    getConstantHazardBaseline(hazard, 0, 24),
    getConstantHazardBaseline(hazard, 72, 24),
  );
  const baseline24h = getConstantHazardBaseline(hazard, 0, 24);
  const baseline48h = getConstantHazardBaseline(hazard, 0, 48);
  assert.ok(baseline24h >= 0 && baseline24h <= 1);
  assert.ok(baseline48h >= baseline24h && baseline48h <= 1);
});

test("constant hazard excludes future events and keeps the shared signal path", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const shadow = calculateShadowProbability(data, { now });
  const benchmark = calculateConstantHazardBenchmark(shadow);

  const futureOnly = buildShadowHazard([
    event("past", "2026-08-01T00:00:00.000Z"),
    event("future", "2026-08-05T00:00:00.000Z"),
  ], now);
  assert.equal(futureOnly.completedEventCount, 1);
  assert.equal(futureOnly.observedEventCount, 0);
  assert.ok(benchmark.predictions.probability24h >= 0);
  assert.ok(benchmark.predictions.probability48h >= benchmark.predictions.probability24h);
  assert.deepEqual(benchmark.predictions, {
    probability24h: applyOddsMultiplier(
      benchmark.baseline.probability24h,
      shadow.multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      benchmark.baseline.probability48h,
      shadow.multipliers.combinedAfterCap.probability48h,
    ),
  });

  const notice = {
    ...shadow,
    officialNoticeOverride: {
      active: true,
      probability12h: 1 - Math.sqrt(0.1),
      probability24h: 0.9,
      probability48h: 0.96,
      probability72h: 1 - Math.pow(1 - 0.96, 72 / 48),
    },
  };
  const noticeBenchmark = calculateConstantHazardBenchmark(notice);
  assert.deepEqual(noticeBenchmark.predictions, { probability24h: 0.9, probability48h: 0.96 });
});

function calibrationRow(
  recordedAt: string,
  probability24h: number,
  probability48h: number,
  actual24h: boolean,
  actual48h: boolean,
): EvaluationRow {
  return { recordedAt, probability24h, probability48h, actual24h, actual48h };
}

test("prequential logit calibration uses only horizon-confirmed past origins", () => {
  const pastRows = Array.from({ length: 13 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return calibrationRow(`2026-08-${day}T00:00:00.000Z`, 0.2, 0.2, true, true);
  });
  const current = calibrationRow("2026-08-14T00:00:00.000Z", 0.2, 0.2, false, false);
  const audit = calculatePrequentialLogitCalibration(current, [
    ...pastRows,
    calibrationRow(current.recordedAt, 0.99, 0.99, true, true),
    calibrationRow("2026-08-15T00:00:00.000Z", 0.99, 0.99, true, true),
  ]);

  assert.equal(audit.calibrationSampleCount24h, 13);
  assert.equal(audit.calibrationSampleCount48h, 12);
  assert.ok(audit.alpha24h > 0);
  assert.ok(audit.alpha48h > 0);
  assert.ok(audit.calibratedProbability24h > current.probability24h);
  assert.ok(audit.calibratedProbability48h > current.probability48h);
});

test("prequential calibration uses zero alpha below ten samples and is deterministic", () => {
  const pastRows = Array.from({ length: 9 }, (_, index) =>
    calibrationRow(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, 0.4, 0.4, true, false),
  );
  const current = calibrationRow("2026-08-12T00:00:00.000Z", 0.4, 0.4, false, false);
  const first = calculatePrequentialLogitCalibration(current, pastRows);
  const second = calculatePrequentialLogitCalibration(current, pastRows);

  assert.deepEqual(first, second);
  assert.equal(first.alpha24h, 0);
  assert.equal(first.alpha48h, 0);
  assert.equal(first.calibratedProbability24h, current.probability24h);
  assert.equal(first.calibratedProbability48h, current.probability48h);
});

test("prequential logit calibration moves in both directions with a fixed normal prior", () => {
  const positiveRows = Array.from({ length: 12 }, (_, index) =>
    calibrationRow(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, 0.2, 0.2, true, true),
  );
  const negativeRows = positiveRows.map((row) => ({ ...row, actual24h: false, actual48h: false }));
  const current = calibrationRow("2026-08-20T00:00:00.000Z", 0.2, 0.2, false, false);
  const positive = calculatePrequentialLogitCalibration(current, positiveRows);
  const negative = calculatePrequentialLogitCalibration(current, negativeRows);

  assert.ok(positive.alpha24h > 0);
  assert.ok(positive.alpha48h > 0);
  assert.ok(negative.alpha24h < 0);
  assert.ok(negative.alpha48h < 0);
});

test("prequential calibration remains finite at epsilon probability boundaries", () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    calibrationRow(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, 0, 1, index % 2 === 0, index % 2 === 1),
  );
  const audit = calculatePrequentialLogitCalibration(
    calibrationRow("2026-08-20T00:00:00.000Z", 0, 1, false, false),
    rows,
  );

  assert.ok(Number.isFinite(audit.alpha24h));
  assert.ok(Number.isFinite(audit.alpha48h));
  assert.ok(Number.isFinite(audit.calibratedProbability24h));
  assert.ok(Number.isFinite(audit.calibratedProbability48h));
});

test("non-overlapping 48-hour origins are selected at a fixed two-day stride", () => {
  const origins = Array.from({ length: 6 }, (_, index) =>
    `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  );
  const selected = selectNonOverlappingOrigins(origins, 48);
  assert.deepEqual(selected, [origins[0], origins[2], origins[4]]);
  assert.ok(selected.slice(1).every((origin, index) =>
    new Date(origin).getTime() - new Date(selected[index]).getTime() === 48 * 60 * 60 * 1000,
  ));
});

test("event contribution counts the origins made positive by each event", () => {
  const origins = [
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    "2026-08-03T00:00:00.000Z",
  ];
  const contributions = calculateEventContributions([
    event("one", "2026-08-02T00:00:00.000Z"),
    event("two", "2026-08-04T00:00:00.000Z"),
  ], origins);

  assert.deepEqual(contributions, [
    { eventId: "one", resetAt: "2026-08-02T00:00:00.000Z", positiveOrigins24h: 1, positiveOrigins48h: 1 },
    { eventId: "two", resetAt: "2026-08-04T00:00:00.000Z", positiveOrigins24h: 1, positiveOrigins48h: 2 },
  ]);
});

test("historical benchmark keeps hazard-elapsed-v1 as its baseline", () => {
  const report: ProbabilityModelEvaluationReport = evaluateProbabilityModels(
    new Date("2026-08-01T03:32:00.000Z"),
  );
  assert.ok(report.models.some((model) => model.modelVersion === CONSTANT_HAZARD_MODEL_VERSION));
  assert.ok(report.models.some((model) => model.modelVersion === CALIBRATED_V2_MODEL_VERSION));
  assert.equal(report.models[0].modelVersion, ELAPSED_ONLY_MODEL_VERSION);
  assert.notEqual(report.models[0].modelVersion, PUBLISHED_PROBABILITY_MODEL_VERSION);
  assert.ok(report.models.some((model) => model.modelVersion === SHADOW_PROBABILITY_MODEL_VERSION));
  assert.equal(report.eventCount, 23);
  assert.match(report.targetDefinition, /Banked Reset distributions/);

  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow: new Date("2026-08-01T03:32:00.000Z") }),
    "en",
    { calculationNow: new Date("2026-08-01T03:32:00.000Z") },
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /benchmark-constant-hazard|logit-calibrated-prequential/);
});
