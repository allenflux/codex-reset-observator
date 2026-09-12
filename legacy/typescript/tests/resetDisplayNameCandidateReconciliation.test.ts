import assert from "node:assert/strict";
import test from "node:test";

import {
  type ResetDisplayNameCandidateStoreClient,
} from "../lib/radar/resetDisplayNameCandidateStore";
import {
  collectPersistedAuthoritativeCandidateExecutionEvidence,
  discoverMissingResetDisplayNameCandidateSeeds,
  reconcileResetDisplayNames,
  type ResetDisplayNameCandidateNotice,
} from "../lib/radar/resetDisplayNameReconciliation";
import type {
  ResetDisplayNameCandidateRecord,
  ResetDisplayNameCandidateSeed,
} from "../lib/radar/resetDisplayNameCandidateTypes";
import type { RandomResetNameGenerationResult } from "../lib/radar/randomResetNaming";
import type { RadarData, WindowEventLike } from "../lib/radar/types";
import type { TiboFormalAdoptionRecord } from "../lib/radar/tiboFormalAdoptionStore";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";

const NOW = new Date("2026-09-09T00:10:00.000Z");
const CANDIDATE_TIMESTAMP = "2026-09-08T00:00:00.000Z";

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
    createdAt: CANDIDATE_TIMESTAMP,
    updatedAt: CANDIDATE_TIMESTAMP,
    nextRetryAt: null,
    ...overrides,
  };
}

