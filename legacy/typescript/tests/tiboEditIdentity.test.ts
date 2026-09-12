import assert from "node:assert/strict";
import test from "node:test";

import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  createUntrustedTiboEditIdentity,
  mergeTiboEditIdentity,
  reconcileTiboEditChainMetadata,
  type TiboEditIdentityRecord,
  type TiboEditIdentityStore,
} from "../lib/radar/tiboEditIdentity";
import { preserveTiboWebhookState } from "../lib/radar/tiboWebhookState";

const A = "2094251180121854309";
const B = "2094252447271366730";
const C = "2094252447271366731";
const X = "2094252447271366740";

type StoredRow = TiboEditIdentityRecord & {
  tweet_id: string;
  text: string;
  signal_type: string;
  classification_reason: string;
  classification_source: string;
  rule_signal_type: string;
  ai_signal_type: string;
  ai_reason_ja: string;
};

function trustedIdentity(ids: string[], tweetId: string) {
  return {
    logical_post_id: ids[0],
    edit_history_tweet_ids: ids,
    edit_version: ids.indexOf(tweetId) + 1,
    edit_metadata_source: "x_api" as const,
  };
}

function legacyRow(tweetId: string, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    tweet_id: tweetId,
    text: `${tweetId} raw text`,
    signal_type: "manual-signal",
    classification_reason: "manual reason",
    classification_source: "manual",
    rule_signal_type: "irrelevant",
    ai_signal_type: "official_notice",
    ai_reason_ja: "raw AI reason",
    ...createUntrustedTiboEditIdentity(tweetId),
    ...overrides,
  };
}

function cloneRow(row: StoredRow): StoredRow {
  return {
    ...row,
    edit_history_tweet_ids: row.edit_history_tweet_ids
      ? [...row.edit_history_tweet_ids]
      : row.edit_history_tweet_ids,
  };
}

function fakeStore(
  rows: StoredRow[],
  updateErrors = new Map<string, unknown>(),
  beforeUpdate?: (tweetId: string) => void,
) {
  const updates: Array<{ tweetId: string; values: Record<string, unknown> }> = [];
  const store: TiboEditIdentityStore = {
    from(table) {
      assert.equal(table, "tibo_signals");
      return {
        select(columns) {
          assert.match(columns, /logical_post_id/);
          return {
            async in(column, values) {
              assert.equal(column, "tweet_id");
              return {
                data: rows
                  .filter((row) => values.includes(row.tweet_id))
                  .map(cloneRow),
                error: null,
              };
            },
          };
        },
        update(values) {
          assert.deepEqual(Object.keys(values).sort(), [
            "edit_history_tweet_ids",
            "edit_metadata_source",
            "edit_version",
            "logical_post_id",
          ]);
          const conditions = new Map<string, string>();
          const builder = {
            eq(column: string, value: string) {
              conditions.set(column, value);
              return builder;
            },
            async select() {
              const tweetId = conditions.get("tweet_id") ?? "";
              beforeUpdate?.(tweetId);
              const row = rows.find((candidate) => candidate.tweet_id === tweetId);
              const matches = row && Array.from(conditions.entries()).every(([column, value]) => {
                if (column === "edit_history_tweet_ids") {
                  return `{${row.edit_history_tweet_ids?.join(",") ?? ""}}` === value;
                }
                return String(row[column as keyof StoredRow] ?? "") === value;
              });
              const error = updateErrors.get(tweetId) ?? null;
              if (!matches) return { data: [], error: null };
              updates.push({ tweetId, values });
              if (error) return { data: null, error };
              assert.ok(row);
              Object.assign(row, values);
              return { data: [{ tweet_id: tweetId }], error: null };
            },
          };
          return builder;
        },
      };
    },
  };
  return { store, updates };
}

test("legacy none rows are upgraded to one trusted chain using identity columns only", async () => {
  const rows = [legacyRow(A), legacyRow(B)];
  const fake = fakeStore(rows);
  const result = await reconcileTiboEditChainMetadata(
    fake.store,
    B,
    trustedIdentity([A, B], B),
  );

  assert.equal(result.status, "reconciled");
  assert.deepEqual(fake.updates.map((update) => update.tweetId), [A, B]);
  assert.deepEqual(rows.map((row) => ({
    id: row.tweet_id,
    root: row.logical_post_id,
    history: row.edit_history_tweet_ids,
    version: row.edit_version,
    source: row.edit_metadata_source,
  })), [
    { id: A, root: A, history: [A, B], version: 1, source: "x_api" },
    { id: B, root: A, history: [A, B], version: 2, source: "x_api" },
  ]);
});

test("a trusted row is preserved when a later lookup falls back to none", () => {
  const result = mergeTiboEditIdentity(
    { tweet_id: A, ...trustedIdentity([A, B], A) },
    createUntrustedTiboEditIdentity(A),
    A,
  );

  assert.equal(result.status, "preserved");
  assert.deepEqual(result.identity, trustedIdentity([A, B], A));
});

test("an existing trusted prefix expands to the incoming full chain", async () => {
  const rows = [
    legacyRow(A, trustedIdentity([A], A)),
    legacyRow(B),
  ];
  const fake = fakeStore(rows);
  const result = await reconcileTiboEditChainMetadata(
    fake.store,
    B,
    trustedIdentity([A, B], B),
  );

  assert.equal(result.status, "reconciled");
  assert.deepEqual(rows.map((row) => row.edit_history_tweet_ids), [[A, B], [A, B]]);
  assert.deepEqual(rows.map((row) => row.edit_version), [1, 2]);
});

