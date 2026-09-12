import assert from "node:assert/strict";
import test from "node:test";
import { getLocalRadarData, createRadarCalculationContext } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";

const CALCULATION_NOW = new Date("2026-09-09T00:00:00.000Z");

test("public snapshot reuses one request-local canonical history context", () => {
  const data = getLocalRadarData({ calculationNow: CALCULATION_NOW });
  const metrics = {
    canonicalHistoryBuilds: 0,
    identityProjectionBuilds: 0,
    noticeBackedHistoryInputBuilds: 0,
  };
  const context = createRadarCalculationContext(data, CALCULATION_NOW, metrics);

  const snapshot = toPublicRadarSnapshot(data, "ja", {
    calculationNow: CALCULATION_NOW,
    calculationContext: context,
  });
  const probability = calculatePublishedProbability(data, {
    now: CALCULATION_NOW,
    canonicalHistoryContext: context.canonicalHistoryContext,
  });

  assert.equal(metrics.canonicalHistoryBuilds, 1);
  assert.equal(metrics.identityProjectionBuilds, 1);
  assert.equal(metrics.noticeBackedHistoryInputBuilds, 1);
  assert.ok(snapshot.viewModel);
  assert.ok(probability);
});

test("canonical context does not change public output", () => {
  const data = getLocalRadarData({ calculationNow: CALCULATION_NOW });
  const context = createRadarCalculationContext(data, CALCULATION_NOW);

  const withoutContext = toPublicRadarSnapshot(data, "ja", {
    calculationNow: CALCULATION_NOW,
  });
  const withContext = toPublicRadarSnapshot(data, "ja", {
    calculationNow: CALCULATION_NOW,
    calculationContext: context,
  });

  assert.deepEqual(withContext, withoutContext);
});
