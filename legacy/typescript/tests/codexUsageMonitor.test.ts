import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppServerRequest,
  createJsonMonitorLogger,
  createJsonLineParser,
  createNotificationDebouncer,
  enqueueMonitorSnapshotPost,
  evaluateMonitorRecoveryCandidate,
  getMonitorBankedResetDisplayState,
  getMonitorPollIntervalMs,
  getMonitorPostSnapshot,
  getMonitorResetEventKey,
  getMonitorSnapshotPostReason,
  getPendingMonitorPosts,
  getRestartBackoffMs,
  getSafeMonitorErrorCode,
  isMonitorResetExecutionConfirmed,
  markMonitorSnapshotPostSucceeded,
  MIN_RECOVERY_CONFIRMATION_DELAY_MS,
  MONITOR_HEARTBEAT_INTERVAL_MS,
  RESET_AT_JITTER_TOLERANCE_SEC,
  shouldRestartAppServerAfterRpcFailure,
  toSafeMonitorPayload,
  updateMonitorSnapshotState,
} from "../tools/codex-usage-monitor";

function snapshot(overrides: Partial<{
  observedAt: string;
  limitId: "codex";
  planType: string;
  usedPercent: number;
  windowDurationMins: 10080;
  resetsAt: number;
  bankedResetAvailableCount?: number | null;
  bankedResetDisplayCount?: number | null;
}> = {}) {
  return {
    observedAt: "2026-08-21T00:00:00.000Z",
    limitId: "codex" as const,
    planType: "plus",
    usedPercent: 20,
    windowDurationMins: 10080 as const,
    resetsAt: 1_787_012_727,
    ...overrides,
  };
}

test("JSONL parser emits complete messages and fails closed on malformed lines", () => {
  const messages: unknown[] = [];
  let malformed = 0;
  const parser = createJsonLineParser(
    (message) => messages.push(message),
    () => { malformed += 1; },
  );

  parser.push('{"jsonrpc":"2.0"');
  parser.push(',"id":1}\nnot-json\n{"result":{"ok":true}}\n');

  assert.deepEqual(messages, [
    { jsonrpc: "2.0", id: 1 },
    { result: { ok: true } },
  ]);
  assert.equal(malformed, 1);
});

test("omits params for the app-server rate-limits request while retaining initialize params", () => {
  assert.deepEqual(
    createAppServerRequest("account/rateLimits/read", "2"),
    { jsonrpc: "2.0", id: "2", method: "account/rateLimits/read" },
  );
  assert.deepEqual(
    createAppServerRequest("initialize", "1", { clientInfo: { name: "test" } }),
    { jsonrpc: "2.0", id: "1", method: "initialize", params: { clientInfo: { name: "test" } } },
  );
});

test("notification refreshes are debounced into one read", async () => {
  let calls = 0;
  const debouncer = createNotificationDebouncer(() => { calls += 1; }, 5);

  debouncer.schedule();
  debouncer.schedule();
  debouncer.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls, 1);
});

test("polling never falls below the sixty second minimum", () => {
  assert.equal(getMonitorPollIntervalMs(undefined), 120_000);
  assert.equal(getMonitorPollIntervalMs("180000"), 180_000);
  assert.equal(getMonitorPollIntervalMs("500"), 60_000);
  assert.equal(getMonitorPollIntervalMs("invalid"), 120_000);
});

test("the monitor heartbeat is shorter than the server comparison gap", () => {
  assert.equal(MONITOR_HEARTBEAT_INTERVAL_MS, 8 * 60 * 1000);
  assert.ok(MONITOR_HEARTBEAT_INTERVAL_MS < 10 * 60 * 1000);
});

test("the first valid snapshot is posted immediately", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot(), {
      previousLocalSnapshot: null,
      lastSuccessfulPostAt: null,
    }, 0),
    "initial",
  );
});

test("ordinary used-percent increases are suppressed", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ usedPercent: 21 }), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    null,
  );
});

test("a used-percent decrease without a reset-at advance is suppressed", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ usedPercent: 19 }), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    null,
  );
});

test("a reset-at advance without a used-percent decrease is suppressed", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ resetsAt: 1_787_016_327 }), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    null,
  );
});

test("a meaningful recovery starts a candidate on first observation and is confirmed on independent observation", () => {
  const initialState = {
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
  };
  const firstEvidence = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 19,
    resetsAt: 1_787_016_327,
  });

  // First observation: candidate starts, but is not posted immediately
  assert.equal(getMonitorSnapshotPostReason(firstEvidence, initialState, 120_000), null);

  const stateWithCandidate = updateMonitorSnapshotState(
    initialState,
    firstEvidence,
    false,
    120_000,
    { nowMs: 120_000 },
  );
  assert.ok(stateWithCandidate.pendingRecoveryCandidate);
  assert.equal(stateWithCandidate.pendingRecoveryCandidate.preRecoveryBaseline.usedPercent, 20);
  assert.equal(stateWithCandidate.pendingRecoveryCandidate.firstEvidenceSnapshot.usedPercent, 19);

  // Independent second observation (>= 45s later): confirmed!
  const confirmedSnapshot = snapshot({
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 19,
    resetsAt: 1_787_016_327,
  });
  assert.equal(
    getMonitorSnapshotPostReason(confirmedSnapshot, stateWithCandidate, 240_000),
    "recovery_candidate",
  );
  assert.equal(
    getMonitorPostSnapshot(confirmedSnapshot, stateWithCandidate, "recovery_candidate", 240_000).observedAt,
    "2026-08-21T00:02:00.000Z",
  );
});

