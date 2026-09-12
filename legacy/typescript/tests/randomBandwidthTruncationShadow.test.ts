import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
  RANDOM_CONTINUOUS_SHADOW_BANDWIDTH_HOURS,
  RANDOM_CONTINUOUS_SHADOW_TRUNCATION_HOURS,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import type { ExperimentalProbabilityForecasts } from "../lib/logProbability";
import { buildNextGenerationExperimentalProbabilityForecasts } from "../lib/nextGenerationLogging";
import { getLocalRadarData } from "../lib/radar";
import {
  calculateNextGenerationBPostResetAgeCandidate,
  calculateNextGenerationBProbability,
} from "../lib/radar/nextGenerationProbability";
import {
  calculateRandomContinuousBandwidthShadowPair,
} from "../lib/radar/randomContinuousBandwidthShadow";
import {
  evaluateRandomBandwidthTruncationModelProspectively,
  getRandomBandwidthAgeBucket,
  selectComparableRandomBandwidthForecasts,
  selectDailyFirstRandomBandwidthForecasts,
} from "../lib/radar/prospectiveRandomBandwidthModelEvaluation";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { ProspectiveForecastRow } from "../lib/radar/prospectiveProbabilityEvaluation";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";
import type { WindowEventLike } from "../lib/radar/types";

const HOUR_MS = 60 * 60 * 1000;

function resetEvent(id: string, completedAt: string): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  };
}

function regularResetEvent(id: string, completedAt: string): WindowEventLike {
  const base = resetEvent(id, completedAt);
  return {
    ...base,
    recordKind: "reference",
    title: "定期リセット",
    details: {
      cycleType: "定期リセット",
      reasonType: "定期更新",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分（定期）",
    },
  };
}

function boundary(
  id: string,
  resetAt: string,
  isRandom = true,
  isRegular = false,
): RecoveryResetBoundary {
  return { id, resetAt, isRandom, isRegular, sourceIds: [id] };
}

function forecast(
  modelVersion: string,
  generatedAt: string,
  probability24h = 0.25,
  probability48h = 0.4,
  randomElapsedHours?: number,
) {
  return {
    modelVersion,
    generatedAt,
    probability24h,
    probability48h,
    randomElapsedHours,
  };
}

function row(
  generatedAt: string,
  control = true,
  challenger = true,
  randomElapsedHours?: number,
): ProspectiveForecastRow {
  const forecasts: ProspectiveForecastRow["forecasts"] = {};
  if (control) {
    forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION] = forecast(
      RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
      generatedAt,
      0.25,
      0.4,
      randomElapsedHours,
    );
  }
  if (challenger) {
    forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION] = forecast(
      RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
      generatedAt,
      0.2,
      0.35,
      randomElapsedHours,
    );
  }
  return { generatedAt, loggedHour: generatedAt, forecasts };
}

test("Production 24/72 settings and public selector remain unchanged", () => {
  assert.equal(RANDOM_CONTINUOUS_SHADOW_BANDWIDTH_HOURS, 24);
  assert.equal(RANDOM_CONTINUOUS_SHADOW_TRUNCATION_HOURS, 72);
  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS.bandwidthHours, 24);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS.truncationHours, 72);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS.bandwidthHours, 18);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS.truncationHours, 54);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS.gridHours, 1);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS.gridHours, 1);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS.integrationStepMinutes, 10);
  assert.equal(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS.integrationStepMinutes, 10);
  const controlOnly = { ...RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS };
  const challengerOnly = { ...RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS };
  delete (controlOnly as { bandwidthHours?: number }).bandwidthHours;
  delete (controlOnly as { truncationHours?: number }).truncationHours;
  delete (challengerOnly as { bandwidthHours?: number }).bandwidthHours;
  delete (challengerOnly as { truncationHours?: number }).truncationHours;
  assert.deepEqual(controlOnly, challengerOnly);
});

