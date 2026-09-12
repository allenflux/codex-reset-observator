import assert from "node:assert/strict";
import test from "node:test";

import {
  combineResetHistory,
  type CodexRecoveryObservationInput,
  type FormalTiboResetSignal,
  type TiboNoticeSignal,
} from "../lib/radar/tiboHistory";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";
import type { WindowEventLike } from "../lib/radar/types";

const ROOT_TWEET_ID = "2094251180121854309";
const EDITED_TWEET_ID = "2094252447271366730";

type HistoryIdentityContext = {
  rawTiboSignals?: readonly (FormalTiboResetSignal | TiboNoticeSignal)[];
  recoveryObservations?: readonly CodexRecoveryObservationInput[];
  adoptionLedgers?: readonly unknown[];
  dynamicEvents?: readonly WindowEventLike[];
  adoptionLedgerReadError?: boolean;
};

const combineWithIdentityContext = combineResetHistory as unknown as (
  staticHistory: WindowEventLike[],
  formalTiboResets: FormalTiboResetSignal[],
  rejectedTiboResets?: never[],
  regularResetRows?: never[],
  noticeSignals?: never[],
  recoveryObservations?: CodexRecoveryObservationInput[],
  estimates?: ResetExecutionEstimate[],
  bankedSignals?: never[],
  identityContext?: HistoryIdentityContext,
) => WindowEventLike[];

function tiboSignal(
  tweetId: string,
  tweetCreatedAt: string,
  overrides: Partial<FormalTiboResetSignal> = {},
): FormalTiboResetSignal {
  return {
    tweet_id: tweetId,
    text: "I have reset usage limits for Codex and ChatGPT Work.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: tweetCreatedAt,
    detected_at: tweetCreatedAt,
    signal_type: "reset_executed",
    confidence: 0.99,
    verification_status: "confirmed",
    classification_reason: "explicit usage reset completion",
    classification_source: "gemini",
    logical_post_id: tweetId,
    edit_history_tweet_ids: [tweetId],
    edit_version: 1,
    edit_metadata_source: "none",
    ...overrides,
  };
}

function staticEvent(overrides: Partial<WindowEventLike> = {}): WindowEventLike {
  return {
    id: "usage-reset-41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    recordKind: "confirmed_global",
    title: "2500万人アクティブユーザー突破記念リセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: "2026-08-29T20:43:34.878Z",
    completed_at: "2026-08-29T21:25:40.549Z",
    closed_at: "2026-08-29T21:25:40.549Z",
    window_minutes: 42,
    scope: "全有料プラン",
    summary: "25M reset",
    source_url: `https://x.com/thsottiaux/status/${ROOT_TWEET_ID}`,
    sourceTweetIds: [ROOT_TWEET_ID, EDITED_TWEET_ID],
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "42分",
      noticeType: "公式告知あり",
    },
    ...overrides,
  };
}

