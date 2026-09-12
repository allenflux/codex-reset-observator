import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getLocalRadarData, getRandomResetHeatmapEventTimes } from "../lib/radar";
import {
  buildRandomResetIntervalDistribution,
  buildRandomResetIntervals,
  buildRandomResetTimeHeatmap,
  buildRandomResetWeekdayDistribution,
  filterRandomResetIntervals,
  filterHeatmapEventTimes,
  formatHeatmapBarLabel,
  formatHeatmapWeekdayBarLabel,
  formatHeatmapWeekdayLabel,
  formatRandomResetIntervalBarLabel,
  formatRandomResetIntervalBinLabel,
  formatRandomResetIntervalCompactLabel,
  formatRandomResetIntervalAxisLabel,
  formatRandomResetDuration,
  getRandomResetIntervalMobileAxisLabels,
  getCompactHeatmapTimeBins,
  getHeatmapTimeAxisTicks,
  getRawBarHeightPercent,
  getHeatmapHour,
  getHeatmapWeekday,
} from "../lib/radar/resetTimeHeatmap";
import type { HistoryRecordKind, WindowEventLike } from "../lib/radar/types";

const NOW = new Date("2026-08-06T00:00:00.000Z");

function historyEvent(
  id: string,
  completedAt: string,
  recordKind: HistoryRecordKind,
  cycleType: "定期リセット" | "ランダムリセット",
  scope: string,
  extra: Partial<WindowEventLike> = {},
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
      resetMethod: cycleType === "定期リセット" ? "強制リセット" : "任意リセット権配布",
      scope,
      noticeToExecution: "0分",
    },
    ...extra,
  };
}

function withLocalHistory<T>(history: WindowEventLike[], callback: () => T) {
  const previous = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...history);
  try {
    return callback();
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...previous);
  }
}

