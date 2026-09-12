import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  fetchResetDisplayNamesResult,
  RESET_DISPLAY_NAME_COLUMNS,
  RESET_DISPLAY_NAME_PUBLIC_COLUMNS,
} from "../lib/radar/resetDisplayNameStore";
import type { ResetDisplayNameRecord } from "../lib/radar/types";

const TWEET_ID = "2090000000000000001";
const COMPLETED_AT = "2026-08-08T04:32:00.000Z";
const SOURCE_URL = `https://x.com/thsottiaux/status/${TWEET_ID}`;

function acceptedRecord(overrides: Partial<ResetDisplayNameRecord> = {}): ResetDisplayNameRecord {
  return {
    event_key: `tibo-reset-${TWEET_ID}`,
    source_tweet_id: TWEET_ID,
    manual_name_ja: null,
    manual_name_en: null,
    manual_name_zh: null,
    ai_name_ja: "週末の利用上限リセット",
    ai_name_en: "Weekend Limit Reset",
    ai_name_zh: "周末限额重置",
    ai_confidence: 0.86,
    ai_evidence: "weekend",
    ai_reason: "recorded reason",
    ai_model: "gemini-3.5-flash-lite",
    ai_prompt_version: "random-reset-name-v3",
    ai_input_mode: "metadata+source",
    ai_status: "accepted",
    ai_flags: [],
    ai_generated_at: "2026-08-08T04:00:00.000Z",
    input_hash: "hash",
    created_at: "2026-08-08T04:00:00.000Z",
    updated_at: "2026-08-08T04:00:00.000Z",
    ...overrides,
  };
}

function projectRecord(
  record: ResetDisplayNameRecord,
  columns: string,
): ResetDisplayNameRecord {
  const projected: Record<string, unknown> = {};
  for (const column of columns.split(",")) {
    projected[column] = record[column as keyof ResetDisplayNameRecord];
  }
  return projected as ResetDisplayNameRecord;
}

function sourceSignal() {
  return {
    tweet_id: TWEET_ID,
    text: "A weekend reset is live.",
    tweet_url: SOURCE_URL,
    tweet_created_at: COMPLETED_AT,
    detected_at: COMPLETED_AT,
    signal_type: "reset_executed" as const,
    confidence: 0.98,
    verification_status: "confirmed" as const,
    classification_source: "gemini" as const,
  };
}

function snapshotFor(record: ResetDisplayNameRecord, locale: "ja" | "en" | "zh") {
  return toPublicRadarSnapshot(
    getLocalRadarData({
      checkedAt: "2026-08-08T05:00:00.000Z",
      calculationNow: new Date("2026-08-08T05:00:00.000Z"),
      formalTiboResets: [sourceSignal()],
      resetDisplayNames: [record],
    }),
    locale,
    { calculationNow: new Date("2026-08-08T05:00:00.000Z") },
  );
}

test("public projection contains the exact safe display-name fields and full keeps metadata", () => {
  const publicFields = RESET_DISPLAY_NAME_PUBLIC_COLUMNS.split(",");
  const fullFields = RESET_DISPLAY_NAME_COLUMNS.split(",");

  assert.deepEqual(publicFields, [
    "event_key",
    "source_tweet_id",
    "manual_name_ja",
    "manual_name_en",
    "manual_name_zh",
    "ai_name_ja",
    "ai_name_en",
    "ai_name_zh",
    "ai_confidence",
    "ai_evidence",
    "ai_prompt_version",
    "ai_status",
    "ai_flags",
  ]);
  assert.equal(fullFields.length, 20);
  assert.equal(fullFields.includes("input_hash"), true);
  assert.equal(fullFields.includes("ai_model"), true);
  assert.equal(publicFields.includes("input_hash"), false);
  assert.equal(publicFields.includes("ai_model"), false);
  assert.equal(publicFields.includes("ai_reason"), false);
  assert.equal(publicFields.includes("ai_input_mode"), false);
  assert.equal(publicFields.includes("updated_at"), false);
});

