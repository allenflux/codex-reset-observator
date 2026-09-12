import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import { getLocalProbabilityCalculation } from "../lib/radar/probability";
import type { ActiveTiboSignal } from "../lib/radar/types";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  readTiboHistorySignals,
  splitTiboHistorySignals,
  TIBO_HISTORY_MAX_ROWS,
  TIBO_HISTORY_SELECT_FIELDS,
} from "../lib/radarFetch";
import {
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import type { TiboSecondarySignal } from "../lib/radar/tiboSecondarySignal";

const REMOVED_HISTORY_FIELDS = [
  "ai_classification_status",
  "ai_reset_type_ja",
  "ai_notice_to_execution",
  "ai_teaser_strength_confidence",
  "ai_teaser_strength_evidence_quote",
  "ai_teaser_strength_reason_ja",
  "is_quote",
  "source_timeline",
  "quote_context_text",
  "quote_tweet_url",
  "quote_author_handle",
] as const;

const REQUIRED_HISTORY_FIELDS = [
  "tweet_id",
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "signal_type",
  "confidence",
  "classification_reason",
  "classification_source",
  "rule_signal_type",
  "ai_signal_type",
  "teaser_strength",
  "secondary_signal",
  "ai_teaser_strength",
  "ai_temporal_expression",
  "ai_temporal_kind",
  "ai_temporal_precision",
  "ai_temporal_timezone",
  "ai_temporal_confidence",
  "temporal_expression",
  "temporal_kind",
  "temporal_precision",
  "temporal_timezone",
  "temporal_confidence",
  "temporal_resolution_source",
  "expected_start_at",
  "expected_end_at",
  "temporal_resolution_status",
  "temporal_resolution_version",
  "translated_text_ja",
  "translated_text_zh",
  "is_reply",
  "reply_to_handles",
  "reply_context_text",
  "verification_status",
  "logical_post_id",
  "edit_history_tweet_ids",
  "edit_version",
  "edit_metadata_source",
] as const;

const NOW = new Date("2026-09-11T00:00:00.000Z");

function resetRow(
  tweetId: string,
  signalType: FormalTiboResetSignal["signal_type"],
  overrides: Partial<FormalTiboResetSignal> = {},
): FormalTiboResetSignal {
  return {
    tweet_id: tweetId,
    text: signalType === "official_notice"
      ? "A usage limit reset is scheduled for all paid users."
      : signalType === "irrelevant"
        ? "The banked reset credit was distributed to everyone."
        : "All paid users received a reset of their usage limits.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: "2026-09-10T12:00:00.000Z",
    detected_at: "2026-09-10T12:01:00.000Z",
    expires_at: "2026-09-12T12:01:00.000Z",
    signal_type: signalType,
    confidence: signalType === "irrelevant" ? 0.99 : 1,
    classification_reason: "fixture classification",
    classification_source: signalType === "irrelevant" ? "manual" : "gemini",
    rule_signal_type: signalType,
    ai_signal_type: signalType,
    ai_classification_status: "success",
    ai_reset_type_ja: "ランダムリセット",
    ai_notice_to_execution: "within one hour",
    teaser_strength: signalType === "teaser" ? "weak" : null,
    secondary_signal: null,
    ai_teaser_strength: signalType === "teaser" ? "weak" : null,
    ai_teaser_strength_confidence: 0.81,
    ai_teaser_strength_evidence_quote: "fixture evidence",
    ai_teaser_strength_reason_ja: "fixture teaser reason",
    ai_temporal_expression: "tomorrow",
    ai_temporal_kind: "relative_day",
    ai_temporal_precision: "day",
    ai_temporal_timezone: "UTC",
    ai_temporal_confidence: 0.9,
    temporal_expression: "tomorrow",
    temporal_kind: "relative_day",
    temporal_precision: "day",
    temporal_timezone: "UTC",
    temporal_confidence: 0.9,
    temporal_resolution_source: "gemini",
    expected_start_at: "2026-09-11T00:00:00.000Z",
    expected_end_at: "2026-09-11T23:59:59.000Z",
    temporal_resolution_status: "resolved",
    temporal_resolution_version: "v1",
    translated_text_ja: "利用上限がリセットされました。",
    translated_text_zh: "使用限额已重置。",
    is_reply: false,
    is_quote: true,
    reply_to_handles: ["@thsottiaux"],
    reply_context_text: "parent context",
    source_timeline: "with_replies",
    quote_context_text: "quoted context",
    quote_tweet_url: "https://x.com/example/status/123",
    quote_author_handle: "@example",
    verification_status: signalType === "irrelevant" ? "rejected" : "confirmed",
    logical_post_id: null,
    edit_history_tweet_ids: null,
    edit_version: null,
    edit_metadata_source: null,
    ...overrides,
  };
}

function projectRows(
  rows: readonly FormalTiboResetSignal[],
  fields: string,
) {
  const selected = new Set(fields.split(","));
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([field]) => selected.has(field)),
  ) as unknown as FormalTiboResetSignal);
}

