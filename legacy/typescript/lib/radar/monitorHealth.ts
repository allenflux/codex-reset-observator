export const MONITOR_HEALTH_MAX_AGE_SECONDS = 900;
export const MONITOR_PARSE_ALERT_AGE_SECONDS = 1800;

export type MonitorHealthStatus = "healthy" | "warning" | "unhealthy";

export type MonitorHealthDetail =
  | "healthy"
  | "heartbeat_missing"
  | "heartbeat_invalid"
  | "heartbeat_future"
  | "heartbeat_stale"
  | "parse_missing"
  | "parse_invalid"
  | "parse_future"
  | "parse_stale"
  | "scan_error"
  | "page_reload_failed";

export interface TiboHeartbeatSnapshot {
  session_started_at: string | null;
  last_heartbeat_at: string | null;
  last_successful_parse_at: string | null;
  last_scan_error: string | null;
  last_page_reload_status: string | null;
  last_page_reload_error: string | null;
}

export interface MonitorHealthResult {
  status: MonitorHealthStatus;
  detail: MonitorHealthDetail;
  heartbeatAgeSeconds?: number;
  parseAgeSeconds?: number;
}

function getTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getAgeSeconds(timestamp: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function getOperationalFailureDetail(
  snapshot: TiboHeartbeatSnapshot,
): "scan_error" | "page_reload_failed" | null {
  if (snapshot.last_scan_error !== null) {
    return "scan_error";
  }

  if (
    snapshot.last_page_reload_status !== "success" &&
    snapshot.last_page_reload_status !== null
  ) {
    return "page_reload_failed";
  }

  return null;
}

function isWithinParseAlertAge(
  sessionStartedAt: string | null,
  now: Date,
): boolean {
  const sessionTimestamp = getTimestamp(sessionStartedAt);
  if (sessionTimestamp === null || sessionTimestamp > now.getTime()) {
    return false;
  }

  return (
    getAgeSeconds(sessionTimestamp, now) <= MONITOR_PARSE_ALERT_AGE_SECONDS
  );
}

export function evaluateTiboHeartbeat(
  snapshot: TiboHeartbeatSnapshot | null | undefined,
  now: Date,
): MonitorHealthResult {
  if (!snapshot || snapshot.last_heartbeat_at === null) {
    return { status: "unhealthy", detail: "heartbeat_missing" };
  }

  const heartbeatTimestamp = getTimestamp(snapshot.last_heartbeat_at);
  if (heartbeatTimestamp === null) {
    return { status: "unhealthy", detail: "heartbeat_invalid" };
  }

  if (heartbeatTimestamp > now.getTime()) {
    return { status: "unhealthy", detail: "heartbeat_future" };
  }

  const heartbeatAgeSeconds = getAgeSeconds(heartbeatTimestamp, now);
  if (heartbeatAgeSeconds > MONITOR_HEALTH_MAX_AGE_SECONDS) {
    const parseTimestamp = getTimestamp(snapshot.last_successful_parse_at);
    if (parseTimestamp === null) {
      return {
        status: "unhealthy",
        detail: "heartbeat_stale",
        heartbeatAgeSeconds,
      };
    }

    if (parseTimestamp > now.getTime()) {
      return {
        status: "unhealthy",
        detail: "parse_future",
        heartbeatAgeSeconds,
      };
    }

    return {
      status: "unhealthy",
      detail: "heartbeat_stale",
      heartbeatAgeSeconds,
      parseAgeSeconds: getAgeSeconds(parseTimestamp, now),
    };
  }

  if (snapshot.last_successful_parse_at === null) {
    const operationalFailure = getOperationalFailureDetail(snapshot);
    if (operationalFailure) {
      return {
        status: "unhealthy",
        detail: operationalFailure,
        heartbeatAgeSeconds,
      };
    }

    return {
      status: isWithinParseAlertAge(snapshot.session_started_at, now)
        ? "warning"
        : "unhealthy",
      detail: "parse_missing",
      heartbeatAgeSeconds,
    };
  }

  const parseTimestamp = getTimestamp(snapshot.last_successful_parse_at);
  if (parseTimestamp === null) {
    return {
      status: "unhealthy",
      detail: "parse_invalid",
      heartbeatAgeSeconds,
    };
  }

  if (parseTimestamp > now.getTime()) {
    return {
      status: "unhealthy",
      detail: "parse_future",
      heartbeatAgeSeconds,
    };
  }

  const parseAgeSeconds = getAgeSeconds(parseTimestamp, now);
  if (parseAgeSeconds > MONITOR_HEALTH_MAX_AGE_SECONDS) {
    const operationalFailure = getOperationalFailureDetail(snapshot);
    if (operationalFailure) {
      return {
        status: "unhealthy",
        detail: operationalFailure,
        heartbeatAgeSeconds,
        parseAgeSeconds,
      };
    }

    return {
      status:
        parseAgeSeconds <= MONITOR_PARSE_ALERT_AGE_SECONDS
          ? "warning"
          : "unhealthy",
      detail: "parse_stale",
      heartbeatAgeSeconds,
      parseAgeSeconds,
    };
  }

  const operationalFailure = getOperationalFailureDetail(snapshot);
  if (operationalFailure) {
    return {
      status: "unhealthy",
      detail: operationalFailure,
      heartbeatAgeSeconds,
      parseAgeSeconds,
    };
  }

  return {
    status: "healthy",
    detail: "healthy",
    heartbeatAgeSeconds,
    parseAgeSeconds,
  };
}
