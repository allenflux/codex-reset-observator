import assert from "node:assert/strict";
import test from "node:test";

import {
  getManualResetDisplayNameWritePayload,
  runManualResetDisplayNameOverride,
  validateManualResetDisplayNameInput,
  type ManualResetDisplayNameStore,
} from "../lib/radar/manualResetDisplayNameOverride";
import {
  parseManualResetDisplayNameArgs,
  runManualResetDisplayNameCli,
} from "../scripts/manage-reset-display-name";
import { resolveResetDisplayTitle } from "../lib/radar/resetDisplayNames";
import type { ResetDisplayNameRecord, WindowEventLike } from "../lib/radar/types";

const eventKey = "tibo-reset-manual-localized-test";

function resetItem(overrides: Partial<WindowEventLike> = {}): WindowEventLike {
  return {
    id: eventKey,
    title: "ランダムリセット",
    source_url: "https://x.com/thsottiaux/status/2090000000000000000",
    ...overrides,
  };
}

function record(overrides: Partial<ResetDisplayNameRecord> = {}): ResetDisplayNameRecord {
  return {
    event_key: eventKey,
    source_tweet_id: "2090000000000000000",
    manual_name_ja: null,
    manual_name_en: null,
    manual_name_zh: null,
    ai_name_ja: "AI日本語リセット",
    ai_name_en: "AI English Reset",
    ai_name_zh: "AI中文重置",
    ai_confidence: 0.9,
    ai_evidence: "evidence",
    ai_reason: "reason",
    ai_model: "test-model",
    ai_prompt_version: "random-reset-name-v3",
    ai_input_mode: "metadata+source",
    ai_status: "accepted",
    ai_flags: [],
    ai_generated_at: "2026-08-31T00:00:00.000Z",
    input_hash: "hash",
    ...overrides,
  };
}

function validInput() {
  return {
    eventKey,
    manualNameJa: "手動の日本語名",
    manualNameEn: "Manual English Name",
    manualNameZh: "手动中文名称",
  };
}

function storeFor(existing: ResetDisplayNameRecord | null): {
  store: ManualResetDisplayNameStore;
  writes: Array<{ eventKey: string; payload: Record<string, string> }>;
} {
  const writes: Array<{ eventKey: string; payload: Record<string, string> }> = [];
  return {
    writes,
    store: {
      findByEventKey: async (key) => key === existing?.event_key ? existing : null,
      updateManualNames: async (key, payload) => {
        writes.push({ eventKey: key, payload });
      },
    },
  };
}

test("three-language manual names are selected for each locale", () => {
  const item = resetItem();
  const names = record({
    manual_name_ja: "手動の日本語名",
    manual_name_en: "Manual English Name",
    manual_name_zh: "手动中文名称",
  });

  assert.equal(resolveResetDisplayTitle(item, names, "ja"), "手動の日本語名");
  assert.equal(resolveResetDisplayTitle(item, names, "en"), "Manual English Name");
  assert.equal(resolveResetDisplayTitle(item, names, "zh"), "手动中文名称");
});

test("complete manual names take precedence over AI names and dictionary translations", () => {
  const item = resetItem();
  const names = record({
    manual_name_ja: "手動の日本語名",
    manual_name_en: "手動で指定した英語名",
    manual_name_zh: "手动指定的中文名",
    ai_name_ja: "AI Japanese Reset",
    ai_name_en: "AI English Reset",
    ai_name_zh: "AI Chinese Reset",
  });

  assert.equal(resolveResetDisplayTitle(item, names, "ja"), "手動の日本語名");
  assert.equal(resolveResetDisplayTitle(item, names, "en"), "手動で指定した英語名");
  assert.equal(resolveResetDisplayTitle(item, names, "zh"), "手动指定的中文名");
});

test("JA-only legacy manual names keep the existing compatibility path", () => {
  const item = resetItem();
  const legacy = record({
    manual_name_ja: "Codex利用制限改善対応リセット",
    manual_name_en: undefined,
    manual_name_zh: undefined,
  });

  assert.equal(resolveResetDisplayTitle(item, legacy, "ja"), "Codex利用制限改善対応リセット");
  assert.equal(resolveResetDisplayTitle(item, legacy, "en"), "AI English Reset");
  assert.equal(resolveResetDisplayTitle(item, legacy, "zh"), "AI中文重置");
});

test("each manual locale is required by the new save contract", () => {
  assert.deepEqual(validateManualResetDisplayNameInput(validInput()), validInput());
  for (const field of ["manualNameJa", "manualNameEn", "manualNameZh"] as const) {
    const input = validInput();
    input[field] = "";
    assert.throws(
      () => validateManualResetDisplayNameInput(input),
      new RegExp(`${field} is required`),
    );
  }
});

test("manual update payload contains only the three manual names and updated_at", () => {
  assert.deepEqual(
    getManualResetDisplayNameWritePayload(validInput(), "2026-08-31T01:00:00.000Z"),
    {
      manual_name_ja: "手動の日本語名",
      manual_name_en: "Manual English Name",
      manual_name_zh: "手动中文名称",
      updated_at: "2026-08-31T01:00:00.000Z",
    },
  );
});

