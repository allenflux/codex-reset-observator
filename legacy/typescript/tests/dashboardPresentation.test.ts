import React from "react";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AboutView } from "../components/AboutView";
import { formatScheduledSourceDay, RadarDashboard } from "../components/RadarDashboard";
import { FaqView } from "../components/FaqView";
import { LocalizedHistoryEvents } from "../components/LocalizedHistoryEvents";
import { formatProbabilityDisplay, ProbabilityMetrics } from "../components/ProbabilityMetrics";
import { ResetHistoryDetails } from "../components/ResetHistoryDetails";
import { TiboActivityCard } from "../components/TiboActivityCard";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  getHistoryNoticePresentation,
  getLocalRadarData,
  getRadarViewModel,
  getRandomResetHeatmapEventTimes,
} from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { getDisplayProbabilityReason, getLocalSignalEvaluation } from "../lib/radar/probability";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import { translateDynamic } from "../lib/radar/i18n";
import { getHistoricalResetPresentationCorrection } from "../lib/radar/historicalResetCorrections";
import {
  buildResetExecutionEstimate,
  MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION,
} from "../lib/radar/resetExecution";
import type { FormalTiboResetSignal, TiboNoticeSignal } from "../lib/radar/tiboHistory";
import type { ActiveTiboSignal, ResetDisplayNameRecord } from "../lib/radar/types";
import type { CodexRecoveryObservation } from "../lib/codexUsageRecovery";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("renders only the 24-hour and 48-hour probability progressbars", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProbabilityMetrics, {
      locale: "en",
      probability24h: 0.23,
      probability48h: 0.765,
    }),
  );

  assert.strictEqual((html.match(/role="progressbar"/g) ?? []).length, 2);
  assert.match(html, /aria-label="Within 24h"/);
  assert.match(html, /aria-label="Within 48h"/);
  assert.doesNotMatch(html, /aria-label="Within 12 hours"/);
  assert.doesNotMatch(html, /aria-label="Within 72 hours"/);
  assert.strictEqual((html.match(/aria-valuemin="0"/g) ?? []).length, 2);
  assert.strictEqual((html.match(/aria-valuemax="100"/g) ?? []).length, 2);
  assert.match(html, />23%</);
  assert.match(html, />77%</);
  assert.match(html, /aria-valuenow="23"/);
  assert.match(html, /aria-valuenow="77"/);
});

test("formats probability cards as localized whole percentages", () => {
  assert.equal(formatProbabilityDisplay(0.213, "ja"), "21%");
  assert.equal(formatProbabilityDisplay(0.765, "en"), "77%");
  assert.equal(formatProbabilityDisplay(0.405, "zh"), "41%");
});

test("renders unknown probabilities without aria-valuenow and with localized value text", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProbabilityMetrics, {
      locale: "en",
      probability24h: undefined,
      probability48h: undefined,
    }),
  );

  assert.strictEqual((html.match(/role="progressbar"/g) ?? []).length, 2);
  assert.strictEqual((html.match(/aria-valuenow=/g) ?? []).length, 0);
  assert.strictEqual((html.match(/aria-valuetext="Unknown"/g) ?? []).length, 2);
});

test("keeps normal dashboard presentation when recovery is provisional", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "ja",
    { calculationNow },
  );
  const displayReasoningSummary = snapshot.viewModel.displayReasoningSummary;
  assert.ok(displayReasoningSummary);

  const provisionalSnapshot = {
    ...snapshot,
    recoveryObservation: {
      status: "observed_unconfirmed" as const,
      observedAt: "2026-08-03T23:30:00.000Z",
      confidence: "strong" as const,
      cycleHint: "unexpected" as const,
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: provisionalSnapshot,
      locale: "ja",
    }),
  );

  assert.match(html, /aria-label="24時間以内"/);
  assert.match(html, /aria-label="48時間以内"/);
  assert.ok(html.includes(displayReasoningSummary), "normal reasoning summary should remain visible");
  assert.match(html, /公式リセット予告[\s\S]*なし/);
  assert.doesNotMatch(html, /利用枠の回復を観測/);
  assert.doesNotMatch(html, /Tiboによる全体リセットの完了発表を確認中です。/);
  assert.doesNotMatch(html, /確認中/);
  assert.doesNotMatch(html, /aria-valuetext="不明"/);
});

test("keeps unknown dashboard values when data is truly unavailable", () => {
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: null, locale: "ja" }),
  );

  assert.strictEqual((html.match(/aria-valuetext="不明"/g) ?? []).length, 2);
  assert.match(html, /データを取得できません|確率表示を一時停止しています/);
});

test("dashboard shows the latest Tibo activity below history for the experiment", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      activeTiboSignals: [
        {
          tweet_id: "private-tweet-id",
          signal_type: "teaser",
          text: "A reset hint from Tibo",
          tweet_url: "https://x.com/thsottiaux/status/123",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-05T00:00:00.000Z",
          verification_status: "auto_unverified",
          confidence: 0.87,
          classification_reason: "private internal reason",
        },
      ],
    }),
    "en",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
  );

  const activityIndex = html.indexOf("Latest Tibo post");
  const historyIndex = html.indexOf("Recent reset events");
  const heatmapIndex = html.indexOf("Past random reset times");
  assert.ok(activityIndex > historyIndex && activityIndex > heatmapIndex);
  assert.doesNotMatch(html, /Latest post/);
  assert.match(html, /A reset hint from Tibo/);
  assert.match(html, /Observed classification/);
  assert.match(html, /Reset hint/);
  assert.match(html, /href="https:\/\/x\.com\/thsottiaux\/status\/123"/);
  assert.doesNotMatch(html, /private-tweet-id|private internal reason|classification_reason/);

  const postIndex = html.indexOf("A reset hint from Tibo");
  const classificationIndex = html.indexOf("Observed classification");
  assert.ok(postIndex >= 0 && postIndex < classificationIndex);
});

test("uses clear Japanese labels for the Tibo post card and unrelated classification", () => {
  const html = renderToStaticMarkup(
    React.createElement(TiboActivityCard, {
      locale: "ja",
      activity: {
        classification: "irrelevant",
        teaserStrength: null,
        text: "リセットとは関係のない投稿です。",
        createdAt: "2026-08-07T05:23:00.000Z",
        sourceUrl: "https://x.com/thsottiaux/status/123",
        isReply: false,
        replyContextText: null,
        replyToHandles: [],
      },
    }),
  );

  assert.match(html, /Tiboの最新投稿/);
  assert.match(html, /<blockquote[^>]*>/);
  assert.match(html, /aria-hidden="true"[^>]*>「<\/span>/);
  assert.match(html, />リセットとは関係のない投稿です。<\/span>/);
  assert.match(html, /aria-hidden="true"[^>]*>」<\/span>/);
  assert.match(html, /リセットとは無関係/);
  assert.match(html, /Tibo \(@thsottiaux\)/);
  assert.doesNotMatch(html, /Tibo氏の最新動向|>その他</);
});

test("uses the UI teaser strength for card classification without changing signal type", () => {
  const html = renderToStaticMarkup(
    React.createElement(TiboActivityCard, {
      locale: "ja",
      activity: {
        classification: "irrelevant",
        teaserStrength: "weak",
        text: "I feel Theo is in need of a reset",
        createdAt: "2026-08-07T21:46:56.000Z",
        sourceUrl: "https://x.com/thsottiaux/status/2085845171363791135",
        isReply: false,
        replyContextText: null,
        replyToHandles: [],
      },
    }),
  );

  assert.match(html, /弱いリセット匂わせ/);
  assert.doesNotMatch(html, /リセットとは無関係/);
});

test("renders reply context and the observed classification label", () => {
  const html = renderToStaticMarkup(
    React.createElement(TiboActivityCard, {
      locale: "ja",
      variant: "related",
      activity: {
        classification: "teaser",
        teaserStrength: "weak",
        text: "Maybe",
        createdAt: "2026-08-16T18:57:17.000Z",
        sourceUrl: "https://x.com/thsottiaux/status/2089063967301730789",
        isReply: true,
        replyContextText: "are we going to get a reset when codex crosses 20M users?",
        replyToHandles: ["@Ananth7e"],
      },
    }),
  );

  assert.match(html, /返信先の投稿/);
  assert.match(html, /@Ananth7e/);
  assert.match(html, /are we going to get a reset when codex crosses 20M users\?/);
  assert.match(html, /Tiboの返信/);
  assert.match(html, />Maybe<\/span>/);
  assert.match(html, /観測分類/);
  assert.match(html, /弱いリセット匂わせ/);
});

test("renders a related Tibo heading when the card uses the related variant", () => {
  const html = renderToStaticMarkup(
    React.createElement(TiboActivityCard, {
      locale: "en",
      variant: "related",
      activity: {
        classification: "official_notice",
        teaserStrength: null,
        text: "A current notice",
        createdAt: "2026-08-07T21:46:56.000Z",
        sourceUrl: "https://x.com/thsottiaux/status/related-variant",
        isReply: false,
        replyContextText: null,
        replyToHandles: [],
      },
    }),
  );

  assert.match(html, /Related Tibo post/);
  assert.match(html, /Tibo \(@thsottiaux\)/);
  assert.doesNotMatch(html, /Latest Tibo post/);
});

test("keeps the Tibo handle unchanged across supported locales", () => {
  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(TiboActivityCard, {
        locale,
        variant: "related",
        activity: {
          classification: "official_notice",
          teaserStrength: null,
          text: "A current notice",
          createdAt: "2026-08-07T21:46:56.000Z",
          sourceUrl: "https://x.com/thsottiaux/status/locale-handle",
          isReply: false,
          replyContextText: null,
          replyToHandles: [],
        },
      }),
    );

    assert.match(html, /Tibo \(@thsottiaux\)/);
    assert.match(html, locale === "ja" ? /観測分類/ : locale === "en" ? /Observed classification/ : /观测分类/);
  }
});

test("places a related Tibo card before the next regular reference and history", () => {
  const calculationNow = new Date("2026-08-05T03:32:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      activeTiboSignals: [
        {
          tweet_id: "presentation-related-official",
          signal_type: "official_notice",
          text: "A reset notice from Tibo",
          tweet_url: "https://x.com/thsottiaux/status/presentation-related-official",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-06T00:00:00.000Z",
          confidence: 0.96,
          verification_status: "auto_unverified",
        },
        {
          tweet_id: "presentation-related-weak",
          signal_type: "irrelevant",
          text: "I might reset limits for good feedback.",
          tweet_url: "https://x.com/thsottiaux/status/presentation-related-weak",
          tweet_created_at: "2026-08-03T22:00:00.000Z",
          expires_at: "2026-08-06T00:00:00.000Z",
          verification_status: "auto_unverified",
          teaser_strength: "weak",
        },
      ],
    }),
    "en",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
  );

  const noticeIndex = html.indexOf("Reset-related notice");
  const relatedIndex = html.indexOf("Related Tibo post");
  const statusIndex = html.indexOf("Current status");
  const referenceIndex = html.indexOf("Next regular reset reference");
  const historyIndex = html.indexOf("Recent reset events");

  assert.ok(noticeIndex >= 0 && noticeIndex < statusIndex);
  assert.ok(statusIndex < relatedIndex && relatedIndex < referenceIndex && referenceIndex < historyIndex);
  assert.equal((html.match(/Related Tibo post/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Latest Tibo post/);
});

