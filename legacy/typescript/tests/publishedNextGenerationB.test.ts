import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import { calculateNextGenerationSelectiveCalibrationProbability } from "../lib/radar/nextGenerationProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";

// Public calculations are evaluated on ten-minute buckets; 02:10 is the
// first rounded bucket at or after the 02:04 adoption timestamp.
const NOW = new Date("2026-08-23T02:10:00.000Z");

test("the selective hybrid promotion is configured while B v1 remains active before its boundary", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const published = calculatePublishedProbability(data, {
    now: NOW,
    activeOfficialNotice: null,
    nextGenerationBTrainingRows: [],
    nextGenerationBTrainingReadStatus: "ok",
  });

  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(published.source, "calibrated");
  assert.equal(published.adoptedModel, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(published.fallbackReason, null);
  assert.ok(published.nextGenerationB);
  assert.deepEqual(
    {
      probability12h: published.probability12h,
      probability24h: published.probability24h,
      probability48h: published.probability48h,
      probability72h: published.probability72h,
    },
    published.nextGenerationB.predictions,
  );
});

test("mixed calibration records final horizon coherence adjustment", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  const trainingRows = Array.from({ length: 12 }, (_, index) => ({
    generatedAt: new Date(now.getTime() - (index + 3) * 24 * 60 * 60 * 1000).toISOString(),
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
    rawProbability24h: 0.8,
    rawProbability48h: 0.8,
    actual24h: false,
    actual48h: false,
  }));

  const result = calculateNextGenerationSelectiveCalibrationProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      activeOfficialNotice: null,
      trainingRows,
      trainingReadStatus: "ok",
    },
  );

  assert.equal(result.predictions.probability48h, result.predictions.probability24h);
  assert.equal(result.horizonCoherenceAdjusted, true);
});
