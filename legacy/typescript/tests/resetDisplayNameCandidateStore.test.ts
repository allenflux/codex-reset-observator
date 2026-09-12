import assert from "node:assert/strict";
import test from "node:test";

import {
  claimResetDisplayNameCandidateGeneration,
  listResetDisplayNameCandidates,
  upsertResetDisplayNameCandidateSeed,
  writeResetDisplayNameCandidateGeneration,
  type ResetDisplayNameCandidateStoreClient,
} from "../lib/radar/resetDisplayNameCandidateStore";
import type {
  ResetDisplayNameCandidateRecord,
} from "../lib/radar/resetDisplayNameCandidateTypes";
import type { RandomResetNameGenerationResult } from "../lib/radar/randomResetNaming";

type DatabaseCandidate = {
  candidate_id: string;
  notice_dedupe_key: string;
  official_notice_tweet_id: string;
  logical_post_id: string | null;
  notice_tweet_ids: string[];
  source_tweet_ids: string[];
  source_snapshot_hash: string | null;
  input_hash: string | null;
  next_retry_at: string | null;
  ai_name_ja: string | null;
  ai_name_en: string | null;
  ai_name_zh: string | null;
  ai_confidence: number | null;
  ai_evidence: string | null;
  ai_reason: string | null;
  ai_flags: string[];
  ai_model: string | null;
  ai_prompt_version: string | null;
  ai_input_mode: string | null;
  ai_status: ResetDisplayNameCandidateRecord["aiStatus"];
  lifecycle_status: ResetDisplayNameCandidateRecord["lifecycleStatus"];
  generation_attempts: number;
  last_generated_at: string | null;
  promoted_event_key: string | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
};

type FakeCandidateClient = ResetDisplayNameCandidateStoreClient & {
  rows: Map<string, DatabaseCandidate>;
  seedWrites: Array<Record<string, unknown>>;
  claimWrites: Array<Record<string, unknown>>;
  resultWrites: Array<Record<string, unknown>>;
};

const timestamp = "2026-09-08T00:00:00.000Z";

function candidate(
  id: string,
  overrides: Partial<ResetDisplayNameCandidateRecord> = {},
): ResetDisplayNameCandidateRecord {
  return {
    candidateId: id,
    noticeDedupeKey: `official-notice:${id}`,
    officialNoticeTweetId: id,
    logicalPostId: null,
    noticeTweetIds: [id],
    sourceTweetIds: [id],
    sourceSnapshotHash: null,
    inputHash: null,
    aiNameJa: null,
    aiNameEn: null,
    aiNameZh: null,
    aiConfidence: null,
    aiEvidence: null,
    aiReason: null,
    aiFlags: [],
    aiModel: null,
    aiPromptVersion: null,
    aiInputMode: null,
    aiStatus: "unprocessed",
    lifecycleStatus: "provisional",
    generationAttempts: 0,
    lastGeneratedAt: null,
    promotedEventKey: null,
    promotedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRetryAt: null,
    ...overrides,
  };
}