test("places strong and weak related cards before history, while none and unknown stay below history", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const cases = [
    { strength: "strong" as const, text: "I feel like a reset soon." },
    { strength: "weak" as const, text: "I might reset limits for good feedback." },
  ];

  for (const item of cases) {
    const snapshot = toPublicRadarSnapshot(
      getLocalRadarData({
        calculationNow,
        recentTiboSignals: [
          {
            tweet_id: `presentation-${item.strength}`,
            signal_type: "irrelevant",
            text: item.text,
            tweet_url: `https://x.com/thsottiaux/status/presentation-${item.strength}`,
            tweet_created_at: "2026-08-03T23:00:00.000Z",
            expires_at: "2026-08-05T00:00:00.000Z",
            verification_status: "auto_unverified",
            teaser_strength: item.strength,
          },
        ],
      }),
      "en",
      { calculationNow },
    );
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
    );
    const statusIndex = html.indexOf("Current status");
    const relatedIndex = html.indexOf("Related Tibo post");
    const historyIndex = html.indexOf("Recent reset events");

    assert.ok(statusIndex >= 0 && statusIndex < relatedIndex);
    assert.ok(relatedIndex < historyIndex);
    assert.equal((html.match(/Related Tibo post/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Latest Tibo post/);
  }

  for (const strength of ["none", null] as const) {
    const snapshot = toPublicRadarSnapshot(
      getLocalRadarData({
        calculationNow,
        recentTiboSignals: [
          {
            tweet_id: `presentation-${strength ?? "unknown"}`,
            signal_type: "irrelevant",
            text: "An unrelated Tibo post.",
            tweet_url: `https://x.com/thsottiaux/status/presentation-${strength ?? "unknown"}`,
            tweet_created_at: "2026-08-03T23:00:00.000Z",
            expires_at: "2026-08-05T00:00:00.000Z",
            verification_status: "auto_unverified",
            teaser_strength: strength,
          },
        ],
      }),
      "en",
      { calculationNow },
    );
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
    );
    const activityIndex = html.indexOf("Latest Tibo post");
    const historyIndex = html.indexOf("Recent reset events");
    const heatmapIndex = html.indexOf("Past random reset times");

    assert.ok(activityIndex > historyIndex && activityIndex > heatmapIndex);
    assert.equal((html.match(/Latest Tibo post/g) ?? []).length, 1);
    assert.doesNotMatch(html, /Related Tibo post/);
  }
});

test("renders the random reset time heatmap after history with a timezone-free SSR skeleton", () => {
  const calculationNow = new Date("2026-08-06T00:00:00.000Z");
  const internalData = getLocalRadarData({ calculationNow });
  const eventTimes = getRandomResetHeatmapEventTimes(internalData, calculationNow);
  const headings = {
    ja: "過去のランダムリセット時刻",
    en: "Past random reset times",
    zh: "历史随机重置时刻分布",
  } as const;
  const descriptions = {
    ja: "過去のランダムリセット時刻を、PCでは1時間ごと、モバイルでは2時間ごとに集計しています。",
    en: "Past random reset times are grouped by hour on desktop and by two-hour blocks on mobile.",
    zh: "按时刻汇总历史随机重置记录（桌面端按1小时、移动端按2小时聚合）。",
  } as const;
  const intervalHeadings = {
    ja: "過去のランダムリセット間隔",
    en: "Past random reset intervals",
    zh: "历史随机重置间隔分布",
  } as const;
  const intervalDescriptions = {
    ja: "過去のランダムリセットどうしの間隔を集計しています。前回のランダムリセットから次のランダムリセットまでの経過時間です。",
    en: "Past intervals between consecutive random resets are grouped by elapsed time. Each interval runs from one random reset to the next.",
    zh: "汇总连续两次随机重置之间的间隔时长（从一次随机重置到下一次随机重置的经过时间）。",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(internalData, locale, { calculationNow });
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: snapshot,
        randomResetHeatmapEventTimes: eventTimes,
        locale,
      }),
    );
    const historyIndex = html.indexOf(locale === "ja" ? "直近のリセット履歴" : locale === "en" ? "Recent reset events" : "最近的重置历史");
    const heatmapIndex = html.indexOf(headings[locale]);
    const intervalIndex = html.indexOf(intervalHeadings[locale]);

    assert.ok(historyIndex >= 0);
    assert.ok(heatmapIndex > historyIndex);
    assert.ok(intervalIndex > heatmapIndex);
    assert.ok(html.includes(descriptions[locale]));
    assert.match(html, new RegExp(locale === "ja" ? "時刻" : locale === "en" ? "Time" : "时间"));
    assert.match(html, new RegExp(locale === "ja" ? "全期間" : locale === "en" ? "All time" : "全部记录"));
    assert.match(html, new RegExp(locale === "ja" ? "直近1か月" : locale === "en" ? "Last month" : "最近1个月"));
    assert.doesNotMatch(html, /過去のランダムリセット曜日|Past random reset weekdays|历史随机重置星期分布/);
    assert.match(html, new RegExp(intervalHeadings[locale]));
    assert.match(html, new RegExp(intervalDescriptions[locale]));
    assert.match(html, new RegExp(locale === "ja" ? "リセット件数" : locale === "en" ? "Reset records" : "重置次数"));
    assert.doesNotMatch(html, /対象件数|Recorded events|记录数量/);
    assert.match(html, new RegExp(locale === "ja" ? "aria-pressed=\"true\"[^>]*>直近1か月" : locale === "en" ? "aria-pressed=\"true\"[^>]*>Last month" : "aria-pressed=\"true\"[^>]*>最近1个月"));
    assert.doesNotMatch(html, /閲覧者のタイムゾーン|Viewer time zone|查看者时区/);
    assert.match(html, new RegExp(`aria-busy="true"[^>]*aria-label="${headings[locale]}"`));
    assert.doesNotMatch(html, /Raw count|Weighted share|加权构成比/);
    assert.doesNotMatch(html, /実際のシステム実行時刻|Some records may reflect|部分记录反映/);
    const heatmapSectionStart = html.lastIndexOf("<section", heatmapIndex);
    const heatmapSectionEnd = html.indexOf("</section>", intervalIndex);
    const heatmapSection = html.slice(heatmapSectionStart, heatmapSectionEnd + "</section>".length);
    assert.doesNotMatch(heatmapSection, /Asia\/Tokyo|JST|00:00–02:00/);
  }
});

test("renders a crawlable localized homepage explanation before the footer", () => {
  const content = {
    ja: {
      heading: "Codexリセット観測所について",
      paragraphs: [
        "Codexリセット観測所は、Codexの利用上限リセットに関する公開情報を整理する非公式サイトです。過去に確認された全体リセットや任意リセット配布、公式・開発関係者による予告、OpenAI Statusなどをもとに、現在の状況をまとめています。",
        "24時間・48時間以内のリセット期待度は、過去のランダムリセット間隔と現在の観測シグナルから算出した統計的な参考値です。OpenAIによる公式な確率ではありません。確定済みの事例はリセット履歴で、予測方法や用語についてはFAQで確認できます。",
      ],
      links: [
        ["/history", "リセット履歴"],
        ["/faq", "FAQ"],
        ["/about", "このサイトについて"],
      ],
    },
    en: {
      heading: "About Codex Reset Observatory",
      paragraphs: [
        "Codex Reset Observatory is an unofficial site that organizes public information about Codex usage-limit resets. It summarizes the current situation using confirmed global resets and account-specific reset grants, official notices from OpenAI and people involved in development, and OpenAI Status.",
        "The 24-hour and 48-hour reset likelihoods are statistical reference values calculated from past random reset intervals and current observed signals. They are not official probabilities from OpenAI. Confirmed cases are listed in the reset history, while the FAQ explains how the forecast is calculated and how the site's terms are used.",
      ],
      links: [
        ["/en/history", "Reset history"],
        ["/en/faq", "FAQ"],
        ["/en/about", "About this site"],
      ],
    },
    zh: {
      heading: "关于 Codex 重置观测站",
      paragraphs: [
        "Codex 重置观测站是一个整理 Codex 使用上限重置公开信息的非官方网站。本站参考过去确认的全局重置和按需发放的重置、OpenAI 及开发相关人员发布的官方预告，以及 OpenAI Status，汇总当前状况。",
        "未来24小时和48小时内的重置期望度，是根据过去的随机重置间隔和当前观测信号计算的统计参考值，并非 OpenAI 官方概率。已确认的事件会记录在重置历史中；预测方法和相关术语可在常见问题中查看。",
      ],
      links: [
        ["/zh/history", "重置历史"],
        ["/zh/faq", "常见问题"],
        ["/zh/about", "关于本网站"],
      ],
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const calculationNow = new Date("2026-08-06T00:00:00.000Z");
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(
          getLocalRadarData({ calculationNow }),
          locale,
          { calculationNow },
        ),
        locale,
      }),
    );
    const sectionStart = html.indexOf('aria-labelledby="homepage-explanation-title"');
    const footerIndex = html.indexOf("<footer");
    assert.ok(sectionStart >= 0, `${locale} explanation section should be in SSR HTML`);
    assert.ok(sectionStart < footerIndex, `${locale} explanation should precede the footer`);

    const sectionEnd = html.indexOf("</section>", sectionStart);
    const sectionHtml = html.slice(sectionStart, sectionEnd);
    assert.ok(sectionHtml.includes(content[locale].heading));
    for (const paragraph of content[locale].paragraphs) {
      const renderedParagraph = paragraph.replace(/'/g, "&#x27;");
      assert.ok(sectionHtml.includes(renderedParagraph), `${locale} paragraph should be crawlable`);
    }
    for (const [href, label] of content[locale].links) {
      assert.ok(sectionHtml.includes(`href="${href}"`));
      assert.ok(sectionHtml.includes(`>${label}</a>`));
    }
    assert.doesNotMatch(sectionHtml, /\bhidden\b|sr-only|opacity-0|invisible|display:\s*none|visibility:\s*hidden/);
  }
});

test("does not render the omitted 12-hour and 72-hour metrics", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "en",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: snapshot,
      locale: "en",
    }),
  );

  assert.match(html, /aria-label="Within 24h"/);
  assert.match(html, /aria-label="Within 48h"/);
  assert.doesNotMatch(html, /Within 12 hours|Within 72 hours/);
  assert.strictEqual((html.match(/role="progressbar"/g) ?? []).length, 2);
});

