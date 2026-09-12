import test from "node:test";
import assert from "node:assert";
import { LOCAL_OBSERVATION_SIGNALS } from "../data/observationSignals";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { resolveLocalizedText, translateDynamic, UI_TRANSLATIONS } from "../lib/radar/i18n";
import { getRadarViewModel, getLocalRadarData } from "../lib/radar";

const JAPANESE_CHAR_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
const JAPANESE_KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/;

test("i18n Automated Check: All LOCAL_OBSERVATION_SIGNALS have full English & Chinese translations", () => {
  for (const signal of LOCAL_OBSERVATION_SIGNALS) {
    if (signal.boostReason) {
      const enBoost = translateDynamic(signal.boostReason, "en");
      const zhBoost = translateDynamic(signal.boostReason, "zh");

      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(enBoost),
        false,
        `Signal '${signal.id}' boostReason lacks English translation. Got: "${enBoost}"`
      );
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(zhBoost),
        false,
        `Signal '${signal.id}' boostReason contains Japanese kana in Chinese. Got: "${zhBoost}"`
      );
      assert.ok(enBoost.length > 0, `Signal '${signal.id}' English boostReason is empty`);
      assert.ok(zhBoost.length > 0, `Signal '${signal.id}' Chinese boostReason is empty`);
    }

    if (signal.title) {
      const enTitle = translateDynamic(signal.title, "en");
      const zhTitle = translateDynamic(signal.title, "zh");
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(enTitle),
        false,
        `Signal '${signal.id}' title lacks English translation. Got: "${enTitle}"`
      );
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(zhTitle),
        false,
        `Signal '${signal.id}' title contains Japanese kana in Chinese. Got: "${zhTitle}"`
      );
    }
  }
});

test("i18n Automated Check: All LOCAL_RESET_HISTORY items have valid English & Chinese translations", () => {
  for (const history of LOCAL_RESET_HISTORY) {
    const historyTitle = typeof history.title === "object" && history.title !== null ? history.title.ja : history.title;
    const historyIdentifier = history.id ?? historyTitle;
    const historyDate = history.completed_at ?? history.closed_at ?? history.opened_at;
    const historyLabel = historyIdentifier ?? historyDate;

    if (history.title) {
      const enTitle = resolveLocalizedText(history.title, "en");
      const zhTitle = resolveLocalizedText(history.title, "zh");
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(enTitle),
        false,
        `History '${historyLabel}' title lacks English translation. Got: "${enTitle}"`
      );
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(zhTitle),
        false,
        `History '${historyLabel}' title contains Japanese kana in Chinese. Got: "${zhTitle}"`
      );
    }
    if (history.details) {
      if (history.details.noticeType) {
        const enNotice = translateDynamic(history.details.noticeType, "en");
        const zhNotice = translateDynamic(history.details.noticeType, "zh");
        assert.strictEqual(
          JAPANESE_CHAR_REGEX.test(enNotice),
          false,
          `History '${historyLabel}' noticeType lacks English translation. Got: "${enNotice}"`
        );
        assert.strictEqual(
          JAPANESE_KANA_REGEX.test(zhNotice),
          false,
          `History '${historyLabel}' noticeType contains Japanese kana in Chinese. Got: "${zhNotice}"`
        );
      }
      if (history.details.cycleType) {
        const enCycle = translateDynamic(history.details.cycleType, "en");
        const zhCycle = translateDynamic(history.details.cycleType, "zh");
        assert.strictEqual(
          JAPANESE_CHAR_REGEX.test(enCycle),
          false,
          `History '${historyLabel}' cycleType lacks English translation. Got: "${enCycle}"`
        );
        assert.strictEqual(
          JAPANESE_KANA_REGEX.test(zhCycle),
          false,
          `History '${historyLabel}' cycleType contains Japanese kana in Chinese. Got: "${zhCycle}"`
        );
      }
      if (history.details.reasonType) {
        const enReason = translateDynamic(history.details.reasonType, "en");
        const zhReason = translateDynamic(history.details.reasonType, "zh");
        assert.strictEqual(
          JAPANESE_CHAR_REGEX.test(enReason),
          false,
          `History '${historyLabel}' reasonType lacks English translation. Got: "${enReason}"`
        );
        assert.strictEqual(
          JAPANESE_KANA_REGEX.test(zhReason),
          false,
          `History '${historyLabel}' reasonType contains Japanese kana in Chinese. Got: "${zhReason}"`
        );
      }
      if (history.details.resetMethod) {
        const enMethod = translateDynamic(history.details.resetMethod, "en");
        const zhMethod = translateDynamic(history.details.resetMethod, "zh");
        assert.strictEqual(
          JAPANESE_CHAR_REGEX.test(enMethod),
          false,
          `History '${historyLabel}' resetMethod lacks English translation. Got: "${enMethod}"`
        );
        assert.strictEqual(
          JAPANESE_KANA_REGEX.test(zhMethod),
          false,
          `History '${historyLabel}' resetMethod contains Japanese kana in Chinese. Got: "${zhMethod}"`
        );
      }
      if (history.details.scope) {
        const enScope = translateDynamic(history.details.scope, "en");
        const zhScope = translateDynamic(history.details.scope, "zh");
        assert.strictEqual(
          JAPANESE_CHAR_REGEX.test(enScope),
          false,
          `History '${historyLabel}' scope lacks English translation. Got: "${enScope}"`
        );
        assert.strictEqual(
          JAPANESE_KANA_REGEX.test(zhScope),
          false,
          `History '${historyLabel}' scope contains Japanese kana in Chinese. Got: "${zhScope}"`
        );
      }
    }
    const historyNote = history.details?.note;
    if (historyNote) {
      const enNote = resolveLocalizedText(historyNote, "en");
      const zhNote = resolveLocalizedText(historyNote, "zh");
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(enNote),
        false,
        `History '${historyLabel}' note lacks English translation. Got: "${enNote}"`
      );
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(zhNote),
        false,
        `History '${historyLabel}' note contains Japanese kana in Chinese. Got: "${zhNote}"`
      );
    }
  }
});

