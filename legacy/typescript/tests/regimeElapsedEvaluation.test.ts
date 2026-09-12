import assert from "node:assert/strict";
import test from "node:test";

import {
  createSixHourOrigins,
  getCensorAwareOutcome,
  selectNonOverlappingOrigins,
  selectPrequentialCandidate,
  type RegimeEvaluationRow,
} from "../scripts/evaluateRegimeElapsedProbability";
import { getLocalRadarData } from "../lib/radar";
import { getPointInTimeRadarData } from "../lib/radar/prequentialCalibration";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";
import type { RecoveryResetBoundary } from "../lib/radar/recoveryBoundary";
import type { ResetExecutionEstimate } from "../lib/radar/resetExecution";
import type { ShadowResetEvent } from "../lib/radar/shadowProbability";
import {
  createProductionPointInTimeRadarData,
  PRODUCTION_PARITY_ORIGIN,
} from "./fixtures/productionPointInTimeRadarData";
import { evaluateRegimeElapsedProbability } from "../scripts/evaluateRegimeElapsedProbability";

function event(id: string, resetAt: string): ShadowResetEvent {
  return { id, resetAt };
}

function row(recordedAt: string, probability24h: number, actual24h: boolean | null): RegimeEvaluationRow {
  return {
    recordedAt,
    probability24h,
    probability48h: probability24h,
    actual24h,
    actual48h: actual24h,
  };
}

