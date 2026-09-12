import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import {
  getActiveOfficialNotice,
  getLocalProbabilityCalculation,
  getLocalResetProbability,
} from "../lib/radar/probability";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  expandTiboSignalVariants,
  setTiboSecondaryManualOverride,
} from "../lib/radar/tiboSecondarySignal";
import type { ActiveTiboSignal } from "../lib/radar/types";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";

const NOW = new Date("2026-08-24T09:10:00.000Z");

type SecondarySignal = NonNullable<ActiveTiboSignal["secondary_signal"]>;

function completedPost(
  id: string,
  text: string,
  secondarySignal: SecondarySignal | null,
  createdAt = "2026-08-24T09:00:00.000Z",
): ActiveTiboSignal {
  return {
    tweet_id: id,
    text,
    tweet_url: `https://x.com/thsottiaux/status/${id}`,
    tweet_created_at: createdAt,
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    expires_at: "2026-08-25T09:00:00.000Z",
    secondary_signal: secondarySignal,
  };
}

function futureSignal(
  signalType: "official_notice" | "teaser" | "none",
  options: Partial<SecondarySignal> = {},
): SecondarySignal {
  return {
    signalType,
    teaserStrength: signalType === "teaser" ? "strong" : null,
    confidence: 0.96,
    evidenceQuote: "tomorrow",
    reasonJa: "次のリセットに関する将来シグナルです。",
    ...options,
  };
}

test("projects a secondary signal with a stable virtual id without deduping the primary", () => {
  const parent = completedPost(
    "composite-parent",
    "Reset is done. Might press the reset button again tomorrow.",
    futureSignal("teaser", {
      teaserStrength: "strong",
      evidenceQuote: "Might press the reset button again tomorrow",
    }),
  );

  const projected = expandTiboSignalVariants([parent]);
  assert.deepEqual(projected.map((signal) => signal.tweet_id), [
    "composite-parent",
    "composite-parent#secondary",
  ]);
  assert.equal(projected[0].signal_type, "reset_executed");
  assert.equal(projected[1].signal_type, "teaser");
  assert.equal(projected[1].parent_tweet_id, "composite-parent");
  assert.equal(projected[1].is_secondary_future_signal, true);
});

