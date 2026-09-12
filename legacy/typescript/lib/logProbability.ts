import {
  PUBLISHED_PROBABILITY_ADOPTION_DATE,
  PUBLISHED_PROBABILITY_ADOPTION_AT,
  PUBLISHED_PROBABILITY_ADOPTION_GATE_STATUS,
  PUBLISHED_PROBABILITY_ADOPTION_BOUNDARY_STATUS,
  PUBLISHED_PROBABILITY_CALIBRATION_TRAINING_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
  PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT,
  PUBLISHED_PROBABILITY_ADOPTION_MODE,
  PUBLISHED_ELAPSED_MODEL_OPTIONS,
  PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  CALIBRATED_SHADOW_MODEL_VERSION_V2,
  RECENCY_SHADOW_MODEL_CONFIG,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import type { RadarViewModel } from "@/lib/radar/types";
import type { ProbabilityCalculationAudit } from "@/lib/radar/probability";
import type { PublishedProbabilityCalculation } from "@/lib/radar/publishedProbability";
import type { PublishedV3FeatureSnapshot } from "@/lib/radar/publishedV3FeatureSnapshot";
import {
  calculateAllRecencyWeightedShadowProbabilities,
} from "@/lib/radar/recencyWeightedProbability";
import {
  calculateShadowProbability,
  calculateShadowProbabilityForModel,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
  type ShadowSignalMultipliers,
} from "@/lib/radar/shadowProbability";
import { calculateRegimeElapsedProbability } from "@/lib/radar/regimeElapsedProbability";
import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  calculateCalibratedShadowProbability,
  type CalibratedShadowProbabilityResult,
} from "@/lib/radar/calibratedShadowProbability";
import type {
  RegimeElapsedMode,
  RegimeElapsedProbabilityResult,
} from "@/lib/radar/regimeElapsedProbability";
import {
  calculateRandomElapsedProbability,
  type RandomElapsedProbabilityResult,
} from "@/lib/radar/randomElapsedProbability";
import {
  calculateRandomContinuousProbability,
  type RandomContinuousProbabilityResult,
} from "@/lib/radar/randomContinuousProbability";

export function hasOfficialNoticeForLog(
  viewModel: Pick<RadarViewModel, "activeWindow">,
) {
  return viewModel.activeWindow.active && viewModel.activeWindow.kind === "official";
}