test("uses the same random broad reset population as the probability model", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const eventTimes = getRandomResetHeatmapEventTimes(data, NOW);
  const heatmap = buildRandomResetTimeHeatmap(eventTimes, "Asia/Tokyo", NOW);

  assert.equal(eventTimes.length, 23);
  assert.deepEqual(
    heatmap.bins.map((bin) => bin.rawCount),
    [1, 0, 2, 4, 1, 3, 0, 2, 0, 3, 0, 0, 4, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(heatmap.totalCount, 23);
});

test("excludes regular, reference, narrow, pending, future, and invalid history", () => {
  const history = [
    historyEvent("random-forced", "2026-08-01T00:00:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン"),
    historyEvent("random-banked", "2026-08-01T02:00:00.000Z", "banked_distribution", "ランダムリセット", "全有料プラン"),
    historyEvent("regular-forced", "2026-08-01T04:00:00.000Z", "confirmed_global", "定期リセット", "全有料プラン"),
    historyEvent("regular-banked", "2026-08-01T06:00:00.000Z", "banked_distribution", "定期リセット", "全有料プラン"),
    historyEvent("reference", "2026-08-01T08:00:00.000Z", "reference", "ランダムリセット", "全有料プラン"),
    historyEvent("narrow", "2026-08-01T10:00:00.000Z", "banked_distribution", "ランダムリセット", "不具合対象ユーザー（約50万人）"),
    historyEvent("pending", "2026-08-01T12:00:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン", {
      kind: "window_opened",
      status: "open",
      closed_at: null,
      completed_at: null,
    }),
    historyEvent("future", "2026-08-07T00:00:00.000Z", "confirmed_global", "ランダムリセット", "全有料プラン"),
    historyEvent("invalid", "not-a-date", "confirmed_global", "ランダムリセット", "全有料プラン"),
  ];

  withLocalHistory(history, () => {
    const eventTimes = getRandomResetHeatmapEventTimes(getLocalRadarData({ calculationNow: NOW }), NOW);
    assert.deepEqual([...eventTimes].sort(), [
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T02:00:00.000Z",
    ]);
  });
});

test("uses the viewer IANA timezone and applies daylight saving time per event", () => {
  const instant = "2026-08-01T00:30:00.000Z";
  assert.equal(getHeatmapHour(instant, "Asia/Tokyo"), 9);
  assert.equal(getHeatmapHour(instant, "America/Los_Angeles"), 17);
  assert.equal(getHeatmapHour("2026-07-01T16:00:00.000Z", "America/New_York"), 12);
  assert.equal(getHeatmapHour("2026-12-01T17:00:00.000Z", "America/New_York"), 12);

  const tokyo = buildRandomResetTimeHeatmap([instant], "Asia/Tokyo", NOW);
  const losAngeles = buildRandomResetTimeHeatmap([instant], "America/Los_Angeles", NOW);
  assert.equal(tokyo.bins[9].rawCount, 1);
  assert.equal(losAngeles.bins[17].rawCount, 1);
});

test("groups reset records by the viewer's local weekday", () => {
  const sunday = "2026-08-02T00:30:00.000Z";
  assert.equal(getHeatmapWeekday(sunday, "Asia/Tokyo"), 0);
  assert.equal(getHeatmapWeekday(sunday, "America/Los_Angeles"), 6);

  const distribution = buildRandomResetWeekdayDistribution(
    [sunday, "2026-08-03T00:30:00.000Z", "2026-08-04T00:30:00.000Z"],
    "Asia/Tokyo",
    NOW,
  );
  assert.equal(distribution.bins.length, 7);
  assert.equal(distribution.totalCount, 3);
  assert.equal(distribution.bins[0].rawCount, 1);
  assert.equal(distribution.bins[1].rawCount, 1);
  assert.equal(distribution.bins[2].rawCount, 1);
  assert.equal(formatHeatmapWeekdayLabel(0, "ja"), "日");
  assert.equal(formatHeatmapWeekdayLabel(1, "en"), "Mon");
  assert.equal(formatHeatmapWeekdayLabel(2, "zh"), "周二");
  assert.equal(formatHeatmapWeekdayBarLabel(distribution.bins[0], "ja"), "日曜日・1件");
  assert.equal(formatHeatmapWeekdayBarLabel(distribution.bins[1], "en"), "Mon, 1 recorded reset");
});

test("uses raw record counts for bar heights and keeps empty bins", () => {
  const eventTimes = [
    "2026-08-06T00:00:00.000Z",
    "2026-07-07T00:00:00.000Z",
    "2026-06-07T00:00:00.000Z",
  ];
  const heatmap = buildRandomResetTimeHeatmap(eventTimes, "UTC", NOW);
  const bin = heatmap.bins[0];

  assert.equal(bin.rawCount, 3);
  assert.equal(heatmap.totalCount, 3);
  assert.equal(heatmap.bins.filter((item) => item.rawCount === 0).length, 23);
  assert.equal(getRawBarHeightPercent(3, 6), 50);
  assert.equal(getRawBarHeightPercent(6, 6), 100);
  assert.ok(getRawBarHeightPercent(6, 7) < 100);
  assert.equal(getRawBarHeightPercent(0, 6), 0);
  assert.deepEqual(getHeatmapTimeAxisTicks(), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  assert.deepEqual(
    getHeatmapTimeAxisTicks(1),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
  );
  assert.equal(formatHeatmapBarLabel(heatmap.bins[0], "ja"), "00:00〜01:00・3件");
  assert.equal(formatHeatmapBarLabel(heatmap.bins[0], "en"), "00:00–01:00, 3 recorded resets");
  assert.equal(
    formatHeatmapBarLabel({ startHour: 2, endHour: 3, rawCount: 1 }, "en"),
    "02:00–03:00, 1 recorded reset",
  );
  assert.equal(formatHeatmapBarLabel(heatmap.bins[0], "zh"), "00:00〜01:00，3条记录");
  assert.deepEqual(
    getCompactHeatmapTimeBins(heatmap.bins).map((item) => item.rawCount),
    [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(Object.hasOwn(bin, "weightedCount"), false);
});

test("filters the chart between all records and the last 30 days", () => {
  const now = new Date("2026-08-06T00:00:00.000Z");
  const eventTimes = [
    "2026-08-05T00:00:00.000Z",
    "2026-07-07T00:00:00.000Z",
    "2026-07-06T23:59:59.000Z",
    "2026-08-07T00:00:00.000Z",
    "not-a-date",
  ];

  assert.equal(filterHeatmapEventTimes(eventTimes, "all", now).length, 3);
  assert.deepEqual(filterHeatmapEventTimes(eventTimes, "lastMonth", now), [
    "2026-08-05T00:00:00.000Z",
    "2026-07-07T00:00:00.000Z",
  ]);
});

const INTERVAL_NOW = new Date("2026-08-10T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function addHours(base: Date, hours: number) {
  return new Date(base.getTime() + hours * HOUR_MS).toISOString();
}

test("builds random reset intervals in chronological order", () => {
  const intervals = buildRandomResetIntervals(
    ["2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    INTERVAL_NOW,
  );

  assert.deepEqual(
    intervals.map(({ startAt, endAt, durationMs }) => ({ startAt, endAt, durationMs })),
    [
      {
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-01-02T00:00:00.000Z",
        durationMs: 24 * HOUR_MS,
      },
      {
        startAt: "2026-01-02T00:00:00.000Z",
        endAt: "2026-01-03T00:00:00.000Z",
        durationMs: 24 * HOUR_MS,
      },
    ],
  );
});

test("creates N-1 intervals and excludes invalid, future, duplicate, and non-positive events", () => {
  const elevenEvents = Array.from({ length: 11 }, (_, index) => addHours(new Date("2026-01-01T00:00:00.000Z"), index * 24));
  assert.equal(buildRandomResetIntervals(elevenEvents, INTERVAL_NOW).length, 10);

  const intervals = buildRandomResetIntervals(
    [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "not-a-date",
      "2026-08-11T00:00:00.000Z",
    ],
    INTERVAL_NOW,
  );
  assert.equal(intervals.length, 0);

  assert.deepEqual(
    filterRandomResetIntervals(
      [
        { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-02T00:00:00.000Z", durationMs: 0 },
        { startAt: "2026-01-02T00:00:00.000Z", endAt: "2026-01-01T00:00:00.000Z", durationMs: -1 },
      ],
      "all",
      INTERVAL_NOW,
    ),
    [],
  );
});

test("filters intervals by endAt, including an out-of-range start and excluding an out-of-range end", () => {
  const intervals = buildRandomResetIntervals(
    [
      "2026-07-06T00:00:00.000Z",
      "2026-07-10T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
      "2026-07-12T00:00:00.000Z",
    ],
    INTERVAL_NOW,
  );
  const filtered = filterRandomResetIntervals(intervals, "lastMonth", INTERVAL_NOW);

  assert.deepEqual(
    filtered.map((interval) => [interval.startAt, interval.endAt]),
    [
      ["2026-07-10T00:00:00.000Z", "2026-07-11T00:00:00.000Z"],
      ["2026-07-11T00:00:00.000Z", "2026-07-12T00:00:00.000Z"],
    ],
  );
  assert.equal(filtered.some((interval) => interval.endAt === "2026-07-10T00:00:00.000Z"), false);
});

test("assigns exact duration boundaries to the required interval bins", () => {
  const durations = [
    11.999,
    12,
    23.999,
    24,
    47.999,
    48,
    71.999,
    72,
    95.999,
    96,
    119.999,
    120,
    143.999,
    144,
    167.999,
    168,
    191.999,
    192,
    215.999,
    216,
    239.999,
    240,
  ];
  const eventTimes = [addHours(INTERVAL_NOW, -3000)];
  for (const duration of durations) eventTimes.push(addHours(new Date(eventTimes.at(-1)!), duration));

  const distribution = buildRandomResetIntervalDistribution(eventTimes, "all", INTERVAL_NOW);
  assert.deepEqual(distribution.bins.map((bin) => bin.rawCount), [3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(
    distribution.bins.map((bin) => [bin.key, bin.minHours, bin.maxHours]),
    [
      ["0-24h", 0, 24],
      ["24-48h", 24, 48],
      ["48-72h", 48, 72],
      ["3-4d", 72, 96],
      ["4-5d", 96, 120],
      ["5-6d", 120, 144],
      ["6-7d", 144, 168],
      ["7-8d", 168, 192],
      ["8-9d", 192, 216],
      ["9-10d", 216, 240],
      ["10d-plus", 240, null],
    ],
  );
});

test("calculates odd and even medians, arithmetic average, minimum, and maximum", () => {
  const eventTimes = [addHours(INTERVAL_NOW, -100)];
  for (const duration of [10, 20, 30]) eventTimes.push(addHours(new Date(eventTimes.at(-1)!), duration));
  const odd = buildRandomResetIntervalDistribution(eventTimes, "all", INTERVAL_NOW);
  assert.equal(odd.medianMs, 20 * HOUR_MS);
  assert.equal(odd.averageMs, 20 * HOUR_MS);
  assert.equal(odd.minMs, 10 * HOUR_MS);
  assert.equal(odd.maxMs, 30 * HOUR_MS);

  const evenEventTimes = [addHours(INTERVAL_NOW, -100)];
  for (const duration of [10, 20, 30, 40]) {
    evenEventTimes.push(addHours(new Date(evenEventTimes.at(-1)!), duration));
  }
  const even = buildRandomResetIntervalDistribution(evenEventTimes, "all", INTERVAL_NOW);
  assert.equal(even.medianMs, 25 * HOUR_MS);
});

test("returns null statistics for zero intervals and the same values for one interval", () => {
  const empty = buildRandomResetIntervalDistribution(["2026-01-01T00:00:00.000Z"], "all", INTERVAL_NOW);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.medianMs, null);
  assert.equal(empty.averageMs, null);
  assert.equal(empty.minMs, null);
  assert.equal(empty.maxMs, null);

  const one = buildRandomResetIntervalDistribution(
    ["2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z"],
    "all",
    INTERVAL_NOW,
  );
  assert.equal(one.totalCount, 1);
  assert.equal(one.medianMs, 36 * HOUR_MS);
  assert.equal(one.averageMs, 36 * HOUR_MS);
  assert.equal(one.minMs, 36 * HOUR_MS);
  assert.equal(one.maxMs, 36 * HOUR_MS);
});

test("formats random reset interval durations and localized bar labels", () => {
  assert.equal(formatRandomResetDuration(9 * HOUR_MS, "ja"), "9時間");
  assert.equal(formatRandomResetDuration(12.5 * HOUR_MS, "ja"), "12.5時間");
  assert.equal(formatRandomResetDuration(24 * HOUR_MS, "ja"), "1日");
  assert.equal(formatRandomResetDuration(36 * HOUR_MS, "ja"), "1.5日");
  assert.equal(formatRandomResetDuration(67.2 * HOUR_MS, "ja"), "2.8日");
  assert.equal(formatRandomResetDuration(168 * HOUR_MS, "ja"), "7日");
  assert.equal(formatRandomResetDuration(9 * HOUR_MS, "en"), "9h");
  assert.equal(formatRandomResetDuration(12.5 * HOUR_MS, "en"), "12.5h");
  assert.equal(formatRandomResetDuration(24 * HOUR_MS, "en"), "1d");
  assert.equal(formatRandomResetDuration(36 * HOUR_MS, "en"), "1.5d");
  assert.equal(formatRandomResetDuration(67.2 * HOUR_MS, "en"), "2.8d");
  assert.equal(formatRandomResetDuration(168 * HOUR_MS, "en"), "7d");
  assert.equal(formatRandomResetDuration(9 * HOUR_MS, "zh"), "9小时");
  assert.equal(formatRandomResetDuration(24 * HOUR_MS, "zh"), "1天");
  assert.equal(formatRandomResetDuration(168 * HOUR_MS, "zh"), "7天");

  const bin = { key: "24-48h" as const, minHours: 24, maxHours: 48, rawCount: 3 };
  const intervalBinKeys = [
    "0-24h",
    "24-48h",
    "48-72h",
    "3-4d",
    "4-5d",
    "5-6d",
    "6-7d",
    "7-8d",
    "8-9d",
    "9-10d",
    "10d-plus",
  ] as const;
  assert.deepEqual(
    intervalBinKeys.map((key) => formatRandomResetIntervalBinLabel({ key }, "ja")),
    ["0–24時間", "24–48時間", "48–72時間", "3–4日", "4–5日", "5–6日", "6–7日", "7–8日", "8–9日", "9–10日", "10日以上"],
  );
  assert.deepEqual(
    intervalBinKeys.map((key) => formatRandomResetIntervalBinLabel({ key }, "en")),
    ["0–24h", "24–48h", "48–72h", "3–4d", "4–5d", "5–6d", "6–7d", "7–8d", "8–9d", "9–10d", "10d+"],
  );
  assert.deepEqual(
    intervalBinKeys.map((key) => formatRandomResetIntervalBinLabel({ key }, "zh")),
    ["0–24小时", "24–48小时", "48–72小时", "3–4天", "4–5天", "5–6天", "6–7天", "7–8天", "8–9天", "9–10天", "10天以上"],
  );
  assert.deepEqual(
    intervalBinKeys.map((key) => formatRandomResetIntervalCompactLabel({ key }, "ja")),
    ["0–24h", "24–48h", "48–72h", "3–4d", "4–5d", "5–6d", "6–7d", "7–8d", "8–9d", "9–10d", "10d+"],
  );
  assert.equal(formatRandomResetIntervalBinLabel({ key: "3-4d" }, "en"), "3–4d");
  assert.equal(formatRandomResetIntervalCompactLabel({ key: "7-8d" }, "zh"), "7–8d");
  assert.equal(formatRandomResetIntervalBinLabel({ key: "10d-plus" }, "zh"), "10天以上");
  assert.equal(formatRandomResetIntervalBarLabel({ key: "3-4d", rawCount: 5 }, "ja"), "3–4日・5件");
  assert.equal(formatRandomResetIntervalBarLabel({ key: "10d-plus", rawCount: 2 }, "en"), "10d+, 2 intervals");
  assert.equal(formatRandomResetIntervalBarLabel({ key: "10d-plus", rawCount: 2 }, "zh"), "10天以上，2个间隔");
  assert.equal(formatRandomResetIntervalBarLabel(bin, "ja"), "24–48時間・3件");
  assert.equal(formatRandomResetIntervalBarLabel({ ...bin, rawCount: 1 }, "en"), "24–48h, 1 interval");
  assert.equal(formatRandomResetIntervalBarLabel(bin, "en"), "24–48h, 3 intervals");
  assert.equal(formatRandomResetIntervalBarLabel(bin, "zh"), "24–48小时，3个间隔");
});

test("uses day-based boundary ticks for the mobile interval chart", () => {
  assert.deepEqual(getRandomResetIntervalMobileAxisLabels(), [
    "0d",
    "1d",
    "2d",
    "3d",
    "4d",
    "5d",
    "6d",
    "7d",
    "8d",
    "9d",
    "10d",
    "10d+",
  ]);
});

test("localizes the random reset interval axis label", () => {
  assert.deepEqual(
    (["ja", "en", "zh"] as const).map((locale) => formatRandomResetIntervalAxisLabel(locale)),
    ["間隔（日）", "Interval (days)", "间隔（天）"],
  );
});
