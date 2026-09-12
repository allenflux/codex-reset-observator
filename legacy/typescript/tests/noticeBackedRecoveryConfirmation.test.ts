import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findNoticeBackedRecoveryEvents,
  combineResetHistory,
  type CodexRecoveryObservationInput,
} from "@/lib/radar/tiboHistory";
import { toPublicRadarSnapshot } from "@/lib/radar/publicDto";
import { resolveLocalizedText } from "@/lib/radar/i18n";
import {
  resolveDisplayExecutionTime,
  buildResetExecutionEstimate,
  TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION,
} from "@/lib/radar/resetExecution";
import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import { getRandomResetHeatmapEventTimes } from "@/lib/radar";
import { getRecoveryResetEvents } from "@/lib/radar/recoveryBoundary";
import { getLastGlobalResetAt } from "@/lib/radar/probability";
import type { RadarData } from "@/lib/radar/types";

describe("Notice-backed Usage Recovery Confirmation Policy (A - O)", () => {
  const sampleNotice = {
    tweet_id: "2087706104814023111",
    text: "Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
    tweet_url: "https://x.com/thsottiaux/status/2087706104814023111",
    tweet_created_at: "2026-08-13T01:01:37Z",
    signal_type: "official_notice" as const,
    confidence: 0.95,
    verification_status: "auto_unverified" as const,
    expected_start_at: "2026-08-13T02:01:37Z",
  };

  const sampleRecovery: CodexRecoveryObservationInput = {
    id: "68e38669-199b-4e56-a5db-83ee22f1e4b9",
    observedAt: "2026-08-13T03:34:43.341Z",
    previousObservedAt: "2026-08-13T03:32:44.526Z",
    previousUsedPercent: 100,
    currentUsedPercent: 0,
    previousResetsAt: 1787012725,
    currentResetsAt: 1787196882,
    cycleHint: "unexpected",
    confidence: "strong",
    status: "observed",
  };

  const sampleEstimate = {
    resetEventKey: "tibo-reset-2087706104814023111",
    displayExecutionAt: "2026-08-13T03:34:43.341Z",
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: "2026-08-13T03:32:44.526Z",
    executionWindowEndAt: "2026-08-13T03:34:43.341Z",
    recoveryObservationId: "68e38669-199b-4e56-a5db-83ee22f1e4b9",
    tiboAnnouncedAt: "2026-08-13T01:01:37Z",
    tiboPrimaryTweetId: "2087706104814023111",
    officialNoticeTweetId: "2087706104814023111",
    estimatorVersion: "usage-execution-v1",
    tiboSourceTweetIds: ["2087706104814023111"],
  };

  it("A. official_noticeなし + strong recovery -> global reset確定しない", () => {
    const events = findNoticeBackedRecoveryEvents([], [sampleRecovery]);
    assert.equal(events.length, 0);
  });

  it("B. official_noticeあり + medium recovery -> global reset確定しない", () => {
    const mediumRecovery: CodexRecoveryObservationInput = { ...sampleRecovery, confidence: "medium" };
    const events = findNoticeBackedRecoveryEvents([sampleNotice], [mediumRecovery]);
    assert.equal(events.length, 0);
  });

  it("C. official_noticeあり + strong regular recovery -> global reset確定しない", () => {
    const regularRecovery: CodexRecoveryObservationInput = { ...sampleRecovery, cycleHint: "regular" };
    const events = findNoticeBackedRecoveryEvents([sampleNotice], [regularRecovery]);
    assert.equal(events.length, 0);
  });

  it("D. rejected official_notice + strong recovery -> global reset確定しない", () => {
    const rejectedNotice = { ...sampleNotice, verification_status: "rejected" as const };
    const events = findNoticeBackedRecoveryEvents([rejectedNotice], [sampleRecovery]);
    assert.equal(events.length, 0);
  });

  it("E. official_noticeあり + strong unexpected recovery -> confirmed global reset", () => {
    const events = findNoticeBackedRecoveryEvents([sampleNotice], [sampleRecovery], [sampleEstimate]);
    assert.equal(events.length, 1);
    assert.equal(events[0].recordKind, "confirmed_global");
    assert.equal(events[0].closed_at, sampleRecovery.observedAt);
  });

  it("匂わせ + strong unexpected recovery は完了投稿なしでも1件の正式履歴になる", () => {
    const teaser = {
      ...sampleNotice,
      tweet_id: "2099999999999999999",
      tweet_url: "https://x.com/thsottiaux/status/2099999999999999999",
      tweet_created_at: "2026-08-26T00:00:00Z",
      signal_type: "teaser" as const,
      confidence: 0.85,
      text: "5 hour limits are back tomorrow.",
    };
    const estimate = {
      ...sampleEstimate,
      resetEventKey: `tibo-reset-${teaser.tweet_id}`,
      tiboAnnouncedAt: teaser.tweet_created_at,
      tiboPrimaryTweetId: teaser.tweet_id,
      tiboSourceTweetIds: [teaser.tweet_id],
      officialNoticeTweetId: null,
      officialNoticeAt: null,
      estimatorVersion: TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION,
    };

    const events = findNoticeBackedRecoveryEvents([teaser], [sampleRecovery], [estimate]);
    assert.equal(events.length, 1);
    assert.equal(events[0].recordKind, "confirmed_global");
    assert.equal(events[0].closed_at, sampleRecovery.observedAt);
    assert.equal(events[0].officialNoticeTweetId, undefined);
    assert.equal(events[0].details?.noticeType, "匂わせ投稿あり");
    assert.ok(events[0].sourceTweetIds?.includes(teaser.tweet_id));
  });

  it("告知履歴は最初の告知時刻を使い、代表告知は具体的な続報を使う", () => {
    const firstNotice = {
      ...sampleNotice,
      tweet_id: "2087706104814023001",
      tweet_url: "https://x.com/thsottiaux/status/2087706104814023001",
      tweet_created_at: "2026-08-13T00:30:00Z",
      text: "The reset will arrive during the day.",
      ai_temporal_precision: "daypart" as const,
      temporal_resolution_status: "resolved" as const,
      expected_start_at: "2026-08-13T02:00:00Z",
      expected_end_at: "2026-08-13T14:00:00Z",
    };
    const representativeNotice = {
      ...sampleNotice,
      tweet_id: "2087706104814023002",
      tweet_url: "https://x.com/thsottiaux/status/2087706104814023002",
      tweet_created_at: "2026-08-13T00:45:00Z",
      text: "The reset will be there by 8pm PST.",
      ai_temporal_precision: "range" as const,
      temporal_resolution_status: "resolved" as const,
      expected_start_at: "2026-08-13T03:00:00Z",
      expected_end_at: "2026-08-13T04:00:00Z",
    };
    const estimate = {
      ...sampleEstimate,
      tiboAnnouncedAt: firstNotice.tweet_created_at,
      tiboPrimaryTweetId: representativeNotice.tweet_id,
      officialNoticeTweetId: representativeNotice.tweet_id,
      tiboSourceTweetIds: [firstNotice.tweet_id, representativeNotice.tweet_id],
    };
    const events = findNoticeBackedRecoveryEvents(
      [firstNotice, representativeNotice],
      [sampleRecovery],
      [estimate],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].opened_at, "2026-08-13T00:30:00.000Z");
    assert.equal(events[0].window_minutes, 185);
    assert.equal(events[0].source_url, representativeNotice.tweet_url);
    assert.equal(events[0].officialNoticeTweetId, representativeNotice.tweet_id);
    assert.deepEqual(events[0].sourceTweetIds, [firstNotice.tweet_id, representativeNotice.tweet_id]);
  });

  it("F. 今回の実データ fixture (notice 2087706104814023111 & recovery 68e38669)", () => {
    const events = findNoticeBackedRecoveryEvents([sampleNotice], [sampleRecovery], [sampleEstimate]);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.recordKind, "confirmed_global");
    assert.equal(event.completed_at, "2026-08-13T03:34:43.341Z");
    assert.equal(event.details?.cycleType, "ランダムリセット");
    assert.equal(event.details?.reasonType, "ご祝儀リセット");
    assert.equal(event.details?.resetMethod, "強制リセット");
    assert.ok(event.sourceTweetIds?.includes("2087706104814023111"));
  });

  it("未知のnotice-backed eventはreasonTypeをご祝儀リセットへfallbackする", () => {
    const events = findNoticeBackedRecoveryEvents(
      [sampleNotice],
      [sampleRecovery],
      [{ ...sampleEstimate, resetEventKey: "tibo-reset-unknown" }],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].details?.reasonType, undefined);
  });

  it("rate-limit compensation notice uses its explicit title and reason", () => {
    const notice = {
      ...sampleNotice,
      tweet_id: "2091412393368945027",
      text: "Reset will land around 14pm PST tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/2091412393368945027",
      tweet_created_at: "2026-08-23T06:29:05Z",
      expected_start_at: "2026-08-23T22:00:00Z",
    };
    const estimate = {
      ...sampleEstimate,
      resetEventKey: "tibo-reset-2091412393368945027",
      tiboAnnouncedAt: notice.tweet_created_at,
      tiboPrimaryTweetId: notice.tweet_id,
      officialNoticeTweetId: notice.tweet_id,
      tiboSourceTweetIds: [notice.tweet_id],
    };

    const event = findNoticeBackedRecoveryEvents([notice], [sampleRecovery], [estimate])[0];

    assert.ok(event);
    assert.equal(event.title, "過剰消費のお詫びリセット");
    assert.equal(event.details?.cycleType, "ランダムリセット");
    assert.equal(event.details?.reasonType, "詫びリセット");
    assert.equal(event.details?.resetMethod, "強制リセット");
    assert.equal(event.details?.scope, "全有料プラン");
    assert.equal(event.details?.noticeType, "公式予告あり");

    const data: RadarData = {
      recent_tibo_signals: [notice as any],
      codex_recovery_observations: [sampleRecovery as any],
      reset_execution_estimates: [estimate as any],
    } as any;
    for (const [locale, expectedTitle, expectedReason, expectedNote] of [
      [
        "ja",
        "過剰消費のお詫びリセット",
        "詫びリセット",
        "週末の過剰消費トラブルに伴い、Codex全体の利用枠がお詫びとしてリセットされました。",
      ],
      [
        "en",
        "Excessive consumption compensation reset",
        "Compensation reset",
        "Codex usage limits were reset as compensation for the weekend's excessive consumption issue.",
      ],
      [
        "zh",
        "过度消耗补偿重置",
        "故障补偿重置",
        "针对周末过度消耗问题，Codex 整体使用额度已作为补偿进行重置。",
      ],
    ] as const) {
      const snapshot = toPublicRadarSnapshot(data, locale, {
        calculationNow: new Date("2026-08-23T23:00:00Z"),
        limitHistory: false,
      });
      const history = snapshot.viewModel.recentHistory.find(
        (item) => item.key === estimate.resetEventKey,
      );
      assert.equal(history?.title, expectedTitle);
      assert.equal(history?.resetType, expectedReason);
      assert.equal(history?.details?.note, expectedNote);
      assert.equal(history?.summary, expectedNote);
    }
  });

  it("K. active notice/recoveryがなくてもpersisted estimateだけで残る", () => {
    const events = findNoticeBackedRecoveryEvents([], [], [sampleEstimate]);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, sampleEstimate.resetEventKey);
    assert.equal(events[0].completed_at, sampleEstimate.displayExecutionAt);
  });

  it("L. estimateがない古いnotice/recoveryからconfirmed eventを再生成しない", () => {
    const events = findNoticeBackedRecoveryEvents([sampleNotice], [sampleRecovery]);
    assert.equal(events.length, 0);
  });

  it("M. official notice/recovery identityが欠けたestimateは採用しない", () => {
    const missingOfficialNotice = { ...sampleEstimate, officialNoticeTweetId: null };
    const missingRecovery = { ...sampleEstimate, recoveryObservationId: null };
    assert.equal(findNoticeBackedRecoveryEvents([], [], [missingOfficialNotice]).length, 0);
    assert.equal(findNoticeBackedRecoveryEvents([], [], [missingRecovery]).length, 0);
  });

  it("N. formal reset matchingは明示的なmatchedTiboTweetIdを要求する", () => {
    const decision = resolveDisplayExecutionTime({
      resetEventKey: "tibo-reset-other",
      tiboAnnouncedAt: "2026-08-13T03:50:00Z",
      tiboPrimaryTweetId: "2087709900000000000",
      tiboSourceTweetIds: ["2087709900000000000"],
      usageObservation: {
        ...sampleRecovery,
        matchedTiboTweetId: null,
      } as any,
    });
    assert.equal(decision.executionTimeSource, "tibo_announcement_fallback");
  });

  it("G. 確定後の ViewModel & PublicDto 状態", () => {
    const data: RadarData = {
      active_tibo_signals: [sampleNotice as any],
      codex_usage_recovery: sampleRecovery as any,
      codex_recovery_observations: [sampleRecovery as any],
      reset_execution_estimates: [sampleEstimate as any],
    } as any;
    const now = new Date("2026-08-13T03:40:00Z");
    const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: now });
    const publicVm = snapshot.viewModel;

    // Active official notice & provisional recovery ended
    assert.equal(snapshot.recoveryObservation, null);
    // Recent history contains item matching recovery reset time
    assert.ok(
      publicVm.recentHistory.some(
        (h) => h.resetAt === "2026-08-13T03:34:43.341Z" || h.key?.includes("notice-recovery") || h.key?.includes("68e38669"),
      ),
    );
    // Probabilities returned as numeric
    assert.equal(typeof publicVm.probability24h, "number");
    assert.equal(typeof publicVm.probability48h, "number");
  });

  it("H. 後から reset_executed 投稿が来ても同一 event へ merge され重複しない", () => {
    const resetExecuted = {
      tweet_id: "2087709900000000000",
      text: "Reset complete!",
      tweet_url: "https://x.com/thsottiaux/status/2087709900000000000",
      tweet_created_at: "2026-08-13T03:50:00Z",
      signal_type: "reset_executed" as const,
      confidence: 0.95,
      verification_status: "auto_unverified" as const,
      related_notice: sampleNotice,
    };

    const combined = combineResetHistory(
      [],
      [resetExecuted as any],
      [],
      [],
      [sampleNotice],
      [sampleRecovery],
      [sampleEstimate],
    );

    const confirmedEvents = combined.filter((e) => e.recordKind === "confirmed_global");
    assert.equal(confirmedEvents.length, 1);
    assert.equal(confirmedEvents[0].completed_at, "2026-08-13T03:34:43.341Z");
  });

  it("複合完了投稿は08:37 Usage Monitor recoveryへ90分以内でmergeされ新規resetを二重登録しない", () => {
    const compositeNotice = {
      ...sampleNotice,
      tweet_id: "2092000000000000100",
      tweet_url: "https://x.com/thsottiaux/status/2092000000000000100",
      tweet_created_at: "2026-08-23T22:00:00Z",
      text: "The reset is now effective for accounts.",
    };
    const compositeRecovery = {
      ...sampleRecovery,
      id: "composite-recovery-0837",
      observedAt: "2026-08-23T23:37:43.201Z",
      previousObservedAt: "2026-08-23T23:33:43.156Z",
    };
    const compositeEstimate = {
      ...sampleEstimate,
      resetEventKey: "tibo-reset-2092000000000000100",
      displayExecutionAt: compositeRecovery.observedAt,
      executionWindowStartAt: compositeRecovery.previousObservedAt,
      executionWindowEndAt: compositeRecovery.observedAt,
      recoveryObservationId: compositeRecovery.id,
      tiboAnnouncedAt: compositeNotice.tweet_created_at,
      tiboPrimaryTweetId: compositeNotice.tweet_id,
      officialNoticeTweetId: compositeNotice.tweet_id,
      tiboSourceTweetIds: [compositeNotice.tweet_id],
    };
    const compositeReset = {
      tweet_id: "2092000000000000001",
      text: "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.",
      tweet_url: "https://x.com/thsottiaux/status/2092000000000000001",
      tweet_created_at: "2026-08-24T00:07:43.201Z",
      signal_type: "reset_executed" as const,
      confidence: 0.98,
      verification_status: "auto_unverified" as const,
      classification_source: "gemini" as const,
      related_notice: compositeNotice,
    };

    const combined = combineResetHistory(
      [],
      [compositeReset as any],
      [],
      [],
      [compositeNotice],
      [compositeRecovery],
      [compositeEstimate],
    );
    const confirmedEvents = combined.filter((event) => event.recordKind === "confirmed_global");

    assert.ok(
      Math.abs(Date.parse(compositeReset.tweet_created_at) - Date.parse(compositeRecovery.observedAt)) <=
        90 * 60 * 1000,
    );
    assert.equal(confirmedEvents.length, 1);
    assert.equal(confirmedEvents[0].completed_at, compositeRecovery.observedAt);
    assert.ok(confirmedEvents[0].sourceTweetIds?.includes(compositeNotice.tweet_id));
    assert.ok(confirmedEvents[0].sourceTweetIds?.includes(compositeReset.tweet_id));
  });

  it("I. 同じ webhook / recovery を再送しても idempotent で重複なし", () => {
    const combined = combineResetHistory(
      [],
      [],
      [],
      [],
      [sampleNotice],
      [sampleRecovery, sampleRecovery],
      [sampleEstimate, sampleEstimate],
    );

    const confirmedEvents = combined.filter((e) => e.recordKind === "confirmed_global");
    assert.equal(confirmedEvents.length, 1);
  });

  it("J. JA / EN / ZHのPublicRadarSnapshotがcompletion UI文言を実際に翻訳する", () => {
    const baseData: RadarData = {
      recent_tibo_signals: [sampleNotice as any],
      codex_recovery_observations: [sampleRecovery as any],
      reset_execution_estimates: [sampleEstimate as any],
      reset_display_names: [{
        event_key: sampleEstimate.resetEventKey,
        source_tweet_id: sampleNotice.tweet_id,
        manual_name_ja: "1500万人アクティブユーザー突破記念リセット",
        ai_name_ja: "1500万突破記念リセット",
        ai_confidence: 0.93,
        ai_evidence: "15M",
        ai_reason: "15M milestone",
        ai_model: "gemini-3.5-flash-lite",
        ai_prompt_version: "random-reset-name-v2-experiment-2",
        ai_input_mode: "source_post_text",
        ai_status: "accepted",
        ai_flags: [],
        ai_generated_at: "2026-08-13T02:00:00Z",
        input_hash: "fixture",
      }] as any,
    };

    const ja = toPublicRadarSnapshot(baseData, "ja", {
      calculationNow: new Date("2026-08-13T05:10:00Z"),
      limitHistory: false,
    });
    const en = toPublicRadarSnapshot(baseData, "en", {
      calculationNow: new Date("2026-08-13T05:10:00Z"),
      limitHistory: false,
    });
    const zh = toPublicRadarSnapshot(baseData, "zh", {
      calculationNow: new Date("2026-08-13T05:10:00Z"),
      limitHistory: false,
    });

    const jaItem = ja.viewModel.recentHistory.find((item) => item.key === sampleEstimate.resetEventKey);
    const enItem = en.viewModel.recentHistory.find((item) => item.key === sampleEstimate.resetEventKey);
    const zhItem = zh.viewModel.recentHistory.find((item) => item.key === sampleEstimate.resetEventKey);

    assert.equal(jaItem?.title, "1500万人アクティブユーザー突破記念リセット");
    assert.equal(enItem?.title, "15 Million Active Users Milestone Reset");
    assert.equal(zhItem?.title, "活跃用户突破1500万纪念重置");
    assert.equal(
      jaItem?.summary,
      "Codexのアクティブユーザー数1500万人突破を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    );
    assert.equal(
      enItem?.summary,
      "To celebrate Codex surpassing 15 million active users, usage limits for ChatGPT Work and Codex were forcibly reset.",
    );
    assert.equal(
      zhItem?.summary,
      "为纪念 Codex 活跃用户数突破 1500 万，ChatGPT Work 和 Codex 的使用额度进行了强制重置。",
    );
    assert.equal(jaItem?.resetAt, sampleEstimate.displayExecutionAt);
    assert.equal(jaItem?.executionTimePrecision, "approximate");
    assert.equal(jaItem?.resetType, "ご祝儀リセット");
    assert.equal(jaItem?.details?.cycleType, "ランダムリセット");
    assert.equal(jaItem?.details?.reasonType, "ご祝儀リセット");
    assert.equal(jaItem?.details?.resetMethod, "強制リセット");
    assert.equal(jaItem?.details?.note, jaItem?.summary);
  });

  it("O. notice expiry後・recovery公開期限後もestimate由来eventが残る", () => {
    const data: RadarData = {
      reset_execution_estimates: [sampleEstimate as any],
    };
    for (const calculationNow of ["2026-08-13T04:02:00Z", "2026-08-13T05:10:00Z"]) {
      const snapshot = toPublicRadarSnapshot(data, "ja", {
        calculationNow: new Date(calculationNow),
        limitHistory: false,
      });
      const targetItem = snapshot.viewModel.recentHistory.find(
        (item) => item.key === sampleEstimate.resetEventKey,
      );
      assert.equal(targetItem?.recordKind, "confirmed_global");
      assert.equal(snapshot.viewModel.activeWindow.active, false);
      assert.equal(typeof snapshot.viewModel.probability24h, "number");
      assert.equal(typeof snapshot.viewModel.probability48h, "number");
      assert.equal(snapshot.recoveryObservation, null);
      assert.equal(targetItem?.resetAt, sampleEstimate.displayExecutionAt);
      assert.equal(
        getLastGlobalResetAt(data, new Date(calculationNow))?.toISOString(),
        sampleEstimate.displayExecutionAt,
      );

      const heatmapTimes = getRandomResetHeatmapEventTimes(data, new Date(calculationNow));
      assert.equal(
        heatmapTimes.filter((time) => time === sampleEstimate.displayExecutionAt).length,
        1,
      );
      const boundaries = getRecoveryResetEvents(data, new Date(calculationNow));
      assert.equal(
        boundaries.filter((boundary) => boundary.resetAt === sampleEstimate.displayExecutionAt).length,
        1,
      );
    }
  });

  it("P. 2026-09-08 rolling notice does not absorb an unlinked delayed monitor recovery", () => {
    const lateObservation = {
      id: "rec-late-monitor-user",
      sourceKey: "local-codex-app-server",
      observedAt: "2026-09-08T05:30:00.000Z",
      previousObservedAt: "2026-09-08T05:25:00.000Z",
      previousUsedPercent: 95,
      currentUsedPercent: 0,
      previousResetsAt: 1788800000,
      currentResetsAt: 1789400000,
      cycleHint: "unexpected" as const,
      confidence: "strong" as const,
      status: "confirmed" as const,
    };

    const lateEstimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${lateObservation.id}`,
      usageObservation: lateObservation,
      isMonitorObserved: true,
    })!;

    const noticeSignal = {
      tweet_id: "2097043464538264003",
      tweet_url: "https://x.com/thsottiaux/status/2097043464538264003",
      tweet_created_at: "2026-09-07T19:24:57.000Z",
      signal_type: "official_notice" as const,
      confidence: 0.99,
      verification_status: "confirmed" as const,
      text: "Lands around 6pm PST today.",
    };

    const combined = combineResetHistory(
      LOCAL_RESET_HISTORY,
      [],
      [],
      [],
      [noticeSignal],
      [lateObservation],
      [lateEstimate],
    );

    assert.equal(combined.length, LOCAL_RESET_HISTORY.length + 1);
    const rollingReset = combined.find(
      (item) => item.id === "local-codex-rolling-notice-reset-2026-09-08",
    );
    const delayedRecovery = combined.find((item) => item.id === lateEstimate.resetEventKey);
    assert.equal(
      resolveLocalizedText(rollingReset?.title, "ja"),
      "Tiboの君を絶対に諦めないリセット",
    );
    assert.equal(rollingReset?.recoveryObservationId, undefined);
    assert.equal(delayedRecovery?.recoveryObservationId, "rec-late-monitor-user");
    assert.notEqual(rollingReset?.id, delayedRecovery?.id);
  });
});
