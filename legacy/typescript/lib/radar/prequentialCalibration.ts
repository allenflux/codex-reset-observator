import type { RadarData } from "./types";
import type { ShadowResetEvent } from "./shadowProbability";
import type { OpenAIStatusHistoryItem } from "../openaiStatus";
import type { CodexRecoveryObservation } from "../codexUsageRecovery";
import type { ResetExecutionEstimate } from "./resetExecution";
import type { RegularResetEventRow } from "./regularResetSchedule";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LOGIT_EPSILON = 1e-12;

export const PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV = 0.5;
export const PREQUENTIAL_CALIBRATION_MIN_SAMPLES = 10;
export const PREQUENTIAL_MIN_COMPLETED_INTERVALS = 5;

export type PrequentialCalibrationRow = {
  recordedAt: string;
  probability24h: number;
  probability48h: number;
  actual24h: boolean;
  actual48h: boolean;
};

export type PrequentialCalibrationAudit = {
  origin: string;
  rawProbability24h: number;
  rawProbability48h: number;
  alpha24h: number;
  alpha48h: number;
  calibrationSampleCount24h: number;
  calibrationSampleCount48h: number;
  positiveCalibrationCount24h: number;
  positiveCalibrationCount48h: number;
  lastResolvedOrigin24h: string | null;
  lastResolvedOrigin48h: string | null;
  calibratedProbability24h: number;
  calibratedProbability48h: number;
};

function timestamp(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clampLogitProbability(value: number) {
  return Math.min(1 - LOGIT_EPSILON, Math.max(LOGIT_EPSILON, clampProbability(value)));
}

function logit(value: number) {
  const safe = clampLogitProbability(value);
  return Math.log(safe / (1 - safe));
}

function sigmoid(value: number) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function calibrateLogitProbability(probability: number, alpha: number) {
  if (alpha === 0) return clampProbability(probability);
  if (!Number.isFinite(alpha)) return clampProbability(probability);
  return clampProbability(sigmoid(logit(probability) + alpha));
}

export function fitLogitInterceptMAP(
  samples: Array<{ probability: number; actual: boolean }>,
  priorStdDev = PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
  minimumSamples = PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
) {
  if (
    samples.length < minimumSamples
    || !Number.isFinite(priorStdDev)
    || priorStdDev <= 0
  ) {
    return 0;
  }

  const priorPrecision = 1 / (priorStdDev * priorStdDev);
  let alpha = 0;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let gradient = -alpha * priorPrecision;
    let information = priorPrecision;
    for (const sample of samples) {
      const probability = sigmoid(logit(sample.probability) + alpha);
      gradient += Number(sample.actual) - probability;
      information += probability * (1 - probability);
    }
    const nextAlpha = Math.min(20, Math.max(-20, alpha + gradient / information));
    alpha = nextAlpha;
    if (Math.abs(gradient) < 1e-12 || Math.abs(gradient / information) < 1e-12) {
      break;
    }
  }
  return Number.isFinite(alpha) ? alpha : 0;
}

function getEligibleCalibrationRows(
  rows: Array<PrequentialCalibrationRow>,
  currentOrigin: string,
  horizonHours: number,
) {
  const currentTime = timestamp(currentOrigin);
  if (currentTime === null) return [];
  const horizonMs = horizonHours * HOUR_MS;
  return rows
    .filter((row) => {
      const pastOrigin = timestamp(row.recordedAt);
      return pastOrigin !== null
        && pastOrigin < currentTime
        && pastOrigin + horizonMs <= currentTime;
    })
    .sort((left, right) => timestamp(left.recordedAt)! - timestamp(right.recordedAt)!);
}

function getLastOrigin(rows: Array<PrequentialCalibrationRow>) {
  return rows.at(-1)?.recordedAt ?? null;
}