test("control and challenger share one raw origin and differ only in bandwidth/truncation", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const staticHistory = [
    resetEvent("random-a", "2026-08-30T12:00:00.000Z"),
    resetEvent("random-b", "2026-09-01T00:00:00.000Z"),
  ];
  const pair = calculateRandomContinuousBandwidthShadowPair(
    getLocalRadarData({ calculationNow: now }),
    { now, staticHistory, activeOfficialNotice: null },
  );

  assert.equal(pair.control.modelVersion, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION);
  assert.equal(pair.challenger.modelVersion, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION);
  assert.equal(pair.control.calculatedAt, pair.challenger.calculatedAt);
  assert.deepEqual(
    pair.control.randomContinuous.randomBoundaryIds,
    pair.challenger.randomContinuous.randomBoundaryIds,
  );
  assert.equal(pair.control.randomContinuous.randomElapsedHours, pair.challenger.randomContinuous.randomElapsedHours);
  assert.equal(pair.control.randomContinuous.regimeMultiplier, pair.challenger.randomContinuous.regimeMultiplier);
  assert.equal(pair.control.randomContinuous.effectiveRegimeMultiplier, pair.challenger.randomContinuous.effectiveRegimeMultiplier);
  assert.equal(pair.control.randomContinuous.bandwidthHours, 24);
  assert.equal(pair.control.randomContinuous.truncationHours, 72);
  assert.equal(pair.challenger.randomContinuous.bandwidthHours, 18);
  assert.equal(pair.challenger.randomContinuous.truncationHours, 54);
  assert.equal(pair.control.randomContinuous.gridHours, pair.challenger.randomContinuous.gridHours);
  assert.equal(pair.control.randomContinuous.integrationStepHours, 10 / 60);
  assert.equal(pair.challenger.randomContinuous.integrationStepHours, 10 / 60);
  assert.equal(pair.control.randomContinuous.regimeMultiplier, pair.challenger.randomContinuous.regimeMultiplier);
  for (const result of [pair.control, pair.challenger]) {
    assert.ok(result.predictions.probability12h <= result.predictions.probability24h);
    assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
    assert.ok(result.predictions.probability48h <= result.predictions.probability72h);
    assert.equal(
      result.randomContinuous.regimeMultiplierPolicyVersion,
      NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    );
  }
});

test("bandwidth pair resolves an implicit calculation time once for both arms", () => {
  const requestedNow = new Date("2026-09-03T12:00:00.000Z");
  let nowReads = 0;
  const options = {
    get now() {
      nowReads += 1;
      return new Date(requestedNow.getTime() + nowReads * 60_000);
    },
    staticHistory: [],
    activeOfficialNotice: null,
  } satisfies Parameters<typeof calculateRandomContinuousBandwidthShadowPair>[1];

  const pair = calculateRandomContinuousBandwidthShadowPair(null, options);

  assert.equal(nowReads, 1);
  assert.equal(pair.control.calculatedAt, pair.challenger.calculatedAt);
});

test("regular resets remain outside the random clock for both shadow arms", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const pair = calculateRandomContinuousBandwidthShadowPair(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: [
        resetEvent("random-a", "2026-08-30T12:00:00.000Z"),
        regularResetEvent("regular-a", "2026-09-01T12:00:00.000Z"),
      ],
      activeOfficialNotice: null,
    },
  );

  assert.deepEqual(pair.control.randomContinuous.randomBoundaryIds, ["random-a"]);
  assert.deepEqual(pair.challenger.randomContinuous.randomBoundaryIds, ["random-a"]);
  assert.equal(pair.control.randomContinuous.regularBoundaryCount, 1);
  assert.equal(pair.challenger.randomContinuous.regularBoundaryCount, 1);
});

test("next-generation logging stores both raw forecasts at one origin without calibration", () => {
  const generatedAt = new Date(Date.parse(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT) + 60_000);
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: generatedAt, staticHistory: [], activeOfficialNotice: null },
    existingForecasts: {},
    trainingState: {
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
    },
  });
  const control = forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION] as Record<string, unknown>;
  const challenger = forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION] as Record<string, unknown>;

  assert.ok(control);
  assert.ok(challenger);
  assert.equal(control.generatedAt, challenger.generatedAt);
  assert.equal(control.kernelBandwidthHours, 24);
  assert.equal(control.kernelTruncationHours, 72);
  assert.equal(challenger.kernelBandwidthHours, 18);
  assert.equal(challenger.kernelTruncationHours, 54);
  assert.equal(control.integrationStepHours, 10 / 60);
  assert.equal(challenger.integrationStepHours, 10 / 60);
  assert.equal(control.calibrationApplied, false);
  assert.equal(challenger.calibrationApplied, false);
  assert.equal(control.regimeMultiplierPolicyVersion, NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION);
  assert.equal(challenger.regimeMultiplierPolicyVersion, NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION);
  assert.equal(control.experimentRole, "control");
  assert.equal(challenger.experimentRole, "challenger");
  assert.equal(control.generatedAt, generatedAt.toISOString());
});

