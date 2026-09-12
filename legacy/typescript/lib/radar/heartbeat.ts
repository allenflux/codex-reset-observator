export interface HeartbeatScanSummary {
  articleCount: number;
  timeElementCount: number;
  tweetTextCount: number;
  nonEmptyTweetTextCount: number;
  matchingTiboStatusCount: number;
  translatedTweetCount: number;
  tweetDatetimeCount: number;
  parseSuccessCount: number;
  currentUrl: string;
  selectorVersion: string;
  scanTimestamp: string;
}

export interface HeartbeatRequestBody {
  sessionId?: string | null;
  lastSuccessfulParseAt?: string | null;
  lastSeenTweetId?: string | null;
  newestSeenTweetCreatedAt?: string | null;
  newest_seen_tweet_created_at?: string | null;
  lastScanError?: string | null;
  lastScanSummary?: unknown | null;
  selectorVersion?: string | null;
  last_page_reload_at?: string | null;
  last_page_reload_status?: string | null;
  last_page_reload_error?: string | null;
  last_scan_summary?: unknown | null;
  lastPageReloadAt?: string | null;
  lastPageReloadStatus?: string | null;
  lastPageReloadError?: string | null;
}

export interface ExistingHeartbeatRecord {
  id?: string | null;
  session_id?: string | null;
  session_started_at?: string | null;
  last_heartbeat_at?: string | null;
  heartbeat_count?: number | null;
  max_gap_seconds?: number | null;
  last_scan_summary?: unknown | null;
  newest_seen_tweet_created_at?: string | null;
}

export interface HeartbeatRecord {
  id: string;
  session_id: string;
  session_started_at: string;
  last_heartbeat_at: string;
  last_successful_parse_at: string | null;
  last_seen_tweet_id: string | null;
  newest_seen_tweet_created_at?: string | null;
  last_scan_error: string | null;
  selector_version: string;
  last_page_reload_at: string | null;
  last_page_reload_status: string | null;
  last_page_reload_error: string | null;
  last_scan_summary: HeartbeatScanSummary | null;
  heartbeat_count: number;
  max_gap_seconds: number;
  last_gap_seconds: number;
  updated_at: string;
}

const SAFE_SCAN_ERROR_CODES = new Set([
  "translated_text_detected",
  "scan_exception",
  "article_missing",
  "time_element_missing",
  "tweet_text_missing",
  "tweet_text_empty",
  "tibo_status_url_missing",
  "tweet_datetime_missing",
  "no_parse_success",
  "scan_error",
]);

function normalizeScanError(value: unknown): string | null {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const code = String(value);
  return SAFE_SCAN_ERROR_CODES.has(code) ? code : "scan_error";
}

function normalizeCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(10_000, Math.floor(number))) : 0;
}

