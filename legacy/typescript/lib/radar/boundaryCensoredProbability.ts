import {
  BIN_PRIOR_EQUIVALENT_EXPOSURE_DAYS,
  GLOBAL_PRIOR_EVENT_COUNT,
  GLOBAL_PRIOR_EXPOSURE_DAYS,
  HAZARD_BIN_HOURS,
  HAZARD_TAIL_START_DAYS,
  MAX_BASELINE_DAILY_PROBABILITY,
  SHADOW_CONFIDENCE_EXPOSURE_DAYS,
  SHADOW_CONFIDENCE_INTERVAL_COUNT,
  MIN_BASELINE_DAILY_PROBABILITY,
} from "@/data/shadowProbabilityConfig";
import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import { combineResetHistory, getNoticeBackedHistoryInputs } from "./tiboHistory";
import {
  applyOddsMultiplier,
  calculateShadowProbability,
  derive12hFrom24hProbability,
  derive72hFrom48hProbability,
  integrateHazardProbability,
  type ShadowHazardBin,
  type ShadowProbabilityHorizons,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
} from "./shadowProbability";
import { getCompletedResetTimestamp } from "./probability";
import { isEligibleRandomResetEvent, isBroadResetScope } from "./resetEligibility";
import type {
  HistoryRecordKind,
  RadarData,
  WindowEventLike,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;

export const BOUNDARY_CENSORED_MODEL_VERSION = "hazard-odds-v3-random-boundary-censored";
export const BOUNDARY_CENSORED_TARGET_DEFINITION =
  "Broad completed random reset events with broad completed regular resets used as observation boundaries and right-censoring points.";

type CycleType = "定期リセット" | "ランダムリセット";

export type BoundaryCensoredBoundary = {
  id: string;
  resetAt: string;
  cycleType: CycleType;
  recordKind: HistoryRecordKind | string | null;
  isRandomEvent: boolean;
};

export type BoundaryCensoredInterval = {
  startAt: string;
  endAt: string;
  durationHours: number;
  event: boolean;
  startBoundaryIds: string[];
  endBoundaryIds: string[];
};

export type BoundaryCensoredIntervalSet = {
  completed: BoundaryCensoredInterval[];
  currentRightCensoredHours: number;
  currentStartAt: string | null;
};

export type BoundaryRegularAudit = {
  id: string;
  resetAt: string | null;
  recordKind: string | null;
  scope: string | null;
  included: boolean;
  reason:
    | "accepted"
    | "not_broad_scope"
    | "future_timestamp"
    | "not_completed"
    | "invalid_timestamp"
    | "unsupported_record_kind";
};

export type BoundaryCensoredCollection = {
  boundaries: BoundaryCensoredBoundary[];
  randomEvents: BoundaryCensoredBoundary[];
  acceptedRegularBoundaries: BoundaryCensoredBoundary[];
  acceptedRegularAudits: BoundaryRegularAudit[];
  excludedRegularBoundaries: BoundaryRegularAudit[];
};

export type BoundaryCensoredHazard = {
  globalLambdaPerHour: number;
  observedEventCount: number;
  weightedEventCount: number;
  completedEventCount: number;
  completedIntervalCount: number;
  completedEventIntervalCount: number;
  censoredIntervalCount: number;
  currentRightCensoredHours: number;
  boundaryCount: number;
  totalExposureHours: number;
  weightedExposureHours: number;
  totalExposureDays: number;
  bins: Array<ShadowHazardBin>;
};

export type BoundaryCensoredAudit = {
  lastRandomResetAt: string | null;
  lastBoundaryAt: string | null;
  currentAgeHours: number;
  boundaryCount: number;
  acceptedRegularBoundaries: BoundaryRegularAudit[];
  excludedRegularBoundaries: BoundaryRegularAudit[];
  completedEventIntervalCount: number;
  censoredIntervalCount: number;
  currentRightCensoredHours: number;
};

export type BoundaryCensoredProbabilityResult = Omit<ShadowProbabilityResult, "hazard"> & {
  modelVersion: typeof BOUNDARY_CENSORED_MODEL_VERSION;
  targetDefinition: typeof BOUNDARY_CENSORED_TARGET_DEFINITION;
  hazard: BoundaryCensoredHazard;
  audit: BoundaryCensoredAudit;
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isPending(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  return item.kind === "window_opened"
    || status === "open"
    || status === "active"
    || status === "pending"
    || status === "scheduled"
    || status === "announced";
}

function getScope(item: WindowEventLike) {
  return item.scope ?? item.details?.scope ?? null;
}

function isSupportedRegularRecordKind(recordKind: string | undefined) {
  return recordKind === "confirmed_global"
    || recordKind === "banked_distribution"
    || recordKind === "reference";
}

function auditRegularItem(item: WindowEventLike, nowTime: number): BoundaryRegularAudit {
  const completedAt = getCompletedResetTimestamp(item);
  const resetAt = completedAt === null ? null : new Date(completedAt).toISOString();
  const base = {
    id: item.id ?? `regular-${resetAt ?? "unknown"}`,
    resetAt,
    recordKind: item.recordKind ?? null,
    scope: getScope(item),
  };

  if (!isSupportedRegularRecordKind(item.recordKind)) {
    return { ...base, included: false, reason: "unsupported_record_kind" };
  }
  if (isPending(item)) {
    return { ...base, included: false, reason: "not_completed" };
  }
  if (completedAt === null) {
    return { ...base, included: false, reason: "invalid_timestamp" };
  }
  if (completedAt > nowTime) {
    return { ...base, included: false, reason: "future_timestamp" };
  }
  if (!isBroadResetScope(item)) {
    return { ...base, included: false, reason: "not_broad_scope" };
  }
  return { ...base, included: true, reason: "accepted" };
}

function getBoundaryIdentity(
  item: WindowEventLike,
  completedAt: number,
  cycleType: CycleType,
) {
  const sourceUrl = item.source_url ?? "";
  const tweetId = sourceUrl.match(/\/status\/(\d+)/i)?.[1] ?? null;
  if (tweetId) return `tweet:${tweetId}:${cycleType}`;
  if (sourceUrl.includes("/status/")) return `source:${sourceUrl}:${cycleType}`;
  return `${item.id ?? "unknown"}:${completedAt}:${cycleType}`;
}

export function collectBoundaryCensoredBoundaries(
  data: RadarData | null,
  now: Date,
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
): BoundaryCensoredCollection {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) {
    return {
      boundaries: [],
      randomEvents: [],
      acceptedRegularBoundaries: [],
      acceptedRegularAudits: [],
      excludedRegularBoundaries: [],
    };
  }

  const {
    noticeSignals,
    bankedSignals,
    recoveryObservations,
    estimates,
    identityContext,
  } = getNoticeBackedHistoryInputs(data);
  const combinedHistory = combineResetHistory(
    staticHistory,
    data?.formal_tibo_resets ?? [],
    data?.rejected_tibo_resets ?? [],
    data?.regular_reset_events ?? [],
    noticeSignals,
    recoveryObservations,
    estimates,
    bankedSignals,
    identityContext,
  );
  const seen = new Set<string>();
  const boundaries: BoundaryCensoredBoundary[] = [];
  const acceptedRegularAudits: BoundaryRegularAudit[] = [];
  const excludedRegularBoundaries: BoundaryRegularAudit[] = [];

  for (const item of combinedHistory) {
    const cycleType = item.details?.cycleType;
    if (cycleType !== "定期リセット" && cycleType !== "ランダムリセット") continue;

    if (cycleType === "定期リセット") {
      const audit = auditRegularItem(item, nowTime);
      if (!audit.included) {
        excludedRegularBoundaries.push(audit);
        continue;
      }
      acceptedRegularAudits.push(audit);
    } else if (item.recordKind !== "confirmed_global" && item.recordKind !== "banked_distribution") {
      continue;
    } else if (!isEligibleRandomResetEvent(item, getCompletedResetTimestamp(item), nowTime)) {
      continue;
    }

    const completedAt = getCompletedResetTimestamp(item);
    if (completedAt === null || completedAt > nowTime) continue;
    const key = getBoundaryIdentity(item, completedAt, cycleType);
    if (seen.has(key)) continue;
    seen.add(key);
    boundaries.push({
      id: item.id ?? key,
      resetAt: new Date(completedAt).toISOString(),
      cycleType,
      recordKind: item.recordKind ?? null,
      isRandomEvent: cycleType === "ランダムリセット",
    });
  }

  boundaries.sort((left, right) => timestamp(left.resetAt)! - timestamp(right.resetAt)!);
  const acceptedRegularBoundaries = acceptedRegularAudits.map((audit) => ({
    id: audit.id,
    resetAt: audit.resetAt!,
    cycleType: "定期リセット" as const,
    recordKind: audit.recordKind,
    isRandomEvent: false,
  }));
  return {
    boundaries,
    randomEvents: boundaries.filter((boundary) => boundary.isRandomEvent),
    acceptedRegularBoundaries,
    acceptedRegularAudits,
    excludedRegularBoundaries,
  };
}

function groupBoundaries(boundaries: Array<BoundaryCensoredBoundary>, nowTime: number) {
  const groups: Array<{
    time: number;
    boundaries: BoundaryCensoredBoundary[];
    hasRandomEvent: boolean;
  }> = [];
  const sorted = boundaries
    .map((boundary) => ({ boundary, time: timestamp(boundary.resetAt) }))
    .filter((item): item is { boundary: BoundaryCensoredBoundary; time: number } =>
      item.time !== null && item.time <= nowTime,
    )
    .sort((left, right) => left.time - right.time);

  for (const item of sorted) {
    const previous = groups.at(-1);
    if (previous?.time === item.time) {
      previous.boundaries.push(item.boundary);
      previous.hasRandomEvent ||= item.boundary.isRandomEvent;
    } else {
      groups.push({
        time: item.time,
        boundaries: [item.boundary],
        hasRandomEvent: item.boundary.isRandomEvent,
      });
    }
  }
  return groups;
}

export function createBoundaryCensoredIntervals(
  boundaries: Array<BoundaryCensoredBoundary>,
  now: Date,
): BoundaryCensoredIntervalSet {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) {
    return { completed: [], currentRightCensoredHours: 0, currentStartAt: null };
  }
  const groups = groupBoundaries(boundaries, nowTime);
  const completed: BoundaryCensoredInterval[] = [];

  for (let index = 1; index < groups.length; index += 1) {
    const previous = groups[index - 1];
    const current = groups[index];
    const durationHours = (current.time - previous.time) / HOUR_MS;
    if (durationHours <= 0) continue;
    completed.push({
      startAt: new Date(previous.time).toISOString(),
      endAt: new Date(current.time).toISOString(),
      durationHours,
      event: current.hasRandomEvent,
      startBoundaryIds: previous.boundaries.map((boundary) => boundary.id),
      endBoundaryIds: current.boundaries.map((boundary) => boundary.id),
    });
  }

  const latestGroup = groups.at(-1);
  const currentRightCensoredHours = latestGroup
    ? Math.max(0, (nowTime - latestGroup.time) / HOUR_MS)
    : 0;
  return {
    completed,
    currentRightCensoredHours,
    currentStartAt: latestGroup ? new Date(latestGroup.time).toISOString() : null,
  };
}

