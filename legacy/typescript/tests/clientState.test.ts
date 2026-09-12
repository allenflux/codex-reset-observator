import assert from "node:assert";
import test from "node:test";
import type { CachedRadarData, PublicRadarSnapshot } from "../lib/radar/types";
import {
  applyRefreshFailure,
  applyRefreshSuccess,
  getDashboardDataState,
  parseCachedRadarData,
  type RadarLoadState,
} from "../lib/radar/clientState";

function snapshot(checkedAt: string, overall: "ok" | "degraded" = "ok"): PublicRadarSnapshot {
  return {
    schemaVersion: "public-v1",
    checkedAt,
    updatedAt: null,
    lastRandomResetAt: null,
    dataHealth: {
      overall,
      stale: false,
      generatedAt: checkedAt,
      sources: {
        supabaseSignals: { state: overall === "ok" ? "ok" : "degraded" },
        openAIStatus: { state: overall === "ok" ? "ok" : "degraded" },
      },
    },
    viewModel: {} as PublicRadarSnapshot["viewModel"],
  };
}

const currentData = snapshot("2026-08-01T00:00:00.000Z");
const cachedData = snapshot("2026-07-31T00:00:00.000Z");

function cacheableSnapshot(checkedAt: string) {
  const data = snapshot(checkedAt);
  data.viewModel = {
    status: "ok",
    expectation: "low",
    codexOperationalStatus: "none",
    probability24h: 0.02,
    probability48h: 0.05,
    lastUpdated: checkedAt,
    regularResetForecast: {
      date: "2026-08-08",
      time: null,
      remaining: "7 days",
      sourceResetAt: null,
      expectedAt: null,
      lastCompletedAt: checkedAt,
      remainingDays: 7,
      isNoticeWindow: false,
    },
    activeWindow: {
      active: false,
      kind: "none",
      label: "none",
      summary: "none",
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
  };
  return data;
}

test("applyRefreshSuccess clears an earlier refresh failure", () => {
  assert.deepStrictEqual(
    applyRefreshSuccess(currentData, "2026-08-01T12:00:00.000Z"),
    {
      data: currentData,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      isStale: false,
      refreshError: null,
    },
  );
});

test("applyRefreshFailure preserves current data ahead of an older cache", () => {
  const current: RadarLoadState = {
    data: currentData,
    fetchedAt: "2026-08-01T12:00:00.000Z",
    isStale: false,
    refreshError: null,
  };
  const cached: CachedRadarData = {
    schemaVersion: "public-v1",
    locale: "ja",
    data: cachedData,
    fetchedAt: "2026-07-31T12:00:00.000Z",
  };

  assert.deepStrictEqual(applyRefreshFailure(current, cached), {
    data: currentData,
    fetchedAt: "2026-08-01T12:00:00.000Z",
    isStale: true,
    refreshError: "request_failed",
  });
});

test("applyRefreshFailure falls back to cached data when current data is absent", () => {
  const current: RadarLoadState = {
    data: null,
    fetchedAt: null,
    isStale: false,
    refreshError: null,
  };
  const cached: CachedRadarData = {
    schemaVersion: "public-v1",
    locale: "ja",
    data: cachedData,
    fetchedAt: "2026-07-31T12:00:00.000Z",
  };

  assert.deepStrictEqual(applyRefreshFailure(current, cached), {
    data: cachedData,
    fetchedAt: "2026-07-31T12:00:00.000Z",
    isStale: true,
    refreshError: "request_failed",
  });
});

test("applyRefreshFailure without current or cached data is unavailable", () => {
  const failed = applyRefreshFailure(
    { data: null, fetchedAt: null, isStale: false, refreshError: null },
    null,
  );

  assert.deepStrictEqual(failed, {
    data: null,
    fetchedAt: null,
    isStale: true,
    refreshError: "request_failed",
  });
  assert.strictEqual(getDashboardDataState(failed), "unavailable");
});

test("getDashboardDataState gives unavailable, stale, and degraded data the required precedence", () => {
  const degradedData = snapshot("2026-08-01T12:00:00.000Z", "degraded");

  assert.strictEqual(
    getDashboardDataState({ data: null, fetchedAt: null, isStale: true, refreshError: "request_failed" }),
    "unavailable",
  );
  assert.strictEqual(
    getDashboardDataState({ data: degradedData, fetchedAt: null, isStale: true, refreshError: "request_failed" }),
    "stale",
  );
  assert.strictEqual(
    getDashboardDataState({ data: degradedData, fetchedAt: null, isStale: false, refreshError: null }),
    "degraded",
  );
  assert.strictEqual(
    getDashboardDataState({ data: currentData, fetchedAt: null, isStale: false, refreshError: null }),
    "ready",
  );
});

test("locale-specific cache accepts only a valid same-locale public snapshot", () => {
  const data = cacheableSnapshot("2026-08-01T00:00:00.000Z");
  const raw = JSON.stringify({
    schemaVersion: "public-v1",
    locale: "en",
    data,
    fetchedAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(parseCachedRadarData(raw, "en")?.locale, "en");
  assert.equal(parseCachedRadarData(raw, "ja"), null);
  assert.equal(parseCachedRadarData("{broken", "en"), null);
  assert.equal(parseCachedRadarData(raw.replace("public-v1", "private-v1"), "en"), null);
  assert.equal(parseCachedRadarData(null, "en"), null);
});

test("locale cache ignores the old shared key and malformed required fields", () => {
  const data = cacheableSnapshot("2026-08-01T00:00:00.000Z");
  const valid = {
    schemaVersion: "public-v1",
    locale: "ja",
    data,
    fetchedAt: "2026-08-01T00:00:00.000Z",
  };

  assert.equal(parseCachedRadarData(JSON.stringify(valid), "ja")?.data.schemaVersion, "public-v1");
  assert.equal(parseCachedRadarData(JSON.stringify({ ...valid, fetchedAt: "not-a-date" }), "ja"), null);
  assert.equal(parseCachedRadarData(JSON.stringify({ ...valid, data: { ...data, viewModel: {} } }), "ja"), null);
});
