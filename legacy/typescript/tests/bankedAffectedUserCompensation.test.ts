import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { ResetHistoryDetails } from "../components/ResetHistoryDetails";
import {
  isBankedDistributionNotice,
  isBroadBankedDistributionNotice,
  isConditionalBankedDistributionNotice,
} from "../lib/radar/bankedReset";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import { findBankedDistributionEvents } from "../lib/radar/tiboHistory";

const TIBO_COMPENSATION_TEXT =
  "There was a bit of a kerfuffle this morning with some banked resets not fully applying when used in ChatGPT Work and Codex. Everyone who used one in the affected time window is getting another one and an email to apologize.";

const notice = {
  tweet_id: "2097752790177370535",
  text: TIBO_COMPENSATION_TEXT,
  tweet_url: "https://x.com/thsottiaux/status/2097752790177370535",
  tweet_created_at: "2026-09-09T18:23:34.000Z",
  signal_type: "official_notice" as const,
  confidence: 1,
  verification_status: "confirmed" as const,
};

const estimate = {
  resetEventKey: "banked-reset-2097752790177370535",
  displayExecutionAt: "2026-09-09T18:23:34.000Z",
  executionTimeSource: "manual_override" as const,
  executionTimeConfidence: "high" as const,
  executionTimePrecision: "approximate" as const,
  executionWindowStartAt: null,
  executionWindowEndAt: null,
  recoveryObservationId: null,
  tiboAnnouncedAt: notice.tweet_created_at,
  tiboPrimaryTweetId: notice.tweet_id,
  tiboSourceTweetIds: [notice.tweet_id],
  officialNoticeTweetId: notice.tweet_id,
  officialNoticeAt: notice.tweet_created_at,
  estimatorVersion: "banked-distribution-observation-v2",
  manualOverrideAt: "2026-09-09T18:24:00.000Z",
  manualOverrideBy: "operator",
  manualOverrideReason: "Production manual correction for the affected-user compensation notice.",
  manualExecutionAt: "2026-09-09T18:23:34.000Z",
  manualExecutionPrecision: "approximate" as const,
};

test("recognizes affected-user BANKED compensation across adjacent sentences", () => {
  assert.equal(isBankedDistributionNotice(TIBO_COMPENSATION_TEXT), true);
  assert.equal(isBroadBankedDistributionNotice(TIBO_COMPENSATION_TEXT), true);
  assert.equal(isConditionalBankedDistributionNotice(TIBO_COMPENSATION_TEXT), true);
});

test("keeps affected-user BANKED compensation in history but out of the broad random-reset target", () => {
  const [event] = findBankedDistributionEvents([notice], [estimate]);

  assert.ok(event);
  assert.equal(event.recordKind, "banked_distribution");
  assert.equal(event.id, estimate.resetEventKey);
  assert.equal(event.randomResetTargetScope, "conditional");
  assert.equal(event.scope, "一部ユーザー");
  assert.equal(event.details?.scope, "一部ユーザー");
  assert.equal(event.details?.reasonType, "詫びリセット");
  assert.equal(
    event.details?.note,
    "ChatGPT WorkおよびCodexにおいて、任意リセット権（banked reset）を使用した際に正常に適用されない問題が発生しました。影響を受けた時間帯に任意リセット権を使用したユーザーに対して、お詫びメールの送付とともに、補償として任意リセット権が1回分再配布されました。",
  );

  const completedAt = Date.parse(event.completed_at ?? event.closed_at ?? event.date ?? "");
  assert.equal(
    isEligibleRandomResetEvent(event, completedAt, Date.parse("2026-09-10T00:00:00.000Z")),
    false,
  );
});

