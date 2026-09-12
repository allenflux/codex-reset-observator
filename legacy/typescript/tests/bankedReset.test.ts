import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  ASTRA_BANKED_HISTORY_EVENT_KEY,
  ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY,
  BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
  BANKED_NOTICE_MATCH_WINDOW_MS,
  isManualBroadBankedScopeCorrection,
  isBankedDistributionCompletionSignal,
  hasFutureBankedDistributionIntent,
  isBankedDistributionNotice,
  getBankedDistributionEventKey,
  isBankedDistributionEstimatorVersion,
  isConditionalBankedDistributionNotice,
  isRecurringConditionalBankedDistributionNotice,
  isBroadBankedDistributionNotice,
  isBankedObservationWithinNoticeWindow,
} from "../lib/radar/bankedReset";
import { isBankedResetAvailableCountGrant } from "../lib/codexUsageRecovery";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import { getLastGlobalResetAt, getRecent7DayResetCount } from "../lib/radar/probability";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { collectBoundaryCensoredBoundaries } from "../lib/radar/boundaryCensoredProbability";
import { selectEligibleCommunicationEvents } from "../lib/radar/communicationRegime";
import { calculateRandomContinuousBandwidthShadowPair } from "../lib/radar/randomContinuousBandwidthShadow";
import { calculateRandomContinuousProbability } from "../lib/radar/randomContinuousProbability";
import { getLastRandomRecoveryResetAt, getRecoveryResetEvents } from "../lib/radar/recoveryBoundary";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import { getShadowCompletedResetEvents } from "../lib/radar/shadowProbability";
import { calculateNextGenerationBPostResetAgeCandidate } from "../lib/radar/nextGenerationProbability";
import {
  combineResetHistory,
  findRelatedBankedDistributionNotices,
  findBankedDistributionEvents,
  getNoticeBackedHistoryInputs,
  type TiboNoticeSignal,
} from "../lib/radar/tiboHistory";

const notice = {
  tweet_id: "banked-notice-1",
  text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
  tweet_url: "https://x.com/thsottiaux/status/banked-notice-1",
  tweet_created_at: "2026-08-21T12:00:00.000Z",
  signal_type: "official_notice" as const,
  confidence: 0.96,
  verification_status: "auto_unverified" as const,
};

const estimate = {
  resetEventKey: "banked-reset-banked-notice-1",
  displayExecutionAt: "2026-08-21T13:00:00.000Z",
  executionTimeSource: "usage_observation" as const,
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
};

test("uses the dedicated BANKED distribution estimator version", () => {
  assert.equal(BANKED_DISTRIBUTION_ESTIMATOR_VERSION, "banked-distribution-observation-v2");
});

test("accepts only the canonical and Production legacy BANKED estimator versions", () => {
  assert.equal(isBankedDistributionEstimatorVersion("banked-distribution-observation-v2"), true);
  assert.equal(isBankedDistributionEstimatorVersion("usage-execution-banked-v1"), true);
  assert.equal(isBankedDistributionEstimatorVersion("usage-execution-v1"), false);
  assert.equal(isBankedDistributionEstimatorVersion("usage-execution-monitor-v1"), false);
  assert.equal(isBankedDistributionEstimatorVersion(null), false);
});

test("keeps Astra broad-scope correction limited to the two exact event keys", () => {
  assert.equal(isManualBroadBankedScopeCorrection(ASTRA_BANKED_HISTORY_EVENT_KEY), true);
  assert.equal(isManualBroadBankedScopeCorrection(ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY), true);
  assert.equal(isManualBroadBankedScopeCorrection("2095651088502591861"), false);
  assert.equal(
    isManualBroadBankedScopeCorrection(`${ASTRA_BANKED_HISTORY_EVENT_KEY}-other-observation`),
    false,
  );
  assert.equal(isManualBroadBankedScopeCorrection("banked-reset-unrelated"), false);
});

test("recognizes a broad BANKED distribution notice without treating generic reset wording as one", () => {
  const text = "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.";

  assert.equal(isBankedDistributionNotice(text), true);
  assert.equal(isBroadBankedDistributionNotice(text), true);
  assert.equal(isBankedDistributionNotice("The reset button is my favorite product feature."), false);
  assert.equal(isBroadBankedDistributionNotice("I received a BANKED reset."), false);
  assert.equal(isBroadBankedDistributionNotice("I gave all my friends a BANKED reset."), false);
});

test("recognizes future BANKED execution language without treating personal operations as notices", () => {
  const text = "We will do the full banked reset today too for all Plus, Pro and Business users.";

  assert.equal(isBankedDistributionNotice(text), true);
  assert.equal(isBroadBankedDistributionNotice(text), true);
  assert.equal(isConditionalBankedDistributionNotice(text), false);

  for (const negative of [
    "You can do a banked reset whenever you want.",
    "I did a banked reset.",
    "Here's how to do a banked reset.",
    "We will do a reset.",
    "Banked resets are useful.",
    "I gave all my friends a BANKED reset.",
  ]) {
    assert.equal(isBankedDistributionNotice(negative), false, negative);
  }
});

test("keeps BANKED completion detection plural-aware and clause-local", () => {
  for (const text of [
    "The banked reset has landed.",
    "The banked resets have landed.",
    "The reset credit has arrived.",
    "The reset credits have arrived.",
    "The banked resets have been distributed.",
    "The reset credits are now available.",
  ]) {
    assert.equal(isBankedDistributionCompletionSignal(text), true, text);
  }

  for (const text of [
    "The banked resets have landed. See you tomorrow.",
    "The banked resets have landed. More ships next week.",
    "The reset credits are now available. We will announce something later.",
    "The banked resets have landed. We will issue another BANKED reset tomorrow.",
  ]) {
    assert.equal(isBankedDistributionCompletionSignal(text), true, text);
  }

  for (const text of [
    "The banked reset will land tomorrow.",
    "The banked resets will be distributed tomorrow.",
    "The reset credits will be available next week.",
  ]) {
    assert.equal(isBankedDistributionCompletionSignal(text), false, text);
  }

  assert.equal(hasFutureBankedDistributionIntent("The banked resets have landed."), false);
  assert.equal(
    hasFutureBankedDistributionIntent(
      "The banked resets have landed. We will issue another BANKED reset tomorrow.",
    ),
    true,
  );
});

