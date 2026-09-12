import assert from "node:assert/strict";
import test from "node:test";

import {
  canStartRadarRefresh,
  getEventRefreshPlan,
  getInitialRefreshPlan,
  getRefreshRetryDelayMs,
  RADAR_FETCH_TIMEOUT_MS,
  STALE_DATA_REFRESH_INTERVAL_MS,
  startAbortTimeout,
} from "../lib/radar/refreshPolicy";
import type { PublicRadarSnapshot } from "../lib/radar/types";

function snapshot(
  checkedAt: string,
  options: {
    stale?: boolean;
    overall?: "ok" | "degraded";
    official?: boolean;
    provisional?: boolean;
    probability24h?: number;
    expectedAt?: string | null;
    expectedEndAt?: string | null;
  } = {},
): PublicRadarSnapshot {
  return {
    schemaVersion: "public-v1",
    checkedAt,
    updatedAt: null,
    lastRandomResetAt: null,
    dataHealth: {
      overall: options.overall ?? "ok",
      stale: options.stale ?? false,
      generatedAt: checkedAt,
      sources: {
        supabaseSignals: { state: "ok" },
        openAIStatus: { state: "ok" },
      },
    },
    viewModel: {
      status: "ok",
      expectation: "低",
      codexOperationalStatus: "none",
      probability24h: options.probability24h ?? 0.02,
      probability48h: 0.05,
      lastUpdated: checkedAt,
      regularResetForecast: {
        date: "2026-08-08",
        time: null,
        remaining: "7 days",
        sourceResetAt: checkedAt,
        expectedAt: null,
        lastCompletedAt: checkedAt,
        remainingDays: 7,
        isNoticeWindow: false,
      },
      activeWindow: {
        active: options.official ?? false,
        kind: options.official ? "official" : "none",
        label: options.official ? "official" : "none",
        summary: options.official ? "official" : "none",
        expectedAt: options.expectedAt ?? null,
        expectedEndAt: options.expectedEndAt ?? null,
      },
      displayReasoningSummary: null,
      latestWindow: {
        kind: "observed",
        title: "none",
        summary: "none",
        scope: "all",
        windowLength: "0 minutes",
      },
      recentHistory: [],
    },
    recoveryObservation: options.provisional
      ? {
          status: "observed_unconfirmed",
          observedAt: checkedAt,
          confidence: "strong",
          cycleHint: "unexpected",
        }
      : null,
  };
}

const NOW = Date.parse("2026-08-04T01:00:00.000Z");
const FRESH_AT = "2026-08-04T00:56:00.000Z";

test("fresh initial data respects the probability-based update interval", () => {
  assert.deepEqual(getInitialRefreshPlan(snapshot(FRESH_AT), FRESH_AT, NOW), {
    action: "wait",
    delayMs: 30 * 60 * 1000 - 4 * 60 * 1000,
  });
});

test("wake events wait for fresh data and coalesce rapid events", () => {
  assert.deepEqual(
    getEventRefreshPlan(snapshot(FRESH_AT), FRESH_AT, Date.parse(FRESH_AT) + 29_000),
    { action: "wait", delayMs: 1_000 },
  );
  assert.deepEqual(
    getEventRefreshPlan(snapshot(FRESH_AT), FRESH_AT, Date.parse(FRESH_AT) + 30_000),
    { action: "wait", delayMs: 30 * 60 * 1000 - 30_000 },
  );
});

test("wake events fetch once the probability-based freshness interval expires", () => {
  const fetchedAt = Date.parse(FRESH_AT);
  assert.deepEqual(
    getEventRefreshPlan(
      snapshot(FRESH_AT, { probability24h: 0.3 }),
      FRESH_AT,
      fetchedAt + 30 * 60 * 1000 - 1,
    ),
    { action: "wait", delayMs: 1 },
  );
  assert.deepEqual(
    getEventRefreshPlan(
      snapshot(FRESH_AT, { probability24h: 0.3 }),
      FRESH_AT,
      fetchedAt + 30 * 60 * 1000,
    ),
    { action: "fetch", delayMs: 0 },
  );
});

test("stale data waits five minutes while still coalescing rapid wake events", () => {
  const stale = snapshot(FRESH_AT, { stale: true });
  assert.deepEqual(
    getEventRefreshPlan(stale, FRESH_AT, Date.parse(FRESH_AT) + 29_000),
    { action: "wait", delayMs: 1_000 },
  );
  assert.deepEqual(
    getEventRefreshPlan(stale, FRESH_AT, Date.parse(FRESH_AT) + 30_000),
    { action: "wait", delayMs: STALE_DATA_REFRESH_INTERVAL_MS - 30_000 },
  );
});

test("normal refresh intervals are low 30 minutes, medium 30 minutes, high 20 minutes, and very high 10 minutes", () => {
  const fetchedAt = Date.parse(FRESH_AT);
  const cases = [
    [0.02, 30 * 60 * 1000],
    [0.2, 30 * 60 * 1000],
    [0.3, 30 * 60 * 1000],
    [0.7, 20 * 60 * 1000],
    [0.9, 10 * 60 * 1000],
  ] as const;

  for (const [probability24h, intervalMs] of cases) {
    assert.deepEqual(
      getInitialRefreshPlan(snapshot(FRESH_AT, { probability24h }), FRESH_AT, fetchedAt),
      { action: "wait", delayMs: intervalMs },
    );
  }
});