export type BoundaryHorizonOutcome = "event" | "negative" | "censored";

export function getBoundaryCensoredHorizonOutcome(
  boundaries: Array<BoundaryCensoredBoundary>,
  origin: Date,
  horizonHours: number,
): BoundaryHorizonOutcome {
  const originTime = origin.getTime();
  if (!Number.isFinite(originTime) || !Number.isFinite(horizonHours) || horizonHours <= 0) {
    return "negative";
  }
  const horizonEnd = originTime + horizonHours * HOUR_MS;
  const firstGroup = groupBoundaries(boundaries, horizonEnd)
    .find((group) => group.time > originTime && group.time <= horizonEnd);
  if (!firstGroup) return "negative";
  return firstGroup.hasRandomEvent ? "event" : "censored";
}

function getBinIndex(ageHours: number) {
  return Math.min(
    Math.max(0, Math.floor(ageHours / HAZARD_BIN_HOURS)),
    Math.floor((HAZARD_TAIL_START_DAYS * 24) / HAZARD_BIN_HOURS),
  );
}

function createEmptyBins() {
  const binCount = Math.floor((HAZARD_TAIL_START_DAYS * 24) / HAZARD_BIN_HOURS) + 1;
  return Array.from({ length: binCount }, (_, index): ShadowHazardBin => ({
    startHour: index * HAZARD_BIN_HOURS,
    endHour: index === binCount - 1 ? null : (index + 1) * HAZARD_BIN_HOURS,
    exposureHours: 0,
    observedEvents: 0,
    posteriorLambdaPerHour: 0,
    impliedDailyProbability: 0,
  }));
}

