import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatDateTimeInZone,
  getBrowserTimeZone,
  getTimeZoneLabel,
  LocalizedDateTime,
} from "../components/LocalizedDateTime";
import { HistoryView } from "../components/HistoryView";
import {
  getHistoryDateTimeProps,
  groupHistoryByMonth,
} from "../components/LocalizedHistoryEvents";
import { RadarDashboard } from "../components/RadarDashboard";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { translateDynamic, translateUI } from "../lib/radar/i18n";
import {
  createObservedRegularResetEventRow,
  getDueRegularResetEventRows,
} from "../lib/radar/regularResetSchedule";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

test("public radar DTO uses an allowlist and excludes internal audit fields", () => {
  const internal = getLocalRadarData({
    checkedAt: "2026-08-04T00:00:00.000Z",
  }) as typeof getLocalRadarData extends (...args: never[]) => infer T ? T : never;

  Object.assign(internal, {
    ai_reason_ja: "internal reason",
    classification_reason: "internal classification",
    rule_confidence: 0.9,
    ai_confidence: 0.99,
    ai_model: "private-model",
    ai_classification_status: "success",
    rejected_tibo_resets: [{ tweet_id: "private-id" }],
    active_tibo_signals: [
      {
        tweet_id: "private-tweet",
        signal_type: "irrelevant",
        text: "private full tweet text",
        tweet_created_at: "2026-08-04T00:00:00.000Z",
      },
    ],
  });

  const publicSnapshot = toPublicRadarSnapshot(internal, "en");
  const serialized = JSON.stringify(publicSnapshot);

  assert.equal(publicSnapshot.schemaVersion, "public-v1");
  assert.equal(publicSnapshot.checkedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(publicSnapshot.viewModel.codexOperationalStatus, "none");
  assert.equal("ai_reason_ja" in publicSnapshot, false);
  assert.equal("classification_reason" in publicSnapshot, false);
  assert.equal("rule_confidence" in publicSnapshot, false);
  assert.equal("ai_confidence" in publicSnapshot, false);
  assert.equal("ai_model" in publicSnapshot, false);
   assert.equal("ai_classification_status" in publicSnapshot, false);
   assert.equal("rejected_tibo_resets" in publicSnapshot, false);
   assert.equal("reasoningSummary" in publicSnapshot.viewModel, false);
   assert.equal("action" in publicSnapshot.viewModel, false);
  assert.doesNotMatch(serialized, /private-model|private reason|private-tweet/);
  assert.equal(publicSnapshot.viewModel.recentHistory.length >= 0, true);

  const staleSnapshot = toPublicRadarSnapshot(internal, "en", {
    stale: true,
    generatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(staleSnapshot.dataHealth.stale, true);
  assert.equal(staleSnapshot.dataHealth.generatedAt, "2026-08-03T00:00:00.000Z");
});

test("public snapshot exposes a random-only last reset timestamp", () => {
  const calculationNow = new Date("2026-08-10T12:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    regularResetEvents: [
      createObservedRegularResetEventRow("2026-08-08T03:00:00.000Z", "2026-08-08T03:00:00.000Z"),
    ],
  });
  const snapshot = toPublicRadarSnapshot(
    internal,
    "ja",
    { calculationNow },
  );
  const publicSnapshot = snapshot as typeof snapshot & { lastRandomResetAt: string | null };
  const expectedViewModel = getRadarViewModel(internal, "ja", true, undefined, calculationNow);

  assert.equal(publicSnapshot.lastRandomResetAt, "2026-08-01T03:32:00.000Z");
  assert.equal(snapshot.viewModel.regularResetForecast.sourceResetAt, "2026-08-08T03:00:00.000Z");
  assert.notEqual(publicSnapshot.lastRandomResetAt, snapshot.viewModel.regularResetForecast.sourceResetAt);
  assert.deepEqual(
    {
      probability12h: snapshot.viewModel.probability12h,
      probability24h: snapshot.viewModel.probability24h,
      probability48h: snapshot.viewModel.probability48h,
      probability72h: snapshot.viewModel.probability72h,
      displayReasoningSummary: snapshot.viewModel.displayReasoningSummary,
    },
    {
      probability12h: expectedViewModel.probability12h,
      probability24h: expectedViewModel.probability24h,
      probability48h: expectedViewModel.probability48h,
      probability72h: expectedViewModel.probability72h,
      displayReasoningSummary: expectedViewModel.displayReasoningSummary,
    },
  );
});

test("public snapshot returns null when only a regular boundary is available", () => {
  const calculationNow = new Date("2026-05-02T12:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      regularResetEvents: [
        createObservedRegularResetEventRow("2026-04-25T12:00:00.000Z", "2026-04-25T12:00:00.000Z"),
      ],
    }),
    "en",
    { calculationNow },
  );
  const publicSnapshot = snapshot as typeof snapshot & { lastRandomResetAt: string | null };

  assert.equal(publicSnapshot.lastRandomResetAt, null);
});

