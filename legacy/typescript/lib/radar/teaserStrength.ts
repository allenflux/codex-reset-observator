import { expandTiboSignalVariants } from "./tiboSecondarySignal";
import type { TiboSecondarySignal } from "./tiboSecondarySignal";
import {
  getTemporalExecutionWindowRelation,
  type ResetExecutionWindow,
} from "./tiboTemporal";
import { isTiboForecastSignalTerminatedAt } from "./officialNoticePolicy";

export const TIBO_TEASER_STRENGTHS = ["strong", "weak", "none"] as const;

export type TeaserStrength = (typeof TIBO_TEASER_STRENGTHS)[number];
export type ResetTeaserStatus = TeaserStrength | "unknown";

const RESET_TEASER_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export type ResetTeaserSignal = {
  tweet_id?: string;
  tweet_created_at: string;
  teaser_strength?: TeaserStrength | null;
  ai_teaser_strength?: TeaserStrength | null;
  signal_type?: string | null;
  verification_status?: string | null;
  is_reply?: boolean | null;
  expires_at?: string | null;
  temporal_precision?: "exact_time" | "day" | "daypart" | "range" | "unknown" | null;
  temporal_confidence?: number | null;
  expected_start_at?: string | null;
  expected_end_at?: string | null;
  temporal_resolution_status?: "resolved" | "unresolved" | "rejected" | null;
  secondary_signal?: TiboSecondarySignal | null;
  is_secondary_future_signal?: boolean;
  primary_event_at?: string;
};

export type TeaserStrengthWindowOptions = {
  includeReplies?: boolean;
  resetExecutionWindow?: ResetExecutionWindow | null;
};

export function getEffectiveTeaserStrength(signal: {
  teaser_strength?: TeaserStrength | null;
  ai_teaser_strength?: TeaserStrength | null;
}) {
  return signal.teaser_strength ?? signal.ai_teaser_strength ?? null;
}

export function isTeaserStrength(value: unknown): value is TeaserStrength {
  return typeof value === "string" &&
    (TIBO_TEASER_STRENGTHS as readonly string[]).includes(value);
}

function getTimestamp(value: string | Date | null | undefined) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Returns posts eligible for a 48-hour teaser-strength window.
 * Expiration is intentionally not part of this filter; callers can choose
 * whether replies belong to their own use of the shared time window.
 */
export function getTeaserStrengthSignals(
  signals: readonly ResetTeaserSignal[] | null | undefined,
  latestResetAt: string | Date | null | undefined,
  now: Date = new Date(),
  options: TeaserStrengthWindowOptions = {},
) {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return [];

  const latestResetTime = getTimestamp(latestResetAt);
  const cutoffTime = nowTime - RESET_TEASER_LOOKBACK_MS;
  const includeReplies = options.includeReplies ?? true;
  const resetExecutionWindow = options.resetExecutionWindow ?? (latestResetTime === null
    ? null
    : { executionWindowStartAt: null, executionWindowEndAt: new Date(latestResetTime).toISOString() });
  const activeForecastSignals = (signals ?? []).filter((signal) =>
    !isTiboForecastSignalTerminatedAt(signal.tweet_id, now)
  );
  const expandedSignals = expandTiboSignalVariants(activeForecastSignals);

  return expandedSignals.filter((signal) => {
    const createdTime = getTimestamp(signal.tweet_created_at);
    const primaryEventTime = signal.is_secondary_future_signal === true
      ? getTimestamp(signal.primary_event_at)
      : null;
    const temporalRelation = getTemporalExecutionWindowRelation(
      signal.temporal_resolution_status === "resolved"
        ? {
            status: signal.temporal_resolution_status,
            expectedStartAt: signal.expected_start_at ?? null,
            expectedEndAt: signal.expected_end_at ?? null,
          }
        : null,
      resetExecutionWindow,
    );
    const isFutureWindowAfterBoundary = temporalRelation === "before";
    const isSemanticallyAfterBoundary = latestResetTime === null ||
      (createdTime !== null && createdTime > latestResetTime) ||
      (primaryEventTime !== null && primaryEventTime === latestResetTime) ||
      (createdTime !== null && createdTime <= latestResetTime && isFutureWindowAfterBoundary);
    return Boolean(
      createdTime !== null &&
        createdTime <= nowTime &&
        createdTime >= cutoffTime &&
        isSemanticallyAfterBoundary &&
        signal.verification_status !== "rejected" &&
        signal.signal_type !== "official_notice" &&
        signal.signal_type !== "reset_executed" &&
        (includeReplies || signal.is_reply !== true),
    );
  });
}

