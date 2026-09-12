import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCodexUsageRecovery,
  type CodexUsageSnapshot,
} from "../lib/codexUsageRecovery";
import {
  confirmNearestCodexRecoveryObservation,
  findLatestBankedGrant,
  getNextUsageMonitorLastBankedGrantAt,
  upsertResetExecutionEstimate,
} from "../lib/codexUsageRecoveryStore";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";
import type { UsageMonitorState } from "../lib/codexUsageMonitorCoverage";

const OBSERVED_AT = "2026-08-26T01:15:00.000Z";
const TRUSTED_GRANT_AT = "2026-08-20T00:00:00.000Z";

function state(
  count: number | null | undefined,
  lastBankedGrantAt: string | null = null,
): UsageMonitorState {
  return {
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-26T01:10:00.000Z",
    receivedAt: "2026-08-26T01:10:01.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 80,
    windowDurationMins: 10080,
    resetsAt: 1_788_000_000,
    coverageStartedAt: null,
    ...(count !== undefined ? { bankedResetAvailableCount: count } : {}),
    lastBankedGrantAt,
  };
}

function snapshot(
  count: number | null | undefined,
  overrides: Partial<CodexUsageSnapshot> = {},
): CodexUsageSnapshot {
  return {
    observedAt: OBSERVED_AT,
    limitId: "codex",
    planType: "plus",
    usedPercent: 80,
    windowDurationMins: 10080,
    resetsAt: 1_788_604_800,
    ...(count !== undefined ? { bankedResetAvailableCount: count } : {}),
    ...overrides,
  };
}

test("a 0 to 1 count increase records the current observation as the grant", () => {
  assert.equal(
    getNextUsageMonitorLastBankedGrantAt(state(0), snapshot(1)),
    OBSERVED_AT,
  );
});

test("a 1 to 2 count increase records the current observation as the grant", () => {
  assert.equal(
    getNextUsageMonitorLastBankedGrantAt(state(1), snapshot(2)),
    OBSERVED_AT,
  );
});

test("an unavailable previous count does not become a grant on a positive count", () => {
  assert.equal(getNextUsageMonitorLastBankedGrantAt(state(undefined), snapshot(1)), null);
});

test("a null previous count does not become a grant on a positive count", () => {
  assert.equal(getNextUsageMonitorLastBankedGrantAt(state(null), snapshot(1)), null);
});

test("an unavailable count preserves no prior grant timestamp", () => {
  assert.equal(getNextUsageMonitorLastBankedGrantAt(state(undefined, null), snapshot(1)), null);
});

test("an unavailable count preserves a trusted prior grant timestamp", () => {
  assert.equal(
    getNextUsageMonitorLastBankedGrantAt(state(undefined, TRUSTED_GRANT_AT), snapshot(1)),
    TRUSTED_GRANT_AT,
  );
});

test("the count-change marker cannot invent a grant without a numeric increase", () => {
  assert.equal(
    getNextUsageMonitorLastBankedGrantAt(
      state(undefined),
      snapshot(1, { bankedResetCountChange: true }),
    ),
    null,
  );
});

test("a count decrease without a trusted grant timestamp fails open for an unexpected recovery", () => {
  const decision = evaluateCodexUsageRecovery(
    snapshot(1, { observedAt: "2026-08-26T01:10:00.000Z", resetsAt: 1_788_000_000 }),
    snapshot(0, { usedPercent: 0 }),
    { lastBankedGrantAt: null },
  );

  assert.equal(decision.kind, "recovery");
  assert.equal(decision.isPersonalReset, false);
});

test("a clear 1 to 0 decrease within the trusted window keeps personal-reset suppression", () => {
  const decision = evaluateCodexUsageRecovery(
    snapshot(1, { observedAt: "2026-08-26T01:10:00.000Z", resetsAt: 1_788_000_000 }),
    snapshot(0, { usedPercent: 0 }),
    { lastBankedGrantAt: TRUSTED_GRANT_AT },
  );

  assert.equal(decision.kind, "recovery");
  assert.equal(decision.isPersonalReset, true);
});