test("trusted edit versions become one canonical history event beyond the legacy five-minute window", () => {
  const root = tiboSignal("2000000000000000001", "2026-08-01T00:00:00.000Z", {
    logical_post_id: "2000000000000000001",
    edit_history_tweet_ids: ["2000000000000000001", "2000000000000000002"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const edited = tiboSignal("2000000000000000002", "2026-08-01T01:00:00.000Z", {
    text: "I have reset usage limits again with the corrected details.",
    logical_post_id: "2000000000000000001",
    edit_history_tweet_ids: ["2000000000000000001", "2000000000000000002"],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });

  const history = combineWithIdentityContext(
    [],
    [root, edited],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [edited, root] },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "tibo-reset-2000000000000000001");
  assert.deepEqual(history[0].sourceTweetIds, [
    "2000000000000000001",
    "2000000000000000002",
  ]);
  assert.equal(history[0].source_url, edited.tweet_url);
  assert.equal(history[0].completed_at, root.tweet_created_at);
});

test("trusted logical posts inside five minutes remain separate while legacy none rows keep compatibility", () => {
  const first = tiboSignal("2000000000000000011", "2026-08-01T02:00:00.000Z", {
    logical_post_id: "2000000000000000011",
    edit_history_tweet_ids: ["2000000000000000011"],
    edit_metadata_source: "x_api",
  });
  const second = tiboSignal("2000000000000000012", "2026-08-01T02:01:00.000Z", {
    logical_post_id: "2000000000000000012",
    edit_history_tweet_ids: ["2000000000000000012"],
    edit_metadata_source: "x_api",
  });
  const trustedHistory = combineWithIdentityContext(
    [],
    [first, second],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [first, second] },
  );
  assert.equal(trustedHistory.length, 2);

  const legacyFirst = tiboSignal("legacy-one", "2026-08-01T03:00:00.000Z");
  const legacySecond = tiboSignal("legacy-two", "2026-08-01T03:01:00.000Z");
  const legacyHistory = combineResetHistory([], [legacyFirst, legacySecond]);
  assert.equal(legacyHistory.length, 1);
});

test("a trusted logical post cannot time-merge with unrelated unlabeled history", () => {
  const trusted = tiboSignal("2000000000000010031", "2026-08-01T06:00:00.000Z", {
    logical_post_id: "2000000000000010031",
    edit_history_tweet_ids: ["2000000000000010031"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const unrelated = staticEvent({
    id: "local-unrelated-reset",
    opened_at: "2026-08-01T05:59:00.000Z",
    completed_at: "2026-08-01T06:00:00.000Z",
    closed_at: "2026-08-01T06:00:00.000Z",
    source_url: "https://x.com/thsottiaux/status/2000000000000010032",
    sourceTweetIds: ["2000000000000010032"],
  });

  const history = combineWithIdentityContext(
    [unrelated],
    [trusted],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [trusted] },
  );

  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((item) => item.id).sort(),
    ["local-unrelated-reset", "tibo-reset-2000000000000010031"],
  );
});

test("reuses an estimate key when one recovery observation uniquely matches the logical post", () => {
  const signal = tiboSignal("2000000000000000031", "2026-08-01T05:00:00.000Z", {
    logical_post_id: "2000000000000000031",
    edit_history_tweet_ids: ["2000000000000000031"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const estimate: ResetExecutionEstimate = {
    resetEventKey: "usage-reset-recovery-evidence",
    displayExecutionAt: "2026-08-01T05:05:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-08-01T05:00:00.000Z",
    executionWindowEndAt: "2026-08-01T05:05:00.000Z",
    recoveryObservationId: "recovery-evidence-1",
    tiboPrimaryTweetId: null,
    tiboSourceTweetIds: [],
    estimatorVersion: "usage-execution-monitor-v1",
  };

  const history = combineWithIdentityContext(
    [],
    [signal],
    [],
    [],
    [],
    [{
      id: "recovery-evidence-1",
      matchedTiboTweetId: signal.tweet_id,
    }],
    [estimate],
    [],
    {
      rawTiboSignals: [signal],
      recoveryObservations: [{
        id: "recovery-evidence-1",
        matchedTiboTweetId: signal.tweet_id,
      }],
    },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, estimate.resetEventKey);
});

test("monitor-backed estimate key wins over a dynamic and ledger self key", () => {
  const signal = tiboSignal("2000000000000000041", "2026-08-01T07:00:00.000Z", {
    logical_post_id: "2000000000000000041",
    edit_history_tweet_ids: ["2000000000000000041"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const estimate: ResetExecutionEstimate = {
    resetEventKey: "usage-reset-monitor-canonical",
    displayExecutionAt: "2026-08-01T07:05:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-08-01T07:00:00.000Z",
    executionWindowEndAt: "2026-08-01T07:05:00.000Z",
    recoveryObservationId: null,
    tiboPrimaryTweetId: signal.tweet_id,
    tiboSourceTweetIds: [signal.tweet_id],
    estimatorVersion: "usage-execution-monitor-v1",
  };

  const history = combineWithIdentityContext(
    [],
    [signal],
    [],
    [],
    [],
    [],
    [estimate],
    [],
    {
      rawTiboSignals: [signal],
      adoptionLedgers: [{
        logicalPostId: signal.tweet_id,
        logicalPostTweetIds: [signal.tweet_id],
        resetEventKey: `tibo-reset-${signal.tweet_id}`,
        representativeTweetId: signal.tweet_id,
        sourceTweetIds: [signal.tweet_id],
        claimSource: "new_adoption",
      }],
      dynamicEvents: [{
        id: `tibo-reset-${signal.tweet_id}`,
        sourceTweetIds: [signal.tweet_id],
      }],
    },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, estimate.resetEventKey);
});

test("a ledger read error is not treated as an empty ledger for new history", () => {
  const signal = tiboSignal("2000000000000000051", "2026-08-01T08:00:00.000Z", {
    logical_post_id: "2000000000000000051",
    edit_history_tweet_ids: ["2000000000000000051"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });

  const history = combineWithIdentityContext(
    [],
    [signal],
    [],
    [],
    [],
    [],
    [],
    [],
    {
      rawTiboSignals: [signal],
      adoptionLedgerReadError: true,
    },
  );

  assert.deepEqual(history, []);
});

test("canonical history is idempotent and keeps provenance ordering deterministic", () => {
  const root = tiboSignal("2000000000000000061", "2026-08-01T09:00:00.000Z", {
    logical_post_id: "2000000000000000061",
    edit_history_tweet_ids: ["2000000000000000061", "2000000000000000062"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const edited = tiboSignal("2000000000000000062", "2026-08-01T09:01:00.000Z", {
    text: "edited reset usage announcement",
    logical_post_id: "2000000000000000061",
    edit_history_tweet_ids: ["2000000000000000061", "2000000000000000062"],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });
  const context = {
    rawTiboSignals: [edited, root],
  } satisfies HistoryIdentityContext;
  const first = combineWithIdentityContext(
    [],
    [edited, root],
    [],
    [],
    [],
    [],
    [],
    [],
    context,
  );
  const second = combineWithIdentityContext(
    first,
    [root, edited],
    [],
    [],
    [],
    [],
    [],
    [],
    { ...context, rawTiboSignals: [root, edited], dynamicEvents: first },
  );

  const summarize = (items: WindowEventLike[]) => items.map((item) => ({
    id: item.id,
    sourceTweetIds: item.sourceTweetIds,
    source_url: item.source_url,
    title: item.title,
    summary: item.summary,
    opened_at: item.opened_at,
    completed_at: item.completed_at,
    closed_at: item.closed_at,
    details: item.details,
  }));
  assert.deepEqual(summarize(second), summarize(first));
});

test("existing static human fields survive canonical Tibo history merging", () => {
  const signal = tiboSignal("2000000000000000071", "2026-08-01T10:00:00.000Z", {
    logical_post_id: "2000000000000000071",
    edit_history_tweet_ids: ["2000000000000000071"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const staticTruth = staticEvent({
    id: "manual-static-truth",
    title: "人手確定リセット名",
    summary: "人手確定の概要",
    opened_at: "2026-08-01T09:58:00.000Z",
    completed_at: "2026-08-01T10:02:00.000Z",
    closed_at: "2026-08-01T10:02:00.000Z",
    scope: "内部確認済み",
    source_url: `https://x.com/thsottiaux/status/${signal.tweet_id}`,
    sourceTweetIds: [signal.tweet_id],
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "内部確認済み",
      noticeToExecution: "4分",
      noticeType: "公式告知あり",
      note: "人手確定メモ",
    },
  });

  const history = combineWithIdentityContext(
    [staticTruth],
    [signal],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [signal] },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, staticTruth.id);
  assert.equal(history[0].title, staticTruth.title);
  assert.equal(history[0].summary, staticTruth.summary);
  assert.equal(history[0].completed_at, staticTruth.completed_at);
  assert.equal(history[0].closed_at, staticTruth.closed_at);
  assert.deepEqual(history[0].details, staticTruth.details);
  assert.deepEqual(history[0].sourceTweetIds, [signal.tweet_id]);
});

test("missing authoritative tail does not create a new history event", () => {
  const root = tiboSignal("2000000000000000081", "2026-08-01T11:00:00.000Z", {
    logical_post_id: "2000000000000000081",
    edit_history_tweet_ids: ["2000000000000000081", "2000000000000000082"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });

  const history = combineWithIdentityContext(
    [],
    [root],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [root] },
  );

  assert.deepEqual(history, []);
});

test("an existing history event survives a missing authoritative tail", () => {
  const root = tiboSignal("2000000000000000091", "2026-08-01T12:00:00.000Z", {
    logical_post_id: "2000000000000000091",
    edit_history_tweet_ids: ["2000000000000000091", "2000000000000000092"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const staticTruth = staticEvent({
    id: "existing-missing-tail-event",
    source_url: root.tweet_url,
    sourceTweetIds: [root.tweet_id],
  });

  const history = combineWithIdentityContext(
    [staticTruth],
    [root],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [root] },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, staticTruth.id);
});

test("a manual conflict without existing evidence creates no history event", () => {
  const root = tiboSignal("2000000000000000101", "2026-08-01T13:00:00.000Z", {
    signal_type: "reset_executed",
    classification_source: "manual",
    logical_post_id: "2000000000000000101",
    edit_history_tweet_ids: ["2000000000000000101", "2000000000000000102"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const edited = tiboSignal("2000000000000000102", "2026-08-01T13:01:00.000Z", {
    signal_type: "irrelevant",
    classification_source: "manual",
    logical_post_id: "2000000000000000101",
    edit_history_tweet_ids: ["2000000000000000101", "2000000000000000102"],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });

  const history = combineWithIdentityContext(
    [],
    [root],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [root, edited] },
  );

  assert.deepEqual(history, []);
});

test("the 25M incident conflict preserves the existing event key and does not create a new history event", () => {
  const manualRoot = tiboSignal(ROOT_TWEET_ID, "2026-08-29T20:43:34.878Z", {
    classification_source: "manual",
    logical_post_id: ROOT_TWEET_ID,
    edit_history_tweet_ids: [ROOT_TWEET_ID, EDITED_TWEET_ID],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const manualEdited = tiboSignal(EDITED_TWEET_ID, "2026-08-29T20:44:00.000Z", {
    text: "The edited version is unrelated to reset classification.",
    signal_type: "irrelevant",
    classification_source: "manual",
    logical_post_id: ROOT_TWEET_ID,
    edit_history_tweet_ids: [ROOT_TWEET_ID, EDITED_TWEET_ID],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });
  const original = staticEvent();

  const history = combineWithIdentityContext(
    [original],
    [manualRoot],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [manualEdited, manualRoot] },
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, original.id);
  assert.equal(history[0].title, original.title);
  assert.deepEqual(history[0].sourceTweetIds, [ROOT_TWEET_ID, EDITED_TWEET_ID]);
  assert.equal(history[0].details?.noticeType, "公式告知あり");
});

test("historical boundary remains available when a later edit is irrelevant", () => {
  const root = tiboSignal(ROOT_TWEET_ID, "2026-08-29T20:43:34.878Z", {
    classification_source: "manual",
    logical_post_id: ROOT_TWEET_ID,
    edit_history_tweet_ids: [ROOT_TWEET_ID, EDITED_TWEET_ID],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const edited = tiboSignal(EDITED_TWEET_ID, "2026-08-29T20:44:00.000Z", {
    signal_type: "irrelevant",
    classification_source: "manual",
    logical_post_id: ROOT_TWEET_ID,
    edit_history_tweet_ids: [ROOT_TWEET_ID, EDITED_TWEET_ID],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });
  const original = staticEvent();
  const history = combineWithIdentityContext(
    [original],
    [root],
    [],
    [],
    [],
    [],
    [],
    [],
    {
      rawTiboSignals: [root, edited],
      dynamicEvents: [original],
    },
  );
  assert.equal(history.some((item) => item.id === original.id), true);
});

test("canonical history identity does not mutate raw inputs", () => {
  const root = tiboSignal("2000000000000000021", "2026-08-01T04:00:00.000Z", {
    logical_post_id: "2000000000000000021",
    edit_history_tweet_ids: ["2000000000000000021", "2000000000000000022"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const edited = tiboSignal("2000000000000000022", "2026-08-01T04:01:00.000Z", {
    logical_post_id: "2000000000000000021",
    edit_history_tweet_ids: ["2000000000000000021", "2000000000000000022"],
    edit_version: 2,
    edit_metadata_source: "x_api",
  });
  const before = structuredClone([root, edited]);
  combineWithIdentityContext(
    [],
    [root, edited],
    [],
    [],
    [],
    [],
    [],
    [],
    { rawTiboSignals: [root, edited] },
  );
  assert.deepEqual([root, edited], before);
});
