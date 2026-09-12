import { LOCAL_OBSERVATION_SIGNALS, type LocalObservationSignal } from "@/data/observationSignals";
import {
  AUTOMATED_TIBO_SIGNAL_WEIGHTS,
  LOCAL_PROBABILITY_WEIGHTS,
  PROBABILITY_MODEL_VERSION,
  TIBO_TEASER_DECAY_HOURS,
} from "@/data/predictionWeights";
import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import type { OpenAIStatusSignals } from "@/lib/openaiStatus";
import type { ActiveTiboSignal, Locale, RadarData, WindowEventLike } from "./types";
import { translateDynamic, translateUI } from "./i18n";
import {
  deriveComplaintPressure,
  evaluateStatusIncidents,
  formatStatusIncidentReason,
  type StatusIncidentEvaluation,
} from "./signalEvaluation";
import {
  getLatestIsoDate,
  isWithinHours,
  getDateTime,
  probabilityToPercent,
  getExpectationLabel,
  getExpectationKey,
  formatElapsedResetDuration,
  formatElapsedResetDurationPrecise,
  formatDateTime,
  type ExpectationKey,
} from "./helpers";
import {
  compareTiboNoticeSpecificity,
  combineResetHistory,
  getNoticeBackedHistoryInputs,
  type CanonicalResetHistoryContext,
  type TiboNoticeSignal,
} from "./tiboHistory";
import { isEligibleRandomResetEvent } from "./resetEligibility";
import {
  getLastRandomRecoveryResetAt,
  getLastRandomRecoveryResetWindow,
  getLastRecoveryResetAt,
} from "./recoveryBoundary";
import {
  aggregateResetTeaserStatus,
  getEffectiveTeaserStrength,
  getTeaserStrengthSignals,
} from "./teaserStrength";
import type { TemporalPrecision, TemporalResolutionStatus } from "./tiboTemporal";
import {
  getEffectiveTemporalPrecision,
  getTemporalExecutionWindowRelation,
  isTemporalNoticeConsumedAtReset,
  TIBO_NOTICE_GRACE_MS,
  type ResetExecutionWindow,
} from "./tiboTemporal";
import { getTiboDisplayLabel } from "./tiboHandle";
import {
  isBankedDistributionNotice,
  isRecurringConditionalBankedDistributionNotice,
  isSupersededBankedNotice,
} from "./bankedReset";
import type { MajorModelReleaseAdjustment } from "@/data/majorModelReleases";
import {
  getOfficialNoticeConsumption,
  isOfficialNoticeTerminatedAt,
  isTiboForecastSignalTerminatedAt,
  type OfficialNoticeConsumption,
} from "./officialNoticePolicy";
import { expandTiboSignalVariants } from "./tiboSecondarySignal";
import { getTiboReadSideSignals } from "./tiboLogicalProjection";

export type LocalSignalEvaluation = {
  environment: NonNullable<RadarData["codex_environment"]>;
  statusIncidents: StatusIncidentEvaluation;
  complaintPressure: ReturnType<typeof deriveComplaintPressure>;
  latestResetAt: Date | null;
};

export type ActiveOfficialNotice = {
  origin: "dynamic" | "local";
  id: string;
  title: string | null;
  summary: string | null;
  observedAt: string;
  expectedAt: string | null;
  expectedEndAt: string | null;
  expiresAt: string | null;
  source: string | null;
  sourceLabel: string;
  text?: string | null;
  isBankedDistribution?: boolean;
  isOngoingBankedDistribution?: boolean;
  consumption?: OfficialNoticeConsumption;
  temporalPrecision?: TemporalPrecision | null;
  temporalConfidence?: number | null;
  temporalResolutionStatus?: TemporalResolutionStatus | null;
  temporalTimezone?: string | null;
};

export type ProbabilityPair = {
  probability24h: number;
  probability48h: number;
};

export type ProbabilityBreakdown = {
  unit: "decimal";
  base: ProbabilityPair;
  contributions: {
    recentResetMomentum: ProbabilityPair;
    elapsedSinceReset: ProbabilityPair;
    localHistoryPressure: ProbabilityPair;
    historicalIntervalPressure: ProbabilityPair;
    regularResetProximity: ProbabilityPair;
    teaserOrEvent: ProbabilityPair;
    statusSignal: ProbabilityPair;
    officialIncidentHint: ProbabilityPair;
    officialUpdate: ProbabilityPair;
    communitySignal: ProbabilityPair;
    usageLimitAnomaly: ProbabilityPair;
    complaintPressure: ProbabilityPair;
  };
  beforeClamp: ProbabilityPair;
  afterClamp: ProbabilityPair;
  officialNoticeOverride: {
    active: boolean;
    probability24h: number | null;
    probability48h: number | null;
  };
};

export type ProbabilityInputSnapshot = {
  calculatedAt: string;
  lastCompletedResetAt: string | null;
  elapsedHoursSinceReset: number | null;
  elapsedDaysSinceReset: number | null;
  recentCompletedResetCount7d: number;
  regularResetExpectedAt: string | null;
  activeOfficialNotice: boolean;
  activeTeaserCount: number;
  weightedStatusScore: number;
  officialIncidentHintCount: number;
  officialUpdateCount: number;
  communityMentionCount: number;
  usageLimitAnomalyCount: number;
  complaintPressure: "low" | "medium" | "high";
  activeStatusIncidentCount: number;
  recentResolvedStatusIncidentCount: number;
  includedStatusIncidentCount: number;
};

export type ProbabilityCalculationAudit = {
  modelVersion: string;
  probability24h: number;
  probability48h: number;
  inputSnapshot: ProbabilityInputSnapshot;
  breakdown: ProbabilityBreakdown;
};

export type ProbabilityCalculationOptions = {
  now?: Date;
  signalEvaluation?: LocalSignalEvaluation;
  activeOfficialNotice?: ActiveOfficialNotice | null;
  regularResetExpectedAt?: string | null;
  canonicalHistoryContext?: CanonicalResetHistoryContext;
};

type ProbabilityContributions = ProbabilityBreakdown["contributions"];
type PeriodContributions = {
  [Key in keyof ProbabilityContributions]: number;
};

function zeroProbabilityPair(): ProbabilityPair {
  return { probability24h: 0, probability48h: 0 };
}

function getSignalTemporalWindow(signal: {
  temporal_resolution_status?: string | null;
  expected_start_at?: string | null;
  expected_end_at?: string | null;
}) {
  return signal.temporal_resolution_status === "resolved"
    ? {
        status: "resolved" as const,
        expectedStartAt: signal.expected_start_at ?? null,
        expectedEndAt: signal.expected_end_at ?? null,
      }
    : null;
}

function toDynamicOfficialNotice(
  signal: ActiveTiboSignal,
  options: {
    ongoingBankedDistribution?: boolean;
    persistentAfterInitialWindow?: boolean;
  } = {},
): ActiveOfficialNotice {
  const isOngoingBankedDistribution = options.ongoingBankedDistribution === true;
  const persistentAfterInitialWindow = options.persistentAfterInitialWindow === true;
  const hideInitialSchedule = isOngoingBankedDistribution || persistentAfterInitialWindow;
  const consumption = getOfficialNoticeConsumption(signal.tweet_id);
  return {
    origin: "dynamic",
    id: signal.tweet_id,
    title: signal.text ?? null,
    summary: signal.text ?? null,
    observedAt: signal.tweet_created_at,
    expectedAt: hideInitialSchedule ? null : signal.expected_start_at ?? null,
    expectedEndAt: hideInitialSchedule ? null : signal.expected_end_at ?? null,
    expiresAt: signal.expires_at ?? null,
    source: signal.tweet_url ?? null,
    sourceLabel: getTiboDisplayLabel(signal.tweet_url),
    text: signal.text ?? null,
    isBankedDistribution: isBankedDistributionNotice(signal.text),
    consumption,
    ...(isOngoingBankedDistribution ? {
      isOngoingBankedDistribution: true,
      temporalPrecision: "unknown" as const,
    } : persistentAfterInitialWindow ? {
      temporalPrecision: "unknown" as const,
      temporalConfidence: null,
      temporalResolutionStatus: "unresolved" as const,
      temporalTimezone: null,
    } : {
      temporalPrecision: getEffectiveTemporalPrecision({
        status: signal.temporal_resolution_status,
        temporalPrecision: signal.temporal_precision ?? signal.ai_temporal_precision,
        expectedStartAt: signal.expected_start_at,
        expectedEndAt: signal.expected_end_at,
      }),
      temporalConfidence: signal.temporal_confidence ?? signal.ai_temporal_confidence ?? null,
      temporalResolutionStatus: signal.temporal_resolution_status ?? null,
      temporalTimezone: signal.temporal_timezone ?? signal.ai_temporal_timezone ?? null,
    }),
  };
}

function getOfficialNoticeTimingReason(
  locale: Locale,
) {
  return translateUI("outlookOfficialNotice", locale);
}

