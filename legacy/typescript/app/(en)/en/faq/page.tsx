import type { Metadata } from "next";
import { FaqView } from "@/components/FaqView";
import {
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: {
    absolute: "Codex Reset FAQ | Usage Limits, Banked Resets, and Timing",
  },
  description:
    "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
  alternates: {
    canonical: siteUrl("/en/faq"),
    languages: {
      ja: siteUrl("/faq"),
      en: siteUrl("/en/faq"),
      zh: siteUrl("/zh/faq"),
      "x-default": siteUrl("/faq"),
    },
  },
  openGraph: {
    title: "Codex Reset FAQ | Usage Limits Reset Timing",
    description:
    "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
    url: siteUrl("/en/faq"),
    siteName: SITE_NAME,
    type: "article",
    locale: "en_US",
    alternateLocale: ["ja_JP"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "Codex Reset FAQ",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Codex Reset FAQ | Usage Limits Reset Timing",
    description:
      "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function EnglishFaqPage() {
  return <FaqView locale="en" />;
}
