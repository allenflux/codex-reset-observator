import {
  GLOBAL_PRIOR_EVENT_COUNT,
  GLOBAL_PRIOR_EXPOSURE_DAYS,
  MAX_BASELINE_DAILY_PROBABILITY,
  MIN_BASELINE_DAILY_PROBABILITY,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_START_HOURS,
  RANDOM_CONTINUOUS_SHADOW_BANDWIDTH_HOURS,
  RANDOM_CONTINUOUS_SHADOW_FREEZE_AT,
  RANDOM_CONTINUOUS_SHADOW_FREEZE_POLICY,
  RANDOM_CONTINUOUS_SHADOW_GRID_HOURS,
  RANDOM_CONTINUOUS_SHADOW_KERNEL,
  RANDOM_CONTINUOUS_SHADOW_LOCAL_PRIOR_EXPOSURE_DAYS,
  RANDOM_CONTINUOUS_SHADOW_LOCAL_PRIOR_WINDOW_HOURS,
  RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
  RANDOM_CONTINUOUS_SHADOW_PROBE_AGES_HOURS,
  RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
  RANDOM_CONTINUOUS_SHADOW_TRUNCATION_HOURS,
} from "@/data/shadowProbabilityConfig";
import type { RadarData } from "./types";
import {
  applyOddsMultiplier,
  type ShadowHazard,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
} from "./shadowProbability";
import {
  calculateRegimeElapsedProbability,
  type RegimeElapsedProbabilityResult,
} from "./regimeElapsedProbability";
import {
  getRecoveryBoundaryAudit,
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "./recoveryBoundary";
import { getRandomElapsedBoundaries } from "./randomElapsedProbability";

const HOUR_MS = 60 * 60 * 1000;
const INTEGRATION_STEP_HOURS = 10 / 60;

export type RandomContinuousModelOptions = {
  bandwidthHours?: number;
  gridHours?: number;
  truncationHours?: number;
  localPriorExposureDays?: number;
  localPriorWindowHours?: number;
  integrationStepMinutes?: number;
  globalPriorEventCount?: number;
  globalPriorExposureDays?: number;
  minimumDailyProbability?: number;
  maximumDailyProbability?: number;
  regimeMultiplierPolicy?: RandomContinuousRegimeMultiplierPolicy;
};

export type RandomContinuousRegimeMultiplierPolicy =
  | "constant"
  | typeof NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION;

export type RegimeMultiplierAtAge = (
  ageHours: number,
  regimeMultiplier: number,
) => number;

type ExposureCell = {
  centerHours: number;
  exposureHours: number;
  eventCount: number;
};

export type RandomContinuousHazard = ShadowHazard & {
  eventAgesHours: number[];
  exposureCells: ExposureCell[];
  censoredExposureHours: number;
  bandwidthHours: number;
  gridHours: number;
  gridStepHours: number;
  truncationHours: number;
  priorExposureDays: number;
  localPriorExposureDays: number;
  localPriorWindowHours: number;
  integrationStepHours: number;
  minimumDailyProbability: number;
  maximumDailyProbability: number;
};

export type RandomContinuousAudit = {
  clock: "random";
  mode: "full";
  latestRandomResetAt: string | null;
  latestRecoveryResetAt: string | null;
  randomElapsedHours: number;
  recoveryElapsedHours: number;
  regimeMultiplier: number;
  effectiveRegimeMultiplier: number;
  regimeMultiplierPolicyVersion?: RandomContinuousRegimeMultiplierPolicy;
  integrationStepHours: number;
  recentRatePerDay: number;
  longTermRatePerDay: number;
  rawRateRatio: number;
  selectedBinScheme: string;
  selectedPriorExposureDays: number;
  selectedRegimeHalfLifeDays: number;
  selectedRegimeRatioExponent: number;
  recoveryBoundaryCount: number;
  randomBoundaryCount: number;
  regularBoundaryCount: number;
  randomBoundaryIds: string[];
  exposureCellCount: number;
  instantaneousHazardPerHour: number;
  instantaneousDailyProbability: number;
  currentKernelWeightedEvents: number;
  currentKernelWeightedExposureHours: number;
  kernelType: typeof RANDOM_CONTINUOUS_SHADOW_KERNEL;
  probeDailyProbabilities: Array<{
    ageHours: number;
    dailyProbability: number;
  }>;
  bandwidthHours: number;
  gridHours: number;
  gridStepHours: number;
  truncationHours: number;
  priorExposureDays: number;
  localPriorExposureDays: number;
  localPriorWindowHours: number;
  freezeAt: string;
  freezePolicy: string;
  boundaryAudit: ReturnType<typeof getRecoveryBoundaryAudit>;
};

export type RandomContinuousProbabilityResult = ShadowProbabilityResult & {
  randomContinuous: RandomContinuousAudit;
};

function getTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function kernelWeight(
  ageHours: number,
  targetAgeHours: number,
  bandwidthHours: number,
  truncationHours: number,
) {
  const distance = Math.abs(ageHours - targetAgeHours);
  if (!Number.isFinite(distance) || distance > truncationHours) return 0;
  const normalized = (ageHours - targetAgeHours) / bandwidthHours;
  return Math.exp(-0.5 * normalized ** 2);
}

function addExposureCells(
  cells: ExposureCell[],
  endHours: number,
  eventAgeHours: number | null = null,
  gridHours = RANDOM_CONTINUOUS_SHADOW_GRID_HOURS,
) {
  if (!Number.isFinite(endHours) || endHours <= 0) return;
  let cursor = 0;
  while (cursor < endHours) {
    const duration = Math.min(gridHours, endHours - cursor);
    if (!Number.isFinite(duration) || duration <= 0) break;
    cells.push({
      centerHours: cursor + duration / 2,
      exposureHours: duration,
      eventCount: eventAgeHours !== null
        && eventAgeHours >= cursor
        && eventAgeHours <= cursor + duration
        ? 1
        : 0,
    });
    cursor += duration;
  }
}

function getLatestElapsedHours(boundaries: RecoveryResetBoundary[], now: Date) {
  const latest = boundaries.at(-1);
  const latestTime = getTimestamp(latest?.resetAt);
  return latestTime === null
    ? 0
    : Math.max(0, (now.getTime() - latestTime) / HOUR_MS);
}

export function buildRandomContinuousHazard(
  boundaries: RecoveryResetBoundary[],
  now: Date,
  options: RandomContinuousModelOptions = {},
): RandomContinuousHazard {
  const bandwidthHours = Number.isFinite(options.bandwidthHours) && options.bandwidthHours! > 0
    ? options.bandwidthHours!
    : RANDOM_CONTINUOUS_SHADOW_BANDWIDTH_HOURS;
  const gridHours = Number.isFinite(options.gridHours) && options.gridHours! > 0
    ? options.gridHours!
    : RANDOM_CONTINUOUS_SHADOW_GRID_HOURS;
  const truncationHours = Number.isFinite(options.truncationHours) && options.truncationHours! > 0
    ? options.truncationHours!
    : RANDOM_CONTINUOUS_SHADOW_TRUNCATION_HOURS;
  const localPriorExposureDays = Number.isFinite(options.localPriorExposureDays) && options.localPriorExposureDays! > 0
    ? options.localPriorExposureDays!
    : RANDOM_CONTINUOUS_SHADOW_LOCAL_PRIOR_EXPOSURE_DAYS;
  const localPriorWindowHours = Number.isFinite(options.localPriorWindowHours) && options.localPriorWindowHours! > 0
    ? options.localPriorWindowHours!
    : RANDOM_CONTINUOUS_SHADOW_LOCAL_PRIOR_WINDOW_HOURS;
  const integrationStepHours = Number.isFinite(options.integrationStepMinutes) && options.integrationStepMinutes! > 0
    ? options.integrationStepMinutes! / 60
    : INTEGRATION_STEP_HOURS;
  const globalPriorEventCount = Number.isFinite(options.globalPriorEventCount) && options.globalPriorEventCount! >= 0
    ? options.globalPriorEventCount!
    : GLOBAL_PRIOR_EVENT_COUNT;
  const globalPriorExposureDays = Number.isFinite(options.globalPriorExposureDays) && options.globalPriorExposureDays! > 0
    ? options.globalPriorExposureDays!
    : GLOBAL_PRIOR_EXPOSURE_DAYS;
  const minimumDailyProbability = Number.isFinite(options.minimumDailyProbability)
    ? Math.max(0, Math.min(1, options.minimumDailyProbability!))
    : MIN_BASELINE_DAILY_PROBABILITY;
  const maximumDailyProbability = Number.isFinite(options.maximumDailyProbability)
    ? Math.max(minimumDailyProbability, Math.min(1, options.maximumDailyProbability!))
    : MAX_BASELINE_DAILY_PROBABILITY;
  const eventAgesHours: number[] = [];
  const exposureCells: ExposureCell[] = [];
  let completedIntervalCount = 0;
  let totalExposureHours = 0;

  for (let index = 1; index < boundaries.length; index += 1) {
    const previousTime = getTimestamp(boundaries[index - 1].resetAt);
    const currentTime = getTimestamp(boundaries[index].resetAt);
    if (previousTime === null || currentTime === null || currentTime <= previousTime) continue;

    const intervalHours = (currentTime - previousTime) / HOUR_MS;
    addExposureCells(exposureCells, intervalHours, intervalHours, gridHours);
    totalExposureHours += intervalHours;
    completedIntervalCount += 1;
    eventAgesHours.push(intervalHours);
  }

  const latestBoundaryTime = boundaries.at(-1)
    ? getTimestamp(boundaries.at(-1)!.resetAt)
    : null;
  const censoredExposureHours = latestBoundaryTime === null
    ? 0
    : Math.max(0, (now.getTime() - latestBoundaryTime) / HOUR_MS);
  if (censoredExposureHours > 0) {
    addExposureCells(exposureCells, censoredExposureHours, null, gridHours);
    totalExposureHours += censoredExposureHours;
  }

  const globalLambdaPerHour = (
    eventAgesHours.length + globalPriorEventCount
  ) / (
    totalExposureHours + globalPriorExposureDays * 24
  );

  return {
    globalLambdaPerHour,
    observedEventCount: eventAgesHours.length,
    weightedEventCount: eventAgesHours.length,
    completedEventCount: boundaries.length,
    completedIntervalCount,
    totalExposureHours,
    weightedExposureHours: totalExposureHours,
    totalExposureDays: totalExposureHours / 24,
    bins: [],
    eventAgesHours,
    exposureCells,
    censoredExposureHours,
    bandwidthHours,
    gridHours,
    gridStepHours: gridHours,
    truncationHours,
    priorExposureDays: localPriorExposureDays,
    localPriorExposureDays,
    localPriorWindowHours,
    integrationStepHours,
    minimumDailyProbability,
    maximumDailyProbability,
  };
}

function getKernelPosterior(hazard: RandomContinuousHazard, ageHours: number) {
  const weightedEventCount = hazard.exposureCells.reduce(
    (sum, cell) => sum + cell.eventCount * kernelWeight(
      cell.centerHours,
      ageHours,
      hazard.bandwidthHours,
      hazard.truncationHours,
    ),
    0,
  );
  const weightedExposureHours = hazard.exposureCells.reduce(
    (sum, cell) => sum + cell.exposureHours * kernelWeight(
      cell.centerHours,
      ageHours,
      hazard.bandwidthHours,
      hazard.truncationHours,
    ),
    0,
  );
  const priorEventEquivalent = hazard.globalLambdaPerHour * hazard.localPriorWindowHours;
  const posteriorLambdaPerHour = (
    weightedEventCount + priorEventEquivalent
  ) / (
    weightedExposureHours + hazard.localPriorWindowHours
  );
  const impliedDailyProbability = clamp01(1 - Math.exp(-posteriorLambdaPerHour * 24));
  const dailyProbability = clamp(
    impliedDailyProbability,
    hazard.minimumDailyProbability,
    hazard.maximumDailyProbability,
  );

  return {
    weightedEventCount,
    weightedExposureHours,
    priorEventEquivalent,
    posteriorLambdaPerHour: -Math.log(1 - dailyProbability) / 24,
    dailyProbability,
  };
}

type ContinuousHazardEvaluator = {
  getHazardAtAge: (ageHours: number) => number;
  getDiagnosticsAtAge: (ageHours: number) => ReturnType<typeof getKernelPosterior>;
};

function createContinuousHazardEvaluator(hazard: RandomContinuousHazard): ContinuousHazardEvaluator {
  const cache = new Map<number, ReturnType<typeof getKernelPosterior>>();

  const getDiagnosticsAtAge = (ageHours: number) => {
    const normalizedAge = Math.max(0, ageHours);
    const cached = cache.get(normalizedAge);
    if (cached) return cached;

    const diagnostics = getKernelPosterior(hazard, normalizedAge);
    cache.set(normalizedAge, diagnostics);
    return diagnostics;
  };

  return {
    getHazardAtAge: (ageHours) => {
      if (!Number.isFinite(ageHours)) return 0;
      return getDiagnosticsAtAge(ageHours).posteriorLambdaPerHour;
    },
    getDiagnosticsAtAge,
  };
}

export function getRandomContinuousHazardAtAge(
  hazard: RandomContinuousHazard,
  ageHours: number,
) {
  if (!Number.isFinite(ageHours)) return 0;
  return getKernelPosterior(hazard, Math.max(0, ageHours)).posteriorLambdaPerHour;
}

export function getRandomContinuousHazardDiagnosticsAtAge(
  hazard: RandomContinuousHazard,
  ageHours: number,
) {
  return getKernelPosterior(hazard, Math.max(0, ageHours));
}

export function integrateRandomContinuousHazard(
  hazard: RandomContinuousHazard,
  startAgeHours: number,
  horizonHours: number,
  regimeMultiplier = 1,
  getRegimeMultiplierAtAge?: RegimeMultiplierAtAge,
) {
  return integrateRandomContinuousHazardWithGetter(
    startAgeHours,
    horizonHours,
    regimeMultiplier,
    (ageHours) => getRandomContinuousHazardAtAge(hazard, ageHours),
    hazard.integrationStepHours,
    getRegimeMultiplierAtAge,
  );
}

export function getPostResetRegimeMultiplierAtAge(
  ageHours: number,
  regimeMultiplier: number,
) {
  const fullMultiplier = Number.isFinite(regimeMultiplier)
    ? Math.max(0, regimeMultiplier)
    : 1;
  if (!Number.isFinite(ageHours) || ageHours < NEXT_GENERATION_B_POST_RESET_AGE_START_HOURS) {
    return 1;
  }
  return fullMultiplier;
}

function integrateRandomContinuousHazardWithGetter(
  startAgeHours: number,
  horizonHours: number,
  regimeMultiplier: number,
  getHazardAtAge: (ageHours: number) => number,
  integrationStepHours = INTEGRATION_STEP_HOURS,
  getRegimeMultiplierAtAge?: RegimeMultiplierAtAge,
) {
  if (!Number.isFinite(startAgeHours) || !Number.isFinite(horizonHours) || horizonHours <= 0) return 0;

  const start = Math.max(0, startAgeHours);
  const end = start + horizonHours;
  let cursor = start;
  let cumulativeHazard = 0;
  let currentLambda = getHazardAtAge(cursor);
  while (cursor < end) {
    const stepEnd = Math.min(end, cursor + integrationStepHours);
    if (!Number.isFinite(stepEnd) || stepEnd <= cursor) break;
    const stepHours = stepEnd - cursor;
    const nextLambda = getHazardAtAge(stepEnd);
    if (getRegimeMultiplierAtAge) {
      const midpoint = cursor + stepHours / 2;
      const midpointMultiplier = getRegimeMultiplierAtAge(midpoint, regimeMultiplier);
      cumulativeHazard += (
        (currentLambda + nextLambda) / 2
      ) * stepHours * (
        Number.isFinite(midpointMultiplier) ? Math.max(0, midpointMultiplier) : 0
      );
    } else {
      cumulativeHazard += (
        (currentLambda + nextLambda) / 2
      ) * stepHours * Math.max(0, regimeMultiplier);
    }
    cursor = stepEnd;
    currentLambda = nextLambda;
  }

  return clamp01(1 - Math.exp(-Math.max(0, cumulativeHazard)));
}

function makeHorizons(
  hazard: RandomContinuousHazard,
  randomElapsedHours: number,
  regimeMultiplier: number,
  getHazardAtAge: (ageHours: number) => number = (ageHours) => getRandomContinuousHazardAtAge(hazard, ageHours),
  getRegimeMultiplierAtAge?: RegimeMultiplierAtAge,
): ShadowProbabilityHorizons {
  return {
    probability12h: integrateRandomContinuousHazardWithGetter(randomElapsedHours, 12, regimeMultiplier, getHazardAtAge, hazard.integrationStepHours, getRegimeMultiplierAtAge),
    probability24h: integrateRandomContinuousHazardWithGetter(randomElapsedHours, 24, regimeMultiplier, getHazardAtAge, hazard.integrationStepHours, getRegimeMultiplierAtAge),
    probability48h: integrateRandomContinuousHazardWithGetter(randomElapsedHours, 48, regimeMultiplier, getHazardAtAge, hazard.integrationStepHours, getRegimeMultiplierAtAge),
    probability72h: integrateRandomContinuousHazardWithGetter(randomElapsedHours, 72, regimeMultiplier, getHazardAtAge, hazard.integrationStepHours, getRegimeMultiplierAtAge),
  };
}

function makeConfidence(hazard: RandomContinuousHazard, officialNoticeActive: boolean) {
  if (officialNoticeActive) {
    return {
      level: "high" as const,
      reason: "An active official notice overrides the normal confidence tier.",
    };
  }
  if (hazard.completedIntervalCount >= 30 && hazard.totalExposureDays >= 120) {
    return {
      level: "medium" as const,
      reason: "The completed random-reset intervals and exposure meet the medium-confidence floor.",
    };
  }
  return {
    level: "low" as const,
    reason: "The available random-reset intervals or exposure are below the medium-confidence floor.",
  };
}

export function calculateRandomContinuousProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
  precomputedRecoveryResult?: RegimeElapsedProbabilityResult,
  modelOptions: RandomContinuousModelOptions = {},
): RandomContinuousProbabilityResult {
  const now = options.now ?? new Date();
  const recoveryResult = precomputedRecoveryResult ?? calculateRegimeElapsedProbability(data, options);
  const boundaries = getRecoveryResetEvents(
    data,
    now,
    options.staticHistory,
    options.canonicalHistoryContext,
  );
  const randomBoundaries = getRandomElapsedBoundaries(boundaries);
  const hazard = buildRandomContinuousHazard(randomBoundaries, now, modelOptions);
  const latestRandomResetAt = randomBoundaries.at(-1)?.resetAt ?? null;
  const latestRecoveryResetAt = boundaries.at(-1)?.resetAt ?? null;
  const randomElapsedHours = getLatestElapsedHours(randomBoundaries, now);
  const recoveryElapsedHours = getLatestElapsedHours(boundaries, now);
  const regimeMultiplier = recoveryResult.regimeElapsed.regime.regimeMultiplier;
  const getRegimeMultiplierAtAge = modelOptions.regimeMultiplierPolicy === NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION
    ? getPostResetRegimeMultiplierAtAge
    : undefined;
  const evaluator = createContinuousHazardEvaluator(hazard);
  const baseline = makeHorizons(
    hazard,
    randomElapsedHours,
    regimeMultiplier,
    evaluator.getHazardAtAge,
    getRegimeMultiplierAtAge,
  );
  const adjusted: ShadowProbabilityHorizons = {
    probability12h: applyOddsMultiplier(
      baseline.probability12h,
      recoveryResult.multipliers.combinedAfterCap.probability24h,
    ),
    probability24h: applyOddsMultiplier(
      baseline.probability24h,
      recoveryResult.multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      baseline.probability48h,
      recoveryResult.multipliers.combinedAfterCap.probability48h,
    ),
    probability72h: applyOddsMultiplier(
      baseline.probability72h,
      recoveryResult.multipliers.combinedAfterCap.probability48h,
    ),
  };
  const predictions = recoveryResult.officialNoticeOverride.active
    ? {
        probability12h: recoveryResult.officialNoticeOverride.probability12h ?? 0.9,
        probability24h: recoveryResult.officialNoticeOverride.probability24h ?? 0.9,
        probability48h: recoveryResult.officialNoticeOverride.probability48h ?? 0.96,
        probability72h: recoveryResult.officialNoticeOverride.probability72h ?? 0.96,
      }
    : adjusted;
  const currentDiagnostics = evaluator.getDiagnosticsAtAge(randomElapsedHours);
  const effectiveRegimeMultiplier = getRegimeMultiplierAtAge
    ? getRegimeMultiplierAtAge(randomElapsedHours, regimeMultiplier)
    : regimeMultiplier;
  const confidence = makeConfidence(hazard, recoveryResult.officialNoticeOverride.active);
  const warnings: string[] = [];
  if (hazard.completedIntervalCount < 2) {
    warnings.push("Random-reset intervals are sparse; treat this shadow result as exploratory.");
  }
  warnings.push("Regular recovery boundaries remain in the audit but do not reset the random-event hazard clock.");

  return {
    modelVersion: RANDOM_CONTINUOUS_SHADOW_MODEL_VERSION,
    calculatedAt: now.toISOString(),
    targetDefinition: RANDOM_CONTINUOUS_SHADOW_TARGET_DEFINITION,
    predictions,
    baseline,
    confidence: {
      ...confidence,
      completedIntervalCount: hazard.completedIntervalCount,
      totalExposureDays: hazard.totalExposureDays,
    },
    hazard,
    multipliers: recoveryResult.multipliers,
    officialNoticeOverride: recoveryResult.officialNoticeOverride,
    warnings,
    randomContinuous: {
      clock: "random",
      mode: "full",
      latestRandomResetAt,
      latestRecoveryResetAt,
      randomElapsedHours,
      recoveryElapsedHours,
      regimeMultiplier,
      effectiveRegimeMultiplier,
      regimeMultiplierPolicyVersion: modelOptions.regimeMultiplierPolicy,
      integrationStepHours: hazard.integrationStepHours,
      recentRatePerDay: recoveryResult.regimeElapsed.regime.recentRatePerDay,
      longTermRatePerDay: recoveryResult.regimeElapsed.regime.longTermRatePerDay,
      rawRateRatio: recoveryResult.regimeElapsed.regime.rawRateRatio,
      selectedBinScheme: recoveryResult.regimeElapsed.binScheme,
      selectedPriorExposureDays: recoveryResult.regimeElapsed.priorExposureDays,
      selectedRegimeHalfLifeDays: recoveryResult.regimeElapsed.regimeHalfLifeDays,
      selectedRegimeRatioExponent: recoveryResult.regimeElapsed.regimeRatioExponent,
      recoveryBoundaryCount: boundaries.length,
      randomBoundaryCount: randomBoundaries.length,
      regularBoundaryCount: boundaries.filter((boundary) => boundary.isRegular).length,
      randomBoundaryIds: randomBoundaries.map((boundary) => boundary.id),
      exposureCellCount: hazard.exposureCells.length,
      instantaneousHazardPerHour: currentDiagnostics.posteriorLambdaPerHour,
      instantaneousDailyProbability: currentDiagnostics.dailyProbability,
      currentKernelWeightedEvents: currentDiagnostics.weightedEventCount,
      currentKernelWeightedExposureHours: currentDiagnostics.weightedExposureHours,
      kernelType: RANDOM_CONTINUOUS_SHADOW_KERNEL,
      probeDailyProbabilities: RANDOM_CONTINUOUS_SHADOW_PROBE_AGES_HOURS.map((ageHours) => ({
        ageHours,
        dailyProbability: evaluator.getDiagnosticsAtAge(ageHours).dailyProbability,
      })),
      bandwidthHours: hazard.bandwidthHours,
      gridHours: hazard.gridHours,
      gridStepHours: hazard.gridHours,
      truncationHours: hazard.truncationHours,
      priorExposureDays: hazard.localPriorExposureDays,
      localPriorExposureDays: hazard.localPriorExposureDays,
      localPriorWindowHours: hazard.localPriorWindowHours,
      freezeAt: RANDOM_CONTINUOUS_SHADOW_FREEZE_AT,
      freezePolicy: RANDOM_CONTINUOUS_SHADOW_FREEZE_POLICY,
      boundaryAudit: getRecoveryBoundaryAudit(
        data,
        now,
        options.staticHistory,
        options.canonicalHistoryContext,
      ),
    },
  };
}
