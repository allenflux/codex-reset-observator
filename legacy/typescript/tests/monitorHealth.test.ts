import assert from "node:assert/strict";
import test from "node:test";
import {
  MONITOR_PARSE_ALERT_AGE_SECONDS,
  evaluateTiboHeartbeat,
  type TiboHeartbeatSnapshot,
} from "../lib/radar/monitorHealth";

const now = new Date("2026-08-02T00:00:00.000Z");

function snapshot(
  overrides: Partial<TiboHeartbeatSnapshot> = {},
): TiboHeartbeatSnapshot {
  return {
    session_started_at: null,
    last_heartbeat_at: "2026-08-01T23:58:00.000Z",
    last_successful_parse_at: "2026-08-01T23:55:00.000Z",
    last_scan_error: null,
    last_page_reload_status: "success",
    last_page_reload_error: null,
    ...overrides,
  };
}

test("reports recent heartbeat and parse activity with safe ages", () => {
  const result = evaluateTiboHeartbeat(snapshot(), now);

  assert.deepStrictEqual(result, {
    status: "healthy",
    detail: "healthy",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 300,
  });
});

test("health output contains no scan snapshot or diagnostic payload", () => {
  const result = evaluateTiboHeartbeat(snapshot(), now);

  assert.doesNotMatch(JSON.stringify(result), /html|snapshot|tweetText|scanSummary/i);
});

test("reports a heartbeat older than fifteen minutes as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_heartbeat_at: "2026-08-01T23:44:59.000Z" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "heartbeat_stale",
    heartbeatAgeSeconds: 901,
    parseAgeSeconds: 300,
  });
});

test("does not expose an unavailable parse age alongside a stale heartbeat", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      last_heartbeat_at: "2026-08-01T23:44:59.000Z",
      last_successful_parse_at: null,
    }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "heartbeat_stale",
    heartbeatAgeSeconds: 901,
  });
});

test("reports a missing heartbeat timestamp as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_heartbeat_at: null }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "heartbeat_missing",
  });
});

test("reports a missing parse timestamp as a warning during a new session", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      session_started_at: "2026-08-02T00:00:00.000Z",
      last_successful_parse_at: null,
    }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "warning",
    detail: "parse_missing",
    heartbeatAgeSeconds: 120,
  });
});

test("does not grant parse_missing a grace period without a valid session start", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_successful_parse_at: null }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "parse_missing",
    heartbeatAgeSeconds: 120,
  });
});

test("keeps parse_missing as a warning through the 30-minute grace period", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      session_started_at: "2026-08-01T23:31:00.000Z",
      last_successful_parse_at: null,
    }),
    now,
  );

  assert.equal(result.status, "warning");
  assert.equal(result.detail, "parse_missing");
  assert.equal(
    Math.floor((now.getTime() - new Date("2026-08-01T23:31:00.000Z").getTime()) / 1000),
    MONITOR_PARSE_ALERT_AGE_SECONDS - 60,
  );
});

test("reports parse_missing as unhealthy after the 30-minute grace period", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      session_started_at: "2026-08-01T23:29:00.000Z",
      last_successful_parse_at: null,
    }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "parse_missing",
    heartbeatAgeSeconds: 120,
  });
});

test("reports invalid timestamps as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_successful_parse_at: "not-a-timestamp" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "parse_invalid",
    heartbeatAgeSeconds: 120,
  });
});

test("reports an invalid heartbeat timestamp as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_heartbeat_at: "not-a-timestamp" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "heartbeat_invalid",
  });
});

test("reports a future heartbeat timestamp as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_heartbeat_at: "2026-08-02T00:00:01.000Z" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "heartbeat_future",
  });
});

test("reports a parse timestamp 16 minutes old as a warning", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_successful_parse_at: "2026-08-01T23:44:00.000Z" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "warning",
    detail: "parse_stale",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 960,
  });
});

test("reports a parse timestamp older than thirty minutes as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_successful_parse_at: "2026-08-01T23:29:59.000Z" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "parse_stale",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 1801,
  });
});

test("keeps a stale heartbeat unhealthy during the parse grace period", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      last_heartbeat_at: "2026-08-01T23:44:59.000Z",
      last_successful_parse_at: "2026-08-01T23:45:00.000Z",
    }),
    now,
  );

  assert.equal(result.status, "unhealthy");
  assert.equal(result.detail, "heartbeat_stale");
});

test("does not soften an operational scan error during the parse grace period", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({
      session_started_at: "2026-08-02T00:00:00.000Z",
      last_successful_parse_at: null,
      last_scan_error: "scan_error",
    }),
    now,
  );

  assert.equal(result.status, "unhealthy");
  assert.equal(result.detail, "scan_error");
});

test("reports a future parse timestamp as unhealthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_successful_parse_at: "2026-08-02T00:00:01.000Z" }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "parse_future",
    heartbeatAgeSeconds: 120,
  });
});

test("does not expose a scan error in the public health detail", () => {
  const rawScanError = "connection reset: internal database address";
  const result = evaluateTiboHeartbeat(
    snapshot({ last_scan_error: rawScanError }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "scan_error",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 300,
  });
  assert.doesNotMatch(JSON.stringify(result), /connection reset|database address/i);
});

test("does not expose a page reload error when its status is not successful", () => {
  const rawReloadError = "profile tab title includes private context";
  const result = evaluateTiboHeartbeat(
    snapshot({
      last_page_reload_status: "monitored_tab_missing",
      last_page_reload_error: rawReloadError,
    }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "unhealthy",
    detail: "page_reload_failed",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 300,
  });
  assert.doesNotMatch(JSON.stringify(result), /private context/i);
});

test("allows a missing page reload status when current heartbeat data is healthy", () => {
  const result = evaluateTiboHeartbeat(
    snapshot({ last_page_reload_status: null }),
    now,
  );

  assert.deepStrictEqual(result, {
    status: "healthy",
    detail: "healthy",
    heartbeatAgeSeconds: 120,
    parseAgeSeconds: 300,
  });
});
