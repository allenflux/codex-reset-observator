import type { TeaserStrength } from "./teaserStrength";
import type { TiboTemporalResolution } from "./tiboTemporal";
import type { TiboEditIdentityFields } from "./tiboEditIdentity";

export type TiboSecondarySignalType = "official_notice" | "teaser" | "none";

export type TiboSecondaryManualOverride = {
  source: "manual";
  signalType: "teaser";
  teaserStrength: Exclude<TeaserStrength, "none">;
  reasonJa: string;
  reviewedAt: string;
};

export type TiboSecondaryManualOverrideInput = {
  signalType: "teaser";
  teaserStrength: Exclude<TeaserStrength, "none">;
  reasonJa: string;
  reviewedAt: string;
};

export type TiboSecondarySignal = {
  signalType: TiboSecondarySignalType;
  teaserStrength: TeaserStrength | null;
  confidence: number | null;
  evidenceQuote: string | null;
  reasonJa: string | null;
  expiresAt?: string | null;
  /** Raw AI signal plus an optional human-only effective override. */
  manualOverride?: TiboSecondaryManualOverride | null;
  temporal?: Pick<
    TiboTemporalResolution,
    | "status"
    | "version"
    | "temporalExpression"
    | "temporalKind"
    | "temporalPrecision"
    | "timezone"
    | "confidence"
    | "expectedStartAt"
    | "expectedEndAt"
    | "resolutionSource"
  > | null;
};

export type TiboSecondarySignalParent = TiboEditIdentityFields & {
  tweet_id?: string;
  signal_type?: string | null;
  classification_source?: string | null;
  tweet_created_at: string;
  expires_at?: string | null;
  secondary_signal?: TiboSecondarySignal | null;
};

export type ProjectedTiboSecondarySignal = {
  is_secondary_future_signal: boolean;
  parent_tweet_id: string;
  primary_event_at: string;
};

function isValidManualOverride(value: unknown): value is TiboSecondaryManualOverride {
  if (!value || typeof value !== "object") return false;
  const override = value as Partial<TiboSecondaryManualOverride>;
  return override.source === "manual" &&
    override.signalType === "teaser" &&
    (override.teaserStrength === "strong" || override.teaserStrength === "weak") &&
    typeof override.reasonJa === "string" &&
    override.reasonJa.trim().length > 0 &&
    override.reasonJa.length <= 1000 &&
    typeof override.reviewedAt === "string" &&
    Number.isFinite(Date.parse(override.reviewedAt));
}

/**
 * Stores only a secondary teaser correction. The AI fields remain untouched;
 * callers derive the effective signal with getEffectiveTiboSecondarySignal.
 */
export function setTiboSecondaryManualOverride(
  signal: TiboSecondarySignal | null | undefined,
  override: TiboSecondaryManualOverrideInput,
): TiboSecondarySignal | null {
  if (!signal) return null;
  if (
    override.signalType !== "teaser" ||
    (override.teaserStrength !== "strong" && override.teaserStrength !== "weak")
  ) {
    throw new Error("Secondary manual overrides must be strong or weak teasers.");
  }

  const reasonJa = override.reasonJa.trim();
  if (!reasonJa || reasonJa.length > 1000) {
    throw new Error("Secondary manual override reason is invalid.");
  }
  if (!Number.isFinite(Date.parse(override.reviewedAt))) {
    throw new Error("Secondary manual override review time is invalid.");
  }

  return {
    ...signal,
    manualOverride: {
      source: "manual",
      signalType: "teaser",
      teaserStrength: override.teaserStrength,
      reasonJa,
      reviewedAt: override.reviewedAt,
    },
  };
}

export function clearTiboSecondaryManualOverride(
  signal: TiboSecondarySignal | null | undefined,
): TiboSecondarySignal | null {
  if (!signal) return null;
  return { ...signal, manualOverride: null };
}

/** Returns the effective secondary signal while leaving its AI provenance intact. */
export function getEffectiveTiboSecondarySignal(
  signal: TiboSecondarySignal | null | undefined,
): TiboSecondarySignal | null {
  if (!signal) return null;
  if (!isValidManualOverride(signal.manualOverride)) return signal;

  return {
    ...signal,
    signalType: "teaser",
    teaserStrength: signal.manualOverride.teaserStrength,
    reasonJa: signal.manualOverride.reasonJa,
  };
}

