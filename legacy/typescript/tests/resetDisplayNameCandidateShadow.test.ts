import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import type { ResetDisplayNameCandidateNotice } from "../lib/radar/resetDisplayNameReconciliation";
import {
  inspectResetDisplayNameCandidatesFromInputs,
} from "../scripts/inspect-reset-display-name-candidates";
import type { ResetDisplayNameCandidateRecord } from "../lib/radar/resetDisplayNameCandidateTypes";
import type { RadarData, WindowEventLike } from "../lib/radar/types";
import type { TiboFormalAdoptionRecord } from "../lib/radar/tiboFormalAdoptionStore";

const NOW = new Date("2026-09-09T00:00:00.000Z");

function candidate(): ResetDisplayNameCandidateRecord {
  return {
    candidateId: "candidate-private-1",
    noticeDedupeKey: "logical-post:2090000000000000001",
    officialNoticeTweetId: "2090000000000000002",
    logicalPostId: "2090000000000000001",
    noticeTweetIds: ["2090000000000000002"],
    sourceTweetIds: ["2090000000000000002"],
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiNameJa: "候補リセット",
    aiNameEn: "Candidate Reset",
    aiNameZh: "候选重置",
    aiConfidence: null,
    aiEvidence: null,
    aiReason: "candidate fixture",
    aiFlags: [],
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    lifecycleStatus: "provisional",
    generationAttempts: 1,
    lastGeneratedAt: "2026-09-08T00:00:00.000Z",
    promotedEventKey: null,
    promotedAt: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    nextRetryAt: null,
  };
}

function notice(): ResetDisplayNameCandidateNotice {
  return {
    officialNoticeTweetId: "2090000000000000002",
    logicalPostId: "2090000000000000001",
    noticeTweetIds: ["2090000000000000002"],
    sourceTweetIds: ["2090000000000000002"],
    tweetCreatedAt: "2026-09-08T01:00:00.000Z",
    noticeObservedAt: "2026-09-08T01:01:00.000Z",
    expectedStartAt: null,
    expectedEndAt: null,
    temporalPrecision: null,
    scope: "全有料プラン",
    noticeType: "公式告知あり",
    sourceUrl: "https://x.test/2090000000000000002",
    sourceContext: "A reset announcement.",
    isExecutionBearing: true,
  };
}

function shadowInputs() {
  const formalNotice = {
    tweet_id: "2090000000000000002",
    text: "A reset announcement.",
    tweet_url: "https://x.test/2090000000000000002",
    tweet_created_at: "2026-09-08T01:00:00.000Z",
    signal_type: "reset_executed" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: "2090000000000000001",
    edit_history_tweet_ids: ["2090000000000000001", "2090000000000000002"],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const adoption: TiboFormalAdoptionRecord = {
    id: "adoption-1",
    logicalPostId: "2090000000000000001",
    logicalPostTweetIds: ["2090000000000000002"],
    resetEventKey: "canonical-event-1",
    representativeTweetId: "2090000000000000002",
    sourceTweetIds: ["2090000000000000002"],
    claimSource: "new_adoption",
    adoptedAt: "2026-09-08T02:00:00.000Z",
    claimedAt: "2026-09-08T02:00:00.000Z",
    createdAt: "2026-09-08T02:00:00.000Z",
    updatedAt: "2026-09-08T02:00:00.000Z",
  };
  const history: WindowEventLike[] = [{
    id: "canonical-event-1",
    kind: "reset_completed",
    recordKind: "banked_distribution",
    status: "closed",
    title: "Recorded reset",
    opened_at: "2026-09-08T01:00:00.000Z",
    completed_at: "2026-09-08T02:00:00.000Z",
    details: {
      cycleType: "ランダムリセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "1時間",
    },
  }];

  return {
    activation: {
      mode: "full" as const,
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    notices: [notice()],
    candidates: [candidate()],
    data: getLocalRadarData({
      formalTiboResets: [formalNotice] as unknown as RadarData["formal_tibo_resets"],
      tiboFormalAdoptions: [adoption],
    }),
    canonicalHistory: history,
    now: NOW,
  };
}

test("shadow inspection is read-only and finds an authoritative promotion-ready candidate", () => {
  const report = inspectResetDisplayNameCandidatesFromInputs(shadowInputs());

  assert.equal(report.eligibleNoticeCount, 1);
  assert.equal(report.existingCandidateCount, 1);
  assert.equal(report.missingSeedCount, 0);
  assert.equal(report.ambiguousIdentityCount, 0);
  assert.equal(report.promotionReadyCount, 1);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.writes, 0);
});

test("shadow inspection is fail-closed for candidate reads when activation is off", () => {
  const input = shadowInputs();
  const report = inspectResetDisplayNameCandidatesFromInputs({
    ...input,
    activation: { mode: "off", adoptionAt: null },
  });

  assert.equal(report.eligibleNoticeCount, 0);
  assert.equal(report.existingCandidateCount, 0);
  assert.equal(report.missingSeedCount, 0);
  assert.equal(report.promotionReadyCount, 0);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.writes, 0);
});