test("separates individual BANKED operations from broad speaker-led distribution", () => {
  for (const text of [
    "I will use my BANKED reset.",
    "I used my BANKED reset.",
    "I did a BANKED reset for myself.",
    "You can use your BANKED reset whenever you want.",
    "Here is how to use your BANKED reset.",
    "I just used one of my reset credits.",
  ]) {
    assert.equal(isBankedDistributionNotice(text), false, text);
  }

  for (const text of [
    "I will give everyone a BANKED reset today.",
    "I will give all Plus users a BANKED reset.",
    "We will grant every Pro user a BANKED reset.",
    "I am giving all paid users a BANKED reset.",
    "We will distribute BANKED resets to everyone.",
  ]) {
    assert.equal(isBankedDistributionNotice(text), true, text);
    assert.equal(isBroadBankedDistributionNotice(text), true, text);
  }
});

test("recognizes limited paid-plan audiences and keeps later eligibility cutoffs local", () => {
  const target = "We will do the full banked reset today too for all Plus, Pro and Business users. PS: If you create the account or upgrade before 8pm PT you will get it too.";

  assert.equal(isBroadBankedDistributionNotice(target), true);
  assert.equal(isConditionalBankedDistributionNotice(target), false);
  assert.equal(isConditionalBankedDistributionNotice("We will give a BANKED reset to all users who still don't have Astra."), true);
  assert.equal(isConditionalBankedDistributionNotice("We will give a BANKED reset to all paid users without Astra."), true);
  assert.equal(isConditionalBankedDistributionNotice("We will give a BANKED reset to every user who meets the requirement."), true);

  for (const scope of [
    "all Plus users",
    "all Plus and Pro users",
    "all Plus, Pro and Business users",
    "all Plus, Pro, Business and Enterprise users",
  ]) {
    assert.equal(
      isBroadBankedDistributionNotice(`We will give a BANKED reset to ${scope}.`),
      true,
      scope,
    );
  }

  for (const scope of ["some Plus users", "selected Business users", "few Pro users"]) {
    assert.equal(
      isBroadBankedDistributionNotice(`We will give a BANKED reset to ${scope}.`),
      false,
      scope,
    );
  }
});

test("classifies the target BANKED announcement for existing matching without changing its identity", () => {
  const targetNotice = {
    ...notice,
    tweet_id: "2096035437299237298",
    text: "Because we are beyond happy to have Astra rolled out today ahead of schedule and you have been super patient with us (not really, but it’s ok!)… we will do the full banked reset today too for all Plus, Pro and Business users. Lands end of day. Happy Astra day and enjoy a phenomenal weekend. PS: If you create the account or upgrade before 8pm PT you will get it too. Still time!",
    tweet_url: "https://x.com/thsottiaux/status/2096035437299237298",
    tweet_created_at: "2026-09-05T00:39:25.000Z",
  };
  const targetEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-2096035437299237298",
    displayExecutionAt: "2026-09-05T07:00:00.000Z",
    tiboAnnouncedAt: targetNotice.tweet_created_at,
    tiboPrimaryTweetId: targetNotice.tweet_id,
    tiboSourceTweetIds: [targetNotice.tweet_id],
    officialNoticeTweetId: targetNotice.tweet_id,
    officialNoticeAt: targetNotice.tweet_created_at,
  };

  assert.equal(isBankedDistributionNotice(targetNotice.text), true);
  assert.equal(isBroadBankedDistributionNotice(targetNotice.text), true);
  assert.equal(isConditionalBankedDistributionNotice(targetNotice.text), false);
  const events = findBankedDistributionEvents([targetNotice], [targetEstimate]);
  assert.equal(events[0]?.recordKind, "banked_distribution");
  assert.equal(events[0]?.id, targetEstimate.resetEventKey);
});

test("recognizes the generalized paid ChatGPT-plan condition in the Astra BANKED announcement", () => {
  const text = "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can.\n\nFirst one will land in ~ 3 hours. There is still time to create your account if you don't have one.";

  assert.equal(isBankedDistributionNotice(text), true);
  assert.equal(isBroadBankedDistributionNotice(text), true);
  assert.equal(isBroadBankedDistributionNotice("I gave you one banked reset."), false);
  assert.equal(isBroadBankedDistributionNotice("I can give you one banked reset for every day you don't have access to Astra on your paid ChatGPT plan."), false);
  assert.equal(isRecurringConditionalBankedDistributionNotice(text), true);
  assert.equal(
    isRecurringConditionalBankedDistributionNotice(
      "We will give a banked reset to everyone who does not have access to Astra.",
    ),
    false,
  );
  assert.equal(isBroadBankedDistributionNotice("Your banked reset is ready."), false);
  assert.equal(isBroadBankedDistributionNotice("You have 2 banked resets."), false);
  assert.equal(isBroadBankedDistributionNotice("A paid ChatGPT user got one reset."), false);
  assert.equal(isBroadBankedDistributionNotice("My paid ChatGPT plan has a reset."), false);
});

