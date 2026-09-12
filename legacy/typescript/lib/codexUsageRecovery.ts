import { isBearerAuthorizationValid } from "./security/bearerAuth";

export const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
export const MAX_USAGE_COMPARISON_GAP_MS = 10 * 60 * 1000;
export const RESET_AT_MEANINGFUL_FORWARD_SEC = 60 * 60;
export const REGULAR_RESET_PROXIMITY_MS = 5 * 60 * 1000;
export const UNCONFIRMED_RECOVERY_ACTIVE_MS = 90 * 60 * 1000;
export const USAGE_TIBO_MATCH_WINDOW_MS = 90 * 60 * 1000;
export const CODEX_USAGE_SOURCE_KEY = "local-codex-app-server";
export const MAX_BANKED_RESET_AVAILABLE_COUNT = 1_000;

export type BankedResetCountSource =
  | "explicit"
  | "unavailable";

export function shouldCreateNoticeBackedEstimate<T extends { id: string }>(
  noticeSignal: T | null | undefined,
  decision: { confidence: string; cycleHint: string },
  observation: unknown,
): noticeSignal is T {
  return Boolean(
    noticeSignal &&
    decision.confidence === "strong" &&
    decision.cycleHint === "unexpected" &&
    observation,
  );
}

export const MONITOR_PROTOCOL_VERSION = 2;

export const CODEX_USAGE_POST_REASONS = [
  "initial",
  "recovery_candidate",
  "banked_reset_count_change",
  "structure_change",
  "heartbeat",
] as const;

export type CodexUsagePostReason = (typeof CODEX_USAGE_POST_REASONS)[number];

export type CodexUsageSnapshot = {
  observedAt: string;
  limitId: "codex";
  planType: string;
  usedPercent: number;
  windowDurationMins: typeof CODEX_WEEKLY_WINDOW_MINUTES;
  resetsAt: number;
  bankedResetAvailableCount?: number | null;
  bankedResetDisplayCount?: number | null;
  bankedResetCountSource?: BankedResetCountSource;
  bankedResetCountChange?: boolean;
  lastBankedGrantAt?: string | null;
  monitorProtocolVersion?: number;
  postReason?: CodexUsagePostReason;
};

export type CodexRecoveryCycleHint = "regular" | "unexpected" | "unknown";
export type CodexRecoveryConfidence = "strong" | "medium";
export type CodexRecoveryStatus = "observed" | "confirmed" | "rejected";

export type CodexRecoveryObservation = {
  id?: string;
  sourceKey: string;
  observedAt: string;
  previousObservedAt?: string | null;
  previousUsedPercent: number;
  currentUsedPercent: number;
  previousResetsAt: number;
  currentResetsAt: number;
  cycleHint: CodexRecoveryCycleHint;
  confidence: CodexRecoveryConfidence;
  status: CodexRecoveryStatus;
  matchedTiboTweetId?: string | null;
  confirmedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PublicRecoveryObservation = {
  status: "observed_unconfirmed";
  observedAt: string;
  confidence: "strong";
  cycleHint: Exclude<CodexRecoveryCycleHint, "regular">;
};

export type CodexUsageRecoveryDecision =
  | { kind: "baseline" }
  | { kind: "stale" }
  | { kind: "rebase" }
  | { kind: "invalid" }
  | { kind: "no_recovery" }
  | {
      kind: "recovery";
      nearRegularSchedule: boolean;
      cycleHint: CodexRecoveryCycleHint;
      confidence: CodexRecoveryConfidence;
      isPersonalReset?: boolean;
      previous: CodexUsageSnapshot;
      current: CodexUsageSnapshot;
    };

/**
 * Only a clearly non-regular recovery can corroborate a Tibo reset. A nearby
 * regular boundary remains regular evidence even when an official notice is
 * also present.
 */
export function canCorroborateTiboReset(
  decision: CodexUsageRecoveryDecision,
) {
  return decision.kind === "recovery" &&
    decision.cycleHint === "unexpected" &&
    !decision.nearRegularSchedule;
}

const MAX_PLAN_TYPE_LENGTH = 64;
const MAX_LIMIT_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function getObservedTime(value: Date | string | undefined) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : null;
}

function readWindow(value: unknown) {
  if (!isRecord(value)) return null;

  const usedPercent = getFiniteNumber(value.usedPercent ?? value.used_percent);
  const windowDurationMins = getPositiveInteger(
    value.windowDurationMins ?? value.window_duration_mins,
  );
  const resetsAt = getPositiveInteger(value.resetsAt ?? value.resets_at);
  if (
    usedPercent === null ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    windowDurationMins === null ||
    resetsAt === null
  ) {
    return null;
  }

  return { usedPercent, windowDurationMins, resetsAt };
}