test("a newly observed explicit BANKED reset count is posted as a count change", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({
      bankedResetAvailableCount: 1,
    }), {
      previousLocalSnapshot: snapshot({
        bankedResetAvailableCount: 0,
      }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
});

test("an explicit BANKED reset count increase from one to two is posted", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ bankedResetAvailableCount: 2 }), {
      previousLocalSnapshot: snapshot({ bankedResetAvailableCount: 1 }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
  assert.notEqual(
    getMonitorSnapshotPostReason(snapshot({ bankedResetAvailableCount: 1 }), {
      previousLocalSnapshot: snapshot({ bankedResetAvailableCount: 1 }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
});

test("keeps the last explicit BANKED count through unavailable polls and detects later grants", () => {
  const cases = [
    { previous: 1, current: 2, expected: "banked_reset_count_change" },
    { previous: 1, current: 1, expected: null },
    { previous: 0, current: 1, expected: "banked_reset_count_change" },
    { previous: 2, current: 1, expected: null },
  ] as const;

  for (const { previous, current, expected } of cases) {
    let state = updateMonitorSnapshotState({
      previousLocalSnapshot: null,
      lastSuccessfulPostAt: null,
    }, snapshot({ bankedResetAvailableCount: previous }), true, 0);
    state = updateMonitorSnapshotState(
      state,
      snapshot({
        observedAt: "2026-08-21T00:02:00.000Z",
        bankedResetAvailableCount: null,
      }),
      true,
      120_000,
    );

    assert.equal(state.lastKnownBankedResetAvailableCount, previous);
    assert.deepEqual(
      getMonitorBankedResetDisplayState(
        snapshot({ bankedResetAvailableCount: null }),
        state.lastKnownBankedResetAvailableCount,
      ),
      { bankedResetDisplayCount: previous, bankedResetCountSource: "last_known" },
    );
    assert.equal(
      getMonitorSnapshotPostReason(
        snapshot({ bankedResetAvailableCount: current }),
        state,
        240_000,
      ),
      expected,
    );
  }
});

test("an initial explicit BANKED count is a baseline, not a locally inferred grant", () => {
  let state = updateMonitorSnapshotState({
    previousLocalSnapshot: null,
    lastSuccessfulPostAt: null,
  }, snapshot({ bankedResetAvailableCount: null }), false, 0);

  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ bankedResetAvailableCount: 1 }), state, 120_000),
    "initial",
  );

  state = updateMonitorSnapshotState(
    state,
    snapshot({ bankedResetAvailableCount: 1 }),
    true,
    120_000,
  );
  assert.equal(state.lastKnownBankedResetAvailableCount, 1);
});