test("a BANKED completion post does not create generic or distribution history by itself", () => {
  const completion = {
    ...notice,
    tweet_id: "banked-completion-only",
    text: "The banked reset has landed, I repeat, the banked reset has landed.",
    tweet_url: "https://x.com/thsottiaux/status/banked-completion-only",
    signal_type: "reset_executed" as const,
    classification_source: "gemini",
  };

  assert.equal(isBankedDistributionCompletionSignal(completion.text), true);
  const history = combineResetHistory([], [completion], [], [], [notice], [], []);
  assert.equal(history.some((item) => item.recordKind === "confirmed_global"), false);
  assert.equal(history.some((item) => item.recordKind === "banked_distribution"), false);
});

test("recognizes a future BANKED availability promise and its explicit broad scope", () => {
  const text = "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.";

  assert.equal(isBankedDistributionNotice(text), true);
  assert.equal(isBroadBankedDistributionNotice(text), true);
  assert.equal(isBankedDistributionNotice("The reset button will be there by 8pm."), false);
  assert.equal(isBankedDistributionNotice("The banked reset was there yesterday."), false);
  assert.equal(isBroadBankedDistributionNotice("The banked reset will be available."), false);
});

test("accepts only a positive explicit BANKED reset count transition", () => {
  assert.equal(isBankedResetAvailableCountGrant(0, 1), true);
  assert.equal(isBankedResetAvailableCountGrant(1, 2), true);
  assert.equal(isBankedResetAvailableCountGrant(1, 0), false);
  assert.equal(isBankedResetAvailableCountGrant(1, 1), false);
  assert.equal(isBankedResetAvailableCountGrant(null, 1), false);
});

test("gives persistent BANKED observations stable, distinct event keys", () => {
  const noticeTweetId = "2095651088502591861";
  const firstObservedAt = "2026-09-04T03:34:46.386Z";
  const secondObservedAt = "2026-09-05T03:34:46.386Z";
  const firstKey = `banked-reset-${noticeTweetId}`;
  const secondKey = `${firstKey}-observation-20260905T033446386Z`;

  assert.equal(getBankedDistributionEventKey({
    noticeTweetId,
    observedAt: firstObservedAt,
    persistent: true,
  }), firstKey);
  assert.equal(getBankedDistributionEventKey({
    noticeTweetId,
    observedAt: secondObservedAt,
    persistent: true,
    previousGrantAt: firstObservedAt,
    previousEventKey: firstKey,
  }), secondKey);
  assert.equal(getBankedDistributionEventKey({
    noticeTweetId,
    observedAt: secondObservedAt,
    persistent: true,
    previousGrantAt: secondObservedAt,
    previousEventKey: secondKey,
  }), secondKey);
  assert.equal(getBankedDistributionEventKey({
    noticeTweetId,
    observedAt: secondObservedAt,
    persistent: false,
    previousGrantAt: firstObservedAt,
    previousEventKey: firstKey,
  }), firstKey);
});

test("matches a credit observation to the resolved BANKED notice window", () => {
  const notice = {
    observedAt: "2026-08-21T12:00:00.000Z",
    expectedAt: "2026-08-21T12:30:00.000Z",
    expectedEndAt: "2026-08-22T07:00:00.000Z",
  };

  assert.equal(isBankedObservationWithinNoticeWindow(notice, "2026-08-21T12:29:00.000Z"), true);
  assert.equal(isBankedObservationWithinNoticeWindow(notice, "2026-08-22T08:31:00.000Z"), false);
  assert.equal(BANKED_NOTICE_MATCH_WINDOW_MS, 90 * 60 * 1000);
});

test("falls back to the announcement matching window when the notice has no resolved time", () => {
  const notice = {
    observedAt: "2026-08-21T12:00:00.000Z",
    expectedAt: null,
    expectedEndAt: null,
  };

  assert.equal(isBankedObservationWithinNoticeWindow(notice, "2026-08-21T13:29:00.000Z"), true);
  assert.equal(isBankedObservationWithinNoticeWindow(notice, "2026-08-21T13:31:00.000Z"), false);
});

test("does not create a BANKED history event from a notice alone", () => {
  const history = combineResetHistory([], [], [], [], [notice], [], []);
  assert.equal(history.some((item) => item.recordKind === "banked_distribution"), false);
});

test("creates one eligible banked_distribution from corroborated observation evidence", () => {
  const history = combineResetHistory([], [], [], [], [notice], [], [estimate, estimate]);
  const banked = history.filter((item) => item.recordKind === "banked_distribution");

  assert.equal(banked.length, 1);
  assert.equal(banked[0].title, "ランダムリセット");
  assert.equal(banked[0].details?.cycleType, "ランダムリセット");
  assert.equal(banked[0].details?.resetMethod, "任意リセット権配布");
  assert.equal(banked[0].completed_at, estimate.displayExecutionAt);
  assert.equal(banked[0].officialNoticeTweetId, notice.tweet_id);
});