function toDatabase(value: ResetDisplayNameCandidateRecord): DatabaseCandidate {
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

function fromDatabase(value: DatabaseCandidate): ResetDisplayNameCandidateRecord {
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

function fakeCandidateStore(
  initial: ResetDisplayNameCandidateRecord[] = [],
  options: { failPromotion?: boolean } = {},
) {
  const rows = new Map(initial.map((value) => [value.candidateId, toDatabase(value)]));
  let seedWrites = 0;
  let candidateResultWrites = 0;
  let promotionWrites = 0;
  const client = {
    rpc(name: "upsert_reset_display_name_candidate_seed" | "promote_reset_display_name_candidate", args: Record<string, unknown>) {
      if (name === "promote_reset_display_name_candidate") {
        if (options.failPromotion) {
          return Promise.resolve({
            data: null,
            error: { message: "promotion failed" },
          });
        }
        const candidateId = typeof args.p_candidate_id === "string" ? args.p_candidate_id : null;
        const canonicalEventKey = typeof args.p_canonical_event_key === "string"
          ? args.p_canonical_event_key
          : null;
        const row = candidateId ? rows.get(candidateId) : undefined;
        if (!row || !canonicalEventKey) {
          return Promise.resolve({
            data: { status: "missing", canonicalWrite: false, canonicalEventKey: null },
            error: null,
          });
        }
        promotionWrites += 1;
        row.lifecycle_status = "promoted";
        row.promoted_event_key = canonicalEventKey;
        row.promoted_at = String(args.p_promoted_at ?? "");
        return Promise.resolve({
          data: { status: "promoted", canonicalWrite: true, canonicalEventKey },
          error: null,
        });
      }
      seedWrites += 1;
      const seed = args.p_seed as ResetDisplayNameCandidateSeed & {
        official_notice_tweet_id: string;
        logical_post_id: string | null;
        notice_tweet_ids: string[];
        source_tweet_ids: string[];
      };
      const existing = Array.from(rows.values()).find((row) =>
        row.official_notice_tweet_id === seed.official_notice_tweet_id ||
        row.notice_tweet_ids.some((id) => seed.notice_tweet_ids.includes(id)) ||
        (seed.logical_post_id !== null && row.logical_post_id === seed.logical_post_id),
      );
      if (!existing) {
        const created = toDatabase(candidate(`candidate-${rows.size + 1}`, {
          officialNoticeTweetId: seed.official_notice_tweet_id,
          logicalPostId: seed.logical_post_id,
          noticeTweetIds: [...seed.notice_tweet_ids],
          sourceTweetIds: [...seed.source_tweet_ids],
          noticeDedupeKey: seed.logical_post_id
            ? `logical-post:${seed.logical_post_id}`
            : `official-notice:${seed.official_notice_tweet_id}`,
        }));
        rows.set(created.candidate_id, created);
        return Promise.resolve({ data: created, error: null });
      }
      existing.logical_post_id ??= seed.logical_post_id;
      existing.notice_dedupe_key = existing.logical_post_id
        ? `logical-post:${existing.logical_post_id}`
        : `official-notice:${existing.official_notice_tweet_id}`;
      existing.notice_tweet_ids = Array.from(new Set([...existing.notice_tweet_ids, ...seed.notice_tweet_ids]));
      existing.source_tweet_ids = Array.from(new Set([...existing.source_tweet_ids, ...seed.source_tweet_ids]));
      return Promise.resolve({ data: existing, error: null });
    },
    from() {
      return {
        select() {
          const filters: Array<(row: DatabaseCandidate) => boolean> = [];
          const query = {
            eq(column: keyof DatabaseCandidate, value: unknown) {
              filters.push((row) => row[column] === value);
              return query;
            },
            order() {
              return Promise.resolve({ data: Array.from(rows.values()), error: null });
            },
            maybeSingle() {
              const row = Array.from(rows.values()).find((entry) => filters.every((filter) => filter(entry)));
              return Promise.resolve({ data: row ?? null, error: null });
            },
          };
          return query;
        },
        update(payload: Record<string, unknown>) {
          const filters: Array<(row: DatabaseCandidate) => boolean> = [];
          const query = {
            eq(column: keyof DatabaseCandidate, value: unknown) {
              filters.push((row) => row[column] === value);
              return query;
            },
            or(expression: string) {
              if (expression.startsWith("next_retry_at.is.null")) {
                const now = expression.match(/next_retry_at\.lte\.(.+)$/)?.[1] ?? "";
                filters.push((row) => row.next_retry_at === null || row.next_retry_at <= now);
              } else if (expression.startsWith("ai_status.neq.pending")) {
                const staleBefore = expression.match(/updated_at\.lt\.(.+)$/)?.[1] ?? "";
                filters.push((row) => row.ai_status !== "pending" || row.updated_at < staleBefore);
              }
              return query;
            },
            select() {
              return {
                maybeSingle() {
                  const row = Array.from(rows.values()).find((entry) => filters.every((filter) => filter(entry)));
                  if (!row) return Promise.resolve({ data: null, error: null });
                  Object.assign(row, payload);
                  if (payload.ai_status === "pending") {
                    return Promise.resolve({ data: row, error: null });
                  }
                  candidateResultWrites += 1;
                  return Promise.resolve({ data: row, error: null });
                },
              };
            },
          };
          return query;
        },
      };
    },
  } as unknown as ResetDisplayNameCandidateStoreClient;

  return {
    client,
    get rows() { return Array.from(rows.values()).map(fromDatabase); },
    get seedWrites() { return seedWrites; },
    get candidateResultWrites() { return candidateResultWrites; },
    get promotionWrites() { return promotionWrites; },
  };
}

function notice(
  id: string,
  overrides: Partial<ResetDisplayNameCandidateNotice> = {},
): ResetDisplayNameCandidateNotice {
  return {
    officialNoticeTweetId: id,
    logicalPostId: null,
    noticeTweetIds: [id],
    sourceTweetIds: [id],
    tweetCreatedAt: CANDIDATE_TIMESTAMP,
    noticeObservedAt: CANDIDATE_TIMESTAMP,
    expectedStartAt: null,
    expectedEndAt: null,
    temporalPrecision: null,
    scope: null,
    noticeType: "official_notice",
    sourceUrl: `https://x.test/${id}`,
    sourceContext: "A recorded reset announcement.",
    isExecutionBearing: true,
    ...overrides,
  };
}

function resetEvent(eventKey: string): WindowEventLike {
  const sourceTweetId = `source-${eventKey}`;
  return {
    id: eventKey,
    recordKind: "confirmed_global",
    kind: "reset_completed",
    status: "closed",
    completed_at: "2026-09-08T00:00:00.000Z",
    closed_at: "2026-09-08T00:00:00.000Z",
    sourceTweetIds: [sourceTweetId],
    source_url: `https://x.test/${sourceTweetId}`,
    details: {
      cycleType: "ランダムリセット",
      reasonType: "詫びリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "公式予告あり",
    },
  };
}

function acceptedCandidatePromotionFixture(options: { failPromotion?: boolean } = {}) {
  const officialNoticeTweetId = "2090000000000000007";
  const logicalPostId = "2090000000000000105";
  const canonicalEventKey = "canonical-precomputed-order-key";
  const candidateStorage = fakeCandidateStore([candidate("candidate-precomputed-order", {
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    officialNoticeTweetId,
    logicalPostId,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
    sourceSnapshotHash: "notice-snapshot",
    inputHash: "notice-input",
    aiNameJa: "予告済みリセット",
    aiNameEn: "Precomputed Reset",
    aiNameZh: "预计算重置",
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    generationAttempts: 1,
    lastGeneratedAt: CANDIDATE_TIMESTAMP,
  })], options);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const adoption: TiboFormalAdoptionRecord = {
    id: "adoption-precomputed-order",
    logicalPostId,
    logicalPostTweetIds: [officialNoticeTweetId],
    resetEventKey: canonicalEventKey,
    representativeTweetId: officialNoticeTweetId,
    sourceTweetIds: [officialNoticeTweetId],
    claimSource: "new_adoption",
    adoptedAt: CANDIDATE_TIMESTAMP,
    claimedAt: CANDIDATE_TIMESTAMP,
    createdAt: CANDIDATE_TIMESTAMP,
    updatedAt: CANDIDATE_TIMESTAMP,
  };
  const history = [{
    ...resetEvent(canonicalEventKey),
    sourceTweetIds: [officialNoticeTweetId],
    source_url: `https://x.test/${officialNoticeTweetId}`,
  }];

  return {
    candidateStorage,
    canonicalEventKey,
    data: {
      formal_tibo_resets: [formalNotice],
      tibo_formal_adoptions: [adoption],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: history,
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
  };
}

function sourceRow(tweetId: string) {
  return {
    tweet_id: tweetId,
    text: "A recorded reset announcement.",
    tweet_created_at: CANDIDATE_TIMESTAMP,
    is_reply: false,
    verification_status: "confirmed",
  };
}

function successResult(): RandomResetNameGenerationResult {
  return {
    name: "記録されたリセット",
    nameEn: "Recorded Reset",
    nameZh: "记录重置",
    confidence: null,
    evidence: null,
    reason: "recorded",
    evidenceGrounded: null,
    flags: [],
    status: "success",
    model: "gemini-test",
    promptVersion: "random-reset-name-v3",
    latencyMs: 1,
    httpStatus: 200,
    retryAfterSeconds: null,
  };
}

function rateLimitedResult(retryAfterSeconds: number | null): RandomResetNameGenerationResult {
  return {
    ...successResult(),
    name: null,
    nameEn: null,
    nameZh: null,
    status: "rate_limited",
    flags: ["provider_rate_limited"],
    httpStatus: 429,
    retryAfterSeconds,
  };
}

async function reconcileWithCandidateFixtures(input: {
  mode?: "off" | "seed" | "full";
  adoptionAt?: string | null;
  now?: string;
  existingCandidates?: ResetDisplayNameCandidateRecord[];
  eligibleNotices?: ResetDisplayNameCandidateNotice[];
  completedEventsNeedingNames?: number;
  maxGeminiRequests?: number;
  dryRun?: boolean;
  candidateRetryAfterSeconds?: number | null;
}) {
  const mode = input.mode ?? "off";
  const candidateStorage = fakeCandidateStore(input.existingCandidates ?? []);
  const notices = input.eligibleNotices ?? [];
  const completedCount = input.completedEventsNeedingNames ?? 0;
  const history = Array.from({ length: completedCount }, (_, index) => resetEvent(`completed-${index + 1}`));
  const sourceRows = history.flatMap((item) => sourceRow(item.sourceTweetIds?.[0] ?? ""));
  let candidateGeminiCalls = 0;
  const reconciliation = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: sourceRows,
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: history,
    sourceRows,
    now: new Date(input.now ?? NOW.toISOString()),
    apiKey: "test-key",
    maxGeminiRequests: input.maxGeminiRequests,
    dryRun: input.dryRun,
    candidateActivation: {
      mode,
      adoptionAt: input.adoptionAt ?? "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: notices,
    candidateStore: candidateStorage.client,
    candidateGenerate: async () => {
      candidateGeminiCalls += 1;
      return input.candidateRetryAfterSeconds === undefined
        ? successResult()
        : rateLimitedResult(input.candidateRetryAfterSeconds);
    },
    ensure: async (item, options) => ({
      eventKey: options.canonicalEventKey ?? item.id ?? null,
      status: "accepted",
      displayName: "Completed reset",
      inputMode: "metadata+source",
      skipped: false,
    }),
  });

  return {
    ...reconciliation,
    seedWrites: candidateStorage.seedWrites,
    candidateGeminiRequests: candidateGeminiCalls,
    candidateResultWrites: candidateStorage.candidateResultWrites,
    nextRetryAt: candidateStorage.rows[0]?.nextRetryAt ?? null,
  };
}

test("reconciler rediscovers a missing seed from an eligible signal", async () => {
  const result = await reconcileWithCandidateFixtures({
    existingCandidates: [],
    eligibleNotices: [notice("notice-1")],
    mode: "seed",
    adoptionAt: "2026-09-01T00:00:00.000Z",
    dryRun: false,
  });
  assert.equal(result.seedWrites, 1);
  assert.equal(result.candidateGeminiRequests, 0);
});

test("candidate generation uses only the remaining global budget", async () => {
  const result = await reconcileWithCandidateFixtures({
    completedEventsNeedingNames: 3,
    eligibleNotices: [notice("notice-1")],
    mode: "full",
    adoptionAt: "2026-09-01T00:00:00.000Z",
    maxGeminiRequests: 3,
  });
  assert.equal(result.geminiRequests, 3);
  assert.equal(result.candidateGeminiRequests, 0);
});

test("full mode permits candidate generation after completed work leaves budget", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "full",
    adoptionAt: "2026-09-01T00:00:00.000Z",
    eligibleNotices: [notice("notice-1")],
    maxGeminiRequests: 1,
  });
  assert.equal(result.candidateGeminiRequests, 1);
});

