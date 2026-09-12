import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTiboSecondaryManualOverride,
  getEffectiveTiboSecondarySignal,
  setTiboSecondaryManualOverride,
  expandTiboSignalVariants,
  type TiboSecondarySignal,
} from "../lib/radar/tiboSecondarySignal";
import { preserveTiboWebhookState } from "../lib/radar/tiboWebhookState";

const reviewedAt = "2026-08-24T10:00:00.000Z";

function aiSignal(
  signalType: TiboSecondarySignal["signalType"] = "none",
  teaserStrength: TiboSecondarySignal["teaserStrength"] = null,
): TiboSecondarySignal {
  return {
    signalType,
    teaserStrength,
    confidence: 1,
    evidenceQuote: signalType === "none" ? null : "tomorrow",
    reasonJa: "AI判定",
  };
}

function manualOverride(teaserStrength: "strong" | "weak") {
  return {
    signalType: "teaser" as const,
    teaserStrength,
    reasonJa: "手動確認: 完了済みreset後の次回resetを示すsecondary teaserとして修正。",
    reviewedAt,
  };
}

test("AI none can be manually overridden to a weak secondary teaser", () => {
  const stored = setTiboSecondaryManualOverride(aiSignal(), manualOverride("weak"));

  assert.equal(stored?.signalType, "none");
  assert.equal(stored?.teaserStrength, null);
  assert.equal(stored?.manualOverride?.source, "manual");
  assert.equal(getEffectiveTiboSecondarySignal(stored)?.signalType, "teaser");
  assert.equal(getEffectiveTiboSecondarySignal(stored)?.teaserStrength, "weak");
});

test("manual secondary override wins over an AI strong result without changing raw AI fields", () => {
  const stored = setTiboSecondaryManualOverride(
    aiSignal("teaser", "strong"),
    manualOverride("weak"),
  );

  assert.equal(stored?.signalType, "teaser");
  assert.equal(stored?.teaserStrength, "strong");
  assert.equal(stored?.manualOverride?.teaserStrength, "weak");
  assert.equal(getEffectiveTiboSecondarySignal(stored)?.teaserStrength, "weak");
});

test("manual secondary override can choose strong without changing the AI none result", () => {
  const stored = setTiboSecondaryManualOverride(aiSignal(), manualOverride("strong"));

  assert.equal(stored?.signalType, "none");
  assert.equal(stored?.teaserStrength, null);
  assert.equal(getEffectiveTiboSecondarySignal(stored)?.signalType, "teaser");
  assert.equal(getEffectiveTiboSecondarySignal(stored)?.teaserStrength, "strong");
});

test("secondary manual override rejects official notice and invalid strength", () => {
  assert.throws(() => setTiboSecondaryManualOverride(aiSignal(), {
    signalType: "official_notice",
    teaserStrength: null,
    reasonJa: "手動確認",
    reviewedAt,
  } as never));
  assert.throws(() => setTiboSecondaryManualOverride(aiSignal(), {
    signalType: "teaser",
    teaserStrength: null,
    reasonJa: "手動確認",
    reviewedAt,
  } as never));
});

test("clearing a secondary manual override restores the AI result", () => {
  const stored = setTiboSecondaryManualOverride(aiSignal(), manualOverride("weak"));
  const cleared = clearTiboSecondaryManualOverride(stored);

  assert.equal(cleared?.manualOverride, null);
  assert.equal(getEffectiveTiboSecondarySignal(cleared)?.signalType, "none");
  assert.equal(getEffectiveTiboSecondarySignal(cleared)?.teaserStrength, null);
});

test("webhook reclassification preserves the secondary-only manual override", () => {
  const existing = {
    secondary_signal: setTiboSecondaryManualOverride(aiSignal(), manualOverride("weak")),
  };
  const result = preserveTiboWebhookState({
    tweet_id: "2091688655828246890",
    detected_at: reviewedAt,
    verification_status: "auto_unverified" as const,
    secondary_signal: aiSignal("teaser", "strong"),
  }, existing, reviewedAt);

  assert.equal(result.secondary_signal?.signalType, "teaser");
  assert.equal(result.secondary_signal?.teaserStrength, "strong");
  assert.equal(result.secondary_signal?.manualOverride?.teaserStrength, "weak");
  assert.equal(getEffectiveTiboSecondarySignal(result.secondary_signal)?.teaserStrength, "weak");
});

test("a later AI none result cannot erase a secondary-only manual override", () => {
  const existing = {
    secondary_signal: setTiboSecondaryManualOverride(aiSignal(), manualOverride("weak")),
  };
  const result = preserveTiboWebhookState({
    tweet_id: "2091688655828246890",
    detected_at: reviewedAt,
    verification_status: "auto_unverified" as const,
    secondary_signal: null,
  }, existing, reviewedAt);
  const stored = result as { secondary_signal?: TiboSecondarySignal | null };

  assert.equal(stored.secondary_signal?.signalType, "none");
  assert.equal(stored.secondary_signal?.manualOverride?.teaserStrength, "weak");
  assert.equal(getEffectiveTiboSecondarySignal(stored.secondary_signal)?.teaserStrength, "weak");
});

test("manual secondary override is applied only to the virtual projection", () => {
  const parent = {
    tweet_id: "2091688655828246890",
    tweet_created_at: "2026-08-23T23:37:43.201Z",
    signal_type: "reset_executed",
    secondary_signal: setTiboSecondaryManualOverride(aiSignal(), manualOverride("weak")),
  };
  const projected = expandTiboSignalVariants([parent]);
  const secondaryProjection = projected[1] as typeof projected[number] & Record<string, unknown>;

  assert.deepEqual(projected.map((signal) => signal.tweet_id), [
    "2091688655828246890",
    "2091688655828246890#secondary",
  ]);
  assert.equal(projected[0].secondary_signal?.signalType, "none");
  assert.equal(projected[0].secondary_signal?.manualOverride?.teaserStrength, "weak");
  assert.equal(secondaryProjection.signal_type, "teaser");
  assert.equal(secondaryProjection.teaser_strength, "weak");
  assert.equal(secondaryProjection.ai_teaser_strength, null);
});