test("creates the observed Astra BANKED event without promoting it to generic global history", () => {
  const astraNotice = {
    ...notice,
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can.\n\nFirst one will land in ~ 3 hours. There is still time to create your account if you don't have one.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    confidence: 0.98,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:12:09.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const astraEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-2095651088502591861",
    displayExecutionAt: "2026-09-04T03:34:46.386Z",
    tiboAnnouncedAt: "2026-09-03T23:12:09.000Z",
    tiboPrimaryTweetId: "2095651088502591861",
    tiboSourceTweetIds: ["2095651088502591861"],
    officialNoticeTweetId: "2095651088502591861",
    officialNoticeAt: "2026-09-03T23:12:09.000Z",
  };

  const history = combineResetHistory([], [], [], [], [astraNotice], [], [astraEstimate]);
  const banked = history.filter((item) => item.recordKind === "banked_distribution");

  assert.equal(banked.length, 1);
  assert.equal(banked[0]?.id, "banked-reset-2095651088502591861");
  assert.equal(banked[0]?.opened_at, "2026-09-03T23:12:09.000Z");
  assert.equal(banked[0]?.completed_at, "2026-09-04T03:34:46.386Z");
  assert.equal(banked[0]?.details?.cycleType, "ランダムリセット");
  assert.equal(history.some((item) => item.recordKind === "confirmed_global"), false);

  const data = getLocalRadarData({
    calculationNow: new Date("2026-09-04T04:00:00.000Z"),
    recentTiboSignals: [astraNotice],
    resetExecutionEstimates: [astraEstimate],
  });
  const expected = {
    ja: {
      title: "GPT-6 Astraリリース記念BANKEDリセット配布",
      classification: "ランダムリセット",
      reason: "ご祝儀リセット",
      method: "任意リセット権配布",
      scope: "全有料プラン",
      noticeType: "告知あり",
      noticeToExecution: "4時間23分",
      note: "GPT-6 Astraの提供開始にあわせ、BANKEDリセットが配布されました。配布は一斉ではなく、順次行われる場合があります。",
    },
    en: {
      title: "GPT-6 Astra Launch BANKED Reset Distribution",
      classification: "Random reset",
      reason: "Celebration reset",
      method: "Banked Reset distribution",
      scope: "All paid plans",
      noticeType: "Announcement",
      noticeToExecution: "4 hours 23 minutes",
      note: "To mark the GPT-6 Astra launch, a BANKED Reset was distributed. Distribution may take place progressively rather than all at once.",
    },
    zh: {
      title: "GPT-6 Astra 发布纪念 BANKED 重置发放",
      classification: "随机重置",
      reason: "庆祝重置",
      method: "BANKED 重置发放",
      scope: "所有付费套餐",
      noticeType: "有告知",
      noticeToExecution: "4 小时 23 分钟",
      note: "配合 GPT-6 Astra 发布，已发放 BANKED 重置。发放可能会分批进行，而不是一次性全部到账。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, {
      calculationNow: new Date("2026-09-04T04:00:00.000Z"),
      limitHistory: false,
    });
    const publicBanked = snapshot.viewModel.recentHistory.find((item) => item.key === "banked-reset-2095651088502591861");
    assert.ok(publicBanked, `${locale} Astra BANKED history should be present`);
    assert.equal(publicBanked.resetAt, "2026-09-04T03:34:46.386Z");
    assert.equal(publicBanked.executionTimePrecision, "approximate");
    assert.equal(publicBanked.title, expected[locale].title);
    assert.equal(publicBanked.details?.cycleType, expected[locale].classification);
    assert.equal(publicBanked.details?.reasonType, expected[locale].reason);
    assert.equal(publicBanked.details?.resetMethod, expected[locale].method);
    assert.equal(publicBanked.details?.scope, expected[locale].scope);
    assert.equal(publicBanked.scope, expected[locale].scope);
    assert.equal(publicBanked.details?.noticeType, expected[locale].noticeType);
    assert.equal(publicBanked.details?.noticeToExecution, expected[locale].noticeToExecution);
    assert.equal(publicBanked.details?.note, expected[locale].note);
  }
});

test("applies the corrected all-paid scope to both observed Astra BANKED events", () => {
  const astraNotice = {
    ...notice,
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    confidence: 0.98,
  };
  const firstEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-2095651088502591861",
    displayExecutionAt: "2026-09-04T03:34:46.386Z",
    tiboAnnouncedAt: astraNotice.tweet_created_at,
    tiboPrimaryTweetId: astraNotice.tweet_id,
    tiboSourceTweetIds: [astraNotice.tweet_id],
    officialNoticeTweetId: astraNotice.tweet_id,
    officialNoticeAt: astraNotice.tweet_created_at,
  };
  const secondEstimate = {
    ...firstEstimate,
    resetEventKey: "banked-reset-2095651088502591861-observation-20260904T234601897Z",
    displayExecutionAt: "2026-09-04T23:46:01.897Z",
    tiboSourceTweetIds: [],
    estimatorVersion: "usage-execution-banked-v1",
  };

  const data = getLocalRadarData({
    calculationNow: new Date("2026-09-05T01:00:00.000Z"),
    recentTiboSignals: [astraNotice],
    resetExecutionEstimates: [firstEstimate, secondEstimate],
  });
  const events = combineResetHistory(
    [],
    [],
    [],
    [],
    [astraNotice],
    [],
    [firstEstimate, secondEstimate],
    [astraNotice],
  ).filter((item) => item.recordKind === "banked_distribution");

  assert.deepEqual(events.map((item) => item.id), [
    firstEstimate.resetEventKey,
    secondEstimate.resetEventKey,
  ]);
  for (const event of events) {
    assert.equal(event.scope, "全有料プラン");
    assert.equal(event.details?.scope, "全有料プラン");
    assert.equal(event.randomResetTargetScope, undefined);
    assert.equal(
      isEligibleRandomResetEvent(event, Date.parse(event.completed_at ?? ""), Date.parse("2026-09-05T01:00:00.000Z")),
      true,
    );
  }

  const expectedScope = {
    ja: "全有料プラン",
    en: "All paid plans",
    zh: "所有付费套餐",
  } as const;
  const expectedTitles = {
    ja: {
      first: "GPT-6 Astraリリース記念BANKEDリセット配布",
      second: "GPT-6 Astraリリース記念リセット（2回目）",
    },
    en: {
      first: "GPT-6 Astra Launch BANKED Reset Distribution",
      second: "GPT-6 Astra Launch Celebration Reset (2nd)",
    },
    zh: {
      first: "GPT-6 Astra 发布纪念 BANKED 重置发放",
      second: "GPT-6 Astra 发布庆祝重置（第2次）",
    },
  } as const;
  const expectedReasons = {
    ja: "ご祝儀リセット",
    en: "Celebration reset",
    zh: "庆祝重置",
  } as const;
  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, {
      calculationNow: new Date("2026-09-05T01:00:00.000Z"),
      limitHistory: false,
    });
    const publicEvents = snapshot.viewModel.recentHistory.filter((item) =>
      item.key === firstEstimate.resetEventKey || item.key === secondEstimate.resetEventKey,
    );
    assert.equal(publicEvents.length, 2);
    for (const event of publicEvents) {
      assert.equal(
        event.title,
        event.key === firstEstimate.resetEventKey
          ? expectedTitles[locale].first
          : expectedTitles[locale].second,
      );
      assert.equal(event.details?.reasonType, expectedReasons[locale]);
      assert.equal(event.scope, expectedScope[locale]);
      assert.equal(event.details?.scope, expectedScope[locale]);
    }
  }

  assert.equal(
    getLastRandomRecoveryResetAt(data, new Date("2026-09-05T01:00:00.000Z"), []),
    secondEstimate.displayExecutionAt,
  );
});