function getProbabilityComponents(
  data: RadarData | null,
  signalEvaluation: LocalSignalEvaluation,
  now: Date,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const environment = signalEvaluation.environment;
  const sortedSignals = expandTiboSignalVariants(
    getTiboReadSideSignals(
      data,
      "probability",
      false,
      canonicalHistoryContext?.readSideProjection,
    ),
  )
    .slice()
    .sort(
      (left, right) =>
        new Date(left.tweet_created_at).getTime() -
        new Date(right.tweet_created_at).getTime(),
    );
  const latestAcceptedTiboExecutionTime =
    getLatestAcceptedTiboExecutionAt(data, now)?.getTime() ?? 0;
  const dynamicRandomRecoveryWindow = getLastRandomRecoveryResetWindow(
    data,
    now,
    [],
    canonicalHistoryContext,
  );
  const latestRandomRecoveryWindow = getLastRandomRecoveryResetWindow(
    data,
    now,
    LOCAL_RESET_HISTORY,
    canonicalHistoryContext,
  );
  const dynamicRandomRecoveryTime = dynamicRandomRecoveryWindow?.executionWindowEndAt ?? null;
  const latestRandomRecoveryTime = latestRandomRecoveryWindow?.executionWindowEndAt ?? null;
  // A dynamic canonical boundary represents the observed reset itself. A late
  // Tibo completion post only corroborates it and must not consume teasers
  // from the next cycle. With no dynamic boundary, retain the legacy fallback
  // for Tibo-only and static-history cases.
  const executionTime = dynamicRandomRecoveryTime
    ? getDateTime(dynamicRandomRecoveryTime)
    : Math.max(
        latestAcceptedTiboExecutionTime,
        latestRandomRecoveryTime ? getDateTime(latestRandomRecoveryTime) : 0,
      );
  const executionWindow: ResetExecutionWindow | null = dynamicRandomRecoveryWindow ??
    (latestRandomRecoveryWindow &&
      getDateTime(latestRandomRecoveryWindow.executionWindowEndAt ?? "") === executionTime
      ? latestRandomRecoveryWindow
      : executionTime > 0
        ? {
            executionWindowStartAt: null,
            executionWindowEndAt: new Date(executionTime).toISOString(),
          }
        : null);
  const validTeasers = sortedSignals.filter((signal) => {
    const createdTime = new Date(signal.tweet_created_at).getTime();
    const secondaryFollowsThisBoundary = signal.is_secondary_future_signal === true &&
      new Date(signal.primary_event_at ?? "").getTime() === executionTime;
    const temporalRelation = getTemporalExecutionWindowRelation(
      getSignalTemporalWindow(signal),
      executionWindow,
    );
    const isFutureWindowAfterReset = temporalRelation === "before";
    return signal.signal_type === "teaser" &&
      !isTiboForecastSignalTerminatedAt(signal.tweet_id, now) &&
      (signal.confidence ?? 0) >= 0.8 &&
      (
        createdTime > executionTime ||
        secondaryFollowsThisBoundary ||
        (createdTime <= executionTime && isFutureWindowAfterReset)
      );
  });

  const activeBoostSignals = LOCAL_OBSERVATION_SIGNALS.filter(
    (signal) =>
      (signal.type === "probability_boost" ||
        typeof signal.boostValue24h === "number" ||
        typeof signal.boostValue48h === "number" ||
        typeof signal.boostValue === "number") &&
      isCurrentLocalSignal(signal, now),
  );
  const activeTeaserOrEvent = activeBoostSignals.length > 0 || validTeasers.length > 0;
  const teaserOrEvent: ProbabilityPair = {
    probability24h: activeBoostSignals.reduce(
      (sum, signal) =>
        sum +
        (signal.boostValue24h ?? signal.boostValue ?? 0) *
          (typeof signal.boostDecayHours === "number"
            ? getTeaserDecayFactor(signal.observedAt, now, signal.boostDecayHours)
            : 1),
      0,
    ),
    probability48h: activeBoostSignals.reduce(
      (sum, signal) =>
        sum +
        (signal.boostValue48h ?? signal.boostValue ?? 0) *
          (typeof signal.boostDecayHours === "number"
            ? getTeaserDecayFactor(signal.observedAt, now, signal.boostDecayHours)
            : 1),
      0,
    ),
  };

  if (validTeasers.length > 0 && activeBoostSignals.length === 0) {
    const teaser = validTeasers[0];
    teaserOrEvent.probability24h += getTeaserBoost("24h", teaser.tweet_created_at, now);
    teaserOrEvent.probability48h += getTeaserBoost("48h", teaser.tweet_created_at, now);
  }

  const officialIncidentHintCount = clampCount(
    environment.official_incident_hints_24h,
    0,
    LOCAL_PROBABILITY_WEIGHTS.countLimits.officialIncidentHints,
  );
  const officialUpdateCount = clampCount(
    environment.official_updates_24h,
    0,
    LOCAL_PROBABILITY_WEIGHTS.countLimits.officialUpdates,
  );
  const communityMentionCount = clampCount(
    environment.community_mentions_24h,
    0,
    LOCAL_PROBABILITY_WEIGHTS.countLimits.communityMentions,
  );
  const usageLimitAnomalyCount = clampCount(
    environment.issue_or_limit_anomalies_24h,
    0,
    LOCAL_PROBABILITY_WEIGHTS.countLimits.issueAnomalies,
  );
  const complaintPressure = signalEvaluation.complaintPressure.level;
  const complaintPressureValue =
    complaintPressure === "high"
      ? LOCAL_PROBABILITY_WEIGHTS.pressureBoost.high
      : complaintPressure === "medium"
        ? LOCAL_PROBABILITY_WEIGHTS.pressureBoost.medium
        : LOCAL_PROBABILITY_WEIGHTS.pressureBoost.low;

  return {
    activeTeaserCount: validTeasers.length,
    activeTeaserOrEvent,
    teaserOrEvent,
    officialIncidentHintCount,
    officialUpdateCount,
    communityMentionCount,
    usageLimitAnomalyCount,
    complaintPressure,
    complaintPressureValue,
  };
}

function getPeriodContributions(
  period: "24h" | "48h",
  data: RadarData | null,
  signalEvaluation: LocalSignalEvaluation,
  components: ReturnType<typeof getProbabilityComponents>,
  regularResetExpectedAt: string | null | undefined,
  now: Date,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): PeriodContributions {
  const weightKey = period === "24h" ? "within24h" : "within48h";
  return {
    recentResetMomentum: getMomentumBoost(period, data, now, canonicalHistoryContext),
    elapsedSinceReset: getElapsedDayBoost(data, now, canonicalHistoryContext),
    localHistoryPressure: components.activeTeaserOrEvent
      ? getLocalHistoryPressure(period, data, now, canonicalHistoryContext)
      : 0,
    historicalIntervalPressure: getHistoricalResetPressure(period, data, now, canonicalHistoryContext),
    regularResetProximity: getRegularResetProximityBoost(
      period,
      regularResetExpectedAt,
      now,
    ),
    teaserOrEvent:
      period === "24h"
        ? components.teaserOrEvent.probability24h
        : components.teaserOrEvent.probability48h,
    statusSignal:
      signalEvaluation.statusIncidents.weightedStatusScore *
      LOCAL_PROBABILITY_WEIGHTS.signalWeights.statusIncident[weightKey],
    officialIncidentHint:
      components.officialIncidentHintCount *
      LOCAL_PROBABILITY_WEIGHTS.signalWeights.officialIncidentHint[weightKey],
    officialUpdate:
      components.officialUpdateCount *
      LOCAL_PROBABILITY_WEIGHTS.signalWeights.officialUpdate[weightKey],
    communitySignal:
      components.communityMentionCount *
      LOCAL_PROBABILITY_WEIGHTS.signalWeights.communityMention[weightKey],
    usageLimitAnomaly:
      components.usageLimitAnomalyCount *
      LOCAL_PROBABILITY_WEIGHTS.signalWeights.issueAnomaly[weightKey],
    complaintPressure: components.complaintPressureValue,
  };
}

function sumPeriodContributions(
  base: number,
  contributions: ProbabilityContributions,
  period: "24h" | "48h",
) {
  return base + Object.values(contributions).reduce(
    (sum, value) => sum + value[period === "24h" ? "probability24h" : "probability48h"],
    0,
  );
}

function clampProbability(value: number, period: "24h" | "48h") {
  const weightKey = period === "24h" ? "within24h" : "within48h";
  const minLimit = LOCAL_PROBABILITY_WEIGHTS.min[weightKey];
  return Math.min(
    LOCAL_PROBABILITY_WEIGHTS.max[weightKey],
    Math.max(minLimit, value),
  );
}

