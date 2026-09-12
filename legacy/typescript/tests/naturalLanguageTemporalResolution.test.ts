import test from "node:test";
import assert from "node:assert";
import {
  parseTiboTemporalSemantics,
  resolveTiboTemporalSchedule,
} from "../lib/radar/tiboTemporal";

test("1. Resolves the real August 13 post ('in the next hour or so') correctly", () => {
  const sourceTextReal =
    "Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.";
  const tweetCreatedAtReal = "2026-08-13T01:01:37Z";

  const mockGeminiOutput = {
    temporalExpression: "in the next hour or so",
    temporalKind: "relative_duration",
    temporalPrecision: "range",
    relativeAmount: 1,
    relativeUnit: "hours",
    temporalConfidence: 0.95,
  };

  const semantics = parseTiboTemporalSemantics(mockGeminiOutput, sourceTextReal);
  assert.notStrictEqual(semantics, null);
  assert.strictEqual(semantics?.temporalExpression, "in the next hour or so");
  assert.strictEqual(semantics?.relativeAmount, 1);
  assert.strictEqual(semantics?.relativeUnit, "hours");

  const resolution = resolveTiboTemporalSchedule(semantics, tweetCreatedAtReal);
  assert.strictEqual(resolution.status, "resolved");
  assert.strictEqual(resolution.expectedStartAt, "2026-08-13T02:01:37.000Z");
  assert.strictEqual(resolution.expectedEndAt, "2026-08-13T02:01:37.000Z");
});

test("2. Validates natural language duration expressions", () => {
  const cases = [
    { text: "Reset in an hour", exp: "in an hour", amount: 1, unit: "hours" },
    { text: "Reset in one hour", exp: "in one hour", amount: 1, unit: "hours" },
    { text: "Reset in two hours", exp: "in two hours", amount: 2, unit: "hours" },
    { text: "Reset in the next hour", exp: "in the next hour", amount: 1, unit: "hours" },
    { text: "Reset within the next hour", exp: "within the next hour", amount: 1, unit: "hours" },
    { text: "Landing in the next hour or so", exp: "in the next hour or so", amount: 1, unit: "hours" },
  ] as const;

  for (const c of cases) {
    const semantics = parseTiboTemporalSemantics(
      {
        temporalExpression: c.exp,
        temporalKind: "relative_duration",
        temporalPrecision: "exact_time",
        relativeAmount: c.amount,
        relativeUnit: c.unit,
        temporalConfidence: 0.95,
      },
      c.text,
    );

    assert.notStrictEqual(semantics, null);
    assert.strictEqual(semantics?.relativeAmount, c.amount);
    assert.strictEqual(semantics?.relativeUnit, c.unit);

    const res = resolveTiboTemporalSchedule(semantics, "2026-08-13T00:00:00Z");
    assert.strictEqual(res.status, "resolved");
  }
});

test("3. Maintains regression compatibility for numeric duration expressions", () => {
  const numericCases = [
    { text: "Reset coming in 24 hours", exp: "in 24 hours", amount: 24, unit: "hours" },
    { text: "Reset in 90 minutes", exp: "in 90 minutes", amount: 90, unit: "minutes" },
    { text: "Reset in 2 days", exp: "in 2 days", amount: 2, unit: "days" },
    { text: "Reset in 1.5 hours", exp: "in 1.5 hours", amount: 1.5, unit: "hours" },
  ] as const;

  for (const c of numericCases) {
    const semantics = parseTiboTemporalSemantics(
      {
        temporalExpression: c.exp,
        temporalKind: "relative_duration",
        temporalPrecision: "exact_time",
        relativeAmount: c.amount,
        relativeUnit: c.unit,
        temporalConfidence: 0.95,
      },
      c.text,
    );

    assert.notStrictEqual(semantics, null);
    assert.strictEqual(semantics?.relativeAmount, c.amount);

    const res = resolveTiboTemporalSchedule(semantics, "2026-08-13T00:00:00Z");
    assert.strictEqual(res.status, "resolved");
  }
});

test("4. Rejects hallucinated amount or unit mismatches", () => {
  // 'in the next hour' but Gemini returned relativeAmount = 2
  const hallucinatedAmount = parseTiboTemporalSemantics(
    {
      temporalExpression: "in the next hour",
      temporalKind: "relative_duration",
      temporalPrecision: "exact_time",
      relativeAmount: 2,
      relativeUnit: "hours",
      temporalConfidence: 0.95,
    },
    "Reset coming in the next hour",
  );
  assert.strictEqual(hallucinatedAmount, null);

  // 'in two hours' but Gemini returned relativeAmount = 1
  const hallucinatedAmount2 = parseTiboTemporalSemantics(
    {
      temporalExpression: "in two hours",
      temporalKind: "relative_duration",
      temporalPrecision: "exact_time",
      relativeAmount: 1,
      relativeUnit: "hours",
      temporalConfidence: 0.95,
    },
    "Reset coming in two hours",
  );
  assert.strictEqual(hallucinatedAmount2, null);

  // 'in an hour' but Gemini returned relativeUnit = "days"
  const hallucinatedUnit = parseTiboTemporalSemantics(
    {
      temporalExpression: "in an hour",
      temporalKind: "relative_duration",
      temporalPrecision: "exact_time",
      relativeAmount: 1,
      relativeUnit: "days",
      temporalConfidence: 0.95,
    },
    "Reset coming in an hour",
  );
  assert.strictEqual(hallucinatedUnit, null);
});

test("5. Keeps vague phrases unresolved", () => {
  const vaguePhrases = ["soon", "later", "in a while", "in the coming hours"];

  for (const phrase of vaguePhrases) {
    const semantics = parseTiboTemporalSemantics(
      {
        temporalExpression: phrase,
        temporalKind: "vague",
        temporalPrecision: "unknown",
        temporalConfidence: 0.9,
      },
      `Reset coming ${phrase}`,
    );

    const res = resolveTiboTemporalSchedule(semantics, "2026-08-13T00:00:00Z");
    assert.strictEqual(res.status, "unresolved");
  }
});
