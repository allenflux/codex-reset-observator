import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_OBSERVATION_SIGNALS } from "../data/observationSignals";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  getHistoryRecordKind,
  getHistorySourceKind,
  getLocalRadarData,
  getRadarViewModel,
} from "../lib/radar";
import { isNewFormalAdoption } from "../lib/radar/formalAdoption";
import {
  getLastGlobalResetAt,
  getRecent7DayResetCount,
} from "../lib/radar/probability";
import {
  combineResetHistory,
  convertTiboResetSignalToHistoryEvent,
  findRelatedTiboNotices,
  findRelatedTiboNotice,
  isFormalTiboResetSignal,
  selectRepresentativeTiboNotice,
  type FormalTiboResetSignal,
  type TiboNoticeSignal,
} from "../lib/radar/tiboHistory";
import type { HistoryRecordKind, WindowEventLike } from "../lib/radar/types";
import {
  TARGET_TIBO_TWEET_CREATED_AT,
  TARGET_TIBO_TWEET_ID,
  TARGET_TIBO_TWEET_TEXT,
  TARGET_TIBO_TWEET_URL,
} from "./fixtures/tiboLongFormReset";

function resetSignal(overrides: Partial<FormalTiboResetSignal> = {}): FormalTiboResetSignal {
  return {
    tweet_id: "2083395449814229287",
    text: "I have reset usage limits for Codex and ChatGPT Work.",
    tweet_url: "https://x.com/thsottiaux/status/2083395449814229287",
    tweet_created_at: "2026-08-01T09:00:00.000Z",
    detected_at: "2026-08-01T09:01:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    ai_classification_status: "success",
    ai_reset_type_ja: "ご祝儀リセット",
    ai_notice_to_execution: null,
    expires_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function regularForecastEvent(
  id: string,
  completedAt: string,
  options: {
    recordKind?: HistoryRecordKind;
    cycleType: "定期リセット" | "ランダムリセット";
    resetMethod: "強制リセット" | "任意リセット権配布";
    scope?: string;
    status?: string;
  },
): WindowEventLike {
  const scope = options.scope ?? "全有料プラン";
  return {
    id,
    recordKind: options.recordKind ?? "confirmed_global",
    title: options.cycleType,
    kind: "reset_completed",
    status: options.status ?? "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope,
    details: {
      cycleType: options.cycleType,
      reasonType: options.cycleType === "定期リセット" ? "定期更新" : "詫びリセット",
      resetMethod: options.resetMethod,
      scope,
      noticeToExecution: "0分",
    },
  };
}

function withLocalHistory<T>(history: WindowEventLike[], callback: () => T) {
  const original = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...history);
  try {
    return callback();
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...original);
  }
}

function noticeSignal(overrides: Partial<TiboNoticeSignal> = {}): TiboNoticeSignal {
  return {
    tweet_id: "notice-1",
    text: "A reset is coming soon.",
    tweet_url: "https://x.com/thsottiaux/status/notice-1",
    tweet_created_at: "2026-08-01T07:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.96,
    verification_status: "auto_unverified",
    ...overrides,
  };
}

test("Gemini reset_executed is eligible for formal history", () => {
  assert.equal(isFormalTiboResetSignal(resetSignal()), true);
});

test("non-reset activation completions cannot enter formal history", () => {
  assert.equal(
    isFormalTiboResetSignal(
      resetSignal({
        text: "The new Codex feature is now live for everyone.",
      }),
    ),
    false,
  );
});

test("reply reset signals remain stored but are excluded from formal reset history", () => {
  const combined = combineResetHistory([], [resetSignal({ is_reply: true })]);
  assert.deepEqual(combined, []);
  assert.equal(isFormalTiboResetSignal(resetSignal({ is_reply: true })), false);
});

test("rule_fallback reset_executed is eligible for formal history", () => {
  assert.equal(
    isFormalTiboResetSignal(
      resetSignal({ classification_source: "rule_fallback", ai_classification_status: "rate_limited" }),
    ),
    true,
  );
});

test("rule reset_executed is eligible for formal history", () => {
  assert.equal(
    isFormalTiboResetSignal(resetSignal({ classification_source: "rule" })),
    true,
  );
});

test("shadow reset_executed is eligible for formal history", () => {
  assert.equal(
    isFormalTiboResetSignal(resetSignal({ classification_source: "shadow" })),
    true,
  );
});

test("reset_executed below the confidence threshold is excluded", () => {
  assert.equal(
    isFormalTiboResetSignal(resetSignal({ classification_source: "rule", confidence: 0.94 })),
    false,
  );
});

test("teaser and irrelevant signals are excluded from formal history", () => {
  assert.equal(isFormalTiboResetSignal(resetSignal({ signal_type: "teaser" })), false);
  assert.equal(isFormalTiboResetSignal(resetSignal({ signal_type: "irrelevant" })), false);
});

test("rejected reset_executed is excluded while confirmed reset_executed is accepted", () => {
  assert.equal(
    isFormalTiboResetSignal(
      resetSignal({ classification_source: "rule", verification_status: "rejected" }),
    ),
    false,
  );
  assert.equal(
    isFormalTiboResetSignal(
      resetSignal({ verification_status: "confirmed", classification_source: "rule" }),
    ),
    true,
  );
});