export function getLocalProbabilityCalculation(
  data: RadarData | null,
  options: ProbabilityCalculationOptions = {},
): ProbabilityCalculationAudit {
  const now = options.now ?? new Date();
  const signalEvaluation =
    options.signalEvaluation ?? getLocalSignalEvaluation(data, now, LOCAL_OBSERVATION_SIGNALS, options.canonicalHistoryContext);
  const activeOfficialNotice =
    options.activeOfficialNotice === undefined
      ? getActiveOfficialNotice(data, signalEvaluation.latestResetAt, now, LOCAL_OBSERVATION_SIGNALS, null, false, false, options.canonicalHistoryContext)
      : options.activeOfficialNotice;
  const regularResetExpectedAt = options.regularResetExpectedAt ?? null;
  const components = getProbabilityComponents(data, signalEvaluation, now, options.canonicalHistoryContext);
  const lastResetAt = getLastGlobalResetAt(data, now, options.canonicalHistoryContext);
  const elapsedMs = lastResetAt
    ? Math.max(0, now.getTime() - lastResetAt.getTime())
    : null;
  const elapsedHoursSinceReset = elapsedMs === null ? null : elapsedMs / (60 * 60 * 1000);
  const elapsedDaysSinceReset = elapsedMs === null ? null : elapsedMs / (24 * 60 * 60 * 1000);
  const recentCompletedResetCount7d = getRecent7DayResetCount(
    data,
    now,
    options.canonicalHistoryContext,
  );
  const inputSnapshot: ProbabilityInputSnapshot = {
    calculatedAt: now.toISOString(),
    lastCompletedResetAt: lastResetAt?.toISOString() ?? null,
    elapsedHoursSinceReset,
    elapsedDaysSinceReset,
    recentCompletedResetCount7d,
    regularResetExpectedAt,
    activeOfficialNotice: Boolean(activeOfficialNotice),
    activeTeaserCount: components.activeTeaserCount,
    weightedStatusScore: signalEvaluation.statusIncidents.weightedStatusScore,
    officialIncidentHintCount: components.officialIncidentHintCount,
    officialUpdateCount: components.officialUpdateCount,
    communityMentionCount: components.communityMentionCount,
    usageLimitAnomalyCount: components.usageLimitAnomalyCount,
    complaintPressure: components.complaintPressure,
    activeStatusIncidentCount: signalEvaluation.statusIncidents.activeStatusIncidentCount,
    recentResolvedStatusIncidentCount: signalEvaluation.statusIncidents.recentResolvedIncidentCount,
    includedStatusIncidentCount: signalEvaluation.statusIncidents.includedIncidentCount,
  };

  const base: ProbabilityPair = {
    probability24h: LOCAL_PROBABILITY_WEIGHTS.base.within24h,
    probability48h: LOCAL_PROBABILITY_WEIGHTS.base.within48h,
  };
  if (activeOfficialNotice) {
    const probability24h = LOCAL_PROBABILITY_WEIGHTS.officialNotice.within24h;
    const probability48h = LOCAL_PROBABILITY_WEIGHTS.officialNotice.within48h;
    return {
      modelVersion: PROBABILITY_MODEL_VERSION,
      probability24h,
      probability48h,
      inputSnapshot,
      breakdown: {
        unit: "decimal",
        base,
        contributions: {
          recentResetMomentum: zeroProbabilityPair(),
          elapsedSinceReset: zeroProbabilityPair(),
          localHistoryPressure: zeroProbabilityPair(),
          historicalIntervalPressure: zeroProbabilityPair(),
          regularResetProximity: zeroProbabilityPair(),
          teaserOrEvent: zeroProbabilityPair(),
          statusSignal: zeroProbabilityPair(),
          officialIncidentHint: zeroProbabilityPair(),
          officialUpdate: zeroProbabilityPair(),
          communitySignal: zeroProbabilityPair(),
          usageLimitAnomaly: zeroProbabilityPair(),
          complaintPressure: zeroProbabilityPair(),
        },
        beforeClamp: { probability24h, probability48h },
        afterClamp: { probability24h, probability48h },
        officialNoticeOverride: {
          active: true,
          probability24h,
          probability48h,
        },
      },
    };
  }

  const contributions24h = getPeriodContributions(
    "24h",
    data,
    signalEvaluation,
    components,
    regularResetExpectedAt,
    now,
    options.canonicalHistoryContext,
  );
  const contributions48h = getPeriodContributions(
    "48h",
    data,
    signalEvaluation,
    components,
    regularResetExpectedAt,
    now,
    options.canonicalHistoryContext,
  );
  const contributions: ProbabilityContributions = {
    recentResetMomentum: {
      probability24h: contributions24h.recentResetMomentum,
      probability48h: contributions48h.recentResetMomentum,
    },
    elapsedSinceReset: {
      probability24h: contributions24h.elapsedSinceReset,
      probability48h: contributions48h.elapsedSinceReset,
    },
    localHistoryPressure: {
      probability24h: contributions24h.localHistoryPressure,
      probability48h: contributions48h.localHistoryPressure,
    },
    historicalIntervalPressure: {
      probability24h: contributions24h.historicalIntervalPressure,
      probability48h: contributions48h.historicalIntervalPressure,
    },
    regularResetProximity: {
      probability24h: contributions24h.regularResetProximity,
      probability48h: contributions48h.regularResetProximity,
    },
    teaserOrEvent: {
      probability24h: contributions24h.teaserOrEvent,
      probability48h: contributions48h.teaserOrEvent,
    },
    statusSignal: {
      probability24h: contributions24h.statusSignal,
      probability48h: contributions48h.statusSignal,
    },
    officialIncidentHint: {
      probability24h: contributions24h.officialIncidentHint,
      probability48h: contributions48h.officialIncidentHint,
    },
    officialUpdate: {
      probability24h: contributions24h.officialUpdate,
      probability48h: contributions48h.officialUpdate,
    },
    communitySignal: {
      probability24h: contributions24h.communitySignal,
      probability48h: contributions48h.communitySignal,
    },
    usageLimitAnomaly: {
      probability24h: contributions24h.usageLimitAnomaly,
      probability48h: contributions48h.usageLimitAnomaly,
    },
    complaintPressure: {
      probability24h: contributions24h.complaintPressure,
      probability48h: contributions48h.complaintPressure,
    },
  };
  const beforeClamp: ProbabilityPair = {
    probability24h: sumPeriodContributions(base.probability24h, contributions, "24h"),
    probability48h: sumPeriodContributions(base.probability48h, contributions, "48h"),
  };
  const clamped24h = clampProbability(beforeClamp.probability24h, "24h");
  const clamped48h = clampProbability(beforeClamp.probability48h, "48h");
  const afterClamp: ProbabilityPair = {
    probability24h: clamped24h,
    probability48h: Math.max(clamped24h, clamped48h),
  };

  return {
    modelVersion: PROBABILITY_MODEL_VERSION,
    probability24h: afterClamp.probability24h,
    probability48h: afterClamp.probability48h,
    inputSnapshot,
    breakdown: {
      unit: "decimal",
      base,
      contributions,
      beforeClamp,
      afterClamp,
      officialNoticeOverride: {
        active: false,
        probability24h: null,
        probability48h: null,
      },
    },
  };
}

export function getLocalResetProbability(
  data: RadarData | null,
  period: "24h" | "48h",
  signalEvaluation?: LocalSignalEvaluation,
  activeOfficialNotice?: ActiveOfficialNotice | null,
  now: Date = new Date(),
  regularResetExpectedAt?: string | null,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): number {
  const calculation = getLocalProbabilityCalculation(data, {
    now,
    signalEvaluation,
    activeOfficialNotice,
    regularResetExpectedAt,
    canonicalHistoryContext,
  });
  return period === "24h"
    ? calculation.probability24h
    : calculation.probability48h;
}

export function getTeaserDecayFactor(
  observedAt: string,
  now: Date = new Date(),
  decayHours: number = TIBO_TEASER_DECAY_HOURS,
) {
  const observedTime = getDateTime(observedAt);
  if (observedTime <= 0 || !Number.isFinite(decayHours) || decayHours <= 0) {
    return 1;
  }

  const ageHours = (now.getTime() - observedTime) / (60 * 60 * 1000);
  if (ageHours <= 0) {
    return 1;
  }

  return Math.max(0, 1 - ageHours / decayHours);
}

export function getTeaserBoost(
  period: "24h" | "48h",
  observedAt: string,
  now: Date = new Date(),
) {
  const weightKey = period === "24h" ? "within24h" : "within48h";
  const baseBoost = AUTOMATED_TIBO_SIGNAL_WEIGHTS.teaser[weightKey];
  return baseBoost * getTeaserDecayFactor(observedAt, now);
}

export function getRegularResetProximityBoost(
  period: "24h" | "48h",
  expectedAt: string | null | undefined,
  now: Date = new Date(),
) {
  const expectedTime = getDateTime(expectedAt);
  if (!expectedTime || !Number.isFinite(now.getTime())) {
    return 0;
  }

  const hoursUntil = (expectedTime - now.getTime()) / (60 * 60 * 1000);
  if (hoursUntil < 0) {
    return 0;
  }

  const weight = LOCAL_PROBABILITY_WEIGHTS.regularResetProximity[
    period === "24h" ? "forecast24h" : "forecast48h"
  ];
  if (hoursUntil > weight.leadInHours) {
    return 0;
  }

  const progress = 1 - hoursUntil / weight.leadInHours;
  return weight.entry + (weight.max - weight.entry) * progress;
}

export function getHistoricalResetPressure(
  period: "24h" | "48h",
  data: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const daysSinceLastReset = getDaysSinceLastGlobalReset(data, now, canonicalHistoryContext);
  if (daysSinceLastReset === null) {
    return 0;
  }

  const intervals = getRandomResetIntervals(data, now, canonicalHistoryContext);
  if (intervals.length === 0) {
    return 0;
  }

  const horizonDays = period === "24h" ? 1 : 2;
  const atRiskIntervals = intervals.filter((days) => days > daysSinceLastReset);
  if (atRiskIntervals.length === 0) {
    return 0;
  }

  const successfulIntervals = atRiskIntervals.filter(
    (days) => days <= daysSinceLastReset + horizonDays,
  ).length;
  const weight = LOCAL_PROBABILITY_WEIGHTS.historicalResetPressure[
    period === "24h" ? "forecast24h" : "forecast48h"
  ];
  const smoothedRate = (
    successfulIntervals + weight.priorRate * LOCAL_PROBABILITY_WEIGHTS.historicalResetPressure.priorWeight
  ) / (atRiskIntervals.length + LOCAL_PROBABILITY_WEIGHTS.historicalResetPressure.priorWeight);
  const excessRate = Math.max(0, smoothedRate - weight.priorRate);
  const normalizedExcess = excessRate / (1 - weight.priorRate);

  return Math.min(weight.maxBoost, normalizedExcess * weight.maxBoost);
}

