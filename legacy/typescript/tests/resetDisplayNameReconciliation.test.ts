import assert from "node:assert/strict";
import test from "node:test";

import {
  getCompletedResetTimestamp,
} from "../lib/radar/probability";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import {
  isAutoNameableCanonicalEvent,
  reconcileResetDisplayNames,
} from "../lib/radar/resetDisplayNameReconciliation";
import type { ResetDisplayNameGenerationOutcome } from "../lib/radar/resetDisplayNameStore";
import type { FormalTiboResetSignal, TiboVerificationStatus } from "../lib/radar/tiboHistory";
import type { RadarData, ResetDisplayNameRecord, WindowEventLike } from "../lib/radar/types";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const COMPLETED_AT = "2026-09-04T10:00:00.000Z";
const TWEET_ID = "2095651088502591861";

function resetEvent(overrides: Partial<WindowEventLike> = {}): WindowEventLike {
  return {
    id: "canonical-event-key",
    recordKind: "banked_distribution",
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: COMPLETED_AT,
    closed_at: COMPLETED_AT,
    completed_at: COMPLETED_AT,
    source_url: `https://x.com/thsottiaux/status/${TWEET_ID}`,
    sourceTweetIds: [TWEET_ID],
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "公式予告あり",
      note: "配布が確認されました。",
    },
    ...overrides,
  };
}

function sourceSignal(overrides: Partial<FormalTiboResetSignal> = {}): FormalTiboResetSignal {
  return {
    tweet_id: TWEET_ID,
    text: "We have distributed a reset to the eligible users.",
    tweet_url: `https://x.com/thsottiaux/status/${TWEET_ID}`,
    tweet_created_at: COMPLETED_AT,
    signal_type: "official_notice",
    confidence: 0.99,
    verification_status: "confirmed" as TiboVerificationStatus,
    is_reply: false,
    ...overrides,
  };
}

function acceptedOutcome(eventKey: string): ResetDisplayNameGenerationOutcome {
  return {
    eventKey,
    status: "accepted",
    displayName: "Generated reset",
    inputMode: "metadata+source",
    skipped: false,
  };
}

function transientExisting(status: "api_error" | "invalid_response", updatedAt: string): ResetDisplayNameRecord {
  return {
    event_key: "canonical-event-key",
    source_tweet_id: TWEET_ID,
    manual_name_ja: null,
    ai_name_ja: null,
    ai_confidence: null,
    ai_evidence: null,
    ai_reason: null,
    ai_model: null,
    ai_prompt_version: null,
    ai_input_mode: "metadata+source",
    ai_status: status,
    ai_flags: [],
    ai_generated_at: null,
    input_hash: null,
    updated_at: updatedAt,
  };
}

test("conditional BANKED events are naming candidates but not probability candidates", () => {
  const item = resetEvent({ randomResetTargetScope: "conditional" });
  const completedAt = getCompletedResetTimestamp(item);

  assert.equal(completedAt, Date.parse(COMPLETED_AT));
  assert.equal(isEligibleRandomResetEvent(item, completedAt, NOW.getTime()), false);
  assert.equal(isAutoNameableCanonicalEvent(item, NOW), true);
});

test("broad confirmed global events remain naming candidates", () => {
  const item = resetEvent({ recordKind: "confirmed_global" });
  assert.equal(isAutoNameableCanonicalEvent(item, NOW), true);
});

test("non-canonical, pending, and rejected records are not naming candidates", () => {
  assert.equal(
    isAutoNameableCanonicalEvent(
      resetEvent({ recordKind: "regular_completed" }),
      NOW,
    ),
    false,
  );
  assert.equal(
    isAutoNameableCanonicalEvent(
      { ...resetEvent(), is_reply: true } as WindowEventLike,
      NOW,
    ),
    false,
  );
  assert.equal(
    isAutoNameableCanonicalEvent(
      resetEvent({ status: "pending", closed_at: null, completed_at: null }),
      NOW,
    ),
    false,
  );
  assert.equal(
    isAutoNameableCanonicalEvent(resetEvent({ status: "rejected" }), NOW),
    false,
  );
});