test("public Tibo activity exposes the post projection and classification", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    activeTiboSignals: [
      {
        tweet_id: "private-tweet-id",
        signal_type: "teaser",
        text: "There will be signs... Resets soon.",
        tweet_url: "https://x.com/thsottiaux/status/123",
        tweet_created_at: "2026-08-03T23:00:00.000Z",
        expires_at: "2026-08-05T00:00:00.000Z",
        verification_status: "auto_unverified",
        confidence: 0.87,
        classification_reason: "private internal reason",
      },
    ],
  });

  const snapshot = toPublicRadarSnapshot(internal, "en", { calculationNow });
  const serialized = JSON.stringify(snapshot);

  assert.deepEqual(snapshot.latestTiboActivity, {
    classification: "teaser",
    teaserStrength: null,
    text: "There will be signs... Resets soon.",
    createdAt: "2026-08-03T23:00:00.000Z",
    sourceUrl: "https://x.com/thsottiaux/status/123",
    isReply: false,
    replyContextText: null,
    replyToHandles: [],
  });
  assert.doesNotMatch(
    serialized,
    /private-tweet-id|private internal reason|confidence|classification_reason/,
  );
});

test("public reply activity exposes bounded parent context without audit fields", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      recentTiboSignals: [
        {
          tweet_id: "reply-public-tweet",
          signal_type: "teaser",
          teaser_strength: "weak",
          text: "Maybe",
          tweet_url: "https://x.com/thsottiaux/status/reply-public-tweet",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          expires_at: "2026-08-05T00:00:00.000Z",
          verification_status: "confirmed",
          is_reply: true,
          reply_to_handles: ["@Ananth7e", "invalid handle", "@Ananth7e"],
          reply_context_text: `  ${"x".repeat(1200)}  `,
          classification_reason: "private reason",
        },
      ],
    }),
    "ja",
    { calculationNow },
  );
  const activity = snapshot.latestTiboActivity;
  const serialized = JSON.stringify(activity);

  assert.equal(activity?.isReply, true);
  assert.deepEqual(activity?.replyToHandles, ["@Ananth7e"]);
  assert.equal(activity?.replyContextText?.length, 1000);
  assert.doesNotMatch(serialized, /private reason|ai_reason_ja/);
  assert.equal("tweet_id" in (activity ?? {}), false);
});

test("public recovery projection exposes only the provisional status fields", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    codexRecoveryObservation: {
      sourceKey: "local-codex-app-server",
      observedAt: "2026-08-03T23:30:00.000Z",
      previousUsedPercent: 69,
      currentUsedPercent: 0,
      previousResetsAt: 1780000000,
      currentResetsAt: 1780600000,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "observed",
      matchedTiboTweetId: null,
      confirmedAt: null,
    },
  });

  const snapshot = toPublicRadarSnapshot(internal, "ja", { calculationNow });
  const serialized = JSON.stringify(snapshot);
  assert.deepEqual(snapshot.recoveryObservation, {
    status: "observed_unconfirmed",
    observedAt: "2026-08-03T23:30:00.000Z",
    confidence: "strong",
    cycleHint: "unexpected",
  });
  assert.doesNotMatch(serialized, /usedPercent|previousResetsAt|currentResetsAt|planType|matchedTiboTweetId/);
});

test("rejected recovery observations stay out of the public snapshot", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      codexRecoveryObservation: {
        sourceKey: "local-codex-app-server",
        observedAt: "2026-08-03T23:30:00.000Z",
        previousUsedPercent: 100,
        currentUsedPercent: 0,
        previousResetsAt: 1780000000,
        currentResetsAt: 1780600000,
        cycleHint: "unexpected",
        confidence: "strong",
        status: "rejected",
        matchedTiboTweetId: null,
        confirmedAt: null,
      },
    }),
    "ja",
    { calculationNow },
  );

  assert.equal(snapshot.recoveryObservation, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /利用枠の回復を観測/);
});

test("usage recovery presentation does not change published probabilities", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const base = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "ja",
    { calculationNow },
  );
  const withRecovery = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      codexRecoveryObservation: {
        sourceKey: "local-codex-app-server",
        observedAt: "2026-08-03T23:30:00.000Z",
        previousUsedPercent: 69,
        currentUsedPercent: 0,
        previousResetsAt: 1780000000,
        currentResetsAt: 1780600000,
        cycleHint: "unexpected",
        confidence: "strong",
        status: "observed",
      },
    }),
    "ja",
    { calculationNow },
  );
  assert.equal(withRecovery.viewModel.probability24h, base.viewModel.probability24h);
  assert.equal(withRecovery.viewModel.probability48h, base.viewModel.probability48h);
  assert.deepEqual(withRecovery.viewModel.recentHistory, base.viewModel.recentHistory);
  assert.equal(
    withRecovery.viewModel.regularResetForecast.sourceResetAt,
    base.viewModel.regularResetForecast.sourceResetAt,
  );
});

test("public Tibo activity exposes only the UI teaser strength, not its audit details", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "weak-teaser-tweet",
        signal_type: "irrelevant",
        text: "I occasionally do oblige for really solid feedback.",
        tweet_url: "https://x.com/thsottiaux/status/124",
        tweet_created_at: "2026-08-03T23:00:00.000Z",
        verification_status: "auto_unverified",
        teaser_strength: "weak",
      },
    ],
  });

  const snapshot = toPublicRadarSnapshot(internal, "en", { calculationNow });
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.latestTiboActivity?.teaserStrength, "weak");
  assert.doesNotMatch(serialized, /teaserStrengthConfidence|teaserStrengthEvidenceQuote|teaserStrengthReasonJa/);
});

