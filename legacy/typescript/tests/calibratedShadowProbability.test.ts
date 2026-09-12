import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  calculateCalibratedShadowProbability,
  enforceProbabilityHorizonCoherence,
  getPointInTimeRadarData,
} from "../lib/radar/calibratedShadowProbability";
import {
  CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_VERSION,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";

function historyEvent(id: string, completedAt: string) {
  return {
    id,
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    summary: "テスト用の全体リセットです。",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "即時実行",
    },
  } as const;
}

test("calibrated Shadow uses the v2 result and preserves audit metadata", () => {
  const now = new Date("2026-08-04T03:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const result = calculateCalibratedShadowProbability(data, {
    now,
    staticHistory: [
      historyEvent("reset-1", "2026-07-20T00:00:00.000Z"),
      historyEvent("reset-2", "2026-07-22T00:00:00.000Z"),
    ],
  });

  assert.equal(result.modelVersion, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(result.pointInTimeProjectionVersion, CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_VERSION);
  assert.equal(result.rawModelVersion, SHADOW_PROBABILITY_MODEL_VERSION);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.calibrationSampleCount24h, 0);
  assert.equal(result.calibrationSampleCount48h, 0);
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
  assert.equal(result.probability24h, result.rawProbability24h);
  assert.equal(result.probability48h, result.rawProbability48h);
  assert.ok(result.probability48h >= result.probability24h);
  assert.ok(result.probability24h >= 0 && result.probability24h <= 1);
  assert.ok(result.probability48h >= 0 && result.probability48h <= 1);
});

test("point-in-time data excludes future signals, status entries, and dynamic resets", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: new Date("2026-08-04T00:00:00.000Z"),
    activeTiboSignals: [
      {
        tweet_id: "past-teaser",
        signal_type: "teaser",
        confidence: 0.85,
        tweet_created_at: "2026-07-31T12:00:00.000Z",
        detected_at: "2026-07-31T12:05:00.000Z",
        expires_at: "2026-08-05T00:00:00.000Z",
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "future-teaser",
        signal_type: "teaser",
        confidence: 0.85,
        tweet_created_at: "2026-08-02T12:00:00.000Z",
        detected_at: "2026-08-02T12:05:00.000Z",
        expires_at: "2026-08-05T00:00:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
    formalTiboResets: [
      {
        tweet_id: "future-reset",
        text: "future reset",
        tweet_url: "https://x.com/example/status/2",
        tweet_created_at: "2026-08-02T12:00:00.000Z",
        detected_at: "2026-08-02T12:05:00.000Z",
        signal_type: "reset_executed",
        confidence: 0.99,
        verification_status: "confirmed",
      },
    ],
    openAIStatus: undefined,
  });
  data.openai_status_history = [
    {
      id: "past-incident",
      title: "Past Codex incident",
      status: "resolved",
      impact: "minor",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T11:00:00.000Z",
      resolvedAt: "2026-07-31T11:00:00.000Z",
      source: "openai_status",
      url: "https://status.openai.com/incidents/past-incident",
    },
    {
      id: "future-incident",
      title: "Future Codex incident",
      status: "investigating",
      impact: "major",
      createdAt: "2026-08-02T10:00:00.000Z",
      updatedAt: "2026-08-02T10:30:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/future-incident",
    },
  ];

  const snapshot = getPointInTimeRadarData(data, origin);
  assert.equal(snapshot?.codex_environment, undefined);
  assert.deepEqual(snapshot?.active_tibo_signals?.map((signal) => signal.tweet_id), ["past-teaser"]);
  assert.equal(snapshot?.formal_tibo_resets?.length, 0);
  assert.deepEqual(snapshot?.openai_status_history?.map((incident) => incident.id), ["past-incident"]);
});

