import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetDisplayNameCandidatePrompt,
  generateResetDisplayNameCandidate,
  type ResetDisplayNameCandidateNamingInput,
} from "../lib/radar/resetDisplayNameCandidateNaming";
import {
  generateRandomResetNameFromPrompt,
  RANDOM_RESET_NAME_PROMPT_VERSION,
  RANDOM_RESET_NAME_TEMPERATURE,
  RANDOM_RESET_NAME_V3_SYSTEM_PROMPT,
} from "../lib/radar/randomResetNaming";

function candidateInput(): ResetDisplayNameCandidateNamingInput {
  return {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeObservedAt: "2026-09-08T00:00:00.000Z",
    expectedStartAt: "2026-09-08T01:00:00.000Z",
    expectedEndAt: "2026-09-08T03:00:00.000Z",
    temporalPrecision: "hour",
    scope: "all paid plans",
    noticeType: "official_notice",
    sourceUrl: "https://x.com/tibo/status/notice-1",
    sourcePostText: "A reset is planned for the weekend.",
    sourceContext: "The announcement is still pending.",
  };
}

function mockGeminiResponse() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      nameJa: "GPT-99リセット",
      nameEn: "GPT-99 Reset",
      nameZh: "GPT-99重置",
      reason: "test",
    }) }] } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("candidate prompt describes a notice and never a completed event", () => {
  const prompt = buildResetDisplayNameCandidatePrompt(candidateInput());

  assert.match(prompt, /notice observed at/i);
  assert.match(prompt, /expected reset end/i);
  assert.doesNotMatch(prompt, /reset completed at/i);
  assert.doesNotMatch(prompt, /completedAt/i);
});

test("candidate adapter uses the shared V3 transport and notice prompt", async () => {
  const originalFetch = globalThis.fetch;
  let requestJson: string | null = null;
  globalThis.fetch = async (_input, init) => {
    requestJson = String(init?.body);
    return mockGeminiResponse();
  };

  try {
    const result = await generateResetDisplayNameCandidate(candidateInput(), {
      apiKey: "test-key",
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "success");
    assert.equal(result.promptVersion, RANDOM_RESET_NAME_PROMPT_VERSION);
    assert.equal(result.nameEn, "GPT-99 Reset");
    assert.deepEqual(result.flags, ["unprovided_named_token", "unprovided_number"]);

    const capturedRequest = JSON.parse(requestJson ?? "{}") as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
      generationConfig?: { temperature?: number };
    };
    assert.equal(capturedRequest.contents?.[0]?.parts?.[0]?.text, RANDOM_RESET_NAME_V3_SYSTEM_PROMPT);
    assert.match(capturedRequest.contents?.[0]?.parts?.[1]?.text ?? "", /notice observed at/i);
    assert.doesNotMatch(capturedRequest.contents?.[0]?.parts?.[1]?.text ?? "", /completedAt/i);
    assert.equal(capturedRequest.generationConfig?.temperature, RANDOM_RESET_NAME_TEMPERATURE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prompt-based V3 generation preserves named-token and number safety flags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => mockGeminiResponse();

  try {
    const result = await generateRandomResetNameFromPrompt(
      "notice prompt",
      { sourcePostText: "GPT-99 reset is planned", evidenceValues: [] },
      { apiKey: "test-key", timeoutMs: 1_000 },
    );

    assert.deepEqual(result.flags, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