test("keeps later persistent BANKED observations as separate history events", () => {
  const astraNotice = {
    ...notice,
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
  };
  const firstEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-2095651088502591861",
    displayExecutionAt: "2026-09-04T03:34:46.386Z",
    tiboAnnouncedAt: astraNotice.tweet_created_at,
    tiboPrimaryTweetId: astraNotice.tweet_id,
    tiboSourceTweetIds: [astraNotice.tweet_id],
    officialNoticeTweetId: astraNotice.tweet_id,
    officialNoticeAt: astraNotice.tweet_created_at,
  };
  const secondEstimate = {
    ...firstEstimate,
    resetEventKey: "banked-reset-2095651088502591861-observation-20260905T033446386Z",
    displayExecutionAt: "2026-09-05T03:34:46.386Z",
    tiboSourceTweetIds: [],
    estimatorVersion: "usage-execution-banked-v1",
  };

  const events = findBankedDistributionEvents([astraNotice], [firstEstimate, secondEstimate]);

  assert.deepEqual(events.map((event) => event.id), [
    firstEstimate.resetEventKey,
    secondEstimate.resetEventKey,
  ]);
  assert.deepEqual(events[1]?.sourceTweetIds, [astraNotice.tweet_id]);
});

test("does not treat generic or monitor estimator versions as BANKED distribution events", () => {
  const unsupportedEstimates = [
    { ...estimate, estimatorVersion: "usage-execution-v1" },
    { ...estimate, estimatorVersion: "usage-execution-monitor-v1" },
  ];

  assert.deepEqual(findBankedDistributionEvents([notice], unsupportedEstimates), []);
});

test("excludes an uncorrected conditional BANKED distribution from the random-reset target", () => {
  const astraNotice = {
    ...notice,
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    confidence: 0.98,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:12:09.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const astraEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-conditional-unrelated",
    displayExecutionAt: "2026-09-04T03:34:46.386Z",
    tiboAnnouncedAt: astraNotice.tweet_created_at,
    tiboPrimaryTweetId: astraNotice.tweet_id,
    tiboSourceTweetIds: [astraNotice.tweet_id],
    officialNoticeTweetId: astraNotice.tweet_id,
    officialNoticeAt: astraNotice.tweet_created_at,
  };
  const astraEvent = findBankedDistributionEvents([astraNotice], [astraEstimate])[0];

  assert.ok(astraEvent);
  assert.equal(astraEvent.recordKind, "banked_distribution");
  assert.equal(isBroadBankedDistributionNotice(astraNotice.text), true);
  assert.equal(
    isEligibleRandomResetEvent(
      astraEvent,
      Date.parse(astraEvent.completed_at ?? ""),
      Date.parse("2026-09-04T04:00:00.000Z"),
    ),
    false,
  );
});

