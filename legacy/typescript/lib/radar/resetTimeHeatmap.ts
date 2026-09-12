import { DISPLAY_TIME_ZONE } from "./helpers";

export const RANDOM_RESET_TIME_HEATMAP_BIN_COUNT = 24;
export const RANDOM_RESET_TIME_HEATMAP_MOBILE_BIN_COUNT = 12;
export const RANDOM_RESET_TIME_HEATMAP_LAST_MONTH_DAYS = 30;
export const RANDOM_RESET_WEEKDAY_BIN_COUNT = 7;
export const RANDOM_RESET_INTERVAL_BIN_COUNT = 11;

export type RandomResetTimeHeatmapRange = "all" | "lastMonth";

export type RandomResetIntervalRecord = {
  startAt: string;
  endAt: string;
  durationMs: number;
};

export type RandomResetIntervalBinKey =
  | "0-24h"
  | "24-48h"
  | "48-72h"
  | "3-4d"
  | "4-5d"
  | "5-6d"
  | "6-7d"
  | "7-8d"
  | "8-9d"
  | "9-10d"
  | "10d-plus";

export type RandomResetIntervalBin = {
  key: RandomResetIntervalBinKey;
  minHours: number;
  maxHours: number | null;
  rawCount: number;
};

export type RandomResetIntervalDistribution = {
  bins: RandomResetIntervalBin[];
  totalCount: number;
  medianMs: number | null;
  averageMs: number | null;
  minMs: number | null;
  maxMs: number | null;
};

export type RandomResetTimeHeatmapBin = {
  startHour: number;
  endHour: number;
  rawCount: number;
};

export type RandomResetTimeHeatmap = {
  bins: RandomResetTimeHeatmapBin[];
  totalCount: number;
};

export type RandomResetWeekdayBin = {
  weekday: number;
  rawCount: number;
};

export type RandomResetWeekdayDistribution = {
  bins: RandomResetWeekdayBin[];
  totalCount: number;
};

export function getHeatmapHour(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const safeTimeZone = getSafeTimeZone(timeZone);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimeZone,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .find((part) => part.type === "hour")?.value,
  );

  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
}

export function buildRandomResetTimeHeatmap(
  eventTimes: string[],
  timeZone: string,
  now: Date | number = Date.now(),
): RandomResetTimeHeatmap {
  const nowTime = typeof now === "number" ? now : now.getTime();
  const bins = Array.from({ length: RANDOM_RESET_TIME_HEATMAP_BIN_COUNT }, (_, index) => ({
    startHour: index,
    endHour: index + 1,
    rawCount: 0,
  }));

  if (!Number.isFinite(nowTime)) {
    return { bins, totalCount: 0 };
  }

  let totalCount = 0;

  for (const eventTime of eventTimes) {
    const eventTimestamp = new Date(eventTime).getTime();
    if (!Number.isFinite(eventTimestamp) || eventTimestamp > nowTime) continue;

    const hour = getHeatmapHour(eventTime, timeZone);
    if (hour === null) continue;

    const bin = bins[hour];
    bin.rawCount += 1;
    totalCount += 1;
  }

  return { bins, totalCount };
}

export function getCompactHeatmapTimeBins(bins: RandomResetTimeHeatmapBin[]) {
  return Array.from({ length: RANDOM_RESET_TIME_HEATMAP_MOBILE_BIN_COUNT }, (_, index) => {
    const first = bins[index * 2];
    const second = bins[index * 2 + 1];
    return {
      startHour: first?.startHour ?? index * 2,
      endHour: second?.endHour ?? index * 2 + 2,
      rawCount: (first?.rawCount ?? 0) + (second?.rawCount ?? 0),
    };
  });
}

export function getHeatmapWeekday(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: getSafeTimeZone(timeZone),
    weekday: "short",
  }).format(date);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);

  return weekdayIndex >= 0 ? weekdayIndex : null;
}