test("status projection uses only observations known at the origin", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") });
  data.openai_status_history = [
    {
      id: "known-active",
      title: "Known active incident",
      status: "investigating",
      impact: "major",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:30:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/known-active",
    },
    {
      id: "resolved-after-origin",
      title: "Incident resolved later",
      status: "resolved",
      impact: "minor",
      createdAt: "2026-07-31T11:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      resolvedAt: "2026-08-02T12:00:00.000Z",
      source: "openai_status",
      url: "https://status.openai.com/incidents/resolved-after-origin",
    },
    {
      id: "created-after-origin",
      title: "Incident created later",
      status: "investigating",
      impact: "critical",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:30:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/created-after-origin",
    },
  ];

  const snapshot = getPointInTimeRadarData(data, origin);
  assert.deepEqual(snapshot?.openai_status_history?.map((incident) => incident.id), [
    "known-active",
    "resolved-after-origin",
  ]);
  const projectedResolved = snapshot?.openai_status_history?.find(
    (incident) => incident.id === "resolved-after-origin",
  );
  assert.equal(projectedResolved?.status, "investigating");
  assert.equal(projectedResolved?.resolvedAt, null);

  const afterResolution = getPointInTimeRadarData(data, new Date("2026-08-03T00:00:00.000Z"));
  const resolved = afterResolution?.openai_status_history?.find(
    (incident) => incident.id === "resolved-after-origin",
  );
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolvedAt, "2026-08-02T12:00:00.000Z");
});

test("future monitoring and identified updates are conservatively projected", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") });
  data.openai_status_history = [
    {
      id: "future-monitoring-update",
      title: "A stronger future monitoring title",
      status: "monitoring",
      impact: "critical",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/future-monitoring-update",
    },
    {
      id: "future-identified-update",
      title: "Another stronger future identified title",
      status: "identified",
      impact: "critical",
      createdAt: "2026-07-31T11:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/future-identified-update",
    },
  ];

  const projected = getPointInTimeRadarData(data, origin)?.openai_status_history ?? [];
  for (const incident of projected) {
    assert.equal(incident.status, "investigating");
    assert.equal(incident.impact, null);
    assert.equal(incident.title, "OpenAI Status incident");
    assert.equal(incident.updatedAt, incident.createdAt);
    assert.equal(incident.resolvedAt, null);
  }
});

test("keeps origin-known monitoring state and excludes incidents without origin evidence", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") });
  data.openai_status_history = [
    {
      id: "known-monitoring",
      title: "Known monitoring incident",
      status: "monitoring",
      impact: "major",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/known-monitoring",
    },
    {
      id: "missing-all-times",
      title: "Undated incident",
      status: "investigating",
      impact: "critical",
      createdAt: null,
      updatedAt: null,
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/missing-all-times",
    },
    {
      id: "missing-created-with-update",
      title: "Incident known from update",
      status: "monitoring",
      impact: "minor",
      createdAt: null,
      updatedAt: "2026-07-31T13:00:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/missing-created-with-update",
    },
  ];

  const projected = getPointInTimeRadarData(data, origin)?.openai_status_history ?? [];
  assert.deepEqual(projected.map((incident) => incident.id), [
    "known-monitoring",
    "missing-created-with-update",
  ]);
  assert.equal(projected[0]?.status, "monitoring");
  assert.equal(projected[0]?.impact, "major");
});

test("future status and impact/title changes do not alter an earlier prediction", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const baseData = getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") });
  baseData.openai_status_history = [{
    id: "mutable-incident",
    title: "Codex incident",
    status: "investigating",
    impact: "minor",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-07-31T10:30:00.000Z",
    resolvedAt: null,
    source: "openai_status",
    url: "https://status.openai.com/incidents/mutable-incident",
  }];
  const futureData = structuredClone(baseData);
  futureData.openai_status_history = [{
    ...baseData.openai_status_history[0],
    title: "Critical capacity errors after a future update",
    status: "resolved",
    impact: "critical",
    updatedAt: "2026-08-02T12:00:00.000Z",
    resolvedAt: "2026-08-02T12:00:00.000Z",
  }];

  const base = calculateCalibratedShadowProbability(getPointInTimeRadarData(baseData, origin), { now: origin });
  const future = calculateCalibratedShadowProbability(getPointInTimeRadarData(futureData, origin), { now: origin });
  assert.equal(future.rawProbability24h, base.rawProbability24h);
  assert.equal(future.rawProbability48h, base.rawProbability48h);
  assert.equal(future.alpha24h, base.alpha24h);
  assert.equal(future.alpha48h, base.alpha48h);
  assert.equal(future.probability24h, base.probability24h);
  assert.equal(future.probability48h, base.probability48h);
});