test("i18n Automated Check: Common history noticeType values have valid English & Chinese translations", () => {
  const noticeTypes = [
    "公式予告あり",
    "公式告知あり",
    "告知投稿あり",
    "匂わせ投稿あり",
    "予告あり",
    "予告なし",
    "なし",
  ];

  for (const notice of noticeTypes) {
    const enNotice = translateDynamic(notice, "en");
    const zhNotice = translateDynamic(notice, "zh");

    assert.strictEqual(
      JAPANESE_CHAR_REGEX.test(enNotice),
      false,
      `Notice type '${notice}' lacks English translation. Got: "${enNotice}"`
    );
    assert.ok(enNotice.length > 0, `Notice type '${notice}' English translation is empty`);
    assert.ok(zhNotice.length > 0, `Notice type '${notice}' Chinese translation is empty`);
  }
});

test("25M active users reset title has English and Chinese translations", () => {
  const title = "2500万人アクティブユーザー突破記念リセット";

  assert.equal(translateDynamic(title, "ja"), title);
  assert.equal(translateDynamic(title, "en"), "25 Million Active Users Milestone Reset");
  assert.equal(translateDynamic(title, "zh"), "活跃用户突破2500万纪念重置");
});

test("i18n Automated Check: RadarViewModel reasoningSummary contains zero Japanese characters in English locale", () => {
  const radarData = getLocalRadarData();
  const enViewModel = getRadarViewModel(radarData, "en");

  const enSummary = enViewModel.reasoningSummary;
  assert.ok(enSummary);
  assert.strictEqual(
    JAPANESE_CHAR_REGEX.test(enSummary),
    false,
    `RadarViewModel English reasoningSummary contains un-translated Japanese text. Got: "${enSummary}"`
  );

  const zhViewModel = getRadarViewModel(radarData, "zh");
  assert.strictEqual(typeof zhViewModel.reasoningSummary, "string");
});

test("i18n Automated Check: data-state warnings are complete for every locale", () => {
  const warningKeys = [
    "degradedDataWarning",
    "dataUnavailable",
    "lastSuccessfulRefresh",
    "unknownProbability",
    "noticePostedAt",
  ];

  for (const key of warningKeys) {
    const translations = UI_TRANSLATIONS[key];

    for (const locale of ["ja", "en", "zh"] as const) {
      assert.ok(
        translations?.[locale]?.trim(),
        `${key} ${locale} translation is empty`,
      );
    }

    assert.strictEqual(
      JAPANESE_CHAR_REGEX.test(translations.en),
      false,
      `${key} English translation contains Japanese characters. Got: "${translations.en}"`,
    );
  }
});

