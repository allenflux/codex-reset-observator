import type { Metadata } from "next";
import { RadarDashboard } from "@/components/RadarDashboard";
import { fetchRadarPageData } from "@/lib/radarFetch";
import {
  HOME_DESCRIPTION_EN,
  HOME_TITLE_EN,
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const revalidate = 3600;

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: { absolute: HOME_TITLE_EN },
  description: HOME_DESCRIPTION_EN,
  alternates: {
    canonical: siteUrl("/en"),
    languages: {
      ja: siteUrl("/"),
      en: siteUrl("/en"),
      zh: siteUrl("/zh"),
      "x-default": siteUrl("/"),
    },
  },
  openGraph: {
    title: HOME_TITLE_EN,
    description: HOME_DESCRIPTION_EN,
    url: siteUrl("/en"),
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
    alternateLocale: ["ja_JP"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: SITE_NAME,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE_EN,
    description: HOME_DESCRIPTION_EN,
    images: [SITE_OG_IMAGE_URL],
  },
};

export default async function EnglishHome() {
  const pageDataStartedAt = performance.now();
  const pageData = await fetchRadarPageData("en");
  console.info(JSON.stringify({
    event: "radar_page_route_fetch",
    route: "/en",
    locale: "en",
    pageType: "home",
    durationMs: performance.now() - pageDataStartedAt,
  }));

  return (
    <RadarDashboard
      initialData={pageData.initialData}
      initialFetchedAt={pageData.initialData.checkedAt}
      randomResetHeatmapEventTimes={pageData.randomResetHeatmapEventTimes}
      locale="en"
    />
  );
}
