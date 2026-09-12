import assert from "node:assert/strict";
import test from "node:test";

import {
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  NEXT_GENERATION_C_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import { getLocalRadarData } from "../lib/radar";
import {
  calculateNormalizedContextualBurstProbability,
  calculateContextualBurstProbability,
  selectContextualBurstCalibrationRows,
} from "../lib/radar/contextualBurstProbability";
import {
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
} from "../data/shadowProbabilityConfig";
import {
  buildRandomContinuousHazard,
  integrateRandomContinuousHazard,
} from "../lib/radar/randomContinuousProbability";
import { getRecoveryResetEvents } from "../lib/radar/recoveryBoundary";
import type { WindowEventLike } from "../lib/radar/types";

const HOUR_MS = 60 * 60 * 1000;

function resetEvent(id: string, completedAt: string): WindowEventLike {
  return {
    id,
    recordKind: "confirmed_global",
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    opened_at: completedAt,
    closed_at: completedAt,
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  };
}

function clusteredHistory() {
  let current = Date.parse("2026-01-01T16:00:00.000Z");
  const history: WindowEventLike[] = [resetEvent("random-0", new Date(current).toISOString())];
  const intervals = Array.from({ length: 8 }, () => [24, 24, 120]).flat();
  intervals.forEach((hours, index) => {
    current += hours * HOUR_MS;
    history.push(resetEvent(`random-${index + 1}`, new Date(current).toISOString()));
  });
  return { history, lastTime: current };
}

test("C base-only horizons are the frozen Gaussian random-clock baseline with multiplier one", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const history = [
    resetEvent("a", "2026-08-01T00:00:00.000Z"),
    resetEvent("b", "2026-08-03T00:00:00.000Z"),
  ];
  const data = getLocalRadarData({ calculationNow: now });
  const result = calculateContextualBurstProbability(data, {
    now,
    staticHistory: history,
    activeOfficialNotice: null,
    trainingRows: [],
  });
  const randomBoundaries = getRecoveryResetEvents(data, now, history).filter((item) => item.isRandom);
  const hazard = buildRandomContinuousHazard(
    randomBoundaries,
    now,
    NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  );
  const latest = Date.parse(randomBoundaries.at(-1)!.resetAt);
  const elapsed = (now.getTime() - latest) / HOUR_MS;

  assert.equal(
    result.ablations.baseOnly.probability24h,
    integrateRandomContinuousHazard(hazard, elapsed, 24, 1),
  );
  assert.equal(
    result.ablations.baseOnly.probability48h,
    integrateRandomContinuousHazard(hazard, elapsed, 48, 1),
  );
  assert.equal(result.contextFit.fallbackUsed, true);
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
});

test("C dynamically integrates context across future PT phase and rolling 72h history", () => {
  const synthetic = clusteredHistory();
  const now = new Date(synthetic.lastTime + 48 * HOUR_MS);
  const result = calculateContextualBurstProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: synthetic.history,
      activeOfficialNotice: null,
      trainingRows: [],
    },
  );

  assert.equal(result.contextFit.fallbackUsed, false);
  assert.ok(Number.isFinite(result.effectiveContextMultiplier24h));
  assert.ok(Number.isFinite(result.effectiveContextMultiplier48h));
  assert.notEqual(result.effectiveContextMultiplier24h, result.effectiveContextMultiplier48h);
  assert.ok(result.probability48h >= result.probability24h);
});

test("ordinary semantic signals affect fullRaw but not C context ablations", () => {
  const now = new Date("2026-08-22T08:00:00.000Z");
  const baseData = getLocalRadarData({ calculationNow: now });
  const signaledData = getLocalRadarData({
    calculationNow: now,
    recentTiboSignals: [{
      tweet_id: "c-strong-teaser",
      signal_type: "irrelevant",
      text: "I might reset later.",
      tweet_url: "https://x.com/thsottiaux/status/c-strong-teaser",
      tweet_created_at: now.toISOString(),
      verification_status: "auto_unverified",
      teaser_strength: "strong",
      is_reply: false,
    }],
  });
  const baseline = calculateContextualBurstProbability(baseData, {
    now,
    activeOfficialNotice: null,
    trainingRows: [],
  });
  const signaled = calculateContextualBurstProbability(signaledData, {
    now,
    activeOfficialNotice: null,
    trainingRows: [],
  });

  assert.deepEqual(signaled.ablations.baseOnly, baseline.ablations.baseOnly);
  assert.deepEqual(signaled.ablations.noBurst, baseline.ablations.noBurst);
  assert.deepEqual(signaled.ablations.noCircadian, baseline.ablations.noCircadian);
  assert.deepEqual(signaled.ablations.fullContext, baseline.ablations.fullContext);
  assert.ok(signaled.ablations.fullRaw.probability24h >= signaled.ablations.fullContext.probability24h);
  assert.ok(signaled.ablations.fullRaw.probability48h >= signaled.ablations.fullContext.probability48h);
});

