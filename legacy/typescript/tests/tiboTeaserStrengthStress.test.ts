import assert from "node:assert/strict";
import test from "node:test";

import { STRESS_CASES } from "../scripts/evaluate-tibo-teaser-strength-stress";
import { buildPrompt, SYSTEM_PROMPT } from "../scripts/evaluate-tibo-teaser-strength";

test("stress dataset has separate ordinary and reply-context cases", () => {
  assert.equal(STRESS_CASES.length, 32);
  assert.equal(STRESS_CASES.filter((post) => !post.replyContext).length, 26);
  assert.equal(STRESS_CASES.filter((post) => post.replyContext).length, 6);
  assert.deepEqual(
    STRESS_CASES.reduce<Record<string, number>>((counts, post) => {
      counts[post.expected] = (counts[post.expected] ?? 0) + 1;
      return counts;
    }, {}),
    { strong: 7, weak: 10, none: 15 },
  );
});

test("stress expected labels are not included in the Gemini prompt", () => {
  const ordinaryPrompt = buildPrompt(STRESS_CASES[0]);
  const replyPrompt = buildPrompt(STRESS_CASES.find((post) => post.tweetId === "R1")!);
  assert.doesNotMatch(ordinaryPrompt, /expected|strong|weak|none/i);
  assert.doesNotMatch(replyPrompt, /expected|strong|weak|none/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /S1|W1|N1|R1/);
  assert.match(replyPrompt, /Parent post text/);
  assert.match(replyPrompt, /Any chance of a Codex reset today/);
  assert.match(replyPrompt, /Great repro/);
});