test("completed reset plus a secondary official notice remains active at the same timestamp", () => {
  const parent = completedPost(
    "composite-official",
    "Reset is done. We will reset everyone again tomorrow.",
    futureSignal("official_notice", {
      teaserStrength: null,
      confidence: 0.99,
      evidenceQuote: "We will reset everyone again tomorrow",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
    formalTiboResets: [parent as unknown as FormalTiboResetSignal],
  });

  const notice = getActiveOfficialNotice(data, null, NOW);
  assert.equal(notice?.id, "composite-official#secondary");
  assert.equal(getLocalResetProbability(data, "24h", undefined, notice, NOW), 0.9);
  assert.equal(getLocalResetProbability(data, "48h", undefined, notice, NOW), 0.96);

  const activity = toPublicRadarSnapshot(data, "en", { calculationNow: NOW }).latestTiboActivity;
  assert.equal(activity?.classification, "official_notice");
  assert.equal(activity?.text, parent.text);
  assert.equal(activity?.createdAt, parent.tweet_created_at);
  assert.equal(activity?.sourceUrl, parent.tweet_url);
  assert.equal("tweet_id" in (activity ?? {}), false);
  assert.doesNotMatch(JSON.stringify(activity), /#secondary/);
});

test("completed reset plus a secondary strong teaser remains in the next cycle", () => {
  const parent = completedPost(
    "composite-strong",
    "Reset is done. Might press the reset button again tomorrow.",
    futureSignal("teaser", {
      teaserStrength: "strong",
      evidenceQuote: "Might press the reset button again tomorrow",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
  });

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  assert.equal(snapshot.resetTeaserStatus, "strong");
  assert.deepEqual(snapshot.latestTiboActivity, {
    classification: "teaser",
    teaserStrength: "strong",
    text: parent.text,
    createdAt: parent.tweet_created_at,
    sourceUrl: parent.tweet_url,
    isReply: false,
    replyContextText: null,
    replyToHandles: [],
  });
  assert.doesNotMatch(JSON.stringify(snapshot.latestTiboActivity), /#secondary|tweet_id/);
});

test("completed reset plus a secondary weak teaser is independently aggregated", () => {
  const parent = completedPost(
    "composite-weak",
    "Reset is done. Maybe another surprise tomorrow.",
    futureSignal("teaser", {
      teaserStrength: "weak",
      evidenceQuote: "Maybe another surprise tomorrow",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
  });

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  assert.equal(snapshot.resetTeaserStatus, "weak");
  assert.deepEqual(snapshot.latestTiboActivity, {
    classification: "teaser",
    teaserStrength: "weak",
    text: parent.text,
    createdAt: parent.tweet_created_at,
    sourceUrl: parent.tweet_url,
    isReply: false,
    replyContextText: null,
    replyToHandles: [],
  });
  assert.doesNotMatch(JSON.stringify(snapshot.latestTiboActivity), /#secondary|tweet_id/);
});

test("a newer unrelated post does not displace a related secondary teaser", () => {
  const parent = completedPost(
    "composite-with-newer-unrelated",
    "Reset is done. Maybe another surprise tomorrow.",
    futureSignal("teaser", {
      teaserStrength: "weak",
      evidenceQuote: "Maybe another surprise tomorrow",
    }),
    "2026-08-24T09:00:00.000Z",
  );
  const newerUnrelated: ActiveTiboSignal = {
    tweet_id: "newer-unrelated",
    text: "A newer post unrelated to resets.",
    tweet_url: "https://x.com/thsottiaux/status/newer-unrelated",
    tweet_created_at: "2026-08-24T09:05:00.000Z",
    signal_type: "irrelevant",
    confidence: 0.99,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    expires_at: "2026-08-25T09:05:00.000Z",
  };
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent, newerUnrelated],
    recentTiboSignals: [parent, newerUnrelated],
  });

  const activity = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW }).latestTiboActivity;
  assert.equal(activity?.classification, "teaser");
  assert.equal(activity?.teaserStrength, "weak");
  assert.equal(activity?.text, parent.text);
  assert.equal(activity?.sourceUrl, parent.tweet_url);
});

test("an unrelated future continuation on the real composite post has no reset secondary signal", () => {
  const text = "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.";
  const parent = completedPost(
    "2091688655828246890",
    text,
    futureSignal("none", {
      teaserStrength: null,
      confidence: 0.91,
      evidenceQuote: "More to come tomorrow",
      reasonJa: "追加内容を示すだけで、次回リセットの予告とは断定できません。",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
  });

  assert.equal(getActiveOfficialNotice(data, null, NOW), null);
  assert.equal(toPublicRadarSnapshot(data, "ja", { calculationNow: NOW }).resetTeaserStatus, "none");
});

test("the real composite post can use a manual weak secondary override without an official notice", () => {
  const text = "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.";
  const aiSecondary = futureSignal("none", {
    confidence: 1,
    evidenceQuote: null,
    reasonJa: "翌日の追加更新であり、次回リセットの予告ではありません。",
  });
  const parent = completedPost(
    "2091688655828246890",
    text,
    setTiboSecondaryManualOverride(aiSecondary, {
      signalType: "teaser",
      teaserStrength: "weak",
      reasonJa: "手動確認: 完了済みreset後の次回resetを弱く示唆するsecondary teaserとして補正。",
      reviewedAt: "2026-08-24T10:00:00.000Z",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
  });

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  const calculation = getLocalProbabilityCalculation(data, { now: NOW });

  assert.equal(snapshot.resetTeaserStatus, "weak");
  assert.equal(getActiveOfficialNotice(data, null, NOW), null);
  assert.equal(calculation.inputSnapshot.activeTeaserCount, 1);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability24h > 0);
  assert.ok(calculation.breakdown.contributions.teaserOrEvent.probability48h > 0);
  assert.equal(parent.secondary_signal?.signalType, "none");
  assert.equal(parent.secondary_signal?.teaserStrength, null);
  assert.equal(parent.secondary_signal?.manualOverride?.teaserStrength, "weak");
});

test("a secondary signal at the same time as a Tibo-only reset is not consumed by timestamp alone", () => {
  const parent = completedPost(
    "legacy-composite",
    "Reset is done. Might press the reset button again tomorrow.",
    futureSignal("teaser", {
      teaserStrength: "strong",
      evidenceQuote: "Might press the reset button again tomorrow",
    }),
  );
  const data = getLocalRadarData({
    calculationNow: NOW,
    activeTiboSignals: [parent],
    recentTiboSignals: [parent],
    formalTiboResets: [parent as unknown as FormalTiboResetSignal],
  });

  const snapshot = toPublicRadarSnapshot(data, "ja", { calculationNow: NOW });
  assert.equal(snapshot.lastRandomResetAt, "2026-08-24T09:00:00.000Z");
  assert.equal(snapshot.resetTeaserStatus, "strong");
});
