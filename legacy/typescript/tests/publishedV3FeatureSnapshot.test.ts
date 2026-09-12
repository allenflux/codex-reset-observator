import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { NEXT_GENERATION_TRAINING_SELECT_FIELDS } from "../lib/radar/nextGenerationTraining";
import type { OpenAIStatusSignals } from "../lib/openaiStatus";
import type { ActiveTiboSignal, RadarData } from "../lib/radar/types";
import {
  buildPublishedV3FeatureSnapshot,
  PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION,
  readPublishedV3FeatureSnapshot,
} from "../lib/radar/publishedV3FeatureSnapshot";

const ORIGIN = new Date("2026-09-10T00:00:00.000Z");

function signal(overrides: Partial<ActiveTiboSignal> = {}): ActiveTiboSignal {
  return {
    tweet_id: "signal-visible",
    text: "A reset teaser is expected later.",
    tweet_url: "https://x.com/thsottiaux/status/signal-visible",
    tweet_created_at: "2026-09-09T12:00:00.000Z",
    detected_at: "2026-09-09T12:05:00.000Z",
    signal_type: "teaser",
    confidence: 0.82,
    verification_status: "confirmed",
    teaser_strength: "weak",
    is_reply: false,
    ...overrides,
  };
}

function status(createdAt: string): OpenAIStatusSignals {
  return {
    updatedAt: createdAt,
    statusIncidents24h: 1,
    activeCodexIncidents: 1,
    recentCodexIncidents: 1,
    affectedCodexComponents: 1,
    suppressCodexIncidents: false,
    codexOperationalStatus: "active",
    latestCodexIncidentName: "Codex incident",
    history: [{
      id: `incident-${createdAt}`,
      title: "Codex incident",
      status: "investigating",
      impact: "minor",
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      source: "openai_status",
      url: "https://status.openai.com/incidents/incident",
    }],
  };
}

function unknownSnapshot() {
  return {
    featureSnapshotVersion: PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION,
    bankedEventWithin48h: null,
    usableTiboSignal: null,
    statusIncident: null,
    tiboSignalAgeHours: null,
    tiboSignalType: null,
    tiboSignalConfidence: null,
    tiboTeaserStrength: null,
  };
}

function bankedEstimate(executionAt: string) {
  return {
    resetEventKey: "banked-reset-banked-notice",
    displayExecutionAt: executionAt,
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: null,
    executionWindowEndAt: null,
    recoveryObservationId: null,
    tiboAnnouncedAt: executionAt,
    tiboPrimaryTweetId: "banked-notice",
    tiboSourceTweetIds: ["banked-notice"],
    officialNoticeTweetId: "banked-notice",
    officialNoticeAt: executionAt,
    estimatorVersion: "banked-distribution-observation-v2",
    createdAt: "2026-09-08T00:02:00.000Z",
    updatedAt: "2026-09-08T00:02:00.000Z",
  };
}

test("feature snapshot uses only Tibo and status information available at the origin", () => {
  const data = getLocalRadarData({
    calculationNow: ORIGIN,
    recentTiboSignals: [
      signal(),
      signal({
        tweet_id: "signal-future",
        tweet_created_at: "2026-09-10T00:01:00.000Z",
        detected_at: "2026-09-10T00:02:00.000Z",
      }),
    ],
    openAIStatus: status("2026-09-09T13:00:00.000Z"),
  });

  const snapshot = buildPublishedV3FeatureSnapshot(data, ORIGIN);

  assert.equal(snapshot.featureSnapshotVersion, "v1");
  assert.equal(snapshot.usableTiboSignal, true);
  assert.equal(snapshot.tiboSignalType, "teaser");
  assert.equal(snapshot.tiboSignalConfidence, 0.82);
  assert.equal(snapshot.tiboTeaserStrength, "weak");
  assert.equal(snapshot.tiboSignalAgeHours, 12);
  assert.equal(snapshot.statusIncident, true);
});