test("a stale shorter reconciliation cannot overwrite a chain extended concurrently", async () => {
  const rows = [legacyRow(A)];
  let raced = false;
  const fake = fakeStore(rows, new Map(), (tweetId) => {
    if (tweetId !== A || raced) return;
    raced = true;
    Object.assign(rows[0], trustedIdentity([A, B, C], A));
  });

  const result = await reconcileTiboEditChainMetadata(
    fake.store,
    A,
    trustedIdentity([A, B], A),
  );

  assert.equal(result.status, "unchanged");
  assert.deepEqual(rows[0].edit_history_tweet_ids, [A, B, C]);
  assert.equal(rows[0].edit_version, 1);
});

test("partial reconciliation updates only an existing member and never creates a stub", async () => {
  const rows = [legacyRow(B)];
  const fake = fakeStore(rows);
  const result = await reconcileTiboEditChainMetadata(
    fake.store,
    B,
    trustedIdentity([A, B], B),
  );

  assert.equal(result.status, "reconciled");
  assert.deepEqual(fake.updates.map((update) => update.tweetId), [B]);
  assert.equal(rows.some((row) => row.tweet_id === A), false);
});

test("manual classification and raw AI audit fields survive identity reconciliation", async () => {
  const rows = [legacyRow(A)];
  const before = {
    text: rows[0].text,
    signal_type: rows[0].signal_type,
    classification_reason: rows[0].classification_reason,
    classification_source: rows[0].classification_source,
    rule_signal_type: rows[0].rule_signal_type,
    ai_signal_type: rows[0].ai_signal_type,
    ai_reason_ja: rows[0].ai_reason_ja,
  };
  const fake = fakeStore(rows);

  await reconcileTiboEditChainMetadata(fake.store, A, trustedIdentity([A, B], A));

  assert.deepEqual({
    text: rows[0].text,
    signal_type: rows[0].signal_type,
    classification_reason: rows[0].classification_reason,
    classification_source: rows[0].classification_source,
    rule_signal_type: rows[0].rule_signal_type,
    ai_signal_type: rows[0].ai_signal_type,
    ai_reason_ja: rows[0].ai_reason_ja,
  }, before);
});

test("a conflicting trusted chain fails closed without updating any member", async () => {
  const rows = [legacyRow(A, trustedIdentity([A, X], A))];
  const fake = fakeStore(rows);
  const result = await reconcileTiboEditChainMetadata(
    fake.store,
    B,
    trustedIdentity([A, B], B),
  );

  assert.equal(result.status, "conflict");
  assert.deepEqual(fake.updates, []);
  assert.deepEqual(rows[0].edit_history_tweet_ids, [A, X]);
});

test("three-version chains converge in arrival order and preserve the same final identity", async () => {
  const forwardRows = [legacyRow(A), legacyRow(B), legacyRow(C)];
  const forward = fakeStore(forwardRows);
  await reconcileTiboEditChainMetadata(forward.store, A, trustedIdentity([A], A));
  await reconcileTiboEditChainMetadata(forward.store, B, trustedIdentity([A, B], B));
  await reconcileTiboEditChainMetadata(forward.store, C, trustedIdentity([A, B, C], C));

  const reverseRows = [legacyRow(A), legacyRow(B), legacyRow(C)];
  const reverse = fakeStore(reverseRows);
  await reconcileTiboEditChainMetadata(reverse.store, C, trustedIdentity([A, B, C], C));
  await reconcileTiboEditChainMetadata(reverse.store, B, trustedIdentity([A, B], B));
  await reconcileTiboEditChainMetadata(reverse.store, A, trustedIdentity([A], A));

  const identitySnapshot = (rows: StoredRow[]) => rows.map((row) => ({
    id: row.tweet_id,
    root: row.logical_post_id,
    history: row.edit_history_tweet_ids,
    version: row.edit_version,
    source: row.edit_metadata_source,
  }));
  assert.deepEqual(identitySnapshot(forwardRows), identitySnapshot(reverseRows));
  assert.deepEqual(identitySnapshot(reverseRows), [
    { id: A, root: A, history: [A, B, C], version: 1, source: "x_api" },
    { id: B, root: A, history: [A, B, C], version: 2, source: "x_api" },
    { id: C, root: A, history: [A, B, C], version: 3, source: "x_api" },
  ]);
});

test("lookup or update failure does not add classification fields to the identity update", async () => {
  const rows = [legacyRow(A)];
  const fake = fakeStore(rows, new Map([[A, new Error("update unavailable")]]));
  const result = await reconcileTiboEditChainMetadata(fake.store, A, trustedIdentity([A], A));

  assert.equal(result.status, "error");
  assert.equal(fake.updates[0].values.classification_source, undefined);
});

test("webhook state keeps legacy callers without edit metadata compatible", () => {
  const result = preserveTiboWebhookState({
    tweet_id: A,
    detected_at: "2026-08-31T00:00:00.000Z",
    verification_status: "auto_unverified",
  }, null, "2026-08-31T00:01:00.000Z");

  assert.equal("logical_post_id" in result, false);
  assert.equal("edit_history_tweet_ids" in result, false);
});

test("edit identity metadata is not exposed by public-v1", () => {
  const snapshot = toPublicRadarSnapshot({
    active_tibo_signals: [{
      tweet_id: B,
      signal_type: "teaser",
      text: "A reset is coming.",
      tweet_url: `https://x.com/thsottiaux/status/${B}`,
      tweet_created_at: "2026-08-31T00:00:00.000Z",
      confidence: 0.9,
      verification_status: "auto_unverified",
      ...trustedIdentity([A, B], B),
    }],
  }, "ja", { calculationNow: new Date("2026-08-31T01:00:00.000Z") });

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("logical_post_id"), false);
  assert.equal(serialized.includes("edit_history_tweet_ids"), false);
  assert.equal(serialized.includes("edit_metadata_source"), false);
});