test("formal adoption ignores expires_at", () => {
  const signal = resetSignal({ expires_at: "2026-07-01T00:00:00.000Z" });
  assert.equal(isFormalTiboResetSignal(signal), true);
  assert.equal(convertTiboResetSignalToHistoryEvent(signal).id, `tibo-reset-${signal.tweet_id}`);
});

test("official notice is preferred over a teaser and only a prior post is linked", () => {
  const reset = resetSignal();
  const related = findRelatedTiboNotice(reset, [
    noticeSignal({ tweet_id: "teaser-1", signal_type: "teaser", tweet_created_at: "2026-08-01T08:00:00.000Z" }),
    noticeSignal({ tweet_id: "notice-2", tweet_created_at: "2026-08-01T07:30:00.000Z" }),
    noticeSignal({ tweet_id: "future", tweet_created_at: "2026-08-01T09:30:00.000Z" }),
  ]);

  assert.equal(related?.tweet_id, "notice-2");
  assert.equal(findRelatedTiboNotice(reset, [noticeSignal({ tweet_created_at: "2026-07-29T00:00:00.000Z" })]), null);
});

test("history separates the first announcement from the most specific representative notice", () => {
  const reset = resetSignal({
    tweet_created_at: "2026-08-01T09:00:00.000Z",
  });
  const first = noticeSignal({
    tweet_id: "notice-first",
    text: "During the day we will reset usage limits for all paid users.",
    tweet_created_at: "2026-08-01T07:00:00.000Z",
    ai_temporal_precision: "daypart",
    temporal_resolution_status: "resolved",
    expected_start_at: "2026-08-01T06:00:00.000Z",
    expected_end_at: "2026-08-02T06:00:00.000Z",
  });
  const deadline = noticeSignal({
    tweet_id: "notice-deadline",
    text: "The reset will be there by 8pm PST for all paid users.",
    tweet_created_at: "2026-08-01T08:00:00.000Z",
    ai_temporal_precision: "exact_time",
    temporal_resolution_status: "resolved",
    expected_start_at: "2026-08-01T08:00:00.000Z",
    expected_end_at: "2026-08-01T12:00:00.000Z",
  });
  const lowInformation = noticeSignal({
    tweet_id: "notice-low-information",
    text: "Yep, still coming!",
    tweet_created_at: "2026-08-01T08:30:00.000Z",
  });

  const related = findRelatedTiboNotices(reset, [first, deadline, lowInformation]);
  const representative = selectRepresentativeTiboNotice(related);
  const event = convertTiboResetSignalToHistoryEvent(
    reset,
    representative,
    undefined,
    related,
  );

  assert.deepEqual(related.map((notice) => notice.tweet_id), [
    "notice-first",
    "notice-deadline",
    "notice-low-information",
  ]);
  assert.equal(representative?.tweet_id, "notice-deadline");
  assert.equal(event.opened_at, first.tweet_created_at);
  assert.equal(event.details?.noticeToExecution, "2時間");
  assert.equal(event.officialNoticeTweetId, "notice-deadline");
  assert.equal(event.source_url, deadline.tweet_url);
  assert.deepEqual(event.sourceTweetIds, [
    "notice-first",
    "notice-deadline",
    "notice-low-information",
    reset.tweet_id,
  ]);
});

test("a narrower explicit range can outrank a broader deadline without changing the first announcement", () => {
  const deadline = noticeSignal({
    tweet_id: "notice-deadline",
    text: "The reset will be there by 8pm PST for all paid users.",
    tweet_created_at: "2026-08-01T08:00:00.000Z",
    ai_temporal_precision: "exact_time",
    temporal_resolution_status: "resolved",
    expected_start_at: "2026-08-01T08:00:00.000Z",
    expected_end_at: "2026-08-01T12:00:00.000Z",
  });
  const narrowRange = noticeSignal({
    tweet_id: "notice-narrow-range",
    text: "The reset will happen between 6pm and 7pm PST.",
    tweet_created_at: "2026-08-01T08:30:00.000Z",
    ai_temporal_precision: "range",
    temporal_resolution_status: "resolved",
    expected_start_at: "2026-08-01T10:00:00.000Z",
    expected_end_at: "2026-08-01T11:00:00.000Z",
  });

  assert.equal(
    selectRepresentativeTiboNotice([deadline, narrowRange])?.tweet_id,
    "notice-narrow-range",
  );
});

