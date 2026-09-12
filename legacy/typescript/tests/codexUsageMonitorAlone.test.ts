import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import type { ActiveTiboSignal } from "../lib/radar/types";
import {
  evaluateCodexUsageRecovery,
  type CodexUsageSnapshot,
  type CodexRecoveryObservation,
} from "../lib/codexUsageRecovery";
import {
  buildResetExecutionEstimate,
  MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION,
  type ResetExecutionEstimate,
} from "../lib/radar/resetExecution";
import {
  findNoticeBackedRecoveryEvents,
  type TiboNoticeSignal,
} from "../lib/radar/tiboHistory";
import { getLastRandomRecoveryResetAt } from "../lib/radar/recoveryBoundary";
import { normalizeResetReasonType } from "../lib/radar/resetReason";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";

const OBSERVATION_TIME = "2026-08-26T01:15:00.000Z";
const PREVIOUS_TIME = "2026-08-26T01:10:00.000Z";
const CALCULATION_NOW = new Date("2026-08-26T02:00:00.000Z");

function makeBaseSnapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    observedAt: PREVIOUS_TIME,
    limitId: "codex",
    planType: "plus",
    usedPercent: 80,
    windowDurationMins: 10080,
    resetsAt: 1788000000,
    ...overrides,
  };
}