function getRandomResetIntervals(
  data: RadarData | null,
  now: Date,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const historicalItems = canonicalHistoryContext?.defaultHistory ?? (() => {
    const {
      noticeSignals,
      bankedSignals,
      recoveryObservations,
      estimates,
      identityContext,
    } = getNoticeBackedHistoryInputs(data);
    return combineResetHistory(
      LOCAL_RESET_HISTORY,
      data?.formal_tibo_resets ?? [],
      data?.rejected_tibo_resets ?? [],
      data?.regular_reset_events ?? [],
      noticeSignals,
      recoveryObservations,
      estimates,
      bankedSignals,
      identityContext,
    );
  })();
  const resetTimes = historicalItems
    .filter((item) => isEligibleRandomResetEvent(
      item,
      getCompletedResetTimestamp(item),
      now.getTime(),
    ))
    .map((item) => getCompletedResetTimestamp(item)!)
    .sort((left, right) => left - right);

  return resetTimes.slice(1).map((time, index) =>
    (time - resetTimes[index]) / (24 * 60 * 60 * 1000),
  );
}

function getHistoricalResetTime(item: WindowEventLike) {
  return getDateTime(item.closed_at ?? item.completed_at ?? null);
}

function isPendingResetRecord(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  return (
    item.kind === "window_opened" ||
    status === "open" ||
    status === "active" ||
    status === "pending" ||
    status === "scheduled" ||
    status === "announced"
  );
}

export function getCompletedResetTimestamp(item: WindowEventLike) {
  if (isPendingResetRecord(item)) {
    return null;
  }

  const timestamp = getHistoricalResetTime(item);
  return timestamp > 0 ? timestamp : null;
}

export function getLocalSignalEnvironment(
  openAIStatus?: OpenAIStatusSignals | null,
  now: Date = new Date(),
  localObservationSignals: Array<LocalObservationSignal> = LOCAL_OBSERVATION_SIGNALS,
): NonNullable<RadarData["codex_environment"]> {
  const recentSignals = localObservationSignals.filter((signal) =>
    isCurrentLocalSignal(signal, now) && isWithinHours(signal.observedAt, 24, now),
  );
  const localStatusIncidents = recentSignals.filter(
    (signal) => signal.type === "status_incident",
  ).length;
  const officialIncidentHints = recentSignals.filter(
    (signal) => signal.type === "official_incident_hint",
  ).length;
  const officialUpdates = recentSignals.filter(
    (signal) => signal.type === "official_notice",
  ).length;
  const communityMentions = recentSignals.filter(
    (signal) => signal.type === "community_report",
  ).length;
  const issueAnomalies = recentSignals.filter(
    (signal) => signal.type === "limit_anomaly",
  ).length;
  const statusIncidents =
    localStatusIncidents + (openAIStatus?.statusIncidents24h ?? 0);
  const activeCodexIncidents = openAIStatus?.activeCodexIncidents ?? 0;
  const complaintPressure = deriveComplaintPressure({
    communityMentions,
    issueAnomalies,
    activeStatusIncidents: activeCodexIncidents,
    statusIncidents,
    officialIncidentHints,
  });

  // ここで getLocalModelUpdatedAt が必要だが循環参照を防ぐためにローカルで計算する
  const updatedCandidates = [
    openAIStatus?.updatedAt,
    ...localObservationSignals.map((signal) => signal.observedAt),
    ...LOCAL_RESET_HISTORY.flatMap((item) => [
      item.closed_at,
      item.completed_at,
      item.opened_at,
      item.date,
    ]),
  ];
  const updatedAt = getLatestIsoDate(updatedCandidates) ?? now.toISOString();

  return {
    updated_at: updatedAt,
    status_incidents_24h: statusIncidents,
    official_incident_hints_24h: officialIncidentHints,
    official_updates_24h: officialUpdates,
    community_mentions_24h: communityMentions,
    issue_or_limit_anomalies_24h: issueAnomalies,
    complaint_pressure: complaintPressure.level,
    complaint_pressure_sources: complaintPressure.sources,
    openai_status_updated_at: openAIStatus?.updatedAt ?? null,
    openai_status_active_codex_incidents: activeCodexIncidents,
    openai_status_recent_codex_incidents:
      openAIStatus?.recentCodexIncidents ?? 0,
    openai_status_affected_codex_components:
      openAIStatus?.affectedCodexComponents ?? 0,
    openai_status_incidents_suppressed:
      openAIStatus?.suppressCodexIncidents ?? false,
    openai_status_latest_codex_incident:
      openAIStatus?.latestCodexIncidentName ?? null,
    codex_operational_status:
      openAIStatus?.codexOperationalStatus ?? "none",
    reset_card: {
      status: "prediction_only",
    },
  };
}

export function getSignalEnvironment(
  data: RadarData | null,
  now: Date = new Date(),
): NonNullable<RadarData["codex_environment"]> {
  return data?.codex_environment ?? getLocalSignalEnvironment(undefined, now);
}

export function getLocalSignalEvaluation(
  data: RadarData | null,
  now: Date = new Date(),
  localObservationSignals: Array<LocalObservationSignal> = LOCAL_OBSERVATION_SIGNALS,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): LocalSignalEvaluation {
  const environment = data?.codex_environment ?? getLocalSignalEnvironment(undefined, now, localObservationSignals);
  const latestResetAt = getLastGlobalResetAt(data, now, canonicalHistoryContext);
  const localStatusSignals = localObservationSignals.filter(
    (signal) =>
      signal.type === "status_incident" &&
      isCurrentLocalSignal(signal, now) &&
      isWithinHours(signal.observedAt, 24, now),
  );
  const statusIncidents = evaluateStatusIncidents({
    incidents: (data?.openai_status_history ?? []).filter(
      (item) => item.source === "openai_status",
    ),
    latestResetAt,
    now,
    suppressOpenAIIncidents:
      environment.openai_status_incidents_suppressed ?? false,
    affectedCodexComponents:
      environment.openai_status_affected_codex_components ?? 0,
    maxWeightedScore:
      LOCAL_PROBABILITY_WEIGHTS.countLimits.statusIncidents,
    localIncidents: localStatusSignals.map((signal) => ({
      id: signal.id,
      impact: "minor",
    })),
  });
  const complaintPressure = deriveComplaintPressure({
    communityMentions: environment.community_mentions_24h ?? 0,
    issueAnomalies: environment.issue_or_limit_anomalies_24h ?? 0,
    activeStatusIncidents: statusIncidents.activeStatusIncidentCount,
    statusIncidents: statusIncidents.includedIncidentCount,
    officialIncidentHints: environment.official_incident_hints_24h ?? 0,
  });

  return {
    environment,
    statusIncidents,
    complaintPressure,
    latestResetAt,
  };
}

export function getLatestActiveLocalSignal(
  type: LocalObservationSignal["type"],
  now: Date = new Date(),
) {
  return LOCAL_OBSERVATION_SIGNALS.filter(
    (signal) => signal.type === type && isCurrentLocalSignal(signal, now),
  )
    .sort((a, b) => getDateTime(b.observedAt) - getDateTime(a.observedAt))
    .at(0);
}

export function getEffectiveSignalStatus(
  signal: LocalObservationSignal,
  now: Date = new Date(),
) {
  const nowTime = now.getTime();
  if (
    signal.resolvedAt &&
    getDateTime(signal.resolvedAt) <= nowTime
  ) {
    return "resolved";
  }

  // 1. 有効期限 (expiresAt) がすでに切れている場合は expired とする
  if (
    signal.status === "expired" ||
    (signal.status !== "resolved" &&
      signal.expiresAt &&
      getDateTime(signal.expiresAt) > 0 &&
      getDateTime(signal.expiresAt) <= nowTime)
  ) {
    return "expired";
  }

  // 2. 自動完了ロジック:
  // 予定時刻 (expectedAt) を過ぎている場合、通常は完了 (resolved) とする。
  // ただし、有効期限 (expiresAt) が未来である場合は、その期限までは active を維持する。
  if (
    signal.expectedAt &&
    getDateTime(signal.expectedAt) > 0 &&
    getDateTime(signal.expectedAt) <= nowTime
  ) {
    if (signal.expiresAt && getDateTime(signal.expiresAt) > nowTime) {
      return signal.status ?? "active";
    }
    return "resolved";
  }

  return signal.status ?? "active";
}

export function isCurrentLocalSignal(
  signal: LocalObservationSignal,
  now: Date = new Date(),
) {
  return getEffectiveSignalStatus(signal, now) === "active";
}