test("a BANKED reset count change remains explicit when it coincides with weekly recovery", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({
      usedPercent: 19,
      resetsAt: 1_787_016_327,
      bankedResetAvailableCount: 1,
    }), {
      previousLocalSnapshot: snapshot({
        bankedResetAvailableCount: 0,
      }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
});

test("a consumed BANKED reset count does not look like a distribution", () => {
  assert.notEqual(
    getMonitorSnapshotPostReason(snapshot({
      bankedResetAvailableCount: 0,
    }), {
      previousLocalSnapshot: snapshot({
        bankedResetAvailableCount: 1,
      }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
});

test("an unavailable-to-explicit BANKED count does not create a grant", () => {
  assert.notEqual(
    getMonitorSnapshotPostReason(snapshot({ bankedResetAvailableCount: 1 }), {
      previousLocalSnapshot: snapshot({ bankedResetAvailableCount: null }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );
});

test("an explicit BANKED reset count change is sent without generic credits", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ bankedResetAvailableCount: 1 }), {
      previousLocalSnapshot: snapshot({ bankedResetAvailableCount: 0 }),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "banked_reset_count_change",
  );

  const payload = toSafeMonitorPayload(snapshot({ bankedResetAvailableCount: 1 }), "banked_reset_count_change");
  assert.deepEqual(payload, {
    monitorProtocolVersion: 2,
    postReason: "banked_reset_count_change",
    observedAt: "2026-08-21T00:00:00.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 20,
    windowDurationMins: 10080,
    resetsAt: 1_787_012_727,
    bankedResetAvailableCount: 1,
    bankedResetCountChange: true,
  });
});

test("a cached BANKED display count is never sent as the current webhook value", () => {
  const payload = toSafeMonitorPayload(snapshot({
    bankedResetAvailableCount: null,
    bankedResetDisplayCount: 1,
  }), "banked_reset_count_change");

  assert.equal("bankedResetAvailableCount" in payload, false);
  assert.equal("bankedResetCountChange" in payload, false);
});

test("a failed event post stays pending with its detection snapshot until success", () => {
  const detected = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    bankedResetAvailableCount: 1,
  });
  let state = enqueueMonitorSnapshotPost({
    previousLocalSnapshot: snapshot({
      bankedResetAvailableCount: 0,
    }),
    lastSuccessfulPostAt: 0,
  }, "banked_reset_count_change", detected);

  assert.deepEqual(getPendingMonitorPosts(state), [{
    reason: "banked_reset_count_change",
    snapshot: detected,
  }]);

  state = {
    ...state,
    previousLocalSnapshot: snapshot({
      observedAt: "2026-08-21T00:04:00.000Z",
      bankedResetAvailableCount: 1,
    }),
  };
  assert.equal(getPendingMonitorPosts(state)[0]?.snapshot.observedAt, detected.observedAt);

  state = markMonitorSnapshotPostSucceeded(state, 240_000);
  assert.deepEqual(getPendingMonitorPosts(state), []);
  assert.equal(state.lastSuccessfulPostAt, 240_000);
});

test("recovery and structure events can queue behind an earlier failed event post", () => {
  let state = enqueueMonitorSnapshotPost({
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
  }, "recovery_candidate", snapshot({ usedPercent: 19, resetsAt: 1_787_016_327 }));
  state = enqueueMonitorSnapshotPost(state, "structure_change", snapshot({ planType: "team" }));

  assert.deepEqual(getPendingMonitorPosts(state).map((pending) => pending.reason), [
    "recovery_candidate",
    "structure_change",
  ]);
});

test("repeated initial failures keep one pending initial post", () => {
  let state = enqueueMonitorSnapshotPost({
    previousLocalSnapshot: null,
    lastSuccessfulPostAt: null,
  }, "initial", snapshot({ observedAt: "2026-08-21T00:02:00.000Z" }));
  state = enqueueMonitorSnapshotPost(
    state,
    "initial",
    snapshot({ observedAt: "2026-08-21T00:04:00.000Z" }),
  );

  assert.equal(getPendingMonitorPosts(state).length, 1);
  assert.equal(getPendingMonitorPosts(state)[0]?.snapshot.observedAt, "2026-08-21T00:02:00.000Z");
});

test("plan changes are posted as a structure change", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot({ planType: "team" }), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "structure_change",
  );
});

test("limit and window changes are also structure changes", () => {
  assert.equal(
    getMonitorSnapshotPostReason({
      ...snapshot(),
      limitId: "other",
    } as unknown as ReturnType<typeof snapshot>, {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "structure_change",
  );
  assert.equal(
    getMonitorSnapshotPostReason({
      ...snapshot(),
      windowDurationMins: 300,
    } as unknown as ReturnType<typeof snapshot>, {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, 120_000),
    "structure_change",
  );
});

test("a snapshot before the heartbeat deadline is suppressed", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot(), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, MONITOR_HEARTBEAT_INTERVAL_MS - 1),
    null,
  );
});

test("a snapshot at the heartbeat deadline is posted as a heartbeat", () => {
  assert.equal(
    getMonitorSnapshotPostReason(snapshot(), {
      previousLocalSnapshot: snapshot(),
      lastSuccessfulPostAt: 0,
    }, MONITOR_HEARTBEAT_INTERVAL_MS),
    "heartbeat",
  );
});

test("a failed post advances the local snapshot but not the successful-post time", () => {
  const state = updateMonitorSnapshotState({
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
  }, snapshot({ usedPercent: 19 }), false, MONITOR_HEARTBEAT_INTERVAL_MS);

  assert.equal(state.previousLocalSnapshot?.usedPercent, 19);
  assert.equal(state.lastSuccessfulPostAt, 0);
});

test("a successful post records its completion time", () => {
  const state = updateMonitorSnapshotState({
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
  }, snapshot(), true, MONITOR_HEARTBEAT_INTERVAL_MS);

  assert.equal(state.lastSuccessfulPostAt, MONITOR_HEARTBEAT_INTERVAL_MS);
});

test("a failed initial post remains eligible for retry on the next poll", () => {
  const state = updateMonitorSnapshotState({
    previousLocalSnapshot: null,
    lastSuccessfulPostAt: null,
  }, snapshot(), false, 0);

  assert.equal(getMonitorSnapshotPostReason(snapshot({ observedAt: "2026-08-21T00:02:00.000Z" }), state, 120_000), "initial");
});

test("a notification burst does not confirm a recovery candidate until confirmation delay has passed", () => {
  const initialState = {
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
  };
  const firstEvidence = snapshot({
    observedAt: "2026-08-21T00:00:02.000Z",
    usedPercent: 19,
    resetsAt: 1_787_016_327,
  });

  // 1st observation (at 2s): starts candidate, not posted immediately
  assert.equal(getMonitorSnapshotPostReason(firstEvidence, initialState, 2_000), null);
  const stateWithCandidate = updateMonitorSnapshotState(initialState, firstEvidence, false, 2_000, { nowMs: 2_000 });

  // Burst observation 2s later (at 4s, total elapsed 2s < 60s): still not confirmed!
  const burstSnapshot = snapshot({
    observedAt: "2026-08-21T00:00:04.000Z",
    usedPercent: 19,
    resetsAt: 1_787_016_327,
  });
  assert.equal(getMonitorSnapshotPostReason(burstSnapshot, stateWithCandidate, 4_000), null);

  // Once 60s+ has elapsed (at 65s, elapsed 63s >= 60s): independent confirmation on scheduled poll!
  const confirmedSnapshot = snapshot({
    observedAt: "2026-08-21T00:01:05.000Z",
    usedPercent: 19,
    resetsAt: 1_787_016_327,
  });
  assert.equal(getMonitorSnapshotPostReason(confirmedSnapshot, stateWithCandidate, 65_000), "recovery_candidate");
});

test("a confirmed recovery wins over heartbeat, while a structure change cancels candidate", () => {
  const candidateState = {
    previousLocalSnapshot: snapshot(),
    lastSuccessfulPostAt: 0,
    pendingRecoveryCandidate: {
      preRecoveryBaseline: snapshot(),
      firstEvidenceSnapshot: snapshot({ usedPercent: 19, resetsAt: 1_787_016_327 }),
      candidateStartedAtMs: 0,
      lastObservation: snapshot({ usedPercent: 19, resetsAt: 1_787_016_327 }),
      observationCount: 1,
    },
  };

  // When confirmed at heartbeat interval, recovery_candidate wins over heartbeat
  assert.equal(
    getMonitorSnapshotPostReason(
      snapshot({ usedPercent: 19, resetsAt: 1_787_016_327 }),
      candidateState,
      MONITOR_HEARTBEAT_INTERVAL_MS,
    ),
    "recovery_candidate",
  );

  // When structure changes, candidate is cancelled and structure_change is posted
  assert.equal(
    getMonitorSnapshotPostReason(
      snapshot({ planType: "team", usedPercent: 19, resetsAt: 1_787_016_327 }),
      candidateState,
      MONITOR_HEARTBEAT_INTERVAL_MS,
    ),
    "structure_change",
  );
});

test("successful heartbeats keep the server comparison interval below ten minutes", () => {
  const first = snapshot();
  let state = updateMonitorSnapshotState({
    previousLocalSnapshot: null,
    lastSuccessfulPostAt: null,
  }, first, true, 0);
  const heartbeatAt = MONITOR_HEARTBEAT_INTERVAL_MS;
  assert.equal(getMonitorSnapshotPostReason(snapshot({ observedAt: "2026-08-21T00:08:00.000Z" }), state, heartbeatAt), "heartbeat");
  state = updateMonitorSnapshotState(state, snapshot({ observedAt: "2026-08-21T00:08:00.000Z" }), true, heartbeatAt);
  assert.ok(heartbeatAt - (state.lastSuccessfulPostAt ?? 0) <= 10 * 60 * 1000);
});

test("restart backoff caps at two minutes", () => {
  assert.deepEqual([0, 1, 2, 3].map(getRestartBackoffMs), [5_000, 30_000, 120_000, 120_000]);
});

test("app-server restarts only after three consecutive RPC failures", () => {
  assert.equal(shouldRestartAppServerAfterRpcFailure(1), false);
  assert.equal(shouldRestartAppServerAfterRpcFailure(2), false);
  assert.equal(shouldRestartAppServerAfterRpcFailure(3), true);
  assert.equal(shouldRestartAppServerAfterRpcFailure(4), true);
});

test("monitor payload contains only safe rate-limit fields", () => {
  assert.deepEqual(
    toSafeMonitorPayload({
      observedAt: "2026-08-11T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1787012727,
    }),
    {
      observedAt: "2026-08-11T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1787012727,
    },
  );
});

test("monitor payload includes only the explicit BANKED reset count for a count change", () => {
  assert.deepEqual(
    toSafeMonitorPayload({
      observedAt: "2026-08-21T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1787012727,
      bankedResetAvailableCount: 1,
    }, "banked_reset_count_change"),
    {
      monitorProtocolVersion: 2,
      postReason: "banked_reset_count_change",
      observedAt: "2026-08-21T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1787012727,
      bankedResetAvailableCount: 1,
      bankedResetCountChange: true,
    },
  );
});

test("toSafeMonitorPayload attaches protocol v2 metadata when postReason is provided", () => {
  for (const reason of [
    "initial",
    "recovery_candidate",
    "banked_reset_count_change",
    "structure_change",
    "heartbeat",
  ] as const) {
    const payload = toSafeMonitorPayload(snapshot(), reason);
    assert.equal(payload.monitorProtocolVersion, 2);
    assert.equal(payload.postReason, reason);
  }
  // When postReason is omitted, payload is unversioned legacy
  const legacyPayload = toSafeMonitorPayload(snapshot());
  assert.equal("monitorProtocolVersion" in legacyPayload, false);
  assert.equal("postReason" in legacyPayload, false);
});

test("Test D: local notification non-post invariant: notifications never post, candidate confirmed only by scheduled poll", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };
  const scheduleA = 1_787_012_727;
  const scheduleB = 1_787_012_727 + 7 * 86400;

  // t=0s: Initial snapshot establishes baseline
  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // t=0s: Anomaly arrives via notification (drop: 60 -> 40, schedule: +7d)
  const anomalyNotice0 = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const noticeReason0 = getMonitorSnapshotPostReason(anomalyNotice0, state, 0, "notification");
  assert.equal(noticeReason0, null, "Notification must never produce a postReason");
  state = updateMonitorSnapshotState(state, anomalyNotice0, false, 0, {
    nowMs: 0,
    logger: testLogger,
    trigger: "notification",
  });
  assert.equal(getPendingMonitorPosts(state).length, 0, "Notification must NOT enqueue any webhook post");
  assert.ok(state.pendingRecoveryCandidate, "Candidate must be started in-memory");

  // t=60s: Another notification arrives with anomaly maintained
  const anomalyNotice60 = snapshot({
    observedAt: "2026-09-10T00:01:00.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const noticeReason60 = getMonitorSnapshotPostReason(anomalyNotice60, state, 60_000, "notification");
  assert.equal(noticeReason60, null, "Notification must never confirm a candidate even after 60s");
  state = updateMonitorSnapshotState(state, anomalyNotice60, false, 60_000, {
    nowMs: 60_000,
    logger: testLogger,
    trigger: "notification",
  });
  assert.equal(getPendingMonitorPosts(state).length, 0, "Notification still must NOT enqueue any webhook post");

  // t=120s: Scheduled poll arrives (trigger: "poll", elapsed 120s >= 60s)
  const pollObs120 = snapshot({
    observedAt: "2026-09-10T00:02:00.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const pollReason = getMonitorSnapshotPostReason(pollObs120, state, 120_000, "poll");
  assert.equal(pollReason, "recovery_candidate", "Scheduled poll confirms the candidate");

  const postSnapshot = getMonitorPostSnapshot(pollObs120, state, pollReason, 120_000, "poll");
  state = enqueueMonitorSnapshotPost(state, pollReason!, postSnapshot);
  state = updateMonitorSnapshotState(state, pollObs120, true, 120_000, {
    nowMs: 120_000,
    logger: testLogger,
    trigger: "poll",
  });

  const pendingPosts = getPendingMonitorPosts(state);
  assert.equal(pendingPosts.length, 1, "Exactly 1 post enqueued upon poll confirmation");
  const payload = toSafeMonitorPayload(pendingPosts[0].snapshot, pendingPosts[0].reason);
  assert.equal(payload.monitorProtocolVersion, 2);
  assert.equal(payload.postReason, "recovery_candidate");
  assert.equal(payload.observedAt, "2026-09-10T00:00:00.000Z", "Posted snapshot is firstEvidenceSnapshot");
});

test("GUI event output exposes safe snapshot state without credentials", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  logger("snapshot_sent", {
    reason: "initial",
    observedAt: "2026-08-11T00:02:00.000Z",
    usedPercent: 6,
    resetsAt: 1787012727,
    planType: "plus",
    windowDurationMins: 10080,
    secret: "must-not-leak",
  });

  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(event.event, "snapshot_sent");
  assert.equal(typeof event.at, "string");
  assert.deepEqual({
    reason: event.reason,
    observedAt: event.observedAt,
    usedPercent: event.usedPercent,
    resetsAt: event.resetsAt,
    planType: event.planType,
    windowDurationMins: event.windowDurationMins,
  }, {
    reason: "initial",
    observedAt: "2026-08-11T00:02:00.000Z",
    usedPercent: 6,
    resetsAt: 1787012727,
    planType: "plus",
    windowDurationMins: 10080,
  });
  assert.equal(lines[0].includes("must-not-leak"), false);
});

test("local GUI snapshot events expose the normalized BANKED reset count without credentials", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  for (const availableCount of [0, 1, 2]) {
    logger("snapshot_observed", {
      observedAt: "2026-08-21T00:02:00.000Z",
      usedPercent: 6,
      resetsAt: 1787012727,
      planType: "plus",
      windowDurationMins: 10080,
      bankedResetDisplayCount: availableCount,
      secret: "must-not-leak",
    });
  }

  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => event.bankedResetDisplayCount), [0, 1, 2]);
  assert.equal(lines.every((line) => line.includes("must-not-leak") === false), true);
});