test("i18n Automated Check: All NOTICE_BACKED_RECOVERY dictionaries have complete English & Chinese translations", async () => {
  const {
    NOTICE_BACKED_RECOVERY_SUMMARIES,
    NOTICE_BACKED_RECOVERY_TITLES,
    NOTICE_BACKED_RECOVERY_FALLBACK_SUMMARY,
    NOTICE_BACKED_RECOVERY_REASON_TYPES,
  } = await import("../lib/radar/tiboHistory");

  // 1. Fallback summary
  const fallbackEn = translateDynamic(NOTICE_BACKED_RECOVERY_FALLBACK_SUMMARY, "en");
  const fallbackZh = translateDynamic(NOTICE_BACKED_RECOVERY_FALLBACK_SUMMARY, "zh");
  assert.strictEqual(
    JAPANESE_CHAR_REGEX.test(fallbackEn),
    false,
    `Fallback summary lacks English translation. Got: "${fallbackEn}"`
  );
  assert.strictEqual(
    JAPANESE_KANA_REGEX.test(fallbackZh),
    false,
    `Fallback summary contains kana in Chinese. Got: "${fallbackZh}"`
  );

  // 2. All notice-backed recovery summaries
  for (const [key, summary] of Object.entries(NOTICE_BACKED_RECOVERY_SUMMARIES)) {
    const en = translateDynamic(summary, "en");
    const zh = translateDynamic(summary, "zh");
    assert.strictEqual(
      JAPANESE_CHAR_REGEX.test(en),
      false,
      `NOTICE_BACKED_RECOVERY_SUMMARIES['${key}'] lacks English translation. Got: "${en}"`
    );
    assert.strictEqual(
      JAPANESE_KANA_REGEX.test(zh),
      false,
      `NOTICE_BACKED_RECOVERY_SUMMARIES['${key}'] contains kana in Chinese. Got: "${zh}"`
    );
  }

  // 3. All notice-backed recovery titles
  for (const [key, title] of Object.entries(NOTICE_BACKED_RECOVERY_TITLES)) {
    const en = translateDynamic(title, "en");
    const zh = translateDynamic(title, "zh");
    assert.strictEqual(
      JAPANESE_CHAR_REGEX.test(en),
      false,
      `NOTICE_BACKED_RECOVERY_TITLES['${key}'] lacks English translation. Got: "${en}"`
    );
    assert.strictEqual(
      JAPANESE_KANA_REGEX.test(zh),
      false,
      `NOTICE_BACKED_RECOVERY_TITLES['${key}'] contains kana in Chinese. Got: "${zh}"`
    );
  }

  // 4. All notice-backed recovery reason types
  for (const [key, reasonType] of Object.entries(NOTICE_BACKED_RECOVERY_REASON_TYPES)) {
    const en = translateDynamic(reasonType, "en");
    const zh = translateDynamic(reasonType, "zh");
    assert.strictEqual(
      JAPANESE_CHAR_REGEX.test(en),
      false,
      `NOTICE_BACKED_RECOVERY_REASON_TYPES['${key}'] lacks English translation. Got: "${en}"`
    );
    assert.strictEqual(
      JAPANESE_KANA_REGEX.test(zh),
      false,
      `NOTICE_BACKED_RECOVERY_REASON_TYPES['${key}'] contains kana in Chinese. Got: "${zh}"`
    );
  }
});

test("i18n Automated Check: Full RadarViewModel history and active window contain zero Japanese in English & Chinese", () => {
  const radarData = getLocalRadarData();

  // Test English ViewModel
  const enVm = getRadarViewModel(radarData, "en");
  for (const item of enVm.recentHistory) {
    if (item.title) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.title),
        false,
        `History item '${item.key}' English title contains Japanese text: "${item.title}"`
      );
    }
    if (item.summary) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.summary),
        false,
        `History item '${item.key}' English summary contains Japanese text: "${item.summary}"`
      );
    }
    if (item.details?.note) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.details.note),
        false,
        `History item '${item.key}' English note contains Japanese text: "${item.details.note}"`
      );
    }
    if (item.details?.cycleType) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.details.cycleType),
        false,
        `History item '${item.key}' English cycleType contains Japanese text: "${item.details.cycleType}"`
      );
    }
    if (item.details?.reasonType) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.details.reasonType),
        false,
        `History item '${item.key}' English reasonType contains Japanese text: "${item.details.reasonType}"`
      );
    }
    if (item.details?.resetMethod) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.details.resetMethod),
        false,
        `History item '${item.key}' English resetMethod contains Japanese text: "${item.details.resetMethod}"`
      );
    }
    if (item.details?.scope) {
      assert.strictEqual(
        JAPANESE_CHAR_REGEX.test(item.details.scope),
        false,
        `History item '${item.key}' English scope contains Japanese text: "${item.details.scope}"`
      );
    }
  }

  // Test Chinese ViewModel
  const zhVm = getRadarViewModel(radarData, "zh");
  for (const item of zhVm.recentHistory) {
    if (item.title) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.title),
        false,
        `History item '${item.key}' Chinese title contains Japanese kana: "${item.title}"`
      );
    }
    if (item.summary) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.summary),
        false,
        `History item '${item.key}' Chinese summary contains Japanese kana: "${item.summary}"`
      );
    }
    if (item.details?.note) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.details.note),
        false,
        `History item '${item.key}' Chinese note contains Japanese kana: "${item.details.note}"`
      );
    }
    if (item.details?.cycleType) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.details.cycleType),
        false,
        `History item '${item.key}' Chinese cycleType contains Japanese kana: "${item.details.cycleType}"`
      );
    }
    if (item.details?.reasonType) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.details.reasonType),
        false,
        `History item '${item.key}' Chinese reasonType contains Japanese kana: "${item.details.reasonType}"`
      );
    }
    if (item.details?.resetMethod) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.details.resetMethod),
        false,
        `History item '${item.key}' Chinese resetMethod contains Japanese kana: "${item.details.resetMethod}"`
      );
    }
    if (item.details?.scope) {
      assert.strictEqual(
        JAPANESE_KANA_REGEX.test(item.details.scope),
        false,
        `History item '${item.key}' Chinese scope contains Japanese kana: "${item.details.scope}"`
      );
    }
  }
});