export function buildRandomResetWeekdayDistribution(
  eventTimes: string[],
  timeZone: string,
  now: Date | number = Date.now(),
): RandomResetWeekdayDistribution {
  const nowTime = typeof now === "number" ? now : now.getTime();
  const bins = Array.from({ length: RANDOM_RESET_WEEKDAY_BIN_COUNT }, (_, weekday) => ({
    weekday,
    rawCount: 0,
  }));

  if (!Number.isFinite(nowTime)) {
    return { bins, totalCount: 0 };
  }

  let totalCount = 0;

  for (const eventTime of eventTimes) {
    const eventTimestamp = new Date(eventTime).getTime();
    if (!Number.isFinite(eventTimestamp) || eventTimestamp > nowTime) continue;

    const weekday = getHeatmapWeekday(eventTime, timeZone);
    if (weekday === null) continue;

    bins[weekday].rawCount += 1;
    totalCount += 1;
  }

  return { bins, totalCount };
}

export function filterHeatmapEventTimes(
  eventTimes: string[],
  range: RandomResetTimeHeatmapRange,
  now: Date | number = Date.now(),
) {
  const nowTime = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(nowTime)) return [];

  const startTime =
    range === "lastMonth"
      ? nowTime - RANDOM_RESET_TIME_HEATMAP_LAST_MONTH_DAYS * 24 * 60 * 60 * 1000
      : Number.NEGATIVE_INFINITY;

  return eventTimes.filter((eventTime) => {
    const timestamp = new Date(eventTime).getTime();
    return Number.isFinite(timestamp) && timestamp >= startTime && timestamp <= nowTime;
  });
}

export function buildRandomResetIntervals(
  eventTimes: string[],
  now: Date | number = Date.now(),
): RandomResetIntervalRecord[] {
  const nowTime = toTimestamp(now);
  if (!Number.isFinite(nowTime)) return [];

  const timestamps = Array.from(
    new Set(
      eventTimes
        .map((eventTime) => new Date(eventTime).getTime())
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= nowTime),
    ),
  ).sort((left, right) => left - right);

  const intervals: RandomResetIntervalRecord[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const startTime = timestamps[index - 1];
    const endTime = timestamps[index];
    const durationMs = endTime - startTime;
    if (durationMs <= 0) continue;

    intervals.push({
      startAt: new Date(startTime).toISOString(),
      endAt: new Date(endTime).toISOString(),
      durationMs,
    });
  }

  return intervals;
}

export function filterRandomResetIntervals(
  intervals: RandomResetIntervalRecord[],
  range: RandomResetTimeHeatmapRange,
  now: Date | number = Date.now(),
): RandomResetIntervalRecord[] {
  const nowTime = toTimestamp(now);
  if (!Number.isFinite(nowTime)) return [];

  const startTime =
    range === "lastMonth"
      ? nowTime - RANDOM_RESET_TIME_HEATMAP_LAST_MONTH_DAYS * 24 * 60 * 60 * 1000
      : Number.NEGATIVE_INFINITY;

  return intervals.filter((interval) => {
    const endTime = new Date(interval.endAt).getTime();
    const startAt = new Date(interval.startAt).getTime();
    return (
      Number.isFinite(startAt)
      && Number.isFinite(endTime)
      && Number.isFinite(interval.durationMs)
      && interval.durationMs > 0
      && endTime > startAt
      && endTime >= startTime
      && endTime <= nowTime
    );
  });
}

export function buildRandomResetIntervalDistribution(
  eventTimes: string[],
  range: RandomResetTimeHeatmapRange,
  now: Date | number = Date.now(),
): RandomResetIntervalDistribution {
  const intervals = filterRandomResetIntervals(
    buildRandomResetIntervals(eventTimes, now),
    range,
    now,
  );
  const durations = intervals.map((interval) => interval.durationMs).sort((left, right) => left - right);
  const bins = buildRandomResetIntervalBins();

  for (const durationMs of durations) {
    const bin = bins[getRandomResetIntervalBinIndex(durationMs)];
    bin.rawCount += 1;
  }

  if (durations.length === 0) {
    return {
      bins,
      totalCount: 0,
      medianMs: null,
      averageMs: null,
      minMs: null,
      maxMs: null,
    };
  }

  const middle = Math.floor(durations.length / 2);
  const medianMs = durations.length % 2 === 1
    ? durations[middle]
    : (durations[middle - 1] + durations[middle]) / 2;

  return {
    bins,
    totalCount: durations.length,
    medianMs,
    averageMs: durations.reduce((sum, durationMs) => sum + durationMs, 0) / durations.length,
    minMs: durations[0],
    maxMs: durations[durations.length - 1],
  };
}

