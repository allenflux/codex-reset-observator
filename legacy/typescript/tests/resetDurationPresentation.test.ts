import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import {
  getDisplayProbabilityReason,
  getLastDisplayResetAt,
  getLocalSignalEvaluation,
} from "../lib/radar/probability";
import { getLastRandomRecoveryResetAt } from "../lib/radar/recoveryBoundary";
import { getDueRegularResetEventRows } from "../lib/radar/regularResetSchedule";
import { formatElapsedResetDuration, formatWindowLength } from "../lib/radar/helpers";
import type { HistoryRecordKind, WindowEventLike } from "../lib/radar/types";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-08-10T12:00:00.000Z");

function resetEvent(
  id: string,
  completedAt: string,
  recordKind: HistoryRecordKind,
  cycleType: "定期リセット" | "ランダムリセット",
  scope: string,
): WindowEventLike {
  return {
    id,
    recordKind,
    title: cycleType,
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope,
    details: {
      cycleType,
      reasonType: cycleType === "定期リセット" ? "定期更新" : "詫びリセット",
      resetMethod: "任意リセット権配布",
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

function getReasonForData(
  data: ReturnType<typeof getLocalRadarData>,
  locale: "ja" | "en" | "zh",
  regimeMultiplier = 1,
) {
  const lastResetAt = getLastRandomRecoveryResetAt(data, NOW);
  const lastReset = lastResetAt ? new Date(lastResetAt) : null;
  const elapsedHours = lastReset
    ? Math.max(0, (NOW.getTime() - lastReset.getTime()) / HOUR_MS)
    : 0;
  return getDisplayProbabilityReason(
    data,
    0.2,
    0.3,
    locale,
    getLocalSignalEvaluation(data, NOW),
    null,
    NOW,
    {
      source: "shadow",
      shadow: {
        regimeElapsed: {
          elapsedHours,
          regime: { regimeMultiplier },
        },
      },
    },
  ) ?? "";
}

function getReason(locale: "ja" | "en" | "zh") {
  return getReasonForData(getLocalRadarData({ calculationNow: NOW }), locale);
}

test("formats elapsed reset durations by truncated hours in Japanese", () => {
  assert.equal(formatElapsedResetDuration(59 * 60 * 1000, "ja"), "1時間未満");
  assert.equal(formatElapsedResetDuration(HOUR_MS, "ja"), "1時間");
  assert.equal(formatElapsedResetDuration(23 * HOUR_MS, "ja"), "23時間");
  assert.equal(formatElapsedResetDuration(24 * HOUR_MS, "ja"), "1日");
  assert.equal(formatElapsedResetDuration(25 * HOUR_MS, "ja"), "1日1時間");
  assert.equal(formatElapsedResetDuration(90 * HOUR_MS, "ja"), "3日18時間");
});

test("formats English singular and plural elapsed reset durations", () => {
  assert.equal(formatElapsedResetDuration(59 * 60 * 1000, "en"), "less than 1 hour");
  assert.equal(formatElapsedResetDuration(HOUR_MS, "en"), "1 hour");
  assert.equal(formatElapsedResetDuration(2 * HOUR_MS, "en"), "2 hours");
  assert.equal(formatElapsedResetDuration(24 * HOUR_MS, "en"), "1 day");
  assert.equal(formatElapsedResetDuration(25 * HOUR_MS, "en"), "1 day and 1 hour");
  assert.equal(formatElapsedResetDuration(49 * HOUR_MS, "en"), "2 days and 1 hour");
  assert.equal(formatElapsedResetDuration(4 * 24 * HOUR_MS, "en"), "4 days");
});

test("formats Chinese elapsed reset durations without spaces", () => {
  assert.equal(formatElapsedResetDuration(59 * 60 * 1000, "zh"), "不到1小时");
  assert.equal(formatElapsedResetDuration(HOUR_MS, "zh"), "1小时");
  assert.equal(formatElapsedResetDuration(90 * HOUR_MS, "zh"), "3天18小时");
  assert.equal(formatElapsedResetDuration(4 * 24 * HOUR_MS, "zh"), "4天");
});

test("formats reset window lengths with English singular and plural units", () => {
  const expectedEnglish = [
    [0, "Immediate reset"],
    [1, "1 minute"],
    [2, "2 minutes"],
    [59, "59 minutes"],
    [60, "1 hour"],
    [61, "1h 1m"],
    [120, "2 hours"],
    [121, "2h 1m"],
  ] as const;

  for (const [minutes, expected] of expectedEnglish) {
    assert.equal(formatWindowLength(minutes, "en"), expected);
  }

  assert.equal(formatWindowLength(1, "ja"), "1分");
  assert.equal(formatWindowLength(60, "ja"), "1時間");
  assert.equal(formatWindowLength(1, "zh"), "1分钟");
  assert.equal(formatWindowLength(60, "zh"), "1小时");
});

test("uses the latest broad regular recovery boundary, ignoring newer narrow records", () => {
  withLocalHistory(
    [
      resetEvent("regular", "2026-08-09T10:00:00.000Z", "confirmed_global", "定期リセット", "全有料プラン"),
      resetEvent("random-banked", "2026-08-09T09:00:00.000Z", "banked_distribution", "ランダムリセット", "全有料プラン"),
      resetEvent("newer-reference", "2026-08-09T11:00:00.000Z", "reference", "定期リセット", "全有料プラン"),
      resetEvent("newer-narrow", "2026-08-09T12:00:00.000Z", "banked_distribution", "ランダムリセット", "不具合対象ユーザー（約50万人）"),
    ],
    () => {
      assert.equal(
        getReason("ja"),
        "前回のランダムリセットから1日3時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
      );
    },
  );
});

test("uses a broad regular reference when it is the latest recovery boundary", () => {
  withLocalHistory(
    [
      resetEvent("random-banked", "2026-08-09T09:00:00.000Z", "banked_distribution", "ランダムリセット", "全有料プラン"),
      resetEvent("newer-reference", "2026-08-09T10:00:00.000Z", "reference", "定期リセット", "全有料プラン"),
      resetEvent("newer-narrow", "2026-08-09T11:00:00.000Z", "banked_distribution", "ランダムリセット", "限定ユーザー"),
    ],
    () => {
      assert.equal(
        getReason("ja"),
        "前回のランダムリセットから1日3時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
      );
    },
  );
});

test("does not use non-regular reference or narrow distributions as the elapsed reset baseline", () => {
  withLocalHistory(
    [
      resetEvent("reference", "2026-08-09T10:00:00.000Z", "reference", "ランダムリセット", "全有料プラン"),
      resetEvent("narrow", "2026-08-09T11:00:00.000Z", "banked_distribution", "ランダムリセット", "限定ユーザー"),
    ],
    () => {
      assert.doesNotMatch(getReason("ja"), /直近のリセットから/);
    },
  );
});

test("uses persisted regular_completed as the display boundary and not the older random reset", () => {
  const regularAt = "2026-08-08T03:32:00.000Z";
  withLocalHistory(
    [resetEvent("random", "2026-08-01T03:32:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン")],
    () => {
      const regularRow = getDueRegularResetEventRows(
        new Date(regularAt),
        "2026-08-01T03:32:00.000Z",
      )[0];
      const data = getLocalRadarData({ calculationNow: NOW, regularResetEvents: [regularRow] });

      assert.equal(getLastDisplayResetAt(data, NOW)?.toISOString(), regularAt);
      assert.equal(
        getReasonForData(data, "ja"),
        "前回のランダムリセットから9日8時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
      );
    },
  );
});

test("uses the same regular recovery boundary in JA, EN, and ZH display reasons", () => {
  const regularAt = "2026-08-08T03:32:00.000Z";
  withLocalHistory(
    [resetEvent("random", "2026-08-01T03:32:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン")],
    () => {
      const regularRow = getDueRegularResetEventRows(
        new Date(regularAt),
        "2026-08-01T03:32:00.000Z",
      )[0];
      const data = getLocalRadarData({ calculationNow: NOW, regularResetEvents: [regularRow] });

      assert.equal(
        getReasonForData(data, "ja"),
        "前回のランダムリセットから9日8時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
      );
      assert.equal(
        getReasonForData(data, "en"),
        "It has been 9 days and 8 hours since the last random reset, and the current forecast puts the outlook for a reset at moderate.",
      );
      assert.equal(
        getReasonForData(data, "zh"),
        "距离上次随机重置已过去9天8小时，根据当前预测，重置的可能性处于中等水平。",
      );
    },
  );
});

test("ignores rejected, voided, future, and narrow regular events and falls back to random", () => {
  const randomAt = "2026-08-01T03:32:00.000Z";
  const regular = (id: string, completedAt: string, scope = "全有料プラン") =>
    resetEvent(id, completedAt, "regular_completed", "定期リセット", scope);
  withLocalHistory(
    [
      resetEvent("random", randomAt, "confirmed_global", "ランダムリセット", "全有料プラン"),
      { ...regular("rejected", "2026-08-10T10:00:00.000Z"), status: "rejected" },
      { ...regular("voided", "2026-08-10T09:00:00.000Z"), status: "voided" },
      regular("future", "2026-08-10T13:00:00.000Z"),
      regular("narrow", "2026-08-10T11:00:00.000Z", "限定ユーザー"),
    ],
    () => {
      assert.equal(getLastDisplayResetAt(null, NOW)?.toISOString(), randomAt);
    },
  );
});

test("display boundary calculation does not change published probability values", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const before = getRadarViewModel(data, "ja", false, undefined, NOW);

  getDisplayProbabilityReason(
    data,
    before.probability24h,
    before.probability48h,
    "ja",
    getLocalSignalEvaluation(data, NOW),
    null,
    NOW,
  );

  const after = getRadarViewModel(data, "ja", false, undefined, NOW);
  assert.deepEqual(
    {
      probability24h: after.probability24h,
      probability48h: after.probability48h,
    },
    {
      probability24h: before.probability24h,
      probability48h: before.probability48h,
    },
  );
});

test("renders the normal outlook sentence in all supported locales", () => {
  withLocalHistory(
    [
      resetEvent("random", "2026-08-08T10:00:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン"),
      resetEvent("regular", "2026-08-09T10:00:00.000Z", "confirmed_global", "定期リセット", "全有料プラン"),
    ],
    () => {
      assert.equal(
        getReason("ja"),
        "前回のランダムリセットから2日2時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
      );
      assert.equal(
        getReason("en"),
        "It has been 2 days and 2 hours since the last random reset, and the current forecast puts the outlook for a reset at moderate.",
      );
      assert.equal(
        getReason("zh"),
        "距离上次随机重置已过去2天2小时，根据当前预测，重置的可能性处于中等水平。",
      );
    },
  );
});