test("missing teaser strength stays unknown instead of becoming none", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      recentTiboSignals: [
        {
          tweet_id: "unclassified-tweet",
          signal_type: "teaser",
          text: "An older classifier result.",
          tweet_url: "https://x.com/thsottiaux/status/125",
          tweet_created_at: "2026-08-03T23:00:00.000Z",
          verification_status: "auto_unverified",
        },
      ],
    }),
    "en",
    { calculationNow },
  );

  assert.equal(snapshot.latestTiboActivity?.teaserStrength, null);
});

test("public Tibo activity can use a recent signal after its active expiry", () => {
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "expired-active-tweet",
        signal_type: "reset_executed",
        text: "Usage limits reset for Codex users.",
        tweet_url: "https://x.com/thsottiaux/status/456",
        tweet_created_at: "2026-08-03T23:00:00.000Z",
        expires_at: "2026-08-03T23:30:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
  });

  const snapshot = toPublicRadarSnapshot(internal, "en", { calculationNow });

  assert.equal(snapshot.latestTiboActivity?.classification, "reset_executed");
  assert.equal(snapshot.latestTiboActivity?.createdAt, "2026-08-03T23:00:00.000Z");
});

test("public Tibo activity uses the newest stored post even when it is irrelevant", () => {
  const calculationNow = new Date("2026-08-07T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "newest-irrelevant-tweet",
        signal_type: "irrelevant",
        text: "A newer Tibo post unrelated to resets.",
        tweet_url: "https://x.com/thsottiaux/status/789",
        tweet_created_at: "2026-08-06T23:00:00.000Z",
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "older-reset-tweet",
        signal_type: "reset_executed",
        text: "An older reset post.",
        tweet_url: "https://x.com/thsottiaux/status/790",
        tweet_created_at: "2026-08-01T03:32:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
  });

  const snapshot = toPublicRadarSnapshot(internal, "en", { calculationNow });

  assert.deepEqual(snapshot.latestTiboActivity, {
    classification: "irrelevant",
    teaserStrength: null,
    text: "A newer Tibo post unrelated to resets.",
    createdAt: "2026-08-06T23:00:00.000Z",
    sourceUrl: "https://x.com/thsottiaux/status/789",
    isReply: false,
    replyContextText: null,
    replyToHandles: [],
  });
});

test("completed Astra rollout removes terminated notices from related activity and keeps the rollout post as latest", () => {
  const beforeTermination = new Date("2026-09-04T22:30:28.999Z");
  const terminationAt = new Date("2026-09-04T22:30:29.000Z");
  const bankedNotice = {
    tweet_id: "2095979536043401428",
    signal_type: "official_notice" as const,
    text: "We will distribute a BANKED reset to eligible users.",
    tweet_url: "https://x.com/thsottiaux/status/2095979536043401428",
    tweet_created_at: "2026-09-04T20:57:00.000Z",
    expires_at: "2026-09-06T00:00:00.000Z",
    verification_status: "auto_unverified" as const,
    confidence: 0.99,
  };
  const astraTeaser = {
    tweet_id: "2095597168816226335",
    signal_type: "teaser" as const,
    text: "We are starting to release GPT-6 Astra.",
    tweet_url: "https://x.com/thsottiaux/status/2095597168816226335",
    tweet_created_at: "2026-09-03T19:37:54.000Z",
    expires_at: "2026-09-06T00:00:00.000Z",
    verification_status: "auto_unverified" as const,
    confidence: 0.9,
    teaser_strength: "weak" as const,
  };
  const rolloutCompletion = {
    tweet_id: "2096002992046796932",
    signal_type: "irrelevant" as const,
    text: "Astra is now rolled out to all Plus and Business users too.",
    tweet_url: "https://x.com/thsottiaux/status/2096002992046796932",
    tweet_created_at: "2026-09-04T22:30:29.000Z",
    verification_status: "auto_unverified" as const,
  };
  const internal = getLocalRadarData({
    recentTiboSignals: [bankedNotice, astraTeaser, rolloutCompletion],
    calculationNow: terminationAt,
  });

  const before = toPublicRadarSnapshot(internal, "en", { calculationNow: beforeTermination });
  const after = toPublicRadarSnapshot(internal, "en", { calculationNow: terminationAt });

  assert.equal(before.latestTiboActivity?.classification, "official_notice");
  assert.equal(before.latestTiboActivity?.sourceUrl, bankedNotice.tweet_url);
  assert.equal(after.latestTiboActivity?.classification, "irrelevant");
  assert.equal(after.latestTiboActivity?.sourceUrl, rolloutCompletion.tweet_url);
  assert.doesNotMatch(JSON.stringify(after.latestTiboActivity), /2095979536043401428|2095597168816226335/);
});

test("public Tibo activity translates known post text for each page locale", () => {
  const calculationNow = new Date("2026-08-07T00:00:00.000Z");
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "localized-tibo-post",
        signal_type: "irrelevant",
        text: "You can just ask Codex with GPT-5.6 Sol the wildest things and it will just do it. I talk to it for 5 minutes straight with things that just seem to require weeks of work, get up to get something in the fridge, pet the dog, come back and...",
        tweet_url: "https://x.com/thsottiaux/status/localized-tibo-post",
        tweet_created_at: "2026-08-06T23:00:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
  });

  const ja = toPublicRadarSnapshot(internal, "ja", { calculationNow });
  const en = toPublicRadarSnapshot(internal, "en", { calculationNow });
  const zh = toPublicRadarSnapshot(internal, "zh", { calculationNow });

  assert.match(ja.latestTiboActivity?.text ?? "", /GPT-5\.6 Sol搭載のCodexなら/);
  assert.match(zh.latestTiboActivity?.text ?? "", /使用 GPT-5\.6 Sol 的 Codex/);
  assert.match(en.latestTiboActivity?.text ?? "", /You can just ask Codex with GPT-5\.6 Sol/);
  assert.notEqual(ja.latestTiboActivity?.text, en.latestTiboActivity?.text);
  assert.notEqual(zh.latestTiboActivity?.text, en.latestTiboActivity?.text);
});

