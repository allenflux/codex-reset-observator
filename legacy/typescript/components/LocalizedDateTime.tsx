"use client";

import { useEffect, useMemo, useState } from "react";
import type { Locale } from "@/lib/radar/types";
import { DISPLAY_TIME_ZONE } from "@/lib/radar/helpers";

type LocalizedDateTimeProps = {
  value: string | null | undefined;
  locale?: Locale;
  className?: string;
  timeClassName?: string;
  weekday?: "short" | "long";
  approximate?: boolean;
};

export function LocalizedDateTime({
  value,
  locale = "ja",
  className,
  timeClassName,
  weekday,
  approximate = false,
}: LocalizedDateTimeProps) {
  // Render deterministic JST text during SSR so crawlers and no-JS clients
  // receive the actual timestamp. After hydration, switch to the viewer's
  // browser timezone without changing the initial server/client markup.
  const [timeZone, setTimeZone] = useState<string>(DISPLAY_TIME_ZONE);
  const date = useMemo(() => parseDate(value), [value]);

  useEffect(() => {
    setTimeZone(getBrowserTimeZone());
  }, []);

  if (!value) {
    const unknownLabel = locale === "en" ? "Unknown" : locale === "zh" ? "未知" : "不明";
    return <span className={className}>{unknownLabel}</span>;
  }

  if (!date) {
    return <span className={className}>{value}</span>;
  }

  const formatLocale = locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP";
  const classes = ["inline-flex", "flex-col", className]
    .filter((item): item is string => Boolean(item))
    .join(" ");
  const timeClasses = [
    "block",
    "leading-tight",
    timeClassName ? null : "font-bold text-slate-900",
    timeClassName,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ");

  const local = formatDateTimeInZone(date, timeZone, formatLocale, { weekday, approximate });

  return (
    <span className={classes}>
      <time
        dateTime={date.toISOString()}
        className={timeClasses}
      >
        {local}
      </time>
    </span>
  );
}

export function getBrowserTimeZone(
  detectTimeZone: () => string | undefined = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  try {
    return detectTimeZone() || DISPLAY_TIME_ZONE;
  } catch {
    return DISPLAY_TIME_ZONE;
  }
}

function parseDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTimeInZone(
  date: Date,
  timeZone: string,
  localeStr: string,
  options: { weekday?: "short" | "long"; approximate?: boolean } = {},
) {
  const safeTimeZone = getSafeTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat(localeStr, {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: options.weekday,
    hour: "2-digit",
    minute: "2-digit",
    hour12: localeStr === "en-US",
    timeZone: safeTimeZone,
  }).format(date);

  const approximatePrefix = options.approximate && localeStr === "en-US" ? "around " : "";
  const approximateSuffix = options.approximate && localeStr === "ja-JP" ? "頃" : "";
  const approximateChinesePrefix = options.approximate && localeStr === "zh-CN" ? "约" : "";
  return `${approximatePrefix}${approximateChinesePrefix}${formatted}${approximateSuffix} ${getTimeZoneLabel(date, safeTimeZone)}`;
}

export function getTimeZoneLabel(date: Date, timeZone: string) {
  const safeTimeZone = getSafeTimeZone(timeZone);

  if (safeTimeZone === DISPLAY_TIME_ZONE) {
    return "JST";
  }

  if (safeTimeZone === "Asia/Seoul") {
    return "KST";
  }

  if (safeTimeZone === "UTC" || safeTimeZone === "Etc/UTC") {
    return "UTC";
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? safeTimeZone;
}

function getSafeTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return DISPLAY_TIME_ZONE;
  }
}
