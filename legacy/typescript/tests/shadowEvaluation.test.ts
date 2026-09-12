import assert from "node:assert/strict";
import test from "node:test";

import type { ProbabilityHistoryItem } from "../data/probabilityHistory";
import { assessShadowEvaluationReadiness } from "../scripts/evaluate-shadow-probability";
import type { ShadowResetEvent } from "../lib/radar/shadowProbability";

function snapshot(recordedAt: string): ProbabilityHistoryItem {
  return {
    id: recordedAt,
    recordedAt,
    probability24h: 0.1,
    probability48h: 0.2,
    expectation: "低",
    displayedProbability24h: "10%",
    displayedProbability48h: "20%",
    reason: "test",
  };
}

function resetEvent(id: string): ShadowResetEvent {
  return { id, resetAt: `2026-01-${id.padStart(2, "0")}T00:00:00.000Z` };
}

test("shadow evaluation refuses insufficient validation data", () => {
  const result = assessShadowEvaluationReadiness(
    [snapshot("2026-08-01T00:00:00.000Z")],
    [snapshot("2026-08-01T00:00:00.000Z")],
    [resetEvent("1")],
    { fullSignalEvaluable: false, shadowConfidence: "low" },
  );

  assert.equal(result.publicAdoptionEligible, false);
  assert.equal(result.fullSignalEvaluable, false);
  assert.match(result.reasons.join(" "), /point-in-time|low/);
});

test("shadow evaluation allows adoption only when all readiness gates pass", () => {
  const snapshots = Array.from({ length: 30 }, (_, index) =>
    snapshot(`2026-08-${String((index % 10) + 1).padStart(2, "0")}T00:00:00.000Z`),
  );
  const dailySnapshots = Array.from({ length: 7 }, (_, index) =>
    snapshot(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
  );

  const result = assessShadowEvaluationReadiness(
    snapshots,
    dailySnapshots,
    ["1", "2", "3", "4", "5"].map(resetEvent),
    { fullSignalEvaluable: true, shadowConfidence: "medium" },
  );

  assert.equal(result.publicAdoptionEligible, true);
  assert.deepEqual(result.reasons, []);
});
