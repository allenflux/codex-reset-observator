import type { Locale } from "./types";
import type { TemporalPrecision, TemporalResolutionStatus } from "./tiboTemporal";
import { translateUI } from "./i18n";

export type OfficialNoticePresentationInput = {
  expectedAt?: string | null;
  expectedEndAt?: string | null;
  temporalPrecision?: TemporalPrecision | null;
  temporalResolutionStatus?: TemporalResolutionStatus | null;
  temporalTimezone?: string | null;
  isBankedDistribution?: boolean;
  isOngoingBankedDistribution?: boolean;
};

type NoticeTimingWindow = "24h" | "48h" | "outside";

function getLocaleName(locale: Locale) {
  return locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP";
}

function getPresentationTimeZone(timeZone: string) {
  const fixedOffsetAliases: Record<string, string> = {
    PST: "Etc/GMT+8",
    PDT: "Etc/GMT+7",
    EST: "Etc/GMT+5",
    EDT: "Etc/GMT+4",
  };
  return fixedOffsetAliases[timeZone.toUpperCase()] ?? timeZone;
}

function getResolvedNoticeDate(notice: OfficialNoticePresentationInput) {
  if (
    !notice.expectedAt ||
    notice.temporalResolutionStatus === "unresolved" ||
    notice.temporalResolutionStatus === "rejected" ||
    !notice.temporalPrecision ||
    notice.temporalPrecision === "unknown" ||
    !notice.temporalTimezone
  ) {
    return null;
  }

  const date = new Date(notice.expectedAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatJapaneseParentheses(value: string) {
  return value.replace(/\(([^)]+)\)/, "（$1）");
}

function formatScheduleWeekday(
  date: Date,
  timeZone: string,
  locale: Locale,
) {
  const value = new Intl.DateTimeFormat(getLocaleName(locale), {
    timeZone: getPresentationTimeZone(timeZone),
    weekday: "long",
  }).format(date);
  return value;
}

function formatExactSchedule(
  date: Date,
  timeZone: string,
  locale: Locale,
) {
  const localeName = getLocaleName(locale);
  const presentationTimeZone = getPresentationTimeZone(timeZone);
  const datePart = new Intl.DateTimeFormat(localeName, {
    timeZone: presentationTimeZone,
    month: "long",
    day: "numeric",
    weekday: locale === "ja" ? "short" : "long",
  }).format(date);
  const timePart = new Intl.DateTimeFormat(localeName, {
    timeZone: presentationTimeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: locale === "en",
  }).format(date);

  if (locale === "ja") {
    return `${formatJapaneseParentheses(datePart)} ${timePart}ごろ`;
  }
  if (locale === "zh") {
    return `${datePart} ${timePart}左右`;
  }
  return `${datePart} at ${timePart}`;
}

/** Returns a short, user-facing schedule subject without exposing resolver terminology. */
export function formatOfficialNoticeScheduleSubject(
  notice: OfficialNoticePresentationInput,
  locale: Locale,
) {
  const date = getResolvedNoticeDate(notice);
  const timeZone = notice.temporalTimezone;
  if (!date || !timeZone) return null;

  try {
    if (notice.temporalPrecision === "exact_time") {
      return formatExactSchedule(date, timeZone, locale);
    }
    return formatScheduleWeekday(date, timeZone, locale);
  } catch {
    return null;
  }
}

export function formatOfficialNoticeSummary(
  notice: OfficialNoticePresentationInput,
  locale: Locale,
) {
  if (notice.isBankedDistribution) {
    if (notice.isOngoingBankedDistribution) {
      return translateUI("ongoingBankedNoticeSummary", locale);
    }
    if (locale === "en") return "A BANKED Reset distribution has been announced.";
    if (locale === "zh") return "已发布 BANKED 重置发放预告。";
    return "BANKEDリセット（任意リセット権）の配布が予告されています。";
  }

  const subject = formatOfficialNoticeScheduleSubject(notice, locale);

  if (locale === "en") {
    return subject
      ? `An official notice says another reset is planned for ${subject}. Please check the latest status.`
      : "An official reset notice has been detected. Please check the latest status.";
  }
  if (locale === "zh") {
    return subject
      ? `有官方预告称计划在${subject}再次重置。请确认最新状态。`
      : "已检测到官方重置预告。请确认最新状态。";
  }
  return subject
    ? `${subject}に再度リセットを行う予定との予告があります。最新状況をご確認ください。`
    : "公式リセットの予告があります。最新状況をご確認ください。";
}

export function formatOfficialNoticeTimingReason(
  notice: OfficialNoticePresentationInput,
  locale: Locale,
  window: NoticeTimingWindow,
) {
  const subject = formatOfficialNoticeScheduleSubject(notice, locale);
  if (!subject) return null;

  if (window === "outside") {
    if (locale === "en") {
      return `An official reset notice is scheduled for ${subject}, but it is outside the next 24- and 48-hour forecast windows.`;
    }
    if (locale === "zh") {
      return `有安排在${subject}的官方重置预告，但目前仍在未来 24 小时和 48 小时预测范围之外。`;
    }
    return `${subject}の公式リセット予告はありますが、まだ24時間・48時間の予測範囲外です。`;
  }

  if (locale === "en") {
    return `An official reset notice is scheduled for ${subject}, raising the outlook within the next ${window === "24h" ? "24" : "48"} hours.`;
  }
  if (locale === "zh") {
    return `有安排在${subject}的官方重置预告，正在提高未来 ${window === "24h" ? "24" : "48"} 小时内的预期。`;
  }
  return `${subject}の公式リセット予告があり、${window === "24h" ? "24" : "48"}時間以内の見込みを押し上げています。`;
}