test("adding a future Status incident does not change an earlier origin prediction", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const baseData = getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") });
  baseData.openai_status_history = [
    {
      id: "known-active",
      title: "Known active incident",
      status: "investigating",
      impact: "major",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:30:00.000Z",
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/known-active",
    },
  ];
  const withFutureStatus = structuredClone(baseData);
  withFutureStatus.openai_status_history?.push({
    id: "future-incident",
    title: "Future incident",
    status: "investigating",
    impact: "critical",
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:30:00.000Z",
    resolvedAt: null,
    source: "openai_status",
    url: "https://status.openai.com/incidents/future-incident",
  });

  const baseSnapshot = getPointInTimeRadarData(baseData, origin);
  const futureSnapshot = getPointInTimeRadarData(withFutureStatus, origin);
  const basePrediction = calculateCalibratedShadowProbability(baseSnapshot, { now: origin });
  const futurePrediction = calculateCalibratedShadowProbability(futureSnapshot, { now: origin });
  assert.deepEqual(futurePrediction, basePrediction);
});

test("future Status data does not enter the v4 calibration audit", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const futureData = structuredClone(data);
  futureData.openai_status_history = [{
    id: "future-status",
    title: "Future status incident",
    status: "investigating",
    impact: "critical",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:30:00.000Z",
    resolvedAt: null,
    source: "openai_status",
    url: "https://status.openai.com/incidents/future-status",
  }];
  const staticHistory = Array.from({ length: 12 }, (_, index) =>
    historyEvent(
      `reset-${index}`,
      new Date(Date.UTC(2026, 5, 1 + index * 3)).toISOString(),
    ),
  );

  const base = calculateCalibratedShadowProbability(data, { now, staticHistory });
  const withFutureStatus = calculateCalibratedShadowProbability(futureData, { now, staticHistory });
  assert.equal(withFutureStatus.alpha24h, base.alpha24h);
  assert.equal(withFutureStatus.alpha48h, base.alpha48h);
  assert.equal(withFutureStatus.calibrationSampleCount24h, base.calibrationSampleCount24h);
  assert.equal(withFutureStatus.calibrationSampleCount48h, base.calibrationSampleCount48h);
  assert.equal(withFutureStatus.probability24h, base.probability24h);
  assert.equal(withFutureStatus.probability48h, base.probability48h);
});

test("the same point-in-time inputs produce a deterministic v4 alpha", () => {
  const origin = new Date("2026-08-01T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: origin });
  const first = getPointInTimeRadarData(data, origin);
  const second = getPointInTimeRadarData(data, origin);
  assert.deepEqual(first, second);
  assert.deepEqual(
    calculateCalibratedShadowProbability(first, { now: origin }),
    calculateCalibratedShadowProbability(second, { now: origin }),
  );
});

test("calculating the internal Shadow does not alter the public v2 calculation", () => {
  const now = new Date("2026-08-04T03:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const before = getRadarViewModel(data, "en", true, undefined, now);
  calculateCalibratedShadowProbability(data, { now });
  const after = getRadarViewModel(data, "en", true, undefined, now);
  assert.deepEqual(
    {
      probability24h: after.probability24h,
      probability48h: after.probability48h,
      expectation: after.expectation,
      displayReasoningSummary: after.displayReasoningSummary,
    },
    {
      probability24h: before.probability24h,
      probability48h: before.probability48h,
      expectation: before.expectation,
      displayReasoningSummary: before.displayReasoningSummary,
    },
  );
});

test("official notice keeps the 90/96 override after calibration", () => {
  const now = new Date("2026-08-04T03:00:00.000Z");
  const result = calculateCalibratedShadowProbability(getLocalRadarData({ calculationNow: now }), {
    now,
    activeOfficialNotice: {
      origin: "dynamic",
      id: "notice",
      title: "Reset notice",
      summary: "Reset notice",
      observedAt: "2026-08-04T00:00:00.000Z",
      expectedAt: null,
      expectedEndAt: null,
      expiresAt: "2026-08-05T00:00:00.000Z",
      source: "https://x.com/example/status/notice",
      sourceLabel: "test",
    },
  });

  assert.equal(result.officialNoticeOverride, true);
  assert.equal(result.probability24h, 0.9);
  assert.equal(result.probability48h, 0.96);
});

test("horizon coherence adjustment is explicit and finite", () => {
  assert.deepEqual(enforceProbabilityHorizonCoherence(0.7, 0.4), {
    probability24h: 0.7,
    probability48h: 0.7,
    adjusted: true,
  });
  assert.deepEqual(enforceProbabilityHorizonCoherence(0.4, 0.7), {
    probability24h: 0.4,
    probability48h: 0.7,
    adjusted: false,
  });
});
