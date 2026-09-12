import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("next-generation A/B/C work is confined to the probability logging route", () => {
  const loggingRoute = readFileSync(join(root, "app/api/log-probability/route.ts"), "utf8");
  const currentRoute = readFileSync(join(root, "app/api/current/route.ts"), "utf8");

  assert.match(loggingRoute, /loadNextGenerationTrainingState/);
  assert.match(loggingRoute, /buildNextGenerationExperimentalProbabilityForecasts/);
  assert.match(loggingRoute, /NEXT_GENERATION_FREEZE_AT/);
  assert.doesNotMatch(currentRoute, /nextGeneration/i);
  assert.doesNotMatch(currentRoute, /contextualBurst|NEXT_GENERATION_C/i);
});
