import { getLocalRadarData } from "../../lib/radar";
import type { ActiveTiboSignal, RadarData } from "../../lib/radar/types";
import type { FormalTiboResetSignal } from "../../lib/radar/tiboHistory";

export const PRODUCTION_PARITY_ORIGIN = new Date("2026-08-13T06:20:00.000Z");

function resetSignal(tweetId: string, tweetCreatedAt: string, detectedAt: string): FormalTiboResetSignal {
  return {
    tweet_id: tweetId,
    text: "All paid users of Codex and ChatGPT Work received a reset.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: tweetCreatedAt,
    detected_at: detectedAt,
    signal_type: "reset_executed",
    confidence: 1,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    is_reply: false,
  };
}

function officialNotice(): ActiveTiboSignal {
  return {
    tweet_id: "2087706104814023111",
    text: "The usage limits have been reset for all paid users of Codex and ChatGPT Work.",
    tweet_url: "https://x.com/thsottiaux/status/2087706104814023111",
    tweet_created_at: "2026-08-13T01:01:37.000Z",
    detected_at: "2026-08-13T01:07:02.022Z",
    signal_type: "official_notice",
    confidence: 0.95,
    verification_status: "auto_unverified",
    expires_at: "2026-08-15T01:07:02.022Z",
    is_reply: false,
  };
}

export function createProductionPointInTimeRadarData(): RadarData {
  const recoveryObservationId = "fixture-recovery-2026-08-13";
  return getLocalRadarData({
    calculationNow: PRODUCTION_PARITY_ORIGIN,
    recentTiboSignals: [officialNotice()],
    formalTiboResets: [
      resetSignal(
        "2083395449814229287",
        "2026-08-01T03:32:37.000Z",
        "2026-08-01T12:58:37.607Z",
      ),
      resetSignal(
        "2086188036493344823",
        "2026-08-08T20:29:22.000Z",
        "2026-08-08T20:30:33.599Z",
      ),
      resetSignal(
        "2086972933566857393",
        "2026-08-11T00:28:16.000Z",
        "2026-08-11T00:29:07.968Z",
      ),
    ],
    resetExecutionEstimates: [
      {
        resetEventKey: "tibo-reset-2087706104814023111",
        displayExecutionAt: "2026-08-13T03:34:43.341Z",
        executionTimeSource: "usage_observation",
        executionTimeConfidence: "high",
        executionTimePrecision: "approximate",
        executionWindowStartAt: "2026-08-13T03:32:44.526Z",
        executionWindowEndAt: "2026-08-13T03:34:43.341Z",
        recoveryObservationId,
        recoveryPreviousObservedAt: "2026-08-13T03:32:44.526Z",
        recoveryObservedAt: "2026-08-13T03:34:43.341Z",
        tiboAnnouncedAt: "2026-08-13T01:01:37.000Z",
        tiboPrimaryTweetId: "2087706104814023111",
        tiboSourceTweetIds: ["2087706104814023111"],
        officialNoticeTweetId: "2087706104814023111",
        officialNoticeAt: "2026-08-13T01:01:37.000Z",
        estimatorVersion: "usage-execution-v1",
        createdAt: "2026-08-13T03:48:35.114Z",
        updatedAt: "2026-08-13T03:48:43.302Z",
      },
    ],
    codexRecoveryObservations: [
      {
        id: recoveryObservationId,
        sourceKey: "local-codex-app-server",
        observedAt: "2026-08-13T03:34:43.341Z",
        previousObservedAt: "2026-08-13T03:32:44.526Z",
        previousUsedPercent: 82,
        currentUsedPercent: 1,
        previousResetsAt: 1787196882,
        currentResetsAt: 1787196882,
        cycleHint: "unexpected",
        confidence: "strong",
        status: "observed",
        matchedTiboTweetId: null,
        confirmedAt: null,
        createdAt: "2026-08-13T03:34:45.010Z",
        updatedAt: "2026-08-13T03:34:43.341Z",
      },
    ],
  });
}
