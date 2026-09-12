import type { Metadata } from "next";

export const SITE_URL = "https://codex.gussuriworks.com";
export const SITE_NAME = "Codex Reset Observatory";
export const SITE_NAME_JA = "Codexリセット観測所";
export const SITE_OG_IMAGE_URL = SITE_URL + "/og-image.png";

export const HOME_TITLE_JA = "Codexリセット観測所｜タイミング・履歴・次回予測";
export const HOME_DESCRIPTION_JA =
  "Codexの最新リセット時刻、過去の履歴、公式予告、24時間・48時間以内のリセット予測を確認できます。";
export const HOME_TITLE_EN =
  "Codex Reset Observatory | Reset Timing, Forecasts & History";
export const HOME_DESCRIPTION_EN =
  "Check the latest Codex reset time, recent history, official notices, and reset forecasts for the next 24 and 48 hours.";
export const HOME_TITLE_ZH = "Codex 重置观测站｜使用额度、时间、历史与预测";
export const HOME_DESCRIPTION_ZH =
  "查看 Codex 最新重置时间、历史记录、官方预告，以及未来 24 小时和 48 小时内的重置预测。";

export function siteUrl(path = "/"): string {
  if (path === "/") {
    return SITE_URL + "/";
  }

  return SITE_URL + (path.startsWith("/") ? path : "/" + path);
}

export type SiteLocale = "ja" | "en" | "zh";

export function getRootMetadata(locale: SiteLocale): Metadata {
  const path = locale === "ja" ? "/" : `/${locale}`;
  const title =
    locale === "ja" ? HOME_TITLE_JA : locale === "en" ? HOME_TITLE_EN : HOME_TITLE_ZH;
  const description =
    locale === "ja"
      ? HOME_DESCRIPTION_JA
      : locale === "en"
        ? HOME_DESCRIPTION_EN
        : HOME_DESCRIPTION_ZH;
  const openGraphLocale = locale === "ja" ? "ja_JP" : locale === "en" ? "en_US" : "zh_CN";

  return {
    metadataBase: new URL(SITE_URL),
    applicationName: SITE_NAME,
    title: { default: title, template: "%s | " + SITE_NAME },
    description,
    alternates: {
      canonical: siteUrl(path),
      languages: {
        ja: siteUrl("/"),
        en: siteUrl("/en"),
        zh: siteUrl("/zh"),
        "x-default": siteUrl("/"),
      },
    },
    openGraph: {
      title,
      description,
      url: siteUrl(path),
      siteName: SITE_NAME,
      locale: openGraphLocale,
      type: "website",
      images: [{ url: SITE_OG_IMAGE_URL, width: 1200, height: 630, alt: SITE_NAME }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SITE_OG_IMAGE_URL],
    },
  };
}

export function getSiteJsonLd(locale: "ja" | "en" | "zh" = "ja") {
  const descriptions = {
    ja: HOME_DESCRIPTION_JA,
    en: HOME_DESCRIPTION_EN,
    zh: HOME_DESCRIPTION_ZH,
  };

  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": SITE_URL + "/#website",
    name: SITE_NAME,
    alternateName: [SITE_NAME_JA],
    url: siteUrl("/"),
    description: descriptions[locale],
    inLanguage: locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP",
  };
}
