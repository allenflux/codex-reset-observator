import assert from "node:assert/strict";
import test from "node:test";
import {
  V2_NAME_MODEL,
  V2_NAME_PROMPT_VERSION,
  V2_NAME_TEMPERATURE,
  buildV2NamePrompt,
  isV2RetryableFailure,
  parseV2NameResponse,
} from "../scripts/evaluate-random-reset-names-v2";

test("v2 experiment 2 prompt is descriptive and source-centered", () => {
  const prompt = buildV2NamePrompt({
    sourcePostText: "To celebrate the launch, I reset the limits for everyone.",
    tweetCreatedAt: "2026-08-01T03:32:00.000Z",
    completedAt: "2026-08-01T03:32:00.000Z",
  });

  assert.equal(V2_NAME_PROMPT_VERSION, "random-reset-name-v2-experiment-2");
  assert.equal(V2_NAME_MODEL, "gemini-3.5-flash-lite");
  assert.equal(V2_NAME_TEMPERATURE, 0.2);
  assert.match(prompt, /To celebrate the launch/);
  assert.match(prompt, /Always end with/);
  assert.match(prompt, /Prefer information that is distinctive/);
  assert.match(prompt, /Do not intentionally make the name humorous/);
  assert.doesNotMatch(prompt, /humorous or strange tone|memorable and readable title|joke, event, situation, or excuse/);
  assert.doesNotMatch(prompt, /manual_name_ja|ai_name_ja|既存表示名|過去に生成/);
});

test("v2 parser accepts only the requested name and reason shape", () => {
  const result = parseV2NameResponse(
    { name: "週末のご祝儀リセット", reason: "週末に向けた利用上限リセットを説明している。" },
    "test-model",
  );

  assert.equal(result.status, "success");
  assert.equal(result.name, "週末のご祝儀リセット");
  assert.equal(result.reason, "週末に向けた利用上限リセットを説明している。");
});

test("v2 parser records technical JSON/schema failures without v1 acceptance gates", () => {
  assert.equal(parseV2NameResponse("not-json", "test-model").status, "invalid_schema");
  assert.equal(
    parseV2NameResponse({ name: "名前だけ" }, "test-model").status,
    "invalid_schema",
  );
  assert.equal(
    parseV2NameResponse({ name: "名前", reason: "理由" }, "test-model").status,
    "success",
  );
});

test("v2 retries only rate limits and temporary failures", () => {
  assert.equal(isV2RetryableFailure("rate_limited", 429), true);
  assert.equal(isV2RetryableFailure("api_error", 503), true);
  assert.equal(isV2RetryableFailure("timeout", null), true);
  assert.equal(isV2RetryableFailure("api_error", 400), false);
  assert.equal(isV2RetryableFailure("invalid_json", 200), false);
});
