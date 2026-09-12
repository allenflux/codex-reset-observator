import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";
import { fileURLToPath } from "node:url";

import { RadarDashboard } from "../components/RadarDashboard";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  getSiteJsonLd,
  HOME_DESCRIPTION_EN,
  HOME_DESCRIPTION_JA,
  HOME_DESCRIPTION_ZH,
  HOME_TITLE_EN,
  HOME_TITLE_JA,
  HOME_TITLE_ZH,
  SITE_NAME,
  SITE_NAME_JA,
  SITE_OG_IMAGE_URL,
  SITE_URL,
  siteUrl,
} from "../lib/siteMetadata";
import { metadata as jaHomeMetadata, revalidate as jaHomeRevalidate } from "../app/(ja)/page";
import { metadata as enHomeMetadata, revalidate as enHomeRevalidate } from "../app/(en)/en/page";
import { metadata as zhHomeMetadata, revalidate as zhHomeRevalidate } from "../app/(zh)/zh/page";
import { metadata as jaAboutMetadata } from "../app/(ja)/about/page";
import { metadata as enAboutMetadata } from "../app/(en)/en/about/page";
import { metadata as zhAboutMetadata } from "../app/(zh)/zh/about/page";
import { metadata as jaFaqMetadata } from "../app/(ja)/faq/page";
import { metadata as enFaqMetadata } from "../app/(en)/en/faq/page";
import { metadata as zhFaqMetadata } from "../app/(zh)/zh/faq/page";
import { metadata as jaHistoryMetadata, revalidate as jaHistoryRevalidate } from "../app/(ja)/history/page";
import { metadata as enHistoryMetadata, revalidate as enHistoryRevalidate } from "../app/(en)/en/history/page";
import { metadata as zhHistoryMetadata, revalidate as zhHistoryRevalidate } from "../app/(zh)/zh/history/page";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function titleFrom(metadata: Metadata): string {
  if (typeof metadata.title === "string") {
    return metadata.title;
  }

  const title = metadata.title;
  if (!title) return "";
  return "absolute" in title ? title.absolute ?? "" : title.default ?? "";
}

function openGraphFrom(metadata: Metadata) {
  assert.ok(metadata.openGraph && !Array.isArray(metadata.openGraph));
  return metadata.openGraph;
}

test("home metadata preserves exact localized SEO contracts", () => {
  const homeCases = [
    {
      locale: "ja",
      metadata: jaHomeMetadata,
      titleConstant: HOME_TITLE_JA,
      descriptionConstant: HOME_DESCRIPTION_JA,
      path: "/",
      expectedTitle: "Codexリセット観測所｜タイミング・履歴・次回予測",
      expectedDescription: "Codexの最新リセット時刻、過去の履歴、公式予告、24時間・48時間以内のリセット予測を確認できます。",
    },
    {
      locale: "en",
      metadata: enHomeMetadata,
      titleConstant: HOME_TITLE_EN,
      descriptionConstant: HOME_DESCRIPTION_EN,
      path: "/en",
      expectedTitle: "Codex Reset Observatory | Reset Timing, Forecasts & History",
      expectedDescription: "Check the latest Codex reset time, recent history, official notices, and reset forecasts for the next 24 and 48 hours.",
    },
    {
      locale: "zh",
      metadata: zhHomeMetadata,
      titleConstant: HOME_TITLE_ZH,
      descriptionConstant: HOME_DESCRIPTION_ZH,
      path: "/zh",
      expectedTitle: "Codex 重置观测站｜使用额度、时间、历史与预测",
      expectedDescription: "查看 Codex 最新重置时间、历史记录、官方预告，以及未来 24 小时和 48 小时内的重置预测。",
    },
  ] as const;

  assert.strictEqual(SITE_NAME, "Codex Reset Observatory");
  assert.strictEqual(SITE_NAME_JA, "Codexリセット観測所");

  for (const item of homeCases) {
    assert.strictEqual(item.titleConstant, item.expectedTitle, item.locale);
    assert.strictEqual(item.descriptionConstant, item.expectedDescription, item.locale);
    assert.strictEqual(item.metadata.applicationName, SITE_NAME, item.locale);
    assert.strictEqual(titleFrom(item.metadata), item.expectedTitle, item.locale);
    assert.strictEqual(item.metadata.description, item.expectedDescription, item.locale);

    const openGraph = openGraphFrom(item.metadata);
    assert.strictEqual(openGraph.siteName, SITE_NAME, item.locale);
    assert.strictEqual(openGraph.title, item.expectedTitle, item.locale);
    assert.strictEqual(openGraph.description, item.expectedDescription, item.locale);
    assert.strictEqual(openGraph.url, siteUrl(item.path), item.locale);
    const firstImage = Array.isArray(openGraph.images) ? openGraph.images[0] : openGraph.images;
    const firstImageUrl =
      typeof firstImage === "string"
        ? firstImage
        : firstImage instanceof URL
          ? firstImage.toString()
          : firstImage?.url;
    assert.strictEqual(firstImageUrl, SITE_OG_IMAGE_URL, item.locale);

    assert.strictEqual(item.metadata.twitter?.title, item.expectedTitle, item.locale);
    assert.strictEqual(item.metadata.twitter?.description, item.expectedDescription, item.locale);
    assert.deepStrictEqual(item.metadata.twitter?.images, [SITE_OG_IMAGE_URL], item.locale);
  }
});

