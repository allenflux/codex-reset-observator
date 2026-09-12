import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
} from "../data/shadowProbabilityConfig";
import {
  loadNextGenerationTrainingState,
  NEXT_GENERATION_TRAINING_SELECT_FIELDS,
  parseNextGenerationTrainingProjectionRows,
  parseNextGenerationTrainingRows,
} from "../lib/radar/nextGenerationTraining";

const componentForecasts = Object.fromEntries(
  NEXT_GENERATION_A_COMPONENT_VERSIONS.map((modelVersion, index) => [modelVersion, {
    modelVersion,
    generatedAt: "2026-08-22T00:00:00.000Z",
    probability24h: 0.1 + index * 0.02,
    probability48h: 0.2 + index * 0.02,
  }]),
);

function historyRow(generatedAt = "2026-08-22T00:00:00.000Z") {
  return {
    logged_hour: generatedAt,
    debug_info: {
      calculated_at: generatedAt,
      experimentalProbabilityForecasts: {
        ...componentForecasts,
        [NEXT_GENERATION_B_MODEL_VERSION]: {
          ...componentForecasts[NEXT_GENERATION_B_MODEL_VERSION],
          modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
          generatedAt,
          rawProbability24h: 0.22,
          rawProbability48h: 0.44,
          probability24h: 0.25,
          probability48h: 0.45,
        },
      },
    },
  };
}

function contextualOnlyRow(generatedAt: string) {
  return {
    logged_hour: generatedAt,
    debug_info: {
      calculated_at: generatedAt,
      experimentalProbabilityForecasts: {
        [NEXT_GENERATION_C_MODEL_VERSION]: {
          modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
          generatedAt,
          rawProbability24h: 0.31,
          rawProbability48h: 0.52,
          probability24h: 0.32,
          probability48h: 0.53,
        },
      },
    },
  };
}

function contextualV2OnlyRow(generatedAt: string) {
  return {
    logged_hour: generatedAt,
    debug_info: {
      calculated_at: generatedAt,
      experimentalProbabilityForecasts: {
        [NEXT_GENERATION_C_V2_MODEL_VERSION]: {
          modelVersion: NEXT_GENERATION_C_V2_MODEL_VERSION,
          generatedAt,
          rawProbability24h: 0.41,
          rawProbability48h: 0.62,
          probability24h: 0.42,
          probability48h: 0.63,
        },
      },
    },
  };
}

function projectedHistoryRow(generatedAt = "2026-08-22T00:00:00.000Z") {
  const row: Record<string, unknown> = {
    logged_hour: generatedAt,
    b_model_version: NEXT_GENERATION_B_MODEL_VERSION,
    b_generated_at: generatedAt,
    b_raw_probability_24h: 0.22,
    b_raw_probability_48h: 0.44,
    b_probability_24h: 0.25,
    b_probability_48h: 0.45,
    c_model_version: null,
    c_generated_at: null,
    c_raw_probability_24h: null,
    c_raw_probability_48h: null,
  };
  for (
    let index = 0;
    index < NEXT_GENERATION_A_COMPONENT_VERSIONS.length;
    index += 1
  ) {
    const modelVersion = NEXT_GENERATION_A_COMPONENT_VERSIONS[index];
    if (modelVersion === NEXT_GENERATION_B_MODEL_VERSION) continue;
    row[`a_${index}_model_version`] = modelVersion;
    row[`a_${index}_generated_at`] = generatedAt;
    row[`a_${index}_probability_24h`] = 0.1 + index * 0.02;
    row[`a_${index}_probability_48h`] = 0.2 + index * 0.02;
  }
  return row;
}

