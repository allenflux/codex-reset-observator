import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON,
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
} from "../data/shadowProbabilityConfig";
import {
  calculateNextGenerationAEnsemble,
  fitNextGenerationEnsemble,
  projectNextGenerationSimplex,
} from "../lib/radar/nextGenerationEnsemble";

const components = Object.fromEntries(
  NEXT_GENERATION_A_COMPONENT_VERSIONS.map((modelVersion, index) => [modelVersion, {
    modelVersion,
    probability24h: 0.12 + index * 0.03,
    probability48h: 0.24 + index * 0.03,
  }]),
);

test("simplex projection is non-negative and sums to one", () => {
  const projected = projectNextGenerationSimplex([0.8, -0.2, 0.4, 0.1, 0.2]);
  assert.equal(projected.length, 5);
  assert.equal(projected.every((value) => value >= 0), true);
  assert.ok(Math.abs(projected.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});
test("A rejects a missing exact component instead of renormalizing remaining weights", () => {
  const missing = { ...components };
  delete missing[NEXT_GENERATION_A_COMPONENT_VERSIONS[2]];
  assert.equal(
    calculateNextGenerationAEnsemble(missing, {
      generatedAt: "2026-08-22T03:00:00.000Z",
      trainingRows: [],
      trainingReadStatus: "ok",
    }),
    null,
  );
});

test("A cold start uses equal weights and alpha zero", () => {
  const result = calculateNextGenerationAEnsemble(components, {
    generatedAt: "2026-08-22T03:00:00.000Z",
    trainingRows: [],
    trainingReadStatus: "ok",
  });

  assert.ok(result);
  assert.equal(result.trainingMode24h, "equal");
  assert.equal(result.trainingMode48h, "equal");
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
  assert.deepEqual(result.weights24h, [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.deepEqual(result.weights48h, [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.equal(result.componentLogitEpsilon, NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON);
});

test("A fitted 24h and 48h models are deterministic constrained fits", () => {
  const trainingRows = Array.from({ length: 10 }, (_, index) => ({
    generatedAt: new Date(Date.UTC(2026, 7, 1 + index, 3)).toISOString(),
    components,
    actual24h: index >= 5,
    actual48h: index >= 4,
  }));
  const first = fitNextGenerationEnsemble(trainingRows, "24h");
  const second = fitNextGenerationEnsemble(trainingRows, "24h");

  assert.equal(first.trainingMode, "fitted");
  assert.deepEqual(first, second);
  assert.equal(first.weights.every((value) => value >= 0), true);
  assert.ok(Math.abs(first.weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.equal(Number.isFinite(first.alpha), true);
  assert.equal(first.solver.converged, true);
});

test("A fits each horizon only from rows whose own label is resolved", () => {
  const trainingRows = Array.from({ length: 10 }, (_, index) => ({
    generatedAt: new Date(Date.UTC(2026, 7, 1 + index, 3)).toISOString(),
    components,
    actual24h: index % 2 === 0,
    actual48h: undefined,
  }));
  const fit24h = fitNextGenerationEnsemble(trainingRows, "24h");
  const fit48h = fitNextGenerationEnsemble(trainingRows, "48h");
  assert.equal(fit24h.sampleCount, 10);
  assert.equal(fit48h.sampleCount, 0);
  assert.equal(fit48h.trainingMode, "equal");
});