test("the 2026-08-11 duplicate completion posts become one canonical event", () => {
  const notice = noticeSignal({
    tweet_id: "2086189414292865249",
    text: "I'll do another performative reset on Monday",
    tweet_created_at: "2026-08-08T20:34:50.000Z",
    temporal_resolution_status: "resolved",
    ai_temporal_precision: "day",
    expected_start_at: "2026-08-10T07:00:00.000Z",
    expected_end_at: "2026-08-11T07:00:00.000Z",
  });
  const first = resetSignal({
    tweet_id: "2086972802457063486",
    text: "Hi.\n\nIt is done.",
    tweet_url: "https://x.com/thsottiaux/status/2086972802457063486",
    tweet_created_at: "2026-08-11T00:27:44.000Z",
    confidence: 0.95,
    rule_signal_type: "irrelevant",
    ai_signal_type: "reset_executed",
    related_notice: notice,
  });
  const second = resetSignal({
    tweet_id: "2086972933566857393",
    text: "Usage limits have been reset for all paid ChatGPT Work and Codex users.\nHappy Monday you all.",
    tweet_url: "https://x.com/thsottiaux/status/2086972933566857393",
    tweet_created_at: "2026-08-11T00:28:16.000Z",
    confidence: 1,
    rule_signal_type: "reset_executed",
    ai_signal_type: "reset_executed",
    related_notice: notice,
  });

  const combined = combineResetHistory([], [second, first]);

  assert.equal(combined.length, 1);
  assert.equal(combined[0].completed_at, "2026-08-11T00:27:44.000Z");
  assert.equal(combined[0].source_url, notice.tweet_url);
  assert.deepEqual(combined[0].sourceTweetIds, [
    "2086189414292865249",
    "2086972802457063486",
    "2086972933566857393",
  ]);
  assert.equal(combined[0].details?.noticeToExecution, "51時間53分");
  withLocalHistory([], () => {
    assert.equal(
      getRecent7DayResetCount(
        { formal_tibo_resets: [first, second] },
        new Date("2026-08-11T01:00:00.000Z"),
      ),
      1,
    );
  });
});

test("resolved Monday notice is matched by its schedule window beyond the 48-hour fallback", () => {
  const reset = resetSignal({
    tweet_created_at: "2026-08-11T00:27:44.000Z",
  });
  const notice = noticeSignal({
    tweet_created_at: "2026-08-08T20:34:50.000Z",
    temporal_resolution_status: "resolved",
    ai_temporal_precision: "day",
    expected_start_at: "2026-08-10T07:00:00.000Z",
    expected_end_at: "2026-08-11T07:00:00.000Z",
  });

  assert.equal(findRelatedTiboNotice(reset, [notice])?.tweet_id, notice.tweet_id);
  assert.equal(
    findRelatedTiboNotice(reset, [
      {
        ...notice,
        expected_start_at: "2026-08-09T07:00:00.000Z",
        expected_end_at: "2026-08-10T07:00:00.000Z",
      },
    ]),
    null,
  );
  assert.equal(
    findRelatedTiboNotice(reset, [
      noticeSignal({ tweet_created_at: "2026-08-10T20:00:00.000Z" }),
    ])?.tweet_created_at,
    "2026-08-10T20:00:00.000Z",
  );
});

test("formal resets more than five minutes apart remain separate", () => {
  const first = resetSignal({
    tweet_id: "reset-before",
    tweet_url: "https://x.com/thsottiaux/status/reset-before",
    tweet_created_at: "2026-08-11T00:27:44.000Z",
  });
  const second = resetSignal({
    tweet_id: "reset-after",
    tweet_url: "https://x.com/thsottiaux/status/reset-after",
    tweet_created_at: "2026-08-11T00:33:00.000Z",
  });

  assert.equal(combineResetHistory([], [first, second]).length, 2);
});

test("rejected and irrelevant posts cannot enter a formal reset cluster", () => {
  const valid = resetSignal({ tweet_id: "valid-reset" });
  const rejected = resetSignal({
    tweet_id: "rejected-reset",
    tweet_created_at: "2026-08-01T09:01:00.000Z",
    verification_status: "rejected",
  });
  const irrelevant = resetSignal({
    tweet_id: "irrelevant-reset",
    tweet_created_at: "2026-08-01T09:02:00.000Z",
    signal_type: "irrelevant",
  });

  const combined = combineResetHistory([], [valid, rejected, irrelevant]);
  assert.deepEqual(combined.map((item) => item.sourceTweetIds), [["valid-reset"]]);
});

test("notice-to-execution duration and notice type are stored in the converted event", () => {
  const reset = resetSignal();
  const notice = noticeSignal({ tweet_created_at: "2026-08-01T07:00:00.000Z" });
  const event = convertTiboResetSignalToHistoryEvent(reset, notice);

  assert.equal(event.opened_at, notice.tweet_created_at);
  assert.equal(event.completed_at, reset.tweet_created_at);
  assert.equal(event.window_minutes, 120);
  assert.equal(event.details?.noticeToExecution, "2時間");
  assert.equal(event.details?.noticeType, "公式予告あり");
});

