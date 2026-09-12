import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { PublicRadarSnapshot } from "../lib/radar/types";
import { GET } from "../app/api/reset-marker/route";
import { RESET_MARKER_CACHE_CONTROL } from "../lib/resetMarkerStore";
import {
  PUBLIC_RANDOM_RESET_EXECUTION_ESTIMATOR_VERSIONS,
  isPublicRandomResetExecutionEstimate,
  type ResetExecutionEstimate,
} from "../lib/radar/resetExecution";
import {
  RESET_MARKER_CATCH_UP_RETRY_DELAY_MS,
  RESET_MARKER_MAX_CATCH_UP_RETRIES,
  RESET_MARKER_POLL_INTERVAL_MS,
  beginResetMarkerRefresh,
  buildCurrentRadarFetchUrl,
  createResetMarkerState,
  getInitialResetMarkerPlan,
  getResetMarkerCatchUpPlan,
  getResetMarkerPollPlan,
  getResetMarkerRequestUrl,
  observeResetMarker,
  type ResetMarkerPayload,
} from "../lib/radar/resetMarker";

const marker = (value: string, resetAt = "2026-09-01T00:02:00.000Z"): ResetMarkerPayload => ({
  schemaVersion: "reset-marker-v1",
  marker: value,
  resetAt,
});

function snapshot(lastRandomResetAt: string | null): PublicRadarSnapshot {
  return {
    schemaVersion: "public-v1",
    checkedAt: "2026-09-01T00:03:00.000Z",
    updatedAt: null,
    lastRandomResetAt,
    dataHealth: {
      overall: "ok",
      stale: false,
      generatedAt: "2026-09-01T00:03:00.000Z",
      sources: {
        supabaseSignals: { state: "ok" },
        openAIStatus: { state: "ok" },
      },
    },
    viewModel: {} as PublicRadarSnapshot["viewModel"],
  };
}

test("initial marker establishes a baseline without requesting a full snapshot", () => {
  const initial = observeResetMarker(createResetMarkerState(), marker("m1"));
  assert.equal(initial.action, "baseline");
  assert.equal(initial.state.marker, "m1");

  const unchanged = observeResetMarker(initial.state, marker("m1"));
  assert.equal(unchanged.action, "unchanged");
  assert.equal(unchanged.state.pending, null);
});

test("initial marker refreshes only when the displayed snapshot is behind", () => {
  const oldSnapshot = snapshot("2026-09-01T00:01:00.000Z");
  const newMarker = marker("m2", "2026-09-01T00:02:00.000Z");
  assert.equal(getInitialResetMarkerPlan(oldSnapshot, newMarker).action, "refresh");
  assert.equal(getInitialResetMarkerPlan(snapshot("2026-09-01T00:02:00.000Z"), newMarker).action, "baseline");
  assert.equal(getInitialResetMarkerPlan(snapshot(null), newMarker).action, "refresh");
  assert.equal(
    getInitialResetMarkerPlan(oldSnapshot, marker("invalid", "not-a-timestamp")).action,
    "baseline",
  );

  const pending = beginResetMarkerRefresh(createResetMarkerState(), newMarker);
  assert.equal(pending.pending?.marker, "m2");
  assert.equal(pending.marker, "m2");
});

test("marker change requests one cache-busted full fetch and URL keeps the marker out of model inputs", () => {
  const baseline = observeResetMarker(createResetMarkerState(), marker("m1"));
  const changed = observeResetMarker(baseline.state, marker("m2"));

  assert.equal(changed.action, "refresh");
  assert.equal(changed.state.pending?.marker, "m2");
  assert.equal(
    buildCurrentRadarFetchUrl("ja", "m2"),
    "/api/current?locale=ja&resetMarker=m2",
  );
  assert.equal(buildCurrentRadarFetchUrl("en"), "/api/current?locale=en");
  assert.equal(getResetMarkerRequestUrl(), "/api/reset-marker");
});

test("catch-up retries are bounded and stop after the marker is reflected", () => {
  const changedMarker = marker("m2");
  assert.deepEqual(
    getResetMarkerCatchUpPlan(snapshot("2026-09-01T00:01:59.000Z"), changedMarker, 0),
    { action: "retry", delayMs: RESET_MARKER_CATCH_UP_RETRY_DELAY_MS },
  );
  assert.deepEqual(
    getResetMarkerCatchUpPlan(snapshot("2026-09-01T00:01:59.000Z"), changedMarker, 1),
    { action: "retry", delayMs: RESET_MARKER_CATCH_UP_RETRY_DELAY_MS },
  );
  assert.deepEqual(
    getResetMarkerCatchUpPlan(snapshot("2026-09-01T00:01:59.000Z"), changedMarker, RESET_MARKER_MAX_CATCH_UP_RETRIES),
    { action: "defer", delayMs: RESET_MARKER_POLL_INTERVAL_MS },
  );
  assert.deepEqual(
    getResetMarkerCatchUpPlan(snapshot("2026-09-01T00:02:00.000Z"), changedMarker, 0),
    { action: "accepted", delayMs: 0 },
  );
});

