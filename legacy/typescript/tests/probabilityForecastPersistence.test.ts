import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  CALIBRATED_SHADOW_MODEL_VERSION_V2,
  ELAPSED_ONLY_MODEL_VERSION,
  LEGACY_SHADOW_PROBABILITY_MODEL_VERSION,
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  SHADOW_PROBABILITY_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_TARGET_DEFINITION,
  RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
} from "../data/shadowProbabilityConfig";
import { buildExperimentalProbabilityForecasts, buildProbabilityDebugInfo } from "../lib/logProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";
import { calculateShadowProbability } from "../lib/radar/shadowProbability";
import { getLocalProbabilityCalculation } from "../lib/radar/probability";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";

test("internal forecast audit stores the inclusive model and all fixed recency models without duplicate keys", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const primary = getLocalProbabilityCalculation(data, { now });
  const shadow = calculateShadowProbability(data, { now });
  const forecasts = buildExperimentalProbabilityForecasts(data, {
    now,
    shadowProbability: shadow,
  });

  assert.deepEqual(Object.keys(forecasts), [
    "hazard-odds-v3-random-inclusive",
    "hazard-odds-v3-recency-bayes-h14-r2",
    "hazard-odds-v3-recency-bayes-h30-r3",
    "hazard-odds-v3-recency-bayes-h60-r2",
    ELAPSED_ONLY_MODEL_VERSION,
    "hazard-regime-elapsed-v1",
    RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
    RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
    CALIBRATED_SHADOW_MODEL_VERSION,
    CALIBRATED_SHADOW_MODEL_VERSION_V2,
  ]);
  assert.equal(forecasts[SHADOW_PROBABILITY_MODEL_VERSION].generatedAt, now.toISOString());
  assert.equal(forecasts[SHADOW_PROBABILITY_MODEL_VERSION].probability24h, shadow.predictions.probability24h);
  assert.equal(forecasts[SHADOW_PROBABILITY_MODEL_VERSION].probability12h, shadow.predictions.probability12h);
  assert.equal(forecasts[SHADOW_PROBABILITY_MODEL_VERSION].probability72h, shadow.predictions.probability72h);
  const regimeElapsed = forecasts["hazard-regime-elapsed-v1"];
  assert.equal(regimeElapsed.modelVersion, "hazard-regime-elapsed-v1");
  assert.equal(regimeElapsed.halfLifeDays, null);
  assert.ok(regimeElapsed.probability24h >= 0);
  assert.ok(regimeElapsed.probability48h >= regimeElapsed.probability24h);
  assert.equal(typeof regimeElapsed.regimeMultiplier, "number");
  assert.equal(typeof regimeElapsed.recentRatePerDay, "number");
  assert.equal(typeof regimeElapsed.longTermRatePerDay, "number");
  assert.equal(typeof regimeElapsed.elapsedHoursSinceRecovery, "number");
  assert.equal(regimeElapsed.selectedBinScheme, "A");
  assert.equal(regimeElapsed.selectedPriorExposureDays, 2);
  assert.equal(regimeElapsed.selectedRegimeHalfLifeDays, 3);
  assert.equal(regimeElapsed.selectedRegimeRatioExponent, 1);
  const elapsedOnly = forecasts[ELAPSED_ONLY_MODEL_VERSION];
  assert.equal(elapsedOnly.modelVersion, ELAPSED_ONLY_MODEL_VERSION);
  assert.equal(elapsedOnly.mode, "elapsed-only");
  assert.equal(elapsedOnly.effectiveRegimeMultiplier, 1);
  assert.equal(typeof elapsedOnly.regimeMultiplier, "number");
  const explicitPublished = calculateRegimeElapsedProbability(
    data,
    { now },
    PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  );
  assert.equal(explicitPublished.regimeElapsed.regime.priorExposureDays, 2);
  assert.equal(regimeElapsed.probability24h, explicitPublished.predictions.probability24h);
  assert.equal(regimeElapsed.probability48h, explicitPublished.predictions.probability48h);
  const explicitElapsedOnly = calculateRegimeElapsedProbability(
    data,
    { now },
    PUBLISHED_ELAPSED_MODEL_OPTIONS,
  );
  assert.equal(elapsedOnly.probability24h, explicitElapsedOnly.predictions.probability24h);
  assert.equal(elapsedOnly.probability48h, explicitElapsedOnly.predictions.probability48h);
  const randomElapsed = forecasts[RANDOM_ELAPSED_SHADOW_MODEL_VERSION];
  assert.equal(randomElapsed.modelVersion, RANDOM_ELAPSED_SHADOW_MODEL_VERSION);
  assert.equal(typeof randomElapsed.randomElapsedHours, "number");
  assert.equal(typeof randomElapsed.recoveryElapsedHours, "number");
  assert.equal(typeof randomElapsed.randomBoundaryCount, "number");
  assert.equal(typeof randomElapsed.regularBoundaryCount, "number");
  assert.equal(randomElapsed.freezeAt, "2026-08-11T18:38:51.000Z");
  const randomContinuous = forecasts[RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION];
  assert.equal(randomContinuous.modelVersion, RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION);
  assert.equal(randomContinuous.estimator, "gaussian-kernel");
  assert.equal(randomContinuous.mode, "full");
  assert.equal(randomContinuous.kernelBandwidthHours, 24);
  assert.equal(randomContinuous.kernelGridHours, 1);
  assert.equal(randomContinuous.kernelTruncationHours, 72);
  assert.equal(randomContinuous.localPriorExposureDays, 2);
  assert.equal(randomContinuous.localPriorWindowHours, 48);
  assert.equal(randomContinuous.kernelType, "gaussian");
  assert.equal(randomContinuous.gridStepHours, 1);
  assert.equal(randomContinuous.priorExposureDays, 2);
  assert.equal(randomContinuous.currentKernelWeightedEvents !== undefined, true);
  assert.equal(randomContinuous.currentKernelWeightedExposureHours !== undefined, true);
  assert.deepEqual(
    randomContinuous.probeDailyProbabilities?.map((probe) => probe.ageHours),
    [96, 120, 132, 144, 156, 168, 192, 216],
  );
  assert.equal(
    randomContinuous.probeDailyProbabilities?.every((probe) =>
      Number.isFinite(probe.dailyProbability)
      && probe.dailyProbability >= 0
      && probe.dailyProbability <= 1,
    ),
    true,
  );
  assert.equal(randomContinuous.effectiveRegimeMultiplier, randomContinuous.regimeMultiplier);
  assert.equal(randomContinuous.freezeAt, "2026-08-18T16:14:21.000Z");
  const calibrated = forecasts[CALIBRATED_SHADOW_MODEL_VERSION];
  const previousCalibrated = forecasts[CALIBRATED_SHADOW_MODEL_VERSION_V2];
  assert.equal(calibrated.rawModelVersion, "hazard-odds-v3-random-inclusive");
  assert.equal(calibrated.evaluationMode, "prospective");
  assert.equal(typeof calibrated.alpha24h, "number");
  assert.equal(typeof calibrated.alpha48h, "number");
  assert.equal(typeof calibrated.calibrationSampleCount24h, "number");
  assert.equal(typeof calibrated.positiveCalibrationCount48h, "number");
  assert.equal(typeof calibrated.horizonCoherenceAdjusted, "boolean");
  assert.equal(typeof calibrated.fallbackUsed, "boolean");
  assert.equal(calibrated.pointInTimeProjectionVersion, "status-conservative-v2");
  assert.equal(previousCalibrated.modelVersion, CALIBRATED_SHADOW_MODEL_VERSION_V2);
  assert.equal(previousCalibrated.officialNoticeOverride, false);
  assert.equal(
    forecasts["hazard-odds-v4-logit-calibrated-prequential-v1"],
    undefined,
  );
  assert.equal(LEGACY_SHADOW_PROBABILITY_MODEL_VERSION, "hazard-odds-v2-random-only");
  for (const forecast of Object.values(forecasts)) {
    assert.equal(forecast.generatedAt, now.toISOString());
    if (forecast.modelVersion === "hazard-regime-elapsed-v1" || forecast.modelVersion === ELAPSED_ONLY_MODEL_VERSION) {
      assert.ok(forecast.completedEventCount >= 0);
    } else {
      assert.ok(forecast.completedEventCount >= forecast.completedIntervalCount);
    }
    assert.ok(forecast.weightedEventCount >= 0);
    assert.ok(forecast.weightedExposureDays >= 0);
    assert.ok(forecast.probability48h >= forecast.probability24h);
    if (forecast.probability72h !== undefined) {
      assert.ok(forecast.probability48h <= forecast.probability72h);
    }
    if (forecast.probability12h !== undefined) {
      assert.ok(forecast.probability12h <= forecast.probability24h);
    }
    if (forecast.modelVersion === "hazard-regime-elapsed-v1" || forecast.modelVersion === ELAPSED_ONLY_MODEL_VERSION) {
      assert.match(forecast.targetDefinition, /recovery-boundary/);
    } else if (forecast.modelVersion === RANDOM_ELAPSED_SHADOW_MODEL_VERSION) {
      assert.equal(forecast.targetDefinition, RANDOM_ELAPSED_SHADOW_TARGET_DEFINITION);
    } else if (forecast.modelVersion === RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION) {
      assert.equal(forecast.targetDefinition, RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION);
    } else {
      assert.equal(forecast.targetDefinition, shadow.targetDefinition);
    }
  }

  const debugInfo = buildProbabilityDebugInfo(
    {},
    primary,
    now.toISOString(),
    now,
    shadow,
    undefined,
    forecasts,
  );
  assert.deepEqual(Object.keys(debugInfo.experimentalProbabilityForecasts as object), Object.keys(forecasts));
  assert.doesNotMatch(
    JSON.stringify(toPublicRadarSnapshot(data, "en", { calculationNow: now })),
    /hazard-odds-v3-recency|hazard-odds-v4-logit-calibrated|hazard-regime-random-elapsed|alpha24h|alpha48h|calibrationSampleCount/,
  );
});