test("compact training select projects only the required forecast fields", () => {
  const fields = NEXT_GENERATION_TRAINING_SELECT_FIELDS.split(",");
  assert.equal(fields[0], "logged_hour");
  assert.equal(fields.length, 31);
  assert.ok(fields.slice(1).every((field) => field.includes("debug_info->experimentalProbabilityForecasts")));
  assert.doesNotMatch(NEXT_GENERATION_TRAINING_SELECT_FIELDS, /(^|,)debug_info(,|$)/);
  assert.match(NEXT_GENERATION_TRAINING_SELECT_FIELDS, /b_raw_probability_24h:/);
  assert.match(NEXT_GENERATION_TRAINING_SELECT_FIELDS, /b_probability_24h:/);
  for (const modelVersion of [
    ...NEXT_GENERATION_A_COMPONENT_VERSIONS,
    NEXT_GENERATION_C_MODEL_VERSION,
    NEXT_GENERATION_C_V2_MODEL_VERSION,
  ]) {
    assert.match(NEXT_GENERATION_TRAINING_SELECT_FIELDS, new RegExp(`->${modelVersion}->`));
  }
});

test("training parser excludes pre-freeze rows and labels only random boundaries", () => {
  const rows = parseNextGenerationTrainingRows(
    [
      historyRow("2026-08-21T03:26:00.000Z"),
      historyRow(),
    ],
    {
      asOf: new Date("2026-08-23T01:00:00.000Z"),
      randomEvents: [{ id: "random-1", resetAt: "2026-08-22T12:00:00.000Z" }],
    },
  );

  assert.equal(rows.bRows.length, 1);
  assert.equal(rows.aRows.length, 1);
  assert.equal(rows.cRows.length, 0);
  assert.equal(rows.bRows[0].rawProbability24h, 0.22);
  assert.equal(rows.bRows[0].actual24h, true);
  assert.equal(rows.bRows[0].actual48h, undefined);
  assert.deepEqual(Object.keys(rows.aRows[0].components), [...NEXT_GENERATION_A_COMPONENT_VERSIONS]);
  assert.equal(rows.skipReasons.pre_freeze, 1);
  assert.equal(rows.backfill, false);
  assert.equal(NEXT_GENERATION_FREEZE_AT < rows.aRows[0].generatedAt, true);
});

test("training parser rejects incomplete A components without weakening B", () => {
  const row = historyRow();
  delete (row.debug_info.experimentalProbabilityForecasts as Record<string, unknown>)[NEXT_GENERATION_A_COMPONENT_VERSIONS[2]];
  const parsed = parseNextGenerationTrainingRows([row], {
    asOf: new Date("2026-08-24T00:00:00.000Z"),
    randomEvents: [],
  });

  assert.equal(parsed.bRows.length, 1);
  assert.equal(parsed.aRows.length, 0);
  assert.equal(parsed.skipReasons.incomplete_a_components, 1);
});

test("C rows are parsed independently of B and A availability", () => {
  const afterFreeze = "2026-08-22T07:00:00.000Z";
  const beforeFreeze = new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) - 1).toISOString();
  const parsed = parseNextGenerationTrainingRows([
    contextualOnlyRow(beforeFreeze),
    contextualOnlyRow(afterFreeze),
  ], {
    asOf: new Date("2026-08-23T12:00:00.000Z"),
    randomEvents: [{ id: "random-c", resetAt: "2026-08-22T18:00:00.000Z" }],
  });

  assert.equal(parsed.cRows.length, 1);
  assert.equal(parsed.cRows[0].generatedAt, afterFreeze);
  assert.equal(parsed.cRows[0].rawProbability24h, 0.31);
  assert.equal(parsed.cRows[0].actual24h, true);
  assert.equal(parsed.cRows[0].actual48h, undefined);
  assert.equal(parsed.bRows.length, 0);
  assert.equal(parsed.aRows.length, 0);
});

test("C v2 training rows use only C v2 forecasts after the C v2 freeze", () => {
  const afterFreeze = new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 60_000).toISOString();
  const beforeFreeze = new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) - 1).toISOString();
  const parsed = parseNextGenerationTrainingRows([
    contextualV2OnlyRow(beforeFreeze),
    contextualV2OnlyRow(afterFreeze),
    contextualOnlyRow(afterFreeze),
  ], {
    asOf: new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 48 * 60 * 60 * 1000),
    randomEvents: [],
  });

  assert.equal(parsed.cV2Rows.length, 1);
  assert.equal(parsed.cV2Rows[0].modelVersion, NEXT_GENERATION_C_V2_MODEL_VERSION);
  assert.equal(parsed.cRows.length, 1);
  assert.equal(parsed.cRows[0].modelVersion, NEXT_GENERATION_C_MODEL_VERSION);
});

