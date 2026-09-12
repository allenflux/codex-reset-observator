import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import * as logProbabilityRoute from "../app/api/log-probability/route";
import { POST as postLogProbability } from "../app/api/log-probability/route";

const root = process.cwd();

test("log probability is POST-only so GET cannot reach the write handler", () => {
  assert.equal("GET" in logProbabilityRoute, false);
  assert.equal(typeof logProbabilityRoute.POST, "function");
});

test("internal 500 responses do not include exception details", () => {
  const logProbabilityRoute = readFileSync(
    join(root, "app/api/log-probability/route.ts"),
    "utf8",
  );
  const heartbeatRoute = readFileSync(
    join(root, "app/api/webhook/tibo/heartbeat/route.ts"),
    "utf8",
  );

  assert.match(logProbabilityRoute, /\{ error: "Database save failed" \}/);
  assert.match(logProbabilityRoute, /\{ error: "Internal Server Error" \}/);
  assert.doesNotMatch(logProbabilityRoute, /details:\s*error\.message/);
  assert.doesNotMatch(logProbabilityRoute, /details:\s*err\?\.message/);
  assert.doesNotMatch(logProbabilityRoute, /NextResponse\.json\([^\n]*stack/);

  assert.match(heartbeatRoute, /\{ error: "Internal Error" \}/);
  assert.doesNotMatch(heartbeatRoute, /error:\s*err\.message/);
});

test("log probability reuses the published raw model for experimental forecasts", () => {
  const logProbabilityRoute = readFileSync(
    join(root, "app/api/log-probability/route.ts"),
    "utf8",
  );

  assert.match(
    logProbabilityRoute,
    /calibratedProbability:\s*publishedProbability\.calibrated,[\s\S]*?shadowProbability:\s*publishedProbability\.rawShadow \?\? publishedProbability\.shadow/,
  );
});

test("log probability unexpected errors use a generic runtime response", async () => {
  const previous = {
    CRON_SECRET: process.env.CRON_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const originalFetch = globalThis.fetch;

  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

  try {
    const response = await postLogProbability(
      new NextRequest("http://localhost/api/log-probability", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal Server Error" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key as keyof typeof previous] = value;
    }
  }
});