export type ExperimentalProbabilityForecast = {
  modelVersion: string;
  generatedAt: string;
  probability12h?: number;
  probability24h: number;
  probability48h: number;
  probability72h?: number;
  halfLifeDays: number | null;
  completedEventCount: number;
  completedIntervalCount: number;
  weightedEventCount: number;
  weightedExposureDays: number;
  baseline12h?: number;
  baseline24h: number;
  baseline48h: number;
  baseline72h?: number;
  combinedSignalMultiplier24h: number;
  combinedSignalMultiplier48h: number;
  combinedSignalMultiplier72h?: number;
  officialNoticeOverride: boolean;
  targetDefinition: string;
  rawModelVersion?: string;
  rawProbability24h?: number;
  rawProbability48h?: number;
  alpha24h?: number;
  alpha48h?: number;
  calibrationSampleCount24h?: number;
  calibrationSampleCount48h?: number;
  positiveCalibrationCount24h?: number;
  positiveCalibrationCount48h?: number;
  calibrationTrainingModelVersion?: string;
  confidence?: "low" | "medium" | "high";
  confidenceReason?: string;
  calibrationApplied?: boolean;
  integrationStepHours?: number;
  experimentRole?: "control" | "challenger";
  featureSnapshot?: PublishedV3FeatureSnapshot;
  regimeMultiplierPolicyVersion?: string;
  priorStdDev?: number;
  minimumSamples?: number;
  lastResolvedOrigin24h?: string | null;
  lastResolvedOrigin48h?: string | null;
  horizonCoherenceAdjusted?: boolean;
  fallbackUsed?: boolean;
  evaluationMode?: "prospective";
  pointInTimeProjectionVersion?: string;
  pointInTimeProjectionLimitations?: string;
  regimeMultiplier?: number;
  effectiveRegimeMultiplier?: number;
  mode?: RegimeElapsedMode;
  recentRatePerDay?: number;
  longTermRatePerDay?: number;
  elapsedHoursSinceRecovery?: number;
  selectedBinScheme?: string;
  selectedPriorExposureDays?: number;
  selectedRegimeHalfLifeDays?: number;
  selectedRegimeRatioExponent?: number;
  elapsedHoursSinceRandom?: number;
  randomElapsedHours?: number;
  recoveryElapsedHours?: number;
  latestRandomResetAt?: string | null;
  latestRecoveryResetAt?: string | null;
  randomBoundaryCount?: number;
  regularBoundaryCount?: number;
  hazardBins?: Array<{
    startHour: number;
    endHour: number | null;
    exposureHours: number;
    observedEvents: number;
    posteriorLambdaPerHour: number;
    impliedDailyProbability: number;
  }>;
  estimator?: "piecewise" | "gaussian-kernel";
  kernelBandwidthHours?: number;
  kernelGridHours?: number;
  gridStepHours?: number;
  kernelTruncationHours?: number;
  priorExposureDays?: number;
  localPriorExposureDays?: number;
  localPriorWindowHours?: number;
  exposureCellCount?: number;
  instantaneousHazardPerHour?: number;
  instantaneousDailyProbability?: number;
  currentKernelWeightedEvents?: number;
  currentKernelWeightedExposureHours?: number;
  kernelType?: "gaussian";
  probeDailyProbabilities?: Array<{
    ageHours: number;
    dailyProbability: number;
  }>;
  freezeAt?: string;
  freezePolicy?: string;
  nextGenerationRole?: "candidate-a" | "candidate-b" | "candidate-c" | "candidate-c-v2";
  trainingReadStatus?: "ok" | "error";
  fallbackReason?: string | null;
  officialNoticeTimingPolicyVersion?: string;
  signalMultipliers?: ShadowSignalMultipliers;
  rawEnsembleProbability24h?: number;
  rawEnsembleProbability48h?: number;
  componentModelVersions?: readonly string[];
  componentProbabilities24h?: number[];
  componentProbabilities48h?: number[];
  componentLogitEpsilon?: number;
  weights24h?: number[];
  weights48h?: number[];
  alphaPriorStdDev?: number;
  weightPriorMean?: number;
  weightPriorStdDev?: number;
  trainingMode24h?: "equal" | "fitted" | "solver_failed";
  trainingMode48h?: "equal" | "fitted" | "solver_failed";
  trainingSampleCount24h?: number;
  trainingSampleCount48h?: number;
  positiveTrainingCount24h?: number;
  positiveTrainingCount48h?: number;
  fitCutoff24h?: string | null;
  fitCutoff48h?: string | null;
  solver24h?: {
    converged: boolean;
    iterations: number;
    objective: number | null;
    reason: string | null;
  };
  solver48h?: {
    converged: boolean;
    iterations: number;
    objective: number | null;
    reason: string | null;
  };
  randomResetCount72h?: number;
  previousRandomIntervalHours?: number | null;
  hourSin?: number;
  hourCos?: number;
  contextCoefficients?: {
    count72: number;
    previousInterval: number;
    hourSin: number;
    hourCos: number;
  };
  burstStats?: {
    count72Mean: number;
    count72StdDev: number;
    previousIntervalMean: number;
    previousIntervalStdDev: number;
  };
  contextTrainingEventCount?: number;
  contextExposureCellCount?: number;
  contextFallbackUsed?: boolean;
  contextFallbackReason?: string | null;
  contextSolver?: {
    converged: boolean;
    iterations: number;
    objective: number | null;
    reason: string | null;
  };
  effectiveContextMultiplier24h?: number;
  effectiveContextMultiplier48h?: number;
  ablations?: Record<string, {
    probability24h: number;
    probability48h: number;
  }>;
  normalizedAblations?: Record<string, {
    probability24h: number;
    probability48h: number;
  }>;
  circadianNormalizationConstant?: number | null;
  circadianCycleMeanBeforeNormalization?: number | null;
  circadianCycleMeanAfterNormalization?: number | null;
  circadianNormalizationFallbackReason?: string | null;
};

export type ExperimentalProbabilityForecasts = Record<string, ExperimentalProbabilityForecast>;