test("local GUI snapshot events omit an unavailable BANKED reset count", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  logger("snapshot_observed", {
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 6,
    resetsAt: 1787012727,
    planType: "plus",
    windowDurationMins: 10080,
    bankedResetDisplayCount: null,
  });

  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal("bankedResetDisplayCount" in event, false);
});

test("local GUI snapshot events identify a retained BANKED count as last known", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  logger("snapshot_observed", {
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 6,
    resetsAt: 1787012727,
    planType: "plus",
    windowDurationMins: 10080,
    bankedResetDisplayCount: 1,
    bankedResetCountSource: "last_known",
  });

  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(event.bankedResetDisplayCount, 1);
  assert.equal(event.bankedResetCountSource, "last_known");
});

test("local BANKED display state distinguishes explicit zero from unavailable", () => {
  assert.deepEqual(
    getMonitorBankedResetDisplayState(snapshot({ bankedResetAvailableCount: 0 }), 1),
    { bankedResetDisplayCount: 0, bankedResetCountSource: "explicit" },
  );
  assert.deepEqual(
    getMonitorBankedResetDisplayState(snapshot({ bankedResetAvailableCount: null }), null),
    { bankedResetDisplayCount: null, bankedResetCountSource: "unavailable" },
  );
});

test("only a successful recovery-candidate response confirms a reset for notification", () => {
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "confirmed" },
      "recovery_candidate",
    ),
    true,
  );
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "teaser_corroborated" },
      "recovery_candidate",
    ),
    true,
  );
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "teaser_corroborated" },
      "heartbeat",
    ),
    false,
  );
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "observed_unconfirmed" },
      "recovery_candidate",
    ),
    false,
  );
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "banked_distribution_observed" },
      "banked_reset_count_change",
    ),
    false,
  );
  assert.equal(
    isMonitorResetExecutionConfirmed(
      { accepted: true, recovery: "confirmed" },
      "initial",
    ),
    false,
  );
});