test("shows an unresolved notice without inventing a planned datetime", (t: TestContext) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-02T00:00:00.000Z"),
  });
  const openedAt = "2026-08-01T23:45:00.000Z";
  const expiresAt = "2026-08-02T12:00:00.000Z";
  const data = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "presentation-notice",
        signal_type: "official_notice",
        text: "A reset notice from Tibo",
        tweet_url: "https://x.com/thsottiaux/status/presentation-notice",
        tweet_created_at: openedAt,
        expires_at: expiresAt,
        confidence: 0.96,
        verification_status: "auto_unverified",
      },
    ],
  });

  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "en"),
      initialFetchedAt: openedAt,
      locale: "en",
    }),
  );

  assert.match(html, /Planned reset/);
  assert.match(html, /time not specified/);
  assert.doesNotMatch(html, /An official reset notice has been detected\. Please check the latest status\./);
  assert.doesNotMatch(html, /Notice posted/);
  assert.match(html, /Tibo \(@thsottiaux\)/);
});

test("shows a resolved notice window with only the viewer-local schedule and source", () => {
  const openedAt = "2026-08-08T20:34:50.000Z";
  const expectedStartAt = "2026-08-10T07:00:00.000Z";
  const expectedEndAt = "2026-08-11T07:00:00.000Z";
  const data = getLocalRadarData({
    calculationNow: new Date(openedAt),
    activeTiboSignals: [
      {
        tweet_id: "presentation-resolved-notice",
        signal_type: "official_notice",
        text: "I'll do another performative reset on Monday",
        tweet_url: "https://x.com/thsottiaux/status/presentation-resolved-notice",
        tweet_created_at: openedAt,
        expires_at: "2026-08-11T09:00:00.000Z",
        confidence: 0.96,
        verification_status: "auto_unverified",
        ai_temporal_expression: "on Monday",
        ai_temporal_kind: "weekday",
        ai_temporal_precision: "day",
        ai_temporal_timezone: "America/Los_Angeles",
        ai_temporal_confidence: 0.95,
        expected_start_at: expectedStartAt,
        expected_end_at: expectedEndAt,
        temporal_resolution_status: "resolved",
        temporal_resolution_version: "tibo-temporal-v1",
      },
    ],
  });

  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "en", { calculationNow: new Date(openedAt) }),
      initialFetchedAt: openedAt,
      locale: "en",
    }),
  );

  assert.match(html, /Planned reset/);
  assert.match(html, /Tibo(?:&#x27;|')s notice date and time are shown in your local time\./);
  assert.doesNotMatch(html, /An official notice says another reset is planned for Monday\. Please check the latest status\./);
  assert.match(html, /An official reset notice has been confirmed\. Considering the notice, the outlook for a reset is higher\./);
  assert.doesNotMatch(html, /time not specified|Pacific Time|In the viewer(?:&#x27;|')s local time/);
  assert.equal((html.match(/I(?:&#x27;|')ll do another performative reset on Monday/g) ?? []).length, 1);
  assert.doesNotMatch(html, />[^<]*2026-08-10T07:00:00\.000Z/);

  const jaHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "ja", { calculationNow: new Date(openedAt) }),
      initialFetchedAt: openedAt,
      locale: "ja",
    }),
  );
  assert.doesNotMatch(jaHtml, /月曜日に再度リセットを行う予定との予告があります。最新状況をご確認ください。/);
  assert.match(jaHtml, /公式のリセット予告が確認されています。予告内容を踏まえ、リセットの見込みが高まっています。/);
  assert.match(jaHtml, /リセット予定/);
  assert.match(jaHtml, /Tibo氏の予告日時をお使いの地域の時間に変換して表示しています/);
  assert.doesNotMatch(jaHtml, /Pacific Time|閲覧者の現地時刻換算|時刻未定/);
  assert.equal((jaHtml.match(/I(?:&#x27;|')ll do another performative reset on Monday/g) ?? []).length, 1);

  const zhHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "zh", { calculationNow: new Date(openedAt) }),
      initialFetchedAt: openedAt,
      locale: "zh",
    }),
  );
  assert.doesNotMatch(zhHtml, /有官方预告称计划在星期一再次重置。请确认最新状态。/);
  assert.match(zhHtml, /重置安排/);
  assert.match(zhHtml, /已确认有官方重置预告。结合预告内容，重置的可能性有所上升。/);
  assert.match(zhHtml, /Tibo 的预告日期和时间会转换为您所在地区的本地时间显示。/);
  assert.doesNotMatch(zhHtml, /太平洋时间|按查看者当地时间换算/);
});

test("renders a reset end-of-day notice as a deadline without changing its internal window", () => {
  const openedAt = "2026-09-05T00:39:25.000Z";
  const expectedStartAt = "2026-09-05T00:39:25.000Z";
  const expectedEndAt = "2026-09-05T07:00:00.000Z";
  const data = getLocalRadarData({
    calculationNow: new Date("2026-09-05T01:00:00.000Z"),
    activeTiboSignals: [
      {
        tweet_id: "2096035437299237298",
        signal_type: "official_notice",
        text: "Because we are beyond happy to have Astra rolled out today ahead of schedule and you have been super patient with us (not really, but it’s ok!)… we will do the full banked reset today too for all Plus, Pro and Business users. Lands end of day. Happy Astra day and enjoy a phenomenal weekend. PS: If you create the account or upgrade before 8pm PT you will get it too. Still time!",
        translated_text_ja: "Plus、Pro、Businessの全ユーザーにフルバンクリセットを実施します。一日の終わりに適用されます。アカウント作成またはアップグレードはPT午後8時までに行えば対象です。",
        translated_text_zh: "我们今天也将为所有 Plus、Pro 和 Business 用户进行完整的储蓄重置。将在今天结束时落地。如果您在太平洋时间晚上 8 点之前创建账户或升级，也可以获得。",
        tweet_url: "https://x.com/thsottiaux/status/2096035437299237298",
        tweet_created_at: openedAt,
        expires_at: "2026-09-06T00:39:25.000Z",
        confidence: 0.98,
        verification_status: "auto_unverified",
        temporal_expression: "Lands end of day",
        temporal_kind: "daypart",
        temporal_precision: "daypart",
        temporal_timezone: "America/Los_Angeles",
        temporal_confidence: 0.95,
        ai_temporal_expression: "Lands end of day",
        ai_temporal_kind: "daypart",
        ai_temporal_precision: "daypart",
        ai_temporal_timezone: "America/Los_Angeles",
        ai_temporal_confidence: 0.95,
        expected_start_at: expectedStartAt,
        expected_end_at: expectedEndAt,
        temporal_resolution_status: "resolved",
        temporal_resolution_version: "tibo-temporal-v1",
      },
    ],
  });

  const expectedSchedule = {
    ja: /16:00頃 JSTまで/,
    en: /by around .*4:00 PM JST/,
    zh: /约.*16:00 JST前/,
  } as const;
  const scheduleLabels = {
    ja: ["リセット予定", "ソース"],
    en: ["Planned reset", "Source"],
    zh: ["重置安排", "来源"],
  } as const;
  const bankedPresentation = {
    ja: {
      heading: "BANKEDリセット（任意リセット権）の配布が予告されています。",
      advice: "任意のタイミングで使用できるため、無理にCodexの使用量を使い切る必要はありません。",
    },
    en: {
      heading: "A BANKED Reset distribution has been announced.",
      advice: "Because it can be used at any time, you do not need to use up your Codex quota.",
    },
    zh: {
      heading: "已发布 BANKED 重置发放预告。",
      advice: "由于可以在任意时间使用，无需为了重置而用完 Codex 的使用额度。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, { calculationNow: new Date("2026-09-05T01:00:00.000Z") });
    assert.equal(snapshot.viewModel.activeWindow.expectedAt, expectedStartAt);
    assert.equal(snapshot.viewModel.activeWindow.expectedEndAt, expectedEndAt);
    assert.equal(snapshot.viewModel.activeWindow.kind, "official");
    assert.equal(snapshot.viewModel.activeWindow.noticeKind, "banked");

    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: snapshot, locale }),
    );
    assert.equal(snapshot.viewModel.activeWindow.label, bankedPresentation[locale].heading);
    assert.match(html, new RegExp(bankedPresentation[locale].heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(bankedPresentation[locale].advice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const scheduleStart = html.indexOf(scheduleLabels[locale][0]);
    const sourceStart = html.indexOf(scheduleLabels[locale][1], scheduleStart);
    assert.ok(scheduleStart >= 0 && sourceStart > scheduleStart);
    const schedule = html.slice(scheduleStart, sourceStart);
    const scheduleText = schedule.replace(/<[^>]*>/g, "");

    assert.match(scheduleText, expectedSchedule[locale]);
    assert.doesNotMatch(scheduleText, /09:39|9:39|20:00|8:00 PM|～| to | 至 /);
  }
});

test("preserves Astra presentation fallbacks separately from the exact scope correction", () => {
  const calculationNow = new Date("2026-09-06T00:00:00.000Z");
  const astraSourceTweetId = "2095651088502591861";
  const event = (id: string, completedAt: string, overrides: Record<string, unknown> = {}) => ({
    id,
    recordKind: "banked_distribution" as const,
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    window_minutes: 0,
    scope: "全有料プラン",
    summary: "BANKED reset",
    source_url: "https://x.com/thsottiaux/status/unrelated-history-source",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "公式告知あり",
      note: "BANKED reset",
    },
    ...overrides,
  });
  const officialIdFallback = event("banked-astra-official-fallback", "2026-09-05T21:00:00.000Z", {
    officialNoticeTweetId: astraSourceTweetId,
  });
  const sourceIdFallback = event("banked-astra-source-fallback", "2026-09-05T20:00:00.000Z", {
    sourceTweetIds: [astraSourceTweetId],
  });
  const nonBankedSameSource = {
    ...event("confirmed-global-same-astra-source", "2026-09-05T19:00:00.000Z", {
      recordKind: "confirmed_global",
      title: "既存全体リセット",
      officialNoticeTweetId: astraSourceTweetId,
    }),
  };
  const originalHistory = LOCAL_RESET_HISTORY.splice(
    0,
    LOCAL_RESET_HISTORY.length,
    officialIdFallback,
    sourceIdFallback,
    nonBankedSameSource,
  );

  try {
    const viewModel = getRadarViewModel(
      getLocalRadarData({ calculationNow }),
      "ja",
      false,
      undefined,
      calculationNow,
    );
    const officialPresentation = viewModel.recentHistory.find(
      (item) => item.key === officialIdFallback.id,
    );
    const sourcePresentation = viewModel.recentHistory.find(
      (item) => item.key === sourceIdFallback.id,
    );
    const nonBankedPresentation = viewModel.recentHistory.find(
      (item) => item.key === nonBankedSameSource.id,
    );

    assert.equal(officialPresentation?.title, "GPT-6 Astraリリース記念BANKEDリセット配布");
    assert.equal(sourcePresentation?.title, "GPT-6 Astraリリース記念BANKEDリセット配布");
    assert.equal(nonBankedPresentation?.title, "既存全体リセット");
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...originalHistory);
  }
});

test("preserves the legacy Astra presentation identity matching semantics", () => {
  const baseKey = "banked-reset-2095651088502591861";
  const secondKey = `${baseKey}-observation-20260904T234601897Z`;
  const sourceTweetId = "2095651088502591861";
  const lookup = (overrides: {
    eventKey?: string | null;
    officialNoticeTweetId?: string | null;
    sourceTweetIds?: ReadonlyArray<string | null | undefined> | null;
  }) => getHistoricalResetPresentationCorrection({
    recordKind: "banked_distribution",
    ...overrides,
  });

  assert.equal(
    lookup({ eventKey: baseKey })?.titleTranslationKey,
    "astraBankedHistoryTitle",
  );
  assert.equal(lookup({ eventKey: secondKey }), null);
  assert.equal(
    lookup({ eventKey: secondKey, officialNoticeTweetId: ` ${sourceTweetId} ` })?.titleTranslationKey,
    "astraBankedHistorySecondTitle",
  );
  assert.equal(
    lookup({ eventKey: secondKey, sourceTweetIds: [sourceTweetId] })?.titleTranslationKey,
    "astraBankedHistorySecondTitle",
  );
  assert.equal(lookup({ eventKey: ` ${baseKey} ` }), null);
  assert.equal(
    lookup({ eventKey: "banked-astra-source-whitespace", sourceTweetIds: [` ${sourceTweetId} `] }),
    null,
  );
});

test("renders a BANKED notice separately and does not recommend exhausting the quota", () => {
  const openedAt = "2026-08-21T12:30:00.000Z";
  const data = getLocalRadarData({
    calculationNow: new Date(openedAt),
    activeTiboSignals: [
      {
        tweet_id: "presentation-banked-notice",
        signal_type: "official_notice",
        text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
        tweet_url: "https://x.com/thsottiaux/status/presentation-banked-notice",
        tweet_created_at: openedAt,
        expires_at: "2026-08-22T09:00:00.000Z",
        confidence: 0.96,
        verification_status: "auto_unverified",
        expected_start_at: openedAt,
        expected_end_at: "2026-08-22T07:00:00.000Z",
        temporal_resolution_status: "resolved",
        ai_temporal_precision: "daypart",
        ai_temporal_timezone: "America/Los_Angeles",
      },
    ],
  });

  const expected = {
    ja: {
      notice: "BANKEDリセット（任意リセット権）の配布が予告されています。",
      advice: "任意のタイミングで使用できるため、無理にCodexの使用量を使い切る必要はありません。",
    },
    en: {
      notice: "A BANKED Reset distribution has been announced.",
      advice: "Because it can be used at any time, you do not need to use up your Codex quota.",
    },
    zh: {
      notice: "已发布 BANKED 重置发放预告。",
      advice: "由于可以在任意时间使用，无需为了重置而用完 Codex 的使用额度。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(data, locale, { calculationNow: new Date(openedAt) }),
        initialFetchedAt: openedAt,
        locale,
      }),
    );
    assert.match(html, new RegExp(expected[locale].notice));
    assert.match(html, new RegExp(expected[locale].advice));
  }

  const jaHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "ja", { calculationNow: new Date(openedAt) }),
      initialFetchedAt: openedAt,
      locale: "ja",
    }),
  );
  assert.doesNotMatch(jaHtml, /リセット前に残り枠を使う/);
});

