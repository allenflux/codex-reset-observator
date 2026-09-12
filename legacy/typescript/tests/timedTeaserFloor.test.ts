import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import { calculateNextGenerationBProbability } from "../lib/radar/nextGenerationProbability";
import type { ActiveOfficialNotice } from "../lib/radar/probability";
import {
  applyStrongTimedTeaserProbabilityFloor,
  getStrongTimedTeaserProbabilityFloor,
} from "../lib/radar/shadowProbability";

const EXPECTED_START_AT = "2026-08-29T07:00:00.000Z";
const EXPECTED_END_AT = "2026-08-30T07:00:00.000Z";

function calculateTimedTeaser(
  now: string,
  overrides: Record<string, unknown> = {},
  activeOfficialNotice: ActiveOfficialNotice | null = null,
) {
  const signal = {
    tweet_id: "timed-floor-test",
    signal_type: "teaser" as const,
    text: "Reset button tomorrow.",
    tweet_url: "https://x.com/thsottiaux/status/timed-floor-test",
    tweet_created_at: new Date(new Date(now).getTime() - 60 * 60 * 1000).toISOString(),
    confidence: 0.9,
    verification_status: "confirmed" as const,
    classification_source: "gemini" as const,
    teaser_strength: "strong" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "exact_time" as const,
    temporal_confidence: 1,
    expected_start_at: EXPECTED_START_AT,
    expected_end_at: EXPECTED_END_AT,
    ...overrides,
  };
  const calculationNow = new Date(now);
  const data = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [signal],
  });
  return calculateNextGenerationBProbability(data, {
    now: calculationNow,
    activeOfficialNotice,
    staticHistory: [],
    trainingRows: [],
    trainingReadStatus: "ok",
  });
}

test("B uses the floor at 24 hours, interpolates it, and reaches the near-start floor", () => {
  const at24Hours = calculateTimedTeaser("2026-08-28T07:00:00.000Z");
  const at2Hours = calculateTimedTeaser("2026-08-29T05:00:00.000Z");
  const at1Hour = calculateTimedTeaser("2026-08-29T06:01:00.000Z");

  assert.deepEqual(
    getStrongTimedTeaserProbabilityFloor(
      getLocalRadarData({
        calculationNow: new Date("2026-08-28T07:00:00.000Z"),
        activeTiboSignals: [{
          tweet_id: "floor-direct",
          signal_type: "teaser",
          tweet_created_at: "2026-08-28T06:00:00.000Z",
          teaser_strength: "strong",
          temporal_resolution_status: "resolved",
          expected_start_at: EXPECTED_START_AT,
          expected_end_at: EXPECTED_END_AT,
        }],
      }),
      new Date("2026-08-28T07:00:00.000Z"),
      null,
    ),
    { probability24h: 0.7, probability48h: 0.85 },
  );
  assert.ok(at24Hours.predictions.probability24h >= 0.7);
  assert.ok(at24Hours.predictions.probability48h >= 0.85);
  assert.ok(at2Hours.predictions.probability24h >= 0.85);
  assert.ok(at2Hours.predictions.probability48h >= 0.9);

  assert.ok(at1Hour.predictions.probability24h >= 0.85);
  assert.ok(at1Hour.predictions.probability48h >= 0.9);
  assert.equal(at1Hour.teaserTimingPolicyVersion, "teaser-window-overlap-v4");
});

test("the floor linearly interpolates between 24 hours and 2 hours", () => {
  const result = getStrongTimedTeaserProbabilityFloor(
    getLocalRadarData({
      calculationNow: new Date("2026-08-28T19:00:00.000Z"),
      activeTiboSignals: [{
        tweet_id: "floor-interpolation",
        signal_type: "teaser",
        tweet_created_at: "2026-08-28T18:00:00.000Z",
        teaser_strength: "strong",
        temporal_resolution_status: "resolved",
        expected_start_at: EXPECTED_START_AT,
        expected_end_at: EXPECTED_END_AT,
      }],
    }),
    new Date("2026-08-28T19:00:00.000Z"),
    null,
  );

  assert.deepEqual(result, {
    probability24h: 0.7818181818181817,
    probability48h: 0.8772727272727273,
  });
});

test("the full floor also applies inside the hinted window and stops after it", () => {
  const inside = calculateTimedTeaser("2026-08-29T08:00:00.000Z");
  assert.ok(inside.predictions.probability24h >= 0.85);
  assert.ok(inside.predictions.probability48h >= 0.9);

  const after = getStrongTimedTeaserProbabilityFloor(
    getLocalRadarData({
      calculationNow: new Date("2026-08-30T08:00:00.000Z"),
      activeTiboSignals: [{
        tweet_id: "floor-after-end",
        signal_type: "teaser",
        tweet_created_at: "2026-08-30T07:00:00.000Z",
        teaser_strength: "strong",
        temporal_resolution_status: "resolved",
        expected_start_at: EXPECTED_START_AT,
        expected_end_at: EXPECTED_END_AT,
      }],
    }),
    new Date("2026-08-30T08:00:00.000Z"),
    null,
  );
  assert.equal(after, null);
});