test("reset confirmation event keys remain stable for retries and change for another reset", () => {
  const first = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    resetsAt: 1_787_016_327,
  });
  const retry = { ...first, observedAt: "2026-08-21T00:02:05.000Z" };
  const next = { ...first, resetsAt: 1_787_023_527 };

  assert.equal(getMonitorResetEventKey(first), getMonitorResetEventKey(retry));
  assert.notEqual(getMonitorResetEventKey(first), getMonitorResetEventKey(next));
});

test("reset confirmation GUI events expose only safe stable fields", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  logger("reset_confirmed", {
    resetEventKey: "usage-reset:1787016327",
    observedAt: "2026-08-21T00:02:00.000Z",
    resetsAt: 1_787_016_327,
    secret: "must-not-leak",
  });

  const event = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.deepEqual(
    {
      event: event.event,
      resetEventKey: event.resetEventKey,
      observedAt: event.observedAt,
      resetsAt: event.resetsAt,
    },
    {
      event: "reset_confirmed",
      resetEventKey: "usage-reset:1787016327",
      observedAt: "2026-08-21T00:02:00.000Z",
      resetsAt: 1_787_016_327,
    },
  );
  assert.equal(lines[0].includes("must-not-leak"), false);
});

test("GUI-safe error codes preserve only known machine-readable reasons", () => {
  assert.equal(getSafeMonitorErrorCode(new Error("monitor_secret_missing")), "monitor_secret_missing");
  assert.equal(getSafeMonitorErrorCode(new Error("private error details")), "Error");
});

test("synthetic analogue: transient recovery-like anomaly starts candidate but cancels on reversion without posting (actual 2026-09-09 sequence unavailable)", () => {
  // The synthetic regression represents the class of transient recovery-like observations
  // that could produce a false reset. The exact 2026-09-09 snapshot sequence was not recovered.
  // actual 9/9 sequence: unavailable
  // current regression: synthetic analogue
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  // Baseline before anomaly: 60% used, normal schedule
  const baseline = snapshot({
    observedAt: "2026-09-09T03:00:00.000Z",
    usedPercent: 60,
    resetsAt: 1_787_012_727,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // Poll 1 (t=120s): Anomalous snapshot drops to 40% with +7d resetsAt
  const anomalous = snapshot({
    observedAt: "2026-09-09T03:02:00.000Z",
    usedPercent: 40,
    resetsAt: 1_787_012_727 + 7 * 86400,
  });

  const reason1 = getMonitorSnapshotPostReason(anomalous, state, 120_000);
  assert.equal(reason1, null, "First anomalous observation must NOT return recovery_candidate immediately");

  state = updateMonitorSnapshotState(state, anomalous, false, 120_000, {
    nowMs: 120_000,
    logger: testLogger,
  });
  assert.ok(state.pendingRecoveryCandidate, "Candidate should be held in pending state");
  assert.equal(state.pendingRecoveryCandidate.preRecoveryBaseline.usedPercent, 60);
  assert.equal(state.pendingRecoveryCandidate.firstEvidenceSnapshot.usedPercent, 40);

  // Verify audit log for candidate start
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0]?.event, "recovery_candidate_started");
  assert.equal(auditLogs[0]?.details?.usedPercent, 40);

  // Poll 2 (t=240s): Reversion! Usage bounces back to 60% and resetsAt reverts to original schedule
  const reverted = snapshot({
    observedAt: "2026-09-09T03:04:00.000Z",
    usedPercent: 60,
    resetsAt: 1_787_012_727,
  });

  const reason2 = getMonitorSnapshotPostReason(reverted, state, 240_000);
  assert.equal(reason2, null, "Reverted observation must NOT trigger a post");

  state = updateMonitorSnapshotState(state, reverted, false, 240_000, {
    nowMs: 240_000,
    logger: testLogger,
  });
  assert.equal(state.pendingRecoveryCandidate, null, "Candidate must be cancelled on reversion");
  assert.equal(state.baselineSnapshot?.usedPercent, 60, "Baseline should rebase to reverted snapshot");

  // Verify audit log for cancellation
  assert.equal(auditLogs.length, 2);
  assert.equal(auditLogs[1]?.event, "recovery_candidate_cancelled");
  assert.equal(auditLogs[1]?.details?.reason, "usage_reverted");
  assert.equal(state.pendingPosts?.length ?? 0, 0, "Zero posts queued for webhook");
});