test("six-hour origins are aligned and leave the requested horizon for labels", () => {
  const origins = createSixHourOrigins(
    Array.from({ length: 8 }, (_, index) => event(`e${index}`, `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)),
    "2026-06-15T00:00:00.000Z",
  );
  assert.ok(origins.length > 0);
  assert.equal(new Date(origins[0]).getUTCHours() % 6, 0);
  assert.equal(new Date(origins[1]).getTime() - new Date(origins[0]).getTime(), 6 * 60 * 60 * 1000);
  assert.ok(new Date(origins.at(-1)!).getTime() <= new Date("2026-06-13T00:00:00.000Z").getTime());
  assert.deepEqual(selectNonOverlappingOrigins(origins, 24).slice(0, 3), [origins[0], origins[4], origins[8]]);
});

test("regular recovery boundaries censor a no-event horizon but random boundaries score positive", () => {
  const regular: RecoveryResetBoundary = {
    id: "regular",
    resetAt: "2026-08-01T12:00:00.000Z",
    isRandom: false,
    isRegular: true,
    sourceIds: ["regular"],
  };
  const random: RecoveryResetBoundary = {
    id: "random",
    resetAt: "2026-08-01T18:00:00.000Z",
    isRandom: true,
    isRegular: false,
    sourceIds: ["random"],
  };
  assert.equal(getCensorAwareOutcome([regular], "2026-08-01T00:00:00.000Z", 24), null);
  assert.equal(getCensorAwareOutcome([regular, random], "2026-08-01T00:00:00.000Z", 24), true);
  assert.equal(getCensorAwareOutcome([], "2026-08-01T00:00:00.000Z", 24), false);
});

test("prequential candidate selection uses only rows already supplied", () => {
  const candidateA = [row("2026-08-01T00:00:00.000Z", 0.2, false)];
  const candidateB = [row("2026-08-01T00:00:00.000Z", 0.9, true)];
  const first = selectPrequentialCandidate([
    { key: "A", rows: [] },
    { key: "B", rows: [] },
  ], "A");
  const afterPastOrigin = selectPrequentialCandidate([
    { key: "A", rows: candidateA },
    { key: "B", rows: candidateB },
  ], "A");

  assert.equal(first, "A");
  assert.equal(afterPastOrigin, "B");
});

function formalResetSignal(
  tweetId: string,
  resetAt: string,
  detectedAt: string = resetAt,
) {
  return {
    tweet_id: tweetId,
    text: "All paid users received a reset.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: resetAt,
    detected_at: detectedAt,
    signal_type: "reset_executed" as const,
    confidence: 1,
    verification_status: "auto_unverified" as const,
    classification_source: "gemini" as const,
    is_reply: false,
  };
}

test("point-in-time projection excludes future dynamic records and strips future confirmation", () => {
  const origin = new Date("2026-08-13T06:20:00.000Z");
  const source = getLocalRadarData({
    activeTiboSignals: [
      {
        ...formalResetSignal("future-tibo", "2026-08-13T05:00:00.000Z", "2026-08-13T07:00:00.000Z"),
      },
    ],
    formalTiboResets: [
      formalResetSignal("known-tibo", "2026-08-13T03:00:00.000Z"),
    ],
    regularResetEvents: [
      {
        schedule_key: "future-regular",
        window_start_at: "2026-08-14T03:30:00.000Z",
        window_end_at: "2026-08-14T03:45:00.000Z",
        representative_at: "2026-08-14T03:32:00.000Z",
        scheduled_at: "2026-08-14T03:32:00.000Z",
        completed_at: "2026-08-14T03:32:00.000Z",
        cycle_type: "定期リセット",
        reset_method: "強制リセット",
        scope: "任意リセット未使用アカウント",
        record_kind: "regular_completed",
        status: "completed",
      },
      {
        schedule_key: "voided-after-origin",
        window_start_at: "2026-08-13T03:30:00.000Z",
        window_end_at: "2026-08-13T03:45:00.000Z",
        representative_at: "2026-08-13T03:32:00.000Z",
        scheduled_at: "2026-08-13T03:32:00.000Z",
        completed_at: "2026-08-13T03:32:00.000Z",
        cycle_type: "定期リセット",
        reset_method: "強制リセット",
        scope: "任意リセット未使用アカウント",
        record_kind: "regular_completed",
        status: "voided",
        corrected_at: "2026-08-13T07:00:00.000Z",
      },
    ],
    resetExecutionEstimates: [
      {
        resetEventKey: "created-after-origin",
        displayExecutionAt: "2026-08-13T05:00:00.000Z",
        executionTimeSource: "usage_observation",
        executionTimeConfidence: "high",
        executionTimePrecision: "approximate",
        recoveryObservationId: "observation-before-origin",
        executionWindowStartAt: "2026-08-13T04:00:00.000Z",
        executionWindowEndAt: "2026-08-13T05:00:00.000Z",
        recoveryPreviousObservedAt: "2026-08-13T04:00:00.000Z",
        recoveryObservedAt: "2026-08-13T05:00:00.000Z",
        tiboSourceTweetIds: ["known-tibo"],
        createdAt: "2026-08-13T06:21:00.000Z",
        updatedAt: "2026-08-13T06:21:00.000Z",
        estimatorVersion: "test",
      },
      {
        resetEventKey: "known-estimate",
        displayExecutionAt: "2026-08-13T05:00:00.000Z",
        executionTimeSource: "usage_observation",
        executionTimeConfidence: "high",
        executionTimePrecision: "approximate",
        recoveryObservationId: "observation-before-origin",
        executionWindowStartAt: "2026-08-13T04:00:00.000Z",
        executionWindowEndAt: "2026-08-13T05:00:00.000Z",
        recoveryPreviousObservedAt: "2026-08-13T04:00:00.000Z",
        recoveryObservedAt: "2026-08-13T05:00:00.000Z",
        tiboSourceTweetIds: ["known-tibo"],
        createdAt: "2026-08-13T05:30:00.000Z",
        updatedAt: "2026-08-13T05:30:00.000Z",
        estimatorVersion: "test",
      },
    ],
    codexRecoveryObservations: [
      {
        id: "observation-before-origin",
        sourceKey: "local-codex-app-server",
        observedAt: "2026-08-13T05:00:00.000Z",
        previousObservedAt: "2026-08-13T04:00:00.000Z",
        previousUsedPercent: 80,
        currentUsedPercent: 1,
        previousResetsAt: 1787190000,
        currentResetsAt: 1787193600,
        cycleHint: "unexpected",
        confidence: "strong",
        status: "confirmed",
        matchedTiboTweetId: "known-tibo",
        confirmedAt: "2026-08-13T07:00:00.000Z",
        createdAt: "2026-08-13T05:01:00.000Z",
        updatedAt: "2026-08-13T05:30:00.000Z",
      },
      {
        id: "observation-after-origin",
        sourceKey: "local-codex-app-server",
        observedAt: "2026-08-13T07:00:00.000Z",
        previousObservedAt: "2026-08-13T06:00:00.000Z",
        previousUsedPercent: 80,
        currentUsedPercent: 1,
        previousResetsAt: 1787190000,
        currentResetsAt: 1787193600,
        cycleHint: "unexpected",
        confidence: "strong",
        status: "observed",
        matchedTiboTweetId: null,
        confirmedAt: null,
        createdAt: "2026-08-13T07:01:00.000Z",
        updatedAt: "2026-08-13T07:01:00.000Z",
      },
    ],
  });

  const projected = getPointInTimeRadarData(source, origin);
  assert.ok(projected);
  assert.equal(projected.active_tibo_signals?.length, 0);
  assert.equal(projected.formal_tibo_resets?.length, 1);
  assert.equal(projected.regular_reset_events?.length, 0);
  assert.deepEqual(projected.reset_execution_estimates?.map((item) => item.resetEventKey), ["known-estimate"]);
  assert.equal(projected.codex_recovery_observations?.length, 1);
  assert.equal(projected.codex_recovery_observations?.[0].status, "observed");
  assert.equal(projected.codex_recovery_observations?.[0].confirmedAt, null);
  assert.equal(projected.codex_recovery_observations?.[0].matchedTiboTweetId, null);
  assert.equal(projected.codex_usage_recovery, undefined);

  const futureEstimateSource = {
    ...source,
    reset_execution_estimates: [
      ...(source.reset_execution_estimates ?? []),
      {
        resetEventKey: "future-estimate",
        displayExecutionAt: "2026-08-13T05:30:00.000Z",
        executionTimeSource: "usage_observation",
        executionTimeConfidence: "high",
        executionTimePrecision: "approximate",
        recoveryObservationId: "future-observation",
        executionWindowStartAt: "2026-08-13T05:00:00.000Z",
        executionWindowEndAt: "2026-08-13T05:30:00.000Z",
        recoveryPreviousObservedAt: "2026-08-13T05:00:00.000Z",
        recoveryObservedAt: "2026-08-13T05:30:00.000Z",
        tiboSourceTweetIds: ["future-tibo"],
        createdAt: "2026-08-13T06:21:00.000Z",
        updatedAt: "2026-08-13T06:21:00.000Z",
        estimatorVersion: "test",
      } satisfies ResetExecutionEstimate,
    ],
  };
  const baselineForecast = calculateRegimeElapsedProbability(projected, {
    now: origin,
    activeOfficialNotice: null,
  });
  const futureProjected = getPointInTimeRadarData(futureEstimateSource, origin);
  assert.ok(futureProjected);
  const futureForecast = calculateRegimeElapsedProbability(
    futureProjected,
    { now: origin, activeOfficialNotice: null },
  );
  assert.deepEqual(futureForecast.predictions, baselineForecast.predictions);
});

test("production point-in-time fixture preserves dynamic boundaries and separates cross-type events", () => {
  const report = evaluateRegimeElapsedProbability(
    createProductionPointInTimeRadarData(),
    PRODUCTION_PARITY_ORIGIN,
  );
  const full = report.evaluationReport.currentSnapshot.fullRegimeShadow;

  assert.equal(report.evaluationReport.inputMode, "production-point-in-time");
  assert.equal(report.evaluationReport.futureLeakagePolicyVersion, "availability-timestamps-v1");
  assert.equal(report.evaluationReport.backfilled, false);
  assert.equal(report.evaluationReport.eventCount, 26);
  assert.equal(report.evaluationReport.recoveryBoundaryCount, 31);
  assert.equal(report.evaluationReport.currentSnapshot.latestRandomResetAt, "2026-08-13T03:34:43.341Z");
  assert.equal(report.evaluationReport.currentSnapshot.latestRecoveryResetAt, "2026-08-13T03:34:43.341Z");
  assert.equal(full.regimeDiagnostics.rawRandomEventCount, 26);
  assert.ok(Math.abs(full.regimeDiagnostics.regimeMultiplier - 1.6281772625) < 1e-9);
  assert.ok(Math.abs(full.predictions.probability24h - 0.3287456050) < 1e-9);
  assert.ok(Math.abs(full.predictions.probability48h - 0.6584455811) < 1e-9);
  assert.equal(typeof report.evaluationReport.currentSnapshot.elapsedOnly.probability24h, "number");
});
