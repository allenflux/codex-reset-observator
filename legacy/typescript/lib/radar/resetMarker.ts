import type { Locale, PublicRadarSnapshot } from "./types";

export const RESET_MARKER_SCHEMA_VERSION = "reset-marker-v1" as const;
export const RESET_MARKER_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const RESET_MARKER_CATCH_UP_RETRY_DELAY_MS = 5 * 1000;
export const RESET_MARKER_MAX_CATCH_UP_RETRIES = 2;

export type ResetMarkerPayload = {
  schemaVersion: typeof RESET_MARKER_SCHEMA_VERSION;
  marker: string | null;
  resetAt: string | null;
};

export type ResetMarkerState = {
  initialized: boolean;
  marker: string | null;
  resetAt: string | null;
  pending: ResetMarkerPayload | null;
  retryCount: number;
};

export type ResetMarkerObservation = {
  action: "baseline" | "unchanged" | "refresh";
  marker: ResetMarkerPayload | null;
  state: ResetMarkerState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseResetMarkerPayload(value: unknown): ResetMarkerPayload | null {
  if (!isRecord(value) || value.schemaVersion !== RESET_MARKER_SCHEMA_VERSION) return null;

  const marker = value.marker;
  const resetAt = value.resetAt;
  if (marker === null && resetAt === null) {
    return { schemaVersion: RESET_MARKER_SCHEMA_VERSION, marker: null, resetAt: null };
  }
  if (
    typeof marker !== "string" ||
    marker.trim() === "" ||
    typeof resetAt !== "string" ||
    !Number.isFinite(Date.parse(resetAt))
  ) {
    return null;
  }

  return {
    schemaVersion: RESET_MARKER_SCHEMA_VERSION,
    marker,
    resetAt,
  };
}

export function createResetMarkerState(): ResetMarkerState {
  return {
    initialized: false,
    marker: null,
    resetAt: null,
    pending: null,
    retryCount: 0,
  };
}

export function getInitialResetMarkerPlan(
  currentSnapshot: PublicRadarSnapshot | null,
  incoming: ResetMarkerPayload,
) {
  if (!incoming.marker || !incoming.resetAt) {
    return { action: "baseline" as const };
  }

  const markerTime = Date.parse(incoming.resetAt);
  if (!Number.isFinite(markerTime)) {
    return { action: "baseline" as const };
  }

  const currentResetAt = currentSnapshot?.lastRandomResetAt ?? null;
  if (currentResetAt === null) {
    return { action: "refresh" as const };
  }

  const currentResetTime = Date.parse(currentResetAt);
  if (!Number.isFinite(currentResetTime)) {
    return { action: "baseline" as const };
  }

  return currentResetTime < markerTime
    ? { action: "refresh" as const }
    : { action: "baseline" as const };
}

export function beginResetMarkerRefresh(
  state: ResetMarkerState,
  marker: ResetMarkerPayload,
): ResetMarkerState {
  return {
    ...state,
    initialized: true,
    marker: marker.marker,
    resetAt: marker.resetAt,
    pending: marker,
    retryCount: 0,
  };
}

export function observeResetMarker(
  state: ResetMarkerState,
  incoming: ResetMarkerPayload,
): ResetMarkerObservation {
  if (!state.initialized) {
    return {
      action: "baseline",
      marker: incoming,
      state: {
        initialized: true,
        marker: incoming.marker,
        resetAt: incoming.resetAt,
        pending: null,
        retryCount: 0,
      },
    };
  }

  // A missing marker must never erase a previously observed reset boundary.
  if (!incoming.marker || !incoming.resetAt) {
    return { action: "unchanged", marker: null, state };
  }

  if (incoming.marker === state.marker) {
    if (state.pending?.marker === incoming.marker && state.retryCount < RESET_MARKER_MAX_CATCH_UP_RETRIES) {
      return { action: "refresh", marker: incoming, state };
    }
    return { action: "unchanged", marker: null, state };
  }

  return {
    action: "refresh",
    marker: incoming,
    state: {
      ...state,
      pending: incoming,
      retryCount: 0,
    },
  };
}

export function markResetMarkerAccepted(
  state: ResetMarkerState,
  marker: ResetMarkerPayload,
): ResetMarkerState {
  return {
    ...state,
    initialized: true,
    marker: marker.marker,
    resetAt: marker.resetAt,
    pending: null,
    retryCount: 0,
  };
}

export function markResetMarkerRetry(
  state: ResetMarkerState,
  marker: ResetMarkerPayload,
  retryCount: number,
): ResetMarkerState {
  return {
    ...state,
    initialized: true,
    pending: marker,
    retryCount,
  };
}

export function deferResetMarker(
  state: ResetMarkerState,
  marker: ResetMarkerPayload,
): ResetMarkerState {
  return {
    ...state,
    initialized: true,
    pending: state.pending?.marker === marker.marker ? null : state.pending,
    retryCount: state.pending?.marker === marker.marker ? 0 : state.retryCount,
  };
}

export function isSnapshotCaughtUpToResetMarker(
  snapshot: PublicRadarSnapshot,
  resetAt: string | null,
) {
  if (!resetAt) return true;
  const markerTime = Date.parse(resetAt);
  const snapshotTime = Date.parse(snapshot.lastRandomResetAt ?? "");
  return Number.isFinite(markerTime) && Number.isFinite(snapshotTime) && snapshotTime >= markerTime;
}

export function getResetMarkerCatchUpPlan(
  snapshot: PublicRadarSnapshot,
  marker: ResetMarkerPayload,
  retryCount: number,
) {
  if (isSnapshotCaughtUpToResetMarker(snapshot, marker.resetAt)) {
    return { action: "accepted" as const, delayMs: 0 };
  }
  if (retryCount < RESET_MARKER_MAX_CATCH_UP_RETRIES) {
    return {
      action: "retry" as const,
      delayMs: RESET_MARKER_CATCH_UP_RETRY_DELAY_MS,
    };
  }
  return {
    action: "defer" as const,
    delayMs: RESET_MARKER_POLL_INTERVAL_MS,
  };
}

export function getResetMarkerPollPlan(
  lastCheckedAt: number | null,
  nowMs: number,
  visibilityState: string,
  onLine: boolean,
) {
  if (visibilityState !== "visible" || !onLine) {
    return { action: "stop" as const, delayMs: null };
  }
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt) || !Number.isFinite(nowMs)) {
    return { action: "check" as const, delayMs: 0 };
  }
  const elapsedMs = nowMs - lastCheckedAt;
  if (elapsedMs >= RESET_MARKER_POLL_INTERVAL_MS) {
    return { action: "check" as const, delayMs: 0 };
  }
  return {
    action: "wait" as const,
    delayMs: Math.max(0, RESET_MARKER_POLL_INTERVAL_MS - Math.max(0, elapsedMs)),
  };
}

export function buildCurrentRadarFetchUrl(
  locale: Locale,
  resetMarker?: string | null,
  retryCount = 0,
) {
  const params = new URLSearchParams({ locale });
  if (resetMarker) {
    params.set("resetMarker", resetMarker);
    // Keep race retries bounded while ensuring a cached early response cannot
    // be reused for every catch-up attempt.
    if (retryCount > 0) params.set("resetMarkerRetry", String(retryCount));
  }
  return `/api/current?${params.toString()}`;
}

export function getResetMarkerRequestUrl() {
  return "/api/reset-marker";
}