test("adversarial sequence A: transient drop with intermediate notification (60/A -> 40/B @0s -> 40/B @50s -> 60/A @90s)", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  const scheduleA = 1_787_012_727;
  const scheduleB = 1_787_012_727 + 7 * 86400;

  // t=0s: baseline established (60% / A)
  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // t=0s: anomaly arrived via notification (40% / B) -> starts candidate
  const anomaly0 = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const reason0 = getMonitorSnapshotPostReason(anomaly0, state, 0, "notification");
  assert.equal(reason0, null, "Candidate start must not post immediately");
  state = updateMonitorSnapshotState(state, anomaly0, false, 0, {
    nowMs: 0,
    logger: testLogger,
    trigger: "notification",
  });
  assert.ok(state.pendingRecoveryCandidate, "Candidate should be started");
  assert.equal(state.pendingRecoveryCandidate.observationCount, 1);

  // t=50s: notification arrives again (40% / B) -> still transient, notification cannot confirm
  const anomaly50 = snapshot({
    observedAt: "2026-09-10T00:00:50.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const reason50 = getMonitorSnapshotPostReason(anomaly50, state, 50_000, "notification");
  assert.equal(reason50, null, "Intermediate notification must NOT confirm candidate");
  state = updateMonitorSnapshotState(state, anomaly50, false, 50_000, {
    nowMs: 50_000,
    logger: testLogger,
    trigger: "notification",
  });
  assert.ok(state.pendingRecoveryCandidate, "Candidate remains pending unconfirmed");
  assert.equal(state.pendingRecoveryCandidate.observationCount, 2);

  // t=90s: reversion arrives (60% / A) -> usage reverted!
  const reverted90 = snapshot({
    observedAt: "2026-09-10T00:01:30.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  const reason90 = getMonitorSnapshotPostReason(reverted90, state, 90_000, "notification");
  assert.equal(reason90, null, "Reverted observation must NOT trigger a post");
  state = updateMonitorSnapshotState(state, reverted90, false, 90_000, {
    nowMs: 90_000,
    logger: testLogger,
    trigger: "notification",
  });
  assert.equal(state.pendingRecoveryCandidate, null, "Candidate must be cancelled on reversion");
  assert.equal(state.baselineSnapshot?.usedPercent, 60);

  // Verify audit logs: started -> cancelled (usage_reverted)
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_started"), true);
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_cancelled" && l.details?.reason === "usage_reverted"), true);
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_confirmed"), false);
  assert.equal(state.pendingPosts?.length ?? 0, 0, "Webhook send count must be 0");
});

test("adversarial sequence B: slightly longer transient glitch (>60s) with notification @90s (60/A -> 40/B @0s -> 40/B @90s -> 60/A @110s)", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  const scheduleA = 1_787_012_727;
  const scheduleB = 1_787_012_727 + 7 * 86400;

  // t=0s: baseline (60% / A)
  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // t=0s: candidate started (40% / B) via notification
  const anomaly0 = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  assert.equal(getMonitorSnapshotPostReason(anomaly0, state, 0, "notification"), null);
  state = updateMonitorSnapshotState(state, anomaly0, false, 0, {
    nowMs: 0,
    logger: testLogger,
    trigger: "notification",
  });
  assert.ok(state.pendingRecoveryCandidate);

  // t=90s: notification arrives with 40% / B. Even though elapsed 90s > 60s, trigger is "notification" so it MUST NOT confirm!
  const anomaly90 = snapshot({
    observedAt: "2026-09-10T00:01:30.000Z",
    usedPercent: 40,
    resetsAt: scheduleB,
  });
  const reason90 = getMonitorSnapshotPostReason(anomaly90, state, 90_000, "notification");
  assert.equal(reason90, null, "Notification at 90s must NOT confirm candidate because confirmation requires scheduled poll");
  state = updateMonitorSnapshotState(state, anomaly90, false, 90_000, {
    nowMs: 90_000,
    logger: testLogger,
    trigger: "notification",
  });
  assert.ok(state.pendingRecoveryCandidate, "Candidate must remain pending_unconfirmed");

  // t=110s: reversion occurs before scheduled poll! (60% / A)
  const reverted110 = snapshot({
    observedAt: "2026-09-10T00:01:50.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  const reason110 = getMonitorSnapshotPostReason(reverted110, state, 110_000, "poll");
  assert.equal(reason110, null, "Reversion at 110s must cancel without posting");
  state = updateMonitorSnapshotState(state, reverted110, false, 110_000, {
    nowMs: 110_000,
    logger: testLogger,
    trigger: "poll",
  });
  assert.equal(state.pendingRecoveryCandidate, null, "Candidate cancelled on reversion");
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_confirmed"), false);
  assert.equal(state.pendingPosts?.length ?? 0, 0, "Webhook send count must be 0");
});

test("adversarial sequence C: genuine recovery with slow usage after reset (60/A -> 5/B @0s -> 8/B @next poll 120s)", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  const scheduleA = 1_787_012_727;
  const scheduleB = 1_787_012_727 + 7 * 86400;

  // t=0s: baseline (60% / A)
  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 60,
    resetsAt: scheduleA,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // t=0s: genuine reset arrives (5% / B) via notification
  const reset0 = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 5,
    resetsAt: scheduleB,
  });
  assert.equal(getMonitorSnapshotPostReason(reset0, state, 0, "notification"), null);
  state = updateMonitorSnapshotState(state, reset0, false, 0, {
    nowMs: 0,
    logger: testLogger,
    trigger: "notification",
  });
  assert.ok(state.pendingRecoveryCandidate);
  assert.equal(state.pendingRecoveryCandidate.firstEvidenceSnapshot.usedPercent, 5);

  // t=120s: next scheduled poll arrives ("poll", elapsed 120s >= 60s). User started coding, usage is 8% / B.
  const pollObs = snapshot({
    observedAt: "2026-09-10T00:02:00.000Z",
    usedPercent: 8,
    resetsAt: scheduleB,
  });
  // Compared against preRecoveryBaseline (60%): 60 - 8 = 52% >= 1%, schedule forward -> confirmed!
  const reason = getMonitorSnapshotPostReason(pollObs, state, 120_000, "poll");
  assert.equal(reason, "recovery_candidate", "Must confirm on scheduled poll");

  const postSnapshot = getMonitorPostSnapshot(pollObs, state, reason, 120_000, "poll");
  // Crucial: Snapshot posted to webhook is the t=0s 5% first evidence snapshot!
  assert.equal(postSnapshot.observedAt, "2026-09-10T00:00:00.000Z");
  assert.equal(postSnapshot.usedPercent, 5);

  state = enqueueMonitorSnapshotPost(state, reason!, postSnapshot);
  state = updateMonitorSnapshotState(state, pollObs, true, 120_000, {
    nowMs: 120_000,
    logger: testLogger,
    trigger: "poll",
  });

  assert.equal(state.pendingRecoveryCandidate, null, "Candidate cleared after confirmation");
  assert.equal(state.baselineSnapshot?.usedPercent, 8, "Baseline advances to latest observation");
  assert.equal(state.pendingPosts?.length, 1, "Exactly 1 post queued");
  assert.equal(state.pendingPosts?.[0]?.snapshot.usedPercent, 5, "Queued post has 5% initial snapshot");
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_confirmed"), true);
});

test("genuine recovery: persists across independent polls and posts firstEvidenceSnapshot timestamp", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 70,
    resetsAt: 1_787_012_727,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // Poll 1 (t=120s): First evidence of genuine reset
  const firstEvidence = snapshot({
    observedAt: "2026-09-10T00:02:00.000Z",
    usedPercent: 0,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(firstEvidence, state, 120_000), null);
  state = updateMonitorSnapshotState(state, firstEvidence, false, 120_000, {
    nowMs: 120_000,
    logger: testLogger,
  });
  assert.ok(state.pendingRecoveryCandidate);

  // Poll 2 (t=240s, 120s later >= 45s): Persisting recovery confirmed
  const confirmedObs = snapshot({
    observedAt: "2026-09-10T00:04:00.000Z",
    usedPercent: 0,
    resetsAt: 1_787_617_527,
  });
  const reason = getMonitorSnapshotPostReason(confirmedObs, state, 240_000);
  assert.equal(reason, "recovery_candidate");

  const postSnapshot = getMonitorPostSnapshot(confirmedObs, state, reason, 240_000);
  // Crucial: postSnapshot preserves the firstEvidence timestamp!
  assert.equal(postSnapshot.observedAt, "2026-09-10T00:02:00.000Z");

  state = updateMonitorSnapshotState(state, confirmedObs, false, 240_000, {
    nowMs: 240_000,
    logger: testLogger,
  });
  assert.equal(state.pendingRecoveryCandidate, null);
  assert.equal(state.baselineSnapshot?.usedPercent, 0);

  // Audit logs confirm started then confirmed
  assert.equal(auditLogs.length, 2);
  assert.equal(auditLogs[0]?.event, "recovery_candidate_started");
  assert.equal(auditLogs[1]?.event, "recovery_candidate_confirmed");
  assert.equal(auditLogs[1]?.details?.firstObservedAt, "2026-09-10T00:02:00.000Z");
  assert.equal(auditLogs[1]?.details?.delayMs, 120_000);

  // Poll 3 (t=360s): No duplicate recovery candidate
  const nextObs = snapshot({
    observedAt: "2026-09-10T00:06:00.000Z",
    usedPercent: 0,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(nextObs, state, 360_000), null);
});

test("post-recovery usage: 80% -> 5% -> 8% confirmed against frozen pre-recovery baseline", () => {
  const baseline = snapshot({
    observedAt: "2026-09-10T00:00:00.000Z",
    usedPercent: 80,
    resetsAt: 1_787_012_727,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  // Poll 1: 5% usage observed
  const firstEvidence = snapshot({
    observedAt: "2026-09-10T00:02:00.000Z",
    usedPercent: 5,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(firstEvidence, state, 120_000), null);
  state = updateMonitorSnapshotState(state, firstEvidence, false, 120_000, { nowMs: 120_000 });

  // Poll 2: User started working, usage increased from 5% to 8%
  const postUsageObs = snapshot({
    observedAt: "2026-09-10T00:04:00.000Z",
    usedPercent: 8,
    resetsAt: 1_787_617_527,
  });
  // Against pre-recovery baseline (80%): 80 - 8 = 72% >= 1%, resetsAt maintained -> CONFIRMED!
  const reason = getMonitorSnapshotPostReason(postUsageObs, state, 240_000);
  assert.equal(reason, "recovery_candidate");

  const postSnapshot = getMonitorPostSnapshot(postUsageObs, state, reason, 240_000);
  assert.equal(postSnapshot.observedAt, "2026-09-10T00:02:00.000Z");
  assert.equal(postSnapshot.usedPercent, 5);
});

test("repeated flapping / oscillation does not post false recoveries", () => {
  const baseTime = Date.parse("2026-08-21T00:00:00.000Z");
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    snapshot({ observedAt: new Date(baseTime).toISOString(), usedPercent: 50, resetsAt: 1_787_012_727 }),
    true,
    0,
  );

  let nowMs = 120_000;
  for (let cycle = 0; cycle < 3; cycle++) {
    // Drop
    const drop = snapshot({
      observedAt: new Date(baseTime + nowMs).toISOString(),
      usedPercent: 30,
      resetsAt: 1_787_617_527,
    });
    assert.equal(getMonitorSnapshotPostReason(drop, state, nowMs), null);
    state = updateMonitorSnapshotState(state, drop, false, nowMs, { nowMs });
    assert.ok(state.pendingRecoveryCandidate);

    nowMs += 120_000;
    // Bounce back
    const bounce = snapshot({
      observedAt: new Date(baseTime + nowMs).toISOString(),
      usedPercent: 50,
      resetsAt: 1_787_012_727,
    });
    assert.equal(getMonitorSnapshotPostReason(bounce, state, nowMs), null);
    state = updateMonitorSnapshotState(state, bounce, false, nowMs, { nowMs });
    assert.equal(state.pendingRecoveryCandidate, null);

    nowMs += 120_000;
  }
  assert.equal(state.pendingPosts?.length ?? 0, 0);
});

test("sub-1% usage corrections do not accumulate into fake resets", () => {
  const baseTime = Date.parse("2026-08-21T00:00:00.000Z");
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    snapshot({ observedAt: new Date(baseTime).toISOString(), usedPercent: 20.0, resetsAt: 1_787_012_727 }),
    true,
    0,
  );

  const steps = [19.6, 19.3, 18.9, 18.6];
  let time = 60_000;
  for (const usedPercent of steps) {
    const s = snapshot({
      observedAt: new Date(baseTime + time).toISOString(),
      usedPercent,
      resetsAt: 1_787_617_527, // even if resetsAt advanced
    });
    // Each step decrease < 1%, so no recovery candidate is started
    const reason = getMonitorSnapshotPostReason(s, state, time);
    assert.notEqual(reason, "recovery_candidate");
    assert.equal(reason, null);
    state = updateMonitorSnapshotState(state, s, false, time, { nowMs: time });
    assert.equal(state.pendingRecoveryCandidate, null);
    time += 60_000;
  }
});

test("resetsAt schedule advance without usage drop does not start candidate", () => {
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    snapshot({ usedPercent: 20, resetsAt: 1_787_012_727 }),
    true,
    0,
  );

  const advancedSchedule = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 20,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(advancedSchedule, state, 120_000), null);
  state = updateMonitorSnapshotState(state, advancedSchedule, false, 120_000, { nowMs: 120_000 });
  assert.equal(state.pendingRecoveryCandidate, null);
  assert.equal(state.baselineSnapshot?.resetsAt, 1_787_617_527);
});

test("comparison gap > 10m cancels pending candidate and rebases", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    snapshot({ usedPercent: 50, resetsAt: 1_787_012_727 }),
    true,
    0,
  );

  const candidateObs = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 20,
    resetsAt: 1_787_617_527,
  });
  state = updateMonitorSnapshotState(state, candidateObs, false, 120_000, { nowMs: 120_000 });
  assert.ok(state.pendingRecoveryCandidate);

  // 15 minutes later (> 10m MAX_USAGE_COMPARISON_GAP_MS)
  const delayedObs = snapshot({
    observedAt: "2026-08-21T00:17:00.000Z",
    usedPercent: 20,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(delayedObs, state, 120_000 + 15 * 60 * 1000), null);
  state = updateMonitorSnapshotState(state, delayedObs, false, 120_000 + 15 * 60 * 1000, {
    nowMs: 120_000 + 15 * 60 * 1000,
    logger: testLogger,
  });
  assert.equal(state.pendingRecoveryCandidate, null);
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_cancelled" && l.details?.reason === "comparison_gap"), true);
});

