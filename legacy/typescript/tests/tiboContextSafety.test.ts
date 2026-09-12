import assert from "node:assert/strict";
import test from "node:test";

import { getTiboContextSafetyDecision } from "../lib/radar/tiboContextSafety";
import { getEffectiveTeaserStrength } from "../lib/radar/teaserStrength";

const baseInput = {
  authorText: "me receiving this very important item",
  selectedSignalType: "teaser" as const,
  aiTeaserStrength: "strong" as const,
};

test("item receipt without reset context is suppressed and keeps an auditable reason", () => {
  const decision = getTiboContextSafetyDecision({
    ...baseInput,
    replyContextText: "haven't used it yet, but I'll take a look. Codex for scale.",
  });

  assert.deepEqual(decision, {
    signalType: "irrelevant",
    teaserStrength: "none",
    reasonJa: "Context safety guard: 物品の受領を示す投稿ですが、本文・返信元・引用文脈に利用枠リセットの明示的な根拠がないため、無関係として扱います。",
  });
});

test("a direct reset-button acquisition remains positive", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      ...baseInput,
      authorText: "I was gifted a very fancy new reset button today",
    }),
    null,
  );
});

test("explicit reset context in the parent preserves the positive result", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      ...baseInput,
      replyContextText: "Here is your new reset button",
    }),
    null,
  );
});

test("Codex alone does not count as reset context", () => {
  const decision = getTiboContextSafetyDecision({
    ...baseInput,
    replyContextText: "Codex for scale",
  });

  assert.equal(decision?.signalType, "irrelevant");
  assert.equal(decision?.teaserStrength, "none");
});

test("explicit reset context in a quote preserves the positive result", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      ...baseInput,
      quoteContextText: "This is your new reset button",
    }),
    null,
  );
});

test("an irrelevant result with an AI weak strength is also suppressed", () => {
  const decision = getTiboContextSafetyDecision({
    ...baseInput,
    selectedSignalType: "irrelevant",
    aiTeaserStrength: "weak",
  });

  assert.equal(decision?.signalType, "irrelevant");
  assert.equal(decision?.teaserStrength, "none");
  assert.equal(
    getEffectiveTeaserStrength({
      teaser_strength: decision?.teaserStrength,
      ai_teaser_strength: "strong",
    }),
    "none",
  );
});

test("physical-item showcase language is suppressed without reset context", () => {
  const decision = getTiboContextSafetyDecision({
    authorText: "It has not been used yet, but would you look at that. Codex for scale.",
    selectedSignalType: "teaser",
    aiTeaserStrength: "strong",
  });

  assert.equal(decision?.signalType, "irrelevant");
  assert.equal(decision?.teaserStrength, "none");
});

test("physical-item showcase remains positive with explicit reset context", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "It has not been used yet, but would you look at that. Codex for scale.",
      replyContextText: "Here is your new reset button",
      selectedSignalType: "teaser",
      aiTeaserStrength: "strong",
    }),
    null,
  );
});

test("showcase cues do not suppress a direct reset-button acquisition", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "I was gifted a very fancy new reset button today",
      selectedSignalType: "teaser",
      aiTeaserStrength: "strong",
    }),
    null,
  );
});

test("ambiguous future surprise downgrades an official notice to a strong teaser", () => {
  const decision = getTiboContextSafetyDecision({
    authorText: "I previously promised a reset for every 1M in additional active users for Codex, until 10M. We blew past that and have been silent since 10M. Little surprise for you tomorrow.",
    selectedSignalType: "official_notice",
    aiTeaserStrength: "strong",
  });

  assert.equal(decision?.signalType, "teaser");
  assert.equal(decision?.teaserStrength, "strong");
});

test("explicit future reset notices remain official", () => {
  for (const authorText of [
    "I'll do another performative reset on Monday",
    "Enjoy a nice reset everyone. Landing in the next hour or so",
  ]) {
    assert.equal(
      getTiboContextSafetyDecision({
        authorText,
        selectedSignalType: "official_notice",
        aiTeaserStrength: "strong",
      }),
      null,
      authorText,
    );
  }
});