test("an execution estimate write error does not return an unsaved estimate", async () => {
  const databaseError = { code: "XX000", message: "estimate write failed" };
  let isWrite = false;
  const client = {
    from() {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.overlaps = () => builder;
      builder.limit = () => builder;
      builder.upsert = () => {
        isWrite = true;
        return builder;
      };
      builder.update = () => {
        isWrite = true;
        return builder;
      };
      builder.maybeSingle = async () => ({
        data: null,
        error: isWrite ? databaseError : null,
      });
      return builder;
    },
  };

  const result = await upsertResetExecutionEstimate(client as never, {
    resetEventKey: "usage-reset-estimate-write-error",
    isMonitorObserved: true,
    usageObservation: {
      id: "recovery-estimate-write-error",
      sourceKey: "local-codex-app-server",
      observedAt: "2026-08-26T01:15:00.000Z",
      previousObservedAt: "2026-08-26T01:10:00.000Z",
      previousUsedPercent: 100,
      currentUsedPercent: 0,
      previousResetsAt: 1_788_000_000,
      currentResetsAt: 1_788_604_800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "observed",
      matchedTiboTweetId: null,
      confirmedAt: null,
      createdAt: "2026-08-26T01:15:00.000Z",
      updatedAt: "2026-08-26T01:15:00.000Z",
    },
    tiboSourceTweetIds: [],
  });

  assert.equal(result.estimate, null);
  assert.deepEqual(result.error, databaseError);
});