export function calculatePrequentialLogitCalibration(
  current: PrequentialCalibrationRow,
  pastRows: Array<PrequentialCalibrationRow>,
): PrequentialCalibrationAudit {
  const rows24h = getEligibleCalibrationRows(pastRows, current.recordedAt, 24);
  const rows48h = getEligibleCalibrationRows(pastRows, current.recordedAt, 48);
  const alpha24h = fitLogitInterceptMAP(rows24h.map((row) => ({
    probability: row.probability24h,
    actual: row.actual24h,
  })));
  const alpha48h = fitLogitInterceptMAP(rows48h.map((row) => ({
    probability: row.probability48h,
    actual: row.actual48h,
  })));

  return {
    origin: current.recordedAt,
    rawProbability24h: current.probability24h,
    rawProbability48h: current.probability48h,
    alpha24h,
    alpha48h,
    calibrationSampleCount24h: rows24h.length,
    calibrationSampleCount48h: rows48h.length,
    positiveCalibrationCount24h: rows24h.filter((row) => row.actual24h).length,
    positiveCalibrationCount48h: rows48h.filter((row) => row.actual48h).length,
    lastResolvedOrigin24h: getLastOrigin(rows24h),
    lastResolvedOrigin48h: getLastOrigin(rows48h),
    calibratedProbability24h: calibrateLogitProbability(current.probability24h, alpha24h),
    calibratedProbability48h: calibrateLogitProbability(current.probability48h, alpha48h),
  };
}

