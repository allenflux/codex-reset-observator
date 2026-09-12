import assert from "node:assert/strict";
import test from "node:test";

import { isMissingTiboOptionalColumnError } from "../lib/radar/tiboSchemaCompatibility";

const KNOWN_OPTIONAL_TIBO_COLUMNS = [
  "secondary_signal",
  "teaser_strength",
  "translated_text_ja",
  "translated_text_zh",
  "ai_teaser_strength",
  "ai_teaser_strength_confidence",
  "ai_teaser_strength_evidence_quote",
  "ai_teaser_strength_reason_ja",
  "ai_temporal_expression",
  "temporal_expression",
  "temporal_kind",
  "temporal_precision",
  "temporal_timezone",
  "temporal_confidence",
  "temporal_resolution_source",
  "expected_start_at",
  "expected_end_at",
  "temporal_resolution_status",
  "quote_context_text",
  "quote_tweet_url",
  "quote_author_handle",
  "logical_post_id",
  "edit_history_tweet_ids",
  "edit_version",
  "edit_metadata_source",
] as const;

test("accepts every known optional Tibo column family for schema-missing errors", () => {
  for (const column of KNOWN_OPTIONAL_TIBO_COLUMNS) {
    assert.equal(
      isMissingTiboOptionalColumnError({
        code: "PGRST204",
        message: `Could not find the ${column} column in the schema cache`,
      }),
      true,
      column,
    );
  }
});

test("preserves the recognized PostgREST and PostgreSQL missing-column codes", () => {
  assert.equal(
    isMissingTiboOptionalColumnError({
      code: "42703",
      message: 'column "logical_post_id" does not exist',
    }),
    true,
  );
  assert.equal(
    isMissingTiboOptionalColumnError({
      code: "PGRST0",
      details: 'Could not find "translated_text_ja" in the schema cache',
    }),
    true,
  );
});

test("fails closed for unknown, unrelated, or non-schema errors", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["primitive", "PGRST204 secondary_signal"],
    ["unrelated database error", { code: "PGRST204", message: "permission denied" }],
    [
      "known field without missing-schema signal",
      { code: "23505", message: "duplicate value for secondary_signal" },
    ],
    [
      "unknown field with PGRST204",
      { code: "PGRST204", message: 'Could not find the future_column column in the schema cache' },
    ],
    [
      "unknown field with 42703",
      { code: "42703", message: 'column "future_column" does not exist' },
    ],
    ["generic missing column message", { message: "column missing" }],
  ];

  for (const [name, error] of cases) {
    assert.equal(isMissingTiboOptionalColumnError(error), false, name);
  }
});