test("future Tibo and status rows do not create retrospective features", () => {
  const data = getLocalRadarData({
    calculationNow: ORIGIN,
    recentTiboSignals: [signal({
      tweet_id: "signal-future-only",
      tweet_created_at: "2026-09-10T00:01:00.000Z",
      detected_at: "2026-09-10T00:02:00.000Z",
    })],
    openAIStatus: status("2026-09-10T00:01:00.000Z"),
  });

  assert.deepEqual(buildPublishedV3FeatureSnapshot(data, ORIGIN), {
    ...unknownSnapshot(),
    bankedEventWithin48h: false,
    usableTiboSignal: false,
    statusIncident: false,
  });
});

test("no signal is represented as known false with nullable signal details", () => {
  const data = getLocalRadarData({ calculationNow: ORIGIN });
  const snapshot = buildPublishedV3FeatureSnapshot(data, ORIGIN);

  assert.equal(snapshot.usableTiboSignal, false);
  assert.equal(snapshot.statusIncident, false);
  assert.equal(snapshot.tiboSignalAgeHours, null);
  assert.equal(snapshot.tiboSignalType, null);
  assert.equal(snapshot.tiboSignalConfidence, null);
  assert.equal(snapshot.tiboTeaserStrength, null);
});

test("a BANKED event exactly 48 hours before the origin is outside the strict lookback", () => {
  const data = getLocalRadarData({
    calculationNow: ORIGIN,
    recentTiboSignals: [signal({
      tweet_id: "banked-notice",
      text: "We will credit all users with a BANKED reset.",
      tweet_created_at: "2026-09-08T00:00:00.000Z",
      detected_at: "2026-09-08T00:01:00.000Z",
      signal_type: "official_notice",
      confidence: 0.96,
      teaser_strength: null,
    })],
    resetExecutionEstimates: [bankedEstimate("2026-09-08T00:00:00.000Z")],
  });

  assert.equal(buildPublishedV3FeatureSnapshot(data, ORIGIN).bankedEventWithin48h, false);
});

test("a BANKED event just inside 48 hours is included", () => {
  const data = getLocalRadarData({
    calculationNow: ORIGIN,
    recentTiboSignals: [signal({
      tweet_id: "banked-notice",
      text: "We will credit all users with a BANKED reset.",
      tweet_created_at: "2026-09-08T00:00:00.001Z",
      detected_at: "2026-09-08T00:01:00.000Z",
      signal_type: "official_notice",
      confidence: 0.96,
      teaser_strength: null,
    })],
    resetExecutionEstimates: [bankedEstimate("2026-09-08T00:00:00.001Z")],
  });

  assert.equal(buildPublishedV3FeatureSnapshot(data, ORIGIN).bankedEventWithin48h, true);
});

test("invalid or missing stored snapshots remain unknown to the reader", () => {
  assert.equal(readPublishedV3FeatureSnapshot(undefined), null);
  assert.equal(readPublishedV3FeatureSnapshot({ featureSnapshotVersion: "v2" }), null);
  assert.deepEqual(readPublishedV3FeatureSnapshot(unknownSnapshot()), unknownSnapshot());
});

test("feature snapshot metadata does not add public RadarData fields", () => {
  const data: RadarData = getLocalRadarData({ calculationNow: ORIGIN });
  const snapshot = buildPublishedV3FeatureSnapshot(data, ORIGIN);
  const publicSnapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: ORIGIN });
  assert.equal("featureSnapshot" in data, false);
  assert.equal("sourceText" in snapshot, false);
  assert.equal(publicSnapshot.schemaVersion, "public-v1");
  assert.doesNotMatch(JSON.stringify(publicSnapshot), /featureSnapshot|tiboSignalAgeHours|bankedEventWithin48h/);
  assert.doesNotMatch(NEXT_GENERATION_TRAINING_SELECT_FIELDS, /featureSnapshot/);
});