test("mode off does not read or write the candidate table", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "off",
    eligibleNotices: [notice("notice-1")],
  });
  assert.equal(result.seedWrites, 0);
  assert.equal(result.candidateGeminiRequests, 0);
});

test("candidate-only work never invalidates the public radar cache", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "full",
    eligibleNotices: [notice("notice-1")],
    maxGeminiRequests: 1,
  });
  assert.equal(result.invalidated, false);
});

test("a resolver-created key is not promoted without persisted authoritative evidence", async () => {
  const evidence = collectPersistedAuthoritativeCandidateExecutionEvidence([], []);
  assert.deepEqual(evidence, []);
});

test("full reconciliation promotes an accepted candidate only after persisted execution evidence", async () => {
  const officialNoticeTweetId = "2090000000000000001";
  const logicalPostId = "2090000000000000100";
  const candidateStorage = fakeCandidateStore([candidate("candidate-1", {
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    officialNoticeTweetId,
    logicalPostId,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
    sourceSnapshotHash: "notice-snapshot",
    inputHash: "notice-input",
    aiNameJa: "Astra記念リセット",
    aiNameEn: "Astra Celebration Reset",
    aiNameZh: "Astra纪念重置",
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    generationAttempts: 1,
    lastGeneratedAt: CANDIDATE_TIMESTAMP,
  })]);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const adoption: TiboFormalAdoptionRecord = {
    id: "adoption-1",
    logicalPostId,
    logicalPostTweetIds: [officialNoticeTweetId],
    resetEventKey: "canonical-event-key",
    representativeTweetId: officialNoticeTweetId,
    sourceTweetIds: [officialNoticeTweetId],
    claimSource: "new_adoption",
    adoptedAt: CANDIDATE_TIMESTAMP,
    claimedAt: CANDIDATE_TIMESTAMP,
    createdAt: CANDIDATE_TIMESTAMP,
    updatedAt: CANDIDATE_TIMESTAMP,
  };

  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [formalNotice],
      tibo_formal_adoptions: [adoption],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: [resetEvent("canonical-event-key")],
    now: NOW,
    apiKey: null,
    maxGeminiRequests: 0,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
    candidateStore: candidateStorage.client,
  });

  assert.equal(result.candidatePromotions, 1);
  assert.equal(candidateStorage.promotionWrites, 1);
  assert.equal(result.writes, 1);
  assert.equal(result.invalidated, false);
});

