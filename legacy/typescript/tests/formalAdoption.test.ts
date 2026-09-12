import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormalAdoptionResult,
  hasExistingFormalResetCluster,
  isNewFormalAdoption,
} from "../lib/radar/formalAdoption";
import { isFormalTiboResetSignal } from "../lib/radar/tiboHistory";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";

function candidate(overrides: Partial<FormalTiboResetSignal> = {}): FormalTiboResetSignal {
  return {
    tweet_id: "2084000000000000100",
    text: "I reset usage limits for Codex.",
    tweet_url: "https://x.com/thsottiaux/status/2084000000000000100",
    tweet_created_at: "2026-08-04T00:00:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    ...overrides,
  };
}

test("new formal Tibo reset is adopted once", () => {
  const signal = candidate();
  assert.equal(isNewFormalAdoption(signal, null), true);
  assert.equal(isNewFormalAdoption(signal, signal), false);
  assert.equal(
    isNewFormalAdoption(signal, { ...signal, verification_status: "confirmed" }),
    false,
  );
});
test("formal adoption rejects ineligible or unavailable candidates", () => {
  assert.equal(
    isNewFormalAdoption(candidate({ signal_type: "teaser" }), null),
    false,
  );
  assert.equal(
    isNewFormalAdoption(candidate({ confidence: 0.94 }), null),
    false,
  );
  assert.equal(isNewFormalAdoption(candidate(), null, false), false);
  assert.equal(
    isNewFormalAdoption(candidate({ is_reply: true }), null),
    false,
  );
  assert.equal(
    isNewFormalAdoption(
      candidate({ tweet_id: "2083395449814229287", tweet_url: "https://x.com/thsottiaux/status/2083395449814229287" }),
      null,
    ),
    false,
  );
});

test("BANKED completion is not eligible for generic formal adoption", () => {
  const bankedCompletion = candidate({
    text: "The banked reset has landed, I repeat, the banked reset has landed.",
  });

  assert.equal(isFormalTiboResetSignal(bankedCompletion), false);
  assert.equal(isNewFormalAdoption(bankedCompletion, null), false);
  assert.equal(
    isFormalTiboResetSignal(candidate({
      text: "The usage limits have been reset for all paid users of Codex.",
    })),
    true,
  );
});

test("a nearby formal reset in the same five-minute cluster suppresses a second adoption", () => {
  const first = candidate({
    tweet_id: "first-reset",
    tweet_url: "https://x.com/thsottiaux/status/first-reset",
    tweet_created_at: "2026-08-11T00:27:44.000Z",
  });
  const second = candidate({
    tweet_id: "second-reset",
    tweet_url: "https://x.com/thsottiaux/status/second-reset",
    tweet_created_at: "2026-08-11T00:28:16.000Z",
  });

  assert.equal(hasExistingFormalResetCluster(second, [first]), true);
  assert.equal(hasExistingFormalResetCluster(second, [
    candidate({
      tweet_id: "later-reset",
      tweet_url: "https://x.com/thsottiaux/status/later-reset",
      tweet_created_at: "2026-08-11T00:34:00.000Z",
    }),
  ]), false);
});

test("formal adoption response contains only display-safe adoption fields", () => {
  const result = buildFormalAdoptionResult(true, candidate());
  assert.deepEqual(result, {
    newlyAdopted: true,
    tweetId: "2084000000000000100",
    title: "ランダムリセット",
    confidence: 0.98,
    sourceUrl: "https://x.com/thsottiaux/status/2084000000000000100",
  });
  assert.equal("text" in result, false);
  assert.equal("classification_reason" in result, false);
});
