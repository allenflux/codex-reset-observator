import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  LOCAL_PROBABILITY_WEIGHTS,
  PROBABILITY_MODEL_VERSION,
} from "../data/predictionWeights";
import { buildProbabilityDebugInfo } from "../lib/logProbability";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import type { ActiveOfficialNotice } from "../lib/radar/probability";
import {
  getDaysSinceLastGlobalReset,
  getElapsedDayBoost,
  getLastGlobalResetAt,
  getLocalProbabilityCalculation,
  getRecent7DayResetCount,
} from "../lib/radar/probability";
import type { WindowEventLike } from "../lib/radar/types";
import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";

const DAY_MS = 24 * 60 * 60 * 1000;

function resetEvent(
  id: string,
  completedAt: string,
  overrides: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: "テストリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
    ...overrides,
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

function sumContributionPeriod(
  base: number,
  contributions: Record<string, { probability24h: number; probability48h: number }>,
  period: "probability24h" | "probability48h",
) {
  return base + Object.values(contributions).reduce((sum, item) => sum + item[period], 0);
}

test("fixed calculation time makes probability and audit output reproducible", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  withLocalHistory(
    [resetEvent("reset-1", "2026-08-01T00:00:00.000Z")],
    () => {
      const data = getLocalRadarData({ calculationNow: now });
      const first = getLocalProbabilityCalculation(data, {
        now,
        regularResetExpectedAt: "2026-08-10T00:00:00.000Z",
      });
      const second = getLocalProbabilityCalculation(data, {
        now,
        regularResetExpectedAt: "2026-08-10T00:00:00.000Z",
      });

      assert.deepEqual(second, first);
      assert.equal(first.modelVersion, PROBABILITY_MODEL_VERSION);
      assert.equal(first.inputSnapshot.calculatedAt, now.toISOString());
    },
  );
});

test("strict history classification uses the adopted calibrated public probability", () => {
  const now = new Date("2026-08-04T03:32:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const viewModel = getRadarViewModel(
    data,
    "ja",
    false,
    undefined,
    now,
  );
  const published = calculatePublishedProbability(data, { now }, { logFallback: false });

  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(published.adoptedModel, CALIBRATED_SHADOW_MODEL_VERSION);
  assert.equal(published.source, "calibrated");
  assert.equal(viewModel.probability24h, published.probability24h);
  assert.equal(viewModel.probability48h, published.probability48h);
});

test("elapsed reset time uses fractional real days rather than calendar days", () => {
  const resetAt = new Date("2026-08-01T00:00:00.000Z");
  const now = new Date(resetAt.getTime() + 36 * 60 * 60 * 1000);
  withLocalHistory(
    [resetEvent("reset-1", resetAt.toISOString())],
    () => {
      const data = getLocalRadarData({ calculationNow: now });
      assert.equal(getDaysSinceLastGlobalReset(data, now), 1.5);
      assert.equal(
        getElapsedDayBoost(data, now),
        1.5 * LOCAL_PROBABILITY_WEIGHTS.elapsedDayBoost.perDay,
      );
    },
  );
});

test("latest reset and seven-day count exclude future, pending, opened-only, and invalid records", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const completedAt = new Date(now.getTime() - 2 * DAY_MS).toISOString();
  const history = [
    resetEvent("completed", completedAt),
    resetEvent("future", new Date(now.getTime() + DAY_MS).toISOString()),
    resetEvent("pending-with-time", completedAt, {
      status: "pending",
      closed_at: new Date(now.getTime() - DAY_MS).toISOString(),
      completed_at: new Date(now.getTime() - DAY_MS).toISOString(),
    }),
    {
      ...resetEvent("opened-only", new Date(now.getTime() - DAY_MS).toISOString()),
      kind: "window_opened",
      status: "open",
      closed_at: null,
      completed_at: null,
    },
    resetEvent("invalid", "not-a-date"),
  ];

  withLocalHistory(history, () => {
    const data = getLocalRadarData({ calculationNow: now });
    assert.equal(getLastGlobalResetAt(data, now)?.toISOString(), completedAt);
    assert.equal(getRecent7DayResetCount(data, now), 1);
  });
});

