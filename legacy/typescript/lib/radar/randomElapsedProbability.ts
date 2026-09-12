import {
  RANDOM_ELAPSED_SHADOW_FREEZE_AT,
  RANDOM_ELAPSED_SHADOW_FREEZE_POLICY,
  RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
  RANDOM_ELAPSED_SHADOW_TARGET_DEFINITION,
  REGIME_ELAPSED_SELECTED_BIN_SCHEME,
  REGIME_ELAPSED_SELECTED_RATIO_EXPONENT,
} from "@/data/shadowProbabilityConfig";
import type { RadarData } from "./types";
import {
  buildRegimeElapsedHazard,
  calculateRegimeElapsedProbability,
  calculateRegimeDiagnostics,
  getRegimeElapsedHazardAtAge,
  integrateRegimeElapsedHazard,
  type RegimeElapsedHazard,
  type RegimeElapsedModelOptions,
  type RegimeElapsedProbabilityResult,
} from "./regimeElapsedProbability";
import {
  getRecoveryBoundaryAudit,
  getRecoveryResetEvents,
  type RecoveryResetBoundary,
} from "./recoveryBoundary";
import {
  applyOddsMultiplier,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
} from "./shadowProbability";

const HOUR_MS = 60 * 60 * 1000;

export type RandomElapsedAudit = {
  clock: "random";
  mode: RegimeElapsedModelOptions["mode"];
  binScheme: "A" | "B";
  priorExposureDays: number;
  regimeHalfLifeDays: number;
  regimeRatioExponent: number;
  latestRandomResetAt: string | null;
  latestRecoveryResetAt: string | null;
  randomElapsedHours: number;
  recoveryElapsedHours: number;
  regime: ReturnType<typeof calculateRegimeDiagnostics>;
  bins: Array<RegimeElapsedHazard["bins"][number]>;
  recoveryBoundaryCount: number;
  randomBoundaryCount: number;
  regularBoundaryCount: number;
  boundaryAudit: ReturnType<typeof getRecoveryBoundaryAudit>;
  officialNoticeTimingPolicyVersion: string;
  freezeAt: string;
  freezePolicy: string;
};

export type RandomElapsedProbabilityResult = ShadowProbabilityResult & {
  randomElapsed: RandomElapsedAudit;
};

function getTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function getElapsedHours(boundaries: RecoveryResetBoundary[], now: Date) {
  const latest = boundaries.at(-1);
  const latestTime = getTimestamp(latest?.resetAt);
  return latestTime === null
    ? 0
    : Math.max(0, (now.getTime() - latestTime) / HOUR_MS);
}

export function getRandomElapsedBoundaries(boundaries: RecoveryResetBoundary[]) {
  return boundaries.filter((boundary) => boundary.isRandom);
}

export function buildRandomElapsedHazard(
  boundaries: RecoveryResetBoundary[],
  now: Date,
  options: Pick<RegimeElapsedModelOptions, "binScheme" | "priorExposureDays"> = {},
) {
  return buildRegimeElapsedHazard(getRandomElapsedBoundaries(boundaries), now, options);
}

function getBaseProbability(
  hazard: RegimeElapsedHazard,
  mode: RegimeElapsedModelOptions["mode"],
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
  mode: RegimeElapsedModelOptions["mode"],
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

function makeRandomHazardConfidence(
  hazard: RegimeElapsedHazard,
  officialNoticeActive: boolean,
) {
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

export function calculateRandomElapsedProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
  modelOptions: RegimeElapsedModelOptions = {},
  precomputedRecoveryResult?: RegimeElapsedProbabilityResult,
): RandomElapsedProbabilityResult {
  const now = options.now ?? new Date();
  const recoveryResult = precomputedRecoveryResult ?? calculateRegimeElapsedProbability(data, options, modelOptions);
  const boundaries = getRecoveryResetEvents(
    data,
    now,
    options.staticHistory,
    options.canonicalHistoryContext,
  );
  const randomBoundaries = getRandomElapsedBoundaries(boundaries);
  const hazard = buildRandomElapsedHazard(boundaries, now, modelOptions);
  const latestRecoveryResetAt = boundaries.at(-1)?.resetAt ?? null;
  const latestRandomResetAt = randomBoundaries.at(-1)?.resetAt ?? null;
  const randomElapsedHours = getElapsedHours(randomBoundaries, now);
  const recoveryElapsedHours = getElapsedHours(boundaries, now);
  const mode = modelOptions.mode ?? "full";
  const regimeMultiplier = mode === "elapsed-only"
    ? 1
    : recoveryResult.regimeElapsed.regime.regimeMultiplier;
  const baseline = makeHorizons(hazard, mode, randomElapsedHours, regimeMultiplier);
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
  const confidence = makeRandomHazardConfidence(hazard, recoveryResult.officialNoticeOverride.active);
  const warnings: string[] = [];
  if (hazard.completedIntervalCount < 2) {
    warnings.push("Random-reset intervals are sparse; treat this shadow result as exploratory.");
  }
  warnings.push("Regular recovery boundaries remain in the audit but do not reset the random-event hazard clock.");

  const regime = {
    ...recoveryResult.regimeElapsed.regime,
    regimeMultiplier,
  };

  return {
    modelVersion: modelOptions.modelVersion ?? RANDOM_ELAPSED_SHADOW_MODEL_VERSION,
    calculatedAt: now.toISOString(),
    targetDefinition: RANDOM_ELAPSED_SHADOW_TARGET_DEFINITION,
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
    randomElapsed: {
      clock: "random",
      mode,
      binScheme: modelOptions.binScheme ?? REGIME_ELAPSED_SELECTED_BIN_SCHEME,
      priorExposureDays: hazard.priorExposureDays,
      regimeHalfLifeDays: regime.halfLifeDays,
      regimeRatioExponent: modelOptions.regimeRatioExponent ?? REGIME_ELAPSED_SELECTED_RATIO_EXPONENT,
      latestRandomResetAt,
      latestRecoveryResetAt,
      randomElapsedHours,
      recoveryElapsedHours,
      regime,
      bins: hazard.bins.map((bin) => ({ ...bin })),
      recoveryBoundaryCount: boundaries.length,
      randomBoundaryCount: randomBoundaries.length,
      regularBoundaryCount: boundaries.filter((boundary) => boundary.isRegular).length,
      boundaryAudit: getRecoveryBoundaryAudit(
        data,
        now,
        options.staticHistory,
        options.canonicalHistoryContext,
      ),
      officialNoticeTimingPolicyVersion: recoveryResult.regimeElapsed.officialNoticeTimingPolicyVersion,
      freezeAt: RANDOM_ELAPSED_SHADOW_FREEZE_AT,
      freezePolicy: RANDOM_ELAPSED_SHADOW_FREEZE_POLICY,
    },
  };
}

export function getRandomElapsedHazardAtAge(
  hazard: RegimeElapsedHazard,
  ageHours: number,
) {
  return getRegimeElapsedHazardAtAge(hazard, ageHours);
}