function addExposure(bins: Array<ShadowHazardBin>, durationHours: number) {
  if (!Number.isFinite(durationHours) || durationHours <= 0) return;
  let cursor = 0;
  while (cursor < durationHours) {
    const bin = bins[getBinIndex(cursor)];
    const boundary = bin.endHour ?? Number.POSITIVE_INFINITY;
    const segmentEnd = Math.min(durationHours, boundary);
    bin.exposureHours += Math.max(0, segmentEnd - cursor);
    if (!Number.isFinite(segmentEnd) || segmentEnd <= cursor) break;
    cursor = segmentEnd;
  }
}

export function buildBoundaryCensoredHazard(
  boundaries: Array<BoundaryCensoredBoundary>,
  now: Date,
): BoundaryCensoredHazard {
  const intervals = createBoundaryCensoredIntervals(boundaries, now);
  const bins = createEmptyBins();
  let observedEventCount = 0;
  let totalExposureHours = 0;

  for (const interval of intervals.completed) {
    addExposure(bins, interval.durationHours);
    totalExposureHours += interval.durationHours;
    if (interval.event) {
      bins[getBinIndex(interval.durationHours)].observedEvents += 1;
      observedEventCount += 1;
    }
  }
  addExposure(bins, intervals.currentRightCensoredHours);
  totalExposureHours += intervals.currentRightCensoredHours;

  const globalLambdaPerHour = (
    observedEventCount + GLOBAL_PRIOR_EVENT_COUNT
  ) / (
    totalExposureHours + GLOBAL_PRIOR_EXPOSURE_DAYS * 24
  );
  const binPriorExposureHours = BIN_PRIOR_EQUIVALENT_EXPOSURE_DAYS * 24;
  const binPriorEventCount = globalLambdaPerHour * binPriorExposureHours;
  for (const bin of bins) {
    const posteriorLambda = (
      bin.observedEvents + binPriorEventCount
    ) / (
      bin.exposureHours + binPriorExposureHours
    );
    const impliedDailyProbability = Number.isFinite(posteriorLambda)
      ? Math.min(1, Math.max(0, 1 - Math.exp(-posteriorLambda * 24)))
      : 0;
    const safeDailyProbability = Math.min(
      MAX_BASELINE_DAILY_PROBABILITY,
      Math.max(MIN_BASELINE_DAILY_PROBABILITY, impliedDailyProbability),
    );
    bin.posteriorLambdaPerHour = -Math.log(1 - safeDailyProbability) / 24;
    bin.impliedDailyProbability = safeDailyProbability;
  }

  return {
    globalLambdaPerHour,
    observedEventCount,
    weightedEventCount: observedEventCount,
    completedEventCount: observedEventCount,
    completedIntervalCount: intervals.completed.length,
    completedEventIntervalCount: intervals.completed.filter((interval) => interval.event).length,
    censoredIntervalCount: intervals.completed.filter((interval) => !interval.event).length,
    currentRightCensoredHours: intervals.currentRightCensoredHours,
    boundaryCount: groupBoundaries(boundaries, now.getTime()).length,
    totalExposureHours,
    weightedExposureHours: totalExposureHours,
    totalExposureDays: totalExposureHours / 24,
    bins,
  };
}