test("dry-run reads the exact event but never writes", async () => {
  const existing = record();
  const { store, writes } = storeFor(existing);
  const result = await runManualResetDisplayNameOverride({
    input: validInput(),
    apply: false,
    updatedAt: "2026-08-31T01:00:00.000Z",
    store,
  });

  assert.equal(result.status, "dry_run");
  assert.equal(writes.length, 0);
  assert.equal(result.existing?.ai_name_en, "AI English Reset");
});

test("explicit apply writes only manual columns and preserves AI metadata", async () => {
  const existing = record();
  const { store, writes } = storeFor(existing);
  const result = await runManualResetDisplayNameOverride({
    input: validInput(),
    apply: true,
    updatedAt: "2026-08-31T01:00:00.000Z",
    store,
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(writes, [{
    eventKey,
    payload: {
      manual_name_ja: "手動の日本語名",
      manual_name_en: "Manual English Name",
      manual_name_zh: "手动中文名称",
      updated_at: "2026-08-31T01:00:00.000Z",
    },
  }]);
  assert.equal(existing.ai_name_ja, "AI日本語リセット");
  assert.equal(existing.ai_name_en, "AI English Reset");
  assert.equal(existing.ai_name_zh, "AI中文重置");
  assert.equal(existing.ai_prompt_version, "random-reset-name-v3");
});

test("a non-matching event key produces no write", async () => {
  const { store, writes } = storeFor(record());
  const result = await runManualResetDisplayNameOverride({
    input: { ...validInput(), eventKey: "different-event" },
    apply: true,
    updatedAt: "2026-08-31T01:00:00.000Z",
    store,
  });

  assert.equal(result.status, "not_found");
  assert.equal(writes.length, 0);
});

test("CLI requires one complete three-language set and defaults to dry-run", () => {
  assert.deepEqual(
    parseManualResetDisplayNameArgs([
      "--event-key",
      eventKey,
      "--name-ja",
      "手動の日本語名",
      "--name-en",
      "Manual English Name",
      "--name-zh",
      "手动中文名称",
    ]),
    {
      apply: false,
      input: validInput(),
    },
  );

  assert.deepEqual(
    parseManualResetDisplayNameArgs([
      "--event-key",
      eventKey,
      "--name-ja",
      "手動の日本語名",
      "--name-en",
      "Manual English Name",
      "--name-zh",
      "手动中文名称",
      "--apply",
    ]),
    {
      apply: true,
      input: validInput(),
    },
  );

  assert.throws(
    () => parseManualResetDisplayNameArgs([
      "--event-key",
      eventKey,
      "--name-ja",
      "手動の日本語名",
      "--name-en",
      "Manual English Name",
    ]),
    /--name-zh is required/,
  );
});

test("CLI JSON identifies the target and proposed update in dry-run and apply modes", async () => {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...args: unknown[]) => output.push(args.join(" "));

  try {
    for (const apply of [false, true]) {
      output.length = 0;
      const result = await runManualResetDisplayNameCli(
        [
          "--event-key",
          eventKey,
          "--name-ja",
          "手動の日本語名",
          "--name-en",
          "Manual English Name",
          "--name-zh",
          "手动中文名称",
          ...(apply ? ["--apply"] : []),
        ],
        async () => ({
          status: apply ? "applied" : "dry_run",
          eventKey,
          existing: record({
            manual_name_ja: "既存の日本語名",
            manual_name_en: "Existing English Name",
            manual_name_zh: "现有中文名称",
          }),
          payload: {
            manual_name_ja: "手動の日本語名",
            manual_name_en: "Manual English Name",
            manual_name_zh: "手动中文名称",
            updated_at: "2026-08-31T01:00:00.000Z",
          },
        }),
      );

      assert.equal(result, 0);
      const report = JSON.parse(output[0]) as Record<string, unknown>;
      assert.equal(report.eventKey, eventKey);
      assert.equal(report.sourceTweetId, "2090000000000000000");
      assert.equal(report.existingManualNameJa, "既存の日本語名");
      assert.equal(report.existingManualNameEn, "Existing English Name");
      assert.equal(report.existingManualNameZh, "现有中文名称");
      assert.deepEqual(report.proposedUpdate, {
        manual_name_ja: "手動の日本語名",
        manual_name_en: "Manual English Name",
        manual_name_zh: "手动中文名称",
        updated_at: "2026-08-31T01:00:00.000Z",
      });
    }
  } finally {
    console.log = originalLog;
  }
});

test("CLI returns exit code 1 and null target fields for not_found", async () => {
  const originalError = console.error;
  const output: string[] = [];
  console.error = (...args: unknown[]) => output.push(args.join(" "));

  try {
    const result = await runManualResetDisplayNameCli(
      [
        "--event-key",
        "missing-event",
        "--name-ja",
        "手動の日本語名",
        "--name-en",
        "Manual English Name",
        "--name-zh",
        "手动中文名称",
      ],
      async () => ({
        status: "not_found",
        eventKey: "missing-event",
        existing: null,
        payload: null,
      }),
    );

    assert.equal(result, 1);
    const report = JSON.parse(output[0]) as Record<string, unknown>;
    assert.equal(report.status, "not_found");
    assert.equal(report.sourceTweetId, null);
    assert.equal(report.existingManualNameJa, null);
    assert.equal(report.existingManualNameEn, null);
    assert.equal(report.existingManualNameZh, null);
    assert.equal(report.proposedUpdate, null);
  } finally {
    console.error = originalError;
  }
});
