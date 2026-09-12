import { RECENCY_SHADOW_MODEL_CONFIG } from "@/data/shadowProbabilityConfig";
import {
  calculateShadowProbabilityForModel,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
} from "./shadowProbability";
import type { RadarData } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export { RECENCY_SHADOW_MODEL_CONFIG };

export function getRecencyDecayWeight(ageDays: number, halfLifeDays: number) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError("half-life must be a finite positive number");
  }
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    throw new RangeError("ageDays must be a finite non-negative number");
  }
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

function getFixedModelConfig(halfLifeDays: number) {
  const model = RECENCY_SHADOW_MODEL_CONFIG.find(
    (candidate) => candidate.halfLifeDays === halfLifeDays,
  );
  if (!model) {
    throw new RangeError(`unsupported recency model half-life: ${halfLifeDays}`);
  }
  return model;
}

export function calculateRecencyWeightedShadowProbability(
  data: RadarData | null,
  halfLifeDays: number,
  options: ShadowProbabilityOptions = {},
): ShadowProbabilityResult {
  const model = getFixedModelConfig(halfLifeDays);
  const now = options.now ?? new Date();
  const nowTime = now.getTime();

  return calculateShadowProbabilityForModel(
    data,
    { ...options, now },
    {
      modelVersion: model.modelVersion,
      hazardOptions: {
        completedIntervalWeight: ({ currentTime }) =>
          getRecencyDecayWeight((nowTime - currentTime) / DAY_MS, model.halfLifeDays),
      },
      includeTeaserStrengthBoost: model.includeTeaserStrengthBoost,
    },
  );
}

export function calculateAllRecencyWeightedShadowProbabilities(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
) {
  return RECENCY_SHADOW_MODEL_CONFIG.map(({ halfLifeDays }) =>
    calculateRecencyWeightedShadowProbability(data, halfLifeDays, options),
  );
}