test("current usage-limit announcement can provide official history provenance for the matching Monitor event", () => {
  const recovery = {
    id: "41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    observedAt: "2026-08-29T21:25:40.549Z",
    previousObservedAt: "2026-08-29T21:21:40.487Z",
    confidence: "strong" as const,
    cycleHint: "unexpected" as const,
    status: "observed" as const,
  };
  const signal = resetSignal({
    tweet_id: TARGET_TIBO_TWEET_ID,
    text: TARGET_TIBO_TWEET_TEXT,
    tweet_url: TARGET_TIBO_TWEET_URL,
    tweet_created_at: TARGET_TIBO_TWEET_CREATED_AT,
    classification_source: "rule",
  });
  const estimate = {
    resetEventKey: "usage-reset-41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    displayExecutionAt: recovery.observedAt,
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: recovery.previousObservedAt,
    executionWindowEndAt: recovery.observedAt,
    recoveryObservationId: recovery.id,
    tiboAnnouncedAt: TARGET_TIBO_TWEET_CREATED_AT,
    tiboPrimaryTweetId: TARGET_TIBO_TWEET_ID,
    tiboSourceTweetIds: [TARGET_TIBO_TWEET_ID],
    officialNoticeTweetId: TARGET_TIBO_TWEET_ID,
    officialNoticeAt: TARGET_TIBO_TWEET_CREATED_AT,
    estimatorVersion: "usage-execution-monitor-v1",
  };

  const events = combineResetHistory(
    [],
    [signal],
    [],
    [],
    [signal as any],
    [recovery],
    [estimate as any],
  );
  const event = events.find((candidate) => candidate.officialNoticeTweetId === TARGET_TIBO_TWEET_ID);

  assert.ok(event);
  assert.equal(events.filter((candidate) => candidate.recordKind === "confirmed_global").length, 1);
  assert.equal(event.id, estimate.resetEventKey);
  assert.equal(event.completed_at, recovery.observedAt);
  assert.equal(event.source_url, TARGET_TIBO_TWEET_URL);
  assert.deepEqual(event.sourceTweetIds, [TARGET_TIBO_TWEET_ID]);
  assert.equal(event.details?.noticeType, "公式告知あり");
  assert.equal(event.details?.noticeToExecution, "42分");
  assert.equal(event.details?.reasonType, "詫びリセット");
});