function readBankedResetAvailableCount(value: unknown) {
  if (!isRecord(value)) return null;
  const availableCount = value.availableCount;
  return typeof availableCount === "number" &&
    Number.isSafeInteger(availableCount) &&
    availableCount >= 0 &&
    availableCount <= MAX_BANKED_RESET_AVAILABLE_COUNT
    ? availableCount
    : null;
}

export function isBankedResetAvailableCountGrant(
  previous: number | null | undefined,
  current: number | null | undefined,
) {
  return typeof previous === "number" &&
    Number.isSafeInteger(previous) &&
    previous >= 0 &&
    typeof current === "number" &&
    Number.isSafeInteger(current) &&
    current >= 0 &&
    current > previous;
}

function getRateLimitSnapshots(root: Record<string, unknown>) {
  const result = isRecord(root.result) ? root.result : root;
  const byLimitId = result.rateLimitsByLimitId ?? result.rate_limits_by_limit_id;
  if (isRecord(byLimitId)) {
    return Object.entries(byLimitId).map(([key, value]) => ({
      key,
      value: isRecord(value) ? value : null,
    }));
  }

  const rateLimits = result.rateLimits ?? result.rate_limits;
  return [{ key: null, value: isRecord(rateLimits) ? rateLimits : null }];
}

type ExplicitBankedResetCount = {
  present: boolean;
  count: number | null;
};

function getExplicitBankedResetAvailableCount(
  result: Record<string, unknown>,
  rateLimit: Record<string, unknown>,
): ExplicitBankedResetCount {
  if (Object.prototype.hasOwnProperty.call(result, "rateLimitResetCredits")) {
    return {
      present: true,
      count: readBankedResetAvailableCount(result.rateLimitResetCredits),
    };
  }
  if (Object.prototype.hasOwnProperty.call(rateLimit, "rateLimitResetCredits")) {
    return {
      present: true,
      count: readBankedResetAvailableCount(rateLimit.rateLimitResetCredits),
    };
  }
  return { present: false, count: null };
}

function normalizeBankedResetCount(
  explicit: ExplicitBankedResetCount,
): { displayCount: number | null; source: BankedResetCountSource } {
  if (explicit.present) {
    return {
      displayCount: explicit.count,
      source: explicit.count === null ? "unavailable" : "explicit",
    };
  }

  return {
    displayCount: null,
    source: "unavailable",
  };
}

/**
 * Extract only the weekly Codex quota from an app-server response. The
 * app-server exposes primary/secondary windows, so the weekly duration is
 * selected by value rather than by position.
 */
export function parseCodexRateLimitsResponse(
  value: unknown,
  observedAt: Date | string = new Date(),
): CodexUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const observedDate = getObservedTime(observedAt);
  if (!observedDate) return null;

  const result = isRecord(value.result) ? value.result : value;
  const snapshots = getRateLimitSnapshots(value);
  const candidates: Array<{
    key: string | null;
    limitId: string | null;
    planType: string;
    window: { usedPercent: number; windowDurationMins: number; resetsAt: number };
    bankedResetAvailableCount: number | null;
    bankedResetDisplayCount: number | null;
    bankedResetCountSource: BankedResetCountSource;
  }> = [];

  for (const snapshot of snapshots) {
    if (!snapshot.value) return null;
    const limitIdValue = snapshot.value.limitId ?? snapshot.value.limit_id ?? snapshot.key;
    const limitId = typeof limitIdValue === "string" && limitIdValue.length <= MAX_LIMIT_ID_LENGTH
      ? limitIdValue
      : null;
    const planValue = snapshot.value.planType ?? snapshot.value.plan_type;
    const planType = typeof planValue === "string" && planValue.length <= MAX_PLAN_TYPE_LENGTH
      ? planValue || "unknown"
      : "unknown";
    const explicitBankedResetCount = getExplicitBankedResetAvailableCount(result, snapshot.value);
    const normalizedBankedResetCount = normalizeBankedResetCount(
      explicitBankedResetCount,
    );

    for (const windowKey of ["primary", "secondary"] as const) {
      const rawWindow = snapshot.value[windowKey];
      if (rawWindow === null || rawWindow === undefined) continue;
      const window = readWindow(rawWindow);
      if (!window) return null;
      if (window.windowDurationMins === CODEX_WEEKLY_WINDOW_MINUTES) {
        candidates.push({
          key: snapshot.key,
          limitId,
          planType,
          window,
          bankedResetAvailableCount: explicitBankedResetCount.count,
          bankedResetDisplayCount: normalizedBankedResetCount.displayCount,
          bankedResetCountSource: normalizedBankedResetCount.source,
        });
      }
    }
  }

  const codexCandidates = candidates.filter((candidate) => candidate.limitId === "codex");
  const selected = codexCandidates.length === 1
    ? codexCandidates[0]
    : codexCandidates.length > 1
      ? null
      : candidates.length === 1
        ? candidates[0]
        : null;
  if (!selected) return null;

  return {
    observedAt: observedDate.toISOString(),
    limitId: "codex",
    planType: selected.planType,
    usedPercent: selected.window.usedPercent,
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt: selected.window.resetsAt,
    bankedResetAvailableCount: selected.bankedResetAvailableCount,
    bankedResetDisplayCount: selected.bankedResetDisplayCount,
    bankedResetCountSource: selected.bankedResetCountSource,
  };
}