test("promotes an accepted authoritative candidate before completed naming", async () => {
  const fixture = acceptedCandidatePromotionFixture();
  let completedGeminiCalls = 0;
  let candidateGeminiCalls = 0;

  const result = await reconcileResetDisplayNames({
    data: fixture.data,
    canonicalHistory: fixture.canonicalHistory,
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 3,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: fixture.candidateNotices,
    candidateStore: fixture.candidateStorage.client,
    candidateGenerate: async () => {
      candidateGeminiCalls += 1;
      return successResult();
    },
    ensure: async () => {
      completedGeminiCalls += 1;
      return {
        eventKey: fixture.canonicalEventKey,
        status: "accepted",
        displayName: "Completed reset",
        inputMode: "metadata+source",
        skipped: false,
      };
    },
  });

  assert.equal(result.candidatePromotions, 1);
  assert.equal(fixture.candidateStorage.promotionWrites, 1);
  assert.equal(result.writes, 1);
  assert.equal(completedGeminiCalls, 0);
  assert.equal(candidateGeminiCalls, 0);
});

test("without an accepted candidate, completed naming remains the fallback", async () => {
  const fixture = acceptedCandidatePromotionFixture();
  const candidateStorage = fakeCandidateStore([candidate("candidate-unprocessed-order", {
    noticeDedupeKey: "logical-post:2090000000000000105",
    officialNoticeTweetId: "2090000000000000007",
    logicalPostId: "2090000000000000105",
    noticeTweetIds: ["2090000000000000007"],
    sourceTweetIds: ["2090000000000000007"],
  })]);
  let completedGeminiCalls = 0;

  const result = await reconcileResetDisplayNames({
    data: fixture.data,
    canonicalHistory: fixture.canonicalHistory,
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 3,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: fixture.candidateNotices,
    candidateStore: candidateStorage.client,
    ensure: async () => {
      completedGeminiCalls += 1;
      return {
        eventKey: fixture.canonicalEventKey,
        status: "accepted",
        displayName: "Completed reset",
        inputMode: "metadata+source",
        skipped: false,
      };
    },
  });

  assert.equal(completedGeminiCalls, 1);
  assert.equal(result.candidatePromotions, 0);
  assert.equal(candidateStorage.promotionWrites, 0);
});

