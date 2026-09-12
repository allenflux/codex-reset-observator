import type { Metadata } from "next";
import { AboutView } from "@/components/AboutView";
import {
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: {
    absolute: "About " + SITE_NAME,
  },
  description:
    "Learn what " + SITE_NAME + " tracks, how reset history is handled, and how Banked Resets can affect account-specific usage windows.",
  alternates: {
    canonical: siteUrl("/en/about"),
    languages: {
      ja: siteUrl("/about"),
      en: siteUrl("/en/about"),
      zh: siteUrl("/zh/about"),
      "x-default": siteUrl("/about"),
    },
  },
  openGraph: {
    title: "About " + SITE_NAME,
    description:
      "A short explanation of the reset history, Banked Resets, and unscheduled reset probability shown on this unofficial Codex reset site.",
    url: siteUrl("/en/about"),
    siteName: SITE_NAME,
    type: "article",
    locale: "en_US",
    alternateLocale: ["ja_JP"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "About " + SITE_NAME,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "About " + SITE_NAME,
    description:
      "What this unofficial Codex reset site tracks and how to read its reset information.",
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function EnglishAboutPage() {
  return <AboutView locale="en" />;
}
