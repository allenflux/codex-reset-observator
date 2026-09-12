import {
  CALIBRATED_SHADOW_MODEL_VERSION,
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION,
  NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
  NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_FREEZE_POLICY,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
  RECENCY_H30_PROBABILITY_MODEL_VERSION,
  REGIME_ELAPSED_FULL_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import type {
  ExperimentalProbabilityForecast,
  ExperimentalProbabilityForecasts,
} from "./logProbability";
import {
  toRandomContinuousExperimentalProbabilityForecast,
} from "./logProbability";
import {
  calculateNextGenerationAEnsemble,
  type NextGenerationAResult,
  type NextGenerationComponentForecast,
} from "./radar/nextGenerationEnsemble";
import {
  calculateNextGenerationBPostResetAgeCandidate,
  calculateNextGenerationBProbability,
  calculateNextGenerationSelectiveCalibrationProbability,
  type NextGenerationBResult,
} from "./radar/nextGenerationProbability";
import {
  calculateContextualBurstProbability,
  calculateNormalizedContextualBurstProbability,
  type ContextualBurstProbabilityResult,
} from "./radar/contextualBurstProbability";
import type { NextGenerationTrainingState } from "./radar/nextGenerationTraining";
import type { RadarData } from "./radar/types";
import { buildPublishedV3FeatureSnapshot } from "./radar/publishedV3FeatureSnapshot";
import type { ShadowProbabilityOptions } from "./radar/shadowProbability";
import {
  calculateRandomContinuousBandwidthShadowPair,
} from "./radar/randomContinuousBandwidthShadow";

function toCommonForecast(result: NextGenerationBResult): ExperimentalProbabilityForecast {
  const random = result.randomContinuousResult;
  const randomAudit = result.randomContinuous;
  const hazard = random.hazard;
  return {
    modelVersion: result.modelVersion,
    generatedAt: result.calculatedAt,
    probability12h: result.predictions.probability12h,
    probability24h: result.predictions.probability24h,
    probability48h: result.predictions.probability48h,
    probability72h: result.predictions.probability72h,
    halfLifeDays: null,
    completedEventCount: hazard.completedEventCount,
    completedIntervalCount: hazard.completedIntervalCount,
    weightedEventCount: hazard.weightedEventCount,
    weightedExposureDays: hazard.weightedExposureHours / 24,
    baseline12h: random.baseline.probability12h,
    baseline24h: random.baseline.probability24h,
    baseline48h: random.baseline.probability48h,
    baseline72h: random.baseline.probability72h,
    combinedSignalMultiplier24h: random.multipliers.combinedAfterCap.probability24h,
    combinedSignalMultiplier48h: random.multipliers.combinedAfterCap.probability48h,
    combinedSignalMultiplier72h: random.multipliers.combinedAfterCap.probability48h,
    officialNoticeOverride: result.officialNoticeOverride.active,
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
    calibrationTrainingModelVersion: result.calibrationTrainingModelVersion,
    regimeMultiplierPolicyVersion: result.regimeMultiplierPolicyVersion,
    priorStdDev: 0.5,
    minimumSamples: 10,
    lastResolvedOrigin24h: result.lastResolvedOrigin24h,
    lastResolvedOrigin48h: result.lastResolvedOrigin48h,
    horizonCoherenceAdjusted: result.horizonCoherenceAdjusted,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
    trainingReadStatus: result.trainingReadStatus,
    evaluationMode: "prospective",
    officialNoticeTimingPolicyVersion: result.officialNoticeTimingPolicyVersion,
    signalMultipliers: random.multipliers,
    mode: randomAudit.mode,
    regimeMultiplier: randomAudit.regimeMultiplier,
    effectiveRegimeMultiplier: randomAudit.effectiveRegimeMultiplier,
    recentRatePerDay: randomAudit.recentRatePerDay,
    longTermRatePerDay: randomAudit.longTermRatePerDay,
    elapsedHoursSinceRecovery: randomAudit.recoveryElapsedHours,
    elapsedHoursSinceRandom: randomAudit.randomElapsedHours,
    randomElapsedHours: randomAudit.randomElapsedHours,
    recoveryElapsedHours: randomAudit.recoveryElapsedHours,
    latestRandomResetAt: randomAudit.latestRandomResetAt,
    latestRecoveryResetAt: randomAudit.latestRecoveryResetAt,
    randomBoundaryCount: randomAudit.randomBoundaryCount,
    regularBoundaryCount: randomAudit.regularBoundaryCount,
    estimator: "gaussian-kernel",
    kernelBandwidthHours: randomAudit.bandwidthHours,
    kernelGridHours: randomAudit.gridHours,
    gridStepHours: randomAudit.gridStepHours,
    kernelTruncationHours: randomAudit.truncationHours,
    priorExposureDays: randomAudit.priorExposureDays,
    localPriorExposureDays: randomAudit.localPriorExposureDays,
    localPriorWindowHours: randomAudit.localPriorWindowHours,
    exposureCellCount: randomAudit.exposureCellCount,
    instantaneousHazardPerHour: randomAudit.instantaneousHazardPerHour,
    instantaneousDailyProbability: randomAudit.instantaneousDailyProbability,
    currentKernelWeightedEvents: randomAudit.currentKernelWeightedEvents,
    currentKernelWeightedExposureHours: randomAudit.currentKernelWeightedExposureHours,
    kernelType: randomAudit.kernelType,
    probeDailyProbabilities: randomAudit.probeDailyProbabilities,
    freezeAt: result.freezeAt,
    freezePolicy: result.freezePolicy,
    nextGenerationRole: "candidate-b",
  };
}

function toRawBandwidthForecast(
  result: ReturnType<typeof calculateRandomContinuousBandwidthShadowPair>["control"],
  experimentRole: "control" | "challenger",
): ExperimentalProbabilityForecast {
  const forecast = toRandomContinuousExperimentalProbabilityForecast(result);
  return {
    ...forecast,
    confidence: result.confidence.level,
    confidenceReason: result.confidence.reason,
    calibrationApplied: false,
    integrationStepHours: result.randomContinuous.integrationStepHours,
    regimeMultiplierPolicyVersion: NEXT_GENERATION_B_POST_RESET_AGE_POLICY_VERSION,
    evaluationMode: "prospective",
    experimentRole,
    freezeAt: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
    freezePolicy: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
  };
}

function isValidBResult(result: NextGenerationBResult) {
  return [
    result.rawProbability24h,
    result.rawProbability48h,
    result.predictions.probability12h,
    result.predictions.probability24h,
    result.predictions.probability48h,
    result.predictions.probability72h,
  ].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && result.predictions.probability48h >= result.predictions.probability24h;
}

function isValidCResult(result: ContextualBurstProbabilityResult) {
  return [
    result.rawProbability24h,
    result.rawProbability48h,
    result.probability12h,
    result.probability24h,
    result.probability48h,
    result.probability72h,
  ].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && result.probability48h >= result.probability24h;
}

function toContextualBurstForecast(
  result: ContextualBurstProbabilityResult,
  role: "candidate-c" | "candidate-c-v2" = "candidate-c",
) {
  const fit = result.contextFit;
  const forecast = {
    modelVersion: result.modelVersion,
    generatedAt: result.calculatedAt,
    probability12h: result.probability12h,
    probability24h: result.probability24h,
    probability48h: result.probability48h,
    probability72h: result.probability72h,
    halfLifeDays: null,
    // C-specific context-fit counts are intentionally separate from the common
    // historical hazard fields; these common values are conservative audit placeholders.
    completedEventCount: fit.trainingEventCount,
    completedIntervalCount: fit.trainingEventCount,
    weightedEventCount: fit.trainingEventCount,
    weightedExposureDays: fit.exposureCellCount / 24,
    baseline24h: result.baseProbability24h,
    baseline48h: result.baseProbability48h,
    combinedSignalMultiplier24h: result.multipliers.combinedAfterCap.probability24h,
    combinedSignalMultiplier48h: result.multipliers.combinedAfterCap.probability48h,
    officialNoticeOverride: result.officialNoticeOverride.active,
    targetDefinition: result.targetDefinition,
    rawModelVersion: result.modelVersion,
    rawProbability24h: result.rawProbability24h,
    rawProbability48h: result.rawProbability48h,
    alpha24h: result.alpha24h,
    alpha48h: result.alpha48h,
    calibrationSampleCount24h: result.calibrationSampleCount24h,
    calibrationSampleCount48h: result.calibrationSampleCount48h,
    positiveCalibrationCount24h: result.positiveCalibrationCount24h,
    positiveCalibrationCount48h: result.positiveCalibrationCount48h,
    priorStdDev: 0.5,
    minimumSamples: 10,
    lastResolvedOrigin24h: result.lastResolvedOrigin24h,
    lastResolvedOrigin48h: result.lastResolvedOrigin48h,
    horizonCoherenceAdjusted: result.horizonCoherenceAdjusted,
    fallbackUsed: result.calibrationFallbackUsed || fit.fallbackUsed,
    fallbackReason: result.calibrationFallbackReason ?? fit.fallbackReason,
    trainingReadStatus: result.trainingReadStatus,
    evaluationMode: "prospective" as const,
    officialNoticeTimingPolicyVersion: result.officialNoticeTimingPolicyVersion,
    signalMultipliers: result.multipliers,
    randomElapsedHours: result.randomElapsedHours,
    elapsedHoursSinceRandom: result.randomElapsedHours,
    latestRandomResetAt: result.latestRandomResetAt,
    latestRecoveryResetAt: result.latestRecoveryResetAt,
    estimator: "gaussian-kernel" as const,
    instantaneousHazardPerHour: result.baseInstantaneousHazardPerHour,
    freezeAt: result.freezeAt,
    freezePolicy: result.freezePolicy,
    nextGenerationRole: role,
    randomResetCount72h: result.originFeatures.randomResetCount72h,
    previousRandomIntervalHours: result.originFeatures.previousRandomIntervalHours,
    hourSin: result.originFeatures.hourSin,
    hourCos: result.originFeatures.hourCos,
    contextCoefficients: fit.coefficients,
    burstStats: fit.burstStats,
    contextTrainingEventCount: fit.trainingEventCount,
    contextExposureCellCount: fit.exposureCellCount,
    contextFallbackUsed: fit.fallbackUsed,
    contextFallbackReason: fit.fallbackReason,
    contextSolver: fit.solver,
    effectiveContextMultiplier24h: result.effectiveContextMultiplier24h,
    effectiveContextMultiplier48h: result.effectiveContextMultiplier48h,
    ablations: result.ablations,
    ...(result.normalizedAblations
      ? {
          normalizedAblations: result.normalizedAblations,
          circadianNormalizationConstant: result.circadianNormalizationConstant,
          circadianCycleMeanBeforeNormalization: result.circadianCycleMeanBeforeNormalization,
          circadianCycleMeanAfterNormalization: result.circadianCycleMeanAfterNormalization,
          circadianNormalizationFallbackReason: result.circadianNormalizationFallbackReason,
        }
      : {}),
  };
  // Keep candidate-C audit fields optional so legacy stored forecasts remain valid.
  return forecast as unknown as ExperimentalProbabilityForecast;
}

function toEnsembleForecast(
  result: NextGenerationAResult,
  bResult: NextGenerationBResult,
): ExperimentalProbabilityForecast {
  const random = bResult.randomContinuousResult;
  const hazard = random.hazard;
  return {
    modelVersion: result.modelVersion,
    generatedAt: result.generatedAt,
    probability12h: result.probability12h,
    probability24h: result.probability24h,
    probability48h: result.probability48h,
    probability72h: result.probability72h,
    halfLifeDays: null,
    completedEventCount: hazard.completedEventCount,
    completedIntervalCount: hazard.completedIntervalCount,
    weightedEventCount: hazard.weightedEventCount,
    weightedExposureDays: hazard.weightedExposureHours / 24,
    baseline12h: result.rawProbability24h,
    baseline24h: result.rawProbability24h,
    baseline48h: result.rawProbability48h,
    baseline72h: result.rawProbability48h,
    combinedSignalMultiplier24h: 1,
    combinedSignalMultiplier48h: 1,
    combinedSignalMultiplier72h: 1,
    officialNoticeOverride: false,
    targetDefinition: bResult.targetDefinition,
    rawModelVersion: NEXT_GENERATION_A_MODEL_VERSION,
    rawProbability24h: result.rawProbability24h,
    rawProbability48h: result.rawProbability48h,
    alpha24h: result.alpha24h,
    alpha48h: result.alpha48h,
    calibrationSampleCount24h: result.trainingSampleCount24h,
    calibrationSampleCount48h: result.trainingSampleCount48h,
    positiveCalibrationCount24h: result.positiveTrainingCount24h,
    positiveCalibrationCount48h: result.positiveTrainingCount48h,
    priorStdDev: result.regularization.alphaPriorStdDev,
    minimumSamples: 10,
    lastResolvedOrigin24h: result.fitCutoff24h,
    lastResolvedOrigin48h: result.fitCutoff48h,
    horizonCoherenceAdjusted: result.horizonCoherenceAdjusted,
    fallbackUsed: false,
    evaluationMode: "prospective",
    componentModelVersions: result.componentModelVersions,
    componentProbabilities24h: result.componentProbabilities24h,
    componentProbabilities48h: result.componentProbabilities48h,
    componentLogitEpsilon: result.componentLogitEpsilon,
    weights24h: result.weights24h,
    weights48h: result.weights48h,
    alphaPriorStdDev: result.regularization.alphaPriorStdDev,
    weightPriorMean: result.regularization.weightPriorMean,
    weightPriorStdDev: result.regularization.weightPriorStdDev,
    trainingMode24h: result.trainingMode24h,
    trainingMode48h: result.trainingMode48h,
    trainingSampleCount24h: result.trainingSampleCount24h,
    trainingSampleCount48h: result.trainingSampleCount48h,
    positiveTrainingCount24h: result.positiveTrainingCount24h,
    positiveTrainingCount48h: result.positiveTrainingCount48h,
    fitCutoff24h: result.fitCutoff24h,
    fitCutoff48h: result.fitCutoff48h,
    solver24h: result.solver24h,
    solver48h: result.solver48h,
    freezeAt: result.freezeAt,
    freezePolicy: result.freezePolicy,
    nextGenerationRole: "candidate-a",
  };
}

function getComponentForecast(
  forecasts: ExperimentalProbabilityForecasts,
  modelVersion: string,
): NextGenerationComponentForecast | null {
  const forecast = forecasts[modelVersion];
  if (!forecast || forecast.modelVersion !== modelVersion) return null;
  if (!Number.isFinite(forecast.probability24h) || !Number.isFinite(forecast.probability48h)) return null;
  return {
    modelVersion,
    probability24h: forecast.probability24h,
    probability48h: forecast.probability48h,
  };
}

export type NextGenerationShadowBuildOptions = {
  data: RadarData | null;
  calculationOptions: ShadowProbabilityOptions;
  existingForecasts: ExperimentalProbabilityForecasts;
  trainingState: NextGenerationTrainingState;
};

export function buildNextGenerationExperimentalProbabilityForecasts(
  options: NextGenerationShadowBuildOptions,
): ExperimentalProbabilityForecasts {
  const generatedAt = options.calculationOptions.now ?? new Date();
  if (generatedAt.getTime() < new Date(NEXT_GENERATION_FREEZE_AT).getTime()) {
    return options.existingForecasts;
  }

  const bCalculationOptions = {
    ...options.calculationOptions,
    trainingRows: options.trainingState.bRows,
    trainingReadStatus: options.trainingState.status,
  };
  const bResult = calculateNextGenerationBProbability(options.data, bCalculationOptions);
  const bValid = isValidBResult(bResult);
  const withB: ExperimentalProbabilityForecasts = bValid
    ? {
        ...options.existingForecasts,
        [NEXT_GENERATION_B_MODEL_VERSION]: toCommonForecast(bResult),
      }
    : options.existingForecasts;
  const postResetAgeResult = calculateNextGenerationBPostResetAgeCandidate(
    options.data,
    bCalculationOptions,
  );
  const postResetAgeValid = isValidBResult(postResetAgeResult);
  const withBVariants: ExperimentalProbabilityForecasts = postResetAgeValid
    ? {
        ...withB,
        [NEXT_GENERATION_B_POST_RESET_AGE_MODEL_VERSION]: toCommonForecast(postResetAgeResult),
      }
    : withB;
  const selectiveCalibrationResult = calculateNextGenerationSelectiveCalibrationProbability(
    options.data,
    bCalculationOptions,
  );
  const selectiveCalibrationValid = isValidBResult(selectiveCalibrationResult);
  const withAllBVariants: ExperimentalProbabilityForecasts = selectiveCalibrationValid
    ? {
        ...withBVariants,
        [NEXT_GENERATION_SELECTIVE_CALIBRATION_MODEL_VERSION]: {
          ...toCommonForecast(selectiveCalibrationResult),
          featureSnapshot: buildPublishedV3FeatureSnapshot(
            options.data,
            new Date(selectiveCalibrationResult.calculatedAt),
          ),
        },
      }
    : withBVariants;

  let withA = withAllBVariants;
  if (bValid) {
    const components = Object.fromEntries(
      NEXT_GENERATION_A_COMPONENT_VERSIONS.map((modelVersion) => {
        const component = modelVersion === NEXT_GENERATION_B_MODEL_VERSION
          ? getComponentForecast(withB, NEXT_GENERATION_B_MODEL_VERSION)
          : getComponentForecast(options.existingForecasts, modelVersion);
        return [modelVersion, component];
      }),
    );
    if (!Object.values(components).some((component) => component === null)) {
      const aResult = calculateNextGenerationAEnsemble(
        components as Record<string, NextGenerationComponentForecast>,
        {
          generatedAt: bResult.calculatedAt,
          trainingRows: options.trainingState.aRows,
          trainingReadStatus: options.trainingState.status,
        },
      );
      if (aResult) {
        withA = {
          ...withAllBVariants,
          [NEXT_GENERATION_A_MODEL_VERSION]: toEnsembleForecast(aResult, bResult),
        };
      }
    }
  }

  let withBandwidthExperiment = withA;
  if (generatedAt.getTime() >= new Date(RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT).getTime()) {
    const pair = calculateRandomContinuousBandwidthShadowPair(
      options.data,
      options.calculationOptions,
    );
    withBandwidthExperiment = {
      ...withA,
      [RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION]: toRawBandwidthForecast(
        pair.control,
        "control",
      ),
      [RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION]: toRawBandwidthForecast(
        pair.challenger,
        "challenger",
      ),
    };
  }

  if (generatedAt.getTime() < new Date(NEXT_GENERATION_C_FREEZE_AT).getTime()) {
    return withBandwidthExperiment;
  }
  let withC = withBandwidthExperiment;
  const cResult = calculateContextualBurstProbability(options.data, {
    ...options.calculationOptions,
    trainingRows: options.trainingState.cRows,
    trainingReadStatus: options.trainingState.status,
  });
  if (isValidCResult(cResult)) {
    withC = {
      ...withBandwidthExperiment,
      [NEXT_GENERATION_C_MODEL_VERSION]: toContextualBurstForecast(cResult),
    };
  }
  if (generatedAt.getTime() < new Date(NEXT_GENERATION_C_V2_FREEZE_AT).getTime()) {
    return withC;
  }
  const cV2Result = calculateNormalizedContextualBurstProbability(options.data, {
    ...options.calculationOptions,
    trainingRows: options.trainingState.cV2Rows,
    trainingReadStatus: options.trainingState.status,
  });
  if (!isValidCResult(cV2Result)) return withC;
  return {
    ...withC,
    [NEXT_GENERATION_C_V2_MODEL_VERSION]: toContextualBurstForecast(cV2Result, "candidate-c-v2"),
  };
}