function getJstDayKey(value: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getJstMidnight(dayKey: string) {
  return new Date(`${dayKey}T00:00:00+09:00`).getTime();
}

function getJstMidnightAtOrAfter(value: number) {
  const midnight = getJstMidnight(getJstDayKey(value));
  return midnight >= value ? midnight : midnight + DAY_MS;
}

function getJstMidnightAtOrBefore(value: number) {
  return getJstMidnight(getJstDayKey(value));
}

function sortEvents(events: Array<ShadowResetEvent>) {
  return events
    .map((event) => ({ event, time: timestamp(event.resetAt) }))
    .filter((item): item is { event: ShadowResetEvent; time: number } => item.time !== null)
    .sort((left, right) => left.time - right.time)
    .map((item) => item.event);
}

export function createPrequentialOrigins(
  events: Array<ShadowResetEvent>,
  asOf: string,
  minimumCompletedIntervals: number = PREQUENTIAL_MIN_COMPLETED_INTERVALS,
  latestOriginHorizonHours = 48,
) {
  const asOfTime = timestamp(asOf);
  if (
    asOfTime === null
    || !Number.isInteger(minimumCompletedIntervals)
    || minimumCompletedIntervals < 1
    || !Number.isFinite(latestOriginHorizonHours)
    || latestOriginHorizonHours <= 0
  ) {
    throw new RangeError("asOf and minimumCompletedIntervals must be valid");
  }

  const sorted = sortEvents(events);
  const firstEligibleEvent = sorted[minimumCompletedIntervals];
  if (!firstEligibleEvent) return [];
  const firstEventTime = timestamp(firstEligibleEvent.resetAt)!;
  const firstOrigin = getJstMidnightAtOrAfter(firstEventTime);
  const lastOrigin = getJstMidnightAtOrBefore(asOfTime - latestOriginHorizonHours * HOUR_MS);
  const origins: Array<string> = [];
  for (let current = firstOrigin; current <= lastOrigin; current += DAY_MS) {
    origins.push(new Date(current).toISOString());
  }
  return origins;
}

export function getActualWithinHorizon(
  events: Array<ShadowResetEvent>,
  origin: string,
  horizonHours: number,
) {
  const originTime = timestamp(origin);
  if (originTime === null || !Number.isFinite(horizonHours) || horizonHours <= 0) {
    return false;
  }
  const end = originTime + horizonHours * HOUR_MS;
  return events.some((event) => {
    const eventTime = timestamp(event.resetAt);
    return eventTime !== null && eventTime > originTime && eventTime <= end;
  });
}

function isAvailableAt(value: string | null | undefined, originTime: number) {
  const parsed = value ? timestamp(value) : null;
  return parsed !== null && parsed <= originTime;
}

function isAfterOrigin(value: string | null | undefined, originTime: number) {
  const parsed = value ? timestamp(value) : null;
  return parsed !== null && parsed > originTime;
}

/**
 * An execution estimate is usable only after both its persisted state and its
 * displayed execution time were available. This prevents a later-created
 * estimate from making an earlier origin appear to know about a reset.
 */
export function projectResetExecutionEstimateToOrigin(
  estimate: ResetExecutionEstimate,
  origin: Date,
): ResetExecutionEstimate | null {
  const originTime = origin.getTime();
  if (
    !Number.isFinite(originTime) ||
    !isAvailableAt(estimate.createdAt, originTime) ||
    !isAvailableAt(estimate.updatedAt ?? estimate.createdAt, originTime) ||
    !isAvailableAt(estimate.displayExecutionAt, originTime)
  ) {
    return null;
  }

  const futureStateTimestamp = [
    estimate.manualOverrideAt,
    estimate.manualExecutionAt,
    estimate.tiboAnnouncedAt,
    estimate.officialNoticeAt,
    estimate.executionWindowStartAt,
    estimate.executionWindowEndAt,
    estimate.recoveryPreviousObservedAt,
    estimate.recoveryObservedAt,
  ].some((value) => isAfterOrigin(value, originTime));
  return futureStateTimestamp ? null : { ...estimate };
}

/**
 * Recovery observations may be confirmed or matched after an origin. When the
 * observation itself was already available, retain only the observed state so
 * later confirmation metadata cannot leak into the historical snapshot.
 */
export function projectCodexRecoveryObservationToOrigin(
  observation: CodexRecoveryObservation,
  origin: Date,
): CodexRecoveryObservation | null {
  const originTime = origin.getTime();
  if (
    !Number.isFinite(originTime) ||
    !isAvailableAt(observation.createdAt, originTime) ||
    !isAvailableAt(observation.observedAt, originTime) ||
    !isAvailableAt(observation.previousObservedAt, originTime)
  ) {
    return null;
  }

  const confirmationWasFuture = isAfterOrigin(observation.confirmedAt, originTime);
  const updateWasFuture = isAfterOrigin(observation.updatedAt, originTime);
  if (confirmationWasFuture || (updateWasFuture && observation.status !== "observed")) {
    return {
      ...observation,
      status: "observed",
      matchedTiboTweetId: null,
      confirmedAt: null,
    };
  }
  if (updateWasFuture) return null;
  return { ...observation };
}

export function isRegularResetEventAvailableAt(
  event: RegularResetEventRow,
  origin: Date,
) {
  const originTime = origin.getTime();
  if (!Number.isFinite(originTime) || !isAvailableAt(event.completed_at, originTime)) {
    return false;
  }

  const status = event.status.toLowerCase();
  if (status === "voided" || status === "corrected") {
    // A future correction cannot be reconstructed from the current row. Keep
    // only the state that was already known at the origin; downstream history
    // eligibility still excludes a known voided row.
    return isAvailableAt(event.corrected_at, originTime);
  }
  return true;
}

function projectStatusIncidentToOrigin(
  incident: OpenAIStatusHistoryItem,
  originTime: number,
) {
  const createdAtTime = incident.createdAt ? timestamp(incident.createdAt) : null;
  const updatedAtTime = incident.updatedAt ? timestamp(incident.updatedAt) : null;
  const resolvedAtTime = incident.resolvedAt ? timestamp(incident.resolvedAt) : null;
  const firstKnownTime = [createdAtTime, updatedAtTime, resolvedAtTime]
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0] ?? null;

  // A future creation timestamp is authoritative even if a malformed payload
  // also contains an older update or resolution timestamp.
  if (createdAtTime !== null && createdAtTime > originTime) return null;
  if (firstKnownTime === null || firstKnownTime > originTime) return null;

  const currentStatus = incident.status.toLowerCase();
  const inferredResolvedTime = resolvedAtTime ?? (
    currentStatus === "resolved" ? updatedAtTime ?? timestamp(incident.createdAt ?? "") : null
  );
  const resolvedAtIsKnown = inferredResolvedTime !== null && inferredResolvedTime <= originTime;
  const updatedAtIsKnown = updatedAtTime !== null && updatedAtTime <= originTime;
  const statusWasUpdatedAfterOrigin = updatedAtTime !== null && updatedAtTime > originTime;
  const resolutionWasRecordedAfterOrigin = resolvedAtTime !== null && resolvedAtTime > originTime;

  if (statusWasUpdatedAfterOrigin) {
    // Statuspage gives us only the latest snapshot, not the intermediate
    // update history. Do not carry future state, impact, or title backwards.
    return {
      ...incident,
      title: "OpenAI Status incident",
      status: "investigating",
      impact: null,
      updatedAt: incident.createdAt ?? null,
      resolvedAt: null,
    };
  }

  const status = currentStatus === "resolved" && (!resolvedAtIsKnown || resolutionWasRecordedAfterOrigin)
    ? "investigating"
    : incident.status;

  return {
    ...incident,
    status,
    updatedAt: updatedAtIsKnown ? incident.updatedAt : incident.createdAt,
    resolvedAt: resolvedAtIsKnown ? incident.resolvedAt : null,
  };
}