test("public and full projections produce identical JA/EN/ZH public snapshots", () => {
  const variants: ResetDisplayNameRecord[] = [
    acceptedRecord(),
    acceptedRecord({
      manual_name_ja: "手動の週末リセット",
      manual_name_en: "Manual Weekend Reset",
      manual_name_zh: "手动周末重置",
    }),
    acceptedRecord({
      ai_prompt_version: "random-reset-name-v2",
      ai_confidence: null,
      ai_evidence: null,
    }),
    acceptedRecord({
      ai_prompt_version: "random-reset-name-v1",
      ai_name_en: undefined,
      ai_name_zh: undefined,
      ai_confidence: 0.71,
      ai_evidence: "weekend",
    }),
    acceptedRecord({
      ai_confidence: 0.5,
      ai_evidence: "weekend",
    }),
    acceptedRecord({
      ai_flags: ["named_token_mismatch"],
    }),
  ];

  for (const record of variants) {
    const publicRecord = projectRecord(record, RESET_DISPLAY_NAME_PUBLIC_COLUMNS);
    for (const locale of ["ja", "en", "zh"] as const) {
      assert.deepEqual(
        snapshotFor(publicRecord, locale),
        snapshotFor(record, locale),
        `public projection changed ${locale} output for ${record.ai_prompt_version}`,
      );
    }
  }
});

test("Radar defaults to public names while reconciliation explicitly requests full names", () => {
  const radarFetchSource = readFileSync(resolve("lib/radarFetch.ts"), "utf8");
  const reconciliationSource = readFileSync(
    resolve("lib/radar/resetDisplayNameReconciliation.ts"),
    "utf8",
  );

  assert.match(
    radarFetchSource,
    /const resetDisplayNameReadMode = options\.resetDisplayNameReadMode \?\? "public";/,
  );
  assert.match(radarFetchSource, /fetchResetDisplayNamesResult\(resetDisplayNameReadMode\)/);
  assert.match(radarFetchSource, /\(\) => fetchResetDisplayNamesResult\("public"\)/);
  assert.match(reconciliationSource, /resetDisplayNameReadMode:\s*"full"/);
});

test("explicit public and compatibility full reads select one query with different projections", async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = async (input) => {
    requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await fetchResetDisplayNamesResult("public");
    await fetchResetDisplayNamesResult();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }

  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]).searchParams.get("select"), RESET_DISPLAY_NAME_PUBLIC_COLUMNS);
  assert.equal(new URL(requests[1]).searchParams.get("select"), RESET_DISPLAY_NAME_COLUMNS);
});

test("public projection preserves the localized and legacy fallback sequence", async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  const selections: string[] = [];

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const selection = new URL(url).searchParams.get("select") ?? "";
    selections.push(selection);
    if (selections.length < 3) {
      return new Response(JSON.stringify({
        code: "PGRST204",
        message: "column manual_name_en does not exist",
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify([acceptedRecord()]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await fetchResetDisplayNamesResult("public");
    assert.equal(result.data.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }

  assert.equal(selections.length, 3);
  assert.deepEqual(selections[0].split(","), RESET_DISPLAY_NAME_PUBLIC_COLUMNS.split(","));
  assert.equal(selections[1], [
    "event_key",
    "source_tweet_id",
    "manual_name_ja",
    "ai_name_ja",
    "ai_name_en",
    "ai_name_zh",
    "ai_confidence",
    "ai_evidence",
    "ai_prompt_version",
    "ai_status",
    "ai_flags",
  ].join(","));
  assert.equal(selections[2], [
    "event_key",
    "source_tweet_id",
    "manual_name_ja",
    "ai_name_ja",
    "ai_confidence",
    "ai_evidence",
    "ai_prompt_version",
    "ai_status",
    "ai_flags",
  ].join(","));
});