function toExperimentalProbabilityForecast(
  result: ShadowProbabilityResult,
  halfLifeDays: number | null,
): ExperimentalProbabilityForecast {
  return {
    modelVersion: result.modelVersion,
    generatedAt: result.calculatedAt,
    probability12h: result.predictions.probability12h,
    probability24h: result.predictions.probability24h,
    probability48h: result.predictions.probability48h,
    probability72h: result.predictions.probability72h,
    halfLifeDays,
    completedEventCount: result.hazard.completedEventCount,
    completedIntervalCount: result.hazard.completedIntervalCount,
    weightedEventCount: result.hazard.weightedEventCount,
    weightedExposureDays: result.hazard.weightedExposureHours / 24,
    baseline12h: result.baseline.probability12h,
    baseline24h: result.baseline.probability24h,
    baseline48h: result.baseline.probability48h,
    baseline72h: result.baseline.probability72h,
    combinedSignalMultiplier24h: result.multipliers.combinedAfterCap.probability24h,
    combinedSignalMultiplier48h: result.multipliers.combinedAfterCap.probability48h,
    combinedSignalMultiplier72h: result.multipliers.combinedAfterCap.probability48h,
    officialNoticeOverride: result.officialNoticeOverride.active,
    targetDefinition: result.targetDefinition,
  };
}

function toCalibratedExperimentalProbabilityForecast(
  result: CalibratedShadowProbabilityResult,
  raw: ShadowProbabilityResult,
): ExperimentalProbabilityForecast {
  return {
    modelVersion: result.modelVersion,
    generatedAt: result.calculatedAt,
    probability24h: result.probability24h,
    probability48h: result.probability48h,
    halfLifeDays: null,
    completedEventCount: raw.hazard.completedEventCount,
    completedIntervalCount: raw.hazard.completedIntervalCount,
    weightedEventCount: raw.hazard.weightedEventCount,
    weightedExposureDays: raw.hazard.weightedExposureHours / 24,
    baseline24h: raw.baseline.probability24h,
    baseline48h: raw.baseline.probability48h,
    combinedSignalMultiplier24h: raw.multipliers.combinedAfterCap.probability24h,
    combinedSignalMultiplier48h: raw.multipliers.combinedAfterCap.probability48h,
    officialNoticeOverride: result.officialNoticeOverride,
    targetDefinition: result.targetDefinition,
    rawModelVersion: result.rawModelVersion,
    rawProbability24h: result.rawProbability24h,
    rawProbability48h: result.rawProbability48h,
    alpha24h: result.alpha24h,
    alpha48h: result.alpha48h,
    calibrationSampleCount24h: result.calibrationSampleCount24h,
    calibrationSampleCount48h: result.calibrationSampleCount48h,
    positiveCalibrationCount24h: result.positiveCalibrationCount24h,
    positiveCalibrationCount48h: result.positiveCalibrationCount48h,
    priorStdDev: result.priorStdDev,
    minimumSamples: result.minimumSamples,
    lastResolvedOrigin24h: result.lastResolvedOrigin24h,
    lastResolvedOrigin48h: result.lastResolvedOrigin48h,
    horizonCoherenceAdjusted: result.horizonCoherenceAdjusted,
    fallbackUsed: result.fallbackUsed,
    evaluationMode: result.evaluationMode,
    pointInTimeProjectionVersion: result.pointInTimeProjectionVersion,
    pointInTimeProjectionLimitations: result.pointInTimeProjectionLimitations,
  };
}

function toRegimeElapsedExperimentalProbabilityForecast(
  result: RegimeElapsedProbabilityResult,
): ExperimentalProbabilityForecast {
  const forecast = toExperimentalProbabilityForecast(result, null);
  return {
    ...forecast,
    mode: result.regimeElapsed.mode,
    regimeMultiplier: result.regimeElapsed.regime.regimeMultiplier,
    effectiveRegimeMultiplier: result.regimeElapsed.effectiveRegimeMultiplier,
    recentRatePerDay: result.regimeElapsed.regime.recentRatePerDay,
    longTermRatePerDay: result.regimeElapsed.regime.longTermRatePerDay,
    elapsedHoursSinceRecovery: result.regimeElapsed.elapsedHours,
    selectedBinScheme: result.regimeElapsed.binScheme,
    selectedPriorExposureDays: result.regimeElapsed.priorExposureDays,
    selectedRegimeHalfLifeDays: result.regimeElapsed.regimeHalfLifeDays,
    selectedRegimeRatioExponent: result.regimeElapsed.regimeRatioExponent,
  };
}