test("shows the local-time note only for resolved Tibo notices", () => {
  const renderNotice = (tweetUrl: string, overrides: Partial<ActiveTiboSignal> = {}) => {
    const openedAt = "2026-08-08T20:34:50.000Z";
    const data = getLocalRadarData({
      calculationNow: new Date(openedAt),
      activeTiboSignals: [
        {
          tweet_id: `presentation-local-time-${tweetUrl}`,
          signal_type: "official_notice",
          text: "Reset notice",
          tweet_url: tweetUrl,
          tweet_created_at: openedAt,
          expires_at: "2026-08-11T09:00:00.000Z",
          confidence: 0.96,
          verification_status: "auto_unverified",
          ...overrides,
        },
      ],
    });

    return renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(data, "en", { calculationNow: new Date(openedAt) }),
        locale: "en",
      }),
    );
  };

  const unresolvedHtml = renderNotice("https://x.com/thsottiaux/status/unresolved");
  assert.doesNotMatch(unresolvedHtml, /Tibo(?:&#x27;|')s notice date and time are shown in your local time\./);

  const nonTiboHtml = renderNotice(
    "https://x.com/other-account/status/non-tibo",
    {
      ai_temporal_precision: "exact_time",
      ai_temporal_timezone: "America/Los_Angeles",
      expected_start_at: "2026-08-10T07:00:00.000Z",
      temporal_resolution_status: "resolved",
    },
  );
  assert.doesNotMatch(nonTiboHtml, /Tibo(?:&#x27;|')s notice date and time are shown in your local time\./);
});

test("formats all Japanese schedule weekdays with compact parentheses", () => {
  const mondayAtSourceMidnight = Date.parse("2026-08-10T07:00:00.000Z");
  const labels = Array.from({ length: 7 }, (_, offset) =>
    formatScheduledSourceDay(
      new Date(mondayAtSourceMidnight + offset * 24 * 60 * 60 * 1000).toISOString(),
      "America/Los_Angeles",
      "ja",
    ),
  );

  assert.deepEqual(labels, [
    "8月10日（月）",
    "8月11日（火）",
    "8月12日（水）",
    "8月13日（木）",
    "8月14日（金）",
    "8月15日（土）",
    "8月16日（日）",
  ]);
});

test("keeps the normal dashboard focused on the current outlook", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow });
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "ja", { calculationNow }),
      locale: "ja",
    }),
  );

  const probabilityIndex = html.indexOf("24時間以内");
  const noticeIndex = html.indexOf("公式リセット予告");
  const incidentIndex = html.indexOf("Codex関連障害");
  const elapsedIndex = html.indexOf(
    "前回のランダムリセットから",
    html.indexOf("Codex関連障害"),
  );
  const teaserIndex = html.indexOf("リセット匂わせ投稿");
  const outlookIndex = html.indexOf("現在の見込み");
  const historyIndex = html.indexOf("リセット履歴", outlookIndex);
  const outlookText = html.slice(outlookIndex, historyIndex);

  assert.ok(probabilityIndex >= 0 && probabilityIndex < noticeIndex);
  assert.ok(noticeIndex >= 0 && noticeIndex < teaserIndex);
  assert.ok(teaserIndex < incidentIndex && incidentIndex < elapsedIndex && elapsedIndex < outlookIndex);
  assert.ok(outlookIndex >= 0);
  assert.match(html, /公式リセット予告[\s\S]*なし/);
  assert.match(html, /Codex関連障害[\s\S]*なし/);
  assert.match(html, /前回のランダムリセットから[\s\S]*2日20時間/);
  assert.match(html, /リセット匂わせ投稿[\s\S]*なし/);
  assert.match(html, /現在の見込み/);
  assert.doesNotMatch(html, /現在、目立った観測変化はありません。/);
  assert.match(outlookText, /前回のランダムリセット|最近はリセット|現在、大きな変化/);
  assert.doesNotMatch(outlookText, /直近のリセットから2日20時間経過しています。/);
  assert.doesNotMatch(outlookText, /公式予告や発生中のCodex関連障害はありません。/);
  assert.doesNotMatch(outlookText, /直近7日間でリセットが3回/);
  assert.doesNotMatch(outlookText, /現在の見立ては24時間以内/);
  assert.doesNotMatch(outlookText, /現在の可能性/);
  assert.doesNotMatch(outlookText, /基礎確率を算出/);
  assert.doesNotMatch(outlookText, /観測シグナルで補正/);
  assert.doesNotMatch(outlookText, /。 /);
  assert.doesNotMatch(outlookText, /\d+%/);
  assert.doesNotMatch(html, /非公式の予測です。実際の実施時期は公式情報をご確認ください。/);
  assert.doesNotMatch(html, /今日、全体リセットはありましたか？|次のリセットはいつですか？|予測のしくみを見る →/);
  assert.doesNotMatch(html, /border-amber-300 bg-amber-50/);
});

test("dashboard elapsed indicator uses the latest random reset across regular boundaries", () => {
  const calculationNow = new Date("2026-08-10T12:00:00.000Z");
  const regularAt = "2026-08-08T12:00:00.000Z";
  const randomAt = "2026-08-01T12:00:00.000Z";

  function renderElapsed(
    locale: "ja" | "en" | "zh",
    lastRandomResetAt: string | null,
    sourceResetAt: string,
  ) {
    const snapshot = toPublicRadarSnapshot(
      getLocalRadarData({ calculationNow }),
      locale,
      { calculationNow },
    );
    snapshot.viewModel.regularResetForecast = {
      ...snapshot.viewModel.regularResetForecast,
      sourceResetAt,
    };
    (snapshot as unknown as { lastRandomResetAt: string | null }).lastRandomResetAt = lastRandomResetAt;
    return renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: snapshot,
        locale,
      }),
    );
  }

  const cases = [
    {
      name: "random then regular",
      html: renderElapsed("ja", randomAt, regularAt),
      label: "前回のランダムリセットから",
      elapsed: "9日",
    },
    {
      name: "new random reset",
      html: renderElapsed("ja", "2026-08-10T11:00:00.000Z", regularAt),
      label: "前回のランダムリセットから",
      elapsed: "1時間",
    },
    {
      name: "random only despite a newer regular reset",
      html: renderElapsed("ja", randomAt, regularAt),
      label: "前回のランダムリセットから",
      elapsed: "9日",
    },
    {
      name: "random newer than regular",
      html: renderElapsed("ja", "2026-08-10T10:00:00.000Z", regularAt),
      label: "前回のランダムリセットから",
      elapsed: "2時間",
    },
    {
      name: "no random reset",
      html: renderElapsed("ja", null, regularAt),
      label: "前回のランダムリセットから",
      elapsed: "不明",
    },
  ];

  for (const item of cases) {
    const labelIndex = item.html.indexOf(item.label, item.html.indexOf("Codex関連障害"));
    assert.ok(labelIndex >= 0, item.name);
    assert.match(item.html.slice(labelIndex, labelIndex + 240), new RegExp(item.elapsed), item.name);
  }

  const localized = [
    ["en", "Since the last random reset"],
    ["zh", "距上次随机重置"],
  ] as const;
  for (const [locale, label] of localized) {
    const html = renderElapsed(locale, randomAt, regularAt);
    assert.match(html, new RegExp(label), locale);
  }
});

test("keeps probability cards compact while showing the full random reset label", () => {
  const calculationNow = new Date("2026-08-10T12:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "ja",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: snapshot,
      locale: "ja",
    }),
  );

  assert.ok(html.includes("lg:grid-cols-[minmax(0,1fr)_minmax(28rem,1.1fr)]"));
  assert.equal((html.match(/aria-label="24時間以内"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="48時間以内"/g) ?? []).length, 1);

  const labelIndex = html.indexOf(
    "前回のランダムリセットから",
    html.indexOf("Codex関連障害"),
  );
  assert.ok(labelIndex >= 0);
  const statusLabel = html.slice(html.lastIndexOf("<dt", labelIndex), html.indexOf("</dt>", labelIndex) + 5);
  assert.match(statusLabel, /whitespace-normal/);
  assert.doesNotMatch(statusLabel, /truncate/);
});