describe("Usage Monitor Standalone Reset Detection Protocol", () => {
  it("1. Tiboなし unexpected weekly recovery -> 即正式ランダム履歴", () => {
    const prev = makeBaseSnapshot({ observedAt: PREVIOUS_TIME, usedPercent: 80, resetsAt: 1788000000 });
    const curr = makeBaseSnapshot({ observedAt: OBSERVATION_TIME, usedPercent: 0, resetsAt: 1788604800 });

    const decision = evaluateCodexUsageRecovery(prev, curr);
    assert.equal(decision.kind, "recovery");
    assert.equal(decision.cycleHint, "unexpected");
    assert.equal(decision.confidence, "strong");

    const recoveryObservation: CodexRecoveryObservation = {
      id: "test-rec-1",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    assert.ok(estimate);
    assert.equal(estimate.displayExecutionAt, OBSERVATION_TIME);
    assert.equal(estimate.estimatorVersion, MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION);

    const events = findNoticeBackedRecoveryEvents([], [recoveryObservation], [estimate]);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "usage-reset-test-rec-1");
    assert.equal(events[0].title, "ランダムリセット");
    assert.equal(events[0].completed_at, OBSERVATION_TIME);
    assert.equal(events[0].recordKind, "confirmed_global");
    assert.equal(events[0].summary, "Codexの週間利用枠がリセットされたことを確認しました。");
  });

  it("2. TiboなしでもlastRandomResetAt更新", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "test-rec-2",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    const radarData = getLocalRadarData({
      checkedAt: CALCULATION_NOW.toISOString(),
      calculationNow: CALCULATION_NOW,
      resetExecutionEstimates: [estimate!],
      codexRecoveryObservations: [recoveryObservation],
    });

    const lastRandomResetAt = getLastRandomRecoveryResetAt(radarData, CALCULATION_NOW);
    assert.equal(lastRandomResetAt, OBSERVATION_TIME);
  });

  it("3. Tiboなしでもprobability boundary更新", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "test-rec-3",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    const radarData = getLocalRadarData({
      checkedAt: CALCULATION_NOW.toISOString(),
      calculationNow: CALCULATION_NOW,
      resetExecutionEstimates: [estimate!],
      codexRecoveryObservations: [recoveryObservation],
    });

    const snapshot = toPublicRadarSnapshot(radarData, "ja", { calculationNow: CALCULATION_NOW });
    assert.equal(snapshot.lastRandomResetAt, OBSERVATION_TIME);
    assert.ok(snapshot.viewModel.recentHistory.some((h) => h.key === "usage-reset-test-rec-3"));
  });

  it("4. regular weekly recovery -> random履歴にしない", () => {
    const regularBoundaryEpochSec = Math.floor(new Date(OBSERVATION_TIME).getTime() / 1000);
    const prev = makeBaseSnapshot({
      observedAt: PREVIOUS_TIME,
      usedPercent: 80,
      resetsAt: regularBoundaryEpochSec,
    });
    const curr = makeBaseSnapshot({
      observedAt: OBSERVATION_TIME,
      usedPercent: 0,
      resetsAt: regularBoundaryEpochSec + 7 * 24 * 3600,
    });

    const decision = evaluateCodexUsageRecovery(prev, curr);
    assert.equal(decision.kind, "recovery");
    assert.equal(decision.cycleHint, "regular");
    assert.equal(decision.nearRegularSchedule, true);
  });

  it("5. planType変更 -> rebase / random履歴にしない", () => {
    const prev = makeBaseSnapshot({ planType: "plus" });
    const curr = makeBaseSnapshot({ observedAt: OBSERVATION_TIME, planType: "team", usedPercent: 0, resetsAt: 1788604800 });

    const decision = evaluateCodexUsageRecovery(prev, curr);
    assert.equal(decision.kind, "rebase");
  });

  it("6. recovery + banked count減少 + 明確に有効期限内 -> 個人リセット扱い / public random履歴なし", () => {
    const grantAt = "2026-08-20T00:00:00.000Z"; // 6 days ago (< 20 days safe window)
    const prev = makeBaseSnapshot({
      bankedResetAvailableCount: 1,
      usedPercent: 80,
      resetsAt: 1788000000,
    });
    const curr = makeBaseSnapshot({
      observedAt: OBSERVATION_TIME,
      bankedResetAvailableCount: 0,
      usedPercent: 0,
      resetsAt: 1788604800,
    });

    const decision = evaluateCodexUsageRecovery(prev, curr, { lastBankedGrantAt: grantAt });
    assert.equal(decision.kind, "recovery");
    assert.equal(decision.isPersonalReset, true);
  });

  it("7. banked count自然失効のみ (no quota recovery) -> random履歴なし", () => {
    const prev = makeBaseSnapshot({
      bankedResetAvailableCount: 1,
      usedPercent: 50,
      resetsAt: 1788000000,
    });
    const curr = makeBaseSnapshot({
      observedAt: OBSERVATION_TIME,
      bankedResetAvailableCount: 0,
      usedPercent: 50, // no decrease
      resetsAt: 1788000000,
    });

    const decision = evaluateCodexUsageRecovery(prev, curr);
    assert.equal(decision.kind, "no_recovery");
  });

  it("8. 自然失効付近 + unexpected weekly recovery -> random履歴を握り潰さない (fail open)", () => {
    const grantAt = "2026-07-26T00:00:00.000Z"; // 31 days ago (around ~30d expiration)
    const prev = makeBaseSnapshot({
      bankedResetAvailableCount: 1,
      usedPercent: 80,
      resetsAt: 1788000000,
    });
    const curr = makeBaseSnapshot({
      observedAt: OBSERVATION_TIME,
      bankedResetAvailableCount: 0,
      usedPercent: 0,
      resetsAt: 1788604800,
    });

    const decision = evaluateCodexUsageRecovery(prev, curr, { lastBankedGrantAt: grantAt });
    assert.equal(decision.kind, "recovery");
    assert.equal(decision.isPersonalReset, false); // Fail-open: published!
  });

  it("9. banked count unavailable + unexpected weekly recovery -> 即公開", () => {
    const prev = makeBaseSnapshot({
      bankedResetAvailableCount: null,
      usedPercent: 80,
      resetsAt: 1788000000,
    });
    const curr = makeBaseSnapshot({
      observedAt: OBSERVATION_TIME,
      bankedResetAvailableCount: null,
      usedPercent: 0,
      resetsAt: 1788604800,
    });

    const decision = evaluateCodexUsageRecovery(prev, curr);
    assert.equal(decision.kind, "recovery");
    assert.equal(decision.isPersonalReset, false);
  });

  it("10. Monitorイベント作成後にTibo official notice追加 -> 同一eventをenrich、duplicateなし、executionAt不変", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-enrich-1",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const initialEstimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    // Later, official notice tweet arrives
    const noticeTweet: TiboNoticeSignal = {
      tweet_id: "tibo-official-123",
      text: "We are resetting limits today due to outage.",
      tweet_url: "https://x.com/thsottiaux/status/tibo-official-123",
      tweet_created_at: "2026-08-26T00:30:00.000Z",
      signal_type: "official_notice",
      confidence: 0.99,
      verification_status: "confirmed",
    };

    const enrichedEstimate = buildResetExecutionEstimate({
      resetEventKey: initialEstimate!.resetEventKey,
      tiboAnnouncedAt: noticeTweet.tweet_created_at,
      tiboPrimaryTweetId: noticeTweet.tweet_id,
      tiboSourceTweetIds: [noticeTweet.tweet_id],
      officialNoticeTweetId: noticeTweet.tweet_id,
      officialNoticeAt: noticeTweet.tweet_created_at,
      usageObservation: recoveryObservation,
      persistedEstimate: initialEstimate,
    });

    assert.equal(enrichedEstimate?.resetEventKey, `usage-reset-${recoveryObservation.id}`);
    assert.equal(enrichedEstimate?.displayExecutionAt, OBSERVATION_TIME); // ExecutionAt unchanged!

    const events = findNoticeBackedRecoveryEvents([noticeTweet], [recoveryObservation], [enrichedEstimate!]);
    assert.equal(events.length, 1);
    assert.equal(events[0].completed_at, OBSERVATION_TIME);
    assert.equal(events[0].details?.reasonType, "詫びリセット");
  });

  it("11. teaser追加 -> 「予告」扱いしない (匂わせ投稿あり)", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-teaser-1",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const teaserTweet: ActiveTiboSignal = {
      tweet_id: "teaser-999",
      text: "Tomorrow we bring back 5h limit...",
      tweet_url: "https://x.com/thsottiaux/status/teaser-999",
      signal_type: "teaser",
      confidence: 0.9,
      verification_status: "confirmed",
      tweet_created_at: "2026-08-25T10:00:00.000Z",
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `tibo-reset-${teaserTweet.tweet_id}`,
      tiboAnnouncedAt: teaserTweet.tweet_created_at,
      tiboPrimaryTweetId: teaserTweet.tweet_id,
      tiboSourceTweetIds: [teaserTweet.tweet_id],
      corroboratingTiboTweetId: teaserTweet.tweet_id,
      usageObservation: recoveryObservation,
    });

    const events = findNoticeBackedRecoveryEvents([teaserTweet as any], [recoveryObservation], [estimate!]);
    assert.equal(events.length, 1);
    assert.equal(events[0].details?.noticeType, "匂わせ投稿あり");
    // 2026-08-25T10:00:00.000Z to 2026-08-26T01:15:00.000Z is 15 hours 15 minutes (915 mins)
    assert.equal(events[0].details?.noticeToExecution, "15時間15分");
    assert.equal(events[0].window_minutes, 915);
  });

  it("12. completion post追加 -> executionAt不変", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-comp-1",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const initialEstimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      tiboAnnouncedAt: "2026-08-26T01:45:00.000Z", // Tibo posted 30 min later
      tiboPrimaryTweetId: "tibo-comp-post",
      tiboSourceTweetIds: ["tibo-comp-post"],
      usageObservation: recoveryObservation,
      persistedEstimate: initialEstimate,
    });

    assert.equal(estimate?.displayExecutionAt, OBSERVATION_TIME); // Preserves 01:15:00!
  });

  it("13. unknown reason -> ご祝儀fallbackしない (理由行非表示)", () => {
    const emptyReason = normalizeResetReasonType({});
    assert.equal(emptyReason, undefined);

    const genericReason = normalizeResetReasonType({ title: "ランダムリセット", summary: "Codexの週間利用枠がリセットされたことを確認しました。" });
    assert.equal(genericReason, undefined);
  });

  it("14. Public UIに「Usage Monitor」という内部語を出さない", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "test-rec-ui",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    const radarData = getLocalRadarData({
      checkedAt: CALCULATION_NOW.toISOString(),
      calculationNow: CALCULATION_NOW,
      resetExecutionEstimates: [estimate!],
      codexRecoveryObservations: [recoveryObservation],
    });

    const vm = getRadarViewModel(radarData, "ja", false, undefined, CALCULATION_NOW);
    const serialized = JSON.stringify(vm);
    assert.equal(serialized.includes("Usage Monitor"), false);
    assert.equal(serialized.includes("Usage observation"), false);
  });

  it("15. 5時間制限復活に伴うリセット -> 匂わせ投稿あり + 告知から実施まで 12時間57分 + 詫びリセット", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-tibo-5h",
      sourceKey: "local-codex-app-server",
      observedAt: "2026-08-25T14:13:31.428Z",
      previousObservedAt: "2026-08-25T14:11:00.000Z",
      previousUsedPercent: 31,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const teaserTweet: ActiveTiboSignal = {
      tweet_id: "2092058556707344708",
      text: "Tomorrow we will bring back the 5h limit for Plus accounts. To apologize for the inconvenience we just reset all weekly quotas.",
      tweet_url: "https://x.com/thsottiaux/status/2092058556707344708",
      signal_type: "teaser",
      confidence: 0.95,
      verification_status: "confirmed",
      tweet_created_at: "2026-08-25T01:16:11.000Z",
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `tibo-reset-${teaserTweet.tweet_id}`,
      tiboAnnouncedAt: teaserTweet.tweet_created_at,
      tiboPrimaryTweetId: teaserTweet.tweet_id,
      tiboSourceTweetIds: [teaserTweet.tweet_id],
      corroboratingTiboTweetId: teaserTweet.tweet_id,
      usageObservation: recoveryObservation,
    });

    const events = findNoticeBackedRecoveryEvents([teaserTweet as any], [recoveryObservation], [estimate!]);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "5時間制限復活に伴うリセット");
    assert.equal(events[0].details?.reasonType, "詫びリセット");
    assert.equal(events[0].details?.noticeType, "匂わせ投稿あり");
    // 2026-08-25T01:16:11.000Z to 2026-08-25T14:13:31.428Z = 777 mins = 12h 57m
    assert.equal(events[0].details?.noticeToExecution, "12時間57分");
    assert.equal(events[0].window_minutes, 777);
    assert.equal(events[0].completed_at, "2026-08-25T14:13:31.428Z");
  });

  it("16. official_notice -> 公式予告あり + 告知から実施まで 表示", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-official-notice",
      sourceKey: "local-codex-app-server",
      observedAt: "2026-08-25T14:00:00.000Z",
      previousObservedAt: "2026-08-25T13:58:00.000Z",
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const officialNoticeTweet: ActiveTiboSignal = {
      tweet_id: "official-notice-1",
      text: "We will reset all usage limits in 2 hours.",
      tweet_url: "https://x.com/thsottiaux/status/official-notice-1",
      signal_type: "official_notice",
      confidence: 0.98,
      verification_status: "confirmed",
      tweet_created_at: "2026-08-25T12:00:00.000Z",
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `tibo-reset-${officialNoticeTweet.tweet_id}`,
      officialNoticeTweetId: officialNoticeTweet.tweet_id,
      officialNoticeAt: officialNoticeTweet.tweet_created_at,
      tiboSourceTweetIds: [officialNoticeTweet.tweet_id],
      usageObservation: recoveryObservation,
    });

    const events = findNoticeBackedRecoveryEvents([officialNoticeTweet as any], [recoveryObservation], [estimate!]);
    assert.equal(events.length, 1);
    assert.equal(events[0].details?.noticeType, "公式予告あり");
    assert.equal(events[0].details?.noticeToExecution, "2時間");
    assert.equal(events[0].window_minutes, 120);
  });

  it("17. completion postだけ -> 告知から実施までの起点にしない & executionAt不変", () => {
    const recoveryObservation: CodexRecoveryObservation = {
      id: "rec-comp-only",
      sourceKey: "local-codex-app-server",
      observedAt: OBSERVATION_TIME,
      previousObservedAt: PREVIOUS_TIME,
      previousUsedPercent: 80,
      currentUsedPercent: 0,
      previousResetsAt: 1788000000,
      currentResetsAt: 1788604800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: null,
    };

    const completionTweet: ActiveTiboSignal = {
      tweet_id: "comp-only-1",
      text: "We just reset all Codex weekly usage quotas.",
      tweet_url: "https://x.com/thsottiaux/status/comp-only-1",
      signal_type: "reset_executed",
      confidence: 0.98,
      verification_status: "confirmed",
      tweet_created_at: "2026-08-26T01:45:00.000Z",
    };

    const estimate = buildResetExecutionEstimate({
      resetEventKey: `usage-reset-${recoveryObservation.id}`,
      tiboAnnouncedAt: completionTweet.tweet_created_at,
      tiboPrimaryTweetId: completionTweet.tweet_id,
      tiboSourceTweetIds: [completionTweet.tweet_id],
      usageObservation: recoveryObservation,
      isMonitorObserved: true,
    });

    const events = findNoticeBackedRecoveryEvents([completionTweet as any], [recoveryObservation], [estimate!]);
    assert.equal(events.length, 1);
    assert.equal(events[0].details?.noticeType, "なし");
    assert.equal(events[0].details?.noticeToExecution, "");
    assert.equal(events[0].completed_at, OBSERVATION_TIME);
  });
});
