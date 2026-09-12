import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import { calculateShadowProbability } from "../lib/radar/shadowProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";
import type {
  BoundaryCensoredBoundary,
  BoundaryCensoredInterval,
} from "../lib/radar/boundaryCensoredProbability";
import {
  BOUNDARY_CENSORED_MODEL_VERSION,
  buildBoundaryCensoredHazard,
  calculateBoundaryCensoredProbability,
  collectBoundaryCensoredBoundaries,
  createBoundaryCensoredIntervals,
  getBoundaryCensoredHorizonOutcome,
} from "../lib/radar/boundaryCensoredProbability";
import type { WindowEventLike } from "../lib/radar/types";
import { evaluateBoundaryCensoredProbability } from "../scripts/evaluateBoundaryCensoredProbability";
import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";

function boundary(
  id: string,
  resetAt: string,
  cycleType: "定期リセット" | "ランダムリセット",
  overrides: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: id,
    kind: "reset_completed",
    status: "closed",
    closed_at: resetAt,
    completed_at: resetAt,
    scope: "全有料プラン",
    details: {
      cycleType,
      reasonType: cycleType,
      resetMethod: cycleType === "定期リセット" ? "強制リセット" : "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
    ...overrides,
  };
}

function boundaryAt(
  id: string,
  resetAt: string,
  isRandomEvent: boolean,
): BoundaryCensoredBoundary {
  return {
    id,
    resetAt,
    cycleType: isRandomEvent ? "ランダムリセット" : "定期リセット",
    recordKind: isRandomEvent ? "confirmed_global" : "reference",
    isRandomEvent,
  };
}

function intervalEvents(intervals: Array<BoundaryCensoredInterval>) {
  return intervals.map((interval) => interval.event);
}

test("builds event and censored intervals across random and regular boundaries", () => {
  const boundaries = [
    boundaryAt("random-0", "2026-08-01T00:00:00.000Z", true),
    boundaryAt("random-24", "2026-08-02T00:00:00.000Z", true),
    boundaryAt("regular-48", "2026-08-03T00:00:00.000Z", false),
    boundaryAt("random-72", "2026-08-04T00:00:00.000Z", true),
    boundaryAt("regular-96", "2026-08-05T00:00:00.000Z", false),
  ];

  const result = createBoundaryCensoredIntervals(
    boundaries,
    new Date("2026-08-06T00:00:00.000Z"),
  );

  assert.deepEqual(intervalEvents(result.completed), [true, false, true, false]);
  assert.deepEqual(result.completed.map((interval) => interval.durationHours), [24, 24, 24, 24]);
  assert.equal(result.currentRightCensoredHours, 24);
});

test("regular boundaries add exposure but never observed random events", () => {
  const hazard = buildBoundaryCensoredHazard([
    boundaryAt("random-0", "2026-08-01T00:00:00.000Z", true),
    boundaryAt("regular-24", "2026-08-02T00:00:00.000Z", false),
    boundaryAt("random-48", "2026-08-03T00:00:00.000Z", true),
  ], new Date("2026-08-04T00:00:00.000Z"));

  assert.equal(hazard.observedEventCount, 1);
  assert.equal(hazard.completedEventIntervalCount, 1);
  assert.equal(hazard.censoredIntervalCount, 1);
  assert.equal(hazard.totalExposureHours, 72);
  assert.equal(hazard.totalExposureDays, 3);
});

test("groups same-time regular and random boundaries without a zero-hour interval", () => {
  const result = createBoundaryCensoredIntervals([
    boundaryAt("random-0", "2026-08-01T00:00:00.000Z", true),
    boundaryAt("regular-24", "2026-08-02T00:00:00.000Z", false),
    boundaryAt("random-24", "2026-08-02T00:00:00.000Z", true),
    boundaryAt("random-48", "2026-08-03T00:00:00.000Z", true),
  ], new Date("2026-08-04T00:00:00.000Z"));

  assert.deepEqual(intervalEvents(result.completed), [true, true]);
  assert.deepEqual(result.completed.map((interval) => interval.durationHours), [24, 24]);
  assert.equal(result.completed.some((interval) => interval.durationHours === 0), false);
});

test("censors a horizon at a regular boundary instead of scoring a later random event as negative", () => {
  const boundaries = [
    boundaryAt("random-0", "2026-08-01T00:00:00.000Z", true),
    boundaryAt("regular-24", "2026-08-02T00:00:00.000Z", false),
    boundaryAt("random-48", "2026-08-03T00:00:00.000Z", true),
  ];

  assert.equal(
    getBoundaryCensoredHorizonOutcome(boundaries, new Date("2026-08-01T00:00:00.000Z"), 48),
    "censored",
  );
  assert.equal(
    getBoundaryCensoredHorizonOutcome(boundaries, new Date("2026-08-02T00:00:00.000Z"), 24),
    "event",
  );
});

test("regular-to-regular creates a censored interval and regular-to-random creates an event interval", () => {
  const result = createBoundaryCensoredIntervals([
    boundaryAt("random-0", "2026-08-01T00:00:00.000Z", true),
    boundaryAt("regular-24", "2026-08-02T00:00:00.000Z", false),
    boundaryAt("regular-48", "2026-08-03T00:00:00.000Z", false),
    boundaryAt("random-72", "2026-08-04T00:00:00.000Z", true),
  ], new Date("2026-08-05T00:00:00.000Z"));

  assert.deepEqual(intervalEvents(result.completed), [false, false, true]);
});

