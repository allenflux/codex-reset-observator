import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ELAPSED_ONLY_MODEL_VERSION,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_AUTO_PUBLISH,
  NEXT_GENERATION_BACKFILL,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_EVALUATION_MODE,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_ADOPTION_BOUNDARY_STATUS,
  PUBLISHED_PROBABILITY_ADOPTION_DATE,
  PUBLISHED_PROBABILITY_ADOPTION_GATE_STATUS,
  PUBLISHED_PROBABILITY_ADOPTION_MODE,
  PUBLISHED_PROBABILITY_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT,
  PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
  PUBLISHED_PROBABILITY_V4_ROLLBACK_AT,
  PUBLISHED_STABLE_FALLBACK_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { evaluatePublishedModelProspectively } from "../lib/radar/prospectivePublishedModelEvaluation";
import { getLocalRadarData } from "../lib/radar";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";

const GOVERNANCE_DOC = resolve("docs/probability/published-model-governance.md");
const PUBLISHED_EVALUATION_DOC = resolve("docs/prospective-published-model-evaluation.md");
const NEXT_GENERATION_DOC = resolve("docs/probability/next-generation-shadow-models.md");

test("published model governance config records the manual selective hybrid and rollback boundaries", () => {
  assert.equal(PUBLISHED_PROBABILITY_MODEL_VERSION, NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION);
  assert.equal(PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION, NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION);
  assert.equal(PUBLISHED_STABLE_FALLBACK_MODEL_VERSION, ELAPSED_ONLY_MODEL_VERSION);
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_MODE, "manual");
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_DATE, "2026-09-10");
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_AT, "2026-09-10T01:00:00.000Z");
  assert.equal(PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT, "2026-09-01T08:00:00.000Z");
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_BOUNDARY_STATUS, "production_boundary_set");
  assert.equal(
    NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
    NEXT_GENERATION_B_MODEL_VERSION,
  );
  assert.equal(PUBLISHED_PROBABILITY_ADOPTION_GATE_STATUS, "not_met");
  assert.equal(PUBLISHED_PROBABILITY_V4_ROLLBACK_AT, "2026-09-11T02:20:00.000Z");
  assert.equal(NEXT_GENERATION_EVALUATION_MODE, "prospective");
  assert.equal(NEXT_GENERATION_BACKFILL, false);
  assert.equal(NEXT_GENERATION_AUTO_PUBLISH, false);
  assert.equal(NEXT_GENERATION_A_MODEL_VERSION, "hazard-ensemble-logit-stack-v1");
  assert.equal(NEXT_GENERATION_C_MODEL_VERSION, "hazard-contextual-burst-circadian-v1");
});

test("governance records the scheduled corrective rollback as a limited recommendation", () => {
  const governance = readFileSync(GOVERNANCE_DOC, "utf8");

  assert.match(governance, /corrective rollback to old V4/);
  assert.match(governance, /confidence: medium-low/);
  assert.match(governance, /resolved 24h=10, 48h=9/);
  assert.match(governance, /24h Brier.*0\.2337/);
  assert.match(governance, /48h Brier.*0\.3601/);
  assert.match(governance, /leave-one-origin-out/);
  assert.match(governance, /episode leave-out.*not fully stable/);
  assert.match(governance, /not a universal superiority claim/);
  assert.match(governance, /support status.*installed.*manual corrective rollback scheduled/i);
  assert.match(governance, /rollback boundary.*2026-09-11T02:20:00\.000Z/);
  assert.match(governance, /V4-24.*C-48.*not implemented/);
});

test("the previous B v1 remains effective before the explicit v2 boundary", () => {
  const now = new Date("2026-08-23T02:10:00.000Z");
  const published = calculatePublishedProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      activeOfficialNotice: null,
      nextGenerationBTrainingRows: [],
      nextGenerationBTrainingReadStatus: "ok",
    },
    { logFallback: false },
  );

  assert.equal(published.adoptedModel, NEXT_GENERATION_B_MODEL_VERSION);
  assert.equal(published.fallbackReason, null);
});

test("prospective evaluation notes name the selective hybrid boundary and v2 as its baseline", () => {
  const report = evaluatePublishedModelProspectively(
    [],
    [],
    new Date("2026-08-30T00:00:00.000Z"),
  );
  const notes = report.notes.join("\n");

  assert.match(notes, new RegExp(`${PUBLISHED_PROBABILITY_MODEL_VERSION}.*boundary`));
  assert.match(notes, new RegExp(`${PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION} remains the comparison baseline`));
  assert.match(notes, /manual adoption boundary/);
  assert.doesNotMatch(notes, /calibrated .* public model was manually adopted/);
});

test("current governance documents do not claim that v3 is still public", () => {
  const governance = readFileSync(GOVERNANCE_DOC, "utf8");
  const publishedEvaluation = readFileSync(PUBLISHED_EVALUATION_DOC, "utf8");
  const nextGeneration = readFileSync(NEXT_GENERATION_DOC, "utf8");

  assert.match(governance, new RegExp(PUBLISHED_PROBABILITY_MODEL_VERSION));
  assert.match(governance, new RegExp(PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION));
  assert.match(governance, /manual/);
  assert.match(governance, /not_met/);
  assert.match(governance, /production_boundary_set/);
  assert.match(governance, /retrospective documentation/i);
  assert.match(governance, /material calibration regression/i);

  assert.match(publishedEvaluation, new RegExp(PUBLISHED_PROBABILITY_MODEL_VERSION));
  assert.match(publishedEvaluation, new RegExp(PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION));
  assert.match(publishedEvaluation, /2026-09-01T08:00:00\.000Z/);
  assert.doesNotMatch(
    publishedEvaluation,
    /現在の公開モデルは、`hazard-odds-v4-logit-calibrated-prequential-v3`/,
  );

  assert.match(nextGeneration, new RegExp(`公開モデル.*${PUBLISHED_PROBABILITY_MODEL_VERSION}`));
  assert.match(nextGeneration, /A\/C.*shadow/);
  assert.doesNotMatch(nextGeneration, /次のモデルは公開選択へ接続しないshadow/);
});