test("compact training projection is semantically equivalent to full debug_info", () => {
  const options = {
    asOf: new Date("2026-08-24T00:00:00.000Z"),
    randomEvents: [{ id: "random-1", resetAt: "2026-08-23T12:00:00.000Z" }],
  };
  const full = parseNextGenerationTrainingRows([historyRow()], options);
  const compact = parseNextGenerationTrainingProjectionRows([projectedHistoryRow()], options);

  assert.deepEqual(compact, full);
});

test("compact projection keeps missing and invalid forecast semantics", () => {
  const options = {
    asOf: new Date("2026-08-24T00:00:00.000Z"),
    randomEvents: [],
  };
  const missingB = projectedHistoryRow();
  delete missingB.b_model_version;
  delete missingB.b_generated_at;
  delete missingB.b_raw_probability_24h;
  delete missingB.b_raw_probability_48h;
  delete missingB.b_probability_24h;
  delete missingB.b_probability_48h;

  const invalidB = projectedHistoryRow();
  invalidB.b_model_version = "wrong-model";
  invalidB.b_raw_probability_24h = 2;

  const fullMissing = parseNextGenerationTrainingRows([{
    logged_hour: missingB.logged_hour as string,
    debug_info: { experimentalProbabilityForecasts: {} },
  }], options);
  const compactMissing = parseNextGenerationTrainingProjectionRows([missingB], options);
  assert.deepEqual(compactMissing, fullMissing);

  const fullInvalid = parseNextGenerationTrainingRows([{
    logged_hour: invalidB.logged_hour as string,
    debug_info: {
      experimentalProbabilityForecasts: {
        [NEXT_GENERATION_B_MODEL_VERSION]: {
          modelVersion: "wrong-model",
          generatedAt: invalidB.b_generated_at,
          rawProbability24h: 2,
          rawProbability48h: invalidB.b_raw_probability_48h,
        },
      },
    },
  }], options);
  const compactInvalid = parseNextGenerationTrainingProjectionRows([invalidB], options);
  assert.deepEqual(compactInvalid, fullInvalid);
});

test("training query distinguishes successful empty reads from query failures", async () => {
  const calls: string[] = [];
  let limitCount: number | undefined;
  const emptyClient = {
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        select(fields: string) {
          calls.push(`select:${fields}`);
          return {
            gte(column: string, value: string) {
              calls.push(`gte:${column}:${value}`);
              return {
                lt(nextColumn: string, nextValue: string) {
                  calls.push(`lt:${nextColumn}:${nextValue}`);
                  return {
                    order(orderColumn: string) {
                      calls.push(`order:${orderColumn}`);
                      return {
                        limit(count: number) {
                          limitCount = count;
                          return Promise.resolve({ data: [], error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const empty = await loadNextGenerationTrainingState(emptyClient, {
    asOf: new Date("2026-08-24T00:00:00.000Z"),
    randomEvents: [],
  });
  assert.equal(empty.status, "ok");
  assert.equal(empty.bRows.length, 0);
  assert.equal(empty.aRows.length, 0);
  assert.equal(empty.cRows.length, 0);
  assert.equal(empty.backfill, false);
  assert.deepEqual(calls.slice(0, 3), [
    "from:prediction_history",
    `select:${NEXT_GENERATION_TRAINING_SELECT_FIELDS}`,
    "gte:logged_hour:2026-08-21T03:00:00.000Z",
  ]);
  assert.equal(limitCount, 10_000);

  const failed = await loadNextGenerationTrainingState({
    from() {
      throw new Error("query failed");
    },
  }, {
    asOf: new Date("2026-08-24T00:00:00.000Z"),
    randomEvents: [],
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.bRows.length, 0);
  assert.equal(failed.aRows.length, 0);
  assert.equal(failed.cRows.length, 0);
});
