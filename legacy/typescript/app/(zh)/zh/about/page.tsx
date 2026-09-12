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
    absolute: "关于 " + SITE_NAME,
  },
  description:
    "了解 " + SITE_NAME + " 观测的内容、如何处理重置历史，以及手动重置可能如何影响账号使用周期。",
  alternates: {
    canonical: siteUrl("/zh/about"),
    languages: {
      ja: siteUrl("/about"),
      en: siteUrl("/en/about"),
      zh: siteUrl("/zh/about"),
      "x-default": siteUrl("/about"),
    },
  },
  openGraph: {
    title: "关于 " + SITE_NAME,
    description:
      "在本站简要了解 Codex 重置历史、手动重置以及随机重置期望度。",
    url: siteUrl("/zh/about"),
    siteName: SITE_NAME,
    type: "article",
    locale: "zh_CN",
    alternateLocale: ["ja_JP", "en_US"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "关于 " + SITE_NAME,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "关于 " + SITE_NAME,
    description:
      "本站简要了解 Codex 重置历史、手动重置以及随机重置期望度。",
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function ChineseAboutPage() {
  return <AboutView locale="zh" />;
}