function getConfidence(hazard: BoundaryCensoredHazard, officialNoticeActive: boolean) {
  if (officialNoticeActive) {
    return {
      level: "high" as const,
      reason: "An active official notice overrides the normal confidence tier.",
    };
  }
  if (
    hazard.completedIntervalCount >= SHADOW_CONFIDENCE_INTERVAL_COUNT
    && hazard.totalExposureDays >= SHADOW_CONFIDENCE_EXPOSURE_DAYS
  ) {
    return {
      level: "medium" as const,
      reason: "Boundary intervals and exposure meet the shadow model's medium-confidence floor.",
    };
  }
  return {
    level: "low" as const,
    reason: "The available boundary intervals or exposure are below the medium-confidence floor.",
  };
}

function adjustBaseline(
  baseline: ShadowProbabilityHorizons,
  multiplier: ShadowProbabilityResult["multipliers"]["combinedAfterCap"],
): ShadowProbabilityHorizons {
  return {
    probability12h: applyOddsMultiplier(baseline.probability12h, multiplier.probability24h),
    probability24h: applyOddsMultiplier(baseline.probability24h, multiplier.probability24h),
    probability48h: applyOddsMultiplier(baseline.probability48h, multiplier.probability48h),
    probability72h: applyOddsMultiplier(baseline.probability72h, multiplier.probability48h),
  };
}