function databaseCandidate(value: ResetDisplayNameCandidateRecord): DatabaseCandidate {
  return {
    candidate_id: value.candidateId,
    notice_dedupe_key: value.noticeDedupeKey,
    official_notice_tweet_id: value.officialNoticeTweetId,
    logical_post_id: value.logicalPostId,
    notice_tweet_ids: [...value.noticeTweetIds],
    source_tweet_ids: [...value.sourceTweetIds],
    source_snapshot_hash: value.sourceSnapshotHash,
    input_hash: value.inputHash,
    next_retry_at: value.nextRetryAt,
    ai_name_ja: value.aiNameJa,
    ai_name_en: value.aiNameEn,
    ai_name_zh: value.aiNameZh,
    ai_confidence: value.aiConfidence,
    ai_evidence: value.aiEvidence,
    ai_reason: value.aiReason,
    ai_flags: [...value.aiFlags],
    ai_model: value.aiModel,
    ai_prompt_version: value.aiPromptVersion,
    ai_input_mode: value.aiInputMode,
    ai_status: value.aiStatus,
    lifecycle_status: value.lifecycleStatus,
    generation_attempts: value.generationAttempts,
    last_generated_at: value.lastGeneratedAt,
    promoted_event_key: value.promotedEventKey,
    promoted_at: value.promotedAt,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function fromDatabaseCandidate(value: DatabaseCandidate): ResetDisplayNameCandidateRecord {
  return {
    candidateId: value.candidate_id,
    noticeDedupeKey: value.notice_dedupe_key,
    officialNoticeTweetId: value.official_notice_tweet_id,
    logicalPostId: value.logical_post_id,
    noticeTweetIds: [...value.notice_tweet_ids],
    sourceTweetIds: [...value.source_tweet_ids],
    sourceSnapshotHash: value.source_snapshot_hash,
    inputHash: value.input_hash,
    nextRetryAt: value.next_retry_at,
    aiNameJa: value.ai_name_ja,
    aiNameEn: value.ai_name_en,
    aiNameZh: value.ai_name_zh,
    aiConfidence: value.ai_confidence,
    aiEvidence: value.ai_evidence,
    aiReason: value.ai_reason,
    aiFlags: [...value.ai_flags],
    aiModel: value.ai_model,
    aiPromptVersion: value.ai_prompt_version,
    aiInputMode: value.ai_input_mode,
    aiStatus: value.ai_status,
    lifecycleStatus: value.lifecycle_status,
    generationAttempts: value.generation_attempts,
    lastGeneratedAt: value.last_generated_at,
    promotedEventKey: value.promoted_event_key,
    promotedAt: value.promoted_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values)).sort();
}

function fakeCandidateClient(): FakeCandidateClient {
  const rows = new Map<string, DatabaseCandidate>();
  const seedWrites: Array<Record<string, unknown>> = [];
  const claimWrites: Array<Record<string, unknown>> = [];
  const resultWrites: Array<Record<string, unknown>> = [];

  const client = {
    rows,
    seedWrites,
    claimWrites,
    resultWrites,
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== "upsert_reset_display_name_candidate_seed") {
        return Promise.resolve({ data: null, error: new Error("unexpected RPC") });
      }
      seedWrites.push(args);
      const seed = args.p_seed as {
        official_notice_tweet_id: string;
        logical_post_id: string | null;
        notice_tweet_ids: string[];
        source_tweet_ids: string[];
      };
      const byOfficial = Array.from(rows.values()).find((row) =>
        row.official_notice_tweet_id === seed.official_notice_tweet_id);
      const noticeAliases = new Set([seed.official_notice_tweet_id, ...seed.notice_tweet_ids]);
      const byAlias = Array.from(rows.values()).find((row) =>
        row.notice_tweet_ids.some((id) => noticeAliases.has(id)));
      const byLogical = seed.logical_post_id === null
        ? undefined
        : Array.from(rows.values()).find((row) => row.logical_post_id === seed.logical_post_id);
      const identities = [byOfficial, byAlias, byLogical].filter((row): row is DatabaseCandidate => Boolean(row));
      const distinctCandidates = Array.from(new Map(
        identities.map((row) => [row.candidate_id, row]),
      ).values());
      if (distinctCandidates.length > 1) {
        return Promise.resolve({ data: null, error: new Error("Candidate seed identity conflict") });
      }
      const existing = distinctCandidates[0];
      if (existing && existing.logical_post_id !== null && seed.logical_post_id !== null &&
        existing.logical_post_id !== seed.logical_post_id) {
        return Promise.resolve({ data: null, error: new Error("Candidate seed identity conflict") });
      }
      if (!existing) {
        const id = `candidate-${rows.size + 1}`;
        const record = databaseCandidate(candidate(id, {
          noticeDedupeKey: seed.logical_post_id
            ? `logical-post:${seed.logical_post_id}`
            : `official-notice:${seed.official_notice_tweet_id}`,
          officialNoticeTweetId: seed.official_notice_tweet_id,
          logicalPostId: seed.logical_post_id,
          noticeTweetIds: unique(seed.notice_tweet_ids),
          sourceTweetIds: unique(seed.source_tweet_ids),
        }));
        rows.set(id, record);
        return Promise.resolve({ data: record, error: null });
      }
      const effectiveLogicalPostId = existing.logical_post_id ?? seed.logical_post_id;
      existing.notice_dedupe_key = effectiveLogicalPostId
        ? `logical-post:${effectiveLogicalPostId}`
        : `official-notice:${seed.official_notice_tweet_id}`;
      existing.logical_post_id = seed.logical_post_id ?? existing.logical_post_id;
      existing.notice_tweet_ids = unique([...existing.notice_tweet_ids, ...seed.notice_tweet_ids]);
      existing.source_tweet_ids = unique([...existing.source_tweet_ids, ...seed.source_tweet_ids]);
      return Promise.resolve({ data: existing, error: null });
    },
    from(_table: "reset_display_name_candidates") {
      return {
        select() {
          const filters: Array<(row: DatabaseCandidate) => boolean> = [];
          const selection = {
            eq(column: keyof DatabaseCandidate, value: unknown) {
              filters.push((row) => row[column] === value);
              return selection;
            },
            order() {
              return Promise.resolve({ data: Array.from(rows.values()), error: null });
            },
            maybeSingle() {
              const row = Array.from(rows.values()).find((entry) => filters.every((filter) => filter(entry)));
              return Promise.resolve({ data: row ?? null, error: null });
            },
          };
          return selection;
        },
        update(payload: Record<string, unknown>) {
          const filters: Array<(row: DatabaseCandidate) => boolean> = [];
          const update = {
            eq(column: keyof DatabaseCandidate, value: unknown) {
              filters.push((row) => row[column] === value);
              return update;
            },
            or(expression: string) {
              if (expression.startsWith("next_retry_at.is.null")) {
                const now = expression.match(/next_retry_at\.lte\.(.+)$/)?.[1] ?? "";
                filters.push((row) => row.next_retry_at === null || row.next_retry_at <= now);
              } else if (expression.startsWith("ai_status.neq.pending")) {
                const staleBefore = expression.match(/updated_at\.lt\.(.+)$/)?.[1] ?? "";
                filters.push((row) => row.ai_status !== "pending" || row.updated_at < staleBefore);
              }
              return update;
            },
            select() {
              return {
                maybeSingle() {
                  const row = Array.from(rows.values()).find((entry) => filters.every((filter) => filter(entry)));
                  if (!row) return Promise.resolve({ data: null, error: null });
                  Object.assign(row, payload);
                  if ("ai_status" in payload && payload.ai_status === "pending") claimWrites.push(payload);
                  else resultWrites.push(payload);
                  return Promise.resolve({ data: row, error: null });
                },
              };
            },
          };
          return update;
        },
      };
    },
  };
  return client as FakeCandidateClient;
}

