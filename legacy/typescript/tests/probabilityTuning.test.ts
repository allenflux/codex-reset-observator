import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_OBSERVATION_SIGNALS } from "../data/observationSignals";
import { LOCAL_PROBABILITY_WEIGHTS } from "../data/predictionWeights";
import { getLocalRadarData } from "../lib/radar";
import {
  getHistoricalResetPressure,
  getLocalResetProbability,
  getRegularResetProximityBoost,
  getTeaserBoost,
} from "../lib/radar/probability";

test("weekend calm correction is not configured", () => {
  assert.equal("weekendCalmAdjustment" in LOCAL_PROBABILITY_WEIGHTS, false);
});

test("Tibo teaser boost starts lower and decays to zero over 48 hours", () => {
  const observedAt = "2026-08-03T00:00:00.000Z";
  const observed = new Date(observedAt);
  const after24Hours = new Date("2026-08-04T00:00:00.000Z");
  const after48Hours = new Date("2026-08-05T00:00:00.000Z");

  assert.equal(getTeaserBoost("24h", observedAt, observed), 0.2);
  assert.equal(getTeaserBoost("48h", observedAt, observed), 0.3);
  assert.equal(getTeaserBoost("24h", observedAt, after24Hours), 0.1);
  assert.equal(getTeaserBoost("48h", observedAt, after24Hours), 0.15);
  assert.equal(getTeaserBoost("24h", observedAt, after48Hours), 0);
  assert.equal(getTeaserBoost("48h", observedAt, after48Hours), 0);
});

test("an older Tibo teaser contributes less than a fresh teaser", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const makeData = (tweetCreatedAt: string) =>
    getLocalRadarData({
      activeTiboSignals: [
        {
          tweet_id: `teaser-${tweetCreatedAt}`,
          signal_type: "teaser",
          confidence: 0.85,
          tweet_created_at: tweetCreatedAt,
          expires_at: "2026-08-06T12:00:00.000Z",
          verification_status: "auto_unverified",
        },
      ],
    });

  const fresh = getLocalResetProbability(
    makeData("2026-08-03T12:00:00.000Z"),
    "24h",
    undefined,
    null,
    now,
  );
  const older = getLocalResetProbability(
    makeData("2026-08-02T12:00:00.000Z"),
    "24h",
    undefined,
    null,
    now,
  );

  assert.ok(fresh > older, `expected fresh=${fresh} to exceed older=${older}`);
});

test("regular reset proximity increases toward the expected time", () => {
  const now = new Date("2026-08-02T08:00:00.000Z");
  const at6Days = "2026-08-08T08:00:00.000Z";
  const at5Days = "2026-08-07T08:00:00.000Z";
  const at2Days = "2026-08-04T08:00:00.000Z";
  const at24Hours = "2026-08-03T08:00:00.000Z";
  const at12Hours = "2026-08-02T20:00:00.000Z";
  const assertClose = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be close to ${expected}`);

  assert.equal(getRegularResetProximityBoost("48h", "2026-08-09T08:00:00.000Z", now), 0);
  assertClose(getRegularResetProximityBoost("48h", at6Days, now), 0.01);
  assertClose(getRegularResetProximityBoost("48h", at5Days, now), 0.02);
  assertClose(getRegularResetProximityBoost("48h", at2Days, now), 0.05);
  assertClose(getRegularResetProximityBoost("48h", at24Hours, now), 0.06);
  assertClose(getRegularResetProximityBoost("48h", now.toISOString(), now), 0.07);
  assert.ok(
    getRegularResetProximityBoost("24h", at12Hours, now) >
      getRegularResetProximityBoost("24h", at24Hours, now),
  );
  assertClose(getRegularResetProximityBoost("24h", at24Hours, now), 0.02);
  assertClose(getRegularResetProximityBoost("24h", now.toISOString(), now), 0.05);
  assert.equal(
    getRegularResetProximityBoost("48h", "2026-08-01T08:00:00.000Z", now),
    0,
  );
});

test("historical reset pressure stays capped while reflecting short random-reset intervals", () => {
  const data = getLocalRadarData({});
  const now = new Date("2026-08-02T08:00:00.000Z");
  const pressure24h = getHistoricalResetPressure("24h", data, now);
  const pressure48h = getHistoricalResetPressure("48h", data, now);

  assert.ok(pressure24h > 0);
  assert.ok(pressure48h > pressure24h);
  assert.ok(pressure24h <= LOCAL_PROBABILITY_WEIGHTS.historicalResetPressure.forecast24h.maxBoost);
  assert.ok(pressure48h <= LOCAL_PROBABILITY_WEIGHTS.historicalResetPressure.forecast48h.maxBoost);
});

test("48-hour probability is never lower than 24-hour probability", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const monotonicityFixture = {
    id: "test-24h-only-boost",
    observedAt: now.toISOString(),
    type: "probability_boost" as const,
    status: "active" as const,
    expiresAt: "2026-08-06T12:00:00.000Z",
    boostValue24h: 0.7,
    boostValue48h: 0,
    title: "test fixture",
    source: "test",
    sourceLabel: "test",
  };

  LOCAL_OBSERVATION_SIGNALS.push(monotonicityFixture);
  try {
    const data = getLocalRadarData({});
    const p24 = getLocalResetProbability(data, "24h", undefined, null, now);
    const p48 = getLocalResetProbability(data, "48h", undefined, null, now);

    assert.ok(p48 >= p24, `expected p48=${p48} to be >= p24=${p24}`);
    assert.equal(p48, p24);
  } finally {
    LOCAL_OBSERVATION_SIGNALS.pop();
  }
});