test("public Tibo activity uses stored translations and keeps the full post text", () => {
  const calculationNow = new Date("2026-08-07T00:00:00.000Z");
  const longPost = `First paragraph of the Tibo post.\n\nSecond paragraph with details ${"x".repeat(260)}`;
  const internal = getLocalRadarData({
    calculationNow,
    recentTiboSignals: [
      {
        tweet_id: "translated-tibo-post",
        signal_type: "official_notice",
        text: longPost,
        translated_text_ja: "Tibo投稿の日本語訳です。\n\n詳細を含みます。",
        translated_text_zh: "这是 Tibo 帖子的简体中文翻译。\n\n包含详细信息。",
        tweet_url: "https://x.com/thsottiaux/status/translated-tibo-post",
        tweet_created_at: "2026-08-06T23:00:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
  });

  const ja = toPublicRadarSnapshot(internal, "ja", { calculationNow });
  const zh = toPublicRadarSnapshot(internal, "zh", { calculationNow });
  const en = toPublicRadarSnapshot(internal, "en", { calculationNow });

  assert.equal(ja.latestTiboActivity?.text, "Tibo投稿の日本語訳です。\n\n詳細を含みます。");
  assert.equal(zh.latestTiboActivity?.text, "这是 Tibo 帖子的简体中文翻译。\n\n包含详细信息。");
  assert.equal(en.latestTiboActivity?.text, longPost);
  assert.equal(en.latestTiboActivity?.text?.includes("x".repeat(260)), true);
  assert.equal(en.latestTiboActivity?.text?.includes("\n\n"), true);
});

test("SSR datetime renders deterministic JST text before browser timezone hydration", () => {
  const props = {
    value: "2026-08-04T00:00:00.000Z",
    locale: "ja" as const,
  };
  const html = renderToStaticMarkup(
    React.createElement(LocalizedDateTime, props),
  );
  const firstClientRender = renderToStaticMarkup(
    React.createElement(LocalizedDateTime, {
      ...props,
    }),
  );

  assert.match(html, /<time[^>]*dateTime="2026-08-04T00:00:00\.000Z"/);
  assert.match(html, /2026年8月4日 09:00 JST/);
  assert.doesNotMatch(html, /aria-busy="true"|aria-hidden="true"|min-w-\[12rem\]/);
  assert.doesNotMatch(html, /Detecting time zone|タイムゾーンを検出中/);
  assert.doesNotMatch(html, /undefined|null|false/);
  assert.equal(firstClientRender, html);
});

test("browser timezone detection uses IANA values and falls back to JST only on failure", () => {
  assert.equal(getBrowserTimeZone(() => "America/New_York"), "America/New_York");
  assert.equal(getBrowserTimeZone(() => ""), "Asia/Tokyo");
  assert.equal(getBrowserTimeZone(() => {
    throw new Error("timezone unavailable");
  }), "Asia/Tokyo");
});

test("formats Tokyo time with one JST label in Japanese and Chinese", () => {
  const date = new Date("2026-08-01T03:32:00.000Z");

  const japanese = formatDateTimeInZone(date, "Asia/Tokyo", "ja-JP");
  const chinese = formatDateTimeInZone(date, "Asia/Tokyo", "zh-CN");

  assert.equal(japanese, "2026年8月1日 12:32 JST");
  assert.equal(chinese, "2026年8月1日 12:32 JST");
  assert.equal((chinese.match(/JST/g) ?? []).length, 1);
  assert.doesNotMatch(chinese, /GMT\+9/);
});

test("marks usage-derived execution times as approximate without changing the timezone label", () => {
  const date = new Date("2026-08-11T00:02:00.000Z");

  assert.equal(
    formatDateTimeInZone(date, "Asia/Tokyo", "ja-JP", { approximate: true }),
    "2026年8月11日 09:02頃 JST",
  );
  assert.match(
    formatDateTimeInZone(date, "Asia/Tokyo", "en-US", { approximate: true }),
    /^around Aug 11, 2026, 09:02 AM JST$/,
  );
  assert.equal(
    formatDateTimeInZone(date, "Asia/Tokyo", "zh-CN", { approximate: true }),
    "约2026年8月11日 09:02 JST",
  );
  assert.equal(
    formatDateTimeInZone(date, "Asia/Tokyo", "ja-JP"),
    "2026年8月11日 09:02 JST",
  );
});

test("history execution display omits approximate markers while internal precision remains available", () => {
  const item = {
    resetAt: "2026-08-13T03:34:43.341Z",
    executionTimePrecision: "approximate" as const,
  };

  const props = getHistoryDateTimeProps(item);
  assert.equal(props.approximate, false);
  assert.equal(
    formatDateTimeInZone(
      new Date(item.resetAt),
      "Asia/Tokyo",
      "ja-JP",
      { approximate: props.approximate },
    ),
    "2026年8月13日 12:34 JST",
  );
});

test("formats a scheduled Japanese datetime with a compact weekday", () => {
  assert.equal(
    formatDateTimeInZone(
      new Date("2026-08-10T07:00:00.000Z"),
      "Asia/Tokyo",
      "ja-JP",
      { weekday: "short" },
    ),
    "2026年8月10日(月) 16:00 JST",
  );
});

test("uses IANA zone identity for Seoul instead of the shared UTC+9 offset", () => {
  const value = formatDateTimeInZone(
    new Date("2026-08-01T03:32:00.000Z"),
    "Asia/Seoul",
    "en-US",
  );

  assert.match(value, /Aug 1, 2026, 12:32 PM KST$/);
  assert.doesNotMatch(value, /JST/);
  assert.equal(getTimeZoneLabel(new Date("2026-08-01T03:32:00.000Z"), "Asia/Seoul"), "KST");
});

test("uses UTC for the explicit UTC IANA zones", () => {
  const date = new Date("2026-08-01T03:32:00.000Z");

  assert.equal(getTimeZoneLabel(date, "UTC"), "UTC");
  assert.equal(getTimeZoneLabel(date, "Etc/UTC"), "UTC");
  assert.match(formatDateTimeInZone(date, "UTC", "en-US"), /UTC$/);
});

test("uses seasonal abbreviations for New York and Los Angeles", () => {
  const newYorkSummer = formatDateTimeInZone(
    new Date("2026-08-01T16:32:00.000Z"),
    "America/New_York",
    "en-US",
  );
  const newYorkWinter = formatDateTimeInZone(
    new Date("2026-01-01T17:32:00.000Z"),
    "America/New_York",
    "en-US",
  );
  const losAngelesSummer = formatDateTimeInZone(
    new Date("2026-08-01T19:32:00.000Z"),
    "America/Los_Angeles",
    "en-US",
  );
  const losAngelesWinter = formatDateTimeInZone(
    new Date("2026-01-01T20:32:00.000Z"),
    "America/Los_Angeles",
    "en-US",
  );

  assert.match(newYorkSummer, /Aug 1, 2026, 12:32 PM EDT$/);
  assert.match(newYorkWinter, /Jan 1, 2026, 12:32 PM EST$/);
  assert.match(losAngelesSummer, /Aug 1, 2026, 12:32 PM PDT$/);
  assert.match(losAngelesWinter, /Jan 1, 2026, 12:32 PM PST$/);
});

test("formats the same ISO instant in the local zone and changes the calendar date when needed", () => {
  const value = "2026-08-01T03:32:00.000Z";
  const tokyo = formatDateTimeInZone(new Date(value), "Asia/Tokyo", "en-US");
  const newYork = formatDateTimeInZone(new Date(value), "America/New_York", "en-US");

  assert.match(tokyo, /Aug 1, 2026, 12:32 PM JST$/);
  assert.match(newYork, /Jul 31, 2026, 11:32 PM EDT$/);
  assert.notEqual(tokyo, newYork);
});

test("preserves unknown and invalid datetime fallback text", () => {
  const unknown = renderToStaticMarkup(
    React.createElement(LocalizedDateTime, { value: null, locale: "en" }),
  );
  const invalid = renderToStaticMarkup(
    React.createElement(LocalizedDateTime, { value: "not-a-date", locale: "zh" }),
  );

  assert.equal(unknown, "<span>Unknown</span>");
  assert.equal(invalid, "<span>not-a-date</span>");
});

test("date class composition omits an absent className", () => {
  const html = renderToStaticMarkup(
    React.createElement(LocalizedDateTime, {
      value: "2026-08-04T00:00:00.000Z",
      locale: "en",
      timeClassName: "font-normal text-slate-700",
    }),
  );

  assert.doesNotMatch(html, /class="[^"]*(undefined|null|false)/);
  assert.match(html, /<time[^>]*font-normal text-slate-700/);
});

test("dashboard renders the translated reset history label", () => {
  const data = toPublicRadarSnapshot(getLocalRadarData({}), "en");
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: data, locale: "en" }),
  );

  assert.match(html, /Reset history/);
  assert.doesNotMatch(html, />resetHistory</);
});

