import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAgreement,
  computeEvidenceValidity,
  computeTeaserStrengthMetrics,
  parseTeaserResponse,
  parseTeaserResponseForEvaluation,
  SYNTHETIC_CASES,
  USER_PROVIDED_CASE,
  type TeaserEvaluationCase,
  type TeaserEvaluationResult,
  type TeaserEvaluationRow,
} from "../scripts/evaluate-tibo-teaser-strength";

const cases: TeaserEvaluationCase[] = [
  { tweetId: "strong", text: "Reset soon", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "user_provided" },
  { tweetId: "weak", text: "I may oblige", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "user_provided" },
  USER_PROVIDED_CASE,
];

function result(teaserStrength: TeaserEvaluationResult["teaserStrength"]): TeaserEvaluationResult {
  return {
    teaserStrength,
    confidence: teaserStrength === null ? null : 0.9,
    evidenceQuote: null,
    evidenceValid: true,
    reasonJa: teaserStrength === null ? null : "評価理由",
    status: teaserStrength === null ? "invalid_schema" : "success",
    model: "test-model",
    latencyMs: 1,
    httpStatus: teaserStrength === null ? null : 200,
  };
}

test("parses the independent teaser strength schema and validates evidence", () => {
  const parsed = parseTeaserResponse({
    teaserStrength: "weak",
    confidence: 0.8,
    evidenceQuote: "may oblige",
    reasonJa: "裁量的な実施可能性を示すが、時期は不明です。",
  }, "I may oblige", "gemini-test");
  assert.equal(parsed.status, "success");
  assert.equal(parsed.teaserStrength, "weak");
  assert.equal(parseTeaserResponse({
    teaserStrength: "weak",
    confidence: 0.8,
    evidenceQuote: "not present",
    reasonJa: "理由",
  }, "I may oblige", "gemini-test").status, "invalid_evidence");
});

test("keeps class output when only the evidence quote is invalid", () => {
  const parsed = parseTeaserResponseForEvaluation({
    teaserStrength: "strong",
    confidence: 0.95,
    evidenceQuote: "not present",
    reasonJa: "近い将来の実施を具体的に示しています。",
  }, "I may reset soon", "gemini-test");
  assert.equal(parsed.status, "success");
  assert.equal(parsed.teaserStrength, "strong");
  assert.equal(parsed.evidenceValid, false);
  assert.equal(parseTeaserResponse({
    teaserStrength: "strong",
    confidence: 0.95,
    evidenceQuote: "not present",
    reasonJa: "理由",
  }, "I may reset soon", "gemini-test").status, "invalid_evidence");
});

test("computes class metrics while counting invalid responses as incorrect", () => {
  const metrics = computeTeaserStrengthMetrics(cases, [result("strong"), result("none"), result(null)]);
  assert.equal(metrics.total, 3);
  assert.equal(metrics.valid, 2);
  assert.equal(metrics.invalid, 1);
  assert.equal(metrics.correct, 1);
  assert.equal(metrics.byClass.strong.recall, 1);
  assert.equal(metrics.byClass.weak.recall, 0);
  assert.equal(metrics.byClass.none.recall, 0);
});

test("computes unanimous and pairwise agreement across repeated runs", () => {
  const rows: TeaserEvaluationRow[] = [];
  for (const run of [1, 2, 3]) {
    rows.push({ ...cases[0], run, prediction: "strong", confidence: 0.9, evidenceQuote: null, evidenceValid: true, reasonJa: "理由", status: "success", model: "test-model", latencyMs: 1, httpStatus: 200 });
    rows.push({ ...cases[1], run, prediction: run === 3 ? "none" : "weak", confidence: 0.7, evidenceQuote: null, evidenceValid: true, reasonJa: "理由", status: "success", model: "test-model", latencyMs: 1, httpStatus: 200 });
    rows.push({ ...cases[2], run, prediction: "none", confidence: 0.9, evidenceQuote: null, evidenceValid: true, reasonJa: "理由", status: "success", model: "test-model", latencyMs: 1, httpStatus: 200 });
  }
  const agreement = computeAgreement(rows, 3);
  assert.equal(agreement.caseCount, 3);
  assert.equal(agreement.completeValidCaseCount, 3);
  assert.equal(agreement.unanimousCaseCount, 2);
  assert.equal(agreement.pairwiseComparableCount, 9);
  assert.equal(agreement.pairwiseAgreementCount, 7);
});

test("separates evidence validity from class metrics", () => {
  const evidence = computeEvidenceValidity(
    cases,
    [
      { teaserStrength: "strong", status: "success", evidenceValid: false },
      { teaserStrength: "weak", status: "success", evidenceValid: true },
      { teaserStrength: "none", status: "success", evidenceValid: true },
    ],
  );
  assert.equal(evidence.classified, 3);
  assert.equal(evidence.valid, 2);
  assert.equal(evidence.invalid, 1);
  assert.equal(evidence.validRate, 2 / 3);
  assert.equal(evidence.byClass.strong.validRate, 0);
  assert.equal(evidence.byClass.weak.validRate, 1);
  assert.equal(evidence.byClass.none.validRate, 1);
});

test("keeps the synthetic evaluation set balanced and separate", () => {
  assert.equal(SYNTHETIC_CASES.length, 16);
  assert.deepEqual(
    SYNTHETIC_CASES.reduce<Record<string, number>>((counts, post) => {
      counts[post.expected] = (counts[post.expected] ?? 0) + 1;
      return counts;
    }, {}),
    { strong: 4, weak: 9, none: 3 },
  );
  assert.ok(SYNTHETIC_CASES.every((post) => post.source === "synthetic"));
});