test("shows a localized regular reset timing note only on mobile history cards", () => {
  const calculationNow = new Date("2026-08-12T00:00:00.000Z");
  const expectedNotes = {
    ja: "定期リセットのタイミングはユーザーによって異なる場合があります。",
    en: "The timing of regular resets may vary by user.",
    zh: "定期重置的时间可能因用户而异。",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(
      getLocalRadarData({ calculationNow }),
      locale,
      { calculationNow },
    );
    const template = snapshot.viewModel.recentHistory.find((item) => item.resetAt);
    if (!template) throw new Error("Expected a reset history item");
    const cycleTypes = {
      ja: { regular: "定期リセット", random: "ランダムリセット" },
      en: { regular: "Weekly reset", random: "Random reset" },
      zh: { regular: "定期重置", random: "随机重置" },
    } as const;
    const regularItem = {
      ...template,
      key: "regular-timing-note",
      recordKind: "regular_completed" as const,
      details: { ...template.details!, cycleType: cycleTypes[locale].regular },
    };
    const randomItem = {
      ...template,
      key: "random-timing-note",
      recordKind: "confirmed_global" as const,
      details: { ...template.details!, cycleType: cycleTypes[locale].random },
    };

    const regularHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: {
          ...snapshot,
          viewModel: { ...snapshot.viewModel, recentHistory: [regularItem] },
        },
        locale,
      }),
    );
    const note = expectedNotes[locale];
    const noteIndex = regularHtml.indexOf(note);
    assert.ok(noteIndex >= 0, locale);
    const noteStart = regularHtml.lastIndexOf("<p", noteIndex);
    const noteEnd = regularHtml.indexOf("</p>", noteIndex) + 4;
    assert.match(regularHtml.slice(noteStart, noteEnd), /sm:hidden/, locale);

    const randomHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: {
          ...snapshot,
          viewModel: { ...snapshot.viewModel, recentHistory: [randomItem] },
        },
        locale,
      }),
    );
    assert.ok(!randomHtml.includes(note), locale);
  }
});

test("aligns reset history notice and execution timestamps in a desktop grid", () => {
  const calculationNow = new Date("2026-08-12T00:00:00.000Z");
  const baseSnapshot = toPublicRadarSnapshot(getLocalRadarData({ calculationNow }), "ja", { calculationNow });
  const template = baseSnapshot.viewModel.recentHistory.find((item) => item.resetAt);
  if (!template) throw new Error("Expected a reset history item for the presentation test");

  const historyItem = {
    ...template,
    key: "timestamp-alignment-test",
    recordKind: "confirmed_global" as const,
    title: "テストリセット",
    signalLabel: "告知",
    signalAt: "2026-08-10T20:34:00.000Z",
    resetLabel: "実施",
    resetAt: "2026-08-11T00:00:00.000Z",
    executionTimePrecision: "approximate" as const,
    source: "https://x.com/thsottiaux/status/timestamp-alignment-test",
    details: {
      ...(template.details ?? {
        cycleType: "ランダムリセット",
        reasonType: "ランダムリセット",
        resetMethod: "強制リセット",
        scope: "全体",
        noticeToExecution: "0分",
      }),
      cycleType: "ランダムリセット",
    },
  };
  const alignedSnapshot = {
    ...baseSnapshot,
    viewModel: {
      ...baseSnapshot.viewModel,
      recentHistory: [historyItem],
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: alignedSnapshot, locale: "ja" }),
  );

  const historyIndex = html.indexOf("テストリセット");
  const noticeLabelIndex = html.indexOf(">告知：</span>", historyIndex);
  const executionLabelIndex = html.indexOf(">実施：</span>", historyIndex);
  const sourceIndex = html.indexOf("ソース", executionLabelIndex);
  assert.ok(historyIndex >= 0);
  assert.ok(noticeLabelIndex > historyIndex);
  assert.ok(executionLabelIndex > noticeLabelIndex);
  assert.ok(sourceIndex > executionLabelIndex);
  const labels = {
    ja: [">告知：</span>", ">実施：</span>"],
    en: [">Announcement: </span>", ">Reset: </span>"],
    zh: [">告知：</span>", ">执行：</span>"],
  } as const;
  for (const locale of ["ja", "en", "zh"] as const) {
    const localizedItem = {
      ...historyItem,
      signalLabel: locale === "en" ? "Announcement" : "告知",
    };
    const localizedSnapshot = {
      ...alignedSnapshot,
      viewModel: {
        ...alignedSnapshot.viewModel,
        recentHistory: [localizedItem],
      },
    };
    const localizedHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: localizedSnapshot, locale }),
    );
    for (const label of labels[locale]) assert.match(localizedHtml, new RegExp(label));

    const localizedHistoryHtml = renderToStaticMarkup(
      React.createElement(LocalizedHistoryEvents, {
        title: "履歴",
        empty: "",
        items: [localizedItem],
        locale,
      }),
    );
    const expectedSignal = `${locale === "en" ? "Announcement" : "告知"}${locale === "en" ? ": " : "："}`;
    assert.ok(localizedHtml.includes(expectedSignal), `${locale} dashboard signal label`);
    assert.ok(localizedHistoryHtml.includes(expectedSignal), `${locale} history signal label`);
  }

  const withoutNoticeSnapshot = {
    ...alignedSnapshot,
    viewModel: {
      ...alignedSnapshot.viewModel,
      recentHistory: [{ ...historyItem, signalLabel: "", signalAt: null }],
    },
  };
  const withoutNoticeHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: withoutNoticeSnapshot, locale: "ja" }),
  );
  assert.doesNotMatch(withoutNoticeHtml, />予告：<\/span>/);
  assert.match(withoutNoticeHtml, />実施：<\/span>/);
});

test("observation status row reflects an active Codex incident without changing the calculation", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      openAIStatus: {
        updatedAt: "2026-08-03T23:00:00.000Z",
        statusIncidents24h: 1,
        activeCodexIncidents: 1,
        recentCodexIncidents: 1,
        affectedCodexComponents: 0,
        suppressCodexIncidents: false,
        codexOperationalStatus: "active",
        latestCodexIncidentName: "Codex incident",
        history: [
          {
            id: "dashboard-active-incident",
            title: "Codex incident",
            status: "investigating",
            impact: "minor",
            createdAt: "2026-08-03T22:00:00.000Z",
            updatedAt: "2026-08-03T23:00:00.000Z",
            resolvedAt: null,
            source: "openai_status",
            url: "https://status.openai.com/incidents/dashboard-active-incident",
          },
        ],
      },
    }),
    "en",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
  );

  assert.match(html, /Codex incidents[\s\S]*Active/);
  assert.match(html, /A Codex-related incident has been confirmed\. We are watching for a possible reset connected with recovery work\./);
});

test("uses the explicit public Codex status instead of parsing localized reasoning", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      openAIStatus: {
        updatedAt: "2026-08-03T23:00:00.000Z",
        statusIncidents24h: 0,
        activeCodexIncidents: 0,
        recentCodexIncidents: 0,
        affectedCodexComponents: 0,
        suppressCodexIncidents: true,
        codexOperationalStatus: "active",
        latestCodexIncidentName: null,
        history: [],
      },
    }),
    "en",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: snapshot, locale: "en" }),
  );

  assert.equal(snapshot.viewModel.codexOperationalStatus, "active");
  assert.match(html, /Codex incidents[\s\S]*Active/);
});

test("observation status row reflects an active reset teaser from the latest Tibo activity", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      activeTiboSignals: [
        {
          tweet_id: "dashboard-active-teaser",
          signal_type: "teaser",
          text: "There will be signs... Resets",
          tweet_url: "https://x.com/thsottiaux/status/dashboard-active-teaser",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-05T23:00:00.000Z",
          verification_status: "auto_unverified",
          teaser_strength: "strong",
        },
      ],
    }),
    "ja",
    { calculationNow },
  );
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: snapshot, locale: "ja" }),
  );

  assert.match(html, /リセット匂わせ投稿[\s\S]*あり/);
});

test("the existing reset teaser status row displays weak and none without adding another status", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const weakSnapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      recentTiboSignals: [
        {
          tweet_id: "dashboard-weak-teaser",
          signal_type: "irrelevant",
          text: "I occasionally do oblige for solid feedback.",
          tweet_url: "https://x.com/thsottiaux/status/dashboard-weak-teaser",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-05T23:00:00.000Z",
          verification_status: "auto_unverified",
          teaser_strength: "weak",
        },
      ],
    }),
    "ja",
    { calculationNow },
  );
  const noneSnapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      recentTiboSignals: [
        {
          tweet_id: "dashboard-none-teaser",
          signal_type: "irrelevant",
          text: "No reset tonight.",
          tweet_url: "https://x.com/thsottiaux/status/dashboard-none-teaser",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-05T23:00:00.000Z",
          verification_status: "auto_unverified",
          teaser_strength: "none",
        },
      ],
    }),
    "ja",
    { calculationNow },
  );

  const weakHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: weakSnapshot, locale: "ja" }),
  );
  const noneHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: noneSnapshot, locale: "ja" }),
  );

  assert.match(weakHtml, /リセット匂わせ投稿[\s\S]*あり（弱）/);
  assert.equal((weakHtml.match(/弱いリセット匂わせ投稿があります。/g) ?? []).length, 1);
  assert.match(noneHtml, /リセット匂わせ投稿[\s\S]*なし/);
  assert.doesNotMatch(noneHtml, /リセットへの前向き発言/);
});

test("teaser strength labels stay natural in English and Simplified Chinese", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "localized-weak-teaser",
        signal_type: "irrelevant",
        text: "I occasionally do oblige for solid feedback.",
        tweet_url: "https://x.com/thsottiaux/status/localized-weak-teaser",
        tweet_created_at: "2026-08-03T23:00:00.000Z",
        expires_at: "2026-08-05T23:00:00.000Z",
        verification_status: "auto_unverified",
        teaser_strength: "weak",
      },
    ],
  });

  const englishHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(internal, "en", { calculationNow }),
      locale: "en",
    }),
  );
  const chineseHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(internal, "zh", { calculationNow }),
      locale: "zh",
    }),
  );

  assert.match(englishHtml, /Reset teaser[\s\S]*Present \(weak\)/);
  assert.match(chineseHtml, /重置暗示帖[\s\S]*有（较弱）/);
});