test("stale fallback data renders normally without a public warning in every locale", () => {
  const warningText = {
    ja: "最新データの取得に失敗したため、最後に取得できた結果を表示しています。",
    en: "Live refresh failed. Showing the last successfully fetched result.",
    zh: "实时更新失败，当前显示上次成功获取的结果。",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const data = toPublicRadarSnapshot(getLocalRadarData({}), locale, {
      stale: true,
      generatedAt: "2026-08-03T00:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: data, locale }),
    );

    assert.doesNotMatch(html, new RegExp(warningText[locale]));
    assert.match(html, /24/);
    assert.match(html, /48/);
  }
});

test("unavailable data keeps the existing public error warning", () => {
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: null, locale: "ja" }),
  );

  assert.match(html, /ライブデータも保存済みデータも取得できません/);
});

test("history page combines confirmed, banked, and regular reference records chronologically", () => {
  const data = toPublicRadarSnapshot(getLocalRadarData({}), "en", { limitHistory: false });
  const html = renderToStaticMarkup(React.createElement(HistoryView, { data, locale: "en" }));

  assert.match(html, /<h2[^>]*>Reset history<\/h2>/);
  assert.match(html, /<h1 class="mt-2 text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl">Recent Codex Reset Events<\/h1>/);
  assert.doesNotMatch(html, /<h2[^>]*>Confirmed global resets|<h2[^>]*>Banked Reset distributions/);
  assert.doesNotMatch(html, /text-\[11px\]/);
  const visibleItems = data.viewModel.recentHistory.filter(
    (item) => item.recordKind === "confirmed_global" ||
      item.recordKind === "banked_distribution" ||
      item.recordKind === "reference",
  );
  assert.ok(visibleItems.length >= 3);
  const firstTitle = translateDynamic(visibleItems[0].title, "en");
  const secondTitle = translateDynamic(visibleItems[1].title, "en");
  for (const item of visibleItems) {
    assert.match(html, new RegExp(escapeRegExp(escapeHtml(translateDynamic(item.title, "en")))));
  }
  assert.ok(html.indexOf(escapeHtml(firstTitle)) < html.indexOf(escapeHtml(secondTitle)));
  assert.doesNotMatch(html, /aria-busy="true"/);
  assert.match(html, /<time[^>]*dateTime=/);
  assert.match(html, /JST/);
  assert.match(html, /Original post/);
  assert.match(html, /Source profile/);
  assert.match(html, /Weekly reset/);
  assert.doesNotMatch(html, /Unclassified history sentinel/);

  const unclassifiedData = toPublicRadarSnapshot(getLocalRadarData({}), "en", { limitHistory: false });
  const firstItem = unclassifiedData.viewModel.recentHistory[0];
  unclassifiedData.viewModel.recentHistory = [
    ...unclassifiedData.viewModel.recentHistory,
    { ...firstItem, key: "unclassified-history-test", title: "Unclassified history sentinel", recordKind: undefined },
  ];
  const unclassifiedHtml = renderToStaticMarkup(
    React.createElement(HistoryView, { data: unclassifiedData, locale: "en" }),
  );
  assert.doesNotMatch(unclassifiedHtml, /Unclassified history sentinel/);

  const localizedAssertions = {
    ja: {
      title: "リセット履歴",
    reference: "定期リセット",
    },
    en: {
      title: "Reset history",
      reference: "Weekly reset",
    },
    zh: {
      title: "重置记录",
      reference: "定期重置",
    },
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const localizedData = toPublicRadarSnapshot(getLocalRadarData({}), locale, { limitHistory: false });
    const localizedHtml = renderToStaticMarkup(
      React.createElement(HistoryView, { data: localizedData, locale }),
    );
    assert.match(localizedHtml, new RegExp(`<h2[^>]*>${localizedAssertions[locale].title}<\\/h2>`));
    assert.doesNotMatch(localizedHtml, /text-\[11px\]/);
    assert.match(localizedHtml, new RegExp(escapeRegExp(localizedAssertions[locale].reference)));

    const description = {
      ja: "Codexの全体リセットと任意リセット配布を、新しい順にまとめています。",
      en: "Global resets and Banked Reset distributions are listed together in chronological order.",
      zh: "按时间倒序汇总 Codex 全局重置和手动重置发放记录。",
    }[locale];
    assert.equal((localizedHtml.match(new RegExp(escapeRegExp(description), "g")) ?? []).length, 1);
  }
});