function makeSemanticFixture() {
  const editRoot = resetRow("9000000000000000001", "reset_executed", {
    text: "All paid users received a reset of their usage limits.",
    logical_post_id: "9000000000000000001",
    edit_history_tweet_ids: ["9000000000000000001", "9000000000000000002"],
    edit_version: 1,
    edit_metadata_source: "x_api",
  });
  const editLatest = resetRow("9000000000000000002", "reset_executed", {
    text: "All paid users received a reset of their usage limits today.",
    logical_post_id: "9000000000000000001",
    edit_history_tweet_ids: ["9000000000000000001", "9000000000000000002"],
    edit_version: 2,
    edit_metadata_source: "x_api",
    secondary_signal: {
      signalType: "teaser",
      teaserStrength: "strong",
      confidence: 0.92,
      evidenceQuote: "today",
      reasonJa: "future reset reference",
      temporal: {
        status: "resolved",
        version: "v1",
        temporalExpression: "tomorrow",
        temporalKind: "relative_day",
        temporalPrecision: "day",
        timezone: "UTC",
        confidence: 0.9,
        expectedStartAt: "2026-09-12T00:00:00.000Z",
        expectedEndAt: "2026-09-12T23:59:59.000Z",
        resolutionSource: "gemini",
      },
    } satisfies TiboSecondarySignal,
  });
  const notice = resetRow("9000000000000000003", "official_notice", {
    text: "The usage limit reset is scheduled for all paid users tomorrow.",
    confidence: 0.99,
    ai_temporal_precision: "day",
    temporal_precision: "day",
    verification_status: "confirmed",
  });
  const reply = resetRow("9000000000000000004", "teaser", {
    text: "Maybe tomorrow 👀",
    is_reply: true,
    verification_status: "auto_unverified",
  });
  const rejected = resetRow("9000000000000000005", "reset_executed", {
    text: "All users received a reset, but this report was rejected.",
    classification_source: "manual",
    verification_status: "rejected",
  });
  const banked = resetRow("9000000000000000006", "irrelevant", {
    text: "The banked reset credit was distributed to everyone.",
    verification_status: "confirmed",
  });
  return [editRoot, editLatest, notice, reply, rejected, banked];
}

function buildComparableRadarData(rows: readonly FormalTiboResetSignal[]) {
  const formal = rows.filter(isFormalTiboResetSignal);
  const rejected = rows
    .filter((row) => row.signal_type === "reset_executed" && row.verification_status === "rejected")
    .map(({ tweet_id, tweet_url, tweet_created_at }) => ({ tweet_id, tweet_url, tweet_created_at }));
  const active = rows.map((row) => ({
    ...row,
    confidence: row.confidence ?? undefined,
    classification_reason: row.classification_reason ?? undefined,
    detected_at: row.detected_at ?? undefined,
    expires_at: row.expires_at ?? undefined,
    is_reply: row.is_reply ?? undefined,
    is_quote: row.is_quote ?? undefined,
  })) satisfies ActiveTiboSignal[];
  return getLocalRadarData({
    checkedAt: NOW.toISOString(),
    calculationNow: NOW,
    recentTiboSignals: active,
    formalTiboResets: formal,
    rejectedTiboResets: rejected,
  });
}

test("history projection excludes only audited source metadata and keeps semantic columns", () => {
  const fields = new Set(TIBO_HISTORY_SELECT_FIELDS.split(","));
  for (const field of REMOVED_HISTORY_FIELDS) assert.equal(fields.has(field), false, field);
  for (const field of REQUIRED_HISTORY_FIELDS) assert.equal(fields.has(field), true, field);
  assert.equal(fields.size, REQUIRED_HISTORY_FIELDS.length);
});