test("an upcoming Codex update does not promote an irrelevant none result", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "Tomorrow we will bring back the 5h limit for Plus accounts across ChatGPT Work and Codex.",
      selectedSignalType: "irrelevant",
      aiTeaserStrength: "none",
    }),
    null,
  );
});

test("an update-only post does not create a context-safety decision", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "Tomorrow we will bring back the 5h limit for Plus accounts across ChatGPT Work and Codex.",
      selectedSignalType: "official_notice",
      aiTeaserStrength: "strong",
    }),
    null,
  );
});

test("a future Codex product update does not promote an irrelevant none result", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "Next week we'll be retiring GPT-5.3-Codex-Spark from ChatGPT Work.",
      selectedSignalType: "irrelevant",
      aiTeaserStrength: "none",
    }),
    null,
  );
});

test("a generic documentation update remains outside the teaser signal", () => {
  const decision = getTiboContextSafetyDecision({
    authorText: "Documentation update tomorrow.",
    selectedSignalType: "irrelevant",
    aiTeaserStrength: "none",
  });

  assert.equal(decision, null);
});

test("a person-targeted reset is irrelevant even when AI strength is weak", () => {
  const decision = getTiboContextSafetyDecision({
    authorText: "I feel Theo is in need of a reset",
    selectedSignalType: "irrelevant",
    aiTeaserStrength: "weak",
  });

  assert.equal(decision?.signalType, "irrelevant");
  assert.equal(decision?.teaserStrength, "none");
});

test("historical reset-button retrospectives are not active teasers", () => {
  const decision = getTiboContextSafetyDecision({
    authorText: "One day we created the reset button and the rest is history.",
    selectedSignalType: "teaser",
    aiTeaserStrength: "weak",
  });

  assert.equal(decision?.signalType, "irrelevant");
  assert.equal(decision?.teaserStrength, "none");
});

test("historical reset context with an independent future reset intent remains positive", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "One day we created the reset button. Tomorrow I'll use it to reset the limits.",
      selectedSignalType: "teaser",
      aiTeaserStrength: "strong",
    }),
    null,
  );
});

test("isolated showcase phrases do not trigger the physical-item guard", () => {
  for (const authorText of [
    "It has not been used yet.",
    "Would you look at that.",
    "Codex for scale.",
  ]) {
    assert.equal(
      getTiboContextSafetyDecision({
        authorText,
        selectedSignalType: "teaser",
        aiTeaserStrength: "strong",
      }),
      null,
      authorText,
    );
  }
});


test("future reuse of a historically framed reset button does not promote an irrelevant none result", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "A good thing about having aged is that I feel that it’s been 20 years since I’ve pressed the reset button. Intrigued to see if I can find it tomorrow and dust it up",
      selectedSignalType: "irrelevant",
      aiTeaserStrength: "none",
    }),
    null,
  );
});

test("historical reset-button text plus an unrelated tomorrow does not get rescued", () => {
  assert.equal(
    getTiboContextSafetyDecision({
      authorText: "It has been 20 years since I pressed the reset button. Tomorrow I am going hiking.",
      selectedSignalType: "irrelevant",
      aiTeaserStrength: "none",
    }),
    null,
  );
});

test("historical and obvious non-usage reset-button contexts remain unpromoted", () => {
  for (const authorText of [
    "It has been years since I pressed the reset button. I might find it tomorrow and dust it up.",
    "My laptop reset button is ancient. I might find it tomorrow and dust it up.",
    "It has been years since I pressed the reset button. I cannot find it tomorrow.",
  ]) {
    assert.equal(
      getTiboContextSafetyDecision({
        authorText,
        selectedSignalType: "irrelevant",
        aiTeaserStrength: "none",
      }),
      null,
      authorText,
    );
  }
});

test("an irrelevant none result is never promoted by context safety alone", () => {
  for (const authorText of [
    "Next week we'll be retiring GPT-5.3-Codex-Spark from ChatGPT Work.",
    "Tomorrow we will bring back the 5h limit for Plus accounts across ChatGPT Work and Codex.",
    "It has been 20 years since I pressed the reset button. I might find it tomorrow and dust it up.",
  ]) {
    const decision = getTiboContextSafetyDecision({
      authorText,
      selectedSignalType: "irrelevant",
      aiTeaserStrength: "none",
    });

    assert.equal(decision, null, authorText);
  }
});