test("dashboard places freshness below the current outlook", () => {
  const data = toPublicRadarSnapshot(getLocalRadarData({}), "en");
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: data, locale: "en" }),
  );
  const freshnessLabel = translateUI("lastSuccessfulRefresh", "en");
  const currentStatusIndex = html.indexOf(translateUI("currentStatus", "en"));
  const outlookIndex = html.indexOf(translateUI("forecastOutlook", "en"));
  const freshnessIndex = html.indexOf(freshnessLabel);
  const historyIndex = html.indexOf(translateUI("resetHistory", "en"));

  assert.ok(currentStatusIndex >= 0);
  assert.ok(outlookIndex > currentStatusIndex);
  assert.ok(freshnessIndex > outlookIndex);
  assert.ok(historyIndex > freshnessIndex);
  assert.equal((html.match(new RegExp(escapeRegExp(freshnessLabel), "g")) ?? []).length, 1);
});

test("freshness uses concise localized labels and subdued datetime styling", () => {
  assert.equal(translateUI("lastSuccessfulRefresh", "ja"), "最終更新");
  assert.equal(translateUI("lastSuccessfulRefresh", "en"), "Last updated");
  assert.equal(translateUI("lastSuccessfulRefresh", "zh"), "最后更新");

  const data = toPublicRadarSnapshot(getLocalRadarData({}), "ja");
  const html = renderToStaticMarkup(
    React.createElement(RadarDashboard, { initialData: data, locale: "ja" }),
  );

  assert.match(html, /最終更新：/);
  assert.match(html, /<time[^>]*font-normal text-slate-700/);
  assert.match(html, /lg:justify-end/);
});

