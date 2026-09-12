import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLocalRadarData, getRadarViewModel } from "@/lib/radar";
import {
  convertTiboResetSignalToHistoryEvent,
} from "@/lib/radar/tiboHistory";
import {
  normalizeResetReasonType,
  RESET_REASON_TYPES,
} from "@/lib/radar/resetReason";

const calculationNow = new Date("2026-08-14T00:00:00.000Z");

describe("canonical reset reason taxonomy", () => {
  it("exposes exactly the three public reason values", () => {
    assert.deepEqual(RESET_REASON_TYPES, [
      "ご祝儀リセット",
      "詫びリセット",
      "定期更新",
    ]);
  });

  it("does not publish legacy random or other values", () => {
    assert.equal(
      normalizeResetReasonType({ reasonType: "ランダムリセット" }),
      "ご祝儀リセット",
    );
    assert.equal(
      normalizeResetReasonType({ reasonType: "その他" }),
      "ご祝儀リセット",
    );
  });

  it("maps the legacy regular label to 定期更新", () => {
    assert.equal(
      normalizeResetReasonType({
        details: { cycleType: "定期リセット", reasonType: "通常更新" },
      }),
      "定期更新",
    );
  });

  it("requires explicit compensation evidence for 詫びリセット", () => {
    assert.equal(
      normalizeResetReasonType({
        summary: "障害復旧対応として利用上限をリセットしました。",
      }),
      "詫びリセット",
    );
    assert.equal(
      normalizeResetReasonType({ title: "Happy Monday reset" }),
      "ご祝儀リセット",
    );
  });

  it("keeps cycleType separate from the reason for the Monday reset post", () => {
    const event = convertTiboResetSignalToHistoryEvent({
      tweet_id: "2086972933566857393",
      text: "Usage limits have been reset for all paid ChatGPT Work and Codex users. Happy Monday you all. Hope it is a fantastic week.",
      tweet_url: "https://x.com/thsottiaux/status/2086972933566857393",
      tweet_created_at: "2026-08-11T00:00:00.000Z",
      signal_type: "reset_executed",
      confidence: 0.99,
      verification_status: "confirmed",
      classification_source: "gemini",
      ai_reset_type_ja: "ランダムリセット",
    });

    assert.equal(event.details?.cycleType, "ランダムリセット");
    assert.equal(event.details?.reasonType, "ご祝儀リセット");
    assert.equal(event.details?.resetMethod, "強制リセット");
  });

  it("keeps the canonical reason aligned in JA, EN, and ZH history", () => {
    const tweetId = "2086972933566857393";
    const data = getLocalRadarData({
      calculationNow,
      formalTiboResets: [{
        tweet_id: tweetId,
        text: "Usage limits have been reset for all paid ChatGPT Work and Codex users. Happy Monday you all. Hope it is a fantastic week.",
        tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
        tweet_created_at: "2026-08-11T00:00:00.000Z",
        signal_type: "reset_executed",
        confidence: 0.99,
        verification_status: "confirmed",
        classification_source: "gemini",
        ai_reset_type_ja: "ランダムリセット",
      }],
    });

    const expected = {
      ja: "ご祝儀リセット",
      en: "Celebration reset",
      zh: "庆祝重置",
    } as const;

    for (const locale of ["ja", "en", "zh"] as const) {
      const history = getRadarViewModel(data, locale, true, undefined, calculationNow)
        .recentHistory
        .find((item) => item.key === `tibo-reset-${tweetId}`);
      assert.ok(history, `expected history in ${locale}`);
      assert.equal(history.resetType, expected[locale]);
      assert.equal(history.details?.reasonType, expected[locale]);
    }
  });

  it("keeps every combined local history reason inside the canonical set", () => {
    const data = getLocalRadarData({ calculationNow });
    const history = getRadarViewModel(data, "ja", false, undefined, calculationNow).recentHistory;
    const allowed = new Set(RESET_REASON_TYPES);

    assert.ok(history.length > 0);
    for (const item of history) {
      if (item.details) {
        assert.ok(
          allowed.has(item.details.reasonType as (typeof RESET_REASON_TYPES)[number]),
          item.key,
        );
      }
    }
  });
});
