"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { HistorySourceKind, Locale, PublicRadarSnapshot } from "@/lib/radar/types";
import { DISPLAY_TIME_ZONE, isSafeHttpUrl } from "@/lib/radar/helpers";
import { translateDynamic, translateUI } from "@/lib/radar/i18n";
import { getBrowserTimeZone, LocalizedDateTime } from "@/components/LocalizedDateTime";
import { ResetHistoryDetails } from "@/components/ResetHistoryDetails";

type HistoryItem = PublicRadarSnapshot["viewModel"]["recentHistory"][number];

export function getHistoryDateTimeProps(item: Pick<HistoryItem, "resetAt">) {
  return {
    value: item.resetAt,
    approximate: false,
  } as const;
}

export function getHistoryMonthLabel(
  value: string | null | undefined,
  locale: Locale,
  timeZone: string,
) {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    return locale === "en" ? "Date unknown" : locale === "zh" ? "日期未知" : "日付不明";
  }

  const language = locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP";
  const safeTimeZone = getSafeTimeZone(timeZone);
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "long",
    timeZone: safeTimeZone,
  }).format(new Date(value));
}

export function groupHistoryByMonth(
  items: HistoryItem[],
  locale: Locale,
  timeZone: string,
) {
  const groups = new Map<string, { label: string; items: HistoryItem[] }>();
  const safeTimeZone = getSafeTimeZone(timeZone);

  for (const item of items) {
    const date = item.resetAt ?? item.date ?? null;
    const label = getHistoryMonthLabel(date, locale, safeTimeZone);
    const key = date && !Number.isNaN(new Date(date).getTime())
      ? new Intl.DateTimeFormat("en-CA", {
          year: "numeric",
          month: "2-digit",
          timeZone: safeTimeZone,
        }).format(new Date(date))
      : "unknown";
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return Array.from(groups.values());
}

function getSafeTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return DISPLAY_TIME_ZONE;
  }
}

function hasPriorSignal(item: HistoryItem) {
  if (!item.signalAt || !item.resetAt) return false;
  const signalTime = new Date(item.signalAt).getTime();
  const resetTime = new Date(item.resetAt).getTime();
  return Number.isFinite(signalTime) && Number.isFinite(resetTime) && signalTime < resetTime;
}

function getSourceLabel(sourceKind: HistorySourceKind | undefined, locale: Locale) {
  switch (sourceKind) {
    case "direct_post":
      return translateUI("sourceOriginalPost", locale);
    case "profile":
      return translateUI("sourceProfile", locale);
    case "official_status":
      return translateUI("sourceOfficialStatus", locale);
    default:
      return translateUI("sourceNotRecorded", locale);
  }
}

function HistorySource({ item, locale }: { item: HistoryItem; locale: Locale }) {
  if (item.details?.cycleType === translateDynamic("定期リセット", locale)) {
    return null;
  }

  const label = getSourceLabel(item.sourceKind, locale);
  const canLink = Boolean(item.sourceKind && item.sourceKind !== "none" && isSafeHttpUrl(item.source));

  return canLink ? (
    <a
      className="inline-flex items-center gap-1 font-semibold text-teal-700 underline-offset-4 hover:underline"
      href={item.source ?? undefined}
      rel="noreferrer"
      target="_blank"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  ) : (
    <span className="text-slate-500">{label}</span>
  );
}

function getHistoryDisplayTitle(item: HistoryItem, locale: Locale) {
  const title = translateDynamic(item.title, locale);
  if (
    item.recordKind !== "reference" ||
    item.details?.cycleType === translateDynamic("定期リセット", locale)
  ) {
    return title;
  }

  return locale === "en"
    ? `${title} (reference record)`
    : locale === "zh"
      ? `${title}（参考记录）`
      : `${title}（参考記録）`;
}

function HistoryItemRow({ item, locale }: { item: HistoryItem; locale: Locale }) {
  return (
    <article
      className="grid gap-4 py-5 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto]"
      key={item.key}
    >
      <div>
        <h4 className="ui-heading text-lg font-semibold text-slate-950">
          {getHistoryDisplayTitle(item, locale)}
        </h4>
        <ResetHistoryDetails item={item} locale={locale} />
      </div>

      <div className="text-sm leading-6 text-slate-700 md:text-right">
        {hasPriorSignal(item) ? (
          <p>
            {item.signalLabel}{locale === "en" ? ": " : "："}<LocalizedDateTime value={item.signalAt} locale={locale} />
          </p>
        ) : null}
        {item.resetAt ? (
          <p>
            {item.resetLabel}{locale === "en" ? ": " : "："}<LocalizedDateTime {...getHistoryDateTimeProps(item)} locale={locale} />
          </p>
        ) : null}
        <HistorySource item={item} locale={locale} />
      </div>
    </article>
  );
}

export function LocalizedHistoryEvents({
  title,
  empty,
  items,
  locale,
}: {
  title: string;
  empty: string;
  items: HistoryItem[];
  locale: Locale;
}) {
  // Keep month headings crawlable during SSR using the same deterministic
  // JST fallback as LocalizedDateTime, then regroup in the viewer's zone.
  const [timeZone, setTimeZone] = useState<string>(DISPLAY_TIME_ZONE);

  useEffect(() => {
    setTimeZone(getBrowserTimeZone());
  }, []);

  const groups = groupHistoryByMonth(items, locale, timeZone);

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm"
    >
      <header className="border-b border-slate-100 pb-4">
        <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      </header>
      <div className="mt-5 space-y-7">
        {items.length === 0 ? (
          <p className="text-sm leading-6 text-slate-600">{empty}</p>
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <h3 className="text-sm font-semibold text-teal-800">{group.label}</h3>
              <div className="mt-2 divide-y divide-slate-100">
                {group.items.map((item) => (
                  <HistoryItemRow item={item} key={item.key} locale={locale} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
