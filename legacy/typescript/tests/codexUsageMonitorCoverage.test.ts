import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_MONITOR_FRESH_MAX_AGE_SECONDS,
  getNextUsageMonitorCoverageStartedAt,
  getUsageMonitorCoverage,
  getUsageMonitorCoverageAtEvent,
} from "../lib/codexUsageMonitorCoverage";
import {
  shouldDeferFormalTiboReset,
} from "../lib/radar/formalAdoption";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";

const now = new Date("2026-08-17T01:00:00.000Z");

function state(overrides: Record<string, unknown> = {}) {
  return {
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-17T00:59:00.000Z",
    receivedAt: "2026-08-17T00:59:01.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 32,
    windowDurationMins: 10080,
    resetsAt: 1787198370,
    coverageStartedAt: "2026-08-17T00:50:00.000Z",
    ...overrides,
  };
}

function resetSignal(overrides: Partial<FormalTiboResetSignal> = {}): FormalTiboResetSignal {
  return {
    tweet_id: "2089999999999999999",
    text: "I reset everyone's usage limits.",
    tweet_url: "https://x.com/thsottiaux/status/2089999999999999999",
    tweet_created_at: "2026-08-17T00:58:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: "auto_unverified",
    classification_source: "gemini",
    ...overrides,
  };
}

test("a recent valid usage monitor state is fresh", () => {
  const result = getUsageMonitorCoverage(state(), now);

  assert.equal(result.state, "fresh");
  if (result.state !== "fresh") return;
  assert.equal(result.usedPercent, 32);
  assert.equal(result.resetsAt, 1787198370);
  assert.equal(result.observedAt.toISOString(), "2026-08-17T00:59:00.000Z");
  assert.equal(result.receivedAt.toISOString(), "2026-08-17T00:59:01.000Z");
  assert.equal(result.coverageStartedAt.toISOString(), "2026-08-17T00:50:00.000Z");
});

test("a valid state older than the freshness window is stale", () => {
  const result = getUsageMonitorCoverage(
    state({
      observedAt: new Date(now.getTime() - (USAGE_MONITOR_FRESH_MAX_AGE_SECONDS + 1) * 1000).toISOString(),
      receivedAt: new Date(now.getTime() - (USAGE_MONITOR_FRESH_MAX_AGE_SECONDS + 1) * 1000).toISOString(),
      coverageStartedAt: new Date(now.getTime() - (USAGE_MONITOR_FRESH_MAX_AGE_SECONDS + 2) * 1000).toISOString(),
    }),
    now,
  );

  assert.deepEqual(result, { state: "stale" });
});

test("missing, malformed, or future usage state is unavailable", () => {
  assert.deepEqual(getUsageMonitorCoverage(null, now), { state: "unavailable" });
  assert.deepEqual(
    getUsageMonitorCoverage(state({ coverageStartedAt: null }), now),
    { state: "unavailable" },
  );
  assert.deepEqual(getUsageMonitorCoverage(state({ usedPercent: "32" }), now), { state: "unavailable" });
  assert.deepEqual(
    getUsageMonitorCoverage(
      state({ observedAt: new Date(now.getTime() + 1_000).toISOString() }),
      now,
    ),
    { state: "unavailable" },
  );
});

test("fresh coverage without a matching recovery defers unverified Tibo reset adoption", () => {
  const coverage = getUsageMonitorCoverage(state(), now);

  assert.equal(
    shouldDeferFormalTiboReset(resetSignal(), coverage, {
      available: true,
      matched: false,
    }),
    true,
  );
});

test("fresh coverage with a matching recovery allows Tibo reset adoption", () => {
  const coverage = getUsageMonitorCoverage(state(), now);

  assert.equal(
    shouldDeferFormalTiboReset(resetSignal(), coverage, {
      available: true,
      matched: true,
    }),
    false,
  );
});

test("stale, unavailable, or unavailable recovery lookup never turns absence into a rejection", () => {
  const stale = getUsageMonitorCoverage(
    state({
      observedAt: "2026-08-16T23:00:00.000Z",
      receivedAt: "2026-08-16T23:00:01.000Z",
    }),
    now,
  );
  const unavailable = getUsageMonitorCoverage(null, now);
  const fresh = getUsageMonitorCoverage(state(), now);

  assert.equal(shouldDeferFormalTiboReset(resetSignal(), stale, { available: true, matched: false }), false);
  assert.equal(shouldDeferFormalTiboReset(resetSignal(), unavailable, { available: true, matched: false }), false);
  assert.equal(shouldDeferFormalTiboReset(resetSignal(), fresh, { available: false, matched: false }), false);
});

test("coverage can defer only when the Tibo event is inside continuous monitor coverage", () => {
  const coverage = getUsageMonitorCoverageAtEvent(
    state(),
    "2026-08-17T00:58:00.000Z",
    now,
  );

  assert.equal(coverage.state, "fresh");
  assert.equal(
    shouldDeferFormalTiboReset(resetSignal(), coverage, {
      available: true,
      matched: false,
    }),
    true,
  );
});

test("a Tibo event before monitor startup is not deferred by a fresh current state", () => {
  const coverage = getUsageMonitorCoverageAtEvent(
    state(),
    "2026-08-17T00:49:59.000Z",
    now,
  );

  assert.deepEqual(coverage, { state: "unavailable" });
  assert.equal(
    shouldDeferFormalTiboReset(resetSignal({ tweet_created_at: "2026-08-17T00:49:59.000Z" }), coverage, {
      available: true,
      matched: false,
    }),
    false,
  );
});

test("a current fresh state does not cover an event after the last observed snapshot", () => {
  assert.deepEqual(
    getUsageMonitorCoverageAtEvent(state(), "2026-08-17T01:00:01.000Z", now),
    { state: "unavailable" },
  );
});

test("a gap starts a new coverage interval instead of inferring continuity", () => {
  const next = getNextUsageMonitorCoverageStartedAt(
    state({
      observedAt: "2026-08-17T00:10:00.000Z",
      coverageStartedAt: "2026-08-17T00:00:00.000Z",
    }),
    {
      observedAt: "2026-08-17T00:26:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 30,
      windowDurationMins: 10080,
      resetsAt: 1787198370,
    },
  );

  assert.equal(next, "2026-08-17T00:26:00.000Z");
});

test("a manually confirmed Tibo reset remains eligible even without monitor recovery", () => {
  const coverage = getUsageMonitorCoverage(state(), now);

  assert.equal(
    shouldDeferFormalTiboReset(
      resetSignal({ verification_status: "confirmed" }),
      coverage,
      { available: true, matched: false },
    ),
    false,
  );
});