async function claimCandidate(
  client: FakeCandidateClient,
  candidateId: string,
  sourceSnapshotHash: string,
  inputHash: string,
  now: string,
) {
  const claimed = await claimResetDisplayNameCandidateGeneration(client, {
    candidateId,
    sourceSnapshotHash,
    inputHash,
    now,
    stalePendingBefore: "2026-09-07T00:00:00.000Z",
  });
  assert.ok(claimed);
  return claimed.updatedAt;
}

function rateLimitedResult(retryAfterSeconds: number | null): RandomResetNameGenerationResult {
  return {
    name: null,
    nameEn: null,
    nameZh: null,
    confidence: null,
    evidence: null,
    reason: null,
    evidenceGrounded: null,
    flags: ["provider_rate_limited"],
    status: "rate_limited",
    model: "gemini-test",
    promptVersion: "random-reset-name-v3",
    latencyMs: 1,
    httpStatus: 429,
    retryAfterSeconds,
  };
}

test("seed has no hashes or AI result and is unprocessed", async () => {
  const client = fakeCandidateClient();
  const record = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  assert.equal(record.aiStatus, "unprocessed");
  assert.equal(record.sourceSnapshotHash, null);
  assert.equal(record.inputHash, null);
  assert.equal(record.promotedEventKey, null);
});

test("trusted logical identity upgrades the same fallback row and unions provenance", async () => {
  const client = fakeCandidateClient();
  const first = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const upgraded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1", "notice-2"],
    sourceTweetIds: ["notice-1", "source-2"],
  });

  assert.equal(upgraded.candidateId, first.candidateId);
  assert.equal(upgraded.logicalPostId, "logical-1");
  assert.deepEqual(upgraded.noticeTweetIds, ["notice-1", "notice-2"]);
  assert.deepEqual(upgraded.sourceTweetIds, ["notice-1", "source-2"]);
});

test("a trusted logical identity is never downgraded by a logical-null retry", async () => {
  const client = fakeCandidateClient();
  const first = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  const retried = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  assert.equal(retried.candidateId, first.candidateId);
  assert.equal(retried.logicalPostId, "logical-1");
  assert.equal(retried.noticeDedupeKey, "logical-post:logical-1");
});

test("a trusted edit alias rediscovers the same candidate on an old logical-null retry", async () => {
  const client = fakeCandidateClient();
  const initial = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const trustedEdit = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-2",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1", "notice-2"],
    sourceTweetIds: ["notice-1", "notice-2"],
  });
  const oldRetry = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  assert.equal(trustedEdit.candidateId, initial.candidateId);
  assert.equal(trustedEdit.officialNoticeTweetId, "notice-1");
  assert.equal(oldRetry.candidateId, initial.candidateId);
  assert.equal(oldRetry.officialNoticeTweetId, "notice-1");
  assert.equal(oldRetry.noticeDedupeKey, "logical-post:logical-1");
  assert.deepEqual(oldRetry.noticeTweetIds, ["notice-1", "notice-2"]);
});

