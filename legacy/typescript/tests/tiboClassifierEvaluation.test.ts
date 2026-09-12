import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeEvaluationRows,
  REQUIRED_RESUME_GEMINI_MODEL,
  isAllowedResumeGeminiModel,
  shouldStopAfterStatus,
  selectRowsForResume,
  shouldWriteResumeReport,
} from "../scripts/evaluate-tibo-classifiers";

test("resume accepts only the explicitly approved Gemini model", () => {
  assert.equal(REQUIRED_RESUME_GEMINI_MODEL, "gemini-3.5-flash-lite");
  assert.equal(isAllowedResumeGeminiModel("gemini-3.5-flash-lite"), true);
  assert.equal(isAllowedResumeGeminiModel("gemini-flash-latest"), false);
  assert.equal(isAllowedResumeGeminiModel(undefined), false);
});

test("resume selects only rows whose Gemini status is not success", () => {
  const rows = [
    { tweetId: "success", geminiStatus: "success" as const },
    { tweetId: "rate-limited", geminiStatus: "rate_limited" as const },
    { tweetId: "api-error", geminiStatus: "api_error" as const },
  ];

  assert.deepEqual(selectRowsForResume(rows), [rows[1], rows[2]]);
});

test("resume stops immediately after the first rate-limited response", () => {
  assert.equal(shouldStopAfterStatus("rate_limited"), true);
  assert.equal(shouldStopAfterStatus("api_error"), false);
  assert.equal(shouldStopAfterStatus("success"), false);
});

test("checkpoint merge preserves successful rows and replaces only the current failed row", () => {
  const successful = { tweetId: "success", geminiStatus: "success" as const, value: "original" };
  const failed = { tweetId: "failed", geminiStatus: "rate_limited" as const, value: "old" };
  const retried = { tweetId: "failed", geminiStatus: "success" as const, value: "new" };

  assert.deepEqual(mergeEvaluationRows([successful, failed], retried), [successful, retried]);
});

test("resume report is written only after every input row has a successful Gemini result", () => {
  assert.equal(
    shouldWriteResumeReport([
      { geminiStatus: "success" as const },
      { geminiStatus: "success" as const },
    ],
    2),
    true
  );
  assert.equal(
    shouldWriteResumeReport([
      { geminiStatus: "success" as const },
      { geminiStatus: "api_error" as const },
    ],
    2),
    false
  );
});