test("official notices without schedule details refresh at a bounded ten-minute cadence", () => {
  assert.deepEqual(
    getInitialRefreshPlan(snapshot(FRESH_AT, { official: true }), FRESH_AT, Date.parse(FRESH_AT)),
    { action: "wait", delayMs: 10 * 60 * 1000 },
  );
  assert.deepEqual(
    getEventRefreshPlan(
      snapshot(FRESH_AT, { official: true }),
      FRESH_AT,
      Date.parse(FRESH_AT) + 10 * 60 * 1000,
    ),
    { action: "fetch", delayMs: 0 },
  );
});

test("official notice refresh cadence shortens as the expected start approaches", () => {
  const fetchedAt = Date.parse(FRESH_AT);
  const cases = [
    [6 * 60 * 60 * 1000, 15 * 60 * 1000],
    [2 * 60 * 60 * 1000, 10 * 60 * 1000],
    [30 * 60 * 1000, 10 * 60 * 1000],
    [30 * 60 * 1000 - 1, 5 * 60 * 1000],
    [0, 5 * 60 * 1000],
    [-10 * 60 * 1000, 5 * 60 * 1000],
  ] as const;

  for (const [remainingMs, intervalMs] of cases) {
    const expectedAt = new Date(fetchedAt + remainingMs).toISOString();
    assert.deepEqual(
      getInitialRefreshPlan(snapshot(FRESH_AT, { official: true, expectedAt }), FRESH_AT, fetchedAt),
      { action: "wait", delayMs: intervalMs },
    );
  }
});

test("active strong provisional recovery refreshes every five minutes", () => {
  assert.deepEqual(
    getInitialRefreshPlan(snapshot(FRESH_AT, { provisional: true }), FRESH_AT, Date.parse(FRESH_AT)),
    { action: "wait", delayMs: 5 * 60 * 1000 },
  );
});

test("missing or invalid data fetches immediately, while stale or degraded success waits five minutes", () => {
  assert.deepEqual(getInitialRefreshPlan(null, null, NOW), { action: "fetch", delayMs: 0 });
  assert.deepEqual(getInitialRefreshPlan(snapshot(FRESH_AT), "invalid", NOW), { action: "fetch", delayMs: 0 });
  assert.deepEqual(
    getInitialRefreshPlan(snapshot(FRESH_AT, { stale: true }), FRESH_AT, Date.parse(FRESH_AT)),
    { action: "wait", delayMs: STALE_DATA_REFRESH_INTERVAL_MS },
  );
  assert.deepEqual(
    getInitialRefreshPlan(snapshot(FRESH_AT, { overall: "degraded" }), FRESH_AT, Date.parse(FRESH_AT)),
    { action: "wait", delayMs: STALE_DATA_REFRESH_INTERVAL_MS },
  );
  assert.deepEqual(
    getInitialRefreshPlan(snapshot(FRESH_AT), FRESH_AT, NOW + 30 * 60 * 1000),
    { action: "fetch", delayMs: 0 },
  );
});

test("retry delays are one minute, five minutes, and fifteen minutes", () => {
  assert.equal(getRefreshRetryDelayMs(1), 60 * 1000);
  assert.equal(getRefreshRetryDelayMs(2), 5 * 60 * 1000);
  assert.equal(getRefreshRetryDelayMs(3), 15 * 60 * 1000);
  assert.equal(getRefreshRetryDelayMs(99), 15 * 60 * 1000);
});

test("refresh is blocked while hidden, offline, or already in flight", () => {
  assert.equal(canStartRadarRefresh({ visibilityState: "visible", onLine: true, inFlight: false }), true);
  assert.equal(canStartRadarRefresh({ visibilityState: "hidden", onLine: true, inFlight: false }), false);
  assert.equal(canStartRadarRefresh({ visibilityState: "visible", onLine: false, inFlight: false }), false);
  assert.equal(canStartRadarRefresh({ visibilityState: "visible", onLine: true, inFlight: true }), false);
});

test("abort timeout cancels the request at fifteen seconds", () => {
  const controller = new AbortController();
  const timeoutCallback: { current: (() => void) | null } = { current: null };
  let clearedHandle: unknown = null;

  const timeout = startAbortTimeout(
    controller,
    RADAR_FETCH_TIMEOUT_MS,
    (callback) => {
      timeoutCallback.current = callback;
      return "timeout-handle";
    },
    (handle) => {
      clearedHandle = handle;
    },
  );

  assert.equal(controller.signal.aborted, false);
  assert.equal(timeout.hasTimedOut(), false);
  timeoutCallback.current?.();
  assert.equal(controller.signal.aborted, true);
  assert.equal(timeout.hasTimedOut(), true);
  timeout.cancel();
  assert.equal(clearedHandle, "timeout-handle");
});