test("history month grouping follows the viewer timezone", () => {
  const data = toPublicRadarSnapshot(getLocalRadarData({}), "en", { limitHistory: false });
  const sourceItem = data.viewModel.recentHistory[0];
  assert.ok(sourceItem);
  const boundaryItem = {
    ...sourceItem,
    resetAt: "2026-08-01T03:32:00.000Z",
    date: "2026-08-01T03:32:00.000Z",
  };

  assert.equal(
    groupHistoryByMonth([boundaryItem], "en", "Asia/Tokyo")[0]?.label,
    "August 2026",
  );
  assert.equal(
    groupHistoryByMonth([boundaryItem], "en", "America/New_York")[0]?.label,
    "July 2026",
  );

  const html = renderToStaticMarkup(React.createElement(HistoryView, { data, locale: "en" }));
  assert.doesNotMatch(html, /aria-busy="true"/);
  assert.match(html, /August 2026/);
  assert.match(html, /JST/);
});

test("normalizes regular reset presentation and hides notice/source rows", () => {
  const calculationNow = new Date("2026-08-08T05:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      regularResetEvents: getDueRegularResetEventRows(
        calculationNow,
        "2026-08-01T03:32:00.000Z",
      ),
    }),
    "ja",
    {
      calculationNow,
      limitHistory: false,
    },
  );
  const regular = snapshot.viewModel.recentHistory.find(
    (item) => item.recordKind === "regular_completed",
  );
  assert.ok(regular);
  assert.equal(regular.title, "定期リセット");
  assert.equal(regular.details?.cycleType, "定期リセット");
  assert.equal(regular.details?.reasonType, "定期更新");
  assert.equal(regular.details?.resetMethod, "強制リセット");
  assert.equal(regular.details?.scope, "任意リセット未使用アカウント");
  assert.equal(regular.details?.noticeToExecution, "");
  assert.equal(regular.details?.noticeType, undefined);
  assert.equal(
    regular.summary,
    "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。",
  );
  assert.equal(
    regular.details?.note,
    "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。",
  );
  assert.equal(regular.signalAt, null);
  assert.equal(regular.signalLabel, "");
  assert.equal(regular.source, null);

  const regularOnlySnapshot = {
    ...snapshot,
    viewModel: {
      ...snapshot.viewModel,
      recentHistory: [regular],
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(HistoryView, { data: regularOnlySnapshot, locale: "ja" }),
  );
  assert.doesNotMatch(html, /予告/);
  assert.doesNotMatch(html, /出典未記録/);
});

test("regular history keeps a known Banked Reset delivery method", () => {
  const snapshot = toPublicRadarSnapshot(getLocalRadarData({}), "ja", {
    calculationNow: new Date("2026-08-08T05:00:00.000Z"),
    limitHistory: false,
  });
  const bankedRegular = snapshot.viewModel.recentHistory.find(
    (item) =>
      item.details?.cycleType === "定期リセット" &&
      item.details.resetMethod === "任意リセット権配布",
  );
  assert.ok(bankedRegular);
  assert.equal(bankedRegular.details?.reasonType, "定期更新");
  assert.equal(bankedRegular.details?.resetMethod, "任意リセット権配布");
});

test("regular reset supplement is localized without changing the history summary", () => {
  const expectedNotes = {
    ja: "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。",
    en: "A regular reset occurs one week after you first use Codex or Work following the previous reset. If you use a Banked Reset, the next weekly timing is likewise counted from your first use after that reset, so it may differ from the time shown here.",
    zh: "定期重置会在您上次重置后首次使用 Codex 或 Work 的一周后进行。使用手动重置后也一样，会从该重置后的首次使用时间起算一周，因此实际时间可能与此处显示的时间不同。",
  } as const;
  const expectedSummaries = {
    ja: "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。",
    en: "Codex usage limits were reset on the usual weekly-cycle timing.",
    zh: "在常规的 1 周循环时间点，执行了 Codex 使用限制重置。",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const calculationNow = new Date("2026-08-08T05:00:00.000Z");
    const snapshot = toPublicRadarSnapshot(getLocalRadarData({
      calculationNow,
      regularResetEvents: getDueRegularResetEventRows(
        calculationNow,
        "2026-08-01T03:32:00.000Z",
      ),
    }), locale, {
      calculationNow,
      limitHistory: false,
    });
    const regular = snapshot.viewModel.recentHistory.find(
      (item) => item.recordKind === "regular_completed",
    );

    assert.ok(regular);
    assert.equal(regular.details?.note, expectedNotes[locale]);
    assert.equal(regular.summary, expectedSummaries[locale]);
  }
});

