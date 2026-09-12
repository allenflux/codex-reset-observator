import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST as postCodexUsage } from "../app/api/webhook/codex-usage/route";
import { GET as getMonitorHealth } from "../app/api/monitor/health/route";
import { POST as postLogProbability } from "../app/api/log-probability/route";
import { POST as postTibo } from "../app/api/webhook/tibo/route";
import { POST as postTiboHeartbeat } from "../app/api/webhook/tibo/heartbeat/route";
import { isBearerAuthorizationValid } from "../lib/security/bearerAuth";

const ENV_KEYS = [
  "TIBO_WEBHOOK_SECRET",
  "CODEX_USAGE_MONITOR_SECRET",
  "CRON_SECRET",
] as const;

function saveEnvironment() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(path: string, method: "GET" | "POST" = "POST") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      authorization: "Bearer wrong-secret",
      "content-type": "application/json",
    },
    body: method === "POST" ? "{}" : undefined,
  });
}

test("Bearer authentication compares fixed-size digests in constant time", () => {
  assert.equal(isBearerAuthorizationValid("Bearer expected-secret", "expected-secret"), true);
  assert.equal(isBearerAuthorizationValid("bEaReR expected-secret", "expected-secret"), true);
  assert.equal(isBearerAuthorizationValid("Bearer wrong-secret", "expected-secret"), false);
  assert.equal(isBearerAuthorizationValid("Bearer shorter", "a much longer expected secret"), false);
  assert.equal(isBearerAuthorizationValid("Basic expected-secret", "expected-secret"), false);
  assert.equal(isBearerAuthorizationValid("Bearer", "expected-secret"), false);
  assert.equal(isBearerAuthorizationValid(null, "expected-secret"), false);
  assert.equal(isBearerAuthorizationValid("Bearer expected-secret", undefined), false);
});

test("unauthorized server endpoints reject before storage, Gemini, or expensive processing", async () => {
  const previous = saveEnvironment();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  process.env.TIBO_WEBHOOK_SECRET = "tibo-secret";
  process.env.CODEX_USAGE_MONITOR_SECRET = "usage-secret";
  process.env.CRON_SECRET = "cron-secret";
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 500 });
  };

  try {
    assert.equal((await postTibo(request("/api/webhook/tibo"))).status, 401);
    assert.equal((await postTiboHeartbeat(request("/api/webhook/tibo/heartbeat"))).status, 401);
    assert.equal((await postCodexUsage(request("/api/webhook/codex-usage"))).status, 401);
    assert.equal((await postLogProbability(request("/api/log-probability"))).status, 401);
    assert.equal((await getMonitorHealth(request("/api/monitor/health", "GET"))).status, 401);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});