test("the new floor does not apply before the lead-in, to weak, or to untimed strong teasers", () => {
  const beforeLeadIn = calculateTimedTeaser("2026-08-27T06:00:00.000Z");
  const weak = calculateTimedTeaser("2026-08-29T06:01:00.000Z", {
    teaser_strength: "weak",
  });
  const untimed = calculateTimedTeaser("2026-08-29T06:01:00.000Z", {
    temporal_resolution_status: null,
    expected_start_at: null,
    expected_end_at: null,
  });

  assert.equal(
    getStrongTimedTeaserProbabilityFloor(
      getLocalRadarData({
        calculationNow: new Date("2026-08-27T06:00:00.000Z"),
        activeTiboSignals: [{
          tweet_id: "before-lead-in",
          signal_type: "teaser",
          tweet_created_at: "2026-08-27T05:00:00.000Z",
          teaser_strength: "strong",
          temporal_resolution_status: "resolved",
          expected_start_at: EXPECTED_START_AT,
          expected_end_at: EXPECTED_END_AT,
        }],
      }),
      new Date("2026-08-27T06:00:00.000Z"),
      null,
    ),
    null,
  );
  assert.ok(beforeLeadIn.predictions.probability24h < 0.7);
  assert.ok(beforeLeadIn.predictions.probability48h < 0.85);
  assert.ok(weak.predictions.probability24h < 0.85);
  assert.ok(weak.predictions.probability48h < 0.9);
  assert.ok(untimed.predictions.probability24h < 0.85);
  assert.ok(untimed.predictions.probability48h < 0.9);
});

test("official notice policy remains authoritative over the teaser floor", () => {
  const notice: ActiveOfficialNotice = {
    origin: "dynamic",
    id: "official-notice",
    title: "Official reset",
    summary: "Official reset notice",
    observedAt: "2026-08-29T05:00:00.000Z",
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: "2026-08-30T07:00:00.000Z",
    source: "https://x.com/thsottiaux/status/official-notice",
    sourceLabel: "test",
  };
  const result = calculateTimedTeaser("2026-08-29T06:01:00.000Z", {}, notice);

  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
  assert.equal(result.officialNoticeOverride.active, true);
});

test("manual and Gemini strong timed teasers use the same floor", () => {
  const manual = calculateTimedTeaser("2026-08-29T06:01:00.000Z", {
    classification_source: "manual",
  });
  const gemini = calculateTimedTeaser("2026-08-29T06:01:00.000Z", {
    classification_source: "gemini",
  });

  assert.deepEqual(manual.predictions, gemini.predictions);
});

test("the floor never lowers a normal result and preserves horizon coherence", () => {
  const base = {
    probability12h: 0.8,
    probability24h: 0.88,
    probability48h: 0.91,
    probability72h: 0.99,
  };

  assert.deepEqual(
    applyStrongTimedTeaserProbabilityFloor(base, {
      probability24h: 0.85,
      probability48h: 0.9,
    }),
    base,
  );
  const raised = applyStrongTimedTeaserProbabilityFloor(base, {
    probability24h: 0.95,
    probability48h: 0.96,
  });
  assert.equal(raised.probability24h, 0.95);
  assert.equal(raised.probability48h, 0.96);
  assert.ok(raised.probability48h >= raised.probability24h);
  assert.ok(raised.probability72h >= raised.probability48h);
});

test("the floor ignores non-teaser signals and invalid timed ranges", () => {
  const now = new Date("2026-08-29T06:01:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "not-a-teaser",
      signal_type: "official_notice",
      tweet_created_at: "2026-08-29T05:01:00.000Z",
      ai_teaser_strength: "strong",
      temporal_resolution_status: "resolved",
      expected_start_at: EXPECTED_START_AT,
      expected_end_at: EXPECTED_END_AT,
    }, {
      tweet_id: "invalid-range",
      signal_type: "teaser",
      tweet_created_at: "2026-08-29T05:01:00.000Z",
      teaser_strength: "strong",
      temporal_resolution_status: "resolved",
      expected_start_at: EXPECTED_END_AT,
      expected_end_at: EXPECTED_START_AT,
    }],
  });

  assert.equal(getStrongTimedTeaserProbabilityFloor(data, now, null), null);
});
