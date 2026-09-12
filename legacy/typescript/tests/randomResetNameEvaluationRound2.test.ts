import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoundTwoPrompt,
  compareRoundTwoRows,
  pairRandomResetNameEvents,
  type RoundTwoEvaluationRow,
  type SourceTweetRow,
} from "../scripts/evaluate-random-reset-names-round2";
import type { WindowEventLike } from "../lib/radar/types";

function event(
  id: string,
  completedAt: string,
  sourceUrl: string,
  options: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    kind: "reset_completed",
    status: "closed",
    closed_at: completedAt,
    completed_at: completedAt,
    title: "既存表示名",
    summary: "記録済みの事実",
    source_url: sourceUrl,
    recordKind: "confirmed_global",
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "なし",
    },
    ...options,
  };
}

function tweet(tweetId: string, createdAt: string, text: string): SourceTweetRow {
  return {
    tweet_id: tweetId,
    text,
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: createdAt,
    is_reply: false,
  };
}

test("pairs only uniquely mapped Tibo source tweets with valid chronology", () => {
  const history = [
    event("paired", "2026-08-01T01:00:00.000Z", "https://x.com/thsottiaux/status/100"),
    event("non-tibo", "2026-07-31T01:00:00.000Z", "https://x.com/dkundel/status/101"),
    event("duplicate", "2026-07-30T01:00:00.000Z", "https://x.com/thsottiaux/status/102"),
    event("duplicate-regular", "2026-07-29T01:00:00.000Z", "https://x.com/thsottiaux/status/102", {
      recordKind: "reference",
      details: {
        cycleType: "定期リセット",
        reasonType: "定期更新",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分",
        noticeType: "なし",
      },
    }),
  ];
  const sourceTweets = [
    tweet("100", "2026-07-31T23:00:00.000Z", "A direct Tibo post"),
    tweet("102", "2026-07-29T00:00:00.000Z", "A duplicate mapping"),
  ];

  const paired = pairRandomResetNameEvents(
    history,
    sourceTweets,
    new Date("2026-08-02T00:00:00.000Z"),
    16,
  );

  assert.equal(paired.length, 1);
  assert.equal(paired[0].eventId, "paired");
  assert.equal(paired[0].sourceTweet.text, "A direct Tibo post");
});

test("allows only a small same-minute timestamp gap for static event precision", () => {
  const history = [
    event("precision-gap", "2026-08-01T01:00:00.000Z", "https://x.com/thsottiaux/status/103"),
  ];

  const withinPrecisionGap = pairRandomResetNameEvents(
    history,
    [tweet("103", "2026-08-01T01:00:30.000Z", "Same-minute source")],
    new Date("2026-08-02T00:00:00.000Z"),
    16,
  );
  const laterPost = pairRandomResetNameEvents(
    history,
    [tweet("103", "2026-08-01T01:06:00.000Z", "Later source")],
    new Date("2026-08-02T00:00:00.000Z"),
    16,
  );

  assert.equal(withinPrecisionGap.length, 1);
  assert.equal(laterPost.length, 0);
});

test("adds only source_post_text to the metadata prompt for condition B", () => {
  const input = {
    completedAt: "2026-08-01T01:00:00.000Z",
    currentClassification: "confirmed_global",
    status: "closed",
    cycleType: "ランダムリセット",
    reasonType: "ご祝儀リセット",
    resetMethod: "強制リセット",
    scope: "全有料プラン",
    noticeType: "なし",
    noticeToExecution: "0分",
    recordedSummary: "記録済みの事実",
    sourceUrl: "https://x.com/thsottiaux/status/100",
    sourcePostText: null,
  } as const;

  const metadataPrompt = buildRoundTwoPrompt(input, "metadata_only", "A direct Tibo post");
  const sourcePrompt = buildRoundTwoPrompt(input, "metadata_plus_source", "A direct Tibo post");

  assert.equal(sourcePrompt.startsWith(`${metadataPrompt}\n`), true);
  assert.doesNotMatch(metadataPrompt, /source_post_text:\s*\n\s*"?A direct Tibo post/);
  assert.match(sourcePrompt, /source_post_text:\n"A direct Tibo post"/);
});

test("compares only successful paired outputs and separates one-sided failures", () => {
  const rows: RoundTwoEvaluationRow[] = [
    {
      eventId: "same",
      completedAt: "2026-08-01T00:00:00.000Z",
      condition: "metadata_only",
      name: "同じ名前",
      confidence: 0.8,
      evidence: null,
      reason: "同じ",
      status: "success",
      needsHumanReview: false,
      flags: [],
      attempts: 1,
    },
    {
      eventId: "same",
      completedAt: "2026-08-01T00:00:00.000Z",
      condition: "metadata_plus_source",
      name: "同じ名前",
      confidence: 0.9,
      evidence: null,
      reason: "同じ",
      status: "success",
      needsHumanReview: false,
      flags: [],
      attempts: 1,
    },
    {
      eventId: "changed",
      completedAt: "2026-07-31T00:00:00.000Z",
      condition: "metadata_only",
      name: null,
      confidence: 0.3,
      evidence: null,
      reason: "不足",
      status: "success",
      needsHumanReview: false,
      flags: [],
      attempts: 1,
    },
    {
      eventId: "changed",
      completedAt: "2026-07-31T00:00:00.000Z",
      condition: "metadata_plus_source",
      name: "原文由来",
      confidence: 0.8,
      evidence: "原文",
      reason: "特徴あり",
      status: "success",
      needsHumanReview: false,
      flags: [],
      attempts: 1,
    },
    {
      eventId: "failed",
      completedAt: "2026-07-30T00:00:00.000Z",
      condition: "metadata_only",
      name: null,
      confidence: null,
      evidence: null,
      reason: null,
      status: "rate_limited",
      needsHumanReview: false,
      flags: [],
      attempts: 4,
    },
  ];

  const comparison = compareRoundTwoRows(rows);
  assert.equal(comparison.pairedSuccessfulCount, 2);
  assert.equal(comparison.sameNameCount, 1);
  assert.equal(comparison.changedNameCount, 1);
  assert.equal(comparison.metadataNullToSourceNameCount, 1);
  assert.equal(comparison.oneSidedFailureCount, 1);
});