function toRandomElapsedExperimentalProbabilityForecast(
  result: RandomElapsedProbabilityResult,
): ExperimentalProbabilityForecast {
  const forecast = toExperimentalProbabilityForecast(result, null);
  return {
    ...forecast,
    regimeMultiplier: result.randomElapsed.regime.regimeMultiplier,
    recentRatePerDay: result.randomElapsed.regime.recentRatePerDay,
    longTermRatePerDay: result.randomElapsed.regime.longTermRatePerDay,
    elapsedHoursSinceRecovery: result.randomElapsed.recoveryElapsedHours,
    elapsedHoursSinceRandom: result.randomElapsed.randomElapsedHours,
    randomElapsedHours: result.randomElapsed.randomElapsedHours,
    recoveryElapsedHours: result.randomElapsed.recoveryElapsedHours,
    latestRandomResetAt: result.randomElapsed.latestRandomResetAt,
    latestRecoveryResetAt: result.randomElapsed.latestRecoveryResetAt,
    randomBoundaryCount: result.randomElapsed.randomBoundaryCount,
    regularBoundaryCount: result.randomElapsed.regularBoundaryCount,
    hazardBins: result.randomElapsed.bins,
    selectedBinScheme: result.randomElapsed.binScheme,
    selectedPriorExposureDays: result.randomElapsed.priorExposureDays,
    selectedRegimeHalfLifeDays: result.randomElapsed.regimeHalfLifeDays,
    selectedRegimeRatioExponent: result.randomElapsed.regimeRatioExponent,
    freezeAt: result.randomElapsed.freezeAt,
    freezePolicy: result.randomElapsed.freezePolicy,
  };
}

export function toRandomContinuousExperimentalProbabilityForecast(
  result: RandomContinuousProbabilityResult,
): ExperimentalProbabilityForecast {
  const forecast = toExperimentalProbabilityForecast(result, null);
  return {
    ...forecast,
    estimator: "gaussian-kernel",
    mode: result.randomContinuous.mode,
    regimeMultiplier: result.randomContinuous.regimeMultiplier,
    effectiveRegimeMultiplier: result.randomContinuous.effectiveRegimeMultiplier,
    recentRatePerDay: result.randomContinuous.recentRatePerDay,
    longTermRatePerDay: result.randomContinuous.longTermRatePerDay,
    selectedBinScheme: result.randomContinuous.selectedBinScheme,
    selectedPriorExposureDays: result.randomContinuous.selectedPriorExposureDays,
    selectedRegimeHalfLifeDays: result.randomContinuous.selectedRegimeHalfLifeDays,
    selectedRegimeRatioExponent: result.randomContinuous.selectedRegimeRatioExponent,
    elapsedHoursSinceRecovery: result.randomContinuous.recoveryElapsedHours,
    elapsedHoursSinceRandom: result.randomContinuous.randomElapsedHours,
    randomElapsedHours: result.randomContinuous.randomElapsedHours,
    recoveryElapsedHours: result.randomContinuous.recoveryElapsedHours,
    latestRandomResetAt: result.randomContinuous.latestRandomResetAt,
    latestRecoveryResetAt: result.randomContinuous.latestRecoveryResetAt,
    randomBoundaryCount: result.randomContinuous.randomBoundaryCount,
    regularBoundaryCount: result.randomContinuous.regularBoundaryCount,
    kernelBandwidthHours: result.randomContinuous.bandwidthHours,
    kernelGridHours: result.randomContinuous.gridHours,
    gridStepHours: result.randomContinuous.gridStepHours,
    kernelTruncationHours: result.randomContinuous.truncationHours,
    priorExposureDays: result.randomContinuous.priorExposureDays,
    localPriorExposureDays: result.randomContinuous.localPriorExposureDays,
    localPriorWindowHours: result.randomContinuous.localPriorWindowHours,
    exposureCellCount: result.randomContinuous.exposureCellCount,
    instantaneousHazardPerHour: result.randomContinuous.instantaneousHazardPerHour,
    instantaneousDailyProbability: result.randomContinuous.instantaneousDailyProbability,
    currentKernelWeightedEvents: result.randomContinuous.currentKernelWeightedEvents,
    currentKernelWeightedExposureHours: result.randomContinuous.currentKernelWeightedExposureHours,
    kernelType: result.randomContinuous.kernelType,
    probeDailyProbabilities: result.randomContinuous.probeDailyProbabilities,
    freezeAt: result.randomContinuous.freezeAt,
    freezePolicy: result.randomContinuous.freezePolicy,
  };
}