test("official notice is applied after raw ablations and calibration", () => {
  const now = new Date("2026-08-22T08:00:00.000Z");
  const data = getLocalRadarData({ calculationNow: now });
  const notice = {
    origin: "local" as const,
    id: "c-notice",
    title: "notice",
    summary: "notice",
    observedAt: now.toISOString(),
    expectedAt: null,
    expectedEndAt: null,
    expiresAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
    source: null,
    sourceLabel: "test",
  };
  const withoutNotice = calculateContextualBurstProbability(data, {
    now,
    activeOfficialNotice: null,
    trainingRows: [],
  });
  const withNotice = calculateContextualBurstProbability(data, {
    now,
    activeOfficialNotice: notice,
    trainingRows: [],
  });

  assert.deepEqual(withNotice.ablations, withoutNotice.ablations);
  assert.equal(withNotice.officialNoticeOverride.active, true);
  assert.equal(withNotice.probability24h, 0.9);
  assert.equal(withNotice.probability48h, 0.96);
});

test("C calibration rows are C-freeze-bound, strict-horizon, and JST daily-first", () => {
  const rows = [
    {
      generatedAt: new Date(Date.parse(NEXT_GENERATION_C_FREEZE_AT) - 1).toISOString(),
      modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
      rawProbability24h: 0.1,
      rawProbability48h: 0.2,
      actual24h: true,
      actual48h: true,
    },
    {
      generatedAt: "2026-08-22T07:00:00.000Z",
      modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
      rawProbability24h: 0.2,
      rawProbability48h: 0.3,
      actual24h: true,
      actual48h: true,
    },
    {
      generatedAt: "2026-08-22T08:00:00.000Z",
      modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
      rawProbability24h: 0.3,
      rawProbability48h: 0.4,
      actual24h: false,
      actual48h: false,
    },
    {
      generatedAt: "2026-08-23T01:00:00.000Z",
      modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
      rawProbability24h: 0.4,
      rawProbability48h: 0.5,
      actual24h: true,
      actual48h: true,
    },
  ];
  const asOf = new Date("2026-08-24T12:00:00.000Z");

  assert.deepEqual(
    selectContextualBurstCalibrationRows(rows, asOf, 24).map((row) => row.generatedAt),
    ["2026-08-22T07:00:00.000Z", "2026-08-23T01:00:00.000Z"],
  );
  assert.deepEqual(
    selectContextualBurstCalibrationRows(rows, new Date("2026-08-24T02:00:00.000Z"), 48)
      .map((row) => row.generatedAt),
    [],
  );
});

test("training read failure keeps C available with zero calibration alpha", () => {
  const now = new Date("2026-08-22T08:00:00.000Z");
  const result = calculateContextualBurstProbability(getLocalRadarData({ calculationNow: now }), {
    now,
    activeOfficialNotice: null,
    trainingRows: [],
    trainingReadStatus: "error",
  });

  assert.equal(result.modelVersion, NEXT_GENERATION_C_MODEL_VERSION);
  assert.equal(result.trainingReadStatus, "error");
  assert.equal(result.calibrationFallbackUsed, true);
  assert.equal(result.alpha24h, 0);
  assert.equal(result.alpha48h, 0);
  assert.ok(result.probability48h >= result.probability24h);
});

test("normalized C v2 uses its own freeze-bound calibration and audit metadata", () => {
  const synthetic = clusteredHistory();
  const now = new Date(Date.parse(NEXT_GENERATION_C_V2_FREEZE_AT) + 60 * 60 * 1000);
  const result = calculateNormalizedContextualBurstProbability(
    getLocalRadarData({ calculationNow: now }),
    {
      now,
      staticHistory: synthetic.history,
      activeOfficialNotice: null,
      trainingRows: [],
    },
  );

  assert.equal(result.modelVersion, NEXT_GENERATION_C_V2_MODEL_VERSION);
  assert.equal(result.freezeAt, NEXT_GENERATION_C_V2_FREEZE_AT);
  assert.equal(typeof result.circadianNormalizationConstant, "number");
  assert.equal(typeof result.circadianCycleMeanBeforeNormalization, "number");
  assert.equal(typeof result.circadianCycleMeanAfterNormalization, "number");
  assert.ok(Math.abs((result.circadianCycleMeanAfterNormalization ?? 0) - 1) < 1e-8);
  assert.ok(result.probability48h >= result.probability24h);
  assert.ok(result.probability72h >= result.probability48h);
});