test("a conflicting trusted logical identity fails without changing the candidate", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["source-1"],
  });
  const before = client.rows.get(seeded.candidateId)!;
  const beforeSnapshot = {
    ...before,
    notice_tweet_ids: [...before.notice_tweet_ids],
    source_tweet_ids: [...before.source_tweet_ids],
  };

  await assert.rejects(() => upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-2",
    noticeTweetIds: ["notice-1", "notice-2"],
    sourceTweetIds: ["source-1", "source-2"],
  }), /conflict/i);

  assert.deepEqual(client.rows.get(seeded.candidateId), beforeSnapshot);
});

test("a seed identity collision is reported without merging candidates", async () => {
  const client = fakeCandidateClient();
  await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-2",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-2"],
    sourceTweetIds: ["notice-2"],
  });

  await assert.rejects(() => upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  }), /conflict/i);
  assert.equal(client.rows.size, 2);
});

test("list maps stored candidates without introducing canonical event identity", async () => {
  const client = fakeCandidateClient();
  await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["source-1"],
  });

  const records = await listResetDisplayNameCandidates(client);

  assert.deepEqual(records.map((record) => ({
    candidateId: record.candidateId,
    logicalPostId: record.logicalPostId,
    promotedEventKey: record.promotedEventKey,
  })), [{
    candidateId: "candidate-1",
    logicalPostId: "logical-1",
    promotedEventKey: null,
  }]);
});

test("claim rejects blank hashes and cooldown rows", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const row = client.rows.get(seeded.candidateId)!;
  row.next_retry_at = "2026-09-08T02:00:00.000Z";

  assert.equal(await claimResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "",
    inputHash: "input-hash",
    now: "2026-09-08T01:00:00.000Z",
    stalePendingBefore: "2026-09-08T00:30:00.000Z",
  }), null);
  assert.equal(await claimResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    now: "2026-09-08T01:00:00.000Z",
    stalePendingBefore: "2026-09-08T00:30:00.000Z",
  }), null);
  assert.equal(client.claimWrites.length, 0);
});

test("claim stores hashes and reclaims a stale pending candidate", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const row = client.rows.get(seeded.candidateId)!;
  row.ai_status = "pending";
  row.updated_at = "2026-09-08T00:00:00.000Z";

  const claimed = await claimResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    now: "2026-09-08T01:00:00.000Z",
    stalePendingBefore: "2026-09-08T00:30:00.000Z",
  });

  assert.equal(claimed?.aiStatus, "pending");
  assert.equal(claimed?.sourceSnapshotHash, "source-hash");
  assert.equal(claimed?.inputHash, "input-hash");
  assert.equal(claimed?.updatedAt, "2026-09-08T01:00:00.000Z");
});

test("rate-limited results preserve flags, increment attempts, and wait at least one hour", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  const claimedAt = await claimCandidate(
    client,
    seeded.candidateId,
    "source-hash",
    "input-hash",
    "2026-09-08T00:00:00.000Z",
  );
  await writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "rate_limited",
    aiInputMode: "notice-precompute-v1",
    result: rateLimitedResult(null),
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T00:00:00.000Z",
    claimedAt,
  });

  const record = fromDatabaseCandidate(client.rows.get(seeded.candidateId)!);
  assert.equal(record.aiStatus, "rate_limited");
  assert.equal(record.generationAttempts, 1);
  assert.deepEqual(record.aiFlags, ["provider_rate_limited"]);
  assert.equal(record.nextRetryAt, "2026-09-08T01:00:00.000Z");
});

test("longer provider retry timing wins and terminal results clear cooldown", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const result = rateLimitedResult(7_200);

  const firstClaimedAt = await claimCandidate(
    client,
    seeded.candidateId,
    "source-hash",
    "input-hash",
    "2026-09-08T00:00:00.000Z",
  );
  await writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "rate_limited",
    aiInputMode: "notice-precompute-v1",
    result,
    retryAfterSeconds: result.retryAfterSeconds,
    generatedAt: "2026-09-08T00:00:00.000Z",
    claimedAt: firstClaimedAt,
  });
  const secondClaimedAt = await claimCandidate(
    client,
    seeded.candidateId,
    "source-hash-2",
    "input-hash-2",
    "2026-09-08T03:00:00.000Z",
  );
  await writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash-2",
    inputHash: "input-hash-2",
    aiStatus: "api_error",
    aiInputMode: "notice-precompute-v1",
    result: { ...result, flags: ["api_error"], status: "api_error", retryAfterSeconds: null },
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T03:00:00.000Z",
    claimedAt: secondClaimedAt,
  });

  const record = fromDatabaseCandidate(client.rows.get(seeded.candidateId)!);
  assert.equal(client.resultWrites[0]?.next_retry_at, "2026-09-08T02:00:00.000Z");
  assert.equal(record.generationAttempts, 2);
  assert.equal(record.nextRetryAt, null);
  assert.deepEqual(record.aiFlags, ["api_error"]);
});