test("monitor-only naming candidates wait for source context and retry on a later run", async () => {
  const item = resetEvent({
    recordKind: "confirmed_global",
    scope: "",
    details: { ...resetEvent().details!, scope: "" },
    source_url: null,
    sourceTweetIds: [],
  });
  const calls: Array<{ eventKey: string | undefined; sourcePostText: string | null | undefined }> = [];
  const ensure = async (
    _candidate: WindowEventLike,
    options: { canonicalEventKey?: string; sourcePostText?: string | null },
  ) => {
    calls.push({ eventKey: options.canonicalEventKey, sourcePostText: options.sourcePostText });
    return acceptedOutcome(options.canonicalEventKey ?? "");
  };

  const first = await reconcileResetDisplayNames({
    data: { reset_display_names: [] },
    canonicalHistory: [item],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  assert.equal(first.outcomes[0]?.status, "source_unavailable");
  assert.equal(calls.length, 0);

  const second = await reconcileResetDisplayNames({
    data: { formal_tibo_resets: [sourceSignal()], reset_display_names: [] },
    canonicalHistory: [{
      ...item,
      source_url: sourceSignal().tweet_url,
      sourceTweetIds: [TWEET_ID],
    }],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  assert.equal(second.outcomes[0]?.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.eventKey, "canonical-event-key");
  assert.match(calls[0]?.sourcePostText ?? "", /eligible users/);
});

test("reconciliation bounds Gemini work and passes only the canonical event key", async () => {
  const history = Array.from({ length: 4 }, (_, index) => resetEvent({
    id: `canonical-event-${index + 1}`,
    sourceTweetIds: [`20956510885025918${index + 1}`],
    source_url: `https://x.com/thsottiaux/status/20956510885025918${index + 1}`,
  }));
  const sourceRows = history.map((item) => sourceSignal({
    tweet_id: item.sourceTweetIds![0],
    tweet_url: item.source_url!,
  }));
  const calls: string[] = [];
  const ensure = async (
    _candidate: WindowEventLike,
    options: { canonicalEventKey?: string },
  ) => {
    calls.push(options.canonicalEventKey ?? "");
    return acceptedOutcome(options.canonicalEventKey ?? "");
  };

  const result = await reconcileResetDisplayNames({
    data: { formal_tibo_resets: sourceRows, reset_display_names: [] } as RadarData,
    canonicalHistory: history,
    now: NOW,
    apiKey: "test-key",
    maxGeminiRequests: 3,
    ensure,
  });

  assert.equal(result.geminiRequests, 3);
  assert.deepEqual(calls.sort(), [
    "canonical-event-1",
    "canonical-event-2",
    "canonical-event-3",
  ]);
  assert.equal(result.outcomes.filter((outcome) => outcome.status === "gemini_cap_reached").length, 1);
});

test("the scheduled adoption boundary is opt-in and excludes only older events", async () => {
  const adoptionAt = new Date("2026-09-04T09:30:00.000Z");
  const before = resetEvent({
    closed_at: "2026-09-04T09:29:59.999Z",
    completed_at: "2026-09-04T09:29:59.999Z",
  });
  const atBoundary = resetEvent({
    closed_at: adoptionAt.toISOString(),
    completed_at: adoptionAt.toISOString(),
  });
  const common = {
    data: { reset_display_names: [] } as RadarData,
    sourceRows: [sourceSignal()],
    now: NOW,
    apiKey: "test-key",
    dryRun: true,
  };

  const beforeResult = await reconcileResetDisplayNames({
    ...common,
    canonicalHistory: [before],
    adoptionAt,
  });
  assert.equal(beforeResult.candidates, 0);
  assert.equal(beforeResult.outcomes[0]?.status, "before_adoption_boundary");
  assert.equal(beforeResult.geminiRequests, 0);

  const boundaryResult = await reconcileResetDisplayNames({
    ...common,
    canonicalHistory: [atBoundary],
    adoptionAt,
  });
  assert.equal(boundaryResult.candidates, 1);
  assert.equal(boundaryResult.outcomes[0]?.status, "dry_run");

  const cliAuditResult = await reconcileResetDisplayNames({
    ...common,
    canonicalHistory: [before],
  });
  assert.equal(cliAuditResult.candidates, 1);
  assert.equal(cliAuditResult.outcomes[0]?.status, "dry_run");
});

test("transient generation failures remain retryable on the next reconciliation", async () => {
  let calls = 0;
  const ensure = async (
    _candidate: WindowEventLike,
  ): Promise<ResetDisplayNameGenerationOutcome> => {
    calls += 1;
    return calls === 1
      ? { eventKey: "canonical-event-key", status: "api_error", displayName: null, inputMode: "metadata+source", skipped: true }
      : acceptedOutcome("canonical-event-key");
  };
  const data = {
    formal_tibo_resets: [sourceSignal()],
    reset_display_names: [],
  } as RadarData;
  const canonicalHistory = [resetEvent()];

  const first = await reconcileResetDisplayNames({
    data,
    canonicalHistory,
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  const second = await reconcileResetDisplayNames({
    data,
    canonicalHistory,
    now: NOW,
    apiKey: "test-key",
    ensure,
  });

  assert.equal(first.outcomes[0]?.status, "api_error");
  assert.equal(second.outcomes[0]?.status, "accepted");
  assert.equal(first.attempted, 1);
  assert.equal(second.attempted, 1);
  assert.equal(calls, 2);
});

test("recent transient failures use a one-hour cooldown while source-unavailable rows remain retryable", async () => {
  let calls = 0;
  const ensure = async (): Promise<ResetDisplayNameGenerationOutcome> => {
    calls += 1;
    return acceptedOutcome("canonical-event-key");
  };
  const existing = transientExisting("api_error", "2026-09-04T11:30:00.000Z");
  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [sourceSignal()],
      reset_display_names: [existing],
    } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });

  assert.equal(result.outcomes[0]?.status, "retry_cooldown");
  assert.equal(result.geminiRequests, 0);
  assert.equal(calls, 0);

  const sourceUnavailable = await reconcileResetDisplayNames({
    data: {
      reset_display_names: [existing],
    } as RadarData,
    canonicalHistory: [resetEvent({ source_url: null, sourceTweetIds: [] })],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  assert.equal(sourceUnavailable.outcomes[0]?.status, "source_unavailable");
  assert.equal(calls, 0);
});

test("expired invalid-response cooldowns can be retried", async () => {
  let calls = 0;
  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [sourceSignal()],
      reset_display_names: [transientExisting("invalid_response", "2026-09-04T10:00:00.000Z")],
    } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure: async () => {
      calls += 1;
      return acceptedOutcome("canonical-event-key");
    },
  });

  assert.equal(result.outcomes[0]?.status, "accepted");
  assert.equal(result.geminiRequests, 1);
  assert.equal(result.writes, 1);
  assert.equal(calls, 1);
});

test("manual and legacy accepted V2 names are protected before Gemini", async () => {
  const existing: ResetDisplayNameRecord = {
    event_key: "canonical-event-key",
    source_tweet_id: TWEET_ID,
    manual_name_ja: "人手確定リセット",
    ai_name_ja: "旧AI名",
    ai_confidence: 0.9,
    ai_evidence: "recorded",
    ai_reason: "existing",
    ai_model: "legacy-model",
    ai_prompt_version: "random-reset-name-v2",
    ai_input_mode: "metadata+source",
    ai_status: "accepted",
    ai_flags: [],
    ai_generated_at: null,
    input_hash: "legacy",
  };
  let calls = 0;
  const ensure = async (): Promise<ResetDisplayNameGenerationOutcome> => {
    calls += 1;
    return acceptedOutcome("canonical-event-key");
  };

  const manual = await reconcileResetDisplayNames({
    data: { formal_tibo_resets: [sourceSignal()], reset_display_names: [existing] } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  assert.equal(manual.outcomes[0]?.status, "manual");
  assert.equal(calls, 0);

  const legacyAccepted = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [sourceSignal()],
      reset_display_names: [{ ...existing, manual_name_ja: null }],
    } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure,
  });
  assert.equal(legacyAccepted.outcomes[0]?.status, "preserved_legacy_accepted");
  assert.equal(calls, 0);
});

test("promoted notice-precomputed names survive a completed-event hash mismatch", async () => {
  let ensureCalls = 0;
  const precomputed: ResetDisplayNameRecord = {
    event_key: "canonical-event-key",
    source_tweet_id: TWEET_ID,
    manual_name_ja: null,
    manual_name_en: null,
    manual_name_zh: null,
    ai_name_ja: "Astra記念リセット",
    ai_name_en: "Astra Celebration Reset",
    ai_name_zh: "Astra纪念重置",
    ai_confidence: null,
    ai_evidence: null,
    ai_reason: "notice-based accepted name",
    ai_model: "gemini-3.5-flash-lite",
    ai_prompt_version: "random-reset-name-v3",
    ai_input_mode: "notice-precompute-v1",
    ai_status: "accepted",
    ai_flags: [],
    ai_generated_at: "2026-09-04T09:00:00.000Z",
    input_hash: "notice-input-hash",
    updated_at: "2026-09-04T09:00:00.000Z",
  };
  const result = await reconcileResetDisplayNames({
    data: {
      formal_tibo_resets: [sourceSignal()],
      reset_display_names: [precomputed],
    } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure: async () => {
      ensureCalls += 1;
      return acceptedOutcome("canonical-event-key");
    },
  });

  assert.equal(result.outcomes[0]?.status, "preserved_precomputed");
  assert.equal(ensureCalls, 0);
  assert.equal(result.writes, 0);
  assert.equal(result.geminiRequests, 0);
});

test("display-name read failures defer reconciliation instead of treating rows as absent", async () => {
  let calls = 0;
  const result = await reconcileResetDisplayNames({
    data: {
      reset_display_names_health: { state: "degraded", detail: "database_error" },
    } as RadarData,
    canonicalHistory: [resetEvent()],
    now: NOW,
    apiKey: "test-key",
    ensure: async () => {
      calls += 1;
      return acceptedOutcome("canonical-event-key");
    },
  });

  assert.equal(result.outcomes[0]?.status, "data_unavailable");
  assert.equal(calls, 0);
  assert.equal(result.writes, 0);
});
