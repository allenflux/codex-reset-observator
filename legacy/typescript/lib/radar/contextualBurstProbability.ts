import {
  NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_FREEZE_POLICY,
  NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  NEXT_GENERATION_C_FROZEN_SIGNAL_CONFIG,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_FREEZE_POLICY,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
} from "@/data/shadowProbabilityConfig";
import type { RadarData } from "./types";
import {
  applyOddsMultiplier,
  derive12hFrom24hProbability,
  derive72hFrom48hProbability,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
  type ShadowSignalMultipliers,
} from "./shadowProbability";
import {
  buildRandomContinuousHazard,
  getRandomContinuousHazardAtAge,
  type RandomContinuousHazard,
} from "./randomContinuousProbability";
import {
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "./recoveryBoundary";
import {
  calculateRegimeElapsedProbability,
  applyOfficialNoticeTimingPolicy,
} from "./regimeElapsedProbability";
import {
  calculatePrequentialLogitCalibration,
  type PrequentialCalibrationRow,
} from "./prequentialCalibration";
import {
  enforceNextGenerationHorizonCoherence,
} from "./nextGenerationProbability";
import { getActiveOfficialNotice } from "./probability";
import {
  fitContextualBurstContext,
  calculateCircadianNormalization,
  getContextualBurstMultiplier,
  getContextualBurstRawFeatures,
  type CircadianNormalization,
  type ContextualBurstFit,
  type ContextualBurstRawFeatures,
} from "./contextualBurstContext";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTEGRATION_STEP_HOURS = NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG.integrationStepMinutes / 60;

export type ContextualBurstCalibrationRow = {
  generatedAt: string;
  modelVersion: string;
  rawProbability24h: number;
  rawProbability48h: number;
  actual24h?: boolean;
  actual48h?: boolean;
};

export type ContextualBurstAblations = {
  baseOnly: { probability24h: number; probability48h: number };
  noBurst: { probability24h: number; probability48h: number };
  noCircadian: { probability24h: number; probability48h: number };
  fullContext: { probability24h: number; probability48h: number };
  fullRaw: { probability24h: number; probability48h: number };
};

export type ContextualBurstNormalizedAblations = {
  baseOnly: { probability24h: number; probability48h: number };
  burstOnly: { probability24h: number; probability48h: number };
  circadianNormalizedOnly: { probability24h: number; probability48h: number };
  fullNormalizedContext: { probability24h: number; probability48h: number };
};

export type ContextualBurstProbabilityResult = {
  modelVersion: typeof NEXT_GENERATION_C_MODEL_VERSION | typeof NEXT_GENERATION_C_V2_MODEL_VERSION;
  calculatedAt: string;
  targetDefinition: typeof RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION;
  probability12h: number;
  probability24h: number;
  probability48h: number;
  probability72h: number;
  rawProbability24h: number;
  rawProbability48h: number;
  baseProbability24h: number;
  baseProbability48h: number;
  randomElapsedHours: number;
  latestRandomResetAt: string | null;
  latestRecoveryResetAt: string | null;
  originFeatures: ContextualBurstRawFeatures;
  contextFit: ContextualBurstFit;
  effectiveContextMultiplier24h: number;
  effectiveContextMultiplier48h: number;
  baseInstantaneousHazardPerHour: number;
  multipliers: ShadowSignalMultipliers;
  alpha24h: number;
  alpha48h: number;
  calibrationSampleCount24h: number;
  calibrationSampleCount48h: number;
  positiveCalibrationCount24h: number;
  positiveCalibrationCount48h: number;
  lastResolvedOrigin24h: string | null;
  lastResolvedOrigin48h: string | null;
  horizonCoherenceAdjusted: boolean;
  trainingReadStatus: "ok" | "error";
  calibrationFallbackUsed: boolean;
  calibrationFallbackReason: string | null;
  officialNoticeOverride: {
    active: boolean;
    probability12h: number | null;
    probability24h: number | null;
    probability48h: number | null;
    probability72h: number | null;
  };
  officialNoticeTimingPolicyVersion: "official-notice-window-v3";
  ablations: ContextualBurstAblations;
  normalizedAblations?: ContextualBurstNormalizedAblations;
  circadianNormalizationConstant?: number | null;
  circadianCycleMeanBeforeNormalization?: number | null;
  circadianCycleMeanAfterNormalization?: number | null;
  circadianNormalizationFallbackReason?: string | null;
  freezeAt: typeof NEXT_GENERATION_C_FREEZE_AT | typeof NEXT_GENERATION_C_V2_FREEZE_AT;
  freezePolicy: typeof NEXT_GENERATION_C_FREEZE_POLICY | typeof NEXT_GENERATION_C_V2_FREEZE_POLICY;
};

type Variant = "baseOnly" | "full" | "noBurst" | "noCircadian";

type IntegrationResult = {
  probability: number;
  cumulativeHazard: number;
  baseCumulativeHazard: number;
  effectiveContextMultiplier: number;
};

type ContextualBurstCalculationConfig = {
  modelVersion: typeof NEXT_GENERATION_C_MODEL_VERSION | typeof NEXT_GENERATION_C_V2_MODEL_VERSION;
  freezeAt: typeof NEXT_GENERATION_C_FREEZE_AT | typeof NEXT_GENERATION_C_V2_FREEZE_AT;
  freezePolicy: typeof NEXT_GENERATION_C_FREEZE_POLICY | typeof NEXT_GENERATION_C_V2_FREEZE_POLICY;
  normalizeCircadian: boolean;
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isProbability(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function elapsedHoursFromLatest(boundaries: RecoveryResetBoundary[], now: Date) {
  const latest = boundaries.at(-1);
  const latestTime = timestamp(latest?.resetAt);
  return latestTime === null ? 0 : Math.max(0, (now.getTime() - latestTime) / HOUR_MS);
}

function integrateContextualHazard(
  hazard: RandomContinuousHazard,
  fit: ContextualBurstFit,
  randomResetTimes: Date[],
  now: Date,
  randomElapsedHours: number,
  horizonHours: number,
  variant: Variant,
  normalization?: CircadianNormalization,
): IntegrationResult {
  const startAgeHours = Math.max(0, randomElapsedHours);
  const endAgeHours = startAgeHours + Math.max(0, horizonHours);
  let cursor = startAgeHours;
  let cumulativeHazard = 0;
  let baseCumulativeHazard = 0;

  const adjustedLambda = (ageHours: number) => {
    const offsetHours = ageHours - startAgeHours;
    const absoluteTime = new Date(now.getTime() + offsetHours * HOUR_MS);
    const baseLambda = getRandomContinuousHazardAtAge(hazard, ageHours);
    if (variant === "baseOnly") return { baseLambda, adjustedLambda: baseLambda };
    const raw = getContextualBurstRawFeatures(randomResetTimes, absoluteTime);
    const ablation = variant === "noBurst"
      ? "noBurst"
      : variant === "noCircadian"
        ? "noCircadian"
        : "full";
    const multiplier = getContextualBurstMultiplier(raw, fit, ablation, normalization);
    return { baseLambda, adjustedLambda: baseLambda * multiplier };
  };

  let current = adjustedLambda(cursor);
  while (cursor < endAgeHours) {
    const stepEnd = Math.min(endAgeHours, cursor + DEFAULT_INTEGRATION_STEP_HOURS);
    if (!(stepEnd > cursor)) break;
    const next = adjustedLambda(stepEnd);
    const duration = stepEnd - cursor;
    cumulativeHazard += (current.adjustedLambda + next.adjustedLambda) / 2 * duration;
    baseCumulativeHazard += (current.baseLambda + next.baseLambda) / 2 * duration;
    cursor = stepEnd;
    current = next;
  }

  const safeCumulative = Math.max(0, cumulativeHazard);
  const probability = Math.min(1, Math.max(0, 1 - Math.exp(-safeCumulative)));
  const effectiveContextMultiplier = baseCumulativeHazard > 0
    ? cumulativeHazard / baseCumulativeHazard
    : 1;
  return {
    probability,
    cumulativeHazard: safeCumulative,
    baseCumulativeHazard: Math.max(0, baseCumulativeHazard),
    effectiveContextMultiplier: Number.isFinite(effectiveContextMultiplier)
      ? effectiveContextMultiplier
      : 1,
  };
}

function horizonsForVariant(
  hazard: RandomContinuousHazard,
  fit: ContextualBurstFit,
  randomResetTimes: Date[],
  now: Date,
  randomElapsedHours: number,
  variant: Variant,
  normalization?: CircadianNormalization,
) {
  const p12 = integrateContextualHazard(hazard, fit, randomResetTimes, now, randomElapsedHours, 12, variant, normalization);
  const p24 = integrateContextualHazard(hazard, fit, randomResetTimes, now, randomElapsedHours, 24, variant, normalization);
  const p48 = integrateContextualHazard(hazard, fit, randomResetTimes, now, randomElapsedHours, 48, variant, normalization);
  const p72 = integrateContextualHazard(hazard, fit, randomResetTimes, now, randomElapsedHours, 72, variant, normalization);
  return {
    horizons: {
      probability12h: p12.probability,
      probability24h: p24.probability,
      probability48h: p48.probability,
      probability72h: p72.probability,
    } satisfies ShadowProbabilityHorizons,
    effectiveContextMultiplier24h: p24.effectiveContextMultiplier,
    effectiveContextMultiplier48h: p48.effectiveContextMultiplier,
  };
}

function applySemanticSignals(
  horizons: ShadowProbabilityHorizons,
  multipliers: ShadowSignalMultipliers,
): ShadowProbabilityHorizons {
  return {
    probability12h: applyOddsMultiplier(
      horizons.probability12h,
      multipliers.combinedAfterCap.probability24h,
    ),
    probability24h: applyOddsMultiplier(
      horizons.probability24h,
      multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      horizons.probability48h,
      multipliers.combinedAfterCap.probability48h,
    ),
    probability72h: applyOddsMultiplier(
      horizons.probability72h,
      multipliers.combinedAfterCap.probability48h,
    ),
  };
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

function selectContextualBurstCalibrationRowsForModel(
  rows: ContextualBurstCalibrationRow[],
  asOf: Date,
  horizonHours: 24 | 48,
  modelVersion: ContextualBurstCalculationConfig["modelVersion"],
  freezeAt: ContextualBurstCalculationConfig["freezeAt"],
) {
  const asOfTime = asOf.getTime();
  const freezeTime = timestamp(freezeAt)!;
  const sorted = rows
    .filter((row) => {
      const generated = timestamp(row.generatedAt);
      const actual = horizonHours === 24 ? row.actual24h : row.actual48h;
      return row.modelVersion === modelVersion
        && generated !== null
        && generated >= freezeTime
        && generated < asOfTime
        && generated + horizonHours * HOUR_MS <= asOfTime
        && typeof actual === "boolean"
        && isProbability(row.rawProbability24h)
        && isProbability(row.rawProbability48h);
    })
    .slice()
    .sort((left, right) => timestamp(left.generatedAt)! - timestamp(right.generatedAt)!);
  const selected = new Map<string, ContextualBurstCalibrationRow>();
  for (const row of sorted) {
    const key = getJstDayKey(row.generatedAt);
    if (key && !selected.has(key)) selected.set(key, row);
  }
  return Array.from(selected.values());
}

export function selectContextualBurstCalibrationRows(
  rows: ContextualBurstCalibrationRow[],
  asOf: Date,
  horizonHours: 24 | 48,
) {
  return selectContextualBurstCalibrationRowsForModel(
    rows,
    asOf,
    horizonHours,
    NEXT_GENERATION_C_MODEL_VERSION,
    NEXT_GENERATION_C_FREEZE_AT,
  );
}

export function selectNormalizedContextualBurstCalibrationRows(
  rows: ContextualBurstCalibrationRow[],
  asOf: Date,
  horizonHours: 24 | 48,
) {
  return selectContextualBurstCalibrationRowsForModel(
    rows,
    asOf,
    horizonHours,
    NEXT_GENERATION_C_V2_MODEL_VERSION,
    NEXT_GENERATION_C_V2_FREEZE_AT,
  );
}

function toCalibrationRows(
  rows: ContextualBurstCalibrationRow[],
  horizonHours: 24 | 48,
): PrequentialCalibrationRow[] {
  return rows.flatMap((row) => {
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

function calculateContextualBurstProbabilityForModel(
  data: RadarData | null,
  config: ContextualBurstCalculationConfig,
  options: ShadowProbabilityOptions & {
    trainingRows?: ContextualBurstCalibrationRow[];
    trainingReadStatus?: "ok" | "error";
  } = {},
): ContextualBurstProbabilityResult {
  const now = options.now ?? new Date();
  const trainingReadStatus = options.trainingReadStatus ?? "ok";
  const allBoundaries = getRecoveryResetEvents(
    data,
    now,
    options.staticHistory,
    options.canonicalHistoryContext,
  );
  const randomBoundaries = allBoundaries.filter((boundary) => boundary.isRandom);
  const hazard = buildRandomContinuousHazard(
    randomBoundaries,
    now,
    NEXT_GENERATION_C_FROZEN_CONTINUOUS_CONFIG,
  );
  const randomElapsedHours = elapsedHoursFromLatest(randomBoundaries, now);
  const randomResetTimes = randomBoundaries.map((boundary) => new Date(boundary.resetAt));
  const fit = fitContextualBurstContext(randomBoundaries, now, hazard);
  const originFeatures = getContextualBurstRawFeatures(randomResetTimes, now);
  const normalization = config.normalizeCircadian
    ? calculateCircadianNormalization(fit.coefficients)
    : undefined;
  const base = horizonsForVariant(hazard, fit, randomResetTimes, now, randomElapsedHours, "baseOnly");
  const noBurst = horizonsForVariant(
    hazard,
    fit,
    randomResetTimes,
    now,
    randomElapsedHours,
    "noBurst",
    normalization,
  );
  const noCircadian = horizonsForVariant(
    hazard,
    fit,
    randomResetTimes,
    now,
    randomElapsedHours,
    "noCircadian",
  );
  const fullContext = horizonsForVariant(
    hazard,
    fit,
    randomResetTimes,
    now,
    randomElapsedHours,
    "full",
    normalization,
  );

  // Reuse B's version-frozen ordinary semantic signal policy, but explicitly
  // force elapsed-only mode so C never consumes B's 3-day regime multiplier.
  const signalResult = calculateRegimeElapsedProbability(data, options, {
    ...NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
    modelVersion: `${config.modelVersion}-signal-input`,
    mode: "elapsed-only",
    signalMultiplierConfig: NEXT_GENERATION_C_FROZEN_SIGNAL_CONFIG,
  });
  const rawHorizons = applySemanticSignals(fullContext.horizons, signalResult.multipliers);

  const selectedRows24h = selectContextualBurstCalibrationRowsForModel(
    options.trainingRows ?? [],
    now,
    24,
    config.modelVersion,
    config.freezeAt,
  );
  const selectedRows48h = selectContextualBurstCalibrationRowsForModel(
    options.trainingRows ?? [],
    now,
    48,
    config.modelVersion,
    config.freezeAt,
  );
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
  const calibrationFallbackUsed = trainingReadStatus === "error";
  const calibrationPair = enforceNextGenerationHorizonCoherence(
    calibrationFallbackUsed ? rawHorizons.probability24h : calibration24h.calibratedProbability24h,
    calibrationFallbackUsed ? rawHorizons.probability48h : calibration48h.calibratedProbability48h,
  );
  const calibratedHorizons: ShadowProbabilityHorizons = {
    probability12h: derive12hFrom24hProbability(calibrationPair.probability24h),
    probability24h: calibrationPair.probability24h,
    probability48h: calibrationPair.probability48h,
    probability72h: derive72hFrom48hProbability(calibrationPair.probability48h),
  };

  const latestRecoveryResetAt = allBoundaries.at(-1)?.resetAt ?? null;
  const latestRandomResetAt = randomBoundaries.at(-1)?.resetAt ?? null;
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
  const noticeHorizons = applyOfficialNoticeTimingPolicy(calibratedHorizons, notice, now);
  const finalPair = enforceNextGenerationHorizonCoherence(
    noticeHorizons?.probability24h ?? calibratedHorizons.probability24h,
    noticeHorizons?.probability48h ?? calibratedHorizons.probability48h,
  );
  const finalHorizons: ShadowProbabilityHorizons = {
    probability12h: noticeHorizons
      ? derive12hFrom24hProbability(finalPair.probability24h)
      : calibratedHorizons.probability12h,
    probability24h: finalPair.probability24h,
    probability48h: finalPair.probability48h,
    probability72h: noticeHorizons
      ? Math.max(finalPair.probability48h, derive72hFrom48hProbability(finalPair.probability48h))
      : calibratedHorizons.probability72h,
  };

  return {
    modelVersion: config.modelVersion,
    calculatedAt: now.toISOString(),
    targetDefinition: RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
    probability12h: finalHorizons.probability12h,
    probability24h: finalHorizons.probability24h,
    probability48h: finalHorizons.probability48h,
    probability72h: finalHorizons.probability72h,
    rawProbability24h: rawHorizons.probability24h,
    rawProbability48h: rawHorizons.probability48h,
    baseProbability24h: base.horizons.probability24h,
    baseProbability48h: base.horizons.probability48h,
    randomElapsedHours,
    latestRandomResetAt,
    latestRecoveryResetAt,
    originFeatures,
    contextFit: fit,
    effectiveContextMultiplier24h: fullContext.effectiveContextMultiplier24h,
    effectiveContextMultiplier48h: fullContext.effectiveContextMultiplier48h,
    baseInstantaneousHazardPerHour: getRandomContinuousHazardAtAge(hazard, randomElapsedHours),
    multipliers: signalResult.multipliers,
    alpha24h: calibrationFallbackUsed ? 0 : calibration24h.alpha24h,
    alpha48h: calibrationFallbackUsed ? 0 : calibration48h.alpha48h,
    calibrationSampleCount24h: calibrationFallbackUsed ? 0 : calibration24h.calibrationSampleCount24h,
    calibrationSampleCount48h: calibrationFallbackUsed ? 0 : calibration48h.calibrationSampleCount48h,
    positiveCalibrationCount24h: calibrationFallbackUsed ? 0 : calibration24h.positiveCalibrationCount24h,
    positiveCalibrationCount48h: calibrationFallbackUsed ? 0 : calibration48h.positiveCalibrationCount48h,
    lastResolvedOrigin24h: calibrationFallbackUsed ? null : calibration24h.lastResolvedOrigin24h,
    lastResolvedOrigin48h: calibrationFallbackUsed ? null : calibration48h.lastResolvedOrigin48h,
    horizonCoherenceAdjusted: calibrationPair.adjusted || (noticeHorizons ? finalPair.adjusted : false),
    trainingReadStatus,
    calibrationFallbackUsed,
    calibrationFallbackReason: calibrationFallbackUsed ? "prediction_history_training_query_failed" : null,
    officialNoticeOverride: {
      active: noticeHorizons !== null,
      probability12h: noticeHorizons?.probability12h ?? null,
      probability24h: noticeHorizons?.probability24h ?? null,
      probability48h: noticeHorizons?.probability48h ?? null,
      probability72h: noticeHorizons?.probability72h ?? null,
    },
    officialNoticeTimingPolicyVersion: "official-notice-window-v3",
    ablations: {
      baseOnly: {
        probability24h: base.horizons.probability24h,
        probability48h: base.horizons.probability48h,
      },
      noBurst: {
        probability24h: noBurst.horizons.probability24h,
        probability48h: noBurst.horizons.probability48h,
      },
      noCircadian: {
        probability24h: noCircadian.horizons.probability24h,
        probability48h: noCircadian.horizons.probability48h,
      },
      fullContext: {
        probability24h: fullContext.horizons.probability24h,
        probability48h: fullContext.horizons.probability48h,
      },
      fullRaw: {
        probability24h: rawHorizons.probability24h,
        probability48h: rawHorizons.probability48h,
      },
    },
    ...(normalization
      ? {
          normalizedAblations: {
            baseOnly: {
              probability24h: base.horizons.probability24h,
              probability48h: base.horizons.probability48h,
            },
            burstOnly: {
              probability24h: noCircadian.horizons.probability24h,
              probability48h: noCircadian.horizons.probability48h,
            },
            circadianNormalizedOnly: {
              probability24h: noBurst.horizons.probability24h,
              probability48h: noBurst.horizons.probability48h,
            },
            fullNormalizedContext: {
              probability24h: fullContext.horizons.probability24h,
              probability48h: fullContext.horizons.probability48h,
            },
          },
          circadianNormalizationConstant: normalization.constant,
          circadianCycleMeanBeforeNormalization: normalization.cycleMeanBeforeNormalization,
          circadianCycleMeanAfterNormalization: normalization.cycleMeanAfterNormalization,
          circadianNormalizationFallbackReason: normalization.fallbackReason,
        }
      : {}),
    freezeAt: config.freezeAt,
    freezePolicy: config.freezePolicy,
  };
}

export function calculateContextualBurstProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions & {
    trainingRows?: ContextualBurstCalibrationRow[];
    trainingReadStatus?: "ok" | "error";
  } = {},
): ContextualBurstProbabilityResult {
  return calculateContextualBurstProbabilityForModel(
    data,
    {
      modelVersion: NEXT_GENERATION_C_MODEL_VERSION,
      freezeAt: NEXT_GENERATION_C_FREEZE_AT,
      freezePolicy: NEXT_GENERATION_C_FREEZE_POLICY,
      normalizeCircadian: false,
    },
    options,
  );
}

export function calculateNormalizedContextualBurstProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions & {
    trainingRows?: ContextualBurstCalibrationRow[];
    trainingReadStatus?: "ok" | "error";
  } = {},
): ContextualBurstProbabilityResult {
  return calculateContextualBurstProbabilityForModel(
    data,
    {
      modelVersion: NEXT_GENERATION_C_V2_MODEL_VERSION,
      freezeAt: NEXT_GENERATION_C_V2_FREEZE_AT,
      freezePolicy: NEXT_GENERATION_C_V2_FREEZE_POLICY,
      normalizeCircadian: true,
    },
    options,
  );
}