test("latest reset and seven-day count use only broad random reset targets", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const history = [
    resetEvent("regular-forced", "2026-08-09T08:00:00.000Z", {
      details: {
        cycleType: "定期リセット",
        reasonType: "定期更新",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分（定期）",
      },
    }),
    resetEvent("random-credit", "2026-08-09T09:00:00.000Z", {
      recordKind: "banked_distribution",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "ご祝儀リセット",
        resetMethod: "任意リセット権配布",
        scope: "全有料プラン",
        noticeToExecution: "0分",
      },
    }),
    resetEvent("regular-credit", "2026-08-09T10:00:00.000Z", {
      recordKind: "banked_distribution",
      details: {
        cycleType: "定期リセット",
        reasonType: "定期更新",
        resetMethod: "任意リセット権配布",
        scope: "全有料プラン",
        noticeToExecution: "0分（定期）",
      },
    }),
    resetEvent("narrow-credit", "2026-08-09T11:00:00.000Z", {
      recordKind: "banked_distribution",
      scope: "不具合対象ユーザー（約50万人）",
      details: {
        cycleType: "ランダムリセット",
        reasonType: "詫びリセット",
        resetMethod: "任意リセット権配布",
        scope: "不具合対象ユーザー（約50万人）",
        noticeToExecution: "0分",
      },
    }),
  ];

  withLocalHistory(history, () => {
    const data = getLocalRadarData({ calculationNow: now });
    assert.equal(getLastGlobalResetAt(data, now)?.toISOString(), "2026-08-09T09:00:00.000Z");
    assert.equal(getRecent7DayResetCount(data, now), 1);
  });
});

test("rejected reset records do not affect the latest reset or seven-day count", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const completedAt = new Date(now.getTime() - DAY_MS).toISOString();
  const sourceUrl = "https://x.com/thsottiaux/status/999999";

  withLocalHistory(
    [resetEvent("rejected", completedAt, { source_url: sourceUrl })],
    () => {
      const data = getLocalRadarData({
        calculationNow: now,
        rejectedTiboResets: [
          {
            tweet_id: "999999",
            tweet_url: sourceUrl,
            tweet_created_at: completedAt,
          },
        ],
      });

      assert.equal(getLastGlobalResetAt(data, now), null);
      assert.equal(getRecent7DayResetCount(data, now), 0);
    },
  );
});

test("breakdown arithmetic matches the reported probabilities and official override is explicit", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  withLocalHistory(
    [resetEvent("reset-1", "2026-08-01T00:00:00.000Z")],
    () => {
      const data = getLocalRadarData({ calculationNow: now });
      const calculation = getLocalProbabilityCalculation(data, {
        now,
        regularResetExpectedAt: "2026-08-10T00:00:00.000Z",
      });
      const { breakdown } = calculation;

      assert.equal(
        breakdown.beforeClamp.probability24h,
        sumContributionPeriod(
          breakdown.base.probability24h,
          breakdown.contributions,
          "probability24h",
        ),
      );
      assert.equal(
        breakdown.beforeClamp.probability48h,
        sumContributionPeriod(
          breakdown.base.probability48h,
          breakdown.contributions,
          "probability48h",
        ),
      );
      assert.equal(breakdown.afterClamp.probability24h, calculation.probability24h);
      assert.equal(breakdown.afterClamp.probability48h, calculation.probability48h);
      assert.equal(breakdown.officialNoticeOverride.active, false);

      const notice: ActiveOfficialNotice = {
        origin: "local",
        id: "notice-1",
        title: "notice",
        summary: "notice",
        observedAt: now.toISOString(),
        expectedAt: null,
        expectedEndAt: null,
        expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
        source: null,
        sourceLabel: "test",
      };
      const overridden = getLocalProbabilityCalculation(data, {
        now,
        activeOfficialNotice: notice,
      });

      assert.equal(overridden.probability24h, LOCAL_PROBABILITY_WEIGHTS.officialNotice.within24h);
      assert.equal(overridden.probability48h, LOCAL_PROBABILITY_WEIGHTS.officialNotice.within48h);
      assert.equal(overridden.breakdown.officialNoticeOverride.active, true);
      assert.equal(
        overridden.breakdown.contributions.statusSignal.probability24h,
        0,
      );
      assert.equal(overridden.breakdown.beforeClamp.probability24h, 0.9);
    },
  );
});

test("probability debug info keeps timestamps distinct and contains only audit-safe data", () => {
  const calculatedAt = new Date("2026-08-10T12:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: calculatedAt });
  const calculation = getLocalProbabilityCalculation(data, { now: calculatedAt });
  const debugInfo = buildProbabilityDebugInfo(
    { weighted_status_score: 0, existing_field: "kept" },
    calculation,
    "2026-08-10T11:59:00.000Z",
    calculatedAt,
  );
  const serialized = JSON.stringify(debugInfo);

  assert.equal((debugInfo as Record<string, unknown>).existing_field, "kept");
  assert.equal(debugInfo.generated_at, "2026-08-10T11:59:00.000Z");
  assert.equal(debugInfo.calculated_at, calculatedAt.toISOString());
  assert.equal(
    (debugInfo.probabilityModel as { version: string }).version,
    PROBABILITY_MODEL_VERSION,
  );
  assert.doesNotMatch(serialized, /api[_-]?key|secret|authorization|tweet text/i);
});
