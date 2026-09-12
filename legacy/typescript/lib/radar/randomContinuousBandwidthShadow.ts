import {
  NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
  NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
  RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
} from "@/data/shadowProbabilityConfig";
import type { RadarData } from "./types";
import {
  calculateRegimeElapsedProbability,
  type RegimeElapsedProbabilityResult,
} from "./regimeElapsedProbability";
import {
  calculateRandomContinuousProbability,
  type RandomContinuousProbabilityResult,
} from "./randomContinuousProbability";
import type { ShadowProbabilityOptions } from "./shadowProbability";

export type RandomBandwidthTruncationShadowPair = {
  control: RandomContinuousProbabilityResult;
  challenger: RandomContinuousProbabilityResult;
};

function withExperimentIdentity(
  result: RandomContinuousProbabilityResult,
  modelVersion: string,
): RandomContinuousProbabilityResult {
  return {
    ...result,
    modelVersion,
    randomContinuous: {
      ...result.randomContinuous,
      freezeAt: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_AT,
      freezePolicy: RANDOM_BANDWIDTH_TRUNCATION_SHADOW_FREEZE_POLICY,
    },
  };
}

export function calculateRandomContinuousBandwidthShadowPair(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
  precomputedRecoveryResult?: RegimeElapsedProbabilityResult,
): RandomBandwidthTruncationShadowPair {
  const { now: requestedNow, ...optionsWithoutNow } = options;
  const calculationNow = requestedNow ?? new Date();
  const sharedOptions: ShadowProbabilityOptions = {
    ...optionsWithoutNow,
    now: calculationNow,
  };
  const regimeResult = precomputedRecoveryResult ?? calculateRegimeElapsedProbability(
    data,
    sharedOptions,
    {
      ...NEXT_GENERATION_B_FROZEN_REGIME_CONFIG,
      modelVersion: "hazard-regime-elapsed-v1",
      mode: "full",
      signalMultiplierConfig: NEXT_GENERATION_B_FROZEN_SIGNAL_CONFIG,
    },
  );

  const control = calculateRandomContinuousProbability(
    data,
    sharedOptions,
    regimeResult,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_OPTIONS,
  );
  const challenger = calculateRandomContinuousProbability(
    data,
    sharedOptions,
    regimeResult,
    RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_OPTIONS,
  );

  return {
    control: withExperimentIdentity(
      control,
      RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CONTROL_MODEL_VERSION,
    ),
    challenger: withExperimentIdentity(
      challenger,
      RANDOM_BANDWIDTH_TRUNCATION_SHADOW_CHALLENGER_MODEL_VERSION,
    ),
  };
}