function getLatestAcceptedTiboExecutionAt(
  data: RadarData | null | undefined,
  now: Date = new Date(),
) {
  // Keep the historical execution cutoff on raw/formal inputs. The logical
  // projection may suppress a superseded public version, but it must not erase
  // the reset boundary used to evaluate subsequent signals.
  const executions = [
    ...(data?.active_tibo_signals ?? []),
    ...(data?.formal_tibo_resets ?? []),
  ].flatMap((signal) => {
    if (
      signal.signal_type !== "reset_executed" ||
      (signal.confidence ?? 0) < 0.95 ||
      signal.verification_status === "rejected"
    ) {
      return [];
    }

    const timestamp = new Date(signal.tweet_created_at).getTime();
    return Number.isNaN(timestamp) || timestamp > now.getTime() ? [] : [timestamp];
  });
  const latestTimestamp = Math.max(...executions, Number.NEGATIVE_INFINITY);

  return Number.isFinite(latestTimestamp) ? new Date(latestTimestamp) : null;
}

export function getActiveOfficialNotice(
  data: RadarData | null,
  latestResetAt?: Date | null,
  now: Date = new Date(),
  localObservationSignals: Array<LocalObservationSignal> = LOCAL_OBSERVATION_SIGNALS,
  resetExecutionWindow: ResetExecutionWindow | null = null,
  requireExecutionWindowMatch = false,
  includeTerminatedExecutionEvidence = false,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): ActiveOfficialNotice | null {
  const recoveryBoundaryAt = getLastResetBoundaryAt(data, now, canonicalHistoryContext);
  const suppliedResetTime = latestResetAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const recoveryBoundaryTime = recoveryBoundaryAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const resolvedLatestResetAt = suppliedResetTime >= recoveryBoundaryTime
    ? latestResetAt
    : recoveryBoundaryAt;
  const latestExecutionAt = getLatestAcceptedTiboExecutionAt(data, now);
  const dynamicRecoveryBoundaryAt = getLastRecoveryResetAt(data, now, [], canonicalHistoryContext);
  const dynamicRandomRecoveryWindow = getLastRandomRecoveryResetWindow(data, now, [], canonicalHistoryContext);
  const activeResetExecutionWindow = dynamicRecoveryBoundaryAt &&
      dynamicRandomRecoveryWindow?.executionWindowEndAt === dynamicRecoveryBoundaryAt
    ? dynamicRandomRecoveryWindow
    : resetExecutionWindow;
  // Prefer a dynamic canonical boundary over a later completion post. If the
  // current data has no dynamic boundary, preserve the legacy Tibo-only and
  // static-history cutoff behavior. A newer confirmed reset boundary must never
  // be superseded by an older dynamic boundary.
  const cutoff = dynamicRecoveryBoundaryAt &&
      getDateTime(dynamicRecoveryBoundaryAt) >= (resolvedLatestResetAt?.getTime() ?? Number.NEGATIVE_INFINITY)
    ? getDateTime(dynamicRecoveryBoundaryAt)
    : Math.max(
        resolvedLatestResetAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        latestExecutionAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      );
  const rawSignals: Array<ActiveTiboSignal> = expandTiboSignalVariants(Array.from(new Map(
    [
      ...getTiboReadSideSignals(
        data,
        "active",
        false,
        canonicalHistoryContext?.readSideProjection,
      ),
      ...getTiboReadSideSignals(
        data,
        "recent",
        false,
        canonicalHistoryContext?.readSideProjection,
      ),
    ].map((signal) => [signal.tweet_id, signal] as const),
  ).values()));
  const dynamicNotices: Array<ActiveOfficialNotice> = rawSignals
    .flatMap((signal) => {
      const consumption = getOfficialNoticeConsumption(signal.tweet_id);
      const isPersistent = consumption === "persistent";
      if (
        signal.signal_type !== "official_notice" ||
        signal.is_reply === true ||
        (signal.confidence ?? 0) < 0.95 ||
        signal.verification_status === "rejected" ||
        (isOfficialNoticeTerminatedAt(signal.tweet_id, now) && !includeTerminatedExecutionEvidence) ||
        (!isPersistent && isSupersededBankedNotice(signal, rawSignals))
      ) {
        return [];
      }

      const observedTime = new Date(signal.tweet_created_at).getTime();
      const expiresTime = signal.expires_at ? new Date(signal.expires_at).getTime() : Number.NaN;
      const initialWindowEnd = [signal.expected_end_at, signal.expires_at]
        .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)[0];
      const persistentAfterInitialWindow = isPersistent &&
        Number.isFinite(initialWindowEnd) &&
        initialWindowEnd <= now.getTime();
      const latestBoundaryTime = cutoff === Number.NEGATIVE_INFINITY ? null : cutoff;
      const secondaryFollowsThisBoundary = signal.is_secondary_future_signal === true &&
        new Date(signal.primary_event_at ?? "").getTime() === cutoff;
      const temporalResolution = getSignalTemporalWindow(signal);
      const temporalRelation = getTemporalExecutionWindowRelation(
        temporalResolution,
        activeResetExecutionWindow,
      );
      if (
        requireExecutionWindowMatch &&
        activeResetExecutionWindow &&
        temporalRelation !== "overlap" &&
        temporalRelation !== "unknown"
      ) {
        return [];
      }
      const executionWindowMatched = requireExecutionWindowMatch &&
        activeResetExecutionWindow !== null &&
        temporalRelation === "overlap";
      const consumedByExecutionWindow = temporalRelation === "before"
        ? false
        : temporalRelation === "overlap"
          ? true
          : temporalRelation === "after"
            ? false
            : isTemporalNoticeConsumedAtReset(
                temporalResolution
                  ? {
                      status: temporalResolution.status,
                      temporalPrecision: getEffectiveTemporalPrecision({
                        status: temporalResolution.status,
                        temporalPrecision: signal.temporal_precision ?? signal.ai_temporal_precision,
                        expectedStartAt: signal.expected_start_at,
                        expectedEndAt: signal.expected_end_at,
                      }) ?? "unknown",
                      expectedStartAt: signal.expected_start_at ?? null,
                      expectedEndAt: signal.expected_end_at ?? null,
                    }
                  : null,
                latestBoundaryTime === null ? null : new Date(latestBoundaryTime),
              );
      if (
        Number.isNaN(observedTime) ||
        observedTime > now.getTime() ||
        (!isPersistent && Number.isNaN(expiresTime)) ||
        (!isPersistent && expiresTime <= now.getTime()) ||
        (!isPersistent && !executionWindowMatched && temporalRelation === "after" && !secondaryFollowsThisBoundary) ||
        (!isPersistent && !executionWindowMatched && observedTime < cutoff && consumedByExecutionWindow) ||
        (!isPersistent && !executionWindowMatched && observedTime === cutoff && !secondaryFollowsThisBoundary && consumedByExecutionWindow)
      ) {
        return [];
      }

      return [toDynamicOfficialNotice(signal, { persistentAfterInitialWindow })];
    });
  const localNotices = localObservationSignals
    .filter(
      (signal) =>
        signal.type === "official_notice" &&
        isCurrentLocalSignal(signal, now) &&
        getDateTime(signal.observedAt) <= now.getTime() &&
        !Number.isNaN(new Date(signal.observedAt).getTime()),
    )
    .map((signal): ActiveOfficialNotice => ({
      origin: "local",
      id: signal.id,
      title: signal.title ?? null,
      summary: signal.title ?? null,
      observedAt: signal.observedAt,
      expectedAt: signal.expectedAt ?? null,
      expectedEndAt: signal.expectedEndAt ?? null,
      expiresAt: signal.expiresAt ?? null,
      source: signal.source ?? null,
      sourceLabel: signal.sourceLabel,
      isBankedDistribution: false,
      consumption: "one_shot",
    }));

  const representativeDynamicNotice = dynamicNotices
    .slice()
    .sort((left, right) => compareTiboNoticeSpecificity(
      {
        tweet_id: left.id,
        text: left.text ?? left.title ?? "",
        tweet_url: left.source ?? "",
        tweet_created_at: left.observedAt,
        signal_type: "official_notice",
        confidence: 1,
        verification_status: "auto_unverified",
        temporal_precision: left.temporalPrecision ?? null,
        temporal_timezone: left.temporalTimezone ?? null,
        expected_start_at: left.expectedAt,
        expected_end_at: left.expectedEndAt,
        temporal_resolution_status: left.temporalResolutionStatus ?? null,
      } satisfies TiboNoticeSignal,
      {
        tweet_id: right.id,
        text: right.text ?? right.title ?? "",
        tweet_url: right.source ?? "",
        tweet_created_at: right.observedAt,
        signal_type: "official_notice",
        confidence: 1,
        verification_status: "auto_unverified",
        temporal_precision: right.temporalPrecision ?? null,
        temporal_timezone: right.temporalTimezone ?? null,
        expected_start_at: right.expectedAt,
        expected_end_at: right.expectedEndAt,
        temporal_resolution_status: right.temporalResolutionStatus ?? null,
      } satisfies TiboNoticeSignal,
    ))[0] ?? null;

  return [
    ...(representativeDynamicNotice ? [representativeDynamicNotice] : []),
    ...localNotices,
  ]
    .sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime())
    .at(0) ?? null;
}

/**
 * Legacy compatibility selector for callers that still need the old
 * presentation-only policy view. The production dashboard now resolves
 * registered persistent notices through getActiveOfficialNotice instead.
 */