test("the calibrated experimental forecast matches the published 24h and 48h values", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const published = calculatePublishedProbability(data, { now }, { logFallback: false });
  const forecasts = buildExperimentalProbabilityForecasts(data, {
    now,
    calibratedProbability: published.calibrated,
  });
  const calibrated = forecasts[CALIBRATED_SHADOW_MODEL_VERSION];

  assert.equal(published.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(calibrated.probability24h, published.probability24h);
  assert.equal(calibrated.probability48h, published.probability48h);
  assert.equal(calibrated.fallbackUsed, published.calibrated?.fallbackUsed);
});

test("reusing the published raw shadow preserves the experimental forecast output", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const published = calculatePublishedProbability(data, { now }, { logFallback: false });
  const calculated = buildExperimentalProbabilityForecasts(data, {
    now,
    calibratedProbability: published.calibrated,
  });
  const reused = buildExperimentalProbabilityForecasts(data, {
    now,
    shadowProbability: published.rawShadow ?? published.shadow,
    calibratedProbability: published.calibrated,
  });

  assert.deepEqual(reused, calculated);
});

test("the calibrated forecast records the canonical raw teaser multiplier", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    recentTiboSignals: [{
      tweet_id: "forecast-strength",
      signal_type: "irrelevant",
      text: "I might reset later.",
      tweet_url: "https://x.com/thsottiaux/status/forecast-strength",
      tweet_created_at: now.toISOString(),
      verification_status: "auto_unverified",
      teaser_strength: "strong",
      is_reply: false,
    }],
  });
  const published = calculatePublishedProbability(data, {
    now,
    activeOfficialNotice: null,
  });
  const raw = published.rawShadow;
  assert.ok(raw);
  const forecasts = buildExperimentalProbabilityForecasts(data, {
    now,
    shadowProbability: raw,
    calibratedProbability: published.calibrated,
  });
  const calibrated = forecasts[CALIBRATED_SHADOW_MODEL_VERSION];
  const previousCalibrated = forecasts[CALIBRATED_SHADOW_MODEL_VERSION_V2];

  assert.ok(calibrated.combinedSignalMultiplier24h > 1);
  assert.ok(calibrated.combinedSignalMultiplier48h > 1);
  assert.equal(
    calibrated.combinedSignalMultiplier24h,
    raw.multipliers.combinedAfterCap.probability24h,
  );
  assert.equal(
    calibrated.combinedSignalMultiplier48h,
    raw.multipliers.combinedAfterCap.probability48h,
  );
  assert.equal(calibrated.rawModelVersion, "hazard-odds-v3-random-inclusive");
  assert.equal(previousCalibrated.combinedSignalMultiplier24h, 1);
  assert.equal(previousCalibrated.combinedSignalMultiplier48h, 1);
  assert.ok(calibrated.probability24h > previousCalibrated.probability24h);
  assert.ok(calibrated.probability48h > previousCalibrated.probability48h);
});