function isValidPlanType(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PLAN_TYPE_LENGTH &&
    /^[a-z0-9_-]+$/i.test(value);
}

/** Validates the exact public-to-webhook shape without retaining extra fields. */
export function parseCodexUsageWebhookPayload(
  value: unknown,
  now: Date = new Date(),
): CodexUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "monitorProtocolVersion",
    "postReason",
    "observedAt",
    "limitId",
    "planType",
    "usedPercent",
    "windowDurationMins",
    "resetsAt",
    "bankedResetAvailableCount",
    "bankedResetCountChange",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;

  let monitorProtocolVersion: number | undefined;
  if (value.monitorProtocolVersion !== undefined) {
    if (
      typeof value.monitorProtocolVersion !== "number" ||
      !Number.isInteger(value.monitorProtocolVersion) ||
      value.monitorProtocolVersion < 1 ||
      value.monitorProtocolVersion > MONITOR_PROTOCOL_VERSION
    ) {
      return null;
    }
    monitorProtocolVersion = value.monitorProtocolVersion;
  }

  let postReason: CodexUsagePostReason | undefined;
  if (value.postReason !== undefined) {
    if (
      typeof value.postReason !== "string" ||
      !CODEX_USAGE_POST_REASONS.includes(value.postReason as CodexUsagePostReason)
    ) {
      return null;
    }
    postReason = value.postReason as CodexUsagePostReason;
  }

  // Strict validation for protocol v2: if monitorProtocolVersion is 2, postReason is strictly required
  if (monitorProtocolVersion === 2 && !postReason) {
    return null;
  }

  // If postReason is supplied without monitorProtocolVersion, associate with current protocol version
  if (postReason && monitorProtocolVersion === undefined) {
    monitorProtocolVersion = MONITOR_PROTOCOL_VERSION;
  }

  const observedAt = typeof value.observedAt === "string" ? new Date(value.observedAt) : null;
  const nowTime = now.getTime();
  if (!observedAt || !Number.isFinite(observedAt.getTime()) || !Number.isFinite(nowTime)) return null;
  if (observedAt.getTime() > nowTime + 5 * 60 * 1000) return null;
  if (value.limitId !== "codex") return null;
  if (!isValidPlanType(value.planType)) return null;
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  if (value.windowDurationMins !== CODEX_WEEKLY_WINDOW_MINUTES) return null;
  const resetsAt = getPositiveInteger(value.resetsAt);
  if (resetsAt === null) return null;

  let bankedResetAvailableCount: number | null | undefined;
  if (value.bankedResetAvailableCount !== undefined) {
    if (value.bankedResetAvailableCount === null) {
      bankedResetAvailableCount = null;
    } else {
      bankedResetAvailableCount = readBankedResetAvailableCount({
        availableCount: value.bankedResetAvailableCount,
      });
      if (bankedResetAvailableCount === null) return null;
    }
  }
  if (value.bankedResetCountChange !== undefined && typeof value.bankedResetCountChange !== "boolean") {
    return null;
  }
  if (value.bankedResetCountChange === true &&
    (typeof bankedResetAvailableCount !== "number" || bankedResetAvailableCount < 1)) {
    return null;
  }

  return {
    observedAt: observedAt.toISOString(),
    limitId: "codex",
    planType: value.planType,
    usedPercent: value.usedPercent,
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt,
    ...(monitorProtocolVersion !== undefined ? { monitorProtocolVersion } : {}),
    ...(postReason !== undefined ? { postReason } : {}),
    ...(value.bankedResetAvailableCount !== undefined ? { bankedResetAvailableCount } : {}),
    ...(value.bankedResetCountChange === true ? { bankedResetCountChange: true } : {}),
  };
}

export function isCodexUsageAuthorizationValid(
  authorizationHeader: string | null,
  expectedSecret: string | undefined,
) {
  return isBearerAuthorizationValid(authorizationHeader, expectedSecret);
}

export const BANKED_RESET_SAFE_CONSUMPTION_MAX_DAYS = 20;

