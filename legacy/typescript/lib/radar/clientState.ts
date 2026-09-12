import type { CachedRadarData, Locale, PublicRadarSnapshot } from "./types";

export type RadarLoadState = {
  data: PublicRadarSnapshot | null;
  fetchedAt: string | null;
  isStale: boolean;
  refreshError: "request_failed" | null;
};

export type DashboardDataState = "ready" | "degraded" | "stale" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidIsoDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function hasRequiredPublicSnapshotFields(data: unknown): data is PublicRadarSnapshot {
  if (!isRecord(data)) return false;
  if (data.schemaVersion !== "public-v1" || !isValidIsoDate(data.checkedAt)) return false;
  if (!isRecord(data.dataHealth) || !isRecord(data.viewModel)) return false;
  if (data.dataHealth.overall !== "ok" && data.dataHealth.overall !== "degraded") return false;
  const viewModel = data.viewModel;

  return [
    "status",
    "expectation",
    "regularResetForecast",
    "activeWindow",
    "latestWindow",
    "recentHistory",
  ].every((key) => key in viewModel);
}

export function parseCachedRadarData(
  raw: string | null,
  locale: Locale,
): CachedRadarData | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== "public-v1" || parsed.locale !== locale) return null;
    if (!isValidIsoDate(parsed.fetchedAt) || !hasRequiredPublicSnapshotFields(parsed.data)) {
      return null;
    }

    return parsed as CachedRadarData;
  } catch {
    return null;
  }
}

export function applyRefreshSuccess(
  data: PublicRadarSnapshot,
  fetchedAt: string,
): RadarLoadState {
  return {
    data,
    fetchedAt,
    isStale: data.dataHealth.stale,
    refreshError: null,
  };
}

export function applyRefreshFailure(
  current: RadarLoadState,
  cached: CachedRadarData | null,
): RadarLoadState {
  if (current.data) {
    return {
      data: current.data,
      fetchedAt: current.fetchedAt,
      isStale: true,
      refreshError: "request_failed",
    };
  }

  return {
    data: cached?.data ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
    isStale: true,
    refreshError: "request_failed",
  };
}

export function getDashboardDataState(
  state: RadarLoadState,
): DashboardDataState {
  if (!state.data) {
    return "unavailable";
  }

  if (state.isStale) {
    return "stale";
  }

  if (state.data.dataHealth.overall === "degraded") {
    return "degraded";
  }

  return "ready";
}