test("history read keeps one query below 1000 rows and locally derives replies", async () => {
  const rows = [
    resetRow("1", "teaser", { is_reply: true }),
    resetRow("2", "reset_executed"),
    resetRow("3", "official_notice", { is_reply: null }),
  ];
  const calls: Array<{ fields: string; includeReplies: boolean }> = [];
  const result = await readTiboHistorySignals(async (fields, includeReplies) => {
    calls.push({ fields, includeReplies });
    return { data: rows, error: null };
  }, { state: "ok" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fields, TIBO_HISTORY_SELECT_FIELDS);
  assert.equal(calls[0].includeReplies, true);
  assert.deepEqual(result.withReplies.data, rows);
  assert.deepEqual(result.withoutReplies.data.map((row) => row.tweet_id), ["2", "3"]);
});

test("history read keeps the exactly-1000 formal fallback and reply-heavy completeness", async () => {
  const unifiedRows = Array.from({ length: TIBO_HISTORY_MAX_ROWS }, (_, index) =>
    resetRow(String(index + 1), index < 900 ? "teaser" : "reset_executed", { is_reply: index < 900 }));
  const formalRows = [resetRow("older-formal", "reset_executed")];
  const calls: Array<{ fields: string; includeReplies: boolean }> = [];
  const result = await readTiboHistorySignals(async (fields, includeReplies) => {
    calls.push({ fields, includeReplies });
    return { data: includeReplies ? unifiedRows : formalRows, error: null };
  }, { state: "ok" });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.fields, call.includeReplies]), [
    [TIBO_HISTORY_SELECT_FIELDS, true],
    [TIBO_HISTORY_SELECT_FIELDS, false],
  ]);
  assert.equal(result.withReplies.data.length, TIBO_HISTORY_MAX_ROWS);
  assert.deepEqual(result.withoutReplies.data.map((row) => row.tweet_id), ["older-formal"]);
});

test("removed history metadata does not change formal/rejected/edit/secondary/temporal/BANKED consumers or public output", () => {
  const fullRows = makeSemanticFixture();
  const reducedRows = projectRows(fullRows, TIBO_HISTORY_SELECT_FIELDS);
  const fullSplit = splitTiboHistorySignals(fullRows);
  const reducedSplit = splitTiboHistorySignals(reducedRows);

  assert.deepEqual(
    fullSplit.withReplies.map((row) => [row.tweet_id, row.is_reply]),
    reducedSplit.withReplies.map((row) => [row.tweet_id, row.is_reply]),
  );
  assert.deepEqual(
    fullSplit.withoutReplies.filter(isFormalTiboResetSignal).map((row) => row.tweet_id),
    reducedSplit.withoutReplies.filter(isFormalTiboResetSignal).map((row) => row.tweet_id),
  );
  assert.deepEqual(
    fullSplit.withoutReplies
      .filter((row) => row.signal_type === "reset_executed" && row.verification_status === "rejected")
      .map((row) => row.tweet_id),
    reducedSplit.withoutReplies
      .filter((row) => row.signal_type === "reset_executed" && row.verification_status === "rejected")
      .map((row) => row.tweet_id),
  );

  const fullData = buildComparableRadarData(fullRows);
  const reducedData = buildComparableRadarData(reducedRows);
  for (const locale of ["ja", "en", "zh"] as const) {
    for (const limitHistory of [true, false]) {
      const fullSnapshot = toPublicRadarSnapshot(fullData, locale, {
        calculationNow: NOW,
        limitHistory,
      });
      const reducedSnapshot = toPublicRadarSnapshot(reducedData, locale, {
        calculationNow: NOW,
        limitHistory,
      });
      assert.equal(JSON.stringify(reducedSnapshot), JSON.stringify(fullSnapshot), `${locale}:${limitHistory}`);
    }
  }

  const fullProbability = getLocalProbabilityCalculation(fullData, { now: NOW });
  const reducedProbability = getLocalProbabilityCalculation(reducedData, { now: NOW });
  assert.equal(JSON.stringify(reducedProbability), JSON.stringify(fullProbability));
});
