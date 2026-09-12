import type { Metadata } from "next";
import { AboutView } from "@/components/AboutView";
import {
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: "このサイトについて",
  description:
    "Codexリセット観測所は、Codexのリセット情報を観測・整理する非公式サイトです。",
  alternates: {
    canonical: siteUrl("/about"),
    languages: {
      ja: siteUrl("/about"),
      en: siteUrl("/en/about"),
      zh: siteUrl("/zh/about"),
      "x-default": siteUrl("/about"),
    },
  },
  openGraph: {
    title: "このサイトについて",
    description:
      "Codexリセット観測所は、Codexのリセット情報を観測・整理する非公式サイトです。",
    url: siteUrl("/about"),
    siteName: SITE_NAME,
    type: "article",
    locale: "ja_JP",
    images: [{ url: SITE_OG_IMAGE_URL, width: 1200, height: 630, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: "このサイトについて",
    description:
      "Codexリセット観測所は、Codexのリセット情報を観測・整理する非公式サイトです。",
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function AboutPage() {
  return <AboutView locale="ja" />;
}