test("the Monitor-backed current announcement is localized from the canonical event key", () => {
  const calculationNow = new Date("2026-08-30T12:00:00.000Z");
  const recovery = {
    id: "41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    observedAt: "2026-08-29T21:25:40.549Z",
    previousObservedAt: "2026-08-29T21:21:40.487Z",
    confidence: "strong" as const,
    cycleHint: "unexpected" as const,
    status: "observed" as const,
  };
  const signal = resetSignal({
    tweet_id: TARGET_TIBO_TWEET_ID,
    text: TARGET_TIBO_TWEET_TEXT,
    tweet_url: TARGET_TIBO_TWEET_URL,
    tweet_created_at: TARGET_TIBO_TWEET_CREATED_AT,
    classification_source: "rule",
  });
  const estimate = {
    resetEventKey: "usage-reset-41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    displayExecutionAt: recovery.observedAt,
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: recovery.previousObservedAt,
    executionWindowEndAt: recovery.observedAt,
    recoveryObservationId: recovery.id,
    tiboAnnouncedAt: TARGET_TIBO_TWEET_CREATED_AT,
    tiboPrimaryTweetId: TARGET_TIBO_TWEET_ID,
    tiboSourceTweetIds: [TARGET_TIBO_TWEET_ID],
    officialNoticeTweetId: TARGET_TIBO_TWEET_ID,
    officialNoticeAt: TARGET_TIBO_TWEET_CREATED_AT,
    estimatorVersion: "usage-execution-monitor-v1",
  };
  const data = getLocalRadarData({
    calculationNow,
    formalTiboResets: [signal],
    recentTiboSignals: [signal as any],
    activeTiboSignals: [signal as any],
    codexRecoveryObservations: [recovery as any],
    resetExecutionEstimates: [estimate as any],
    resetDisplayNames: [{
      event_key: estimate.resetEventKey,
      source_tweet_id: null,
      manual_name_ja: "Codex利用制限改善対応リセット",
      ai_name_ja: null,
      ai_confidence: null,
      ai_evidence: null,
      ai_reason: null,
      ai_model: null,
      ai_prompt_version: null,
      ai_input_mode: null,
      ai_status: null,
      ai_flags: null,
      ai_generated_at: null,
      input_hash: null,
    }],
  });

  const expected = {
    ja: {
      title: "Codex利用制限改善対応リセット",
      reason: "詫びリセット",
      noticeType: "告知あり",
      noticeToExecution: "42分",
    },
    en: {
      title: "Codex Usage Limit Improvement Reset",
      reason: "Compensation reset",
      noticeType: "Announcement",
      noticeToExecution: "42 minutes",
    },
    zh: {
      title: "Codex 使用限制改进重置",
      reason: "故障补偿重置",
      noticeType: "有告知",
      noticeToExecution: "42 分钟",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const item = getRadarViewModel(data, locale, false, undefined, calculationNow).recentHistory.find(
      (historyItem) => historyItem.key === estimate.resetEventKey,
    );

    assert.ok(item, `${locale} target history item should be present`);
    assert.equal(item.title, expected[locale].title);
    assert.equal(item.details?.reasonType, expected[locale].reason);
    assert.equal(item.details?.noticeType, expected[locale].noticeType);
    assert.equal(item.details?.noticeToExecution, expected[locale].noticeToExecution);
    assert.equal(item.signalAt, TARGET_TIBO_TWEET_CREATED_AT);
    assert.equal(item.resetAt, recovery.observedAt);
    assert.equal(item.source, TARGET_TIBO_TWEET_URL);
  }
});

test("converted event uses a conservative scope and a fixed factual summary", () => {
  const event = convertTiboResetSignalToHistoryEvent(
    resetSignal({ text: "I have reset usage limits." }),
  );

  assert.equal(event.scope, "Codex / ChatGPT Work");
  assert.equal(event.title, "ランダムリセット");
  assert.equal(event.summary, "Tibo氏がCodexの利用上限リセット完了を発表しました。");
  assert.equal(event.details?.cycleType, "ランダムリセット");
  assert.equal(event.details?.reasonType, undefined);
  assert.equal(event.details?.note, "Tibo氏がCodexの利用上限リセット完了を発表しました。");
  assert.equal(event.details?.resetMethod, "強制リセット");
});

test("automatically generated Tibo history is localized without Japanese leakage", () => {
  const japaneseCharacters = /[\u3040-\u30FF]/;
  const cases = [
    { id: "celebration", reason: "ご祝儀リセット" as const, text: "Celebrating launch! I reset usage limits for Codex and ChatGPT Work." },
    { id: "compensation", reason: "詫びリセット" as const, text: "I reset usage limits after a reliability incident." },
    { id: "regular", reason: "定期更新" as const, text: "I reset usage limits on the usual weekly cycle." },
    { id: "fallback", reason: undefined, text: "I reset usage limits." },
  ] as const;

  for (const testCase of cases) {
    const signal = resetSignal({
      tweet_id: `i18n-auto-reset-${testCase.id}`,
      tweet_url: `https://x.com/thsottiaux/status/i18n-auto-reset-${testCase.id}`,
      text: testCase.text,
      ai_reset_type_ja: "ランダムリセット",
    });
    const data = getLocalRadarData({ formalTiboResets: [signal] });

    for (const locale of ["en", "zh"] as const) {
      const viewModel = getRadarViewModel(data, locale, false);
      const item = viewModel.recentHistory.find(
        (historyItem) => historyItem.key === `tibo-reset-${signal.tweet_id}`,
      );

      assert.ok(item, `${locale} Tibo history item should be present`);
      const isRegular = testCase.id === "regular";
      assert.equal(
        item.title,
        isRegular
          ? locale === "en" ? "Weekly reset" : "定期重置"
          : locale === "en" ? "Random reset" : "随机重置",
      );
      assert.equal(
        item.details?.reasonType,
        isRegular
          ? locale === "en" ? "Regular update" : "定期更新"
          : !testCase.reason
            ? ""
            : locale === "en"
            ? testCase.reason === "詫びリセット"
              ? "Compensation reset"
              : "Celebration reset"
            : testCase.reason === "詫びリセット"
              ? "故障补偿重置"
              : "庆祝重置",
      );
      assert.equal(
        item.summary,
        isRegular
          ? locale === "en"
            ? "Codex usage limits were reset on the usual weekly-cycle timing."
            : "在常规的 1 周循环时间点，执行了 Codex 使用限制重置。"
          : locale === "en"
          ? "Tibo announced that Codex usage limits were reset."
          : "Tibo 宣布 Codex 的使用限制已重置。",
      );
      assert.equal(
        item.details?.note,
        isRegular
          ? locale === "en"
            ? "A regular reset occurs one week after you first use Codex or Work following the previous reset. If you use a Banked Reset, the next weekly timing is likewise counted from your first use after that reset, so it may differ from the time shown here."
            : "定期重置会在您上次重置后首次使用 Codex 或 Work 的一周后进行。使用手动重置后也一样，会从该重置后的首次使用时间起算一周，因此实际时间可能与此处显示的时间不同。"
          : item.summary,
      );
      const visibleText = [
        item.title,
        item.summary,
        item.details?.cycleType,
        item.details?.reasonType,
        item.details?.resetMethod,
        item.details?.scope,
        item.details?.noticeToExecution,
        item.details?.noticeType,
        item.details?.note,
        viewModel.latestWindow.title,
        viewModel.latestWindow.summary,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ");

      assert.doesNotMatch(
        visibleText,
        japaneseCharacters,
        `${locale} Tibo history contains un-translated Japanese text: ${visibleText}`,
      );
    }
  }
});

test("static and dynamic history entries with the same tweet URL are merged once", () => {
  const dynamic = convertTiboResetSignalToHistoryEvent(resetSignal());
  const staticItem = {
    ...dynamic,
    id: "static-copy",
    title: "手動で詳しく記録したリセット",
    summary: "静的履歴の詳しい概要",
  };

  const combined = combineResetHistory([staticItem], [resetSignal()]);

  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, staticItem.id);
  assert.equal(combined[0].title, staticItem.title);
  assert.equal(combined[0].summary, staticItem.summary);
});

test("manual static history overrides automatic Tibo values for the same tweet", () => {
  const signal = resetSignal({
    tweet_id: "2083999999999999999",
    tweet_url: "https://x.com/thsottiaux/status/2083999999999999999",
    text: "I reset usage limits.",
  });
  const manualItem = {
    id: "manual-corrected-reset",
    title: "2026年8月1日 ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: "2026-08-01T08:00:00.000Z",
    closed_at: "2026-08-01T09:00:00.000Z",
    completed_at: "2026-08-01T09:00:00.000Z",
    window_minutes: 60,
    scope: "全有料プラン",
    summary: "手動確認済みの正確な補足です。",
    source_url: signal.tweet_url,
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "1時間",
      noticeType: "公式予告あり",
      note: "手動確認済みの正確な補足です。",
    },
  };

  const combined = combineResetHistory([manualItem], [signal]);
  const merged = combined.find((item) => item.id === manualItem.id);

  assert.ok(merged);
  assert.equal(merged.title, manualItem.title);
  assert.equal(merged.summary, manualItem.summary);
  assert.equal(merged.closed_at, manualItem.closed_at);
  assert.deepEqual(merged.details, manualItem.details);
});