test("promotion failure falls back to completed naming", async () => {
  const fixture = acceptedCandidatePromotionFixture({ failPromotion: true });
  let completedGeminiCalls = 0;

  const result = await reconcileResetDisplayNames({
    data: fixture.data,
    canonicalHistory: fixture.canonicalHistory,
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 3,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: fixture.candidateNotices,
    candidateStore: fixture.candidateStorage.client,
    ensure: async () => {
      completedGeminiCalls += 1;
      return {
        eventKey: fixture.canonicalEventKey,
        status: "accepted",
        displayName: "Completed reset",
        inputMode: "metadata+source",
        skipped: false,
      };
    },
  });

  assert.equal(completedGeminiCalls, 1);
  assert.equal(result.candidatePromotions, 0);
  assert.equal(fixture.candidateStorage.promotionWrites, 0);
});

test("official notice backed by a public-valid usage estimate can promote", async () => {
  const officialNoticeTweetId = "2090000000000000003";
  const logicalPostId = "2090000000000000102";
  const canonicalEventKey = "canonical-usage-estimate-key";
  const candidateStorage = fakeCandidateStore([candidate("candidate-estimate", {
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    officialNoticeTweetId,
    logicalPostId,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
    aiNameJa: "Usage観測リセット",
    aiNameEn: "Usage Observation Reset",
    aiNameZh: "使用量观测重置",
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    generationAttempts: 1,
    lastGeneratedAt: CANDIDATE_TIMESTAMP,
  })]);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const estimate: ResetExecutionEstimate = {
    resetEventKey: canonicalEventKey,
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-09-08T01:00:00.000Z",
    executionWindowEndAt: "2026-09-08T02:00:00.000Z",
    recoveryObservationId: "observation-usage-estimate",
    tiboSourceTweetIds: [officialNoticeTweetId],
    officialNoticeTweetId,
    estimatorVersion: "usage-execution-v1",
  };

  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [formalNotice],
      reset_execution_estimates: [estimate],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: [resetEvent(canonicalEventKey)],
    now: NOW,
    apiKey: null,
    maxGeminiRequests: 0,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
    candidateStore: candidateStorage.client,
  });

  assert.equal(result.candidatePromotions, 1);
  assert.equal(candidateStorage.promotionWrites, 1);
});