export function formatRandomResetIntervalBinLabel(
  bin: Pick<RandomResetIntervalBin, "key">,
  locale: "ja" | "en" | "zh",
) {
  const labels = {
    ja: {
      "0-24h": "0–24時間",
      "24-48h": "24–48時間",
      "48-72h": "48–72時間",
      "3-4d": "3–4日",
      "4-5d": "4–5日",
      "5-6d": "5–6日",
      "6-7d": "6–7日",
      "7-8d": "7–8日",
      "8-9d": "8–9日",
      "9-10d": "9–10日",
      "10d-plus": "10日以上",
    },
    en: {
      "0-24h": "0–24h",
      "24-48h": "24–48h",
      "48-72h": "48–72h",
      "3-4d": "3–4d",
      "4-5d": "4–5d",
      "5-6d": "5–6d",
      "6-7d": "6–7d",
      "7-8d": "7–8d",
      "8-9d": "8–9d",
      "9-10d": "9–10d",
      "10d-plus": "10d+",
    },
    zh: {
      "0-24h": "0–24小时",
      "24-48h": "24–48小时",
      "48-72h": "48–72小时",
      "3-4d": "3–4天",
      "4-5d": "4–5天",
      "5-6d": "5–6天",
      "6-7d": "6–7天",
      "7-8d": "7–8天",
      "8-9d": "8–9天",
      "9-10d": "9–10天",
      "10d-plus": "10天以上",
    },
  } as const;

  return labels[locale][bin.key];
}

export function formatRandomResetIntervalCompactLabel(
  bin: Pick<RandomResetIntervalBin, "key">,
  locale: "ja" | "en" | "zh",
) {
  const labels = {
    "0-24h": "0–24h",
    "24-48h": "24–48h",
    "48-72h": "48–72h",
    "3-4d": "3–4d",
    "4-5d": "4–5d",
    "5-6d": "5–6d",
    "6-7d": "6–7d",
    "7-8d": "7–8d",
    "8-9d": "8–9d",
    "9-10d": "9–10d",
    "10d-plus": "10d+",
  } satisfies Record<RandomResetIntervalBinKey, string>;

  return labels[bin.key];
}

export function getRandomResetIntervalMobileAxisLabels() {
  return [
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
  ] as const;
}

export function formatRandomResetIntervalAxisLabel(locale: "ja" | "en" | "zh") {
  const labels = {
    ja: "間隔（日）",
    en: "Interval (days)",
    zh: "间隔（天）",
  } as const;

  return labels[locale];
}

export function formatRandomResetIntervalBarLabel(
  bin: Pick<RandomResetIntervalBin, "key" | "rawCount">,
  locale: "ja" | "en" | "zh",
) {
  const range = formatRandomResetIntervalBinLabel(bin, locale);
  if (locale === "en") {
    return `${range}, ${bin.rawCount} ${bin.rawCount === 1 ? "interval" : "intervals"}`;
  }
  if (locale === "zh") return `${range}，${bin.rawCount}个间隔`;
  return `${range}・${bin.rawCount}件`;
}

export function formatRandomResetDuration(
  durationMs: number | null,
  locale: "ja" | "en" | "zh",
) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";

  const hours = durationMs / (60 * 60 * 1000);
  const unit = hours < 24 ? hours : hours / 24;
  const value = formatOneDecimal(unit);
  if (locale === "en") return `${value}${hours < 24 ? "h" : "d"}`;
  if (locale === "zh") return `${value}${hours < 24 ? "小时" : "天"}`;
  return `${value}${hours < 24 ? "時間" : "日"}`;
}

