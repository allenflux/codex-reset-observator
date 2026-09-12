import {
  MAX_BASELINE_DAILY_PROBABILITY,
  MIN_BASELINE_DAILY_PROBABILITY,
} from "@/data/shadowProbabilityConfig";
import {
  applyOddsMultiplier,
  getConstantProbabilityBaseline,
  type ShadowHazard,
  type ShadowProbabilityPair,
  type ShadowProbabilityResult,
} from "./shadowProbability";
import {
  calculatePrequentialLogitCalibration,
  createPrequentialOrigins,
  getActualWithinHorizon,
  PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
  PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
  type PrequentialCalibrationAudit,
  type PrequentialCalibrationRow,
} from "./prequentialCalibration";

export {
  calculatePrequentialLogitCalibration,
  createPrequentialOrigins,
  getActualWithinHorizon,
  PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
  PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
};
export type { PrequentialCalibrationAudit, PrequentialCalibrationRow } from "./prequentialCalibration";

export type EvaluationProbabilityResult = {
  baseline: ShadowProbabilityPair;
  predictions: ShadowProbabilityPair;
};

function clampProbability(value: number) {
  return Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function timestamp(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Constant hazard baseline for the evaluation benchmark.
 * The start age is accepted for parity with the existing helper, but it does
 * not affect a constant hazard model.
 */
export function getConstantHazardBaseline(
  hazard: ShadowHazard,
  startAgeHours: number,
  horizonHours: number,
) {
  const rawDailyProbability = getConstantProbabilityBaseline(hazard, startAgeHours, 24);
  const dailyProbability = Math.min(
    MAX_BASELINE_DAILY_PROBABILITY,
    Math.max(MIN_BASELINE_DAILY_PROBABILITY, rawDailyProbability),
  );
  const lambdaPerHour = -Math.log1p(-dailyProbability) / 24;
  return clampProbability(1 - Math.exp(-lambdaPerHour * Math.max(0, horizonHours)));
}

/**
 * Evaluation-only constant-hazard comparison using the same multipliers and
 * notice override as the supplied v2 result.
 */
export function calculateConstantHazardBenchmark(
  shadow: ShadowProbabilityResult,
): EvaluationProbabilityResult {
  const baseline = {
    probability24h: getConstantHazardBaseline(shadow.hazard, 0, 24),
    probability48h: getConstantHazardBaseline(shadow.hazard, 0, 48),
  } satisfies ShadowProbabilityPair;
  const adjusted = {
    probability24h: applyOddsMultiplier(
      baseline.probability24h,
      shadow.multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      baseline.probability48h,
      shadow.multipliers.combinedAfterCap.probability48h,
    ),
  } satisfies ShadowProbabilityPair;

  return {
    baseline,
    predictions: shadow.officialNoticeOverride.active
      ? {
          probability24h: shadow.officialNoticeOverride.probability24h ?? 0.9,
          probability48h: shadow.officialNoticeOverride.probability48h ?? 0.96,
        }
      : adjusted,
  };
}
