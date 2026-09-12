import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  createReconcileResetDisplayNamesHandler,
  getResetDisplayNameReconciliationOptions,
  RESET_DISPLAY_NAME_RECONCILER_ADOPTION_AT,
  toSafeResetDisplayNameReconciliationResponse,
} from "../lib/radar/resetDisplayNameReconciliationRoute";
import type {
  ResetDisplayNameReconciliationOptions,
  ResetDisplayNameReconciliationResult,
} from "../lib/radar/resetDisplayNameReconciliation";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function restoreCronSecret() {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
}

function makeRequest(authorization?: string) {
  return new NextRequest("https://example.test/api/internal/reconcile-reset-display-names", {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
  });
}

function result(overrides: Partial<ResetDisplayNameReconciliationResult> = {}): ResetDisplayNameReconciliationResult {
  return {
    scanned: 4,
    candidates: 2,
    attempted: 1,
    geminiRequests: 1,
    writes: 1,
    invalidated: true,
    outcomes: [
      {
        eventKey: "secret-event-key",
        sourceTweetId: "secret-source-tweet-id",
        sourceReady: true,
        attempted: true,
        status: "accepted",
        displayName: "secret generated display name",
      },
    ],
    ...overrides,
  };
}

test("internal reconciliation route rejects unauthorized requests without running the reconciler", async () => {
  process.env.CRON_SECRET = "expected-secret";
  let calls = 0;
  const handler = createReconcileResetDisplayNamesHandler(async () => {
    calls += 1;
    return result();
  });

  try {
    const response = await handler(makeRequest("Bearer wrong-secret"));
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  } finally {
    restoreCronSecret();
  }
});

test("authorized route runs one bounded reconciliation and returns only safe aggregate data", async () => {
  process.env.CRON_SECRET = "expected-secret";
  let calls = 0;
  const received = { options: null as ResetDisplayNameReconciliationOptions | null };
  const invalidated: string[] = [];
  const handler = createReconcileResetDisplayNamesHandler(async (options) => {
    calls += 1;
    received.options = options;
    await options.invalidateRadarData?.();
    return result();
  }, async () => {
    invalidated.push("radar-data");
  });

  try {
    const response = await handler(makeRequest("Bearer expected-secret"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.ok(received.options);
    assert.equal(received.options.dryRun, false);
    assert.equal(received.options.maxGeminiRequests, 3);
    assert.equal(received.options.adoptionAt?.toISOString(), RESET_DISPLAY_NAME_RECONCILER_ADOPTION_AT);
    assert.deepEqual(invalidated, ["radar-data"]);
    assert.deepEqual(body, {
      status: "completed",
      scanned: 4,
      candidates: 2,
      attempted: 1,
      geminiRequests: 1,
      writes: 1,
      invalidated: true,
      statusSummary: { accepted: 1 },
    });
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    restoreCronSecret();
  }
});

test("authorized zero-write result does not trigger route-side invalidation", async () => {
  process.env.CRON_SECRET = "expected-secret";
  let invalidations = 0;
  const handler = createReconcileResetDisplayNamesHandler(
    async () => result({ writes: 0, invalidated: false }),
    async () => {
      invalidations += 1;
    },
  );

  try {
    const response = await handler(makeRequest("Bearer expected-secret"));
    assert.equal(response.status, 200);
    assert.equal(invalidations, 0);
    assert.equal((await response.json()).invalidated, false);
  } finally {
    restoreCronSecret();
  }
});

test("missing CRON_SECRET is a configuration failure and does not run the reconciler", async () => {
  delete process.env.CRON_SECRET;
  let calls = 0;
  const handler = createReconcileResetDisplayNamesHandler(async () => {
    calls += 1;
    return result();
  });

  const response = await handler(makeRequest("Bearer expected-secret"));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), {
    error: "configuration_unavailable",
  });
  restoreCronSecret();
});

test("safe response summarizes outcomes without exposing event or source details", () => {
  assert.deepEqual(toSafeResetDisplayNameReconciliationResponse(result({
    writes: 0,
    invalidated: false,
    outcomes: [
      {
        eventKey: "private-event",
        sourceTweetId: "private-source",
        sourceReady: false,
        attempted: false,
        status: "source_unavailable",
        displayName: null,
      },
      {
        eventKey: "private-event-2",
        sourceTweetId: null,
        sourceReady: true,
        attempted: false,
        status: "manual",
        displayName: "private-name",
      },
    ],
  })), {
    status: "completed",
    scanned: 4,
    candidates: 2,
    attempted: 1,
    geminiRequests: 1,
    writes: 0,
    invalidated: false,
    statusSummary: {
      manual: 1,
      source_unavailable: 1,
    },
  });
});

test("route fixes reconciliation options to dry-run false and three Gemini requests", () => {
  const invalidator = () => undefined;
  const options = getResetDisplayNameReconciliationOptions(invalidator);
  assert.equal(options.dryRun, false);
  assert.equal(options.maxGeminiRequests, 3);
  assert.equal(options.adoptionAt?.toISOString(), RESET_DISPLAY_NAME_RECONCILER_ADOPTION_AT);
  assert.equal(options.invalidateRadarData, invalidator);
});

test("workflow calls the production route with CRON_SECRET only and no local install", () => {
  const workflowPath = path.join(process.cwd(), ".github", "workflows", "reconcile-reset-display-names.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /cron:\s*["']?\*\/10 \* \* \* \*["']?/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group:\s*reset-display-name-reconciliation/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /secrets\.CRON_SECRET/);
  assert.match(workflow, /--request POST/);
  assert.match(workflow, /api\/internal\/reconcile-reset-display-names/);
  assert.doesNotMatch(workflow, /actions\/checkout|setup-node|pnpm install|SUPABASE_SERVICE_ROLE_KEY|GEMINI_API_KEY/);
  assert.match(workflow, /statusSummary/);
  assert.match(workflow, /geminiRequests/);
});