export function getOngoingBankedNotice(
  data: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): ActiveOfficialNotice | null {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return null;

  // A recurring policy remains informational after its first delivery window
  // expires. Use the retained recent signal set so that the one-shot delivery
  // expiry does not consume the ongoing policy notice.
  const rawSignals = expandTiboSignalVariants(getTiboReadSideSignals(
    data,
    "recent",
    false,
    canonicalHistoryContext?.readSideProjection,
  ));
  return rawSignals
    .filter((signal) => {
      if (
        signal.signal_type !== "official_notice" ||
        signal.is_reply === true ||
        (signal.confidence ?? 0) < 0.95 ||
        signal.verification_status === "rejected" ||
        isOfficialNoticeTerminatedAt(signal.tweet_id, now) ||
        !isRecurringConditionalBankedDistributionNotice(signal.text) ||
        isSupersededBankedNotice(signal, rawSignals)
      ) {
        return false;
      }

      const observedTime = Date.parse(signal.tweet_created_at);
      return Number.isFinite(observedTime) && observedTime <= nowTime;
    })
    .map((signal) => toDynamicOfficialNotice(signal, { ongoingBankedDistribution: true }))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
}

export function getRecent7DayResetCount(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): number {
  const nowTime = now.getTime();
  const sevenDaysAgo = nowTime - 7 * 24 * 60 * 60 * 1000;
  const combinedHistory = canonicalHistoryContext?.defaultHistory ?? (() => {
    const {
      noticeSignals,
      bankedSignals,
      recoveryObservations,
      estimates,
      identityContext,
    } = getNoticeBackedHistoryInputs(data);
    return combineResetHistory(
      LOCAL_RESET_HISTORY,
      data?.formal_tibo_resets ?? [],
      data?.rejected_tibo_resets ?? [],
      data?.regular_reset_events ?? [],
      noticeSignals,
      recoveryObservations,
      estimates,
      bankedSignals,
      identityContext,
    );
  })();

  return combinedHistory.filter((item) => {
    const time = getCompletedResetTimestamp(item);
    return isEligibleRandomResetEvent(item, time, nowTime) && time! >= sevenDaysAgo;
  }).length;
}

export function getMomentumBoost(
  period: "24h" | "48h",
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): number {
  const count = getRecent7DayResetCount(data, now, canonicalHistoryContext);
  const weightKey = period === "24h" ? "within24h" : "within48h";
  const daysSince = getDaysSinceLastGlobalReset(data, now, canonicalHistoryContext);

  let rawBoost = 0;
  if (count >= 4) {
    rawBoost = LOCAL_PROBABILITY_WEIGHTS.momentumBoost.level2[weightKey];
  } else if (count === 3) {
    rawBoost = LOCAL_PROBABILITY_WEIGHTS.momentumBoost.level1[weightKey];
  }

  if (daysSince === null) {
    return rawBoost;
  }

  // 0〜1日目はクールダウン期のため、ラッシュ期ブーストを抑制する
  if (daysSince < 1) {
    return 0;
  }
  if (daysSince < 2) {
    return rawBoost * 0.5;
  }

  return rawBoost;
}

export function getLocalHistoryPressure(
  period: "24h" | "48h",
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const daysSinceLastReset = getDaysSinceLastGlobalReset(data, now, canonicalHistoryContext);
  if (daysSinceLastReset === null) {
    return 0;
  }

  const weightKey = period === "24h" ? "within24h" : "within48h";
  const pressure = LOCAL_PROBABILITY_WEIGHTS.historyPressure.find(
    (item) => daysSinceLastReset <= item.maxDaysSinceReset,
  );

  return pressure?.[weightKey] ?? 0;
}

export function getElapsedDayBoost(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const daysSinceLastReset = getDaysSinceLastGlobalReset(data, now, canonicalHistoryContext);
  if (daysSinceLastReset === null) {
    return 0;
  }

  return daysSinceLastReset * LOCAL_PROBABILITY_WEIGHTS.elapsedDayBoost.perDay;
}

export function getDaysSinceLastGlobalReset(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const lastReset = getLastGlobalResetAt(data, now, canonicalHistoryContext);
  if (!lastReset) {
    return null;
  }

  return Math.max(0, (now.getTime() - lastReset.getTime()) / (24 * 60 * 60 * 1000));
}

export function getLastGlobalResetAt(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const combinedHistory = canonicalHistoryContext?.defaultHistory ?? (() => {
    const {
      noticeSignals,
      bankedSignals,
      recoveryObservations,
      estimates,
      identityContext,
    } = getNoticeBackedHistoryInputs(data);
    return combineResetHistory(
      LOCAL_RESET_HISTORY,
      data?.formal_tibo_resets ?? [],
      data?.rejected_tibo_resets ?? [],
      data?.regular_reset_events ?? [],
      noticeSignals,
      recoveryObservations,
      estimates,
      bankedSignals,
      identityContext,
    );
  })();
  const candidates = combinedHistory.map((item) => {
    const time = getCompletedResetTimestamp(item);
    return isEligibleRandomResetEvent(item, time, now.getTime())
      ? new Date(time!).toISOString()
      : null;
  });

  const latestOfficialStr = getLatestIsoDate(candidates);
  const latestOfficialAt = latestOfficialStr ? new Date(latestOfficialStr) : null;
  return latestOfficialAt;
}

/**
 * UI boundary only: a completed regular reset consumes earlier teaser
 * signals and restarts the elapsed-time display. Regular events are not
 * eligible random target events and therefore never affect probability code.
 */
export function getLastResetBoundaryAt(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const latestBoundary = getLastRecoveryResetAt(data ?? null, now, LOCAL_RESET_HISTORY, canonicalHistoryContext);
  return latestBoundary ? new Date(latestBoundary) : null;
}

export function getLastDisplayResetAt(
  data?: RadarData | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  return getLastResetBoundaryAt(data, now, canonicalHistoryContext);
}

export function getLocalExpectationLevel(
  data: RadarData | null,
  locale: Locale = "ja",
  signalEvaluation?: LocalSignalEvaluation,
  activeOfficialNotice?: ActiveOfficialNotice | null,
  regularResetExpectedAt?: string | null,
  now: Date = new Date(),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const resolvedSignalEvaluation = signalEvaluation ?? getLocalSignalEvaluation(data, now, LOCAL_OBSERVATION_SIGNALS, canonicalHistoryContext);
  const resolvedOfficialNotice = activeOfficialNotice === undefined
    ? getActiveOfficialNotice(data, resolvedSignalEvaluation.latestResetAt, now, LOCAL_OBSERVATION_SIGNALS, null, false, false, canonicalHistoryContext)
    : activeOfficialNotice;
  const probability24h = getLocalResetProbability(
    data,
    "24h",
    resolvedSignalEvaluation,
    resolvedOfficialNotice,
    now,
    regularResetExpectedAt,
    canonicalHistoryContext,
  );
  const probability48h = getLocalResetProbability(
    data,
    "48h",
    resolvedSignalEvaluation,
    resolvedOfficialNotice,
    now,
    regularResetExpectedAt,
    canonicalHistoryContext,
  );
  return getExpectationLabel({ p24h: probability24h, p48h: probability48h }, locale);
}