test("stale out-of-order observation cancels pending candidate", () => {
  const auditLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const testLogger = (event: string, details?: Record<string, unknown>) => {
    auditLogs.push({ event, details });
  };

  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    snapshot({ usedPercent: 50, resetsAt: 1_787_012_727 }),
    true,
    0,
  );

  const candidateObs = snapshot({
    observedAt: "2026-08-21T00:05:00.000Z",
    usedPercent: 20,
    resetsAt: 1_787_617_527,
  });
  state = updateMonitorSnapshotState(state, candidateObs, false, 300_000, { nowMs: 300_000 });
  assert.ok(state.pendingRecoveryCandidate);

  // Stale observation with older timestamp
  const staleObs = snapshot({
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 20,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(staleObs, state, 360_000), null);
  state = updateMonitorSnapshotState(state, staleObs, false, 360_000, {
    nowMs: 360_000,
    logger: testLogger,
  });
  assert.equal(state.pendingRecoveryCandidate, null);
  assert.equal(auditLogs.some((l) => l.event === "recovery_candidate_cancelled" && l.details?.reason === "stale_observation"), true);
});

test("failed webhook post retains firstEvidenceSnapshot in pending queue without duplicate candidate creation", () => {
  const baseline = snapshot({
    observedAt: "2026-08-21T00:00:00.000Z",
    usedPercent: 60,
    resetsAt: 1_787_012_727,
  });
  let state = updateMonitorSnapshotState(
    { previousLocalSnapshot: null, lastSuccessfulPostAt: null },
    baseline,
    true,
    0,
  );

  const firstEvidence = snapshot({
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 10,
    resetsAt: 1_787_617_527,
  });
  state = updateMonitorSnapshotState(state, firstEvidence, false, 120_000, { nowMs: 120_000 });

  const confirmedObs = snapshot({
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 10,
    resetsAt: 1_787_617_527,
  });
  const postReason = getMonitorSnapshotPostReason(confirmedObs, state, 240_000);
  assert.equal(postReason, "recovery_candidate");
  const postSnapshot = getMonitorPostSnapshot(confirmedObs, state, postReason, 240_000);

  // Enqueue confirmed post
  state = enqueueMonitorSnapshotPost(state, postReason!, postSnapshot);
  // State updated (candidate cleared, baseline updated to 10%)
  state = updateMonitorSnapshotState(state, confirmedObs, false, 240_000, { nowMs: 240_000 });

  // Webhook failed -> post remains pending with firstEvidence
  const pending = getPendingMonitorPosts(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.snapshot.observedAt, "2026-08-21T00:02:00.000Z");
  assert.equal(pending[0]?.snapshot.usedPercent, 10);

  // Next poll (t=360s): No duplicate candidate starts because baseline is already 10%
  const nextObs = snapshot({
    observedAt: "2026-08-21T00:06:00.000Z",
    usedPercent: 10,
    resetsAt: 1_787_617_527,
  });
  assert.equal(getMonitorSnapshotPostReason(nextObs, state, 360_000), null);
  // Pending post still contains original first evidence
  assert.equal(getPendingMonitorPosts(state)[0]?.snapshot.observedAt, "2026-08-21T00:02:00.000Z");
});