function buildRandomResetIntervalBins(): RandomResetIntervalBin[] {
  return [
    { key: "0-24h", minHours: 0, maxHours: 24, rawCount: 0 },
    { key: "24-48h", minHours: 24, maxHours: 48, rawCount: 0 },
    { key: "48-72h", minHours: 48, maxHours: 72, rawCount: 0 },
    { key: "3-4d", minHours: 72, maxHours: 96, rawCount: 0 },
    { key: "4-5d", minHours: 96, maxHours: 120, rawCount: 0 },
    { key: "5-6d", minHours: 120, maxHours: 144, rawCount: 0 },
    { key: "6-7d", minHours: 144, maxHours: 168, rawCount: 0 },
    { key: "7-8d", minHours: 168, maxHours: 192, rawCount: 0 },
    { key: "8-9d", minHours: 192, maxHours: 216, rawCount: 0 },
    { key: "9-10d", minHours: 216, maxHours: 240, rawCount: 0 },
    { key: "10d-plus", minHours: 240, maxHours: null, rawCount: 0 },
  ];
}

function getRandomResetIntervalBinIndex(durationMs: number) {
  const durationHours = durationMs / (60 * 60 * 1000);
  if (durationHours < 24) return 0;
  if (durationHours < 48) return 1;
  if (durationHours < 72) return 2;
  if (durationHours < 96) return 3;
  if (durationHours < 120) return 4;
  if (durationHours < 144) return 5;
  if (durationHours < 168) return 6;
  if (durationHours < 192) return 7;
  if (durationHours < 216) return 8;
  if (durationHours < 240) return 9;
  return 10;
}

function toTimestamp(value: Date | number) {
  return typeof value === "number" ? value : value.getTime();
}

function formatOneDecimal(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function getRawBarHeightPercent(rawCount: number, maxRawCount: number) {
  if (!Number.isFinite(rawCount) || !Number.isFinite(maxRawCount) || rawCount <= 0 || maxRawCount <= 0) {
    return 0;
  }

  return Math.min(100, (rawCount / maxRawCount) * 100);
}

export function getHeatmapTimeAxisTicks(stepHours: 1 | 2 = 2) {
  return Array.from(
    { length: RANDOM_RESET_TIME_HEATMAP_BIN_COUNT / stepHours + 1 },
    (_, index) => index * stepHours,
  );
}

export function formatHeatmapWeekdayLabel(weekday: number, locale: "ja" | "en" | "zh") {
  const labels = {
    ja: ["日", "月", "火", "水", "木", "金", "土"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  } as const;

  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return "?";
  return labels[locale][weekday];
}

export function formatHeatmapWeekdayBarLabel(
  bin: Pick<RandomResetWeekdayBin, "weekday" | "rawCount">,
  locale: "ja" | "en" | "zh",
) {
  const label = formatHeatmapWeekdayLabel(bin.weekday, locale);
  if (locale === "en") return `${label}, ${formatEnglishRecordCount(bin.rawCount)}`;
  if (locale === "zh") return `${label}，${bin.rawCount}条记录`;
  return `${label}曜日・${bin.rawCount}件`;
}

export function formatHeatmapBarLabel(
  bin: Pick<RandomResetTimeHeatmapBin, "startHour" | "endHour" | "rawCount">,
  locale: "ja" | "en" | "zh",
) {
  const range = formatHeatmapTimeRange(bin, locale);
  if (locale === "en") return `${range}, ${formatEnglishRecordCount(bin.rawCount)}`;
  if (locale === "zh") return `${range}，${bin.rawCount}条记录`;
  return `${range}・${bin.rawCount}件`;
}

function formatEnglishRecordCount(count: number) {
  return `${count} recorded ${count === 1 ? "reset" : "resets"}`;
}

export function formatHeatmapTimeRange(
  bin: Pick<RandomResetTimeHeatmapBin, "startHour" | "endHour">,
  locale: "ja" | "en" | "zh",
) {
  const start = String(bin.startHour).padStart(2, "0");
  const end = String(bin.endHour).padStart(2, "0");
  if (locale === "en") return `${start}:00–${end}:00`;
  return `${start}:00〜${end}:00`;
}

function getSafeTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return DISPLAY_TIME_ZONE;
  }
}