test("generation results cannot mutate a promoted candidate", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const row = client.rows.get(seeded.candidateId)!;
  row.lifecycle_status = "promoted";
  row.ai_status = "accepted";
  row.ai_name_ja = "Promoted name";

  await assert.rejects(() => writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "new-source-hash",
    inputHash: "new-input-hash",
    aiStatus: "accepted",
    aiInputMode: "notice-precompute-v1",
    result: {
      ...rateLimitedResult(null),
      status: "success",
      name: "New name",
      nameEn: "New name Reset",
      nameZh: "新名称重置",
      flags: [],
      retryAfterSeconds: null,
    },
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T04:00:00.000Z",
    claimedAt: "2026-09-08T04:00:00.000Z",
  }), /did not find the candidate/);

  assert.equal(row.lifecycle_status, "promoted");
  assert.equal(row.ai_name_ja, "Promoted name");
  assert.equal(client.resultWrites.length, 0);
});

test("a result write without a claim token is rejected", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  await assert.rejects(() => writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "api_error",
    aiInputMode: "notice-precompute-v1",
    result: rateLimitedResult(null),
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T00:00:00.000Z",
    claimedAt: "",
  }), /claim token/);
  assert.equal(client.resultWrites.length, 0);
});

test("seed and claim statuses cannot be written as generation results", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });

  for (const aiStatus of ["unprocessed", "pending"] as const) {
    await assert.rejects(() => writeResetDisplayNameCandidateGeneration(client, {
      candidateId: seeded.candidateId,
      sourceSnapshotHash: "source-hash",
      inputHash: "input-hash",
      aiStatus,
      aiInputMode: "notice-precompute-v1",
      result: rateLimitedResult(null),
      retryAfterSeconds: null,
      generatedAt: "2026-09-08T00:00:00.000Z",
      claimedAt: "claim-token",
    } as never), /seed or claim status/);
  }
  assert.equal(client.resultWrites.length, 0);
});

test("a claim owner can write only its matching result", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const claimedAt = await claimCandidate(
    client,
    seeded.candidateId,
    "source-hash",
    "input-hash",
    "2026-09-08T00:00:00.000Z",
  );

  await writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "api_error",
    aiInputMode: "notice-precompute-v1",
    result: rateLimitedResult(null),
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T00:00:00.000Z",
    claimedAt,
  });

  assert.equal(client.resultWrites.length, 1);
});

test("a stale worker cannot overwrite a reclaimed candidate result", async () => {
  const client = fakeCandidateClient();
  const seeded = await upsertResetDisplayNameCandidateSeed(client, {
    officialNoticeTweetId: "notice-1",
    logicalPostId: null,
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
  });
  const staleClaimedAt = await claimCandidate(
    client,
    seeded.candidateId,
    "source-hash",
    "input-hash",
    "2026-09-08T00:00:00.000Z",
  );
  const freshClaimedAt = await (async () => {
    const claimed = await claimResetDisplayNameCandidateGeneration(client, {
      candidateId: seeded.candidateId,
      sourceSnapshotHash: "source-hash",
      inputHash: "input-hash",
      now: "2026-09-08T01:00:00.000Z",
      stalePendingBefore: "2026-09-08T00:30:00.000Z",
    });
    assert.ok(claimed);
    return claimed.updatedAt;
  })();

  await writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "api_error",
    aiInputMode: "notice-precompute-v1",
    result: rateLimitedResult(null),
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T01:00:00.000Z",
    claimedAt: freshClaimedAt,
  });
  await assert.rejects(() => writeResetDisplayNameCandidateGeneration(client, {
    candidateId: seeded.candidateId,
    sourceSnapshotHash: "source-hash",
    inputHash: "input-hash",
    aiStatus: "api_error",
    aiInputMode: "notice-precompute-v1",
    result: { ...rateLimitedResult(null), flags: ["stale_worker"] },
    retryAfterSeconds: null,
    generatedAt: "2026-09-08T02:00:00.000Z",
    claimedAt: staleClaimedAt,
  }), /did not find the candidate/);

  assert.equal(client.resultWrites.length, 1);
  assert.deepEqual(client.rows.get(seeded.candidateId)?.ai_flags, ["provider_rate_limited"]);
});
