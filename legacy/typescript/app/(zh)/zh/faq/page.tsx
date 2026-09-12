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
    absolute: "Codex 重置 FAQ | 重置时机、使用限制与手动重置",
  },
  description:
    "关于 Codex 重置具体时机、Token 和使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
  alternates: {
    canonical: siteUrl("/zh/faq"),
    languages: {
      ja: siteUrl("/faq"),
      en: siteUrl("/en/faq"),
      zh: siteUrl("/zh/faq"),
      "x-default": siteUrl("/faq"),
    },
  },
  openGraph: {
    title: "Codex 重置 FAQ",
    description:
      "关于 Codex 重置具体时机、使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
    url: siteUrl("/zh/faq"),
    siteName: SITE_NAME,
    type: "article",
    locale: "zh_CN",
    alternateLocale: ["ja_JP", "en_US"],
    images: [
      {
        url: SITE_OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "Codex 重置 FAQ",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Codex 重置 FAQ",
    description:
      "关于 Codex 重置具体时机、使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function ChineseFaqPage() {
  return <FaqView locale="zh" />;
}
