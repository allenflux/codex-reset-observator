import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveManualOutlook,
  type ManualOutlookConfig,
} from "../data/manualOutlook";
import { RadarDashboard } from "../components/RadarDashboard";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("resolveManualOutlook returns null when config is null or expiresAt is null", () => {
  assert.equal(resolveManualOutlook(Date.now(), "ja", null), null);
  assert.equal(
    resolveManualOutlook(Date.now(), "ja", {
      expiresAt: null,
      message: "テスト",
    }),
    null,
  );
});

test("resolveManualOutlook returns active override when within valid time window", () => {
  const config: ManualOutlookConfig = {
    expiresAt: "2026-09-10T12:00:00.000Z",
    message: {
      ja: "一時的な手動メッセージです。",
      en: "Temporary manual message.",
      zh: "临时手动消息。",
    },
  };

  const beforeExpiry = resolveManualOutlook(
    "2026-09-10T06:00:00.000Z",
    "ja",
    config,
  );
  assert.ok(beforeExpiry);
  assert.equal(beforeExpiry.isActive, true);
  assert.equal(beforeExpiry.message, "一時的な手動メッセージです。");
  assert.equal(beforeExpiry.badge, "速報");
  assert.equal(beforeExpiry.style, "alert");
  assert.equal(beforeExpiry.showSystemReasonBelow, false);

  const enResult = resolveManualOutlook(
    "2026-09-10T06:00:00.000Z",
    "en",
    config,
  );
  assert.ok(enResult);
  assert.equal(enResult.message, "Temporary manual message.");
  assert.equal(enResult.badge, "Flash");

  const zhResult = resolveManualOutlook(
    "2026-09-10T06:00:00.000Z",
    "zh",
    config,
  );
  assert.ok(zhResult);
  assert.equal(zhResult.message, "临时手动消息。");
  assert.equal(zhResult.badge, "快讯");
});

test("resolveManualOutlook returns null after expiresAt (auto-expiration)", () => {
  const config: ManualOutlookConfig = {
    expiresAt: "2026-09-10T12:00:00.000Z",
    message: "テスト",
  };

  // Exactly at expiresAt -> expired
  assert.equal(
    resolveManualOutlook("2026-09-10T12:00:00.000Z", "ja", config),
    null,
  );
  // After expiresAt -> expired
  assert.equal(
    resolveManualOutlook("2026-09-10T12:00:01.000Z", "ja", config),
    null,
  );
});

test("resolveManualOutlook respects startsAt when specified", () => {
  const config: ManualOutlookConfig = {
    startsAt: "2026-09-10T08:00:00.000Z",
    expiresAt: "2026-09-10T12:00:00.000Z",
    message: "テスト",
  };

  // Before startsAt -> not yet active
  assert.equal(
    resolveManualOutlook("2026-09-10T07:59:59.000Z", "ja", config),
    null,
  );
  // Within window -> active
  assert.ok(resolveManualOutlook("2026-09-10T08:00:00.000Z", "ja", config));
});

test("resolveManualOutlook supports custom badges and warning/info styles", () => {
  const warningConfig: ManualOutlookConfig = {
    expiresAt: "2026-09-10T12:00:00.000Z",
    style: "warning",
    badge: { ja: "重要なお知らせ", en: "Important", zh: "重要通知" },
    message: "注意メッセージ",
    showSystemReasonBelow: true,
  };

  const res = resolveManualOutlook("2026-09-10T09:00:00.000Z", "ja", warningConfig);
  assert.ok(res);
  assert.equal(res.badge, "重要なお知らせ");
  assert.equal(res.style, "warning");
  assert.equal(res.showSystemReasonBelow, true);

  const infoConfig: ManualOutlookConfig = {
    expiresAt: "2026-09-10T12:00:00.000Z",
    style: "info",
    message: "お知らせメッセージ",
  };
  const infoRes = resolveManualOutlook("2026-09-10T09:00:00.000Z", "en", infoConfig);
  assert.ok(infoRes);
  assert.equal(infoRes.badge, "Info");
  assert.equal(infoRes.style, "info");
});

test("RadarDashboard renders alert container, badge, and manual message when override is active in module", async () => {
  const { setManualOutlookOverrideForTesting } = await import("../data/manualOutlook");
  const calculationNow = new Date("2026-08-04T00:00:00.000Z");
  const snapshot = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow }),
    "ja",
    { calculationNow },
  );

  // Explicitly test null override -> normal rendering
  setManualOutlookOverrideForTesting(null);
  const defaultHtml = renderToStaticMarkup(
    React.createElement(RadarDashboard, {
      initialData: snapshot,
      initialFetchedAt: "2026-08-04T00:00:00.000Z",
      locale: "ja",
    }),
  );
  assert.ok(defaultHtml.includes("現在の見込み"));
  assert.ok(!defaultHtml.includes("bg-red-50/80"));
  assert.ok(!defaultHtml.includes("bg-red-600"));

  // Set testing override
  try {
    setManualOutlookOverrideForTesting({
      expiresAt: "2026-08-04T06:00:00.000Z",
      style: "alert",
      message: {
        ja: "現在リセット状況を確認中のため、一時的に手動文章を表示しています。",
        en: "Temporarily showing manual message while checking reset status.",
        zh: "正在确认重置状态，暂时展示手动消息。",
      },
    });

    const activeHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: snapshot,
        initialFetchedAt: "2026-08-04T02:00:00.000Z",
        locale: "ja",
      }),
    );

    assert.ok(activeHtml.includes("現在リセット状況を確認中のため、一時的に手動文章を表示しています。"));
    assert.ok(activeHtml.includes("border-red-300"));
    assert.ok(activeHtml.includes("bg-red-50/80"));
    assert.ok(activeHtml.includes("bg-red-600"));
    assert.ok(activeHtml.includes("速報"));

    // English render check
    const activeEnHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: snapshot,
        initialFetchedAt: "2026-08-04T02:00:00.000Z",
        locale: "en",
      }),
    );
    assert.ok(activeEnHtml.includes("Temporarily showing manual message while checking reset status."));
    assert.ok(activeEnHtml.includes("Flash"));

    // After expiration -> reverts to normal rendering automatically
    const expiredHtml = renderToStaticMarkup(
      React.createElement(RadarDashboard, {
        initialData: snapshot,
        initialFetchedAt: "2026-08-04T07:00:00.000Z",
        locale: "ja",
      }),
    );
    assert.ok(!expiredHtml.includes("現在リセット状況を確認中のため"));
    assert.ok(!expiredHtml.includes("bg-red-50/80"));
  } finally {
    setManualOutlookOverrideForTesting(undefined);
  }
});
