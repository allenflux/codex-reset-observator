import type { Metadata } from "next";
import { FaqView } from "@/components/FaqView";
import {
  SITE_NAME,
  SITE_OG_IMAGE_URL,
  siteUrl,
} from "@/lib/siteMetadata";

const FAQ_TITLE = "Codex・ChatGPT Work リセットFAQ | Codex Reset Observatory";
const FAQ_DESCRIPTION =
  "CodexやChatGPT Workのリセット、共有される利用上限、リセット時期、公式予告、過去の履歴や予測の見方を説明します。";

export const metadata: Metadata = {
  applicationName: SITE_NAME,
  title: { absolute: FAQ_TITLE },
  description: FAQ_DESCRIPTION,
  alternates: {
    canonical: siteUrl("/faq"),
    languages: {
      ja: siteUrl("/faq"),
      en: siteUrl("/en/faq"),
      zh: siteUrl("/zh/faq"),
      "x-default": siteUrl("/faq"),
    },
  },
  openGraph: {
    title: FAQ_TITLE,
    description: FAQ_DESCRIPTION,
    url: siteUrl("/faq"),
    siteName: SITE_NAME,
    type: "article",
    locale: "ja_JP",
    images: [{ url: SITE_OG_IMAGE_URL, width: 1200, height: 630, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title: FAQ_TITLE,
    description: FAQ_DESCRIPTION,
    images: [SITE_OG_IMAGE_URL],
  },
};

export default function FaqPage() {
  return <FaqView locale="ja" />;
}
