import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  claimTiboFormalAdoption,
  TIBO_FORMAL_ADOPTION_RPC,
  type TiboFormalAdoptionRecord,
} from "../lib/radar/tiboFormalAdoptionStore";

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260831120757_tibo_formal_adoptions.sql",
);

const input = {
  logicalPostId: "2094251180121854309",
  logicalPostTweetIds: ["2094251180121854309", "2094252447271366730"],
  resetEventKey: "tibo-reset-2094251180121854309",
  representativeTweetId: "2094252447271366730",
  sourceTweetIds: ["2094251180121854309", "2094252447271366730", "2094252447271366750"],
  claimSource: "new_adoption" as const,
  identitySource: "x_api" as const,
  adoptedAt: "2026-08-31T00:00:00.000Z",
  claimedAt: "2026-08-31T00:00:01.000Z",
};

function record(overrides: Partial<TiboFormalAdoptionRecord> = {}): TiboFormalAdoptionRecord {
  return {
    id: "adoption-1",
    logicalPostId: input.logicalPostId,
    logicalPostTweetIds: [...input.logicalPostTweetIds],
    resetEventKey: input.resetEventKey,
    representativeTweetId: input.representativeTweetId,
    sourceTweetIds: [...input.sourceTweetIds],
    claimSource: input.claimSource,
    adoptedAt: input.adoptedAt,
    claimedAt: input.claimedAt,
    createdAt: input.claimedAt,
    updatedAt: input.claimedAt,
    ...overrides,
  };
}

function databaseRecord(value: TiboFormalAdoptionRecord) {
  return {
    id: value.id,
    logical_post_id: value.logicalPostId,
    logical_post_tweet_ids: value.logicalPostTweetIds,
    reset_event_key: value.resetEventKey,
    representative_tweet_id: value.representativeTweetId,
    source_tweet_ids: value.sourceTweetIds,
    claim_source: value.claimSource,
    adopted_at: value.adoptedAt,
    claimed_at: value.claimedAt,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function fakeClient(
  response: { data: unknown; error: unknown },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(response);
    },
  };
}

test("atomic claim sends the logical aliases and provenance as separate arrays", async () => {
  const client = fakeClient({
    data: { status: "claimed_new", record: {
      id: "adoption-1",
      logical_post_id: input.logicalPostId,
      logical_post_tweet_ids: input.logicalPostTweetIds,
      reset_event_key: input.resetEventKey,
      representative_tweet_id: input.representativeTweetId,
      source_tweet_ids: input.sourceTweetIds,
      claim_source: input.claimSource,
      adopted_at: input.adoptedAt,
      claimed_at: input.claimedAt,
      created_at: input.claimedAt,
      updated_at: input.claimedAt,
    } },
    error: null,
  });

  const result = await claimTiboFormalAdoption(client, input);

  assert.equal(result.status, "claimed_new");
  assert.equal(result.record?.resetEventKey, input.resetEventKey);
  assert.deepEqual(client.calls, [{
    name: TIBO_FORMAL_ADOPTION_RPC,
    args: {
      p_logical_post_id: input.logicalPostId,
      p_logical_post_tweet_ids: input.logicalPostTweetIds,
      p_reset_event_key: input.resetEventKey,
      p_representative_tweet_id: input.representativeTweetId,
      p_source_tweet_ids: input.sourceTweetIds,
      p_claim_source: input.claimSource,
      p_identity_source: input.identitySource,
      p_adopted_at: input.adoptedAt,
      p_claimed_at: input.claimedAt,
    },
  }]);
});

test("existing and reconciled claims are not reported as newly claimed", async () => {
  for (const status of ["existing", "reconciled"] as const) {
    const client = fakeClient({
      data: { status, record: {
        id: "adoption-1",
        logical_post_id: input.logicalPostId,
        logical_post_tweet_ids: input.logicalPostTweetIds,
        reset_event_key: "tibo-reset-existing",
        representative_tweet_id: input.representativeTweetId,
        source_tweet_ids: input.sourceTweetIds,
        claim_source: "existing_history",
        adopted_at: null,
        claimed_at: input.claimedAt,
        created_at: input.claimedAt,
        updated_at: input.claimedAt,
      } },
      error: null,
    });

    const result = await claimTiboFormalAdoption(client, {
      ...input,
      adoptedAt: null,
      claimSource: "existing_history",
    });

    assert.equal(result.status, status);
    assert.equal(result.claimedNew, false);
    assert.equal(result.record?.adoptedAt, null);
  }
});

test("malformed RPC results fail closed", async () => {
  const client = fakeClient({ data: { status: "claimed_new" }, error: null });
  const result = await claimTiboFormalAdoption(client, input);

  assert.equal(result.status, "error");
  assert.ok(result.error instanceof Error);
});

