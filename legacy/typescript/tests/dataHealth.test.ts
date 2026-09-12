import assert from "node:assert/strict";
import test from "node:test";

import {
  combineDataSourceHealth,
  createRadarDataHealth,
  getDatabaseReadHealth,
  getRequiredConfigurationHealth,
  OK_DATA_SOURCE,
} from "../lib/radar/dataHealth";

test("reports missing required source configuration", () => {
  assert.deepStrictEqual(getRequiredConfigurationHealth([undefined, "key"]), {
    state: "misconfigured",
    detail: "missing_configuration",
  });
  assert.deepStrictEqual(getRequiredConfigurationHealth(["url", "key"]), {
    state: "ok",
  });
});

test("prioritizes configuration failure before database results", () => {
  assert.deepStrictEqual(
    getDatabaseReadHealth(
      { state: "misconfigured", detail: "missing_configuration" },
      { hasData: true, hasError: false },
    ),
    { state: "misconfigured", detail: "missing_configuration" },
  );
});

test("classifies database query errors", () => {
  assert.deepStrictEqual(
    getDatabaseReadHealth(OK_DATA_SOURCE, { hasData: false, hasError: true }),
    { state: "degraded", detail: "database_error" },
  );
});

test("classifies null database responses without query errors", () => {
  assert.deepStrictEqual(
    getDatabaseReadHealth(OK_DATA_SOURCE, { hasData: false, hasError: false }),
    { state: "degraded", detail: "invalid_response" },
  );
});

test("accepts intentionally empty database arrays", () => {
  assert.deepStrictEqual(
    getDatabaseReadHealth(OK_DATA_SOURCE, { hasData: true, hasError: false }),
    { state: "ok" },
  );
});

test("combines source health using the strongest failure", () => {
  assert.deepStrictEqual(
    combineDataSourceHealth(
      { state: "ok" },
      { state: "degraded", detail: "request_failed" },
      { state: "misconfigured", detail: "missing_configuration" },
    ),
    { state: "misconfigured", detail: "missing_configuration" },
  );
});

test("marks radar health degraded when either required source is not ok", () => {
  const checkedAt = "2026-08-01T00:00:00.000Z";
  const okHealth = { state: "ok" } as const;
  const degradedHealth = { state: "degraded", detail: "request_failed" } as const;

  assert.strictEqual(
    createRadarDataHealth(checkedAt, okHealth, degradedHealth).overall,
    "degraded",
  );
});
