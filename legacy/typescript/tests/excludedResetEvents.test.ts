import test from "node:test";
import assert from "node:assert/strict";
import {
  isExcludedResetEventKey,
  isExcludedRecoveryObservationId,
} from "../data/resetHistory";
import { findNoticeBackedRecoveryEvents } from "../lib/radar/tiboHistory";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";

test("identifies manually excluded reset event keys and observation IDs", () => {
  assert.equal(
    isExcludedResetEventKey("usage-reset-512a8b31-e43e-4f91-b5e6-7023b87e80ec"),
    true,
  );
  assert.equal(
    isExcludedRecoveryObservationId("512a8b31-e43e-4f91-b5e6-7023b87e80ec"),
    true,
  );
  assert.equal(isExcludedResetEventKey("regular-reset-2026-09-08"), false);
  assert.equal(isExcludedRecoveryObservationId("valid-uuid"), false);
  assert.equal(isExcludedResetEventKey(null), false);
  assert.equal(isExcludedRecoveryObservationId(undefined), false);
});

test("findNoticeBackedRecoveryEvents filters out excluded reset execution estimates", () => {
  const mockEstimates: ResetExecutionEstimate[] = [
    {
      resetEventKey: "usage-reset-512a8b31-e43e-4f91-b5e6-7023b87e80ec",
      recoveryObservationId: "512a8b31-e43e-4f91-b5e6-7023b87e80ec",
      displayExecutionAt: "2026-09-09T17:41:53.654Z",
      executionTimeSource: "usage_observation",
      executionTimeConfidence: "high",
      executionTimePrecision: "exact",
      estimatorVersion: "usage-execution-monitor-v1",
      tiboSourceTweetIds: [],
    },
  ];

  const events = findNoticeBackedRecoveryEvents(
    [],
    [],
    mockEstimates,
  );

  assert.equal(events.length, 0);
});

test("isEligibleRandomResetEvent rejects excluded reset event IDs", () => {
  const result = isEligibleRandomResetEvent(
    {
      id: "usage-reset-512a8b31-e43e-4f91-b5e6-7023b87e80ec",
      recordKind: "confirmed_global",
      completedAt: "2026-09-09T17:41:53.654Z",
      reasonSummary: "Usage reset",
    } as any,
    Date.parse("2026-09-09T17:41:53.654Z"),
    Date.parse("2026-09-10T00:00:00.000Z"),
  );

  assert.equal(result, false);
});