test("an estimate for an unrelated official notice cannot promote this candidate", async () => {
  const officialNoticeTweetId = "2090000000000000005";
  const unrelatedNoticeTweetId = "2090000000000000006";
  const logicalPostId = "2090000000000000104";
  const canonicalEventKey = "canonical-unrelated-estimate-key";
  const candidateStorage = fakeCandidateStore([candidate("candidate-unrelated-estimate", {
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    officialNoticeTweetId,
    logicalPostId,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
    aiNameJa: "候補リセット",
    aiNameEn: "Candidate Reset",
    aiNameZh: "候选重置",
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    generationAttempts: 1,
    lastGeneratedAt: CANDIDATE_TIMESTAMP,
  })]);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const unrelatedEstimate: ResetExecutionEstimate = {
    resetEventKey: canonicalEventKey,
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-09-08T01:00:00.000Z",
    executionWindowEndAt: "2026-09-08T02:00:00.000Z",
    recoveryObservationId: "observation-unrelated-estimate",
    tiboSourceTweetIds: [unrelatedNoticeTweetId],
    officialNoticeTweetId: unrelatedNoticeTweetId,
    estimatorVersion: "usage-execution-v1",
  };

  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [formalNotice],
      reset_execution_estimates: [unrelatedEstimate],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: [resetEvent(canonicalEventKey)],
    now: NOW,
    apiKey: null,
    maxGeminiRequests: 0,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
    candidateStore: candidateStorage.client,
  });

  assert.equal(result.candidatePromotions, 0);
  assert.equal(candidateStorage.promotionWrites, 0);
});

test("authoritative execution evidence prevents candidate Gemini generation", async () => {
  const officialNoticeTweetId = "2090000000000000004";
  const logicalPostId = "2090000000000000103";
  const canonicalEventKey = "canonical-no-candidate-generation";
  const candidateStorage = fakeCandidateStore([candidate("candidate-unprocessed", {
    officialNoticeTweetId,
    logicalPostId,
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
  })]);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const estimate: ResetExecutionEstimate = {
    resetEventKey: canonicalEventKey,
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-09-08T01:00:00.000Z",
    executionWindowEndAt: "2026-09-08T02:00:00.000Z",
    recoveryObservationId: "observation-skip-generation",
    tiboSourceTweetIds: [officialNoticeTweetId],
    officialNoticeTweetId,
    estimatorVersion: "usage-execution-v1",
  };
  let candidateGeminiCalls = 0;

  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [formalNotice],
      reset_execution_estimates: [estimate],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: [resetEvent(canonicalEventKey)],
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 1,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
    candidateStore: candidateStorage.client,
    candidateGenerate: async () => {
      candidateGeminiCalls += 1;
      return successResult();
    },
  });

  assert.equal(candidateGeminiCalls, 0);
  assert.equal(result.candidateGeminiRequests, 0);
  assert.equal(result.candidatePromotions, 0);
});