test("accepts broad reference regular history and audits excluded regular history", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const result = collectBoundaryCensoredBoundaries(
    null,
    now,
    [
      boundary("regular-reference", "2026-08-01T00:00:00.000Z", "定期リセット", {
        recordKind: "reference",
      }),
      boundary("regular-narrow", "2026-08-02T00:00:00.000Z", "定期リセット", {
        scope: "不具合対象ユーザー（約50万人）",
        details: {
          cycleType: "定期リセット",
          reasonType: "定期リセット",
          resetMethod: "強制リセット",
          scope: "不具合対象ユーザー（約50万人）",
          noticeToExecution: "0分",
        },
      }),
      boundary("regular-future", "2026-08-11T00:00:00.000Z", "定期リセット"),
      boundary("regular-pending", "2026-08-03T00:00:00.000Z", "定期リセット", {
        status: "pending",
        closed_at: null,
        completed_at: null,
      }),
      boundary("regular-invalid", "not-a-date", "定期リセット"),
      boundary("random-reference", "2026-08-04T00:00:00.000Z", "ランダムリセット", {
        recordKind: "reference",
      }),
    ],
  );

  assert.deepEqual(result.boundaries.map((item) => item.id), ["regular-reference"]);
  assert.deepEqual(result.acceptedRegularBoundaries.map((item) => item.id), ["regular-reference"]);
  assert.deepEqual(
    result.excludedRegularBoundaries.map((item) => [item.id, item.reason]),
    [
      ["regular-narrow", "not_broad_scope"],
      ["regular-future", "future_timestamp"],
      ["regular-pending", "not_completed"],
      ["regular-invalid", "invalid_timestamp"],
    ],
  );
});

test("rejected history is excluded from candidate boundaries", () => {
  const rejectedUrl = "https://x.com/thsottiaux/status/999";
  const result = collectBoundaryCensoredBoundaries(
    {
      rejected_tibo_resets: [{
        tweet_id: "999",
        tweet_url: rejectedUrl,
        tweet_created_at: "2026-08-04T00:00:00.000Z",
      }],
    },
    new Date("2026-08-05T00:00:00.000Z"),
    [boundary("rejected", "2026-08-04T00:00:00.000Z", "ランダムリセット", {
      source_url: rejectedUrl,
    })],
  );

  assert.equal(result.boundaries.length, 0);
});

test("candidate probability uses the latest broad boundary and keeps horizons ordered", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const result = calculateBoundaryCensoredProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: [
        boundary("random-0", "2026-08-01T00:00:00.000Z", "ランダムリセット"),
        boundary("regular-48", "2026-08-03T00:00:00.000Z", "定期リセット", {
          recordKind: "reference",
        }),
      ],
      activeOfficialNotice: null,
    },
  );

  assert.equal(result.modelVersion, BOUNDARY_CENSORED_MODEL_VERSION);
  assert.equal(result.audit.lastRandomResetAt, "2026-08-01T00:00:00.000Z");
  assert.equal(result.audit.lastBoundaryAt, "2026-08-03T00:00:00.000Z");
  assert.equal(result.audit.currentAgeHours, 36);
  assert.ok(result.predictions.probability12h >= 0);
  assert.ok(result.predictions.probability12h <= result.predictions.probability24h);
  assert.ok(result.predictions.probability24h <= result.predictions.probability48h);
  assert.ok(result.predictions.probability48h <= result.predictions.probability72h);
  assert.ok(result.predictions.probability72h <= 1);
});

test("candidate preserves the official notice override", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const result = calculateBoundaryCensoredProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: [boundary("random", "2026-08-01T00:00:00.000Z", "ランダムリセット")],
      activeOfficialNotice: {
        origin: "local",
        id: "notice",
        title: "Reset notice",
        summary: null,
        observedAt: "2026-08-03T00:00:00.000Z",
        expectedAt: "2026-08-04T00:00:00.000Z",
        expectedEndAt: null,
        expiresAt: null,
        source: null,
        sourceLabel: "source",
      },
    },
  );

  assert.equal(result.officialNoticeOverride.active, true);
  assert.equal(result.predictions.probability24h, 0.9);
  assert.equal(result.predictions.probability48h, 0.96);
});

test("candidate evaluation model stays separate from the public recency model", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const options = {
    now,
    staticHistory: [boundary("random", "2026-08-01T00:00:00.000Z", "ランダムリセット")],
    activeOfficialNotice: null,
  };
  const publicResult = calculatePublishedProbability(data, options, { logFallback: false });
  const candidateResult = calculateBoundaryCensoredProbability(data, options);

  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(publicResult.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(candidateResult.modelVersion, BOUNDARY_CENSORED_MODEL_VERSION);
});

test("boundary-censored evaluation compares against the unweighted baseline", () => {
  const report = evaluateBoundaryCensoredProbability(new Date("2026-08-01T03:32:00.000Z"));

  assert.equal(report.evaluationMethod, "walk_forward_prequential");
  assert.equal(report.currentModelVersion, "hazard-odds-v3-random-inclusive");
  assert.equal(report.candidateModelVersion, BOUNDARY_CENSORED_MODEL_VERSION);
  assert.ok(report.models.current.metrics24h.scoredCount > 0);
  assert.ok(report.models.candidate.metrics24h.censoredCount >= 0);
  assert.ok(report.intervalSummary.candidateCensoredIntervalCount > 0);
  assert.ok(report.acceptedRegularBoundaries.length > 0);
});