export function buildExperimentalProbabilityForecasts(
  data: Parameters<typeof calculateShadowProbability>[0],
  options: ShadowProbabilityOptions & {
    shadowProbability?: ShadowProbabilityResult | null;
    calibratedProbability?: CalibratedShadowProbabilityResult | null;
  } = {},
): ExperimentalProbabilityForecasts {
  const { shadowProbability, calibratedProbability, ...calculationOptions } = options;
  const v2 = shadowProbability ?? calculateShadowProbability(data, calculationOptions);
  const elapsedOnly = calculateRegimeElapsedProbability(
    data,
    calculationOptions,
    PUBLISHED_ELAPSED_MODEL_OPTIONS,
  );
  const regimeElapsed = calculateRegimeElapsedProbability(
    data,
    calculationOptions,
    PUBLISHED_REGIME_ELAPSED_MODEL_OPTIONS,
  );
  const randomElapsed = calculateRandomElapsedProbability(data, calculationOptions, {}, regimeElapsed);
  const randomContinuous = calculateRandomContinuousProbability(data, calculationOptions, regimeElapsed);
  const recencyResults = calculateAllRecencyWeightedShadowProbabilities(data, calculationOptions);
  const calibrated = calibratedProbability ?? calculateCalibratedShadowProbability(data, {
    ...calculationOptions,
    shadowProbability: v2,
  });
  const previousRaw = calculateShadowProbabilityForModel(data, calculationOptions, {
    includeTeaserStrengthBoost: false,
    legacyOfficialNoticeOverride: true,
  });
  const previousCalibrated = calculateCalibratedShadowProbability(data, {
    ...calculationOptions,
    shadowProbability: previousRaw,
    modelVersion: CALIBRATED_SHADOW_MODEL_VERSION_V2,
    includeTeaserStrengthBoost: false,
    legacyOfficialNoticeOverride: true,
  });
  const forecasts: ExperimentalProbabilityForecasts = {
    [SHADOW_PROBABILITY_MODEL_VERSION]: toExperimentalProbabilityForecast(v2, null),
  };
  for (const result of recencyResults) {
    const halfLifeDays = RECENCY_SHADOW_MODEL_CONFIG.find(
      (model) => model.modelVersion === result.modelVersion,
    )?.halfLifeDays ?? null;
    forecasts[result.modelVersion] = toExperimentalProbabilityForecast(result, halfLifeDays);
  }
  forecasts[elapsedOnly.modelVersion] = toRegimeElapsedExperimentalProbabilityForecast(elapsedOnly);
  forecasts[regimeElapsed.modelVersion] = toRegimeElapsedExperimentalProbabilityForecast(regimeElapsed);
  forecasts[randomElapsed.modelVersion] = toRandomElapsedExperimentalProbabilityForecast(randomElapsed);
  forecasts[randomContinuous.modelVersion] = toRandomContinuousExperimentalProbabilityForecast(randomContinuous);
  forecasts[CALIBRATED_SHADOW_MODEL_VERSION] = toCalibratedExperimentalProbabilityForecast(calibrated, v2);
  forecasts[CALIBRATED_SHADOW_MODEL_VERSION_V2] = toCalibratedExperimentalProbabilityForecast(previousCalibrated, previousRaw);
  return forecasts;
}

