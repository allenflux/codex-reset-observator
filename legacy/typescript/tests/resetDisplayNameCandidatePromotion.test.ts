import assert from "node:assert/strict";
import test from "node:test";

import {
  promoteResetDisplayNameCandidate,
  type PromoteResetDisplayNameCandidateInput,
  type ResetDisplayNameCandidateStoreClient,
} from "../lib/radar/resetDisplayNameCandidateStore";
import type { ResetDisplayNameCandidateRecord } from "../lib/radar/resetDisplayNameCandidateTypes";
import type { ResetDisplayNameRecord } from "../lib/radar/types";

const CANDIDATE_ID = "candidate-1";
const CREATED_AT = "2026-09-08T00:00:00.000Z";

function acceptedCandidate(
  overrides: Partial<ResetDisplayNameCandidateRecord> = {},
): ResetDisplayNameCandidateRecord {
  return {
    candidateId: CANDIDATE_ID,
    noticeDedupeKey: "official-notice:notice-1",
    officialNoticeTweetId: "notice-1",
    logicalPostId: "logical-1",
    noticeTweetIds: ["notice-1"],
    sourceTweetIds: ["notice-1"],
    sourceSnapshotHash: "source-hash",
    inputHash: "notice-input-hash",
    aiNameJa: "Astra記念リセット",
    aiNameEn: "Astra Celebration Reset",
    aiNameZh: "Astra纪念重置",
    aiConfidence: null,
    aiEvidence: null,
    aiReason: "notice-based accepted name",
    aiFlags: [],
    aiModel: "gemini-3.5-flash-lite",
    aiPromptVersion: "random-reset-name-v3",
    aiInputMode: "notice-precompute-v1",
    aiStatus: "accepted",
    lifecycleStatus: "provisional",
    generationAttempts: 1,
    lastGeneratedAt: CREATED_AT,
    promotedEventKey: null,
    promotedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    nextRetryAt: null,
    ...overrides,
  };
}

function promotionInput(canonicalEventKey: string): PromoteResetDisplayNameCandidateInput {
  return {
    candidateId: CANDIDATE_ID,
    canonicalEventKey,
    canonicalSourceTweetId: "notice-1",
    promotedAt: "2026-09-09T00:00:00.000Z",
    identityResolution: {
      status: "existing",
      resetEventKey: canonicalEventKey,
      matchedEvidenceEventKey: canonicalEventKey,
    },
    authoritativeEvidence: [{
      resetEventKey: canonicalEventKey,
      kind: "formal_adoption",
    }],
  };
}

type FakePromotionClient = ResetDisplayNameCandidateStoreClient & {
  candidate: ResetDisplayNameCandidateRecord;
  canonical: ResetDisplayNameRecord | null;
  canonicalWrites: number;
  rpcCalls: number;
};

function fakePromotionClient(
  candidate: ResetDisplayNameCandidateRecord,
  options: { canonicalNameState?: "missing" | "manual" | "accepted" | "review_required" } = {},
): FakePromotionClient {
  let canonicalEventKey: string | null = candidate.promotedEventKey;
  const canonical = options.canonicalNameState === "missing"
    ? null
    : {
        event_key: "canonical-event-1",
        source_tweet_id: "old-source",
        manual_name_ja: options.canonicalNameState === "manual" ? "手動リセット" : null,
        manual_name_en: options.canonicalNameState === "manual" ? "Manual Reset" : null,
        manual_name_zh: options.canonicalNameState === "manual" ? "手动重置" : null,
        ai_name_ja: options.canonicalNameState === "review_required" ? "古い不安全な名前" : "既存AI名",
        ai_name_en: options.canonicalNameState === "review_required" ? "Old unsafe name" : "Existing AI name",
        ai_name_zh: options.canonicalNameState === "review_required" ? "旧的不安全名称" : "现有AI名称",
        ai_confidence: 0.2,
        ai_evidence: "old evidence",
        ai_reason: "old reason",
        ai_model: "old-model",
        ai_prompt_version: "old-prompt",
        ai_input_mode: "completed-event-v1",
        ai_status: options.canonicalNameState === "review_required" ? "review_required" : "accepted",
        ai_flags: options.canonicalNameState === "review_required" ? ["old-unsafe"] : [],
        ai_generated_at: CREATED_AT,
        input_hash: "old-hash",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      } satisfies ResetDisplayNameRecord;
  const client = {
    candidate,
    canonical,
    canonicalWrites: 0,
    rpcCalls: 0,
    rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "promote_reset_display_name_candidate");
      this.rpcCalls += 1;
      const requestedKey = args.p_canonical_event_key;
      if (typeof requestedKey !== "string") {
        return Promise.resolve({ data: null, error: new Error("invalid key") });
      }
      if (canonicalEventKey && canonicalEventKey !== requestedKey) {
        return Promise.resolve({
          data: { status: "conflict", canonicalWrite: false, canonicalEventKey },
          error: null,
        });
      }
      if (canonicalEventKey === requestedKey) {
        return Promise.resolve({
          data: { status: "already_promoted", canonicalWrite: false, canonicalEventKey },
          error: null,
        });
      }
      if (this.candidate.aiStatus !== "accepted") {
        return Promise.resolve({
          data: { status: "not_accepted", canonicalWrite: false, canonicalEventKey: null },
          error: null,
        });
      }
      canonicalEventKey = requestedKey;
      this.candidate.promotedEventKey = requestedKey;
      this.candidate.promotedAt = String(args.p_promoted_at);
      this.candidate.lifecycleStatus = "promoted";
      if (options.canonicalNameState === "missing") {
        this.canonicalWrites += 1;
      } else if (options.canonicalNameState === "review_required" && this.canonical) {
        this.canonical = {
          ...this.canonical,
          ai_name_ja: this.candidate.aiNameJa,
          ai_name_en: this.candidate.aiNameEn,
          ai_name_zh: this.candidate.aiNameZh,
          ai_confidence: this.candidate.aiConfidence,
          ai_evidence: this.candidate.aiEvidence,
          ai_reason: this.candidate.aiReason,
          ai_model: this.candidate.aiModel,
          ai_prompt_version: this.candidate.aiPromptVersion,
          ai_input_mode: this.candidate.aiInputMode,
          ai_status: "accepted",
          ai_flags: [...this.candidate.aiFlags],
          ai_generated_at: this.candidate.lastGeneratedAt,
          input_hash: this.candidate.inputHash,
        };
        this.canonicalWrites += 1;
      }
      const canonicalChanged = options.canonicalNameState === "missing" ||
        options.canonicalNameState === "review_required";
      return Promise.resolve({
        data: {
          status: canonicalChanged ? "promoted" : "reused",
          canonicalWrite: canonicalChanged,
          canonicalEventKey: requestedKey,
        },
        error: null,
      });
    },
    from() {
      throw new Error("promotion wrapper should use the atomic RPC");
    },
  } as FakePromotionClient;
  return client;
}