test("recovery candidate GUI audit logs expose only safe fields without credentials", () => {
  const lines: string[] = [];
  const logger = createJsonMonitorLogger((line) => lines.push(line));

  logger("recovery_candidate_started", {
    observedAt: "2026-08-21T00:02:00.000Z",
    usedPercent: 10,
    resetsAt: 1_787_617_527,
    planType: "plus",
    windowDurationMins: 10080,
    bankedResetDisplayCount: 2,
    secret: "must-not-leak",
    token: "private-token",
  });

  logger("recovery_candidate_confirmed", {
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 10,
    resetsAt: 1_787_617_527,
    firstObservedAt: "2026-08-21T00:02:00.000Z",
    delayMs: 120_000,
    apiKey: "must-not-leak",
  });

  logger("recovery_candidate_cancelled", {
    reason: "usage_reverted",
    observedAt: "2026-08-21T00:04:00.000Z",
    usedPercent: 60,
    resetsAt: 1_787_012_727,
    secret: "must-not-leak",
  });

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.includes("must-not-leak"), false);
    assert.equal(line.includes("private-token"), false);
  }

  const started = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(started.event, "recovery_candidate_started");
  assert.equal(started.usedPercent, 10);
  assert.equal(started.bankedResetDisplayCount, 2);

  const confirmed = JSON.parse(lines[1]) as Record<string, unknown>;
  assert.equal(confirmed.event, "recovery_candidate_confirmed");
  assert.equal(confirmed.firstObservedAt, "2026-08-21T00:02:00.000Z");
  assert.equal(confirmed.delayMs, 120_000);

  const cancelled = JSON.parse(lines[2]) as Record<string, unknown>;
  assert.equal(cancelled.event, "recovery_candidate_cancelled");
  assert.equal(cancelled.reason, "usage_reverted");
});