test("localized radar pages use a one-hour ISR interval", () => {
  assert.deepStrictEqual(
    [
      jaHomeRevalidate,
      enHomeRevalidate,
      zhHomeRevalidate,
      jaHistoryRevalidate,
      enHistoryRevalidate,
      zhHistoryRevalidate,
    ],
    [3600, 3600, 3600, 3600, 3600, 3600],
  );
});

test("home SEO descriptions expose only the public 24-hour and 48-hour horizons", () => {
  for (const description of [HOME_DESCRIPTION_JA, HOME_DESCRIPTION_EN, HOME_DESCRIPTION_ZH]) {
    assert.match(description, /24/);
    assert.match(description, /48/);
    assert.doesNotMatch(description, /12|72/);
  }
});

test("localized FAQ metadata preserves search contracts", () => {
  const cases = [
    {
      metadata: jaFaqMetadata,
      title: "Codex・ChatGPT Work リセットFAQ | Codex Reset Observatory",
      description: "CodexやChatGPT Workのリセット、共有される利用上限、リセット時期、公式予告、過去の履歴や予測の見方を説明します。",
      openGraphTitle: "Codex・ChatGPT Work リセットFAQ | Codex Reset Observatory",
      openGraphDescription: "CodexやChatGPT Workのリセット、共有される利用上限、リセット時期、公式予告、過去の履歴や予測の見方を説明します。",
      twitterDescription: "CodexやChatGPT Workのリセット、共有される利用上限、リセット時期、公式予告、過去の履歴や予測の見方を説明します。",
    },
    {
      metadata: enFaqMetadata,
      title: "Codex Reset FAQ | Usage Limits, Banked Resets, and Timing",
      description: "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
      openGraphTitle: "Codex Reset FAQ | Usage Limits Reset Timing",
      openGraphDescription: "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
      twitterDescription: "Did Codex reset today? Find answers about usage limits reset timing, Banked Resets, reset history, and why the forecast changes.",
    },
    {
      metadata: zhFaqMetadata,
      title: "Codex 重置 FAQ | 重置时机、使用限制与手动重置",
      description: "关于 Codex 重置具体时机、Token 和使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
      openGraphTitle: "Codex 重置 FAQ",
      openGraphDescription: "关于 Codex 重置具体时机、使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
      twitterDescription: "关于 Codex 重置具体时机、使用额度重置、手动重置以及随机重置期望度的常见问题解答。",
    },
  ] as const;

  for (const item of cases) {
    const openGraph = openGraphFrom(item.metadata);
    assert.equal(titleFrom(item.metadata), item.title);
    assert.equal(item.metadata.description, item.description);
    assert.equal(openGraph.title, item.openGraphTitle);
    assert.equal(openGraph.description, item.openGraphDescription);
    assert.equal(item.metadata.twitter?.title, item.openGraphTitle);
    assert.equal(item.metadata.twitter?.description, item.twitterDescription);
  }
});

test("llms description keeps Codex central while explaining the shared Work pool", () => {
  const llms = readFileSync(join(root, "public/llms.txt"), "utf8");

  assert.match(llms, /independent website that tracks and forecasts OpenAI Codex usage limits resets/);
  assert.match(llms, /Codex and ChatGPT Work remain separate experiences/);
  assert.match(llms, /agentic usage and credits pool/);
});