test("promotion is idempotent and never changes the candidate identity", async () => {
  const client = fakePromotionClient(acceptedCandidate(), { canonicalNameState: "missing" });
  const input = promotionInput("canonical-event-1");
  const first = await promoteResetDisplayNameCandidate(client, input);
  const second = await promoteResetDisplayNameCandidate(client, input);
  assert.equal(first.status, "promoted");
  assert.equal(second.status, "already_promoted");
  assert.equal(client.canonicalWrites, 1);
  assert.equal(client.candidate.candidateId, input.candidateId);
});
test("a different canonical key after promotion is a conflict", async () => {
  const client = fakePromotionClient(acceptedCandidate({ promotedEventKey: "canonical-event-1" }));
  const result = await promoteResetDisplayNameCandidate(client, promotionInput("canonical-event-2"));
  assert.equal(result.status, "conflict");
});

test("a non-null key from resolver status new never reaches the promotion RPC", async () => {
  const client = fakePromotionClient(acceptedCandidate());
  const result = await promoteResetDisplayNameCandidate(client, {
    ...promotionInput("tibo-reset-new"),
    identityResolution: {
      status: "new",
      resetEventKey: "tibo-reset-new",
      matchedEvidenceEventKey: null,
    },
    authoritativeEvidence: [],
  });
  assert.equal(result.status, "not_authoritative");
  assert.equal(client.rpcCalls, 0);
  assert.equal(client.canonicalWrites, 0);
});

test("an existing key with persisted formal adoption evidence is promotable", async () => {
  const client = fakePromotionClient(acceptedCandidate(), { canonicalNameState: "missing" });
  const result = await promoteResetDisplayNameCandidate(client, promotionInput("canonical-event-1"));
  assert.equal(result.status, "promoted");
  assert.equal(client.rpcCalls, 1);
});

test("a candidate without accepted names is not promoted", async () => {
  const client = fakePromotionClient(acceptedCandidate({ aiStatus: "null", aiNameJa: null }));
  const result = await promoteResetDisplayNameCandidate(client, promotionInput("canonical-event-1"));
  assert.equal(result.status, "not_accepted");
  assert.equal(client.rpcCalls, 1);
  assert.equal(client.canonicalWrites, 0);
});

test("manual or existing accepted canonical names are reused without replacement", async () => {
  const client = fakePromotionClient(acceptedCandidate(), { canonicalNameState: "accepted" });
  const result = await promoteResetDisplayNameCandidate(client, promotionInput("canonical-event-1"));
  assert.equal(result.status, "reused");
  assert.equal(result.canonicalWrite, false);
  assert.equal(client.canonicalWrites, 0);
});

test("promotion replaces unsafe nonaccepted canonical AI names with the accepted candidate", async () => {
  const client = fakePromotionClient(acceptedCandidate(), { canonicalNameState: "review_required" });
  const result = await promoteResetDisplayNameCandidate(client, promotionInput("canonical-event-1"));

  assert.equal(result.status, "promoted");
  assert.equal(result.canonicalWrite, true);
  assert.equal(client.canonical?.ai_name_ja, "Astra記念リセット");
  assert.equal(client.canonical?.ai_name_en, "Astra Celebration Reset");
  assert.equal(client.canonical?.ai_name_zh, "Astra纪念重置");
  assert.equal(client.canonical?.ai_status, "accepted");
  assert.deepEqual(client.canonical?.ai_flags, []);
  assert.equal(client.canonical?.input_hash, "notice-input-hash");
  assert.equal(client.canonical?.ai_input_mode, "notice-precompute-v1");
  assert.equal(client.canonical?.manual_name_ja, null);
  assert.equal(client.canonicalWrites, 1);
});