test("legacy static entries sharing a profile URL remain separate history records", () => {
  const combined = combineResetHistory([
    {
      id: "legacy-reset-1",
      title: "過去のリセット1",
      kind: "reset_completed",
      status: "closed",
      closed_at: "2026-07-28T03:00:00.000Z",
      completed_at: "2026-07-28T03:00:00.000Z",
      source_url: "https://x.com/thsottiaux",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "ご祝儀リセット",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分",
        note: "過去の記録1",
      },
    },
    {
      id: "legacy-reset-2",
      title: "過去のリセット2",
      kind: "reset_completed",
      status: "closed",
      closed_at: "2026-07-29T03:00:00.000Z",
      completed_at: "2026-07-29T03:00:00.000Z",
      source_url: "https://x.com/thsottiaux",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "詫びリセット",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分",
        note: "過去の記録2",
      },
    },
  ], []);

  assert.equal(combined.length, 2);
  assert.deepEqual(
    combined.map((item) => item.id).sort(),
    ["legacy-reset-1", "legacy-reset-2"],
  );
});

test("legacy static entries sharing a tweet URL remain separate when their reset methods differ", () => {
  const combined = combineResetHistory([
    {
      id: "legacy-forced-reset",
      title: "定期リセット",
      kind: "reset_completed",
      status: "closed",
      closed_at: "2026-06-18T07:00:00.000Z",
      completed_at: "2026-06-18T07:00:00.000Z",
      source_url: "https://x.com/thsottiaux/status/2066956441173323943",
      details: {
        cycleType: "定期リセット",
        reasonType: "定期更新",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分（定期）",
        note: "定期リセット",
      },
    },
    {
      id: "legacy-manual-reset",
      title: "詫びリセット権配布",
      kind: "reset_completed",
      status: "closed",
      closed_at: "2026-06-18T07:00:00.000Z",
      completed_at: "2026-06-18T07:00:00.000Z",
      source_url: "https://x.com/thsottiaux/status/2066956441173323943",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "詫びリセット",
        resetMethod: "任意リセット権配布",
        scope: "全有料プラン",
        noticeToExecution: "0分",
        note: "任意リセット権配布",
      },
    },
  ], []);

  assert.equal(combined.length, 2);
  assert.deepEqual(
    combined.map((item) => item.id).sort(),
    ["legacy-forced-reset", "legacy-manual-reset"],
  );
});

