import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import { buildProbabilityDebugInfo } from "../lib/logProbability";
import { calculatePublishedProbability } from "../lib/radar/publishedProbability";

const RELEASE_START = "2026-09-03T19:37:54.000Z";
const HOUR_MS = 60 * 60 * 1000;

function atReleaseAge(hours: number, offsetMs = 0) {
  return new Date(new Date(RELEASE_START).getTime() + hours * HOUR_MS + offsetMs);
}

function calculateAt(now: Date, options: Parameters<typeof calculatePublishedProbability>[1] = {}) {
  const data = getLocalRadarData({ calculationNow: now, checkedAt: now.toISOString() });
  return calculatePublishedProbability(data, { ...options, now }, { logFallback: false });
}

type MajorModelReleaseAdjustment = {
  active: boolean;
  releaseId: string | null;
  displayName: string | null;
  releaseStartAt: string | null;
  phase: "strong" | "medium" | "weak" | null;
  floor24h: number | null;
  floor48h: number | null;
  baseProbability24h: number | null;
  baseProbability48h: number | null;
  applied24h: number | null;
  applied48h: number | null;
};

function getAdjustment(result: ReturnType<typeof calculatePublishedProbability>) {
  return (result as ReturnType<typeof calculatePublishedProbability> & {
    majorModelReleaseAdjustment?: MajorModelReleaseAdjustment;
  }).majorModelReleaseAdjustment;
}

test("release regime is inactive at every release age", () => {
  const before = calculateAt(atReleaseAge(0, -1));
  const strong = calculateAt(atReleaseAge(0));
  const medium = calculateAt(atReleaseAge(72));
  const weak = calculateAt(atReleaseAge(168));
  const ended = calculateAt(atReleaseAge(240));

  assert.equal(getAdjustment(before)?.active, false);
  assert.equal(getAdjustment(strong)?.active, false);
  assert.equal(getAdjustment(medium)?.active, false);
  assert.equal(getAdjustment(weak)?.active, false);
  assert.equal(getAdjustment(ended)?.active, false);
});

test("release floor does not replace the selected model result", () => {
  const now = atReleaseAge(12);
  const result = calculateAt(now);
  const adjustment = getAdjustment(result);

  assert.equal(adjustment?.active, false);
  assert.equal(adjustment?.applied24h, null);
  assert.equal(adjustment?.applied48h, null);
  assert.ok(result.probability24h < 0.52);
  assert.ok(result.probability48h < 0.75);
  assert.ok(result.probability12h <= result.probability24h);
  assert.ok(result.probability24h <= result.probability48h);
  assert.ok(result.probability48h <= result.probability72h);
});

test("official-notice probability remains unchanged without release adjustment", () => {
  const now = atReleaseAge(12);
  const result = calculateAt(now, {
    activeOfficialNotice: {
      origin: "local",
      id: "test-official-notice",
      title: "Reset notice",
      summary: "Reset notice",
      observedAt: now.toISOString(),
      expectedAt: null,
      expectedEndAt: null,
      expiresAt: null,
      source: null,
      sourceLabel: "test",
    },
  });

  assert.equal(result.nextGenerationB?.officialNoticeOverride.active, true);
  assert.equal(result.probability24h, 0.9);
  assert.equal(result.probability48h, 0.96);
  assert.equal(getAdjustment(result)?.active, false);
});

test("release context is inactive in audit debug info", () => {
  const now = atReleaseAge(36);
  const data = getLocalRadarData({
    calculationNow: now,
    checkedAt: now.toISOString(),
    formalTiboResets: [{
      tweet_id: "release-reset",
      text: "Reset completed",
      tweet_url: "https://x.com/thsottiaux/status/2000000000000000000",
      tweet_created_at: atReleaseAge(24).toISOString(),
      signal_type: "reset_executed",
      verification_status: "confirmed",
      confidence: 1,
    }],
  });
  const result = calculatePublishedProbability(data, { now }, { logFallback: false });
  const debugInfo = buildProbabilityDebugInfo(
    {},
    result.primary,
    now.toISOString(),
    now,
    result.rawShadow,
    result,
  );
  const published = debugInfo.publishedProbabilityModel as {
    majorModelReleaseAdjustment: MajorModelReleaseAdjustment;
  };

  assert.equal(getAdjustment(result)?.active, false);
  assert.deepEqual(published.majorModelReleaseAdjustment, getAdjustment(result));
});

test("release-specific explanation is not used", () => {
  const now = atReleaseAge(12);
  const data = getLocalRadarData({ calculationNow: now, checkedAt: now.toISOString() });

  const ja = getRadarViewModel(data, "ja", false, undefined, now);
  const en = getRadarViewModel(data, "en", false, undefined, now);
  const zh = getRadarViewModel(data, "zh", false, undefined, now);

  assert.notEqual(ja.displayReasoningSummary, "GPT-6 Astraのリリース直後のため、通常よりリセット確率を高めに予測しています。");
  assert.notEqual(en.displayReasoningSummary, "Because GPT-6 Astra was just released, we are forecasting a higher reset probability than usual.");
  assert.notEqual(zh.displayReasoningSummary, "由于 GPT-6 Astra 刚刚发布，我们预测重置概率将高于平时。");
});