function normalizeScanSummary(value: unknown): HeartbeatScanSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = value as Record<string, unknown>;
  let currentUrl = "";
  try {
    const url = new URL(String(summary.currentUrl || ""));
    const host = url.hostname.toLowerCase();
    if (host !== "x.com" && host !== "twitter.com") return null;
    currentUrl = `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }

  const selectorVersion = String(summary.selectorVersion || "unknown").slice(0, 100);
  const scanTimestamp = String(summary.scanTimestamp || "").slice(0, 40);
  if (!/^[-A-Za-z0-9_.]+$/.test(selectorVersion) || !scanTimestamp) return null;

  return {
    articleCount: normalizeCount(summary.articleCount),
    timeElementCount: normalizeCount(summary.timeElementCount),
    tweetTextCount: normalizeCount(summary.tweetTextCount),
    nonEmptyTweetTextCount: normalizeCount(
      Object.prototype.hasOwnProperty.call(summary, "nonEmptyTweetTextCount")
        ? summary.nonEmptyTweetTextCount
        : summary.tweetTextCount,
    ),
    matchingTiboStatusCount: normalizeCount(summary.matchingTiboStatusCount),
    translatedTweetCount: normalizeCount(summary.translatedTweetCount),
    tweetDatetimeCount: normalizeCount(summary.tweetDatetimeCount),
    parseSuccessCount: normalizeCount(summary.parseSuccessCount),
    currentUrl,
    selectorVersion,
    scanTimestamp,
  };
}

function normalizeNewestSeenTweetCreatedAt(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + 5 * 60 * 1000) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

export function withoutHeartbeatDiagnosticColumns(payload: HeartbeatRecord) {
  const {
    last_scan_summary: _ignoredSummary,
    newest_seen_tweet_created_at: _ignoredNewestTweetTime,
    ...legacyPayload
  } = payload;
  return legacyPayload;
}

export function isMissingHeartbeatDiagnosticColumn(
  error: { code?: string; message?: string } | null,
) {
  const message = error?.message?.toLowerCase() || "";
  return Boolean(
    error &&
      (error.code === "PGRST204" ||
        message.includes("last_scan_summary") ||
        message.includes("newest_seen_tweet_created_at")),
  );
}

export function buildHeartbeatRecord(
  body: HeartbeatRequestBody,
  existing: ExistingHeartbeatRecord | null,
  now: Date,
): HeartbeatRecord {
  const nowIso = now.toISOString();
  const normalizedSessionId = body.sessionId || "default_session";

  let sessionStartedAt = existing?.session_started_at || nowIso;
  let heartbeatCount = (existing?.heartbeat_count || 0) + 1;
  let maxGapSeconds = existing?.max_gap_seconds || 0;
  let lastGapSeconds = 0;
  const requestedPageReloadStatus =
    body.last_page_reload_status ?? body.lastPageReloadStatus ?? null;
  const pageReloadStatus =
    requestedPageReloadStatus === null ||
    requestedPageReloadStatus === "success" ||
    requestedPageReloadStatus === "monitored_tab_missing" ||
    requestedPageReloadStatus === "error"
      ? requestedPageReloadStatus
      : "error";
  const requestedScanSummary = body.last_scan_summary ?? body.lastScanSummary;
  const requestedNewestSeenTweetCreatedAt =
    body.newest_seen_tweet_created_at ?? body.newestSeenTweetCreatedAt;
  const newestSeenTweetCreatedAt =
    normalizeNewestSeenTweetCreatedAt(requestedNewestSeenTweetCreatedAt, now) ??
    normalizeNewestSeenTweetCreatedAt(existing?.newest_seen_tweet_created_at, now);

  const isNewSession = existing?.session_id !== normalizedSessionId;
  if (isNewSession) {
    sessionStartedAt = nowIso;
    heartbeatCount = 1;
    maxGapSeconds = 0;
    lastGapSeconds = 0;
  } else if (existing?.last_heartbeat_at) {
    const previousTime = new Date(existing.last_heartbeat_at).getTime();
    lastGapSeconds = Math.max(0, Math.floor((now.getTime() - previousTime) / 1000));
    if (lastGapSeconds > maxGapSeconds) {
      maxGapSeconds = lastGapSeconds;
    }
  }

  const record: HeartbeatRecord = {
    id: "main",
    session_id: normalizedSessionId,
    session_started_at: sessionStartedAt,
    last_heartbeat_at: nowIso,
    last_successful_parse_at: body.lastSuccessfulParseAt || null,
    last_seen_tweet_id: body.lastSeenTweetId || null,
    last_scan_error: normalizeScanError(body.lastScanError),
    selector_version: body.selectorVersion || "v1",
    last_page_reload_at: body.last_page_reload_at ?? body.lastPageReloadAt ?? null,
    last_page_reload_status: pageReloadStatus,
    last_page_reload_error: pageReloadStatus === "error" ? "page_reload_error" : null,
    last_scan_summary:
      typeof requestedScanSummary === "undefined"
        ? normalizeScanSummary(existing?.last_scan_summary)
        : normalizeScanSummary(requestedScanSummary),
    heartbeat_count: heartbeatCount,
    max_gap_seconds: maxGapSeconds,
    last_gap_seconds: lastGapSeconds,
    updated_at: nowIso,
  };

  if (newestSeenTweetCreatedAt) {
    record.newest_seen_tweet_created_at = newestSeenTweetCreatedAt;
  }

  return record;
}