export function buildProbabilityDebugInfo(
  base: Record<string, unknown>,
  calculation: ProbabilityCalculationAudit,
  generatedAt: string | null | undefined,
  calculatedAt: Date,
  shadowProbability?: ShadowProbabilityResult | null,
  publishedProbability?: PublishedProbabilityCalculation,
  experimentalProbabilityForecasts?: ExperimentalProbabilityForecasts,
) {
  const calculatedAtIso = calculatedAt.toISOString();
  const rawShadow = publishedProbability?.rawShadow ?? publishedProbability?.shadow ?? null;
  const publishedB = publishedProbability?.nextGenerationB ?? null;
  const publishedConfidence = publishedB?.randomContinuousResult.confidence ?? rawShadow?.confidence ?? null;

  return {
    ...base,
    generated_at: generatedAt ?? null,
    calculated_at: calculatedAtIso,
    probabilityModel: {
      version: calculation.modelVersion,
      generatedAt: generatedAt ?? null,
      calculatedAt: calculatedAtIso,
      inputs: calculation.inputSnapshot,
      breakdown: calculation.breakdown,
    },
    ...(shadowProbability
      ? { shadowProbabilityModel: shadowProbability }
      : {}),
    ...(publishedProbability
      ? {
          publishedProbabilityModel: {
            version: publishedProbability.adoptedModel,
            source: publishedProbability.source,
            probability12h: publishedProbability.probability12h,
            probability24h: publishedProbability.probability24h,
            probability48h: publishedProbability.probability48h,
            probability72h: publishedProbability.probability72h,
            fallbackReason: publishedProbability.fallbackReason,
            confidence: publishedConfidence?.level ?? null,
            completedIntervalCount: publishedConfidence?.completedIntervalCount ?? null,
            totalExposureDays: publishedConfidence?.totalExposureDays ?? null,
            adoptionMode: PUBLISHED_PROBABILITY_ADOPTION_MODE,
            adoptionDate: PUBLISHED_PROBABILITY_ADOPTION_DATE,
            adoptionAt: PUBLISHED_PROBABILITY_ADOPTION_AT,
            previousModelVersion: PUBLISHED_PROBABILITY_PREVIOUS_MODEL_VERSION,
            previousAdoptionAt: PUBLISHED_PROBABILITY_PREVIOUS_ADOPTION_AT,
            adoptionGateStatus: PUBLISHED_PROBABILITY_ADOPTION_GATE_STATUS,
            adoptionBoundaryStatus: PUBLISHED_PROBABILITY_ADOPTION_BOUNDARY_STATUS,
            rawModelVersion: publishedB?.rawModelVersion ?? rawShadow?.modelVersion ?? null,
            calibratedFallbackUsed: publishedB?.fallbackUsed ?? publishedProbability.calibrated?.fallbackUsed ?? null,
            calibrationAlpha24h: publishedB?.alpha24h ?? publishedProbability.calibrated?.alpha24h ?? null,
            calibrationAlpha48h: publishedB?.alpha48h ?? publishedProbability.calibrated?.alpha48h ?? null,
            calibrationSampleCount24h: publishedB?.calibrationSampleCount24h ?? publishedProbability.calibrated?.calibrationSampleCount24h ?? null,
            calibrationSampleCount48h: publishedB?.calibrationSampleCount48h ?? publishedProbability.calibrated?.calibrationSampleCount48h ?? null,
            positiveCalibrationCount24h: publishedB?.positiveCalibrationCount24h ?? publishedProbability.calibrated?.positiveCalibrationCount24h ?? null,
            positiveCalibrationCount48h: publishedB?.positiveCalibrationCount48h ?? publishedProbability.calibrated?.positiveCalibrationCount48h ?? null,
            trainingReadStatus: publishedB?.trainingReadStatus ?? null,
            modelFallbackReason: publishedB?.fallbackReason ?? null,
            calibrationTrainingModelVersion:
              publishedB?.calibrationTrainingModelVersion
              ?? PUBLISHED_PROBABILITY_CALIBRATION_TRAINING_MODEL_VERSION,
            regimeMultiplierPolicyVersion:
              publishedB?.regimeMultiplierPolicyVersion ?? null,
            majorModelReleaseAdjustment: publishedProbability.majorModelReleaseAdjustment,
          },
        }
      : {}),
    ...(experimentalProbabilityForecasts
      ? { experimentalProbabilityForecasts }
      : {}),
  };
}