test("a recovery CAS loser rejects confirmation claimed by an unrelated Tibo post", async () => {
  const observed = {
    id: "recovery-cas",
    source_key: "local-codex-app-server",
    observed_at: OBSERVED_AT,
    previous_observed_at: "2026-08-26T01:10:00.000Z",
    previous_used_percent: 100,
    current_used_percent: 0,
    previous_resets_at: 1_788_000_000,
    current_resets_at: 1_788_604_800,
    cycle_hint: "unexpected",
    confidence: "strong",
    status: "observed",
    matched_tibo_tweet_id: null,
    confirmed_at: null,
    created_at: OBSERVED_AT,
    updated_at: OBSERVED_AT,
  };
  const confirmedForOtherPost = {
    ...observed,
    status: "confirmed",
    matched_tibo_tweet_id: "unrelated-tweet",
    confirmed_at: "2026-08-26T01:16:00.000Z",
  };
  let fromCalls = 0;
  const client = {
    from() {
      fromCalls += 1;
      const call = fromCalls;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.in = () => builder;
      builder.gte = () => builder;
      builder.lte = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.update = () => builder;
      builder.maybeSingle = async () => ({
        data: call === 2 ? null : confirmedForOtherPost,
        error: null,
      });
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve({
        data: [observed],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };

  const result = await confirmNearestCodexRecoveryObservation(
    client as never,
    "current-tweet",
    OBSERVED_AT,
    90 * 60 * 1000,
    "2026-08-26T01:16:00.000Z",
    ["current-tweet"],
  );

  assert.equal(result.matched, false);
  assert.match(String(result.error), /CAS race/);
  assert.equal(result.observation, null);
});

test("does not match an already-confirmed observation for an unrelated tweet by time alone", async () => {
  const confirmedForOtherPost = {
    id: "recovery-confirmed",
    source_key: "local-codex-app-server",
    observed_at: OBSERVED_AT,
    previous_observed_at: "2026-08-26T01:10:00.000Z",
    previous_used_percent: 100,
    current_used_percent: 0,
    previous_resets_at: 1_788_000_000,
    current_resets_at: 1_788_604_800,
    cycle_hint: "unexpected",
    confidence: "strong",
    status: "confirmed",
    matched_tibo_tweet_id: "unrelated-tweet",
    confirmed_at: "2026-08-26T01:16:00.000Z",
    created_at: OBSERVED_AT,
    updated_at: "2026-08-26T01:16:00.000Z",
  };
  let fromCalls = 0;
  const client = {
    from() {
      fromCalls += 1;
      const call = fromCalls;
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.in = () => builder;
      builder.gte = () => builder;
      builder.lte = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve({
        data: call === 1 ? [] : [confirmedForOtherPost],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };

  const result = await confirmNearestCodexRecoveryObservation(
    client as never,
    "current-tweet",
    OBSERVED_AT,
    90 * 60 * 1000,
    "2026-08-26T01:16:00.000Z",
    ["current-tweet"],
  );

  assert.equal(result.matched, false);
  assert.equal(result.observation, null);
  assert.equal(result.error, null);
});

test("keeps the first confirmed tweet id when a later edit uses the same recovery observation", async () => {
  const observed = {
    id: "recovery-first-writer",
    source_key: "local-codex-app-server",
    observed_at: OBSERVED_AT,
    previous_observed_at: "2026-08-26T01:10:00.000Z",
    previous_used_percent: 100,
    current_used_percent: 0,
    previous_resets_at: 1_788_000_000,
    current_resets_at: 1_788_604_800,
    cycle_hint: "unexpected",
    confidence: "strong",
    status: "observed",
    matched_tibo_tweet_id: null,
    confirmed_at: null,
    created_at: OBSERVED_AT,
    updated_at: OBSERVED_AT,
  };
  const confirmedByA = {
    ...observed,
    status: "confirmed",
    matched_tibo_tweet_id: "tweet-A",
    confirmed_at: "2026-08-26T01:16:00.000Z",
  };
  let fromCalls = 0;
  const client = {
    from() {
      fromCalls += 1;
      const call = fromCalls;
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.in = () => builder;
      builder.gte = () => builder;
      builder.lte = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.update = () => builder;
      builder.maybeSingle = async () => ({
        data: call === 2 ? confirmedByA : null,
        error: null,
      });
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve({
        data: call === 1 ? [observed] : call === 3 ? [] : [confirmedByA],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };

  const first = await confirmNearestCodexRecoveryObservation(
    client as never,
    "tweet-A",
    OBSERVED_AT,
    90 * 60 * 1000,
    "2026-08-26T01:16:00.000Z",
    ["tweet-A"],
  );
  const second = await confirmNearestCodexRecoveryObservation(
    client as never,
    "tweet-B",
    OBSERVED_AT,
    90 * 60 * 1000,
    "2026-08-26T01:17:00.000Z",
    ["tweet-A", "tweet-B"],
  );

  assert.equal(first.matched, true);
  assert.equal(first.observation?.matchedTiboTweetId, "tweet-A");
  assert.equal(second.matched, true);
  assert.equal(second.observation?.matchedTiboTweetId, "tweet-A");
});

test("an existing execution estimate keeps its event and primary provenance during edit retry", async () => {
  const existingEstimate = {
    id: "estimate-existing",
    reset_event_key: "tibo-reset-A",
    display_execution_at: "2026-08-31T00:10:00.000Z",
    execution_time_source: "usage_observation",
    execution_time_confidence: "high",
    execution_time_precision: "approximate",
    execution_window_start_at: "2026-08-31T00:09:00.000Z",
    execution_window_end_at: "2026-08-31T00:10:00.000Z",
    recovery_observation_id: "recovery-existing",
    recovery_previous_observed_at: "2026-08-31T00:09:00.000Z",
    recovery_observed_at: "2026-08-31T00:10:00.000Z",
    tibo_announced_at: "2026-08-30T00:00:00.000Z",
    tibo_primary_tweet_id: "tweet-A",
    tibo_source_tweet_ids: ["tweet-A", "notice-old"],
    official_notice_tweet_id: "notice-old",
    official_notice_at: "2026-08-30T00:00:01.000Z",
    estimator_version: "usage-execution-v1",
    manual_override_at: null,
    manual_override_by: null,
    manual_override_reason: null,
    manual_execution_at: null,
    manual_execution_precision: null,
    created_at: "2026-08-31T00:10:00.000Z",
    updated_at: "2026-08-31T00:10:00.000Z",
  };
  let fromCalls = 0;
  let updatePayload: Record<string, unknown> | null = null;
  const client = {
    from() {
      fromCalls += 1;
      const call = fromCalls;
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.overlaps = () => builder;
      builder.limit = () => builder;
      builder.update = (values: Record<string, unknown>) => {
        updatePayload = values;
        return builder;
      };
      builder.maybeSingle = async () => {
        if (call === 3) return { data: existingEstimate, error: null };
        if (call === 4) return { data: { ...existingEstimate, ...updatePayload }, error: null };
        return { data: null, error: null };
      };
      return builder;
    },
  };

  const result = await upsertResetExecutionEstimate(client as never, {
    resetEventKey: "tibo-reset-B",
    tiboAnnouncedAt: "2026-08-31T00:01:00.000Z",
    tiboPrimaryTweetId: "tweet-B",
    tiboSourceTweetIds: ["tweet-A", "tweet-B"],
    officialNoticeTweetId: "notice-new",
    officialNoticeAt: "2026-08-31T00:01:01.000Z",
    usageObservation: {
      id: "recovery-existing",
      sourceKey: "local-codex-app-server",
      observedAt: "2026-08-31T00:10:00.000Z",
      previousObservedAt: "2026-08-31T00:09:00.000Z",
      previousUsedPercent: 100,
      currentUsedPercent: 0,
      previousResetsAt: 1_788_000_000,
      currentResetsAt: 1_788_604_800,
      cycleHint: "unexpected",
      confidence: "strong",
      status: "confirmed",
      matchedTiboTweetId: "tweet-A",
      confirmedAt: "2026-08-31T00:11:00.000Z",
      createdAt: "2026-08-31T00:10:00.000Z",
      updatedAt: "2026-08-31T00:11:00.000Z",
    },
  });

  assert.equal(result.error, null);
  const persistedEstimate = result.estimate as ResetExecutionEstimate | null;
  assert.equal(persistedEstimate?.resetEventKey, "tibo-reset-A");
  assert.equal(persistedEstimate?.tiboPrimaryTweetId, "tweet-A");
  assert.equal(persistedEstimate?.recoveryObservationId, "recovery-existing");
  assert.equal(persistedEstimate?.displayExecutionAt, "2026-08-31T00:10:00.000Z");
  assert.equal(persistedEstimate?.tiboAnnouncedAt, "2026-08-30T00:00:00.000Z");
  assert.equal(persistedEstimate?.officialNoticeTweetId, "notice-old");
  assert.equal(persistedEstimate?.officialNoticeAt, "2026-08-30T00:00:01.000Z");
  assert.deepEqual(persistedEstimate?.tiboSourceTweetIds, ["tweet-A", "tweet-B", "notice-old"]);
  const persistedUpdatePayload = updatePayload as Record<string, unknown> | null;
  assert.equal(persistedUpdatePayload?.reset_event_key, "tibo-reset-A");
  assert.equal(persistedUpdatePayload?.tibo_primary_tweet_id, "tweet-A");
  assert.equal(persistedUpdatePayload?.recovery_observation_id, "recovery-existing");
  assert.equal(persistedUpdatePayload?.display_execution_at, "2026-08-31T00:10:00.000Z");
  assert.equal(persistedUpdatePayload?.official_notice_tweet_id, "notice-old");
  assert.deepEqual(persistedUpdatePayload?.tibo_source_tweet_ids, ["tweet-A", "tweet-B", "notice-old"]);
});

test("findLatestBankedGrant includes the legacy Production BANKED estimator version", async () => {
  let estimatorVersions: string[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "reset_execution_estimates");
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.in = (column: string, values: string[]) => {
        assert.equal(column, "estimator_version");
        estimatorVersions = values;
        return builder;
      };
      builder.lte = () => builder;
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = async () => ({
        data: {
          reset_event_key: "banked-reset-legacy-production",
          display_execution_at: "2026-09-04T03:34:46.386Z",
          created_at: "2026-09-04T03:34:46.386Z",
        },
        error: null,
      });
      return builder;
    },
  };

  const result = await findLatestBankedGrant(
    client as never,
    "2026-09-05T03:34:46.386Z",
  );

  assert.deepEqual(estimatorVersions, [
    "banked-distribution-observation-v2",
    "usage-execution-banked-v1",
  ]);
  assert.deepEqual(result, {
    resetEventKey: "banked-reset-legacy-production",
    observedAt: "2026-09-04T03:34:46.386Z",
  });
});