export function getTiboSecondaryVirtualId(tweetId: string) {
  return `${tweetId}#secondary`;
}

function isProjectableSecondarySignal(
  signal: TiboSecondarySignalParent,
): signal is TiboSecondarySignalParent & { secondary_signal: TiboSecondarySignal } {
  const effective = getEffectiveTiboSecondarySignal(signal.secondary_signal);
  return Boolean(signal.tweet_id) &&
    signal.signal_type === "reset_executed" &&
    effective?.signalType !== undefined &&
    (effective.signalType === "official_notice" ||
      (effective.signalType === "teaser" &&
        (effective.teaserStrength === "strong" || effective.teaserStrength === "weak")));
}

export function expandTiboSignalVariants<T extends TiboSecondarySignalParent>(
  signals: readonly T[] | null | undefined,
): Array<T & Partial<ProjectedTiboSecondarySignal>> {
  const parents = new Map<string, T>();
  let anonymousIndex = 0;
  for (const signal of signals ?? []) {
    const key = signal.tweet_id ?? `__anonymous-${anonymousIndex++}`;
    const existing = parents.get(key);
    if (!existing) {
      parents.set(key, signal);
      continue;
    }

    const merged = { ...existing } as T;
    const mergedRecord = merged as Record<string, unknown>;
    const incomingRecord = signal as Record<string, unknown>;
    for (const [field, value] of Object.entries(incomingRecord)) {
      if (
        value !== null &&
        value !== undefined &&
        (mergedRecord[field] === null || mergedRecord[field] === undefined)
      ) {
        mergedRecord[field] = value;
      }
    }
    parents.set(key, merged);
  }

  const projected: Array<T & Partial<ProjectedTiboSecondarySignal>> = [];
  for (const signal of Array.from(parents.values())) {
    projected.push(signal);
    if (!isProjectableSecondarySignal(signal)) continue;

    const secondary = signal.secondary_signal;
    const effectiveSecondary = getEffectiveTiboSecondarySignal(secondary)!;
    const temporal = effectiveSecondary.temporal;
    const parentTweetId = signal.tweet_id!;
    projected.push({
      ...signal,
      tweet_id: getTiboSecondaryVirtualId(parentTweetId),
      signal_type: effectiveSecondary.signalType,
      confidence: effectiveSecondary.confidence ?? undefined,
      classification_reason: effectiveSecondary.reasonJa ?? undefined,
      teaser_strength: effectiveSecondary.teaserStrength,
      expires_at: effectiveSecondary.expiresAt ?? signal.expires_at,
      classification_source: effectiveSecondary.manualOverride?.source ?? signal.classification_source,
      ai_teaser_strength: secondary.teaserStrength,
      ai_teaser_strength_confidence: secondary.confidence,
      ai_teaser_strength_evidence_quote: secondary.evidenceQuote,
      ai_teaser_strength_reason_ja: secondary.reasonJa,
      ai_temporal_expression: temporal?.temporalExpression ?? null,
      ai_temporal_kind: temporal?.temporalKind ?? null,
      ai_temporal_precision: temporal?.temporalPrecision ?? null,
      ai_temporal_timezone: temporal?.timezone ?? null,
      ai_temporal_confidence: temporal?.confidence ?? null,
      temporal_expression: temporal?.temporalExpression ?? null,
      temporal_kind: temporal?.temporalKind ?? null,
      temporal_precision: temporal?.temporalPrecision ?? null,
      temporal_timezone: temporal?.timezone ?? null,
      temporal_confidence: temporal?.confidence ?? null,
      temporal_resolution_source: temporal?.resolutionSource ?? null,
      expected_start_at: temporal?.expectedStartAt ?? null,
      expected_end_at: temporal?.expectedEndAt ?? null,
      temporal_resolution_status: temporal?.status ?? null,
      temporal_resolution_version: temporal?.version ?? null,
      secondary_signal: null,
      is_secondary_future_signal: true,
      parent_tweet_id: parentTweetId,
      primary_event_at: signal.tweet_created_at,
    } as unknown as T & ProjectedTiboSecondarySignal);
  }

  return projected;
}