test("keeps conditional BANKED history out of every random probability input", () => {
  const astraNotice = {
    ...notice,
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    confidence: 0.98,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:12:09.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const astraEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-conditional-unrelated",
    displayExecutionAt: "2026-09-04T03:34:46.386Z",
    tiboAnnouncedAt: astraNotice.tweet_created_at,
    tiboPrimaryTweetId: astraNotice.tweet_id,
    tiboSourceTweetIds: [astraNotice.tweet_id],
    officialNoticeTweetId: astraNotice.tweet_id,
    officialNoticeAt: astraNotice.tweet_created_at,
  };
  const astraEvent = findBankedDistributionEvents([astraNotice], [astraEstimate])[0];
  const genericEvent = findBankedDistributionEvents([notice], [estimate])[0];
  const previousBroadReset = {
    id: "random-2026-08-31-022450",
    recordKind: "confirmed_global" as const,
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: "2026-08-31T02:24:50.909Z",
    closed_at: "2026-08-31T02:24:50.909Z",
    completed_at: "2026-08-31T02:24:50.909Z",
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  };
  const now = new Date("2026-09-04T04:00:00.000Z");
  assert.ok(astraEvent);
  assert.ok(genericEvent);
  assert.equal(isConditionalBankedDistributionNotice(astraNotice.text), true);
  assert.equal(isConditionalBankedDistributionNotice(notice.text), false);
  assert.equal(isEligibleRandomResetEvent(genericEvent, Date.parse(genericEvent.completed_at ?? ""), now.getTime()), true);
  assert.equal(isEligibleRandomResetEvent(previousBroadReset, Date.parse(previousBroadReset.completed_at ?? ""), now.getTime()), true);

  const history = [previousBroadReset, astraEvent];
  const baseline = calculateRandomContinuousProbability(null, {
    now,
    staticHistory: [previousBroadReset],
  });
  const withAstra = calculateRandomContinuousProbability(null, {
    now,
    staticHistory: history,
  });

  assert.deepEqual(withAstra.randomContinuous.randomBoundaryIds, baseline.randomContinuous.randomBoundaryIds);
  assert.equal(withAstra.randomContinuous.latestRandomResetAt, previousBroadReset.completed_at);
  assert.equal(withAstra.randomContinuous.randomBoundaryCount, baseline.randomContinuous.randomBoundaryCount);
  assert.equal(withAstra.hazard.completedIntervalCount, baseline.hazard.completedIntervalCount);
  assert.equal(withAstra.hazard.weightedEventCount, baseline.hazard.weightedEventCount);
  assert.equal(
    withAstra.randomContinuous.currentKernelWeightedEvents,
    baseline.randomContinuous.currentKernelWeightedEvents,
  );

  assert.deepEqual(getRecoveryResetEvents(null, now, history).map((item) => item.id), [previousBroadReset.id]);
  assert.deepEqual(getShadowCompletedResetEvents(null, now, history).map((item) => item.id), [previousBroadReset.id]);
  assert.deepEqual(
    selectEligibleCommunicationEvents(history, now.getTime()).map((item) => item.id),
    [previousBroadReset.id],
  );
  const censored = collectBoundaryCensoredBoundaries(null, now, history);
  assert.deepEqual(censored.randomEvents.map((item) => item.id), [previousBroadReset.id]);

  const bandwidthPair = calculateRandomContinuousBandwidthShadowPair(null, {
    now,
    staticHistory: history,
  });
  assert.deepEqual(bandwidthPair.control.randomContinuous.randomBoundaryIds, [previousBroadReset.id]);
  assert.deepEqual(bandwidthPair.challenger.randomContinuous.randomBoundaryIds, [previousBroadReset.id]);

  const nextGeneration = calculateNextGenerationBPostResetAgeCandidate(null, {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
  });
  assert.deepEqual(nextGeneration.randomContinuous.randomBoundaryIds, [previousBroadReset.id]);

  const originalHistory = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, previousBroadReset);
  try {
    const data = getLocalRadarData({
      calculationNow: now,
      recentTiboSignals: [astraNotice],
      resetExecutionEstimates: [astraEstimate],
    });
    assert.equal(getLastGlobalResetAt(data, now)?.toISOString(), previousBroadReset.completed_at);
    assert.equal(getRecent7DayResetCount(data, now), 1);
    const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: now, limitHistory: false });
    const publicAstra = snapshot.viewModel.recentHistory.find((item) => item.key === astraEstimate.resetEventKey);
    assert.ok(publicAstra);
    assert.equal(Object.prototype.hasOwnProperty.call(publicAstra, "randomResetTargetScope"), false);
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...originalHistory);
  }
});

test("keeps generic all-paid BANKED scope while localizing its history classification", () => {
  const data = getLocalRadarData({
    calculationNow: new Date("2026-08-22T02:00:00.000Z"),
    recentTiboSignals: [notice],
    resetExecutionEstimates: [estimate],
  });

  const expected = {
    ja: { classification: "ランダムリセット", scope: "全有料プラン" },
    en: { classification: "Random reset", scope: "All paid plans" },
    zh: { classification: "随机重置", scope: "所有付费套餐" },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const item = getRadarViewModel(data, locale, false, undefined, new Date("2026-08-22T02:00:00.000Z"))
      .recentHistory.find((historyItem) => historyItem.recordKind === "banked_distribution");
    assert.ok(item, `${locale} generic BANKED history should be present`);
    assert.equal(item.details?.cycleType, expected[locale].classification);
    assert.equal(item.details?.scope, expected[locale].scope);
    assert.equal(item.scope, expected[locale].scope);
    assert.equal(item.details?.scope, expected[locale].scope);
  }
});

test("does not merge a BANKED distribution into the 2026-09-08 rolling global event", () => {
  const rollingNotice = {
    tweet_id: "2097043464538264003",
    text: "We will do the full banked reset today for all paid users. Lands end of day.",
    tweet_url: "https://x.com/thsottiaux/status/2097043464538264003",
    tweet_created_at: "2026-09-07T19:24:57.000Z",
    signal_type: "official_notice" as const,
    confidence: 0.99,
    verification_status: "confirmed" as const,
  };
  const bankedEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-rolling-notice-separate",
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    tiboPrimaryTweetId: rollingNotice.tweet_id,
    tiboSourceTweetIds: [rollingNotice.tweet_id],
    officialNoticeTweetId: rollingNotice.tweet_id,
    officialNoticeAt: rollingNotice.tweet_created_at,
  };

  const bankedEvent = findBankedDistributionEvents([rollingNotice], [bankedEstimate])[0];
  assert.equal(bankedEvent?.recordKind, "banked_distribution");

  const combined = combineResetHistory(
    LOCAL_RESET_HISTORY,
    [],
    [],
    [],
    [rollingNotice],
    [],
    [bankedEstimate],
  );

  const rolling = combined.find((item) => item.id === "local-codex-rolling-notice-reset-2026-09-08");
  const banked = combined.find((item) => item.id === bankedEstimate.resetEventKey);
  assert.equal(rolling?.recordKind, "confirmed_global");
  assert.equal(banked?.recordKind, "banked_distribution");
  assert.notEqual(rolling?.id, banked?.id);
});

