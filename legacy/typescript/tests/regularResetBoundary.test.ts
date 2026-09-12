import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import {
  createObservedRegularResetEventRow,
  type RegularResetEventRow,
} from "../lib/radar/regularResetSchedule";
import {
  getLastRandomRecoveryResetAt,
  getRecoveryResetEvents,
} from "../lib/radar/recoveryBoundary";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import { getLatestRegularScheduleAnchorAt } from "../lib/radar";
import { getLastResetBoundaryAt } from "../lib/radar/probability";
import {
  combineResetHistory,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import type { RadarData, WindowEventLike } from "../lib/radar/types";

const REGULAR_AT = "2026-08-20T03:34:43.341Z";
const NOW = new Date("2026-08-20T04:00:00.000Z");

function regularEvent(completedAt = REGULAR_AT): RegularResetEventRow {
  return regularEventAt(REGULAR_AT, completedAt);
}

function regularEventAt(scheduledAt: string, completedAt = scheduledAt): RegularResetEventRow {
  return createObservedRegularResetEventRow(scheduledAt, completedAt);
}

function regularHistoryEventAt(scheduledAt: string, completedAt = scheduledAt): WindowEventLike {
  return {
    id: `regular-history-${scheduledAt}`,
    recordKind: "regular_completed",
    title: "定期リセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: scheduledAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "任意リセット未使用アカウント",
    details: {
      cycleType: "定期リセット",
      reasonType: "定期更新",
      resetMethod: "強制リセット",
      scope: "任意リセット未使用アカウント",
      noticeToExecution: "0分（定期）",
    },
  };
}

function withLocalHistory<T>(history: WindowEventLike[], callback: () => T): T {
  const original = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...history);
  try {
    return callback();
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...original);
  }
}

function randomSignal(
  tweetCreatedAt: string,
  tweetId: string,
): FormalTiboResetSignal {
  return {
    tweet_id: tweetId,
    text: "I have reset usage limits for Codex and ChatGPT Work.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: tweetCreatedAt,
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "confirmed",
    classification_source: "rule",
    is_reply: false,
  };
}

function radarData(
  regularResetEvents: RegularResetEventRow[],
  formalTiboResets: FormalTiboResetSignal[],
  rejectedTiboResets: Array<{ tweet_id: string; tweet_url: string; tweet_created_at: string }> = [],
): RadarData {
  return {
    regular_reset_events: regularResetEvents,
    formal_tibo_resets: formalTiboResets,
    rejected_tibo_resets: rejectedTiboResets,
  } as RadarData;
}

test("regular and random resets remain separate across history and recovery boundaries", () => {
  const random = randomSignal("2026-08-20T03:37:00.000Z", "random-near-regular");
  const combined = combineResetHistory([], [random], [], [regularEvent()]);

  assert.equal(combined.length, 2);
  assert.deepEqual(
    new Set(combined.map((item) => item.details?.cycleType)),
    new Set(["定期リセット", "ランダムリセット"]),
  );

  const randomHistory = combined.find((item) => item.details?.cycleType === "ランダムリセット");
  assert.ok(randomHistory);
  assert.equal(
    isEligibleRandomResetEvent(randomHistory, Date.parse(random.tweet_created_at), NOW.getTime()),
    true,
  );

  const boundaries = getRecoveryResetEvents(radarData([regularEvent()], [random]), NOW, []);
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries.filter((boundary) => boundary.isRandom).length, 1);
  assert.equal(boundaries.filter((boundary) => boundary.isRegular).length, 1);
});

test("random teaser cutoff ignores regular-only boundaries and uses the latest random boundary", () => {
  const regularOnly = getLastRandomRecoveryResetAt(
    radarData([regularEvent()], []),
    NOW,
    [],
  );
  assert.equal(regularOnly, null);

  const random = randomSignal("2026-08-20T03:37:00.000Z", "random-cutoff");
  const withBoth = getLastRandomRecoveryResetAt(
    radarData([regularEvent()], [random]),
    NOW,
    [],
  );
  assert.equal(withBoth, "2026-08-20T03:37:00.000Z");
});

test("cross-type recovery boundaries never use the time-only five-minute merge", () => {
  for (const [label, deltaMs] of [["1 second", 1_000], ["4:59", 299_000], ["5:00", 300_000]] as const) {
    const randomAt = new Date(Date.parse(REGULAR_AT) + deltaMs).toISOString();
    const random = randomSignal(randomAt, `random-${label}`);
    const boundaries = getRecoveryResetEvents(radarData([regularEvent()], [random]), NOW, []);
    assert.equal(boundaries.length, 2, label);
  }
});