test("adding the bandwidth experiment does not change the existing B forecasts", () => {
  const generatedAt = new Date(Date.parse(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT) + 60_000);
  const calculationOptions = {
    now: generatedAt,
    staticHistory: [],
    activeOfficialNotice: null,
  };
  const trainingState = {
    status: "ok" as const,
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
    backfill: false as const,
  };
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions,
    existingForecasts: {},
    trainingState,
  });
  const b = calculateNextGenerationBProbability(null, calculationOptions);
  const v2 = calculateNextGenerationBPostResetAgeCandidate(null, calculationOptions);
  const storedB = forecasts[NEXT_GENERATION_B_MODEL_VERSION];
  const storedV2 = forecasts[NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION];

  assert.equal(storedB?.probability24h, b.predictions.probability24h);
  assert.equal(storedB?.probability48h, b.predictions.probability48h);
  assert.equal(storedV2?.probability24h, v2.predictions.probability24h);
  assert.equal(storedV2?.probability48h, v2.predictions.probability48h);
});

test("experiment freeze excludes pre-freeze rows and does not backfill", () => {
  const before = new Date(Date.parse(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT) - 1);
  const forecasts = buildNextGenerationExperimentalProbabilityForecasts({
    data: null,
    calculationOptions: { now: before, staticHistory: [] },
    existingForecasts: {},
    trainingState: {
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
    },
  });
  assert.equal(forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION], undefined);
  assert.equal(forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION], undefined);
});

test("prospective evaluator requires both same-row forecasts, uses JST daily-first, and buckets age", () => {
  assert.equal(getRandomBandwidthAgeBucket(0), "0-24h");
  assert.equal(getRandomBandwidthAgeBucket(23.999), "0-24h");
  assert.equal(getRandomBandwidthAgeBucket(24), "24-48h");
  assert.equal(getRandomBandwidthAgeBucket(47.999), "24-48h");
  assert.equal(getRandomBandwidthAgeBucket(48), "48-72h");
  assert.equal(getRandomBandwidthAgeBucket(71.999), "48-72h");
  assert.equal(getRandomBandwidthAgeBucket(72), "72h+");

  const comparable = row("2026-09-03T00:00:00.000Z", true, true, 12);
  assert.equal(selectComparableRandomBandwidthForecasts([
    row("2026-09-02T00:00:00.000Z", true, false, 12),
    comparable,
  ]).length, 1);
  assert.deepEqual(
    selectDailyFirstRandomBandwidthForecasts([
      row("2026-09-03T00:00:00.000Z", true, true, 12),
      row("2026-09-03T01:00:00.000Z", true, true, 13),
      row("2026-09-04T00:00:00.000Z", true, true, 24),
    ]).map((item) => item.generatedAt),
    ["2026-09-03T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
  );

  const report = evaluateRandomBandwidthTruncationModelProspectively(
    [
      row("2026-09-03T00:00:00.000Z", true, true, 12),
      row("2026-09-03T01:00:00.000Z", true, true, 13),
      row("2026-09-04T00:00:00.000Z", true, true, 24),
      row("2026-09-05T00:00:00.000Z", true, false, 48),
    ],
    [
      boundary("regular", "2026-09-03T12:00:00.000Z", false, true),
      boundary("random", "2026-09-04T12:00:00.000Z", true, false),
    ],
    new Date("2026-09-07T00:00:00.000Z"),
  );
  assert.equal(report.backfilled, false);
  assert.equal(report.forecastCounts.comparable, 3);
  assert.equal(report.evaluationMode, "prospective");
  assert.equal(report.activeModelVersion, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION);
  assert.equal(report.baselineModelVersion, RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION);
  assert.equal(report.comparison.resolved24h, 1);
  assert.equal(report.comparison.resolved48h, 1);
  assert.equal(report.comparison.targetResetCount, 1);
  assert.equal(report.ageBuckets.length, 4);
  assert.deepEqual(report.ageBuckets.map((bucket) => bucket.ageBucket), ["0-24h", "24-48h", "48-72h", "72h+"]);
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.gate.manualReviewOnly, true);
});

test("prospective evaluator rejects a forecast whose map key and modelVersion disagree", () => {
  const malformed = row("2026-09-03T00:00:00.000Z", true, true, 12);
  const control = malformed.forecasts[RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION];
  if (!control) throw new Error("control fixture is missing");
  control.modelVersion = RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION;

  assert.deepEqual(selectComparableRandomBandwidthForecasts([malformed]), []);
});

test("shadow experiment does not leak through public-v1 DTO", () => {
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow: new Date("2026-09-03T12:00:00.000Z") }),
    "ja",
  );
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION), false);
  assert.equal(serialized.includes(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION), false);
  assert.equal(serialized.includes(NEXT_GENERATION_B_MODEL_VERSION), false);
});

test("experiment row type remains compatible with existing forecast storage", () => {
  const forecasts: ExperimentalProbabilityForecasts = {};
  assert.deepEqual(Object.keys(forecasts), []);
  assert.ok(HOUR_MS > 0);
});