test("dry-run reconciliation never promotes an accepted candidate", async () => {
  const officialNoticeTweetId = "2090000000000000002";
  const logicalPostId = "2090000000000000101";
  const candidateStorage = fakeCandidateStore([candidate("candidate-dry-run", {
    noticeDedupeKey: `logical-post:${logicalPostId}`,
    officialNoticeTweetId,
    logicalPostId,
    noticeTweetIds: [officialNoticeTweetId],
    sourceTweetIds: [officialNoticeTweetId],
    sourceSnapshotHash: "notice-snapshot",
    inputHash: "notice-input",
    aiNameJa: "Astra記念リセット",
    aiNameEn: "Astra Celebration Reset",
    aiNameZh: "Astra纪念重置",
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    generationAttempts: 1,
    lastGeneratedAt: CANDIDATE_TIMESTAMP,
  })]);
  const formalNotice = {
    ...sourceRow(officialNoticeTweetId),
    text: "A recorded reset announcement.",
    tweet_url: `https://x.test/${officialNoticeTweetId}`,
    signal_type: "official_notice" as const,
    confidence: 1,
    verification_status: "confirmed" as const,
    logical_post_id: logicalPostId,
    edit_history_tweet_ids: [logicalPostId, officialNoticeTweetId],
    edit_version: 2,
    edit_metadata_source: "x_api" as const,
  };
  const adoption: TiboFormalAdoptionRecord = {
    id: "adoption-dry-run",
    logicalPostId,
    logicalPostTweetIds: [officialNoticeTweetId],
    resetEventKey: "canonical-dry-run-key",
    representativeTweetId: officialNoticeTweetId,
    sourceTweetIds: [officialNoticeTweetId],
    claimSource: "new_adoption",
    adoptedAt: CANDIDATE_TIMESTAMP,
    claimedAt: CANDIDATE_TIMESTAMP,
    createdAt: CANDIDATE_TIMESTAMP,
    updatedAt: CANDIDATE_TIMESTAMP,
  };
  let completedGeminiCalls = 0;
  let candidateGeminiCalls = 0;

  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [formalNotice],
      tibo_formal_adoptions: [adoption],
      reset_display_names: [],
    } as unknown as RadarData,
    canonicalHistory: [resetEvent("canonical-dry-run-key")],
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 3,
    dryRun: true,
    candidateActivation: {
      mode: "full",
      adoptionAt: "2026-09-01T00:00:00.000Z",
    },
    candidateNotices: [notice(officialNoticeTweetId, { logicalPostId })],
    candidateStore: candidateStorage.client,
    candidateGenerate: async () => {
      candidateGeminiCalls += 1;
      return successResult();
    },
    ensure: async () => {
      completedGeminiCalls += 1;
      return {
        eventKey: "canonical-dry-run-key",
        status: "accepted",
        displayName: "Completed reset",
        inputMode: "metadata+source",
        skipped: false,
      };
    },
  });

  assert.equal(result.candidatePromotions, 0);
  assert.equal(result.geminiRequests, 0);
  assert.equal(result.writes, 0);
  assert.equal(completedGeminiCalls, 0);
  assert.equal(candidateGeminiCalls, 0);
  assert.equal(candidateStorage.seedWrites, 0);
  assert.equal(candidateStorage.promotionWrites, 0);
  assert.equal(candidateStorage.rows[0]?.lifecycleStatus, "provisional");
});

test("self-healing uses persisted tweetCreatedAt rather than noticeObservedAt for the cutoff", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "seed",
    adoptionAt: "2026-09-09T00:00:00.000Z",
    eligibleNotices: [notice("notice-1", {
      tweetCreatedAt: "2026-09-08T23:59:59.999Z",
      noticeObservedAt: "2026-09-09T00:05:00.000Z",
    })],
  });
  assert.equal(result.seedWrites, 0);
});