test("same-type formal reset dedupe remains unchanged outside the cross-type case", () => {
  const close = getRecoveryResetEvents(
    radarData([], [
      randomSignal(REGULAR_AT, "random-same-type-1"),
      randomSignal(new Date(Date.parse(REGULAR_AT) + 299_000).toISOString(), "random-same-type-2"),
    ]),
    NOW,
    [],
  );
  const separate = getRecoveryResetEvents(
    radarData([], [
      randomSignal(REGULAR_AT, "random-separate-1"),
      randomSignal(new Date(Date.parse(REGULAR_AT) + 301_000).toISOString(), "random-separate-2"),
    ]),
    NOW,
    [],
  );

  assert.equal(close.length, 1);
  assert.equal(close[0].isRandom, true);
  assert.equal(separate.length, 2);
  assert.equal(separate.every((boundary) => boundary.isRandom), true);
});

test("time-only rejected Tibo proximity never removes a canonical regular boundary", () => {
  for (const [label, deltaMs] of [["1 second", 1_000], ["4:59", 299_000], ["5:00", 300_000]] as const) {
    const rejectedAt = new Date(Date.parse(REGULAR_AT) + deltaMs).toISOString();
    const rejected = {
      tweet_id: `rejected-${label}`,
      tweet_url: `https://x.com/thsottiaux/status/rejected-${label}`,
      tweet_created_at: rejectedAt,
    };
    const data = radarData([regularEvent()], [], [rejected]);
    const combined = combineResetHistory([], [], [rejected], [regularEvent()]);

    assert.equal(combined.length, 1, label);
    assert.equal(combined[0].details?.cycleType, "定期リセット", label);
    assert.equal(getLatestRegularScheduleAnchorAt(data, NOW), REGULAR_AT, label);
    assert.equal(getLastResetBoundaryAt(data, NOW)?.toISOString(), REGULAR_AT, label);
  }
});

test("time-only rejected Tibo proximity still removes a matching random candidate", () => {
  const random = {
    id: "random-rejected-candidate",
    recordKind: "confirmed_global" as const,
    status: "closed",
    closed_at: REGULAR_AT,
    completed_at: REGULAR_AT,
    source_url: "https://x.com/thsottiaux/status/random-rejected-candidate",
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  } as WindowEventLike;
  const rejected = {
    tweet_id: "rejected-random-candidate",
    tweet_url: "https://x.com/thsottiaux/status/rejected-random-candidate",
    tweet_created_at: "2026-08-20T03:36:00.000Z",
  };

  assert.deepEqual(combineResetHistory([random], [], [rejected], []), []);
});

test("regular forecast auto-completes the due occurrence without a monitor observation", () => {
  const anchorAt = "2026-08-13T03:34:43.341Z";
  const expectedAt = "2026-08-20T03:34:43.341Z";
  const beforeNow = new Date("2026-08-20T03:34:43.340Z");
  const beforeForecast = withLocalHistory([regularHistoryEventAt(anchorAt)], () => {
    const data = getLocalRadarData({ calculationNow: beforeNow });
    return getRadarViewModel(data, "ja", false, undefined, beforeNow).regularResetForecast;
  });
  assert.equal(beforeForecast.expectedAt, expectedAt);
  assert.equal(beforeForecast.isNoticeWindow, true);
  assert.equal(beforeForecast.remaining.startsWith("-") || beforeForecast.remaining.includes("-"), false);
  assert.ok((beforeForecast.remainingDays ?? 0) >= 0);

  const dueNow = new Date("2026-08-20T03:35:00.000Z");
  const dueData = getLocalRadarData({ calculationNow: dueNow });
  const dueViewModel = withLocalHistory([regularHistoryEventAt(anchorAt)], () => {
    return getRadarViewModel(dueData, "ja", false, undefined, dueNow);
  });
  const projectedRegular = dueViewModel.recentHistory.find(
    (item) => item.recordKind === "regular_completed" && item.resetAt === expectedAt,
  );
  assert.ok(projectedRegular);
  assert.equal(dueViewModel.regularResetForecast.sourceResetAt, expectedAt);
  assert.equal(dueViewModel.regularResetForecast.expectedAt, "2026-08-27T03:34:43.341Z");
  assert.equal(dueViewModel.regularResetForecast.isNoticeWindow, false);
  assert.equal(dueData.regular_reset_events?.length ?? 0, 0);

  const completionNow = new Date("2026-08-20T03:40:00.000Z");
  const completedForecast = withLocalHistory([regularHistoryEventAt(anchorAt)], () => {
    const data = getLocalRadarData({
      calculationNow: completionNow,
      regularResetEvents: [regularEventAt(expectedAt, "2026-08-20T03:36:00.000Z")],
    });
    return getRadarViewModel(data, "ja", false, undefined, completionNow).regularResetForecast;
  });
  assert.equal(completedForecast.expectedAt, "2026-08-27T03:36:00.000Z");
});