test("keeps the simplified official notice card above the probability card", (t: TestContext) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-08-02T00:00:00.000Z"),
  });
  const openedAt = "2026-08-01T23:45:00.000Z";
  const data = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "presentation-official-notice",
        signal_type: "official_notice",
        text: "A reset notice from Tibo",
        tweet_url: "https://x.com/thsottiaux/status/presentation-official-notice",
        tweet_created_at: openedAt,
        expires_at: "2026-08-02T12:00:00.000Z",
        confidence: 0.96,
        verification_status: "auto_unverified",
      },
    ],
  });
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: toPublicRadarSnapshot(data, "en"),
      initialFetchedAt: openedAt,
      locale: "en",
    }),
  );

  const noticeIndex = html.indexOf("Planned reset");
  const probabilityIndex = html.indexOf("Within 24h");

  assert.ok(noticeIndex >= 0 && noticeIndex < probabilityIndex);
  assert.doesNotMatch(html, /Notice posted/);
  assert.match(html, /Tibo \(@thsottiaux\)/);
  assert.match(html, /Official reset notice[\s\S]*Notice available/);
  assert.doesNotMatch(html, /Official notice: None/);
  assert.doesNotMatch(html, /border-slate-50/);
});

test("renders a persistent BANKED policy as an official notice without a stale schedule", () => {
  const calculationNow = new Date("2026-09-04T04:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [{
      tweet_id: "2095651088502591861",
      signal_type: "official_notice",
      text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
      tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
      tweet_created_at: "2026-09-03T23:12:09.000Z",
      expires_at: "2026-09-06T00:00:00.000Z",
      confidence: 0.98,
      verification_status: "auto_unverified",
      expected_start_at: "2026-09-04T02:12:09.000Z",
      expected_end_at: "2026-09-04T02:30:00.000Z",
      temporal_resolution_status: "resolved",
      ai_temporal_precision: "exact_time",
      ai_temporal_timezone: "UTC",
    }],
    formalTiboResets: [{
      tweet_id: "astra-distribution-execution",
      signal_type: "reset_executed",
      text: "A reset was observed.",
      tweet_url: "https://x.com/thsottiaux/status/astra-distribution-execution",
      tweet_created_at: "2026-09-04T03:34:46.386Z",
      confidence: 0.98,
      verification_status: "confirmed",
    }],
  });

  const localized = {
    ja: "BANKEDリセット（任意リセット権）の配布が予告されています。",
    en: "A BANKED Reset distribution has been announced.",
    zh: "已发布 BANKED 重置发放预告。",
  } as const;
  const noSchedule = /時刻未定|time not specified|时间未定/;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(data, locale, { calculationNow }),
        locale,
      }),
    );

    assert.match(html, new RegExp(localized[locale].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(`${locale === "ja" ? "公式リセット予告" : locale === "en" ? "Official reset notice" : "官方重置预告"}[\\s\\S]*${locale === "ja" ? "予告あり" : locale === "en" ? "Notice available" : "已有预告"}`));
    assert.doesNotMatch(html, /継続中のBANKED配布方針|Ongoing BANKED distribution policy|持续中的 BANKED 发放政策/);
    assert.doesNotMatch(html, noSchedule);
    assert.match(html, /href="https:\/\/x\.com\/thsottiaux\/status\/2095651088502591861"/);
  }
});

test("uses the official BANKED heading and reports an available official notice", () => {
  const calculationNow = new Date("2026-09-04T04:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [{
      tweet_id: "2095651088502591861",
      signal_type: "official_notice",
      text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
      tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
      tweet_created_at: "2026-09-03T23:12:09.000Z",
      expires_at: "2026-09-06T00:00:00.000Z",
      confidence: 0.98,
      verification_status: "auto_unverified",
      expected_start_at: "2026-09-04T02:12:09.000Z",
      expected_end_at: "2026-09-04T02:30:00.000Z",
      temporal_resolution_status: "resolved",
      ai_temporal_precision: "exact_time",
      ai_temporal_timezone: "UTC",
    }],
    formalTiboResets: [{
      tweet_id: "astra-distribution-execution",
      signal_type: "reset_executed",
      text: "A reset was observed.",
      tweet_url: "https://x.com/thsottiaux/status/astra-distribution-execution",
      tweet_created_at: "2026-09-04T03:34:46.386Z",
      confidence: 0.98,
      verification_status: "confirmed",
    }],
  });
  const expected = {
    ja: { heading: "BANKEDリセット（任意リセット権）の配布が予告されています。", noticeLabel: "公式リセット予告", noticeValue: "予告あり" },
    en: { heading: "A BANKED Reset distribution has been announced.", noticeLabel: "Official reset notice", noticeValue: "Notice available" },
    zh: { heading: "已发布 BANKED 重置发放预告。", noticeLabel: "官方重置预告", noticeValue: "已有预告" },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, { calculationNow });
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: snapshot, locale }),
    );

    assert.equal(snapshot.viewModel.activeWindow.kind, "official");
    assert.equal(snapshot.viewModel.activeWindow.noticeKind, "banked");
    assert.equal(snapshot.viewModel.activeWindow.label, expected[locale].heading);
    assert.match(html, new RegExp(expected[locale].heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(`${expected[locale].noticeLabel}[\\s\\S]*${expected[locale].noticeValue}`));
    assert.doesNotMatch(html, /継続中のBANKED配布方針|Ongoing BANKED distribution policy|持续中的 BANKED 发放政策/);
  }
});

test("prioritizes a normal official notice over an ongoing BANKED informational notice", () => {
  const calculationNow = new Date("2026-09-04T04:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [
      {
        tweet_id: "2095651088502591861",
        signal_type: "official_notice",
        text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
        tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
        tweet_created_at: "2026-09-03T23:12:09.000Z",
        expires_at: "2026-09-06T00:00:00.000Z",
        confidence: 0.98,
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "normal-official-notice",
        signal_type: "official_notice",
        text: "A reset is planned tomorrow for all users.",
        tweet_url: "https://x.com/thsottiaux/status/normal-official-notice",
        tweet_created_at: "2026-09-04T03:00:00.000Z",
        expires_at: "2026-09-05T00:00:00.000Z",
        confidence: 0.98,
        verification_status: "auto_unverified",
        expected_start_at: "2026-09-04T12:00:00.000Z",
        temporal_resolution_status: "resolved",
        ai_temporal_precision: "exact_time",
        ai_temporal_timezone: "UTC",
      },
    ],
  });
  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow });

  assert.equal(snapshot.viewModel.activeWindow.kind, "official");
  assert.equal(snapshot.viewModel.activeWindow.noticeKind, "forced");
  assert.equal(snapshot.viewModel.activeWindow.source, "https://x.com/thsottiaux/status/normal-official-notice");
  assert.doesNotMatch(snapshot.viewModel.activeWindow.summary, /BANKEDリセットが毎日配布される方針/);
});

test("keeps dashboard labels localized without extra direct-answer links", () => {
  const cases = [
    { locale: "ja" as const, notice: "公式リセット予告", noticeValue: "なし", incident: "Codex関連障害", description: "Codexのリセット予測、最新情報、過去の履歴をまとめて確認できます。", directAnswer: "今日、全体リセットはありましたか？" },
    { locale: "en" as const, notice: "Official reset notice", noticeValue: "None", incident: "Codex incidents", description: "Check Codex reset forecasts, official updates, and recent reset history in one place.", directAnswer: "Did Codex reset today?" },
    { locale: "zh" as const, notice: "官方重置预告", noticeValue: "无", incident: "Codex 相关故障", description: "集中查看 Codex 的重置预测、最新信息和近期重置记录。", directAnswer: "今天有全局重置吗？" },
  ];

  for (const item of cases) {
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: toPublicRadarSnapshot(getLocalRadarData({ calculationNow: new Date("2026-08-04T00:00:00.000Z") }), item.locale, { calculationNow: new Date("2026-08-04T00:00:00.000Z") }),
        locale: item.locale,
      }),
    );

    assert.match(html, new RegExp(item.notice));
    assert.match(html, new RegExp(item.noticeValue));
    assert.match(html, new RegExp(item.incident));
    assert.match(html, new RegExp(item.description));
    assert.doesNotMatch(html, new RegExp(item.directAnswer));
    assert.doesNotMatch(html, /When is the next Codex reset\?|下一次 Codex 重置是什么时候？|予測のしくみを見る →|How the forecast works →|查看预测方式 →/);
    const outlookLabel = item.locale === "ja" ? "現在の見込み" : item.locale === "en" ? "Current outlook" : "当前判断";
    const outlookIndex = html.indexOf(outlookLabel);
    const historyLabel = item.locale === "ja" ? "リセット履歴" : item.locale === "en" ? "Reset history" : "重置历史";
    const historyIndex = html.indexOf(historyLabel, outlookIndex);
    const outlookText = html.slice(outlookIndex, historyIndex);
    assert.ok(outlookIndex >= 0);
    assert.doesNotMatch(html, /非公式の予測です|This is an unofficial forecast|本预测并非官方信息/);
    assert.doesNotMatch(outlookText, /。 /);
    if (item.locale === "en") {
      assert.doesNotMatch(outlookText, / {2,}/);
    }
    assert.doesNotMatch(
      html,
      /過去のリセット間隔から算出した基礎確率|Track Codex reset history and a statistical forecast|查看 Codex 重置历史，以及根据过去重置间隔计算基础概率/,
    );
    assert.doesNotMatch(
      html,
      /This is a statistical reference estimate based on past reset intervals|過去のリセット間隔を基礎に現在の公開シグナルで補正した参考値|本预测以过去的重置间隔为基础，并根据当前公开信号调整/,
    );
  }
});

test("adds the forecast-method anchor to each localized FAQ", () => {
  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(React.createElement(FaqView, { locale }));
    assert.match(html, /id="forecast-method"/);
  }
});

