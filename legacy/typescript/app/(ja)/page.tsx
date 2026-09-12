import type { Metadata } from "next";
import { RadarDashboard } from "@/components/RadarDashboard";
import { fetchRadarPageData } from "@/lib/radarFetch";
import {
  HOME_DESCRIPTION_JA,
  HOME_TITLE_JA,
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const revalidate = 3600;

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: { absolute: HOME_TITLE_JA },
  description: HOME_DESCRIPTION_JA,
  alternates: {
    canonical: siteUrl("/"),
    languages: {
      ja: siteUrl("/"),
      en: siteUrl("/en"),
      zh: siteUrl("/zh"),
      "x-default": siteUrl("/"),
    },
  },
  openGraph: {
    title: HOME_TITLE_JA,
    description: HOME_DESCRIPTION_JA,
    url: siteUrl("/"),
    siteName: SITE_NAME,
    type: "website",
    locale: "ja_JP",
    images: [{ url: SITE_OG_IMAGE_URL, width: 1200, height: 630, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE_JA,
    description: HOME_DESCRIPTION_JA,
    images: [SITE_OG_IMAGE_URL],
  },
};

export default async function Home() {
  const pageDataStartedAt = performance.now();
  const pageData = await fetchRadarPageData("ja");
  console.info(JSON.stringify({
    event: "radar_page_route_fetch",
    route: "/",
    locale: "ja",
    pageType: "home",
    durationMs: performance.now() - pageDataStartedAt,
  }));

  return (
    <RadarDashboard
      initialData={pageData.initialData}
      initialFetchedAt={pageData.initialData.checkedAt}
      randomResetHeatmapEventTimes={pageData.randomResetHeatmapEventTimes}
      locale="ja"
    />
  );
}