/**
 * Return only data that could have been available at a walk-forward origin.
 * Current environment aggregates are intentionally removed so they cannot
 * carry values calculated after the origin into the historical prediction.
 */
export function getPointInTimeRadarData(data: RadarData | null, origin: Date): RadarData | null {
  const originTime = origin.getTime();
  if (!data || !Number.isFinite(originTime)) return null;

  return {
    schema_version: data.schema_version,
    service: data.service,
    purpose: data.purpose,
    timezone: data.timezone,
    checked_at: origin.toISOString(),
    monitored_at: origin.toISOString(),
    updated_at: origin.toISOString(),
    openai_status_history: (data.openai_status_history ?? []).flatMap((incident) => {
      const projected = projectStatusIncidentToOrigin(incident, originTime);
      return projected ? [projected] : [];
    }),
    active_tibo_signals: (data.active_tibo_signals ?? []).filter((signal) =>
      isAvailableAt(signal.detected_at ?? signal.tweet_created_at, originTime),
    ),
    recent_tibo_signals: (data.recent_tibo_signals ?? []).filter((signal) =>
      isAvailableAt(signal.detected_at ?? signal.tweet_created_at, originTime),
    ),
    formal_tibo_resets: (data.formal_tibo_resets ?? []).filter((signal) =>
      isAvailableAt(signal.detected_at ?? signal.tweet_created_at, originTime),
    ),
    rejected_tibo_resets: (data.rejected_tibo_resets ?? []).filter((signal) =>
      isAvailableAt(signal.tweet_created_at, originTime),
    ),
    regular_reset_events: (data.regular_reset_events ?? []).filter((event) =>
      isRegularResetEventAvailableAt(event, origin),
    ),
    reset_execution_estimates: (data.reset_execution_estimates ?? []).flatMap((estimate) => {
      const projected = projectResetExecutionEstimateToOrigin(estimate, origin);
      return projected ? [projected] : [];
    }),
    codex_recovery_observations: (data.codex_recovery_observations ?? []).flatMap((observation) => {
      const projected = projectCodexRecoveryObservationToOrigin(observation, origin);
      return projected ? [projected] : [];
    }),
    // Do not reuse current aggregate values at a historical origin.
    codex_environment: undefined,
    codex_usage_recovery: undefined,
  };
}