test("WebSite JSON-LD uses one formal name and only the Japanese alternate name", () => {
  for (const locale of ["ja", "en", "zh"] as const) {
    const jsonLd = getSiteJsonLd(locale);

    assert.strictEqual(jsonLd.name, SITE_NAME);
    assert.deepStrictEqual(jsonLd.alternateName, [SITE_NAME_JA]);
    assert.strictEqual(jsonLd.url, siteUrl("/"));
    assert.strictEqual(jsonLd["@id"], SITE_URL + "/#website");
    assert.doesNotMatch(JSON.stringify(jsonLd.alternateName), /vercel|\.app/i);
  }

  const jsonLdSource = readFileSync(join(root, "components/SiteJsonLd.tsx"), "utf8");
  assert.strictEqual((jsonLdSource.match(/getSiteJsonLd\(/g) ?? []).length, 1);

  for (const [layout, lang] of [
    ["app/(ja)/layout.tsx", "ja"],
    ["app/(en)/layout.tsx", "en"],
    ["app/(zh)/layout.tsx", "zh"],
  ] as const) {
    const source = readFileSync(join(root, layout), "utf8");
    assert.match(source, new RegExp(`<html lang="${lang}">`));
    assert.match(source, new RegExp(`<SiteJsonLd locale="${lang}"`));
    assert.doesNotMatch(source, /headers\(|x-codex-pathname/);
  }
});

test("all localized pages use the formal application name and absolute URL metadata", () => {
  const pages = [
    [jaHomeMetadata, "/"],
    [enHomeMetadata, "/en"],
    [zhHomeMetadata, "/zh"],
    [jaAboutMetadata, "/about"],
    [enAboutMetadata, "/en/about"],
    [zhAboutMetadata, "/zh/about"],
    [jaFaqMetadata, "/faq"],
    [enFaqMetadata, "/en/faq"],
    [zhFaqMetadata, "/zh/faq"],
    [jaHistoryMetadata, "/history"],
    [enHistoryMetadata, "/en/history"],
    [zhHistoryMetadata, "/zh/history"],
  ] as const;

  for (const [metadata, path] of pages) {
    assert.strictEqual(metadata.applicationName, SITE_NAME, path);
    assert.strictEqual(openGraphFrom(metadata).siteName, SITE_NAME, path);
    assert.strictEqual(openGraphFrom(metadata).url, siteUrl(path), path);
    assert.strictEqual(metadata.alternates?.canonical, siteUrl(path), path);
    assert.strictEqual("keywords" in metadata, false, path);
  }
});

test("history metadata describes the combined chronological reset list", () => {
  const cases = [
    {
      metadata: jaHistoryMetadata,
      description: "Codexの全体リセット、任意リセット配布、実施時刻、出典を新しい順に確認できます。",
    },
    {
      metadata: enHistoryMetadata,
      description: "View Codex global resets, Banked Reset distributions, timestamps, and sources in chronological order.",
    },
    {
      metadata: zhHistoryMetadata,
      description: "按时间倒序查看 Codex 全局重置、手动重置发放记录、执行时间和来源。",
    },
  ];

  for (const { metadata, description } of cases) {
    assert.equal(metadata.description, description);
    assert.equal(openGraphFrom(metadata).description, description);
    assert.equal(metadata.twitter?.description, description);
  }
});

test("canonical and hreflang links point to the same three localized routes", () => {
  for (const metadata of [jaHomeMetadata, enHomeMetadata, zhHomeMetadata]) {
    assert.deepStrictEqual(metadata.alternates?.languages, {
      ja: siteUrl("/"),
      en: siteUrl("/en"),
      zh: siteUrl("/zh"),
      "x-default": siteUrl("/"),
    });
  }
});

test("all localized page clusters use the Japanese page as x-default", () => {
  const pageClusters = [
    {
      path: "/",
      metadata: [jaHomeMetadata, enHomeMetadata, zhHomeMetadata],
    },
    {
      path: "/about",
      metadata: [jaAboutMetadata, enAboutMetadata, zhAboutMetadata],
    },
    {
      path: "/faq",
      metadata: [jaFaqMetadata, enFaqMetadata, zhFaqMetadata],
    },
    {
      path: "/history",
      metadata: [jaHistoryMetadata, enHistoryMetadata, zhHistoryMetadata],
    },
  ];

  for (const { path, metadata } of pageClusters) {
    for (const pageMetadata of metadata) {
      assert.deepStrictEqual(pageMetadata.alternates?.languages, {
        ja: siteUrl(path),
        en: siteUrl(path === "/" ? "/en" : `/en${path}`),
        zh: siteUrl(path === "/" ? "/zh" : `/zh${path}`),
        "x-default": siteUrl(path),
      }, path);
    }
  }
});

test("Japanese home HTML exposes the Japanese main brand and English supporting name", () => {
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(getLocalRadarData({}), "ja"),
      locale: "ja",
    }),
  );

  assert.match(html, /<h1[^>]*>Codexリセット観測所<\/h1>/);
  assert.match(html, /<p[^>]*>Codex Reset Observatory<\/p>/);
});

test("all home locales use the locale-appropriate main heading and formal brand", () => {
  const expectedHeadings = {
    ja: "Codexリセット観測所",
    en: "Codex Reset Observatory",
    zh: "Codex 重置观测站",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(getLocalRadarData({}), locale),
        locale,
      }),
    );

    assert.match(html, new RegExp(`<h1[^>]*>${expectedHeadings[locale]}<\\/h1>`), locale);
    assert.match(html, /Codex Reset Observatory/, locale);
  }
});

test("localized root layouts avoid keywords, headers, and duplicate JSON-LD", () => {
  const layoutSources = [
    "app/(ja)/layout.tsx",
    "app/(en)/layout.tsx",
    "app/(zh)/layout.tsx",
  ].map((path) => readFileSync(join(root, path), "utf8"));

  for (const layoutSource of layoutSources) {
    assert.doesNotMatch(layoutSource, /keywords\s*:/);
    assert.doesNotMatch(layoutSource, /headers\(/);
    assert.strictEqual((layoutSource.match(/application\/ld\+json/g) ?? []).length, 0);
  }

});