test("formal reset updates latest reset time and regular forecast anchor", () => {
  const signal = resetSignal({
    tweet_id: "2083999999999999998",
    tweet_url: "https://x.com/thsottiaux/status/2083999999999999998",
  });
  const calculationNow = new Date("2026-08-01T10:00:00.000Z");
  const data = getLocalRadarData({ formalTiboResets: [signal], calculationNow });
  const latest = getLastGlobalResetAt(data, calculationNow);
  const viewModel = getRadarViewModel(data, "ja", false, undefined, calculationNow);

  assert.equal(latest?.toISOString(), signal.tweet_created_at);
  assert.equal(viewModel.regularResetForecast.lastCompletedAt, signal.tweet_created_at);
  assert.equal(
    viewModel.regularResetForecast.expectedAt,
    new Date(new Date(signal.tweet_created_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
});

test("regular forecast accepts broad forced or regular records, including reference banked resets", () => {
  const calculationNow = new Date("2026-08-08T00:00:00.000Z");

  withLocalHistory(
    [
      regularForecastEvent("random-forced", "2026-08-01T00:00:00.000Z", {
        cycleType: "ランダムリセット",
        resetMethod: "強制リセット",
      }),
      regularForecastEvent("regular-reference-banked", "2026-08-02T00:00:00.000Z", {
        recordKind: "reference",
        cycleType: "定期リセット",
        resetMethod: "任意リセット権配布",
      }),
      regularForecastEvent("random-banked", "2026-08-07T00:00:00.000Z", {
        cycleType: "ランダムリセット",
        resetMethod: "任意リセット権配布",
      }),
      regularForecastEvent("regular-narrow", "2026-08-07T12:00:00.000Z", {
        cycleType: "定期リセット",
        resetMethod: "強制リセット",
        scope: "不具合対象ユーザー（約50万人）",
      }),
      regularForecastEvent("regular-pending", "2026-08-07T18:00:00.000Z", {
        cycleType: "定期リセット",
        resetMethod: "強制リセット",
        status: "pending",
      }),
      regularForecastEvent("regular-rejected", "2026-08-07T20:00:00.000Z", {
        cycleType: "定期リセット",
        resetMethod: "強制リセット",
        status: "rejected",
      }),
    ],
    () => {
      const forecast = getRadarViewModel(
        getLocalRadarData({ calculationNow }),
        "ja",
        false,
        undefined,
        calculationNow,
      ).regularResetForecast;

      assert.equal(forecast.lastCompletedAt, "2026-08-02T00:00:00.000Z");
      assert.equal(forecast.expectedAt, "2026-08-09T00:00:00.000Z");
    },
  );
});

test("regular forecast advances after the unconfirmed occurrence reaches its expected date", () => {
  const calculationNow = new Date("2026-07-22T00:00:00.000Z");

  withLocalHistory(
    [
      regularForecastEvent("regular-forced", "2026-07-01T00:00:00.000Z", {
        cycleType: "定期リセット",
        resetMethod: "強制リセット",
      }),
    ],
    () => {
      const forecast = getRadarViewModel(
        getLocalRadarData({ calculationNow }),
        "ja",
        false,
        undefined,
        calculationNow,
      ).regularResetForecast;

      assert.equal(forecast.expectedAt, "2026-07-29T00:00:00.000Z");
      assert.equal(forecast.isNoticeWindow, false);
    },
  );
});

test("formal reset contributes to the recent seven-day reset count", () => {
  const withoutDynamic = getRecent7DayResetCount(getLocalRadarData({ formalTiboResets: [] }));
  const withDynamic = getRecent7DayResetCount(
    getLocalRadarData({
      formalTiboResets: [
        resetSignal({
          tweet_id: "unique-recent-reset",
          tweet_url: "https://x.com/thsottiaux/status/unique-recent-reset",
          tweet_created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      ],
    }),
  );

  assert.equal(withDynamic, withoutDynamic + 1);
});

test("formal reset remains in history after its signal expiry", () => {
  const data = getLocalRadarData({
    formalTiboResets: [resetSignal({ expires_at: "2026-07-01T00:00:00.000Z" })],
  });
  const history = getRadarViewModel(data, "ja", false).recentHistory;

  assert.equal(history.some((item) => item.key === "tibo-reset-2083395449814229287"), true);
});

test("rejected dynamic reset allows the latest reset to fall back to static history", () => {
  const futureReset = resetSignal({
    tweet_id: "2098000000000000000",
    tweet_created_at: "2026-09-15T09:00:00.000Z",
  });
  const acceptedData = getLocalRadarData({ formalTiboResets: [futureReset] });
  const rejectedData = getLocalRadarData({
    formalTiboResets: [],
    rejectedTiboResets: [futureReset],
  });

  const testNow = new Date("2026-09-16T00:00:00.000Z");
  const acceptedLatest = getLastGlobalResetAt(acceptedData, testNow)?.getTime() ?? 0;
  const rejectedLatest = getLastGlobalResetAt(rejectedData, testNow)?.getTime() ?? 0;

  assert.ok(acceptedLatest > rejectedLatest);
  assert.notEqual(rejectedLatest, new Date(futureReset.tweet_created_at).getTime());
});

test("the static 2026-08-01 Luna record preserves the teaser provenance and execution time", () => {
  const record = LOCAL_RESET_HISTORY.find((item) => item.id === "local-luna-100k-threads-efficiency-reset-2026-08-01");
  assert.ok(record);
  assert.equal(record.opened_at, "2026-07-31T04:53:19.170Z");
  assert.equal(record.closed_at, "2026-08-01T12:32:00+09:00");
  assert.equal(record.completed_at, "2026-08-01T12:32:00+09:00");
  assert.equal(record.window_minutes, 1359);
  assert.equal(record.details?.noticeToExecution, "22時間39分");
  assert.equal(record.details?.noticeType, "匂わせ投稿あり");
  assert.equal(record.source_url, "https://x.com/thsottiaux/status/2083053369351090254");
  assert.deepEqual(record.sourceTweetIds, [
    "2083053369351090254",
    "2083395449814229287",
  ]);

  const observation = LOCAL_OBSERVATION_SIGNALS.find(
    (signal) => signal.id === "official-tibo-signs-resets-teaser-2026-07-31",
  );
  assert.ok(observation);
  assert.equal(observation.observedAt, "2026-07-31T04:53:19.170Z");
  assert.equal(observation.resolvedAt, "2026-08-01T03:32:00.000Z");
  assert.equal(observation.source, "https://x.com/thsottiaux/status/2083053369351090254");

  const timestampDeltaMinutes = Math.round(
    (Date.parse(record.closed_at) - Date.parse(record.opened_at)) / (60 * 1000),
  );
  assert.equal(timestampDeltaMinutes, 1359);

  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const expectedSignalLabels = {
    ja: "告知",
    en: "Announcement",
    zh: "告知",
  } as const;
  const expectedResetLabels = {
    ja: "実施",
    en: "Reset",
    zh: "执行",
  } as const;
  const recordId = record.id;

  for (const locale of ["ja", "en", "zh"] as const) {
    const viewModel = getRadarViewModel(
      getLocalRadarData({ calculationNow }),
      locale,
      false,
      undefined,
      calculationNow,
    );
    const item = viewModel.recentHistory.find((historyItem) => historyItem.key === recordId);

    assert.ok(item, `${locale} Luna history item should be present`);
    assert.equal(item.signalAt, record.opened_at);
    assert.equal(item.signalLabel, expectedSignalLabels[locale]);
    assert.equal(item.resetAt, new Date(record.closed_at).toISOString());
    assert.equal(item.resetLabel, expectedResetLabels[locale]);
  }
});

test("Luna provenance blocks formal adoption for its related execution tweet", () => {
  const record = LOCAL_RESET_HISTORY.find((item) => item.id === "local-luna-100k-threads-efficiency-reset-2026-08-01");
  assert.ok(record);
  assert.equal(record.source_url, "https://x.com/thsottiaux/status/2083053369351090254");
  assert.equal(record.sourceTweetIds?.includes("2083395449814229287"), true);

  const relatedExecution = resetSignal({
    tweet_id: "2083395449814229287",
    tweet_url: "https://x.com/thsottiaux/status/2083395449814229287",
  });
  assert.equal(isNewFormalAdoption(relatedExecution, null, true), false);

  const unrelatedTweet = resetSignal({
    tweet_id: "2083395449814229999",
    tweet_url: "https://x.com/thsottiaux/status/2083395449814229999",
  });
  assert.equal(isNewFormalAdoption(unrelatedTweet, null, true), true);
});

test("weekly reference dates remain visible in history without becoming latest random resets", () => {
  const calculationNow = new Date("2026-08-04T03:32:00.000Z");
  const viewModel = getRadarViewModel(
    getLocalRadarData({ calculationNow }),
    "ja",
    false,
    undefined,
    calculationNow,
  );

  assert.equal(viewModel.regularResetForecast.expectedAt, "2026-08-08T03:32:00.000Z");
  assert.equal(viewModel.recentHistory.some((item) => item.recordKind === "reference"), true);
  assert.equal(viewModel.recentHistory.some((item) => item.key.startsWith("regular-reset-")), false);
  assert.notEqual(viewModel.latestWindow.title, "定期リセット");
  assert.equal(viewModel.latestWindow.recordKind, "confirmed_global");
});

test("history records distinguish confirmed resets, banked distributions, and source kinds", () => {
  const reference25 = LOCAL_RESET_HISTORY.find((item) => item.id === "local-codex-regular-reset-2026-06-25");
  const reference07 = LOCAL_RESET_HISTORY.find((item) => item.id === "local-codex-regular-reset-2026-07-07");
  const reference18 = LOCAL_RESET_HISTORY.find((item) => item.id === "local-codex-rate-limit-reset-notice-2026-06-17");
  const banked18 = LOCAL_RESET_HISTORY.find((item) => item.id === "personal-compensation-reset-credit-2026-06-18");
  const banked12 = LOCAL_RESET_HISTORY.find((item) => item.id === "personal-reset-credit-2026-06-11");
  const confirmed = LOCAL_RESET_HISTORY.find((item) => item.id === "local-codex-forced-reset-2026-06-30");

  assert.equal(
    LOCAL_RESET_HISTORY.every((item) =>
      item.recordKind === "confirmed_global" ||
      item.recordKind === "banked_distribution" ||
      item.recordKind === "reference",
    ),
    true,
  );
  assert.equal(reference25 ? getHistoryRecordKind(reference25) : null, "reference");
  assert.equal(reference07 ? getHistoryRecordKind(reference07) : null, "reference");
  assert.equal(reference18 ? getHistoryRecordKind(reference18) : null, "reference");
  for (const record of [reference25, reference07, reference18]) {
    assert.equal(record?.title, "定期リセット");
    assert.equal(record?.details?.cycleType, "定期リセット");
    assert.equal(record?.details?.reasonType, "定期更新");
    assert.equal(record?.details?.resetMethod, "強制リセット");
  }
  assert.equal(reference18?.details?.scope, "全有料プラン");
  assert.equal(banked18 ? getHistoryRecordKind(banked18) : null, "banked_distribution");
  assert.equal(banked12 ? getHistoryRecordKind(banked12) : null, "banked_distribution");
  assert.equal(confirmed ? getHistoryRecordKind(confirmed) : null, "confirmed_global");
  assert.equal(getHistoryRecordKind({ title: "Unclassified event" }), "reference");
  assert.equal(banked12?.details?.cycleType, "定期リセット");
  assert.equal(banked12?.details?.reasonType, "定期更新");
  assert.equal(banked12?.details?.resetMethod, "任意リセット権配布");
  assert.equal(getHistorySourceKind({ source_url: "https://x.com/thsottiaux/status/123" }), "direct_post");
  assert.equal(getHistorySourceKind({ source_url: "https://x.com/thsottiaux" }), "profile");
  assert.equal(getHistorySourceKind({ source_url: "https://status.openai.com/incidents/123" }), "official_status");
  assert.equal(getHistorySourceKind({}), "none");
});

test("localized active-window labels do not leak the Japanese no-notice label", () => {
  const data = getLocalRadarData({ calculationNow: new Date("2026-08-04T03:32:00.000Z") });

  assert.equal(getRadarViewModel(data, "ja", true).activeWindow.label, "予告なし");
  assert.equal(getRadarViewModel(data, "en", true).activeWindow.label, "No notice");
  assert.equal(getRadarViewModel(data, "zh", true).activeWindow.label, "无预告");
});