export function calculateBoundaryCensoredProbability(
  data: RadarData | null,
  options: ShadowProbabilityOptions = {},
): BoundaryCensoredProbabilityResult {
  const now = options.now ?? new Date();
  const current = calculateShadowProbability(data, options);
  const collection = collectBoundaryCensoredBoundaries(data, now, options.staticHistory);
  const hazard = buildBoundaryCensoredHazard(collection.boundaries, now);
  const lastBoundary = collection.boundaries.at(-1)?.resetAt ?? null;
  const lastRandomResetAt = collection.randomEvents.at(-1)?.resetAt ?? null;
  const lastBoundaryTime = timestamp(lastBoundary);
  const currentAgeHours = lastBoundaryTime === null
    ? 0
    : Math.max(0, (now.getTime() - lastBoundaryTime) / HOUR_MS);
  const baseline: ShadowProbabilityHorizons = {
    probability12h: integrateHazardProbability(hazard, currentAgeHours, 12),
    probability24h: integrateHazardProbability(hazard, currentAgeHours, 24),
    probability48h: integrateHazardProbability(hazard, currentAgeHours, 48),
    probability72h: integrateHazardProbability(hazard, currentAgeHours, 72),
  };
  const adjusted = adjustBaseline(baseline, current.multipliers.combinedAfterCap);
  const officialNoticeOverride = current.officialNoticeOverride;
  const predictions = officialNoticeOverride.active
    ? {
        probability12h: officialNoticeOverride.probability12h ?? derive12hFrom24hProbability(0.9),
        probability24h: officialNoticeOverride.probability24h ?? 0.9,
        probability48h: officialNoticeOverride.probability48h ?? 0.96,
        probability72h: officialNoticeOverride.probability72h ?? derive72hFrom48hProbability(0.96),
      }
    : adjusted;
  const confidence = getConfidence(hazard, officialNoticeOverride.active);
  const acceptedRegularBoundaries = collection.acceptedRegularAudits;

  return {
    ...current,
    modelVersion: BOUNDARY_CENSORED_MODEL_VERSION,
    targetDefinition: BOUNDARY_CENSORED_TARGET_DEFINITION,
    predictions,
    baseline,
    confidence: {
      ...confidence,
      completedIntervalCount: hazard.completedIntervalCount,
      totalExposureDays: hazard.totalExposureDays,
    },
    hazard,
    audit: {
      lastRandomResetAt,
      lastBoundaryAt: lastBoundary,
      currentAgeHours,
      boundaryCount: hazard.boundaryCount,
      acceptedRegularBoundaries: acceptedRegularBoundaries,
      excludedRegularBoundaries: collection.excludedRegularBoundaries,
      completedEventIntervalCount: hazard.completedEventIntervalCount,
      censoredIntervalCount: hazard.censoredIntervalCount,
      currentRightCensoredHours: hazard.currentRightCensoredHours,
    },
  };
}