test("top dashboard omits latest reset and weekly reference cards", () => {
  const weeklyLabels = {
    ja: "1週間サイクルのリセット参考日",
    en: "Weekly reset reference",
    zh: "每周重置参考日期",
  } as const;
  const weeklyNotes = {
    ja: "過去の全体リセット時刻から7日後を計算した参考値です。各アカウントの実際の表示日時や利用枠とは異なる場合があります。",
    en: "This is a shared reference calculated as seven days after the latest confirmed global reset. Your account’s actual usage window may differ.",
    zh: "这是根据最近一次已确认的全局重置时间向后计算七天得到的公共参考值。您账号的实际使用周期可能不同。",
  } as const;
  const calculationNow = new Date("2026-08-04T03:32:00.000Z");

  for (const locale of ["ja", "en", "zh"] as const) {
    const data = toPublicRadarSnapshot(
      getLocalRadarData({ calculationNow }),
      locale,
      { calculationNow },
    );
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: data, locale }),
    );
    const currentStatusStart = html.indexOf(translateUI("currentStatus", locale));
    const historyStart = html.indexOf(translateUI("resetHistory", locale));
    const forecast = data.viewModel.regularResetForecast;

    assert.ok(currentStatusStart >= 0);
    assert.ok(historyStart > currentStatusStart);
    const currentStatusHtml = html.slice(currentStatusStart, historyStart);
    assert.doesNotMatch(currentStatusHtml, new RegExp(escapeRegExp(translateUI("latestReset", locale))));
    assert.doesNotMatch(currentStatusHtml, new RegExp(escapeRegExp(weeklyLabels[locale])));
    assert.doesNotMatch(currentStatusHtml, new RegExp(escapeRegExp(weeklyNotes[locale])));
    assert.doesNotMatch(currentStatusHtml, new RegExp(escapeRegExp(forecast.date)));
    assert.doesNotMatch(currentStatusHtml, new RegExp(escapeRegExp(forecast.remaining)));
    assert.match(html, new RegExp(escapeRegExp(translateUI("within24h", locale))));
    assert.match(html, new RegExp(escapeRegExp(translateUI("within48h", locale))));
    assert.doesNotMatch(html, new RegExp(escapeRegExp(translateUI("within12h", locale))));
    assert.doesNotMatch(html, new RegExp(escapeRegExp(translateUI("within72h", locale))));
  }
});

test("shows the next regular reset reference only within 72 hours", () => {
  const calculationNow = new Date("2026-08-05T03:32:00.000Z");
  const labels = {
    ja: "次回定期リセット参考日",
    en: "Next regular reset reference",
    zh: "下次定期重置参考日期",
  } as const;
  const notes = {
    ja: "実際のリセット日時は、ユーザーごとの利用状況により異なる場合があります。",
    en: "The actual reset time may vary by user depending on usage.",
    zh: "实际重置时间可能因用户的使用情况而异。",
  } as const;
  for (const locale of ["ja", "en", "zh"] as const) {
    const data = toPublicRadarSnapshot(
      getLocalRadarData({ calculationNow }),
      locale,
      { calculationNow },
    );
    const html = renderToStaticMarkup(
      React.createElement(RadarDashboard, { initialData: data, locale }),
    );

    assert.equal(data.viewModel.regularResetForecast.isNoticeWindow, true);
    assert.match(html, new RegExp(escapeRegExp(labels[locale])));
    assert.match(html, new RegExp(escapeRegExp(notes[locale])));
    assert.doesNotMatch(html, /<dt[^>]*>参考日時<\/dt>|<dt[^>]*>Reference date and time<\/dt>|<dt[^>]*>参考日期和时间<\/dt>/);
    const remaining = data.viewModel.regularResetForecast.remaining;
    const remainingText = locale === "en" ? `(${remaining})` : `（${remaining}）`;
    assert.match(html, new RegExp(escapeRegExp(remainingText)));
    assert.match(html, /dateTime="2026-08-08T03:32:00\.000Z"/);
  }
});

test("history uses the common announcement label only for a signal before execution", () => {
  const expectedLabels = {
    ja: "告知：",
    en: "Announcement:",
    zh: "告知：",
  } as const;

  for (const locale of ["ja", "en", "zh"] as const) {
    const base = toPublicRadarSnapshot(getLocalRadarData({}), locale, { limitHistory: false });
    const sourceItem = base.viewModel.recentHistory.find((item) => item.recordKind === "confirmed_global");
    assert.ok(sourceItem);

    const makeSnapshot = (signalAt: string) => ({
      ...base,
      viewModel: {
        ...base.viewModel,
        recentHistory: [
          {
            ...sourceItem,
            signalAt,
            resetAt: "2026-08-02T00:00:00.000Z",
          },
        ],
      },
    });

    const priorSignalHtml = renderToStaticMarkup(
      React.createElement(HistoryView, {
        data: makeSnapshot("2026-08-01T23:00:00.000Z"),
        locale,
      }),
    );
    const immediateHtml = renderToStaticMarkup(
      React.createElement(HistoryView, {
        data: makeSnapshot("2026-08-02T00:00:00.000Z"),
        locale,
      }),
    );

    assert.match(priorSignalHtml, new RegExp(expectedLabels[locale]));
    assert.doesNotMatch(immediateHtml, new RegExp(expectedLabels[locale]));
  }
});

test("current API keeps its shared cache and excludes responses from search indexing", () => {
  const routeSource = readFileSync(resolve("app/api/current/route.ts"), "utf8");

  assert.match(routeSource, /"Cache-Control": API_CACHE_CONTROL/);
  assert.match(routeSource, /"X-Robots-Tag": "noindex, nofollow"/);
});


test("public Tibo activity exposes only resolved teaser window timestamps needed for localized outlook rendering", () => {
  const calculationNow = new Date("2026-08-27T08:30:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({
      calculationNow,
      recentTiboSignals: [{
        tweet_id: "public-timed-teaser",
        signal_type: "teaser",
        text: "Reset button tomorrow.",
        tweet_url: "https://x.com/thsottiaux/status/public-timed-teaser",
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
    }),
    "en",
    { calculationNow },
  );

  assert.equal(snapshot.latestTiboActivity?.temporalResolutionStatus, "resolved");
  assert.equal(snapshot.latestTiboActivity?.expectedStartAt, "2026-08-27T07:00:00.000Z");
  assert.equal(snapshot.latestTiboActivity?.expectedEndAt, "2026-08-28T07:00:00.000Z");
});