export function getLocalProbabilityReason(
  data: RadarData | null,
  probability24h: number | undefined,
  probability48h: number | undefined,
  locale: Locale = "ja",
  signalEvaluation?: LocalSignalEvaluation,
  activeOfficialNotice?: ActiveOfficialNotice | null,
  includeMomentumReason = true,
  now: Date = new Date(),
  probability12h?: number,
  probability72h?: number,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): string | null {
  const resolvedSignalEvaluation = signalEvaluation ?? getLocalSignalEvaluation(data, now, LOCAL_OBSERVATION_SIGNALS, canonicalHistoryContext);
  const resolvedOfficialNotice = activeOfficialNotice === undefined
    ? getActiveOfficialNotice(data, resolvedSignalEvaluation.latestResetAt, now, LOCAL_OBSERVATION_SIGNALS, null, false, false, canonicalHistoryContext)
    : activeOfficialNotice;
  const environment = resolvedSignalEvaluation.environment;
  // Keep the 12h/72h inputs for the existing internal calculation path, while
  // limiting public reasoning text to the two displayed horizons.
  void probability12h;
  void probability72h;

  if (resolvedOfficialNotice) {
    return getOfficialNoticeTimingReason(locale);
  }

  const p24 = probabilityToPercent(probability24h, locale);
  const p48 = probabilityToPercent(probability48h, locale);
  const issueAnomalies = environment.issue_or_limit_anomalies_24h ?? 0;
  const communityMentions = environment.community_mentions_24h ?? 0;
  const officialIncidentHints = environment.official_incident_hints_24h ?? 0;
  const officialUpdates = environment.official_updates_24h ?? 0;
  let lastResetLabel = "";
  const displayLastReset = getLastDisplayResetAt(data, now, canonicalHistoryContext);
  if (displayLastReset) {
    const elapsedDuration = formatElapsedResetDuration(
      Math.max(0, now.getTime() - displayLastReset.getTime()),
      locale,
    );
    if (locale === "en") {
      lastResetLabel = `It has been ${elapsedDuration} since the last reset`;
    } else if (locale === "zh") {
      lastResetLabel = `距离上次重置已过去${elapsedDuration}`;
    } else {
      lastResetLabel = `直近のリセットから${elapsedDuration}経過`;
    }
  } else {
    lastResetLabel = locale === "en" ? "unknown days have passed since the last reset" : locale === "zh" ? "自上次重置以来的天数未知" : "直近のリセットから経過日数不明";
  }

  const statusSummary = formatStatusIncidentReason(
    resolvedSignalEvaluation.statusIncidents,
    locale,
  );
  let signalSummary = statusSummary;
  if (locale === "en") {
    const extraParts: Array<string> = [];
    if (officialUpdates > 0) {
      extraParts.push("a reset-related developer signal is active");
    }
    if (issueAnomalies > 0) {
      extraParts.push("usage limit anomalies are reported");
    }
    if (communityMentions > 0) {
      extraParts.push("community reports regarding resets are observed");
    }

    if (extraParts.length > 0) {
      signalSummary = `${statusSummary} Additional signals indicate ${extraParts.join(" and ")}.`;
    }
  } else if (locale === "zh") {
    const extraParts: Array<string> = [];
    if (officialUpdates > 0) {
      extraParts.push("存在官方公告与预告");
    }
    if (issueAnomalies > 0) {
      extraParts.push("有使用限制异常的报告");
    }
    if (communityMentions > 0) {
      extraParts.push("有社区关于重置的讨论");
    }

    if (extraParts.length > 0) {
      signalSummary = `${statusSummary} 此外，${extraParts.join("，")}。`;
    }
  } else {
    const extraParts: Array<string> = [];
    if (officialUpdates > 0) {
      extraParts.push("公式からの予告・アナウンスがあります");
    }
    if (issueAnomalies > 0) {
      extraParts.push("利用上限まわりの異常報告があります");
    }
    if (communityMentions > 0) {
      extraParts.push("コミュニティ上でリセット報告があります");
    }

    if (extraParts.length > 0) {
      signalSummary = `${statusSummary} また、${extraParts.join("、")}。`;
    }
  }

  const activeHintSignals = LOCAL_OBSERVATION_SIGNALS.filter(
    (signal) =>
      signal.type === "official_incident_hint" &&
      isCurrentLocalSignal(signal, now)
  );

  let hintSummary: string | null = null;
  if (activeHintSignals.length > 0) {
    if (locale === "en") {
      hintSummary = "Official developer signals hinting at updates or resets have been observed.";
    } else if (locale === "zh") {
      hintSummary = "检测到来自官方开发者关于更新或重置的预告提示。";
    } else {
      hintSummary = "公式開発者から更新やリセットを示唆する投稿・シグナルが確認されています。";
    }
  }
  const combinedSignalSummary = hintSummary
    ? `${signalSummary} ${hintSummary}`
    : signalSummary;

  const activeBoostSignals = LOCAL_OBSERVATION_SIGNALS.filter(
    (signal) =>
      (signal.type === "probability_boost" ||
        typeof signal.boostValue24h === "number" ||
        typeof signal.boostValue48h === "number" ||
        typeof signal.boostValue === "number") &&
      isCurrentLocalSignal(signal, now)
  );

  const activeBoostSignalsWithReason = activeBoostSignals.filter(
    (sig) =>
      !!sig.boostReason &&
      ((sig.boostValue24h ?? sig.boostValue ?? 0) > 0 ||
        (sig.boostValue48h ?? sig.boostValue ?? 0) > 0)
  );

  let boostText = "";
  if (activeBoostSignalsWithReason.length > 0) {
    if (locale === "en") {
      const reasons = activeBoostSignalsWithReason.map(sig => translateDynamic(sig.boostReason ?? sig.title, locale)).join(" and ");
      boostText = ` The probability is higher than usual because of ${reasons}.`;
    } else if (locale === "zh") {
      const has9m = activeBoostSignalsWithReason.some(sig => sig.id.includes("9m"));
      const hasGpt56 = activeBoostSignalsWithReason.some(sig => (sig.boostReason ?? sig.title).includes("5.6"));
      if (has9m && hasGpt56) {
        boostText = " 考虑到可能为庆祝活跃用户达到 900 万而进行重置，以及 GPT-5.6 发布相关的庆祝活动，本次预测概率高于平时。";
      } else {
        const reasons = activeBoostSignalsWithReason.map(sig => translateDynamic(sig.boostReason ?? sig.title, locale)).join("和");
        boostText = ` 由于${reasons}，本次预测概率高于平时。`;
      }
    } else {
      const reasons = activeBoostSignalsWithReason.map(sig => translateDynamic(sig.boostReason ?? sig.title, locale)).join("および");
      boostText = ` ${reasons}のため、通常より確率を高く予測しています。`;
    }
  }

  const resetCount7d = getRecent7DayResetCount(data, now, canonicalHistoryContext);
  const currentMomentum = getMomentumBoost("48h", data, now, canonicalHistoryContext);
  let momentumText = "";
  if (includeMomentumReason && currentMomentum > 0) {
    if (resetCount7d >= 4) {
      const text = "直近7日間でリセットが4回以上発生しており、連続リセットウェーブ（ラッシュ期）に入っているため予測確率を大幅に上昇補正しています。";
      momentumText = ` ${translateDynamic(text, locale)}`;
    } else if (resetCount7d === 3) {
      const text = "直近7日間でリセットが3回発生しており、リセット頻度が高まっているため予測確率を上昇補正しています。";
      momentumText = ` ${translateDynamic(text, locale)}`;
    }
  }


  if (locale === "en") {
    const horizonSummary = `${p24} within 24 hours and ${p48} within 48 hours`;
    return `The current forecast is ${horizonSummary}. It starts with a baseline derived from past reset intervals and is adjusted using current observable signals. ${lastResetLabel}. ${combinedSignalSummary}${boostText}${momentumText}`;
  } else if (locale === "zh") {
    const horizonSummary = `24 小时内 ${p24}、48 小时内 ${p48}`;
    return `当前预测为 ${horizonSummary}。预测先根据过去的重置间隔计算基础概率，再根据当前观测信号进行调整。${lastResetLabel}，${combinedSignalSummary}${boostText}${momentumText}`;
  } else {
    const horizonSummary = `24時間以内${p24}・48時間以内${p48}`;
    return `現在の見立ては${horizonSummary}です。過去のリセット間隔から基礎確率を算出し、現在の観測シグナルで補正しています。${lastResetLabel}で、${combinedSignalSummary}${boostText}${momentumText}`;
  }
}

type DisplayProbabilityModelContext = {
  source:
    | "calibrated"
    | "shadow"
    | "stable-shadow-fallback"
    | "legacy-shadow-fallback"
    | "heuristic-fallback";
  shadow?: unknown;
  stableShadow?: unknown;
  majorModelReleaseAdjustment?: MajorModelReleaseAdjustment;
};

type DisplayHazardBin = {
  startHour: number;
  endHour: number | null;
  posteriorLambdaPerHour: number;
};

type DisplayElapsedDiagnostics = {
  bins: DisplayHazardBin[];
  globalLambdaPerHour: number;
};

type DisplayHazardReason =
  | "cooldown"
  | "low"
  | "approaching"
  | "overlap"
  | "very_high"
  | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDisplayHazardBins(value: unknown): DisplayHazardBin[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const record = asRecord(item);
      const startHour = asFiniteNumber(record?.startHour);
      const endHour = record?.endHour === null
        ? null
        : asFiniteNumber(record?.endHour);
      const posteriorLambdaPerHour = asFiniteNumber(record?.posteriorLambdaPerHour);

      if (
        startHour === null ||
        endHour === undefined ||
        posteriorLambdaPerHour === null ||
        posteriorLambdaPerHour < 0 ||
        (endHour !== null && endHour <= startHour)
      ) {
        return null;
      }

      return { startHour, endHour, posteriorLambdaPerHour };
    })
    .filter((bin): bin is DisplayHazardBin => bin !== null)
    .sort((left, right) => left.startHour - right.startHour);
}

function getPublishedElapsedDiagnostics(
  publishedCalculation?: DisplayProbabilityModelContext,
): DisplayElapsedDiagnostics | null {
  if (
    publishedCalculation?.source !== "calibrated" &&
    publishedCalculation?.source !== "shadow" &&
    publishedCalculation?.source !== "stable-shadow-fallback"
  ) return null;

  const shadow = asRecord(publishedCalculation.stableShadow ?? publishedCalculation.shadow);
  const regimeElapsed = asRecord(shadow?.regimeElapsed);
  if (regimeElapsed?.mode !== "elapsed-only") return null;

  const hazard = asRecord(shadow?.hazard);
  const bins = readDisplayHazardBins(hazard?.bins ?? regimeElapsed?.bins);
  const globalLambdaPerHour = asFiniteNumber(hazard?.globalLambdaPerHour);

  if (bins.length === 0 || globalLambdaPerHour === null || globalLambdaPerHour <= 0) {
    return null;
  }

  return { bins, globalLambdaPerHour };
}

function getDisplayHazardRateAtAge(
  bins: DisplayHazardBin[],
  ageHours: number,
) {
  if (bins.length === 0) return null;

  const normalizedAge = Math.max(0, ageHours);
  let index = bins.findIndex(
    (bin) => normalizedAge >= bin.startHour &&
      (bin.endHour === null || normalizedAge < bin.endHour),
  );
  if (index < 0) index = normalizedAge < bins[0].startHour ? 0 : bins.length - 1;

  const current = bins[index];
  const next = bins[index + 1];
  if (!next || current.endHour === null || current.endHour <= current.startHour) {
    return current.posteriorLambdaPerHour;
  }

  const progress = Math.min(
    1,
    Math.max(0, (normalizedAge - current.startHour) / (current.endHour - current.startHour)),
  );
  return current.posteriorLambdaPerHour +
    (next.posteriorLambdaPerHour - current.posteriorLambdaPerHour) * progress;
}