test("regression: conditional BANKED notices get scope 一部ユーザー, but only tweet 2097752790177370535 gets special compensation note", () => {
  const otherConditionalNotice = {
    tweet_id: "2099999999999999999",
    text: "We will give a BANKED reset to all users who still don't have Astra.",
    tweet_url: "https://x.com/thsottiaux/status/2099999999999999999",
    tweet_created_at: "2026-09-09T19:00:00.000Z",
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
  };

  const otherConditionalEstimate = {
    resetEventKey: "banked-reset-2099999999999999999",
    displayExecutionAt: "2026-09-09T19:00:00.000Z",
    executionTimeSource: "manual_override" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: null,
    executionWindowEndAt: null,
    recoveryObservationId: null,
    tiboAnnouncedAt: otherConditionalNotice.tweet_created_at,
    tiboPrimaryTweetId: otherConditionalNotice.tweet_id,
    tiboSourceTweetIds: [otherConditionalNotice.tweet_id],
    officialNoticeTweetId: otherConditionalNotice.tweet_id,
    officialNoticeAt: otherConditionalNotice.tweet_created_at,
    estimatorVersion: "banked-distribution-observation-v2",
    manualOverrideAt: "2026-09-09T19:01:00.000Z",
    manualOverrideBy: "operator",
    manualOverrideReason: "Astra conditional notice.",
    manualExecutionAt: "2026-09-09T19:00:00.000Z",
    manualExecutionPrecision: "approximate" as const,
  };

  const events = findBankedDistributionEvents(
    [notice, otherConditionalNotice],
    [estimate, otherConditionalEstimate],
  );

  const compensationEvent = events.find((e) => e.id === estimate.resetEventKey);
  const otherEvent = events.find((e) => e.id === otherConditionalEstimate.resetEventKey);

  assert.ok(compensationEvent, "Compensation event must exist");
  assert.ok(otherEvent, "Other conditional event must exist");

  // 今回tweet: scope = 一部ユーザー, special compensation note = YES
  assert.equal(compensationEvent.scope, "一部ユーザー");
  assert.equal(compensationEvent.details?.scope, "一部ユーザー");
  assert.equal(compensationEvent.randomResetTargetScope, "conditional");
  assert.equal(compensationEvent.details?.reasonType, "詫びリセット");
  const compNote =
    typeof compensationEvent.details?.note === "string"
      ? compensationEvent.details.note
      : compensationEvent.details?.note?.ja ?? "";
  assert.match(compNote, /お詫び|補償として任意リセット権が1回分再配布|影響/);
  assert.notEqual(compNote, "任意リセット権の配布が確認されました。");

  // 別のconditional BANKED notice: scope = 一部ユーザー, special compensation note = NO
  assert.equal(otherEvent.scope, "一部ユーザー");
  assert.equal(otherEvent.details?.scope, "一部ユーザー");
  assert.equal(otherEvent.randomResetTargetScope, "conditional");
  assert.equal(otherEvent.details?.reasonType, "ご祝儀リセット");
  const otherNote =
    typeof otherEvent.details?.note === "string"
      ? otherEvent.details.note
      : otherEvent.details?.note?.ja ?? "";
  assert.equal(otherNote, "任意リセット権の配布が確認されました。");
  assert.doesNotMatch(otherNote, /お詫び|補償として任意リセット権が再配布|影響時間帯/);

  // probability eligibility and lastRandomResetAt remain unchanged
  const calculationNow = new Date("2026-09-10T00:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [notice, otherConditionalNotice],
    resetExecutionEstimates: [estimate, otherConditionalEstimate],
  });
  const snapshot = toPublicRadarSnapshot(data, "ja", {
    calculationNow,
    limitHistory: false,
  });
  assert.equal(snapshot.lastRandomResetAt, "2026-09-08T01:30:00.000Z");

  const compCompletedAt = Date.parse(compensationEvent.completed_at ?? "");
  const otherCompletedAt = Date.parse(otherEvent.completed_at ?? "");
  assert.equal(
    isEligibleRandomResetEvent(compensationEvent, compCompletedAt, calculationNow.getTime()),
    false,
  );
  assert.equal(
    isEligibleRandomResetEvent(otherEvent, otherCompletedAt, calculationNow.getTime()),
    false,
  );
});

