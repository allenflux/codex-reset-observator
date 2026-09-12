import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import type { WindowEventLike } from "../lib/radar/types";

const RESET_AT = "2026-08-01T00:00:00.000Z";

function historyEvent(overrides: Partial<WindowEventLike> = {}): WindowEventLike {
  const scope = "全有料プラン";
  return {
    id: "history-event",
    recordKind: "confirmed_global",
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: RESET_AT,
    closed_at: RESET_AT,
    completed_at: RESET_AT,
    scope,
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope,
      noticeType: "なし",
      noticeToExecution: "0分",
    },
    ...overrides,
  };
}

test("recent history dedupes by raw stable id before locale projection", () => {
  const firstTitle = "Codex信頼性障害補償リセット";
  const secondTitle = "Codex障害対応の利用上限リセット";
  const noIdentityTitle = "same raw title";
  const history = [
    historyEvent({ id: "stable-first", title: firstTitle }),
    historyEvent({ id: "stable-second", title: secondTitle }),
    historyEvent({ id: "stable-first", title: "別表示名" }),
    historyEvent({ id: undefined, guid: undefined, title: noIdentityTitle }),
    historyEvent({ id: undefined, guid: undefined, title: noIdentityTitle }),
  ];
  const calculationNow = new Date("2026-08-10T00:00:00.000Z");
  const originalHistory = LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...history);
  const localizedKeys: Record<"ja" | "en" | "zh", string[]> = {
    ja: [],
    en: [],
    zh: [],
  };
  const localizedFallbackKeys: Record<"ja" | "en" | "zh", string[]> = {
    ja: [],
    en: [],
    zh: [],
  };

  try {
    for (const locale of ["ja", "en", "zh"] as const) {
      const viewModel = getRadarViewModel(
        getLocalRadarData({ calculationNow }),
        locale,
        false,
        undefined,
        calculationNow,
      );
      const stableItems = viewModel.recentHistory.filter((item) =>
        item.key === "stable-first" || item.key === "stable-second",
      );
      const noIdentityItems = viewModel.recentHistory.filter(
        (item) => item.title === noIdentityTitle,
      );

      assert.equal(stableItems.length, 2, `${locale} keeps distinct stable IDs`);
      assert.equal(
        viewModel.recentHistory.filter((item) => item.key === "stable-first").length,
        1,
        `${locale} removes the duplicate stable ID`,
      );
      assert.equal(noIdentityItems.length, 2, `${locale} keeps records without stable IDs`);
      assert.equal(
        new Set(noIdentityItems.map((item) => item.key)).size,
        2,
        `${locale} assigns unique presentation keys without stable IDs`,
      );

      if (locale === "en") {
        assert.equal(
          viewModel.recentHistory.filter((item) => item.title === "Codex reliability compensation reset").length,
          2,
        );
      }
      if (locale === "zh") {
        assert.equal(
          viewModel.recentHistory.filter((item) => item.title === "Codex 可靠性事故补偿重置").length,
          2,
        );
      }

      localizedKeys[locale] = viewModel.recentHistory.map((item) => item.key);
      localizedFallbackKeys[locale] = noIdentityItems.map((item) => item.key);
    }
  } finally {
    LOCAL_RESET_HISTORY.splice(0, LOCAL_RESET_HISTORY.length, ...originalHistory);
  }

  assert.deepEqual(localizedKeys.en, localizedKeys.ja);
  assert.deepEqual(localizedKeys.zh, localizedKeys.ja);
  assert.deepEqual(localizedFallbackKeys.en, localizedFallbackKeys.ja);
  assert.deepEqual(localizedFallbackKeys.zh, localizedFallbackKeys.ja);
});

test("built-in recent history keeps the same keys and order for every locale", () => {
  const calculationNow = new Date("2026-08-31T00:00:00.000Z");
  const localized = ["ja", "en", "zh"].map((locale) =>
    getRadarViewModel(
      getLocalRadarData({ calculationNow }),
      locale as "ja" | "en" | "zh",
      false,
      undefined,
      calculationNow,
    ).recentHistory.map((item) => ({ key: item.key, recordKind: item.recordKind })),
  );

  assert.deepEqual(localized[1], localized[0]);
  assert.deepEqual(localized[2], localized[0]);
});