test("a rate-limited candidate is not retried on the next ten-minute reconciliation", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "full",
    adoptionAt: "2026-09-01T00:00:00.000Z",
    now: "2026-09-09T00:10:00.000Z",
    existingCandidates: [candidate("notice-1", {
      aiStatus: "rate_limited",
      nextRetryAt: "2026-09-09T01:00:00.000Z",
    })],
    eligibleNotices: [notice("notice-1", { tweetCreatedAt: "2026-09-08T00:00:00.000Z" })],
  });
  assert.equal(result.candidateGeminiRequests, 0);
});

test("a provider retry-after longer than one hour is respected", async () => {
  const result = await reconcileWithCandidateFixtures({
    mode: "full",
    adoptionAt: "2026-09-01T00:00:00.000Z",
    now: "2026-09-09T00:00:00.000Z",
    candidateRetryAfterSeconds: 7200,
    eligibleNotices: [notice("notice-1", { tweetCreatedAt: "2026-09-08T00:00:00.000Z" })],
  });
  assert.equal(result.nextRetryAt, "2026-09-09T02:00:00.000Z");
});

test("missing seed discovery uses exact IDs and the persisted cutoff", () => {
  const seeds = discoverMissingResetDisplayNameCandidateSeeds(
    [notice("notice-1", { tweetCreatedAt: "2026-09-08T00:00:00.000Z" })],
    [],
    { mode: "seed", adoptionAt: "2026-09-01T00:00:00.000Z" },
  );
  assert.deepEqual(seeds.map((seed) => seed.officialNoticeTweetId), ["notice-1"]);
  assert.equal(seeds[0]?.logicalPostId, null);
});

test("authoritative evidence comes only from formal adoption and monitor usage estimates", () => {
  const ledgers = [{ resetEventKey: "formal-1" }] as TiboFormalAdoptionRecord[];
  const estimates = [{
    resetEventKey: "estimate-1",
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-09-08T01:00:00.000Z",
    executionWindowEndAt: "2026-09-08T02:00:00.000Z",
    recoveryObservationId: "observation-1",
    tiboSourceTweetIds: ["notice-1"],
    officialNoticeTweetId: "notice-1",
    estimatorVersion: "usage-execution-v1",
  }] as ResetExecutionEstimate[];
  assert.deepEqual(
    collectPersistedAuthoritativeCandidateExecutionEvidence(ledgers, estimates),
    [
      { resetEventKey: "formal-1", kind: "formal_adoption" },
      { resetEventKey: "estimate-1", kind: "monitor_usage_estimate" },
    ],
  );
});

test("non-public execution estimates are not authoritative candidate evidence", () => {
  const base = {
    resetEventKey: "estimate-invalid",
    displayExecutionAt: "2026-09-08T02:00:00.000Z",
    executionTimeSource: "usage_observation" as const,
    executionTimeConfidence: "high" as const,
    executionTimePrecision: "approximate" as const,
    executionWindowStartAt: "2026-09-08T01:00:00.000Z",
    executionWindowEndAt: "2026-09-08T02:00:00.000Z",
    recoveryObservationId: "observation-invalid",
    tiboSourceTweetIds: ["notice-1"],
    officialNoticeTweetId: "notice-1",
    estimatorVersion: "usage-execution-v1",
  } satisfies ResetExecutionEstimate;
  const variants: ResetExecutionEstimate[] = [
    { ...base, executionTimeConfidence: "low" },
    { ...base, executionTimePrecision: "window" },
    { ...base, executionWindowStartAt: "2026-09-08T02:00:00.000Z" },
    { ...base, displayExecutionAt: "2026-09-08T01:59:59.000Z" },
  ];

  for (const variant of variants) {
    assert.deepEqual(collectPersistedAuthoritativeCandidateExecutionEvidence([], [variant]), []);
  }
});