test("public DTO isolates randomResetTargetScope, retains 9/8 lastRandomResetAt, and localizes across JA/EN/ZH", () => {
  const calculationNow = new Date("2026-09-10T00:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [notice],
    resetExecutionEstimates: [estimate],
  });

  const expectedLocalized = {
    ja: {
      title: "任意リセット不具合補償リセット",
      scope: "一部ユーザー",
      reasonType: "詫びリセット",
      note: "ChatGPT WorkおよびCodexにおいて、任意リセット権（banked reset）を使用した際に正常に適用されない問題が発生しました。影響を受けた時間帯に任意リセット権を使用したユーザーに対して、お詫びメールの送付とともに、補償として任意リセット権が1回分再配布されました。",
      scopeLabel: "対象",
    },
    en: {
      title: "Banked Reset Issue Compensation Reset",
      scope: "Some users",
      reasonType: "Compensation reset",
      note: "An issue occurred where some Banked Resets did not fully apply when used in ChatGPT Work and Codex. Users who used one during the affected time window are receiving an apology email along with a replacement Banked Reset.",
      scopeLabel: "Eligibility",
    },
    zh: {
      title: "手动重置故障补偿重置",
      scope: "部分用户",
      reasonType: "故障补偿重置",
      note: "ChatGPT Work 和 Codex 出现部分手动重置（banked reset）使用后未完全生效的问题。在受影响时段内使用过手动重置的用户将收到一封致歉邮件以及补发的手动重置机会。",
      scopeLabel: "适用对象",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, {
      calculationNow,
      limitHistory: false,
    });

    // lastRandomResetAt remains the 9/8 global reset, NOT the conditional BANKED compensation event
    assert.equal(snapshot.lastRandomResetAt, "2026-09-08T01:30:00.000Z");

    const historyItem = snapshot.viewModel.recentHistory.find(
      (item) => item.key === estimate.resetEventKey,
    );
    assert.ok(historyItem, `${locale} history item should exist`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(historyItem, "randomResetTargetScope"),
      false,
    );
    assert.equal(historyItem.title, expectedLocalized[locale].title);
    assert.equal(historyItem.scope, expectedLocalized[locale].scope);
    assert.equal(historyItem.details?.scope, expectedLocalized[locale].scope);
    assert.equal(historyItem.details?.reasonType, expectedLocalized[locale].reasonType);
    assert.equal(historyItem.details?.note, expectedLocalized[locale].note);
    assert.equal(historyItem.details?.noticeToExecution, "");

    // UI rendering test for this event: displays "対象: 一部ユーザー" (or localized)
    const html = renderToStaticMarkup(
      React.createElement(ResetHistoryDetails, {
        item: historyItem,
        locale,
      }),
    );
    assert.match(html, new RegExp(expectedLocalized[locale].scopeLabel));
    assert.match(html, new RegExp(expectedLocalized[locale].scope));
    assert.match(html, new RegExp(expectedLocalized[locale].reasonType));
    assert.match(html, new RegExp(expectedLocalized[locale].note.slice(0, 10)));
    assert.doesNotMatch(html, /告知から実施まで|Time from notice to reset|从预告到执行/);
    assert.doesNotMatch(html, /0分|0 min|0 分/);

    // UI rendering test for existing "全有料プラン" items: does NOT display "対象" row
    const allPaidItem = snapshot.viewModel.recentHistory.find(
      (item) => item.key === "local-codex-rolling-notice-reset-2026-09-08",
    );
    if (allPaidItem) {
      const allPaidHtml = renderToStaticMarkup(
        React.createElement(ResetHistoryDetails, {
          item: allPaidItem,
          locale,
        }),
      );
      assert.doesNotMatch(allPaidHtml, new RegExp(expectedLocalized[locale].scopeLabel));
    }
  }
});

test("does not treat a vague personal replacement as a BANKED distribution", () => {
  assert.equal(
    isBankedDistributionNotice(
      "I used one of my banked resets this morning. Support said I might get another one.",
    ),
    false,
  );
});

test("ties cross-sentence compensation to a reset or credit target", () => {
  assert.equal(
    isBankedDistributionNotice(
      "Banked resets had an issue. Everyone who used one in the affected time window is getting another one.",
    ),
    true,
  );
  assert.equal(
    isBankedDistributionNotice(
      "Banked resets had an issue. Everyone who was affected will receive an additional reset credit.",
    ),
    true,
  );
  assert.equal(
    isBankedDistributionNotice(
      "Banked resets had an issue. Everyone who was affected will be given a replacement banked reset.",
    ),
    true,
  );
  assert.equal(
    isBankedDistributionNotice(
      "Banked resets had an issue. Everyone who used one is getting another email.",
    ),
    false,
  );
  assert.equal(
    isBankedDistributionNotice(
      "Banked resets had an issue. Everyone who used one is getting an email.",
    ),
    false,
  );
});
