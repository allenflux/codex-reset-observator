import {
  GLOBAL_PRIOR_EVENT_COUNT,
  GLOBAL_PRIOR_EXPOSURE_DAYS,
  MAX_BASELINE_DAILY_PROBABILITY,
  MAX_TOTAL_ODDS_MULTIPLIER_24H,
  MAX_TOTAL_ODDS_MULTIPLIER_48H,
  MIN_BASELINE_DAILY_PROBABILITY,
  ELAPSED_ONLY_MODEL_VERSION,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  REGIME_ELAPSED_MAX_MULTIPLIER,
  REGIME_ELAPSED_MIN_MULTIPLIER,
  REGIME_ELAPSED_SELECTED_BIN_SCHEME,
  REGIME_ELAPSED_SELECTED_PRIOR_EXPOSURE_DAYS,
  REGIME_ELAPSED_SELECTED_RATIO_EXPONENT,
  REGIME_ELAPSED_SELECTED_REGIME_HALF_LIFE_DAYS,
} from "@/data/shadowProbabilityConfig";
import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import {
  getActiveOfficialNotice,
  getLocalSignalEvaluation,
  type ActiveOfficialNotice,
  type LocalSignalEvaluation,
} from "./probability";
import type { RadarData, WindowEventLike } from "./types";
import {
  applyOddsMultiplier,
  calculateShadowSignalMultipliers,
  derive12hFrom24hProbability,
  derive72hFrom48hProbability,
  getShadowSignalInputs,
  type ShadowHazard,
  type ShadowHazardBin,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
  type ShadowSignalMultiplierConfig,
} from "./shadowProbability";
import {
  getRecoveryBoundaryAudit,
  getLastRandomRecoveryResetWindow,
  getRecoveryResetEvents,
  type RecoveryBoundaryAudit,
  type RecoveryResetBoundary,
} from "./recoveryBoundary";
import {
  getTemporalNoticeCoverage,
} from "./tiboTemporal";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LOG_2 = Math.LN2;
const INTEGRATION_STEP_HOURS = 10 / 60;
export const OFFICIAL_NOTICE_TIMING_POLICY_VERSION = "official-notice-window-v3";

export type RegimeElapsedBinScheme = "A" | "B";
export type RegimeElapsedMode = "full" | "elapsed-only" | "regime-only";

export type RegimeElapsedModelOptions = {
  modelVersion?: string;
  binScheme?: RegimeElapsedBinScheme;
  priorExposureDays?: number;
  regimeHalfLifeDays?: number;
  regimeRatioExponent?: number;
  minRegimeMultiplier?: number;
  maxRegimeMultiplier?: number;
  mode?: RegimeElapsedMode;
  signalMultiplierConfig?: ShadowSignalMultiplierConfig;
};

export type RegimeElapsedHazardBin = ShadowHazardBin;

export type RegimeDiagnostics = {
  recentWeightedEventCount: number;
  recentWeightedExposureDays: number;
  recentRatePerDay: number;
  longTermRatePerDay: number;
  rawRateRatio: number;
  regimeMultiplier: number;
  halfLifeDays: number;
  priorEventCount: number;
  priorExposureDays: number;
  rawRandomEventCount: number;
  observationStartAt: string | null;
};

export type RegimeElapsedHazard = ShadowHazard & {
  recoveryBoundaryCount: number;
  randomBoundaryCount: number;
  regularBoundaryCount: number;
  censoredExposureHours: number;
  binScheme: RegimeElapsedBinScheme;
  priorExposureDays: number;
};

export type RegimeElapsedAudit = {
  mode: RegimeElapsedMode;
  binScheme: RegimeElapsedBinScheme;
  priorExposureDays: number;
  regimeHalfLifeDays: number;
  regimeRatioExponent: number;
  latestRandomResetAt: string | null;
  latestRecoveryResetAt: string | null;
  elapsedHours: number;
  regime: RegimeDiagnostics;
  effectiveRegimeMultiplier: number;
  bins: Array<RegimeElapsedHazardBin>;
  recoveryBoundaryCount: number;
  randomBoundaryCount: number;
  regularBoundaryCount: number;
  boundaryAudit: RecoveryBoundaryAudit[];
  officialNoticeTimingPolicyVersion: string;
};

