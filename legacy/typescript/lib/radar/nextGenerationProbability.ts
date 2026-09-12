import {
  NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
  NEXT_GENERATION_B_FROZEN_CONTINUOUS_CONFIG,
  NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_B_RAW_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_FREEZE_POLICY,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  NEXT_GENERATION_V3_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import type { RadarData } from "./types";
import {
  applyOddsMultiplier,
  applyStrongTimedTeaserProbabilityFloor,
  derive12hFrom24hProbability,
  derive72hFrom48hProbability,
  getStrongTimedTeaserProbabilityFloor,
  TEASER_TIMING_POLICY_VERSION,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
} from "./shadowProbability";
import {
  calculatePrequentialLogitCalibration,
  type PrequentialCalibrationRow,
} from "./prequentialCalibration";
import {
  applyOfficialNoticeTimingPolicy,
  calculateRegimeElapsedProbability,
} from "./regimeElapsedProbability";
import {
  calculateRandomContinuousProbability,
  type RandomContinuousRegimeMultiplierPolicy,
  type RandomContinuousProbabilityResult,
} from "./randomContinuousProbability";
import { getActiveOfficialNotice } from "./probability";

export {
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  NEXT_GENERATION_V3_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_FREEZE_POLICY,
} from "@/data/shadowProbabilityConfig";

export type NextGenerationCalibrationRow = {
  generatedAt: string;
  modelVersion: string;
  rawProbability24h: number;
  rawProbability48h: number;
  actual24h?: boolean;
  actual48h?: boolean;
};

export type NextGenerationTrainingReadStatus = "ok" | "error";

export type NextGenerationPublicCalibrationPolicy = "apply" | "diagnostic-only";

export type NextGenerationCalibrationPolicy = {
  probability24h: NextGenerationPublicCalibrationPolicy;
  probability48h: NextGenerationPublicCalibrationPolicy;
};

type NextGenerationPublicCalibrationPolicySummary =
  | NextGenerationPublicCalibrationPolicy
  | "mixed";

export type NextGenerationBResult = {
  modelVersion:
    | typeof NEXT_GENERATION_B_MODEL_VERSION
    | typeof NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION
    | typeof NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION
    | typeof NEXT_GENERATION_V3_MODEL_VERSION;
  rawModelVersion: typeof NEXT_GENERATION_B_RAW_MODEL_VERSION;
  calculatedAt: string;
  targetDefinition: string;
  rawProbability24h: number;
  rawProbability48h: number;
  predictions: ShadowProbabilityHorizons;
  alpha24h: number;
  alpha48h: number;
  calibrationSampleCount24h: number;
  calibrationSampleCount48h: number;
  positiveCalibrationCount24h: number;
  positiveCalibrationCount48h: number;
  calibrationTrainingModelVersion: typeof NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION;
  regimeMultiplierPolicyVersion?: string;
  lastResolvedOrigin24h: string | null;
  lastResolvedOrigin48h: string | null;
  horizonCoherenceAdjusted: boolean;
  trainingReadStatus: NextGenerationTrainingReadStatus;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  officialNoticeOverride: {
    active: boolean;
    probability12h: number | null;
    probability24h: number | null;
    probability48h: number | null;
    probability72h: number | null;
  };
  officialNoticeTimingPolicyVersion: string;
  teaserTimingPolicyVersion: typeof TEASER_TIMING_POLICY_VERSION;
  randomContinuous: RandomContinuousProbabilityResult["randomContinuous"];
  randomContinuousResult: RandomContinuousProbabilityResult;
  freezeAt: typeof NEXT_GENERATION_FREEZE_AT;
  freezePolicy: typeof NEXT_GENERATION_FREEZE_POLICY;
  publicCalibrationPolicy: NextGenerationPublicCalibrationPolicySummary;
  calibrationPolicy: NextGenerationCalibrationPolicy;
};

export type NextGenerationBPostResetAgeCandidateResult = Omit<
  NextGenerationBResult,
  "modelVersion"
> & {
  modelVersion: typeof NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION;
  regimeMultiplierPolicyVersion: typeof NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION;
};

export type NextGenerationV3Result = Omit<NextGenerationBResult, "modelVersion"> & {
  modelVersion: typeof NEXT_GENERATION_V3_MODEL_VERSION;
  publicCalibrationPolicy: "diagnostic-only";
  calibrationPolicy: {
    probability24h: "diagnostic-only";
    probability48h: "diagnostic-only";
  };
};

export type NextGenerationSelectiveCalibrationV3Result = Omit<NextGenerationBResult, "modelVersion"> & {
  modelVersion: typeof NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION;
  publicCalibrationPolicy: "mixed";
  calibrationPolicy: {
    probability24h: "diagnostic-only";
    probability48h: "apply";
  };
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getJstDayKey(value: string) {
  const parsed = timestamp(value);
  if (parsed === null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(parsed));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isFiniteProbability(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function getRawSignalAdjustedHorizons(result: RandomContinuousProbabilityResult) {
  return {
    probability12h: applyOddsMultiplier(
      result.baseline.probability12h,
      result.multipliers.combinedAfterCap.probability24h,
    ),
    probability24h: applyOddsMultiplier(
      result.baseline.probability24h,
      result.multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      result.baseline.probability48h,
      result.multipliers.combinedAfterCap.probability48h,
    ),
    probability72h: applyOddsMultiplier(
      result.baseline.probability72h,
      result.multipliers.combinedAfterCap.probability48h,
    ),
  } satisfies ShadowProbabilityHorizons;
}

export function enforceNextGenerationHorizonCoherence(
  probability24h: number,
  probability48h: number,
) {
  const safe24h = isFiniteProbability(probability24h) ? probability24h : 0;
  const safe48h = isFiniteProbability(probability48h) ? probability48h : 0;
  if (safe48h < safe24h) {
    return { probability24h: safe24h, probability48h: safe24h, adjusted: true };
  }
  return { probability24h: safe24h, probability48h: safe48h, adjusted: false };
}

export function selectNextGenerationCalibrationRows(
  rows: Array<NextGenerationCalibrationRow>,
  asOf: Date,
  horizonHours: 24 | 48 = 48,
) {
  const freezeTime = timestamp(NEXT_GENERATION_FREEZE_AT)!;
  const asOfTime = asOf.getTime();
  const sorted = rows
    .filter((row) => {
      const generatedAt = timestamp(row.generatedAt);
      const actual = horizonHours === 24 ? row.actual24h : row.actual48h;
      return row.modelVersion === NEXT_GENERATION_B_MODEL_VERSION
        && generatedAt !== null
        && generatedAt >= freezeTime
        && generatedAt < asOfTime
        && generatedAt + horizonHours * 60 * 60 * 1000 <= asOfTime
        && typeof actual === "boolean"
        && isFiniteProbability(row.rawProbability24h)
        && isFiniteProbability(row.rawProbability48h);
    })
    .slice()
    .sort((left, right) => timestamp(left.generatedAt)! - timestamp(right.generatedAt)!);
  const selected = new Map<string, NextGenerationCalibrationRow>();
  for (const row of sorted) {
    const dayKey = getJstDayKey(row.generatedAt);
    if (dayKey && !selected.has(dayKey)) selected.set(dayKey, row);
  }
  return Array.from(selected.values());
}

function toCalibrationRows(rows: Array<NextGenerationCalibrationRow>, horizonHours: 24 | 48) {
  return rows.flatMap((row): Array<PrequentialCalibrationRow> => {
    const actual = horizonHours === 24 ? row.actual24h : row.actual48h;
    if (typeof actual !== "boolean") return [];
    return [{
      recordedAt: row.generatedAt,
      probability24h: row.rawProbability24h,
      probability48h: row.rawProbability48h,
      actual24h: horizonHours === 24 ? actual : false,
      actual48h: horizonHours === 48 ? actual : false,
    }];
  });
}

export type NextGenerationBCalculationOptions = ShadowProbabilityOptions & {
  trainingRows?: Array<NextGenerationCalibrationRow>;
  trainingReadStatus?: NextGenerationTrainingReadStatus;
};

function calculateNextGenerationBProbabilityVariant<TModelVersion extends string>(
  data: RadarData | null,
  options: NextGenerationBCalculationOptions = {},
  variant: {
    modelVersion: TModelVersion;
    regimeMultiplierPolicy?: RandomContinuousRegimeMultiplierPolicy;
    regimeMultiplierPolicyVersion?: string;
    publicCalibrationPolicy?: NextGenerationPublicCalibrationPolicy;
    calibrationPolicy?: NextGenerationCalibrationPolicy;
  },
): Omit<NextGenerationBResult, "modelVersion"> & {
  modelVersion: TModelVersion;
  regimeMultiplierPolicyVersion?: string;
} {
  const now = options.now ?? new Date();
  const trainingReadStatus = options.trainingReadStatus ?? "ok";
  const regimeResult = calculateRegimeElapsedProbability(
    data,
    options,
    {
      ...NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
      modelVersion: "hazard-regime-elapsed-v1",
      mode: "full",
      signalMultiplierConfig: NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG,
    },
  );
  const randomContinuousResult = calculateRandomContinuousProbability(
    data,
    options,
    regimeResult,
    {
      ...NEXT_GENERATION_B_FROZEN_CONTINUOUS_CONFIG,
      regimeMultiplierPolicy: variant.regimeMultiplierPolicy,
    },
  );
  const rawHorizons = getRawSignalAdjustedHorizons(randomContinuousResult);
  const selectedRows24h = selectNextGenerationCalibrationRows(options.trainingRows ?? [], now, 24);
  const selectedRows48h = selectNextGenerationCalibrationRows(options.trainingRows ?? [], now, 48);
  const currentCalibrationRow: PrequentialCalibrationRow = {
    recordedAt: now.toISOString(),
    probability24h: rawHorizons.probability24h,
    probability48h: rawHorizons.probability48h,
    actual24h: false,
    actual48h: false,
  };
  const calibration24h = calculatePrequentialLogitCalibration(
    currentCalibrationRow,
    toCalibrationRows(selectedRows24h, 24),
  );
  const calibration48h = calculatePrequentialLogitCalibration(
    currentCalibrationRow,
    toCalibrationRows(selectedRows48h, 48),
  );
  const calibrated = enforceNextGenerationHorizonCoherence(
    calibration24h.calibratedProbability24h,
    calibration48h.calibratedProbability48h,
  );
  const latestRecoveryResetAt = randomContinuousResult.randomContinuous.latestRecoveryResetAt;
  const notice = options.activeOfficialNotice === undefined
    ? getActiveOfficialNotice(
        data,
        latestRecoveryResetAt ? new Date(latestRecoveryResetAt) : null,
        now,
        options.localObservationSignals,
        null,
        false,
        false,
        options.canonicalHistoryContext,
      )
    : options.activeOfficialNotice;
  const calibratedHorizons: ShadowProbabilityHorizons = {
    probability12h: derive12hFrom24hProbability(calibrated.probability24h),
    probability24h: calibrated.probability24h,
    probability48h: calibrated.probability48h,
    probability72h: derive72hFrom48hProbability(calibrated.probability48h),
  };
  const calibrationPolicy = variant.calibrationPolicy ?? {
    probability24h: variant.publicCalibrationPolicy ?? "apply",
    probability48h: variant.publicCalibrationPolicy ?? "apply",
  };
  const calibrationCoherenceAdjusted = calibrationPolicy.probability24h === "apply"
    && calibrationPolicy.probability48h === "apply"
    && calibrated.adjusted;
  const publicCalibrationPolicy = calibrationPolicy.probability24h === calibrationPolicy.probability48h
    ? calibrationPolicy.probability24h
    : "mixed";
  const publicProbability24h = calibrationPolicy.probability24h === "diagnostic-only"
    ? rawHorizons.probability24h
    : calibratedHorizons.probability24h;
  const publicProbability48h = calibrationPolicy.probability48h === "diagnostic-only"
    ? rawHorizons.probability48h
    : calibratedHorizons.probability48h;
  const publicBaseHorizons: ShadowProbabilityHorizons = {
    probability12h: derive12hFrom24hProbability(publicProbability24h),
    probability24h: publicProbability24h,
    probability48h: publicProbability48h,
    probability72h: derive72hFrom48hProbability(publicProbability48h),
  };
  const noticeHorizons = applyOfficialNoticeTimingPolicy(publicBaseHorizons, notice, now);
  const strongTimedTeaserFloor = noticeHorizons
    ? null
    : getStrongTimedTeaserProbabilityFloor(
      data,
      now,
      timestamp(latestRecoveryResetAt),
      undefined,
      options.canonicalHistoryContext,
    );
  const policyHorizons = applyStrongTimedTeaserProbabilityFloor(
    noticeHorizons ?? publicBaseHorizons,
    strongTimedTeaserFloor,
  );
  const finalPair = enforceNextGenerationHorizonCoherence(
    policyHorizons.probability24h,
    policyHorizons.probability48h,
  );
  const finalHorizons: ShadowProbabilityHorizons = {
    probability12h: policyHorizons.probability12h,
    probability24h: finalPair.probability24h,
    probability48h: finalPair.probability48h,
    probability72h: Math.max(
      finalPair.probability48h,
      policyHorizons.probability72h,
    ),
  };
  const fallbackUsed = trainingReadStatus === "error";
  const result: Omit<NextGenerationBResult, "modelVersion"> & {
    modelVersion: TModelVersion;
    regimeMultiplierPolicyVersion?: string;
  } = {
    modelVersion: variant.modelVersion,
    rawModelVersion: NEXT_GENERATION_B_RAW_MODEL_VERSION,
    calculatedAt: now.toISOString(),
    targetDefinition: randomContinuousResult.targetDefinition,
    rawProbability24h: rawHorizons.probability24h,
    rawProbability48h: rawHorizons.probability48h,
    predictions: finalHorizons,
    alpha24h: fallbackUsed ? 0 : calibration24h.alpha24h,
    alpha48h: fallbackUsed ? 0 : calibration48h.alpha48h,
    calibrationSampleCount24h: fallbackUsed ? 0 : calibration24h.calibrationSampleCount24h,
    calibrationSampleCount48h: fallbackUsed ? 0 : calibration48h.calibrationSampleCount48h,
    positiveCalibrationCount24h: fallbackUsed ? 0 : calibration24h.positiveCalibrationCount24h,
    positiveCalibrationCount48h: fallbackUsed ? 0 : calibration48h.positiveCalibrationCount48h,
    calibrationTrainingModelVersion:
      NEXT_GENERATION_B_POST_RESET_AGE_CALIBRATION_TRAINING_MODEL_VERSION,
    lastResolvedOrigin24h: fallbackUsed ? null : calibration24h.lastResolvedOrigin24h,
    lastResolvedOrigin48h: fallbackUsed ? null : calibration48h.lastResolvedOrigin48h,
    horizonCoherenceAdjusted: calibrationCoherenceAdjusted || finalPair.adjusted,
    trainingReadStatus,
    fallbackUsed,
    fallbackReason: fallbackUsed ? "prediction_history_training_query_failed" : null,
    officialNoticeOverride: {
      active: noticeHorizons !== null,
      probability12h: noticeHorizons?.probability12h ?? null,
      probability24h: noticeHorizons?.probability24h ?? null,
      probability48h: noticeHorizons?.probability48h ?? null,
      probability72h: noticeHorizons?.probability72h ?? null,
    },
    officialNoticeTimingPolicyVersion: "official-notice-window-v3",
    teaserTimingPolicyVersion: TEASER_TIMING_POLICY_VERSION,
    randomContinuous: randomContinuousResult.randomContinuous,
    randomContinuousResult,
    freezeAt: NEXT_GENERATION_FREEZE_AT,
    freezePolicy: NEXT_GENERATION_FREEZE_POLICY,
    publicCalibrationPolicy,
    calibrationPolicy,
  };
  if (variant.regimeMultiplierPolicyVersion) {
    result.regimeMultiplierPolicyVersion = variant.regimeMultiplierPolicyVersion;
  }
  return result;
}

export function calculateNextGenerationBProbability(
  data: RadarData | null,
  options: NextGenerationBCalculationOptions = {},
): NextGenerationBResult {
  return calculateNextGenerationBProbabilityVariant(data, options, {
    modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
  });
}

export function calculateNextGenerationBPostResetAgeCandidate(
  data: RadarData | null,
  options: NextGenerationBCalculationOptions = {},
): NextGenerationBPostResetAgeCandidateResult {
  return calculateNextGenerationBProbabilityVariant(data, options, {
    modelVersion: NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
    regimeMultiplierPolicy: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    regimeMultiplierPolicyVersion: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  }) as NextGenerationBPostResetAgeCandidateResult;
}

export function calculateNextGenerationV3Probability(
  data: RadarData | null,
  options: NextGenerationBCalculationOptions = {},
): NextGenerationV3Result {
  return calculateNextGenerationBProbabilityVariant(data, options, {
    modelVersion: NEXT_GENERATION_V3_MODEL_VERSION,
    regimeMultiplierPolicy: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    regimeMultiplierPolicyVersion: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    calibrationPolicy: {
      probability24h: "diagnostic-only",
      probability48h: "diagnostic-only",
    },
  }) as NextGenerationV3Result;
}

export function calculateNextGenerationSelectiveCalibrationProbability(
  data: RadarData | null,
  options: NextGenerationBCalculationOptions = {},
): NextGenerationSelectiveCalibrationV3Result {
  return calculateNextGenerationBProbabilityVariant(data, options, {
    modelVersion: NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
    regimeMultiplierPolicy: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    regimeMultiplierPolicyVersion: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    calibrationPolicy: {
      probability24h: "diagnostic-only",
      probability48h: "apply",
    },
  }) as NextGenerationSelectiveCalibrationV3Result;
}