function getAverageDisplayHazard(
  diagnostics: DisplayElapsedDiagnostics,
  startHour: number,
  endHour: number,
) {
  if (endHour <= startHour) return null;

  const sampleCount = Math.max(4, Math.ceil((endHour - startHour) / 6));
  let total = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleAge = startHour + ((index + 0.5) / sampleCount) * (endHour - startHour);
    const rate = getDisplayHazardRateAtAge(diagnostics.bins, sampleAge);
    if (rate === null) return null;
    total += rate;
  }

  return total / sampleCount;
}

function getDisplayHazardReason(
  diagnostics: DisplayElapsedDiagnostics | null,
  elapsedHours: number,
  expectationKey: Exclude<ExpectationKey, "unknown">,
): DisplayHazardReason {
  if (!diagnostics) return null;

  const currentRate = getDisplayHazardRateAtAge(diagnostics.bins, elapsedHours);
  const futureRate = getAverageDisplayHazard(
    diagnostics,
    elapsedHours + 24,
    elapsedHours + 48,
  );
  if (currentRate === null || futureRate === null) return null;

  const currentRatio = currentRate / diagnostics.globalLambdaPerHour;
  const futureRatio = futureRate / diagnostics.globalLambdaPerHour;

  if (expectationKey === "low" && elapsedHours < 24 && currentRatio < 0.9) {
    return "cooldown";
  }
  if (expectationKey === "low" && futureRatio <= 0.85) {
    return "low";
  }
  if (expectationKey === "very_high" && futureRatio >= 1.5) {
    return "very_high";
  }
  if (expectationKey === "high" && futureRatio >= 1.1) {
    return "overlap";
  }
  if (expectationKey === "medium" && futureRatio >= 1.1) {
    return "approaching";
  }

  return null;
}

function replaceElapsedPlaceholder(text: string, elapsed: string) {
  return text.replace("{elapsed}", elapsed);
}

function replaceTeaserWindowPlaceholders(text: string, start: string, end: string) {
  return text.replace("{start}", start).replace("{end}", end);
}

function getTimedTeaserForOutlook(
  data: RadarData,
  latestResetAt: string | null,
  now: Date,
  strength: "strong" | "weak",
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  const sourceSignals = getTiboReadSideSignals(
    data,
    "recent",
    false,
    canonicalHistoryContext?.readSideProjection,
  );
  return getTeaserStrengthSignals(sourceSignals, latestResetAt, now, { includeReplies: true })
    .filter((signal) => {
      const effectiveStrength = getEffectiveTeaserStrength(signal);
      const start = signal.expected_start_at ? Date.parse(signal.expected_start_at) : Number.NaN;
      const end = signal.expected_end_at ? Date.parse(signal.expected_end_at) : Number.NaN;
      return effectiveStrength === strength &&
        signal.temporal_resolution_status === "resolved" &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end + TIBO_NOTICE_GRACE_MS >= now.getTime();
    })
    .sort((left, right) =>
      new Date(right.tweet_created_at).getTime() - new Date(left.tweet_created_at).getTime()
    )
    .at(0) ?? null;
}

function getTimedTeaserOutlookText(
  locale: Locale,
  signal: ReturnType<typeof getTimedTeaserForOutlook>,
  strength: "strong" | "weak",
  now: Date,
) {
  if (!signal?.expected_start_at || !signal.expected_end_at) return null;
  const endTime = Date.parse(signal.expected_end_at);
  const isGracePeriod = Number.isFinite(endTime) && endTime < now.getTime();
  return replaceTeaserWindowPlaceholders(
    translateUI(
      isGracePeriod
        ? strength === "strong"
          ? "outlookStrongTimedTeaserGrace"
          : "outlookWeakTimedTeaserGrace"
        : strength === "strong"
          ? "outlookStrongTimedTeaser"
          : "outlookWeakTimedTeaser",
      locale,
    ),
    formatDateTime(signal.expected_start_at, locale),
    formatDateTime(signal.expected_end_at, locale),
  );
}

function getGenericOutlookKey(
  expectationKey: Exclude<ExpectationKey, "unknown">,
  hasElapsed: boolean,
) {
  const suffix = expectationKey === "very_high"
    ? "VeryHigh"
    : expectationKey === "high"
      ? "High"
      : expectationKey === "medium"
        ? "Medium"
        : "Low";
  return `outlook${hasElapsed ? "Generic" : "NoElapsed"}${suffix}`;
}

export function getDisplayProbabilityReason(
  data: RadarData | null,
  probability24h: number | undefined,
  probability48h: number | undefined,
  locale: Locale = "ja",
  signalEvaluation?: LocalSignalEvaluation,
  activeOfficialNotice?: ActiveOfficialNotice | null,
  now: Date = new Date(),
  publishedCalculation?: DisplayProbabilityModelContext,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): string | null {
  if (!data) {
    return translateUI("outlookUnavailable", locale);
  }

  const resolvedSignalEvaluation = signalEvaluation ?? getLocalSignalEvaluation(data, now, LOCAL_OBSERVATION_SIGNALS, canonicalHistoryContext);
  const resolvedOfficialNotice = activeOfficialNotice === undefined
    ? getActiveOfficialNotice(data, resolvedSignalEvaluation.latestResetAt, now, LOCAL_OBSERVATION_SIGNALS, null, false, false, canonicalHistoryContext)
    : activeOfficialNotice;

  if (resolvedOfficialNotice) {
    return getOfficialNoticeTimingReason(locale);
  }

  const environment = resolvedSignalEvaluation.environment;
  const activeIncidentCount = resolvedSignalEvaluation.statusIncidents.activeStatusIncidentCount;
  const issueAnomalyCount = environment.issue_or_limit_anomalies_24h ?? 0;
  const latestResetAt = getLastDisplayResetAt(data, now, canonicalHistoryContext)?.toISOString() ?? null;
  const teaserStatus = aggregateResetTeaserStatus(
    getTiboReadSideSignals(
      data,
      "recent",
      false,
      canonicalHistoryContext?.readSideProjection,
    ),
    latestResetAt,
    now,
  );

  if (teaserStatus === "strong") {
    const timedTeaser = getTimedTeaserForOutlook(
      data,
      latestResetAt,
      now,
      "strong",
      canonicalHistoryContext,
    );
    return getTimedTeaserOutlookText(locale, timedTeaser, "strong", now)
      ?? translateUI("outlookStrongTeaser", locale);
  }

  if (activeIncidentCount > 0 || environment.codex_operational_status === "active") {
    return translateUI("outlookActiveIncident", locale);
  }

  if (teaserStatus === "weak") {
    const timedTeaser = getTimedTeaserForOutlook(
      data,
      latestResetAt,
      now,
      "weak",
      canonicalHistoryContext,
    );
    return getTimedTeaserOutlookText(locale, timedTeaser, "weak", now)
      ?? translateUI("outlookWeakTeaser", locale);
  }

  if (issueAnomalyCount > 0) {
    return translateUI("outlookUsageAnomaly", locale);
  }

  const expectationKey = getExpectationKey({ p24h: probability24h, p48h: probability48h });
  if (expectationKey === "unknown") {
    return translateUI("outlookUnavailable", locale);
  }

  const latestRandomResetAt = getLastRandomRecoveryResetAt(data, now, LOCAL_RESET_HISTORY, canonicalHistoryContext);
  const elapsedMs = latestRandomResetAt
    ? Math.max(0, now.getTime() - new Date(latestRandomResetAt).getTime())
    : null;
  const hasElapsed = elapsedMs !== null;
  const elapsed = hasElapsed
    ? formatElapsedResetDurationPrecise(elapsedMs, locale)
    : null;

  if (!hasElapsed || !elapsed) {
    return translateUI(getGenericOutlookKey(expectationKey, false), locale);
  }

  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  const hazardReason = getDisplayHazardReason(
    getPublishedElapsedDiagnostics(publishedCalculation),
    elapsedHours,
    expectationKey,
  );

  if (hazardReason === "cooldown") {
    const key = elapsedMs < 60 * 1000
      ? "outlookLowCooldownSubminute"
      : "outlookLowCooldown";
    return replaceElapsedPlaceholder(translateUI(key, locale), elapsed);
  }

  if (hazardReason === "low") {
    return replaceElapsedPlaceholder(translateUI("outlookLowHistorical", locale), elapsed);
  }

  if (hazardReason === "approaching" && expectationKey === "medium") {
    return replaceElapsedPlaceholder(translateUI("outlookModerateApproaching", locale), elapsed);
  }

  if (hazardReason === "overlap" && expectationKey === "high") {
    return replaceElapsedPlaceholder(translateUI("outlookHighOverlap", locale), elapsed);
  }

  if (hazardReason === "very_high" && expectationKey === "very_high") {
    return replaceElapsedPlaceholder(translateUI("outlookVeryHighOverlap", locale), elapsed);
  }

  return replaceElapsedPlaceholder(
    translateUI(getGenericOutlookKey(expectationKey, true), locale),
    elapsed,
  );
}

function clampCount(value: number | undefined, min: number, max: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.min(max, Math.max(min, value));
}
