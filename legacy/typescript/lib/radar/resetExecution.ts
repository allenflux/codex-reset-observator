import type { CodexRecoveryObservation } from "../codexUsageRecovery";

export const RESET_EXECUTION_ESTIMATOR_VERSION = "usage-execution-v1";
export const TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION = "usage-execution-teaser-v1";
export const MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION = "usage-execution-monitor-v1";
export const PUBLIC_RANDOM_RESET_EXECUTION_ESTIMATOR_VERSIONS = [
  RESET_EXECUTION_ESTIMATOR_VERSION,
  TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION,
  MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION,
] as const;

export type ExecutionTimeSource =
  | "usage_observation"
  | "tibo_announcement_fallback"
  | "manual_override";

export type ExecutionTimeConfidence = "high" | "medium" | "low";

export type ExecutionTimePrecision =
  | "exact"
  | "approximate"
  | "window"
  | "announcement_fallback";

export type ManualExecutionOverride = {
  manualExecutionAt: string;
  manualExecutionPrecision: Exclude<ExecutionTimePrecision, "announcement_fallback">;
  manualOverrideReason: string;
  manualOverrideAt: string;
  manualOverrideBy?: string | null;
};

export type ResetExecutionEstimate = {
  resetEventKey: string;
  displayExecutionAt: string;
  executionTimeSource: ExecutionTimeSource;
  executionTimeConfidence: ExecutionTimeConfidence;
  executionTimePrecision: ExecutionTimePrecision;
  executionWindowStartAt?: string | null;
  executionWindowEndAt?: string | null;
  recoveryObservationId?: string | null;
  recoveryPreviousObservedAt?: string | null;
  recoveryObservedAt?: string | null;
  tiboAnnouncedAt?: string | null;
  tiboPrimaryTweetId?: string | null;
  tiboSourceTweetIds: string[];
  officialNoticeTweetId?: string | null;
  officialNoticeAt?: string | null;
  estimatorVersion: string;
  manualOverrideAt?: string | null;
  manualOverrideBy?: string | null;
  manualOverrideReason?: string | null;
  manualExecutionAt?: string | null;
  manualExecutionPrecision?: Exclude<ExecutionTimePrecision, "announcement_fallback"> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export function isPublicRandomResetExecutionEstimate(
  estimate: Partial<ResetExecutionEstimate> | null | undefined,
) {
  if (!estimate) return false;

  const displayExecutionAt = typeof estimate.displayExecutionAt === "string"
    ? parseTimestamp(estimate.displayExecutionAt)
    : null;
  const windowStartAt = typeof estimate.executionWindowStartAt === "string"
    ? parseTimestamp(estimate.executionWindowStartAt)
    : null;
  const windowEndAt = typeof estimate.executionWindowEndAt === "string"
    ? parseTimestamp(estimate.executionWindowEndAt)
    : null;
  const officialNoticeTweetId = typeof estimate.officialNoticeTweetId === "string"
    ? estimate.officialNoticeTweetId.trim()
    : "";
  const teaserTweetId = typeof estimate.tiboPrimaryTweetId === "string"
    ? estimate.tiboPrimaryTweetId.trim()
    : "";
  const recoveryObservationId = typeof estimate.recoveryObservationId === "string"
    ? estimate.recoveryObservationId.trim()
    : "";
  const estimatorVersion = typeof estimate.estimatorVersion === "string"
    ? estimate.estimatorVersion
    : "";
  const sourceTweetIds = new Set(
    (Array.isArray(estimate.tiboSourceTweetIds) ? estimate.tiboSourceTweetIds : [])
      .filter((tweetId): tweetId is string => typeof tweetId === "string")
      .map((tweetId) => tweetId.trim())
      .filter(Boolean),
  );

  const isNoticeBacked = Boolean(officialNoticeTweetId);
  const isTeaserCorroborated =
    !officialNoticeTweetId &&
    estimatorVersion === TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION &&
    Boolean(teaserTweetId);
  const isMonitorObserved =
    !officialNoticeTweetId &&
    !isTeaserCorroborated &&
    (estimatorVersion === MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION ||
      (!teaserTweetId && Boolean(recoveryObservationId)));

  return Boolean(
    PUBLIC_RANDOM_RESET_EXECUTION_ESTIMATOR_VERSIONS.includes(
      estimatorVersion as (typeof PUBLIC_RANDOM_RESET_EXECUTION_ESTIMATOR_VERSIONS)[number],
    ) &&
      estimate.executionTimeSource === "usage_observation" &&
      estimate.executionTimeConfidence === "high" &&
      estimate.executionTimePrecision === "approximate" &&
      recoveryObservationId &&
      (isNoticeBacked || isTeaserCorroborated || isMonitorObserved) &&
      displayExecutionAt !== null &&
      windowStartAt !== null &&
      windowEndAt !== null &&
      windowStartAt < windowEndAt &&
      displayExecutionAt === windowEndAt &&
      (isMonitorObserved || (officialNoticeTweetId
        ? sourceTweetIds.has(officialNoticeTweetId)
        : isTeaserCorroborated && sourceTweetIds.has(teaserTweetId))),
  );
}

export type DisplayExecutionDecision = {
  displayExecutionAt: string | null;
  executionTimeSource: ExecutionTimeSource;
  executionTimeConfidence: ExecutionTimeConfidence;
  executionTimePrecision: ExecutionTimePrecision;
  executionWindowStartAt: string | null;
  executionWindowEndAt: string | null;
  recoveryObservationId: string | null;
  estimatorVersion: string;
};

export type ResolveDisplayExecutionTimeInput = {
  resetEventKey: string;
  tiboAnnouncedAt?: string | null;
  tiboPrimaryTweetId?: string | null;
  tiboSourceTweetIds?: string[];
  officialNoticeTweetId?: string | null;
  officialNoticeAt?: string | null;
  corroboratingTiboTweetId?: string | null;
  isMonitorObserved?: boolean;
  usageObservation?: CodexRecoveryObservation | null;
  persistedEstimate?: ResetExecutionEstimate | null;
  manualOverride?: ManualExecutionOverride | null;
};

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function hasCompleteManualOverride(
  value: ManualExecutionOverride | null | undefined,
): value is ManualExecutionOverride {
  return Boolean(
    value &&
      parseTimestamp(value.manualExecutionAt) &&
      parseTimestamp(value.manualOverrideAt) &&
      value.manualOverrideReason.trim(),
  );
}

function isMatchedUsageObservation(
  value: CodexRecoveryObservation | null | undefined,
  sourceTweetIds: Set<string>,
  officialNoticeTweetId?: string | null,
  corroboratingTiboTweetId?: string | null,
  isMonitorObserved = false,
) {
  if (!value) return false;

  const observedAt = parseTimestamp(value.observedAt);
  const previousObservedAt = parseTimestamp(value.previousObservedAt);
  if (!observedAt || !previousObservedAt) return false;
  if (Date.parse(previousObservedAt) >= Date.parse(observedAt)) return false;

  if (isMonitorObserved) {
    return (
      value.confidence === "strong" &&
      value.cycleHint === "unexpected" &&
      value.status !== "rejected"
    );
  }

  if (value.status === "confirmed" && value.matchedTiboTweetId && sourceTweetIds.has(value.matchedTiboTweetId)) {
    return true;
  }

  if (
    officialNoticeTweetId &&
    sourceTweetIds.has(officialNoticeTweetId) &&
    value.confidence === "strong" &&
    value.cycleHint !== "regular" &&
    value.status !== "rejected"
  ) {
    return true;
  }

  if (
    corroboratingTiboTweetId &&
    sourceTweetIds.has(corroboratingTiboTweetId) &&
    (value.confidence === "strong" || value.confidence === "medium") &&
    value.cycleHint === "unexpected" &&
    value.status !== "rejected"
  ) {
    return true;
  }

  return false;
}

function getPersistedManualOverride(
  estimate: ResetExecutionEstimate | null | undefined,
): ManualExecutionOverride | null {
  if (!estimate?.manualExecutionAt || !estimate.manualExecutionPrecision) return null;
  if (!estimate.manualOverrideReason || !estimate.manualOverrideAt) return null;

  const override: ManualExecutionOverride = {
    manualExecutionAt: estimate.manualExecutionAt,
    manualExecutionPrecision: estimate.manualExecutionPrecision,
    manualOverrideReason: estimate.manualOverrideReason,
    manualOverrideAt: estimate.manualOverrideAt,
    manualOverrideBy: estimate.manualOverrideBy,
  };
  return hasCompleteManualOverride(override) ? override : null;
}

function getManualDecision(
  override: ManualExecutionOverride,
): DisplayExecutionDecision {
  return {
    displayExecutionAt: parseTimestamp(override.manualExecutionAt),
    executionTimeSource: "manual_override",
    executionTimeConfidence: "high",
    executionTimePrecision: override.manualExecutionPrecision,
    executionWindowStartAt: null,
    executionWindowEndAt: null,
    recoveryObservationId: null,
    estimatorVersion: RESET_EXECUTION_ESTIMATOR_VERSION,
  };
}

function getUsageDecision(
  observation: CodexRecoveryObservation,
  estimatorVersion = RESET_EXECUTION_ESTIMATOR_VERSION,
): DisplayExecutionDecision {
  const observedAt = parseTimestamp(observation.observedAt);
  const previousObservedAt = parseTimestamp(observation.previousObservedAt);
  return {
    displayExecutionAt: observedAt,
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: previousObservedAt,
    executionWindowEndAt: observedAt,
    recoveryObservationId: observation.id ?? null,
    estimatorVersion,
  };
}

function getPersistedUsageDecision(
  estimate: ResetExecutionEstimate | null | undefined,
  sourceTweetIds: Set<string>,
): DisplayExecutionDecision | null {
  if (
    !estimate ||
    estimate.executionTimeSource !== "usage_observation" ||
    estimate.executionTimePrecision !== "approximate" ||
    estimate.executionTimeConfidence !== "high" ||
    !estimate.recoveryObservationId
  ) {
    return null;
  }

  const isMonitorObserved =
    estimate.estimatorVersion === MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION ||
    (!estimate.tiboPrimaryTweetId && !estimate.officialNoticeTweetId);

  if (!isMonitorObserved) {
    if (
      !estimate.tiboPrimaryTweetId ||
      !sourceTweetIds.has(estimate.tiboPrimaryTweetId) ||
      (estimate.officialNoticeTweetId !== null &&
        estimate.officialNoticeTweetId !== undefined &&
        !sourceTweetIds.has(estimate.officialNoticeTweetId))
    ) {
      return null;
    }
  }

  const displayExecutionAt = parseTimestamp(estimate.displayExecutionAt);
  const windowEndAt = parseTimestamp(estimate.executionWindowEndAt);
  const windowStartAt = parseTimestamp(estimate.executionWindowStartAt);
  if (!displayExecutionAt || !windowEndAt || !windowStartAt || displayExecutionAt !== windowEndAt) {
    return null;
  }

  return {
    displayExecutionAt,
    executionTimeSource: "usage_observation",
    executionTimeConfidence: "high",
    executionTimePrecision: "approximate",
    executionWindowStartAt: windowStartAt,
    executionWindowEndAt: windowEndAt,
    recoveryObservationId: estimate.recoveryObservationId,
    estimatorVersion: estimate.estimatorVersion,
  };
}

export function resolveDisplayExecutionTime(
  input: ResolveDisplayExecutionTimeInput,
): DisplayExecutionDecision {
  const sourceTweetIds = new Set(
    [input.tiboPrimaryTweetId, ...(input.tiboSourceTweetIds ?? [])].filter((id): id is string => Boolean(id)),
  );
  const manualOverride = input.manualOverride ?? getPersistedManualOverride(input.persistedEstimate);
  if (hasCompleteManualOverride(manualOverride)) {
    return getManualDecision(manualOverride);
  }

  const isMonitorObserved =
    input.isMonitorObserved === true ||
    (!input.officialNoticeTweetId && !input.corroboratingTiboTweetId && !input.tiboPrimaryTweetId);

  if (isMatchedUsageObservation(
    input.usageObservation,
    sourceTweetIds,
    input.officialNoticeTweetId,
    input.corroboratingTiboTweetId,
    isMonitorObserved,
  )) {
    return getUsageDecision(
      input.usageObservation!,
      isMonitorObserved
        ? MONITOR_OBSERVED_RESET_EXECUTION_ESTIMATOR_VERSION
        : input.corroboratingTiboTweetId
          ? TEASER_CORROBORATED_RESET_EXECUTION_ESTIMATOR_VERSION
          : RESET_EXECUTION_ESTIMATOR_VERSION,
    );
  }

  const persistedUsage = getPersistedUsageDecision(input.persistedEstimate, sourceTweetIds);
  if (persistedUsage) return persistedUsage;

  const fallbackTime = parseTimestamp(input.tiboAnnouncedAt) ?? parseTimestamp(input.usageObservation?.observedAt);

  return {
    displayExecutionAt: fallbackTime,
    executionTimeSource: "tibo_announcement_fallback",
    executionTimeConfidence: "medium",
    executionTimePrecision: "announcement_fallback",
    executionWindowStartAt: null,
    executionWindowEndAt: null,
    recoveryObservationId: null,
    estimatorVersion: RESET_EXECUTION_ESTIMATOR_VERSION,
  };
}

export function buildResetExecutionEstimate(
  input: ResolveDisplayExecutionTimeInput,
): ResetExecutionEstimate | null {
  const decision = resolveDisplayExecutionTime(input);
  if (!decision.displayExecutionAt) return null;

  const manualOverride = input.manualOverride ?? getPersistedManualOverride(input.persistedEstimate);
  return {
    resetEventKey: input.resetEventKey,
    displayExecutionAt: decision.displayExecutionAt,
    executionTimeSource: decision.executionTimeSource,
    executionTimeConfidence: decision.executionTimeConfidence,
    executionTimePrecision: decision.executionTimePrecision,
    executionWindowStartAt: decision.executionWindowStartAt,
    executionWindowEndAt: decision.executionWindowEndAt,
    recoveryObservationId: decision.recoveryObservationId,
    recoveryPreviousObservedAt: decision.executionWindowStartAt,
    recoveryObservedAt: decision.executionWindowEndAt,
    tiboAnnouncedAt: parseTimestamp(input.tiboAnnouncedAt),
    tiboPrimaryTweetId: input.tiboPrimaryTweetId ?? null,
    tiboSourceTweetIds: Array.from(new Set(input.tiboSourceTweetIds ?? [])),
    officialNoticeTweetId: input.officialNoticeTweetId ?? input.persistedEstimate?.officialNoticeTweetId ?? null,
    officialNoticeAt: parseTimestamp(input.officialNoticeAt ?? input.persistedEstimate?.officialNoticeAt),
    estimatorVersion: decision.estimatorVersion,
    manualOverrideAt: manualOverride?.manualOverrideAt ?? null,
    manualOverrideBy: manualOverride?.manualOverrideBy ?? null,
    manualOverrideReason: manualOverride?.manualOverrideReason ?? null,
    manualExecutionAt: manualOverride?.manualExecutionAt ?? null,
    manualExecutionPrecision: manualOverride?.manualExecutionPrecision ?? null,
  };
}