test("RPC conflict reasons are retained without becoming a new claim", async () => {
  const client = fakeClient({
    data: {
      status: "conflict",
      reason: "ambiguous_existing_claims",
      record: {
        ...databaseRecord(record({
          resetEventKey: "tibo-reset-existing",
          claimSource: "existing_history",
          adoptedAt: null,
        })),
      },
    },
    error: null,
  });

  const result = await claimTiboFormalAdoption(client, input);

  assert.equal(result.status, "conflict");
  assert.equal(result.claimedNew, false);
  assert.equal(result.reason, "ambiguous_existing_claims");
});

test("a canonical non-root collision is an explicit conflict, not a new claim", async () => {
  const client = fakeClient({
    data: {
      status: "conflict",
      reason: "canonical_existing_claims",
      record: {
        ...databaseRecord(record({
          logicalPostId: "2094252447271366730",
          logicalPostTweetIds: ["2094252447271366730"],
          resetEventKey: "tibo-reset-2094252447271366730",
          representativeTweetId: "2094252447271366730",
          sourceTweetIds: ["2094252447271366730"],
          claimSource: "new_adoption",
        })),
      },
    },
    error: null,
  });

  const result = await claimTiboFormalAdoption(client, input);

  assert.equal(result.status, "conflict");
  assert.equal(result.claimedNew, false);
  assert.equal(result.reason, "canonical_existing_claims");
  assert.equal(result.record?.resetEventKey, "tibo-reset-2094252447271366730");
});

test("database migration uses an atomic claim, immutable keys, and bounded claim sources", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tibo_formal_adoptions/i);
  assert.match(sql, /logical_post_tweet_ids text\[\] NOT NULL/i);
  assert.match(sql, /source_tweet_ids text\[\] NOT NULL/i);
  assert.match(sql, /logical_post_id text NOT NULL UNIQUE/i);
  assert.match(sql, /reset_event_key text NOT NULL UNIQUE/i);
  assert.match(sql, /claim_source text NOT NULL/i);
  assert.match(sql, /btrim\(logical_post_id\) <> ''/i);
  assert.match(sql, /btrim\(reset_event_key\) <> ''/i);
  assert.match(sql, /cardinality\(logical_post_tweet_ids\) <= 6/i);
  assert.match(sql, /cardinality\(source_tweet_ids\) > 0/i);
  assert.match(sql, /Untrusted identity must be a self identity/i);
  assert.match(sql, /X API identity aliases must be numeric/i);
  assert.match(sql, /Invalid Tibo source provenance/i);
  assert.match(sql, /existing_estimate/i);
  assert.match(sql, /existing_history/i);
  assert.match(sql, /existing_dynamic/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /ON CONFLICT \(logical_post_id\) DO NOTHING/i);
  assert.match(sql, /RETURNING \*/i);
  assert.match(sql, /case when p_claim_source = 'new_adoption' then 'claimed_new' else 'existing' end/i);
  assert.match(sql, /ambiguous_existing_claims/i);
  assert.match(sql, /canonical_existing_claims/i);
  assert.match(sql, /p_claim_source <> 'new_adoption'/i);
  assert.match(sql, /v_existing\.logical_post_id <> v_selected_root/i);
  assert.match(sql, /where collision\.logical_post_id = v_selected_root/i);
  assert.match(sql, /reset_event_key is immutable/i);
  const updateBlock = sql.match(/if v_changed then[\s\S]*?return jsonb_build_object\('status', 'reconciled'/i)?.[0] ?? "";
  assert.doesNotMatch(updateBlock, /representative_tweet_id\s*=/i);
  assert.match(sql, /ALTER TABLE public\.tibo_formal_adoptions ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.tibo_formal_adoptions FROM public, anon, authenticated/i);
  assert.match(sql, /GRANT ALL PRIVILEGES ON TABLE public\.tibo_formal_adoptions TO service_role/i);
  assert.match(sql, /SECURITY INVOKER/i);
  assert.match(sql, /set search_path = pg_catalog, public, extensions/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.claim_tibo_formal_adoption/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.claim_tibo_formal_adoption/i);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*?TO\s+(?:public|anon|authenticated)/i);
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
});

test("concurrent same-chain claims with different event keys have one new claim in the atomic contract", async () => {
  const claimed = databaseRecord(record());
  let inserted = false;
  const client = {
    rpc(_name: string, _args: Record<string, unknown>) {
      if (!inserted) {
        inserted = true;
        return Promise.resolve({ data: { status: "claimed_new", record: claimed }, error: null });
      }
      return Promise.resolve({ data: { status: "existing", record: claimed }, error: null });
    },
  };

  const results = await Promise.all([
    claimTiboFormalAdoption(client, input),
    claimTiboFormalAdoption(client, {
      ...input,
      resetEventKey: "tibo-reset-2094252447271366730",
      representativeTweetId: "2094252447271366730",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "claimed_new").length, 1);
  assert.equal(results.filter((result) => result.claimedNew).length, 1);
});