test("marker polling is visible-only and visibility resume is bounded by the last check", () => {
  assert.equal(RESET_MARKER_POLL_INTERVAL_MS, 5 * 60 * 1000);
  const now = Date.parse("2026-09-01T00:10:00.000Z");
  assert.deepEqual(getResetMarkerPollPlan(null, now, "visible", true), {
    action: "check",
    delayMs: 0,
  });
  assert.deepEqual(getResetMarkerPollPlan(now - 30_000, now, "visible", true), {
    action: "wait",
    delayMs: RESET_MARKER_POLL_INTERVAL_MS - 30_000,
  });
  assert.deepEqual(getResetMarkerPollPlan(now - RESET_MARKER_POLL_INTERVAL_MS, now, "visible", true), {
    action: "check",
    delayMs: 0,
  });
  assert.deepEqual(getResetMarkerPollPlan(null, now, "hidden", true), {
    action: "stop",
    delayMs: null,
  });
  assert.deepEqual(getResetMarkerPollPlan(null, now, "visible", false), {
    action: "stop",
    delayMs: null,
  });
});

test("RadarDashboard owns marker polling while retaining the existing full refresh path", () => {
  const source = readFileSync(resolve("components/RadarDashboard.tsx"), "utf8");
  assert.match(source, /getResetMarkerRequestUrl/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /getResetMarkerPollPlan/);
  assert.match(source, /resetMarker/);
  assert.match(source, /getInitialRefreshPlan/);
  assert.doesNotMatch(source, /cache:\s*"no-store"/);
});

test("reset-marker route is a lightweight endpoint and does not build Radar data", () => {
  const source = readFileSync(resolve("app/api/reset-marker/route.ts"), "utf8");
  assert.doesNotMatch(source, /fetchCurrentRadarData|getRadarViewModel|toPublicRadarSnapshot|calculatePublishedProbability/);
  assert.match(source, /RESET_MARKER_CACHE_CONTROL/);
  assert.equal(RESET_MARKER_CACHE_CONTROL, "public, max-age=0, s-maxage=300");
});

test("reset-marker route performs one bounded estimate query and returns the public marker contract", async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-value";
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return new Response(JSON.stringify([
      {
        reset_event_key: "usage-reset-marker-test",
        display_execution_at: "2026-09-01T00:02:00.000Z",
        execution_time_source: "usage_observation",
        execution_time_confidence: "high",
        execution_time_precision: "approximate",
        execution_window_start_at: "2026-09-01T00:01:00.000Z",
        execution_window_end_at: "2026-09-01T00:02:00.000Z",
        recovery_observation_id: "recovery-marker-test",
        tibo_primary_tweet_id: null,
        tibo_source_tweet_ids: [],
        official_notice_tweet_id: null,
        estimator_version: "usage-execution-monitor-v1",
      },
    ]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), RESET_MARKER_CACHE_CONTROL);
    assert.deepEqual(await response.json(), {
      schemaVersion: "reset-marker-v1",
      marker: "usage-reset-marker-test:2026-09-01T00:02:00.000Z",
      resetAt: "2026-09-01T00:02:00.000Z",
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/rest\/v1\/reset_execution_estimates\?/);
    assert.match(requests[0], /execution_time_source=eq\.usage_observation/);
    assert.equal(
      new URL(requests[0]).searchParams.get("estimator_version"),
      "in.(usage-execution-v1,usage-execution-teaser-v1,usage-execution-monitor-v1)",
    );
    assert.match(requests[0], /execution_time_confidence=eq\.high/);
    assert.match(requests[0], /execution_time_precision=eq\.approximate/);
    assert.match(requests[0], /execution_window_start_at=not\.is\.null/);
    assert.match(requests[0], /execution_window_end_at=not\.is\.null/);
    assert.match(requests[0], /recovery_observation_id=not\.is\.null/);
    assert.match(requests[0], /limit=1/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

function validMarkerEstimate(
  overrides: Partial<ResetExecutionEstimate> = {},
): Partial<ResetExecutionEstimate> {
  return {
    displayExecutionAt: "2026-09-01T00:02:00.000Z",
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: "2026-09-01T00:01:00.000Z",
    executionWindowEndAt: "2026-09-01T00:02:00.000Z",
    recoveryObservationId: "recovery-marker-test",
    tiboPrimaryTweetId: null,
    tiboSourceTweetIds: [],
    officialNoticeTweetId: null,
    estimatorVersion: PUBLIC_RANDOM_RESET_EXECUTION_ESTIMATOR_VERSIONS[0],
    ...overrides,
  };
}

test("marker eligibility covers all public random execution estimators and excludes non-boundaries", () => {
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      estimatorVersion: "usage-execution-monitor-v1",
    })),
    true,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      estimatorVersion: "usage-execution-teaser-v1",
      tiboPrimaryTweetId: "teaser-marker-test",
      tiboSourceTweetIds: ["teaser-marker-test"],
    })),
    true,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      estimatorVersion: "usage-execution-v1",
      officialNoticeTweetId: "notice-marker-test",
      tiboSourceTweetIds: ["notice-marker-test"],
    })),
    true,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      estimatorVersion: "banked-distribution-observation-v2",
    })),
    false,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      executionTimeConfidence: "low",
    })),
    false,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      executionWindowEndAt: null,
    })),
    false,
  );
  assert.equal(
    isPublicRandomResetExecutionEstimate(validMarkerEstimate({
      executionTimeSource: "manual_override",
    })),
    false,
  );
});