test("explains teaser timing and strength weighting in every localized FAQ", () => {
  const cases = {
    ja: {
      question: "リセット匂わせ投稿は予測にどう反映されますか？",
      timing: "今後24時間・48時間の予測範囲にどれだけ重なるか",
      strength: "匂わせの強さも追加補正",
      caveat: "匂わせは確定した公式予定ではありません。",
    },
    en: {
      question: "How are reset teaser posts reflected in the forecast?",
      timing: "overlaps the next 24 and 48 hours",
      strength: "hint strength is also used as an additional adjustment",
      caveat: "A teaser is not a confirmed official schedule.",
    },
    zh: {
      question: "重置暗示帖如何影响预测？",
      timing: "未来24小时、48小时预测区间的重叠程度",
      strength: "暗示强度作为额外修正",
      caveat: "暗示帖并不等同于已确认的官方安排。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(React.createElement(FaqView, { locale }));
    assert.match(html, /id="teaser-forecast-method"/);
    assert.ok(html.includes(cases[locale].question), locale);
    assert.ok(html.includes(cases[locale].timing), locale);
    assert.ok(html.includes(cases[locale].strength), locale);
    assert.ok(html.includes(cases[locale].caveat), locale);
    assert.match(html, /"@type":"FAQPage"/);
  }
});

test("explains the shared Codex and Work usage pool in localized About and FAQ content", () => {
  const cases = {
    ja: {
      about: "CodexとChatGPT Workは、対象プランでは同じエージェント利用量・クレジットのプールを共有しています。",
      question: "ChatGPT Workのリセットも関係ありますか？",
      answer: "その共有利用枠に対するリセットであれば、CodexだけでなくChatGPT Workの利用にも関係します。",
    },
    en: {
      about: "On eligible plans, Codex and ChatGPT Work share the same agentic usage and credits pool.",
      question: "Does a Codex reset also affect ChatGPT Work?",
      answer: "A reset affecting that shared pool can therefore affect both Codex and ChatGPT Work",
    },
    zh: {
      about: "在符合条件的方案中，Codex 和 ChatGPT Work 共享同一个代理式使用量和额度池。",
      question: "Codex 的重置也会影响 ChatGPT Work 吗？",
      answer: "影响这一共享额度池的重置也可能影响两者。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const aboutHtml = renderToStaticMarkup(React.createElement(AboutView, { locale }));
    const faqHtml = renderToStaticMarkup(React.createElement(FaqView, { locale }));

    assert.ok(aboutHtml.includes(cases[locale].about), locale);
    assert.ok(aboutHtml.includes("Codex") || locale === "zh", locale);
    assert.ok(faqHtml.includes(cases[locale].question), locale);
    assert.ok(faqHtml.includes(cases[locale].answer), locale);
    assert.match(faqHtml, /"@type":"FAQPage"/);
  }
});

test("adds stable ChatGPT reset FAQ anchors and keeps the whole-service distinction", () => {
  const cases = {
    ja: {
      work: "ChatGPT Workのリセットも関係ありますか？",
      reset: "ChatGPTのリセットとCodexのリセットは同じですか？",
      distinction: "すべてのChatGPT利用制限がCodexと同じわけではありません。",
    },
    en: {
      work: "Does a Codex reset also affect ChatGPT Work?",
      reset: "Is a ChatGPT reset the same as a Codex reset?",
      distinction: "Not all ChatGPT usage limits are the same as Codex limits.",
    },
    zh: {
      work: "Codex 的重置也会影响 ChatGPT Work 吗？",
      reset: "ChatGPT 的重置和 Codex 的重置是同一回事吗？",
      distinction: "并非所有 ChatGPT 使用限制都与 Codex 的限制相同。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(React.createElement(FaqView, { locale }));

    assert.match(html, new RegExp(`id="chatgpt-work-reset"`));
    assert.match(html, new RegExp(`id="chatgpt-reset"`));
    assert.ok(html.includes(cases[locale].work), locale);
    assert.ok(html.includes(cases[locale].reset), locale);
    assert.ok(html.includes(cases[locale].distinction), locale);
    assert.match(html, /"@type":"FAQPage"/);
  }
});

test("renders the history scope row while retaining localized scope values", () => {
  const calculationNow = new Date("2026-08-10T12:00:00.000Z");
  const template = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "ja",
    { calculationNow },
  ).viewModel.recentHistory[0];

  const makeItem = (scope: string) => ({
    ...template,
    key: `scope-${scope}`,
    scope,
    details: {
      ...(template.details ?? {
        cycleType: "ランダムリセット",
        reasonType: "ご祝儀リセット",
        resetMethod: "強制リセット",
        scope,
        noticeToExecution: "",
      }),
      scope,
      noticeToExecution: "",
      noticeType: "なし",
      note: null,
    },
  });

  const scopeValues = [
    "Codex / ChatGPT Work",
    "全有料プラン",
    "不具合対象ユーザー（約50万人）",
    "任意リセット未使用アカウント",
    "Go / Plus / Pro",
  ] as const;
  const scopeLabels = {
    ja: "対象",
    en: "Eligibility",
    zh: "适用对象",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    for (const scope of scopeValues) {
      const html = renderToStaticMarkup(
        React.createElement(ResetHistoryDetails, {
          item: makeItem(scope),
          locale,
        }),
      );
      const translatedScope = translateDynamic(scope, locale);
      if (scope === "全有料プラン") {
        assert.doesNotMatch(html, new RegExp(scopeLabels[locale]));
        assert.doesNotMatch(
          html,
          new RegExp(translatedScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      } else {
        assert.match(html, new RegExp(scopeLabels[locale]));
        assert.match(
          html,
          new RegExp(translatedScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    }
  }
});

test("keeps all-paid-plan scope in internal history data and random-reset eligibility", () => {
  const calculationNow = new Date("2026-08-31T00:00:00.000Z");
  const stored = LOCAL_RESET_HISTORY.find(
    (item) =>
      item.details?.cycleType === "ランダムリセット" &&
      item.details.scope === "全有料プラン" &&
      item.recordKind === "confirmed_global" &&
      Date.parse(item.completed_at ?? item.closed_at ?? "") <= calculationNow.getTime(),
  );
  assert.ok(stored);
  assert.equal(stored.details?.scope, "全有料プラン");

  const viewModel = getRadarViewModel(
    getLocalRadarData({ calculationNow }),
    "ja",
    false,
    undefined,
    calculationNow,
  );
  const projected = viewModel.recentHistory.find(
    (item) => item.key === stored.id,
  );
  assert.ok(projected);
  assert.equal(projected.scope, "全有料プラン");
  assert.equal(projected.details?.scope, "全有料プラン");

  const completedAt = Date.parse(stored.completed_at ?? stored.closed_at ?? "");
  assert.equal(
    isEligibleRandomResetEvent(
      stored,
      completedAt,
      Date.parse("2026-08-24T00:00:00.000Z"),
    ),
    true,
  );
});

test("localizes the current reset supplement about per-account rollout timing", () => {
  const calculationNow = new Date("2026-09-08T06:00:00.000Z");
  const expected = {
    ja: "リセットは全アカウントで同時ではなく順次実施され、実施時刻にはアカウントごとの差がありました。",
    en: "The reset was carried out sequentially rather than simultaneously for all accounts, so the execution time varied by account.",
    zh: "重置并非所有账号同时进行，而是按顺序执行，各账号的执行时间有所不同。",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const viewModel = getRadarViewModel(
      getLocalRadarData({ calculationNow }),
      locale,
      false,
      undefined,
      calculationNow,
    );
    const item = viewModel.recentHistory.find(
      (historyItem) => historyItem.key === "local-codex-rolling-notice-reset-2026-09-08",
    );
    assert.ok(item, `${locale} current reset history item should be present`);
    assert.equal(item.details?.note, expected[locale]);
  }
});

test("keeps the AIE reset button event aligned with its one-hour notice window", () => {
  const stored = LOCAL_RESET_HISTORY.find(
    (item) => item.id === "personal-codex-reset-button-aie-2026-07-02",
  );
  assert.ok(stored);

  const openedAt = Date.parse(stored.opened_at ?? "");
  const completedAt = Date.parse(stored.completed_at ?? stored.closed_at ?? "");
  assert.equal(Math.round((completedAt - openedAt) / 60000), 60);
  assert.equal(stored.window_minutes, 60);
  assert.equal(stored.details?.noticeToExecution, "1時間");
  assert.equal(stored.details?.noticeType, "告知投稿あり");
  assert.equal(stored.recordKind, "banked_distribution");

  const calculationNow = new Date("2026-07-03T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow });
  const expected = {
    ja: { signalLabel: "告知", noticeToExecution: "1時間", windowLength: "1時間" },
    en: { signalLabel: "Announcement", noticeToExecution: "1 hour", windowLength: "1 hour" },
    zh: { signalLabel: "告知", noticeToExecution: "1小时", windowLength: "1小时" },
  } as const;

  const aieHistoryKey = "personal-codex-reset-button-aie-2026-07-02";
  for (const locale of ["ja", "en", "zh"] as const) {
    const viewModel = getRadarViewModel(data, locale, false, undefined, calculationNow);
    const aieViewItem = viewModel.recentHistory.find(
      (historyItem) => historyItem.key === aieHistoryKey,
    );
    assert.ok(aieViewItem, `${locale} AIE history item should be present`);
    assert.equal(aieViewItem.signalAt, stored.opened_at);
    assert.equal(aieViewItem.resetAt, stored.completed_at);
    assert.equal(aieViewItem.signalLabel, expected[locale].signalLabel);
    assert.equal(aieViewItem.details?.noticeToExecution, expected[locale].noticeToExecution);
    assert.equal(aieViewItem.windowLength, expected[locale].windowLength);
    assert.notEqual(aieViewItem.windowLength, locale === "en" ? "Immediate reset" : locale === "zh" ? "即时重置" : "即時リセット");
  }
});

test("maps stored history notice types to the three presentation states", () => {
  const cases = [
    ["公式予告あり", "announcement"],
    ["公式告知あり", "announcement"],
    ["告知投稿あり", "announcement"],
    ["予告あり", "announcement"],
    ["匂わせ投稿あり", "teaser"],
    ["なし", "none"],
    ["予告なし", "none"],
    ["", "none"],
    [null, "none"],
    [undefined, "none"],
  ] as const;

  for (const [rawNoticeType, expected] of cases) {
    assert.equal(getHistoryNoticePresentation(rawNoticeType), expected, rawNoticeType ?? "empty");
  }
});

test("does not infer an announcement from an opened non-notice history event", () => {
  const calculationNow = new Date("2026-08-31T00:00:00.000Z");
  const event = {
    id: "non-notice-opened-history",
    recordKind: "confirmed_global" as const,
    title: "告知なしリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: "2026-08-30T05:00:00.000Z",
    closed_at: "2026-08-30T06:00:00.000Z",
    completed_at: "2026-08-30T06:00:00.000Z",
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeType: "なし",
      noticeToExecution: "0分",
      note: "告知なしのテストイベント",
    },
  };
  const originalHistory = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, event);

  try {
    for (const locale of ["ja", "en", "zh"] as const) {
      const snapshot = toPublicRadarSnapshot(
        getLocalRadarData({ calculationNow }),
        locale,
        { calculationNow },
      );
      const item = snapshot.viewModel.recentHistory.find((historyItem) => historyItem.key === event.id);
      assert.ok(item, `${locale} non-notice history item should be present`);
      assert.equal(item.details?.noticeType, undefined);
      assert.equal(item.details?.noticeToExecution, "");
      assert.equal(item.signalAt, null);
      assert.equal(item.signalLabel, "");

      const detailsHtml = renderToStaticMarkup(
        React.createElement(ResetHistoryDetails, { item, locale }),
      );
      assert.doesNotMatch(detailsHtml, /告知あり|Announcement|有告知|匂わせあり|Teaser hint|有预告提示/);
      assert.doesNotMatch(detailsHtml, /告知から実施まで|Time from notice to reset|从预告到执行/);

      const dashboardHtml = renderToStaticMarkup(
        React.createElement(RadarDashboard, {
          initialData: {
            ...snapshot,
            viewModel: { ...snapshot.viewModel, recentHistory: [item] },
          },
          locale,
        }),
      );
      const historyIndex = dashboardHtml.indexOf(item.title);
      assert.ok(historyIndex >= 0, `${locale} non-notice history title should be rendered`);
      const historyHtml = dashboardHtml.slice(historyIndex);
      assert.doesNotMatch(historyHtml, />告知(?:：|: )<\/span>/);
      assert.doesNotMatch(historyHtml, />Announcement: <\/span>/);
      assert.doesNotMatch(historyHtml, />予告(?:：|: )<\/span>|>Notice: <\/span>|>预告：<\/span>/);
      assert.match(
        historyHtml,
        new RegExp(`>${locale === "en" ? "Reset" : locale === "zh" ? "执行" : "実施"}${locale === "en" ? ": " : "："}</span>`),
      );
    }
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...originalHistory);
  }
});

test("normalizes a monitor-only recovery to the shared history schema", () => {
  const calculationNow = new Date("2026-08-30T00:00:00.000Z");
  const resetEventKey = "usage-reset-41c8ec4e-f752-4e5b-b685-4af67a1e6925";
  const recoveryObservation: CodexRecoveryObservation = {
    id: "41c8ec4e-f752-4e5b-b685-4af67a1e6925",
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-29T21:25:40.549Z",
    previousObservedAt: "2026-08-29T21:21:40.487Z",
    previousUsedPercent: 80,
    currentUsedPercent: 0,
    previousResetsAt: 1788000000,
    currentResetsAt: 1788604800,
    cycleHint: "unexpected",
    confidence: "strong",
    status: "confirmed",
    matchedTiboTweetId: null,
  };
  const estimate = buildResetExecutionEstimate({
    resetEventKey,
    usageObservation: recoveryObservation,
    isMonitorObserved: true,
  });
  assert.ok(estimate);
  assert.equal(estimate.estimatorVersion, MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION);

  const displayName: ResetDisplayNameRecord = {
    event_key: resetEventKey,
    source_tweet_id: null,
    manual_name_ja: "Codex利用制限改善対応リセット",
    ai_name_ja: null,
    ai_confidence: null,
    ai_evidence: null,
    ai_reason: null,
    ai_model: null,
    ai_prompt_version: null,
    ai_input_mode: null,
    ai_status: null,
    ai_flags: null,
    ai_generated_at: null,
    input_hash: null,
  };
  const data = getLocalRadarData({
    calculationNow,
    codexRecoveryObservations: [recoveryObservation],
    resetExecutionEstimates: [estimate],
    resetDisplayNames: [displayName],
  });
  const expected = {
    ja: { reason: "詫びリセット", oldWindowLabel: "検知幅", oldSignal: "観測", oldNoticeSignal: "予告" },
    en: { reason: "Compensation reset", oldWindowLabel: "Detection window", oldSignal: "Observed", oldNoticeSignal: "Notice" },
    zh: { reason: "故障补偿重置", oldWindowLabel: "检测时间窗口", oldSignal: "观测", oldNoticeSignal: "预告" },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(data, locale, { calculationNow });
    const item = snapshot.viewModel.recentHistory.find((historyItem) => historyItem.key === resetEventKey);
    assert.ok(item, `${locale} monitor-only history item should be present`);
    assert.equal(item.details?.reasonType, expected[locale].reason);
    assert.equal(item.details?.noticeToExecution, "");
    assert.equal(item.signalLabel, "");
    assert.equal(item.signalAt, null);
    assert.equal(item.resetAt, recoveryObservation.observedAt);
    assert.equal(item.details?.noticeType, undefined);

    const detailsHtml = renderToStaticMarkup(
      React.createElement(ResetHistoryDetails, { item, locale }),
    );
    assert.doesNotMatch(detailsHtml, /告知から実施まで|Time from notice to reset|从预告到执行/);
    assert.doesNotMatch(detailsHtml, /0分|0 min|0 分/);
    assert.doesNotMatch(detailsHtml, new RegExp(expected[locale].oldWindowLabel));
    assert.doesNotMatch(detailsHtml, new RegExp(expected[locale].oldSignal));

    const dashboardHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: {
          ...snapshot,
          viewModel: { ...snapshot.viewModel, recentHistory: [item] },
        },
        locale,
      }),
    );
    const historyIndex = dashboardHtml.indexOf(item.title);
    assert.ok(historyIndex >= 0, `${locale} monitor-only title should be rendered`);
    const historyHtml = dashboardHtml.slice(historyIndex);
    assert.doesNotMatch(historyHtml, new RegExp(`>${expected[locale].oldSignal}${locale === "en" ? ": " : "："}</span>`));
    assert.doesNotMatch(historyHtml, new RegExp(`>${expected[locale].oldNoticeSignal}${locale === "en" ? ": " : "："}</span>`));
    assert.match(historyHtml, new RegExp(`>${locale === "en" ? "Reset" : locale === "zh" ? "执行" : "実施"}${locale === "en" ? ": " : "："}</span>`));
  }
});

test("keeps notice-backed history on the shared notice-to-execution schema", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const makeReset = (
    tweetId: string,
    noticeType: TiboNoticeSignal["signal_type"],
    noticeAt: string,
    resetAt: string,
  ): FormalTiboResetSignal => ({
    tweet_id: tweetId,
    text: "I reset usage limits for Codex and ChatGPT Work.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: resetAt,
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    related_notice: {
      tweet_id: `${tweetId}-notice`,
      text: noticeType === "official_notice" ? "The reset is scheduled." : "A reset may be coming.",
      tweet_url: `https://x.com/thsottiaux/status/${tweetId}-notice`,
      tweet_created_at: noticeAt,
      signal_type: noticeType,
      confidence: noticeType === "official_notice" ? 0.96 : 0.9,
      verification_status: "auto_unverified",
    },
  });
  const data = getLocalRadarData({
    calculationNow,
    formalTiboResets: [
      makeReset("shared-official-reset", "official_notice", "2026-08-01T07:00:00.000Z", "2026-08-01T09:00:00.000Z"),
      makeReset("shared-teaser-reset", "teaser", "2026-08-02T07:00:00.000Z", "2026-08-02T09:00:00.000Z"),
    ],
  });

  const expected = {
    ja: { duration: "2時間", signal: "告知", announcement: "告知あり", teaser: "匂わせあり" },
    en: { duration: "2 hours", signal: "Announcement", announcement: "Announcement", teaser: "Teaser hint" },
    zh: { duration: "2 小时", signal: "告知", announcement: "有告知", teaser: "有预告提示" },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const viewModel = getRadarViewModel(data, locale, false, undefined, calculationNow);
    for (const key of ["shared-official-reset", "shared-teaser-reset"]) {
      const item = viewModel.recentHistory.find((historyItem) => historyItem.key === `tibo-reset-${key}`);
      assert.ok(item, `${locale} ${key} history item should be present`);
      assert.equal(item.details?.noticeToExecution, expected[locale].duration);
      assert.equal(
        item.details?.noticeType,
        key.includes("teaser") ? expected[locale].teaser : expected[locale].announcement,
      );
      assert.equal(item.signalLabel, expected[locale].signal);
      assert.ok(item.signalAt);
      assert.ok(item.resetAt);
    }
  }
});

test("adds a localized FAQ note about plan and account-specific reset application", () => {
  const cases = {
    ja: {
      question: "リセットはすべての有料プランに適用されますか？",
      answer: "過去にはBusinessで未適用または遅延となった事例も確認されています。",
    },
    en: {
      question: "Does a reset always apply to every paid plan?",
      answer: "We have seen past cases where Business was not included or was updated later.",
    },
    zh: {
      question: "重置一定会适用于所有付费方案吗？",
      answer: "过去也曾出现 Business 未适用或延迟生效的情况。",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const html = renderToStaticMarkup(React.createElement(FaqView, { locale }));
    assert.ok(html.includes(cases[locale].question), locale);
    assert.ok(html.includes(cases[locale].answer), locale);
  }
});

test("public FAQ wording names only the displayed 24-hour and 48-hour forecasts", () => {
  const html = renderToStaticMarkup(React.createElement(FaqView, { locale: "en" }));

  assert.match(html, /within the next 24 or 48 hours/);
  assert.doesNotMatch(html, /next 12, 24, 48, or 72 hours/);
});

test("joins display outlook sentences without locale-specific spacing errors", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const baseEvaluation = getLocalSignalEvaluation(data, now);
  const branchEvaluations = [
    {
      environment: { official_updates_24h: 1 },
      statusIncidents: {},
    },
    {
      environment: {},
      statusIncidents: { activeStatusIncidentCount: 1 },
    },
    {
      environment: { issue_or_limit_anomalies_24h: 1 },
      statusIncidents: {},
    },
  ];

  for (const branch of branchEvaluations) {
    const evaluation = {
      ...baseEvaluation,
      environment: { ...baseEvaluation.environment, ...branch.environment },
      statusIncidents: { ...baseEvaluation.statusIncidents, ...branch.statusIncidents },
    };

    for (const locale of ["ja", "en", "zh"] as const) {
      const reason = getDisplayProbabilityReason(
        data,
        0.25,
        0.45,
        locale,
        evaluation,
        null,
        now,
      );

      assert.ok(reason);
      if (locale === "en") {
        assert.doesNotMatch(reason, / {2,}/);
      } else {
        assert.doesNotMatch(reason, /。 /);
      }
    }
  }
});


test("timed teaser outlook renders crawlable JST on SSR before browser-local hydration", () => {
  const calculationNow = new Date("2026-08-27T08:30:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [{
      tweet_id: "localized-timed-teaser-outlook",
      signal_type: "teaser",
      text: "Reset button tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/localized-timed-teaser-outlook",
      tweet_created_at: "2026-08-27T06:31:31.000Z",
      expires_at: "2026-08-28T10:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      teaser_strength: "strong",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "day",
      temporal_confidence: 0.95,
      expected_start_at: "2026-08-27T07:00:00.000Z",
      expected_end_at: "2026-08-28T07:00:00.000Z",
    }],
    recentTiboSignals: [{
      tweet_id: "localized-timed-teaser-outlook",
      signal_type: "teaser",
      text: "Reset button tomorrow.",
      tweet_url: "https://x.com/thsottiaux/status/localized-timed-teaser-outlook",
      tweet_created_at: "2026-08-27T06:31:31.000Z",
      expires_at: "2026-08-28T10:00:00.000Z",
      confidence: 0.9,
      verification_status: "confirmed",
      teaser_strength: "strong",
      is_reply: false,
      temporal_resolution_status: "resolved",
      temporal_precision: "day",
      temporal_confidence: 0.95,
      expected_start_at: "2026-08-27T07:00:00.000Z",
      expected_end_at: "2026-08-28T07:00:00.000Z",
    }],
  });
  const snapshot = toPublicRadarSnapshot(internal, "ja", { calculationNow });
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: snapshot,
      initialFetchedAt: calculationNow.toISOString(),
      locale: "ja",
    }),
  );

  assert.match(html, /Tiboがリセットを強く示唆しています/);
  assert.match(html, /<time[^>]*dateTime="2026-08-27T07:00:00\.000Z"[^>]*>2026年8月27日 16:00 JST<\/time>/);
  assert.match(html, /<time[^>]*dateTime="2026-08-28T07:00:00\.000Z"[^>]*>2026年8月28日 16:00 JST<\/time>/);
});
