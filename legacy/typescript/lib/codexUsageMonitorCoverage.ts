import { MONITOR_HEALTH_MAX_AGE_SECONDS } from "./radar/monitorHealth";
import type { CodexUsageSnapshot } from "./codexUsageRecovery";

export const USAGE_MONITOR_FRESH_MAX_AGE_SECONDS = MONITOR_HEALTH_MAX_AGE_SECONDS;

export type UsageMonitorState = {
  sourceKey: string;
  observedAt: string;
  receivedAt: string;
  limitId: string;
  planType: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  /** Nullable for rows written before event-time continuity was introduced. */
  coverageStartedAt: string | null;
  bankedResetAvailableCount?: number | null;
  lastBankedGrantAt?: string | null;
};

export type UsageMonitorCoverage =
  | {
      state: "fresh";
      observedAt: Date;
      receivedAt: Date;
      coverageStartedAt: Date;
      usedPercent: number;
      resetsAt: number;
    }
  | { state: "stale" }
  | { state: "unavailable" };

function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function isValidState(value: UsageMonitorState | null | undefined): value is UsageMonitorState {
  return Boolean(
    value &&
      value.sourceKey === "local-codex-app-server" &&
      value.limitId === "codex" &&
      value.windowDurationMins === 10080 &&
      typeof value.planType === "string" &&
      value.planType.length > 0 &&
      Number.isFinite(value.usedPercent) &&
      value.usedPercent >= 0 &&
      value.usedPercent <= 100 &&
      Number.isInteger(value.resetsAt) &&
      value.resetsAt > 0,
  );
}

export function getUsageMonitorCoverage(
  state: UsageMonitorState | null | undefined,
  now: Date = new Date(),
): UsageMonitorCoverage {
  if (!isValidState(state)) return { state: "unavailable" };

  const nowTime = now.getTime();
  const observedAt = parseDate(state.observedAt);
  const receivedAt = parseDate(state.receivedAt);
  if (!Number.isFinite(nowTime) || !observedAt || !receivedAt) {
    return { state: "unavailable" };
  }

  const observedTime = observedAt.getTime();
  const receivedTime = receivedAt.getTime();
  if (observedTime > nowTime || receivedTime > nowTime || receivedTime < observedTime) {
    return { state: "unavailable" };
  }

  const coverageStartedAt = parseDate(state.coverageStartedAt);
  if (!coverageStartedAt || coverageStartedAt.getTime() > observedTime) {
    return { state: "unavailable" };
  }

  const maxAgeMs = USAGE_MONITOR_FRESH_MAX_AGE_SECONDS * 1000;
  if (nowTime - observedTime > maxAgeMs || nowTime - receivedTime > maxAgeMs) {
    return { state: "stale" };
  }

  return {
    state: "fresh",
    observedAt,
    receivedAt,
    coverageStartedAt,
    usedPercent: state.usedPercent,
    resetsAt: state.resetsAt,
  };
}

/**
 * A current fresh row is only negative evidence for events inside the
 * continuous interval that the monitor can actually prove it observed.
 * Events before startup, after the last snapshot, or before a continuity gap
 * deliberately return unavailable rather than being treated as uncovered
 * evidence.
 */
export function getUsageMonitorCoverageAtEvent(
  state: UsageMonitorState | null | undefined,
  eventAt: string,
  now: Date = new Date(),
): UsageMonitorCoverage {
  const coverage = getUsageMonitorCoverage(state, now);
  if (coverage.state !== "fresh") return coverage;

  const eventDate = parseDate(eventAt);
  if (!eventDate) return { state: "unavailable" };

  const eventTime = eventDate.getTime();
  if (
    eventTime < coverage.coverageStartedAt.getTime() ||
    eventTime > coverage.observedAt.getTime()
  ) {
    return { state: "unavailable" };
  }

  return coverage;
}

/**
 * Computes the next proven coverage start without inferring coverage across
 * a polling gap. The caller still has to apply the resulting row with a
 * monotonic database update.
 */
export function getNextUsageMonitorCoverageStartedAt(
  previous: UsageMonitorState | null | undefined,
  current: CodexUsageSnapshot,
): string | null {
  const currentDate = parseDate(current.observedAt);
  if (!currentDate) return null;

  if (!previous) return currentDate.toISOString();

  const previousDate = parseDate(previous.observedAt);
  const previousCoverageStart = parseDate(previous.coverageStartedAt);
  if (!previousDate || !previousCoverageStart) return currentDate.toISOString();

  const elapsed = currentDate.getTime() - previousDate.getTime();
  if (elapsed <= 0 || elapsed > MAX_USAGE_COMPARISON_GAP_MS) {
    return currentDate.toISOString();
  }

  return previousCoverageStart.toISOString();
}

const MAX_USAGE_COMPARISON_GAP_MS = 10 * 60 * 1000;