test("does not apply the Astra presentation to another personal or reply-like BANKED event", () => {
  const personalEvent = {
    id: "banked-reset-personal-reply",
    recordKind: "banked_distribution" as const,
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: "2026-08-22T12:00:00.000Z",
    closed_at: "2026-08-22T13:00:00.000Z",
    completed_at: "2026-08-22T13:00:00.000Z",
    window_minutes: 60,
    scope: "全有料プラン",
    summary: "I gave you one banked reset in reply.",
    source_url: "https://x.com/thsottiaux/status/2090000000000000000",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "1時間",
      noticeType: "公式告知あり",
      note: "I gave you one banked reset in reply.",
    },
  };
  const originalHistory = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, personalEvent);

  try {
    const data = getLocalRadarData({ calculationNow: new Date("2026-08-22T14:00:00.000Z") });
    for (const locale of ["ja", "en", "zh"] as const) {
      const item = getRadarViewModel(
        data,
        locale,
        false,
        undefined,
        new Date("2026-08-22T14:00:00.000Z"),
      ).recentHistory[0];
      assert.ok(item, `${locale} personal BANKED history should be present`);
      assert.notEqual(item.title, locale === "ja"
        ? "GPT-6 Astraリリース記念BANKEDリセット配布"
        : locale === "en"
          ? "GPT-6 Astra Launch BANKED Reset Distribution"
          : "GPT-6 Astra 发布纪念 BANKED 重置发放");
      assert.equal(item.details?.scope, locale === "ja" ? "全有料プラン" : locale === "en" ? "All paid plans" : "所有付费套餐");
    }
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...originalHistory);
  }
});

test("uses the accepted event display name for the 20M BANKED event in every locale", () => {
  const banked = findBankedDistributionEvents([notice], [
    { ...estimate, resetEventKey: "banked-reset-2090766694897619318" },
  ])[0];
  const displayName = "2000万人アクティブユーザー突破記念リセット";
  const displayNameRecord = {
    event_key: "banked-reset-2090766694897619318",
    source_tweet_id: notice.tweet_id,
    manual_name_ja: displayName,
    ai_name_ja: null,
    ai_confidence: null,
    ai_evidence: null,
    ai_reason: null,
    ai_model: null,
    ai_prompt_version: null,
    ai_input_mode: null,
    ai_status: null,
    ai_flags: [],
    ai_generated_at: null,
    input_hash: null,
  };

  assert.equal(banked?.title, "ランダムリセット");

  const radarData = getLocalRadarData({
    calculationNow: new Date("2026-08-22T02:00:00.000Z"),
    recentTiboSignals: [notice],
    resetDisplayNames: [displayNameRecord],
    resetExecutionEstimates: [{ ...estimate, resetEventKey: "banked-reset-2090766694897619318" }],
  });
  for (const [locale, expectedTitle] of [
    ["ja", displayName],
    ["en", "20 Million Active Users Milestone Reset"],
    ["zh", "活跃用户突破2000万纪念重置"],
  ] as const) {
    const viewModel = getRadarViewModel(radarData, locale, false, undefined, new Date("2026-08-22T02:00:00.000Z"));
    assert.equal(
      viewModel.recentHistory.find((item) => item.recordKind === "banked_distribution")?.title,
      expectedTitle,
    );
  }
});

test("keeps official notice confidence when recent and active signal rows overlap", () => {
  const recentSignal = { ...notice, confidence: undefined };
  const activeSignal = { ...notice, confidence: 0.98 };
  const inputs = getNoticeBackedHistoryInputs({
    recent_tibo_signals: [recentSignal],
    active_tibo_signals: [activeSignal],
    codex_recovery_observations: [],
    codex_usage_recovery: null,
    reset_execution_estimates: [estimate],
  });

  assert.equal(inputs.noticeSignals[0]?.confidence, 0.98);
  assert.equal(findBankedDistributionEvents(inputs.noticeSignals, inputs.estimates).length, 1);
});

test("accepts a guarded manual BANKED observation without a recovery row", () => {
  const manualEstimate = {
    ...estimate,
    executionTimeSource: "manual_override" as const,
    displayExecutionAt: "2026-08-21T13:00:00.000Z",
    manualOverrideAt: "2026-08-21T13:05:00.000Z",
    manualOverrideBy: "operator",
    manualOverrideReason: "A usage UI observation confirmed availability by this time.",
    manualExecutionAt: "2026-08-21T13:00:00.000Z",
    manualExecutionPrecision: "approximate" as const,
  };
  const history = combineResetHistory([], [], [], [], [notice], [], [manualEstimate]);
  const banked = history.filter((item) => item.recordKind === "banked_distribution");

  assert.equal(banked.length, 1);
  assert.equal(banked[0].completed_at, manualEstimate.displayExecutionAt);
});

test("rejects a manual BANKED observation without its audit evidence", () => {
  const incompleteEstimate = {
    ...estimate,
    executionTimeSource: "manual_override" as const,
    manualExecutionAt: estimate.displayExecutionAt,
    manualExecutionPrecision: "approximate" as const,
  };
  const history = combineResetHistory([], [], [], [], [notice], [], [incompleteEstimate]);

  assert.equal(history.some((item) => item.recordKind === "banked_distribution"), false);
});

test("BANKED history keeps the first announcement while displaying the specific representative notice", () => {
  const followUp: TiboNoticeSignal = {
    ...notice,
    tweet_id: "banked-notice-deadline",
    text: "The banked reset will be there by 8pm PST for all paid users of ChatGPT Work and Codex.",
    tweet_url: "https://x.com/thsottiaux/status/banked-notice-deadline",
    tweet_created_at: "2026-08-21T23:40:34.000Z",
    ai_temporal_precision: "exact_time",
    expected_start_at: "2026-08-21T23:40:34.000Z",
    expected_end_at: "2026-08-22T04:00:00.000Z",
    temporal_resolution_status: "resolved",
  };
  const lowInformation: TiboNoticeSignal = {
    ...notice,
    tweet_id: "banked-notice-low-information",
    text: "Yep, still coming!",
    tweet_url: "https://x.com/thsottiaux/status/banked-notice-low-information",
    tweet_created_at: "2026-08-21T23:45:00.000Z",
  };
  const related = [notice, followUp, lowInformation];
  const mergedEstimate = {
    ...estimate,
    resetEventKey: "banked-reset-banked-notice-1",
    displayExecutionAt: "2026-08-22T00:00:00.000Z",
    tiboAnnouncedAt: notice.tweet_created_at,
    tiboPrimaryTweetId: followUp.tweet_id,
    tiboSourceTweetIds: related.map((item) => item.tweet_id),
    officialNoticeTweetId: followUp.tweet_id,
    officialNoticeAt: followUp.tweet_created_at,
  };
  const history = combineResetHistory([], [], [], [], related, [], [mergedEstimate]);
  const banked = history.find((item) => item.recordKind === "banked_distribution");

  assert.ok(banked);
  assert.equal(banked.opened_at, notice.tweet_created_at);
  assert.equal(banked.officialNoticeTweetId, followUp.tweet_id);
  assert.equal(banked.source_url, followUp.tweet_url);
  assert.deepEqual(banked.sourceTweetIds, related.map((item) => item.tweet_id));
  assert.equal(banked.details?.noticeToExecution, "12時間");
});

