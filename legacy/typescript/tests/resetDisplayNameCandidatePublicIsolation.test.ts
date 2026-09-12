import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  createReconcileResetDisplayNamesHandler,
} from "../lib/radar/resetDisplayNameReconciliationRoute";
import type { ResetDisplayNameReconciliationResult } from "../lib/radar/resetDisplayNameReconciliation";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

const candidateFixture = {
  candidateId: "candidate-private-id",
  sourceText: "private candidate source text",
  generatedName: "candidate generated name",
};

function restoreCronSecret() {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
}

function publicSnapshotFromRadarFixture() {
  return toPublicRadarSnapshot(
    getLocalRadarData({
      checkedAt: "2026-09-09T00:00:00.000Z",
      calculationNow: new Date("2026-09-09T00:00:00.000Z"),
    }),
    "ja",
    { calculationNow: new Date("2026-09-09T00:00:00.000Z") },
  );
}

async function safeRouteResponseFromCandidateOnlyRun() {
  const result: ResetDisplayNameReconciliationResult = {
    scanned: 1,
    candidates: 1,
    attempted: 0,
    geminiRequests: 0,
    writes: 0,
    invalidated: false,
    outcomes: [{
      eventKey: candidateFixture.candidateId,
      sourceTweetId: candidateFixture.sourceText,
      sourceReady: true,
      attempted: false,
      status: "candidate_pending",
      displayName: candidateFixture.generatedName,
    }],
    candidateSeeds: 1,
    candidateGeminiRequests: 0,
    candidatePromotions: 0,
  };
  const handler = createReconcileResetDisplayNamesHandler(
    async () => result,
    async () => {
      throw new Error("candidate-only reconciliation must not invalidate radar data");
    },
  );
  return handler(new NextRequest(
    "https://example.test/api/internal/reconcile-reset-display-names",
    {
      method: "POST",
      headers: {
        authorization: "Bearer expected-secret",
      },
    },
  ));
}

test("candidate-only state is absent from the real public snapshot and safe route response", async () => {
  const snapshot = publicSnapshotFromRadarFixture();
  const serializedSnapshot = JSON.stringify(snapshot);
  assert.equal(serializedSnapshot.includes(candidateFixture.candidateId), false);
  assert.equal(serializedSnapshot.includes(candidateFixture.sourceText), false);
  assert.equal(serializedSnapshot.includes(candidateFixture.generatedName), false);

  process.env.CRON_SECRET = "expected-secret";
  try {
    const response = await safeRouteResponseFromCandidateOnlyRun();
    const body = await response.json();
    const serializedBody = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.invalidated, false);
    assert.equal(serializedBody.includes(candidateFixture.candidateId), false);
    assert.equal(serializedBody.includes(candidateFixture.sourceText), false);
    assert.equal(serializedBody.includes(candidateFixture.generatedName), false);
  } finally {
    restoreCronSecret();
  }
});