export type RegimeElapsedProbabilityResult = ShadowProbabilityResult & {
  regimeElapsed: RegimeElapsedAudit;
};

export const REGIME_ELAPSED_TARGET_DEFINITION =
  "Broad-scope random reset probability modeled by recovery-boundary elapsed time and a point-in-time, exponentially weighted random-reset regime; regular resets are recovery boundaries but never random target events.";

const BIN_SCHEMES: Record<RegimeElapsedBinScheme, Array<[number, number | null]>> = {
  A: [[0, 12], [12, 24], [24, 48], [48, 72], [72, 168], [168, null]],
  B: [[0, 24], [24, 48], [48, 72], [72, 168], [168, null]],
};

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function finitePositive(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function getTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function createBins(scheme: RegimeElapsedBinScheme) {
  return BIN_SCHEMES[scheme].map(([startHour, endHour]): RegimeElapsedHazardBin => ({
    startHour,
    endHour,
    exposureHours: 0,
    observedEvents: 0,
    posteriorLambdaPerHour: 0,
    impliedDailyProbability: 0,
  }));
}

function getBinIndex(bins: Array<RegimeElapsedHazardBin>, ageHours: number) {
  const normalizedAge = Math.max(0, ageHours);
  const index = bins.findIndex((bin) =>
    normalizedAge >= bin.startHour &&
    (bin.endHour === null || normalizedAge < bin.endHour),
  );
  return index === -1 ? bins.length - 1 : index;
}

function addExposure(
  bins: Array<RegimeElapsedHazardBin>,
  startHour: number,
  durationHours: number,
) {
  if (!Number.isFinite(startHour) || !Number.isFinite(durationHours) || durationHours <= 0) return;

  const endHour = startHour + durationHours;
  let cursor = Math.max(0, startHour);
  while (cursor < endHour) {
    const bin = bins[getBinIndex(bins, cursor)];
    const boundary = bin.endHour ?? Number.POSITIVE_INFINITY;
    const segmentEnd = Math.min(endHour, boundary);
    bin.exposureHours += Math.max(0, segmentEnd - cursor);
    if (!Number.isFinite(segmentEnd) || segmentEnd <= cursor) break;
    cursor = segmentEnd;
  }
}

function getElapsedAgeHours(boundaries: RecoveryResetBoundary[], nowTime: number) {
  const last = boundaries.at(-1);
  const lastTime = last ? getTimestamp(last.resetAt) : null;
  return lastTime === null ? 0 : Math.max(0, (nowTime - lastTime) / HOUR_MS);
}

export function buildRegimeElapsedHazard(
  boundaries: RecoveryResetBoundary[],
  now: Date,
  options: Pick<RegimeElapsedModelOptions, "binScheme" | "priorExposureDays"> = {},
): RegimeElapsedHazard {
  const nowTime = now.getTime();
  const binScheme = options.binScheme ?? REGIME_ELAPSED_SELECTED_BIN_SCHEME;
  const priorExposureDays = finitePositive(
    options.priorExposureDays,
    REGIME_ELAPSED_SELECTED_PRIOR_EXPOSURE_DAYS,
  );
  const bins = createBins(binScheme);
  let observedEventCount = 0;
  let totalExposureHours = 0;
  let completedIntervalCount = 0;

  for (let index = 1; index < boundaries.length; index += 1) {
    const previousTime = getTimestamp(boundaries[index - 1].resetAt);
    const currentTime = getTimestamp(boundaries[index].resetAt);
    if (previousTime === null || currentTime === null || currentTime <= previousTime) continue;

    const intervalHours = (currentTime - previousTime) / HOUR_MS;
    addExposure(bins, 0, intervalHours);
    totalExposureHours += intervalHours;
    completedIntervalCount += 1;

    if (boundaries[index].isRandom) {
      observedEventCount += 1;
      bins[getBinIndex(bins, intervalHours)].observedEvents += 1;
    }
  }

  const latestBoundaryTime = boundaries.at(-1) ? getTimestamp(boundaries.at(-1)!.resetAt) : null;
  const censoredExposureHours = latestBoundaryTime === null
    ? 0
    : Math.max(0, (nowTime - latestBoundaryTime) / HOUR_MS);
  if (censoredExposureHours > 0) {
    addExposure(bins, 0, censoredExposureHours);
    totalExposureHours += censoredExposureHours;
  }

  const globalLambdaPerHour = (
    observedEventCount + GLOBAL_PRIOR_EVENT_COUNT
  ) / (
    totalExposureHours + GLOBAL_PRIOR_EXPOSURE_DAYS * 24
  );
  const priorExposureHours = priorExposureDays * 24;
  const priorEventCount = globalLambdaPerHour * priorExposureHours;

  for (const bin of bins) {
    const posteriorLambda = (
      bin.observedEvents + priorEventCount
    ) / (
      bin.exposureHours + priorExposureHours
    );
    const impliedDailyProbability = clamp01(1 - Math.exp(-posteriorLambda * 24));
    const safeDailyProbability = clamp(
      impliedDailyProbability,
      MIN_BASELINE_DAILY_PROBABILITY,
      MAX_BASELINE_DAILY_PROBABILITY,
    );
    bin.posteriorLambdaPerHour = -Math.log(1 - safeDailyProbability) / 24;
    bin.impliedDailyProbability = safeDailyProbability;
  }

  return {
    globalLambdaPerHour,
    observedEventCount,
    weightedEventCount: observedEventCount,
    completedEventCount: boundaries.filter((boundary) => boundary.isRandom).length,
    completedIntervalCount,
    totalExposureHours,
    weightedExposureHours: totalExposureHours,
    totalExposureDays: totalExposureHours / 24,
    bins,
    recoveryBoundaryCount: boundaries.length,
    randomBoundaryCount: boundaries.filter((boundary) => boundary.isRandom).length,
    regularBoundaryCount: boundaries.filter((boundary) => boundary.isRegular).length,
    censoredExposureHours,
    binScheme,
    priorExposureDays,
  };
}

export function integrateRegimeElapsedHazard(
  hazard: RegimeElapsedHazard,
  startAgeHours: number,
  horizonHours: number,
  regimeMultiplier = 1,
) {
  if (!Number.isFinite(startAgeHours) || !Number.isFinite(horizonHours) || horizonHours <= 0) return 0;

  const start = Math.max(0, startAgeHours);
  const end = start + horizonHours;
  let cursor = start;
  let cumulativeHazard = 0;
  let currentLambda = getRegimeElapsedHazardAtAge(hazard, cursor);
  while (cursor < end) {
    const bin = hazard.bins[getBinIndex(hazard.bins, cursor)];
    const binBoundary = bin.endHour ?? Number.POSITIVE_INFINITY;
    const stepEnd = Math.min(end, binBoundary, cursor + INTEGRATION_STEP_HOURS);
    if (!Number.isFinite(stepEnd) || stepEnd <= cursor) break;
    const stepHours = stepEnd - cursor;
    const nextLambda = getRegimeElapsedHazardAtAge(hazard, stepEnd);
    cumulativeHazard += ((currentLambda + nextLambda) / 2) * stepHours * Math.max(0, regimeMultiplier);
    cursor = stepEnd;
    currentLambda = nextLambda;
  }

  return clamp01(1 - Math.exp(-Math.max(0, cumulativeHazard)));
}

export function getRegimeElapsedHazardAtAge(
  hazard: RegimeElapsedHazard,
  ageHours: number,
) {
  if (!Number.isFinite(ageHours) || hazard.bins.length === 0) return 0;

  const age = Math.max(0, ageHours);
  const index = getBinIndex(hazard.bins, age);
  const current = hazard.bins[index];
  const next = hazard.bins[index + 1];
  if (!next || current.endHour === null || current.endHour <= current.startHour) {
    return current.posteriorLambdaPerHour;
  }

  const progress = clamp(
    (age - current.startHour) / (current.endHour - current.startHour),
    0,
    1,
  );
  return current.posteriorLambdaPerHour +
    (next.posteriorLambdaPerHour - current.posteriorLambdaPerHour) * progress;
}

function integrateDecayExposureDays(startTime: number, endTime: number, nowTime: number, halfLifeDays: number) {
  if (endTime <= startTime || endTime > nowTime) return 0;
  const halfLifeMs = halfLifeDays * DAY_MS;
  const endWeight = Math.exp(-LOG_2 * (nowTime - endTime) / halfLifeMs);
  const startWeight = Math.exp(-LOG_2 * (nowTime - startTime) / halfLifeMs);
  return Math.max(0, (endWeight - startWeight) * halfLifeMs / LOG_2 / DAY_MS);
}

export function calculateRegimeDiagnostics(
  boundaries: RecoveryResetBoundary[],
  now: Date,
  options: Pick<RegimeElapsedModelOptions, "priorExposureDays" | "regimeHalfLifeDays" | "regimeRatioExponent" | "minRegimeMultiplier" | "maxRegimeMultiplier"> = {},
): RegimeDiagnostics {
  const nowTime = now.getTime();
  const halfLifeDays = finitePositive(options.regimeHalfLifeDays, REGIME_ELAPSED_SELECTED_REGIME_HALF_LIFE_DAYS);
  const ratioExponent = finitePositive(options.regimeRatioExponent, REGIME_ELAPSED_SELECTED_RATIO_EXPONENT);
  const priorExposureDays = finitePositive(options.priorExposureDays, GLOBAL_PRIOR_EXPOSURE_DAYS);
  const priorEventCount = GLOBAL_PRIOR_EVENT_COUNT;
  const randomTimes = boundaries
    .filter((boundary) => boundary.isRandom)
    .map((boundary) => getTimestamp(boundary.resetAt))
    .filter((time): time is number => time !== null && time <= nowTime)
    .sort((left, right) => left - right);

  if (randomTimes.length === 0) {
    return {
      recentWeightedEventCount: 0,
      recentWeightedExposureDays: 0,
      recentRatePerDay: 0,
      longTermRatePerDay: 0,
      rawRateRatio: 1,
      regimeMultiplier: 1,
      halfLifeDays,
      priorEventCount,
      priorExposureDays,
      rawRandomEventCount: 0,
      observationStartAt: null,
    };
  }

  const observationStart = randomTimes[0];
  const recentWeightedEventCount = randomTimes.reduce(
    (sum, time) => sum + Math.exp(-LOG_2 * (nowTime - time) / (halfLifeDays * DAY_MS)),
    0,
  );
  const recentWeightedExposureDays = integrateDecayExposureDays(
    observationStart,
    nowTime,
    nowTime,
    halfLifeDays,
  );
  const rawExposureDays = Math.max(0, (nowTime - observationStart) / DAY_MS);
  const recentRatePerDay = (
    recentWeightedEventCount + priorEventCount
  ) / (
    recentWeightedExposureDays + priorExposureDays
  );
  const longTermRatePerDay = (
    randomTimes.length + priorEventCount
  ) / (
    rawExposureDays + priorExposureDays
  );
  const rawRateRatio = longTermRatePerDay > 0
    ? recentRatePerDay / longTermRatePerDay
    : 1;
  const minMultiplier = finitePositive(options.minRegimeMultiplier, REGIME_ELAPSED_MIN_MULTIPLIER);
  const maxMultiplier = Math.max(
    minMultiplier,
    finitePositive(options.maxRegimeMultiplier, REGIME_ELAPSED_MAX_MULTIPLIER),
  );

  return {
    recentWeightedEventCount,
    recentWeightedExposureDays,
    recentRatePerDay,
    longTermRatePerDay,
    rawRateRatio,
    regimeMultiplier: clamp(Math.pow(Math.max(rawRateRatio, 0), ratioExponent), minMultiplier, maxMultiplier),
    halfLifeDays,
    priorEventCount,
    priorExposureDays,
    rawRandomEventCount: randomTimes.length,
    observationStartAt: new Date(observationStart).toISOString(),
  };
}

function getBaseProbability(
  hazard: RegimeElapsedHazard,
  mode: RegimeElapsedMode,
  ageHours: number,
  horizonHours: number,
  regimeMultiplier: number,
) {
  if (mode === "regime-only") {
    return clamp01(1 - Math.exp(-hazard.globalLambdaPerHour * regimeMultiplier * horizonHours));
  }
  return integrateRegimeElapsedHazard(
    hazard,
    ageHours,
    horizonHours,
    mode === "elapsed-only" ? 1 : regimeMultiplier,
  );
}

function makeHorizons(
  hazard: RegimeElapsedHazard,
  mode: RegimeElapsedMode,
  ageHours: number,
  regimeMultiplier: number,
) {
  return {
    probability12h: getBaseProbability(hazard, mode, ageHours, 12, regimeMultiplier),
    probability24h: getBaseProbability(hazard, mode, ageHours, 24, regimeMultiplier),
    probability48h: getBaseProbability(hazard, mode, ageHours, 48, regimeMultiplier),
    probability72h: getBaseProbability(hazard, mode, ageHours, 72, regimeMultiplier),
  } satisfies ShadowProbabilityHorizons;
}

export function applyOfficialNoticeTimingPolicy(
  baseline: ShadowProbabilityHorizons,
  notice: ActiveOfficialNotice | null,
  now: Date,
) {
  if (!notice) return null;

  const temporalResolution = {
    status: notice.temporalResolutionStatus ?? "unresolved",
    temporalPrecision: notice.temporalPrecision ?? "unknown",
    confidence: notice.temporalConfidence ?? null,
    expectedStartAt: notice.expectedAt,
    expectedEndAt: notice.expectedEndAt,
  };
  const coverage24 = getTemporalNoticeCoverage(temporalResolution, now, 24);
  const coverage48 = getTemporalNoticeCoverage(temporalResolution, now, 48);
  if (coverage24 === null || coverage48 === null) {
    return {
      probability12h: derive12hFrom24hProbability(0.9),
      probability24h: 0.9,
      probability48h: 0.96,
      probability72h: derive72hFrom48hProbability(0.96),
    } satisfies ShadowProbabilityHorizons;
  }

  const probability24h = clamp(
    baseline.probability24h + coverage24 * (0.9 - baseline.probability24h),
    0,
    1,
  );
  const probability48h = clamp(
    baseline.probability48h + coverage48 * (0.96 - baseline.probability48h),
    probability24h,
    1,
  );
  return {
    probability12h: derive12hFrom24hProbability(probability24h),
    probability24h,
    probability48h,
    probability72h: Math.max(probability48h, derive72hFrom48hProbability(probability48h)),
  } satisfies ShadowProbabilityHorizons;
}

export function calculateRegimeElapsedProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
  modelOptions: RegimeElapsedModelOptions = {},
): RegimeElapsedProbabilityResult {
  const now = options.now ?? new Date();
  const localObservationSignals = options.localObservationSignals;
  const signalEvaluation: LocalSignalEvaluation = options.signalEvaluation ??
    getLocalSignalEvaluation(data, now, localObservationSignals, options.canonicalHistoryContext);
  const boundaries = getRecoveryResetEvents(
    data,
    now,
    options.staticHistory ?? LOCAL_RESET_HISTORY,
    options.canonicalHistoryContext,
  );
  const hazard = buildRegimeElapsedHazard(boundaries, now, modelOptions);
  const regime = calculateRegimeDiagnostics(boundaries, now, modelOptions);
  const mode = modelOptions.mode ?? "full";
  const latestRecoveryResetAt = boundaries.at(-1)?.resetAt ?? null;
  const latestRandomResetAt = boundaries.filter((boundary) => boundary.isRandom).at(-1)?.resetAt ?? null;
  const randomExecutionWindow = getLastRandomRecoveryResetWindow(
    data,
    now,
    options.staticHistory ?? LOCAL_RESET_HISTORY,
    options.canonicalHistoryContext,
  );
  const resetExecutionWindow = randomExecutionWindow &&
      getTimestamp(randomExecutionWindow.executionWindowEndAt) === getTimestamp(latestRecoveryResetAt)
    ? randomExecutionWindow
    : null;
  const elapsedHours = getElapsedAgeHours(boundaries, now.getTime());
  const resolvedOfficialNotice = options.activeOfficialNotice === undefined
    ? getActiveOfficialNotice(
        data,
        latestRecoveryResetAt ? new Date(latestRecoveryResetAt) : null,
        now,
        localObservationSignals,
        null,
        false,
        false,
        options.canonicalHistoryContext,
      )
    : options.activeOfficialNotice;
  const inputs = getShadowSignalInputs(
    data,
    now,
    signalEvaluation,
    latestRecoveryResetAt ? getTimestamp(latestRecoveryResetAt) : null,
    null,
    true,
    localObservationSignals,
    modelOptions.signalMultiplierConfig,
    resetExecutionWindow,
    options.canonicalHistoryContext,
  );
  const multipliers = calculateShadowSignalMultipliers(inputs, modelOptions.signalMultiplierConfig);
  const regimeMultiplier = mode === "elapsed-only" ? 1 : regime.regimeMultiplier;
  const baseline = makeHorizons(hazard, mode, elapsedHours, regimeMultiplier);
  const adjusted: ShadowProbabilityHorizons = {
    probability12h: applyOddsMultiplier(
      baseline.probability12h,
      multipliers.combinedAfterCap.probability24h,
    ),
    probability24h: applyOddsMultiplier(
      baseline.probability24h,
      multipliers.combinedAfterCap.probability24h,
    ),
    probability48h: applyOddsMultiplier(
      baseline.probability48h,
      multipliers.combinedAfterCap.probability48h,
    ),
    probability72h: applyOddsMultiplier(
      baseline.probability72h,
      multipliers.combinedAfterCap.probability48h,
    ),
  };
  const officialNoticeActive = Boolean(resolvedOfficialNotice);
  const officialNoticePredictions = applyOfficialNoticeTimingPolicy(
    baseline,
    resolvedOfficialNotice,
    now,
  );
  const officialNoticeOverride = {
    active: officialNoticeActive,
    probability12h: officialNoticePredictions?.probability12h ?? null,
    probability24h: officialNoticePredictions?.probability24h ?? null,
    probability48h: officialNoticePredictions?.probability48h ?? null,
    probability72h: officialNoticePredictions?.probability72h ?? null,
  };
  const modelVersion = modelOptions.modelVersion ?? (
    mode === "elapsed-only"
      ? ELAPSED_ONLY_MODEL_VERSION
      : REGIME_ELAPSED_FULL_MODEL_VERSION
  );
  const warnings: string[] = [];
  if (hazard.completedIntervalCount < 2) {
    warnings.push("Recovery-boundary intervals are sparse; treat this model as exploratory.");
  }

  return {
    modelVersion,
    calculatedAt: now.toISOString(),
    targetDefinition: REGIME_ELAPSED_TARGET_DEFINITION,
    predictions: officialNoticeActive
      ? officialNoticePredictions!
      : adjusted,
    baseline,
    confidence: {
      level: officialNoticeActive
        ? "high"
        : hazard.completedIntervalCount >= 30 && hazard.totalExposureDays >= 120
          ? "medium"
          : "low",
      reason: officialNoticeActive
        ? "An active official notice overrides the normal confidence tier."
        : "Confidence reflects recovery-boundary interval count and exposure; it does not gate publication.",
      completedIntervalCount: hazard.completedIntervalCount,
      totalExposureDays: hazard.totalExposureDays,
    },
    hazard,
    multipliers,
    officialNoticeOverride,
    warnings,
    regimeElapsed: {
      mode,
      binScheme: modelOptions.binScheme ?? REGIME_ELAPSED_SELECTED_BIN_SCHEME,
      priorExposureDays: hazard.priorExposureDays,
      regimeHalfLifeDays: regime.halfLifeDays,
      regimeRatioExponent: finitePositive(modelOptions.regimeRatioExponent, REGIME_ELAPSED_SELECTED_RATIO_EXPONENT),
      latestRandomResetAt,
      latestRecoveryResetAt,
      elapsedHours,
      regime,
      effectiveRegimeMultiplier: regimeMultiplier,
      bins: hazard.bins.map((bin) => ({ ...bin })),
      recoveryBoundaryCount: hazard.recoveryBoundaryCount,
      randomBoundaryCount: hazard.randomBoundaryCount,
      regularBoundaryCount: hazard.regularBoundaryCount,
      boundaryAudit: getRecoveryBoundaryAudit(
        data,
        now,
        options.staticHistory ?? LOCAL_RESET_HISTORY,
        options.canonicalHistoryContext,
      ),
      officialNoticeTimingPolicyVersion: OFFICIAL_NOTICE_TIMING_POLICY_VERSION,
    },
  };
}

export function getRegimeElapsedProbabilityWithoutSignals(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
  modelOptions: RegimeElapsedModelOptions = {},
) {
  const result = calculateRegimeElapsedProbability(data, {
    ...options,
    activeOfficialNotice: null,
    signalEvaluation: options.signalEvaluation,
  }, modelOptions);
  return result.baseline;
}