export function isExplicitBankedResetConsumption(
  previous: CodexUsageSnapshot,
  current: CodexUsageSnapshot,
  lastBankedGrantAt?: string | null,
): boolean {
  if (
    typeof previous.bankedResetAvailableCount === "number" &&
    typeof current.bankedResetAvailableCount === "number" &&
    current.bankedResetAvailableCount < previous.bankedResetAvailableCount
  ) {
    if (lastBankedGrantAt) {
      const grantTime = Date.parse(lastBankedGrantAt);
      const currentTime = Date.parse(current.observedAt);
      if (Number.isFinite(grantTime) && Number.isFinite(currentTime)) {
        const daysSinceGrant = (currentTime - grantTime) / (24 * 60 * 60 * 1000);
        // If granted within 20 days, it is clearly not natural 30-day expiration -> personal reset
        if (daysSinceGrant >= 0 && daysSinceGrant <= BANKED_RESET_SAFE_CONSUMPTION_MAX_DAYS) {
          return true;
        }
        // If near ~30 days expiration or older, fail-open (not definitely personal consumption)
        return false;
      }
    }
    // If no grant date is known and count dropped clearly, check if option specifies
    return false;
  }
  return false;
}

export function evaluateCodexUsageRecovery(
  previous: CodexUsageSnapshot | null | undefined,
  current: CodexUsageSnapshot,
  options: {
    activeOfficialNotice?: boolean;
    activeResetEvidence?: boolean;
    lastBankedGrantAt?: string | null;
    isExplicitPersonalReset?: boolean;
  } = {},
): CodexUsageRecoveryDecision {
  if (!previous) return { kind: "baseline" };

  if (
    previous.limitId !== current.limitId ||
    previous.planType !== current.planType ||
    previous.windowDurationMins !== current.windowDurationMins
  ) {
    return { kind: "rebase" };
  }

  const previousTime = Date.parse(previous.observedAt);
  const currentTime = Date.parse(current.observedAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return { kind: "invalid" };
  if (currentTime <= previousTime) return { kind: "stale" };
  if (currentTime - previousTime > MAX_USAGE_COMPARISON_GAP_MS) return { kind: "rebase" };

  const usageDecrease = previous.usedPercent - current.usedPercent;
  const resetsAtAdvance = current.resetsAt - previous.resetsAt;
  if (usageDecrease < 1 || resetsAtAdvance < RESET_AT_MEANINGFUL_FORWARD_SEC) {
    return { kind: "no_recovery" };
  }

  const nearRegularSchedule = Math.abs(currentTime - previous.resetsAt * 1000) <= REGULAR_RESET_PROXIMITY_MS;
  const activeResetEvidence = options.activeResetEvidence === true || options.activeOfficialNotice === true;
  const cycleHint: CodexRecoveryCycleHint = nearRegularSchedule
    ? activeResetEvidence ? "unknown" : "regular"
    : "unexpected";

  // Monitor quality is strong on its own for unexpected weekly recoveries
  const confidence: CodexRecoveryConfidence = nearRegularSchedule && !activeResetEvidence ? "medium" : "strong";

  const isPersonalReset =
    options.isExplicitPersonalReset === true ||
    isExplicitBankedResetConsumption(previous, current, options.lastBankedGrantAt);

  return {
    kind: "recovery",
    nearRegularSchedule,
    cycleHint,
    confidence,
    isPersonalReset,
    previous,
    current,
  };
}

export function getPublicRecoveryObservation(
  observation: CodexRecoveryObservation | null | undefined,
  now: Date = new Date(),
  consumedRecoveryObservationIds: ReadonlySet<string> = new Set<string>(),
): PublicRecoveryObservation | null {
  if (
    !observation ||
    observation.status !== "observed" ||
    observation.confidence !== "strong" ||
    observation.cycleHint !== "unexpected"
  ) {
    return null;
  }

  const observedTime = Date.parse(observation.observedAt);
  const nowTime = now.getTime();
  if (!Number.isFinite(observedTime) || !Number.isFinite(nowTime) || observedTime > nowTime) return null;
  if (nowTime - observedTime > UNCONFIRMED_RECOVERY_ACTIVE_MS) return null;

  if (observation.id && consumedRecoveryObservationIds.has(observation.id)) {
    return null;
  }

  return {
    status: "observed_unconfirmed",
    observedAt: new Date(observedTime).toISOString(),
    confidence: "strong",
    cycleHint: observation.cycleHint,
  };
}

export function doesTiboResetMatchUsageObservation(
  observation: CodexRecoveryObservation | null | undefined,
  tiboTweetCreatedAt: string,
) {
  if (!observation || observation.status !== "observed" || observation.cycleHint === "regular") return false;
  const observedTime = Date.parse(observation.observedAt);
  const tweetTime = Date.parse(tiboTweetCreatedAt);
  return Number.isFinite(observedTime) && Number.isFinite(tweetTime) &&
    Math.abs(tweetTime - observedTime) <= USAGE_TIBO_MATCH_WINDOW_MS;
}