/**
 * UI aggregation keeps its existing reply-inclusive behavior. Probability
 * code uses getTeaserStrengthSignals directly with replies disabled.
 */
export function getUiResetTeaserSignals(
  signals: readonly ResetTeaserSignal[] | null | undefined,
  latestResetAt: string | Date | null | undefined,
  now: Date = new Date(),
  resetExecutionWindow: ResetExecutionWindow | null = null,
) {
  return getTeaserStrengthSignals(signals, latestResetAt, now, {
    includeReplies: true,
    resetExecutionWindow,
  });
}

/**
 * Aggregates the UI-only teaser state without changing the meaning of any
 * active signal, expiry, or probability input.
 */
export function aggregateResetTeaserStatus(
  signals: readonly ResetTeaserSignal[] | null | undefined,
  latestResetAt: string | Date | null | undefined,
  now: Date = new Date(),
  resetExecutionWindow: ResetExecutionWindow | null = null,
): ResetTeaserStatus {
  const eligibleSignals = getUiResetTeaserSignals(
    signals,
    latestResetAt,
    now,
    resetExecutionWindow,
  );
  let hasEligiblePost = false;
  let hasWeak = false;
  let hasNone = false;

  for (const signal of eligibleSignals) {
    hasEligiblePost = true;
    const strength = getEffectiveTeaserStrength(signal);
    if (strength === "strong") return "strong";
    if (strength === "weak") {
      hasWeak = true;
    } else if (strength === "none") {
      hasNone = true;
    }
  }

  if (hasWeak) return "weak";
  if (hasNone) return "none";
  return hasEligiblePost ? "unknown" : "none";
}

export type TeaserStrengthAssessment = {
  teaserStrength: TeaserStrength | null;
  teaserStrengthConfidence: number | null;
  teaserStrengthEvidenceQuote: string | null;
  teaserStrengthReasonJa: string | null;
};

function getExactEvidenceQuote(value: unknown, sourceText: string) {
  if (typeof value !== "string" || value.length > 300) return null;

  const quote = value.trim();
  if (!quote) return null;
  return sourceText.toLowerCase().includes(quote.toLowerCase()) ? quote : null;
}

export function parseTeaserStrengthAssessment(
  value: unknown,
  sourceText: string,
): TeaserStrengthAssessment {
  if (!value || typeof value !== "object") {
    return {
      teaserStrength: null,
      teaserStrengthConfidence: null,
      teaserStrengthEvidenceQuote: null,
      teaserStrengthReasonJa: null,
    };
  }

  const parsed = value as Record<string, unknown>;
  const teaserStrength = isTeaserStrength(parsed.teaserStrength)
    ? parsed.teaserStrength
    : null;
  if (!teaserStrength) {
    return {
      teaserStrength: null,
      teaserStrengthConfidence: null,
      teaserStrengthEvidenceQuote: null,
      teaserStrengthReasonJa: null,
    };
  }

  const confidence = parsed.teaserStrengthConfidence;
  const teaserStrengthConfidence = typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
    ? confidence
    : null;

  return {
    teaserStrength,
    teaserStrengthConfidence,
    teaserStrengthEvidenceQuote: getExactEvidenceQuote(
      parsed.teaserStrengthEvidenceQuote,
      sourceText,
    ),
    teaserStrengthReasonJa:
      typeof parsed.teaserStrengthReasonJa === "string"
        ? parsed.teaserStrengthReasonJa.slice(0, 500)
        : null,
  };
}