test("BANKED notice grouping excludes a separate non-overlapping event", () => {
  const first = {
    ...notice,
    expected_start_at: "2026-08-21T12:00:00.000Z",
    expected_end_at: "2026-08-22T07:00:00.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const sameEvent = {
    ...first,
    tweet_id: "banked-notice-2",
    text: "The banked reset will be there by 8pm PST for all paid users of ChatGPT Work and Codex.",
    tweet_url: "https://x.com/thsottiaux/status/banked-notice-2",
    tweet_created_at: "2026-08-21T23:40:34.000Z",
    ai_temporal_precision: "exact_time" as const,
    expected_start_at: "2026-08-21T23:40:34.000Z",
    expected_end_at: "2026-08-22T04:00:00.000Z",
  };
  const separate = {
    ...first,
    tweet_id: "banked-notice-separate",
    text: "A separate BANKED reset will be available next week for all paid users of ChatGPT Work and Codex.",
    tweet_url: "https://x.com/thsottiaux/status/banked-notice-separate",
    tweet_created_at: "2026-08-22T12:00:00.000Z",
    expected_start_at: "2026-08-28T12:00:00.000Z",
    expected_end_at: "2026-08-29T07:00:00.000Z",
  };

  assert.deepEqual(
    findRelatedBankedDistributionNotices(
      [first, sameEvent, separate],
      sameEvent.tweet_id,
      "2026-08-22T00:00:00.000Z",
    ).map((item) => item.tweet_id),
    [first.tweet_id, sameEvent.tweet_id],
  );
});

test("keeps BANKED completion as provenance without making it representative", () => {
  const completion = {
    ...notice,
    tweet_id: "2090964822422949999",
    text: "The banked reset has landed, I repeat, the banked reset has landed. Have an amazing weekend.",
    tweet_url: "https://x.com/thsottiaux/status/2090964822422949999",
    tweet_created_at: "2026-08-22T00:50:36.000Z",
    signal_type: "irrelevant" as const,
    confidence: 1,
    verification_status: "auto_unverified" as const,
  };
  const inputs = getNoticeBackedHistoryInputs({
    recent_tibo_signals: [notice, completion],
    active_tibo_signals: [],
    codex_recovery_observations: [],
    codex_usage_recovery: null,
    reset_execution_estimates: [],
  });
  const related = findRelatedBankedDistributionNotices(
    inputs.bankedSignals,
    notice.tweet_id,
    "2026-08-22T01:52:00.000Z",
  );

  assert.deepEqual(related.map((signal) => signal.tweet_id), [notice.tweet_id, completion.tweet_id]);

  const estimateWithSources = {
    ...estimate,
    resetEventKey: "banked-reset-2090766694897619318",
    tiboPrimaryTweetId: notice.tweet_id,
    tiboSourceTweetIds: [notice.tweet_id, completion.tweet_id],
    officialNoticeTweetId: notice.tweet_id,
  };
  const event = findBankedDistributionEvents(inputs.bankedSignals, [estimateWithSources])[0];
  assert.ok(event);
  assert.deepEqual(event.sourceTweetIds, [notice.tweet_id, completion.tweet_id]);
  assert.equal(event.officialNoticeTweetId, notice.tweet_id);
  assert.equal(event.opened_at, notice.tweet_created_at);
});

test("BANKED completion provenance alone cannot create a distribution event", () => {
  const completion = {
    ...notice,
    tweet_id: "2090964822422949999",
    text: "The banked reset has landed.",
    tweet_created_at: "2026-08-22T00:50:36.000Z",
    signal_type: "irrelevant" as const,
    confidence: 1,
    verification_status: "auto_unverified" as const,
  };
  const inputs = getNoticeBackedHistoryInputs({
    recent_tibo_signals: [completion],
    active_tibo_signals: [],
    codex_recovery_observations: [],
    codex_usage_recovery: null,
    reset_execution_estimates: [
      {
        ...estimate,
        resetEventKey: "banked-reset-2090964822422949999",
        tiboPrimaryTweetId: completion.tweet_id,
        tiboSourceTweetIds: [completion.tweet_id],
        officialNoticeTweetId: completion.tweet_id,
      },
    ],
  });

  assert.equal(findBankedDistributionEvents(inputs.bankedSignals, inputs.estimates).length, 0);
});

test("a confirmed BANKED distribution becomes the latest eligible random boundary", () => {
  const data = getLocalRadarData({
    recentTiboSignals: [notice],
    resetExecutionEstimates: [estimate],
    calculationNow: new Date("2026-08-21T14:00:00.000Z"),
  });

  assert.equal(
    getLastGlobalResetAt(data, new Date("2026-08-21T14:00:00.000Z"))?.toISOString(),
    estimate.displayExecutionAt,
  );
});
