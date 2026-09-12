import type { Metadata } from "next";
import { HistoryView } from "@/components/HistoryView";
import { fetchRadarPageData } from "@/lib/radarFetch";
import {
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: {
    absolute: "Codex Reset History - Recent Usage Limits Reset Signals",
  },
  description:
    "View Codex global resets, Banked Reset distributions, timestamps, and sources in chronological order.",
  alternates: {
    canonical: siteUrl("/en/history"),
    languages: {
      ja: siteUrl("/history"),
      en: siteUrl("/en/history"),
      zh: siteUrl("/zh/history"),
      "x-default": siteUrl("/history"),
    },
  },
  openGraph: {
    title: "Codex Reset History - Usage Limits Reset Signals",
    description:
      "View Codex global resets, Banked Reset distributions, timestamps, and sources in chronological order.",
    url: siteUrl("/en/history"),
    siteName: SITE_NAME,
    type: "article",
    locale: "en_US",
    alternateLocale: ["ja_JP"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "Codex Reset History",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Codex Reset History - Usage Limits Reset Signals",
    description:
      "View Codex global resets, Banked Reset distributions, timestamps, and sources in chronological order.",
    images: [SITE_OG_IMAGE_URL],
  },
};

export const revalidate = 3600;

export default async function EnglishHistoryPage() {
  const pageDataStartedAt = performance.now();
  const pageData = await fetchRadarPageData("en", {
    limitHistory: false,
    includeHeatmap: false,
  });
  console.info(JSON.stringify({
    event: "radar_page_route_fetch",
    route: "/en/history",
    locale: "en",
    pageType: "history",
    durationMs: performance.now() - pageDataStartedAt,
  }));

  return <HistoryView data={pageData.initialData} locale="en" />;
}
