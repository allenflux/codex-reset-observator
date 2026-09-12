import { getRefreshIntervalMs } from "./helpers";
import type { PublicRadarSnapshot } from "./types";

export const RADAR_FETCH_TIMEOUT_MS = 15_000;
export const OFFICIAL_NOTICE_NO_TIME_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const STRONG_RECOVERY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const STALE_DATA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const REFRESH_EVENT_MIN_INTERVAL_MS = 30 * 1000;

const REFRESH_RETRY_INTERVALS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;

export type RefreshPlan = {
  action: "fetch" | "wait";
  delayMs: number;
};

export type RefreshEnvironment = {
  visibilityState: string;
  onLine: boolean;
  inFlight: boolean;
};

function getValidTime(value: string | null | undefined) {
  if (!value) return null;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function getOfficialNoticeRefreshIntervalMs(
  activeWindow: PublicRadarSnapshot["viewModel"]["activeWindow"],
  nowMs: number,
) {
  const expectedTime = getValidTime(activeWindow.expectedAt) ?? getValidTime(activeWindow.expectedEndAt);
  if (expectedTime === null) return OFFICIAL_NOTICE_NO_TIME_REFRESH_INTERVAL_MS;

  const remainingMs = expectedTime - nowMs;
  if (remainingMs >= 6 * 60 * 60 * 1000) return 15 * 60 * 1000;
  if (remainingMs >= 2 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (remainingMs >= 30 * 60 * 1000) return 10 * 60 * 1000;
  return 5 * 60 * 1000;
}

function getFreshDataRemainingMs(
  data: PublicRadarSnapshot | null | undefined,
  fetchedAt: string | null | undefined,
  nowMs: number,
) {
  if (!data) return null;

  const fetchedTime = getValidTime(fetchedAt);
  if (fetchedTime === null || !Number.isFinite(nowMs)) return null;

  const elapsedMs = nowMs - fetchedTime;
  if (elapsedMs < 0) return null;

  const intervalMs = data.dataHealth.stale || data.dataHealth.overall === "degraded"
    ? STALE_DATA_REFRESH_INTERVAL_MS
    : (() => {
        const hasActiveOfficialNotice =
          data.viewModel.activeWindow.active && data.viewModel.activeWindow.kind === "official";
        const hasActiveStrongRecovery = data.recoveryObservation?.status === "observed_unconfirmed" &&
          data.recoveryObservation.confidence === "strong";
        return hasActiveOfficialNotice
          ? getOfficialNoticeRefreshIntervalMs(data.viewModel.activeWindow, nowMs)
          : hasActiveStrongRecovery
            ? STRONG_RECOVERY_REFRESH_INTERVAL_MS
            : getRefreshIntervalMs(data.viewModel.probability24h);
      })();
  return Math.max(0, intervalMs - elapsedMs);
}

export function getInitialRefreshPlan(
  data: PublicRadarSnapshot | null | undefined,
  fetchedAt: string | null | undefined,
  nowMs = Date.now(),
): RefreshPlan {
  const remainingMs = getFreshDataRemainingMs(data, fetchedAt, nowMs);

  if (remainingMs === null || remainingMs === 0) {
    return { action: "fetch", delayMs: 0 };
  }

  return { action: "wait", delayMs: remainingMs };
}

/**
 * Returns the plan used by visibility/focus/online wake events.  A wake event
 * should be prompt, but repeated browser events must not create a fetch storm.
 */
export function getEventRefreshPlan(
  data: PublicRadarSnapshot | null | undefined,
  fetchedAt: string | null | undefined,
  nowMs = Date.now(),
): RefreshPlan {
  const fetchedTime = getValidTime(fetchedAt);
  if (fetchedTime === null || !Number.isFinite(nowMs) || nowMs < fetchedTime) {
    return { action: "fetch", delayMs: 0 };
  }

  const elapsedMs = nowMs - fetchedTime;
  if (elapsedMs < REFRESH_EVENT_MIN_INTERVAL_MS) {
    return {
      action: "wait",
      delayMs: REFRESH_EVENT_MIN_INTERVAL_MS - elapsedMs,
    };
  }

  const remainingMs = getFreshDataRemainingMs(data, fetchedAt, nowMs);
  if (remainingMs === null || remainingMs === 0) {
    return { action: "fetch", delayMs: 0 };
  }

  return { action: "wait", delayMs: remainingMs };
}

export function getRefreshRetryDelayMs(failureCount: number) {
  const normalizedCount = Number.isFinite(failureCount)
    ? Math.max(1, Math.floor(failureCount))
    : 1;
  const index = Math.min(normalizedCount, REFRESH_RETRY_INTERVALS_MS.length) - 1;
  return REFRESH_RETRY_INTERVALS_MS[index];
}

export function canStartRadarRefresh(environment: RefreshEnvironment) {
  return (
    environment.visibilityState === "visible" &&
    environment.onLine &&
    !environment.inFlight
  );
}

export function startAbortTimeout<T>(
  controller: AbortController,
  timeoutMs: number,
  setTimeoutFn: (callback: () => void, delayMs: number) => T,
  clearTimeoutFn: (handle: T) => void,
) {
  let timedOut = false;
  const handle = setTimeoutFn(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    hasTimedOut: () => timedOut,
    cancel: () => clearTimeoutFn(handle),
  };
}
