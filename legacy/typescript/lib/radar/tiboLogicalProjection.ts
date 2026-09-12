import type { ActiveTiboSignal, RadarData } from "./types";
import type { FormalTiboResetSignal } from "./tiboHistory";
import { getTrustedTiboEditIdentity } from "./tiboEditIdentity";
import {
  collapseTrustedTiboEditChains,
  toEffectiveTiboLogicalPostRow,
  type TiboLogicalPost,
  type TiboLogicalPostRow,
  type TiboLogicalPostConflict,
} from "./tiboLogicalPost";

export type TiboReadSideSignal = ActiveTiboSignal | FormalTiboResetSignal;

type TiboReadSideSignalSource = "active" | "recent" | "formal" | "direct";

type TiboReadSideSignalCandidate = {
  signal: TiboReadSideSignal;
  source: TiboReadSideSignalSource;
};

type TiboRawTweetVersionConflict = {
  reason: "conflicting_raw_tweet_versions";
  rawVersions: TiboLogicalPostRow[];
  chains: string[][];
  tweetIds: string[];
  fields: string[];
};

export type TiboReadSideConflict =
  | TiboLogicalPostConflict<TiboLogicalPostRow>
  | TiboRawTweetVersionConflict;

export type TiboReadSideProjection = {
  logicalPosts: Array<TiboLogicalPost<TiboLogicalPostRow>>;
  effectiveSignals: ActiveTiboSignal[];
  suppressedLogicalPosts: Array<TiboLogicalPost<TiboLogicalPostRow>>;
  conflicts: TiboReadSideConflict[];
};

export type TiboReadSideSignalScope =
  | "all"
  | "active"
  | "recent"
  | "probability"
  | "teaser";

export type TiboReadSideInput = {
  active_tibo_signals?: readonly TiboReadSideSignal[] | null;
  recent_tibo_signals?: readonly TiboReadSideSignal[] | null;
  formal_tibo_resets?: readonly TiboReadSideSignal[] | null;
};

type ReadSideProjectionCacheEntry = {
  activeSignals: RadarData["active_tibo_signals"];
  recentSignals: RadarData["recent_tibo_signals"];
  formalResets: RadarData["formal_tibo_resets"];
  effectiveSignals: ActiveTiboSignal[];
  effectiveSignalByRawTweetId: Map<string, ActiveTiboSignal>;
};

const readSideProjectionCache = new WeakMap<object, ReadSideProjectionCacheEntry>();

function cloneOptionalArray<T>(value: T[] | null | undefined) {
  return value === null || value === undefined ? value : [...value];
}

function toLogicalPostRow(signal: TiboReadSideSignal): TiboLogicalPostRow {
  const row = {
    ...signal,
    tweet_id: signal.tweet_id,
    text: signal.text ?? "",
    tweet_url: signal.tweet_url ?? null,
    tweet_created_at: signal.tweet_created_at,
    edit_history_tweet_ids: cloneOptionalArray(signal.edit_history_tweet_ids),
  } as TiboLogicalPostRow & { reply_to_handles?: string[] | null };
  row.reply_to_handles = cloneOptionalArray(signal.reply_to_handles);
  return row;
}

const CLASSIFICATION_FIELDS = new Set([
  "signal_type",
  "confidence",
  "classification_reason",
  "classification_source",
  "verification_status",
]);

const IDENTITY_FIELDS = new Set([
  "logical_post_id",
  "edit_history_tweet_ids",
  "edit_version",
  "edit_metadata_source",
]);

// These fields affect public signal meaning or provenance. Non-null conflicts
// are not resolved by whichever source happened to be iterated first.
const SEMANTIC_FIELDS = [
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "signal_type",
  "confidence",
  "classification_reason",
  "classification_source",
  "verification_status",
  "teaser_strength",
  "ai_teaser_strength",
  "secondary_signal",
  "is_secondary_future_signal",
  "parent_tweet_id",
  "primary_event_at",
  "translated_text_ja",
  "translated_text_zh",
  "ai_temporal_expression",
  "ai_temporal_kind",
  "ai_temporal_direction",
  "ai_temporal_precision",
  "ai_temporal_timezone",
  "ai_temporal_confidence",
  "temporal_expression",
  "temporal_kind",
  "temporal_precision",
  "temporal_timezone",
  "temporal_confidence",
  "temporal_resolution_source",
  "expected_start_at",
  "expected_end_at",
  "temporal_resolution_status",
  "temporal_resolution_version",
  "is_reply",
  "is_quote",
  "quote_context_text",
  "quote_tweet_url",
  "quote_author_handle",
  "reply_to_handles",
  "reply_context_text",
  "rule_signal_type",
  "ai_signal_type",
  "ai_reason_ja",
  "ai_classification_status",
  "ai_reset_type_ja",
  "ai_notice_to_execution",
  "ai_teaser_strength",
  "ai_teaser_strength_confidence",
  "ai_teaser_strength_evidence_quote",
  "ai_teaser_strength_reason_ja",
  "source_timeline",
  "related_notice",
  "related_notices",
  ...Array.from(IDENTITY_FIELDS),
];

function hasMeaningfulValue(value: unknown) {
  return value !== null && value !== undefined &&
    !(typeof value === "string" && value.trim() === "");
}

function cloneMergedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMergedValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = cloneMergedValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`,
  ).join(",")}}`;
}

function sourcePriority(source: TiboReadSideSignalSource) {
  return source === "active" ? 3 : source === "recent" ? 2 : source === "formal" ? 1 : 0;
}

function candidateRichness(candidate: TiboReadSideSignalCandidate) {
  return Object.values(candidate.signal as Record<string, unknown>)
    .filter(hasMeaningfulValue).length;
}

function compareCandidatePreference(
  left: TiboReadSideSignalCandidate,
  right: TiboReadSideSignalCandidate,
) {
  const richnessDifference = candidateRichness(right) - candidateRichness(left);
  if (richnessDifference !== 0) return richnessDifference;

  const sourceDifference = sourcePriority(right.source) - sourcePriority(left.source);
  if (sourceDifference !== 0) return sourceDifference;

  const leftKey = stableSerialize(left.signal);
  const rightKey = stableSerialize(right.signal);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isManualCandidate(candidate: TiboReadSideSignalCandidate) {
  return candidate.signal.classification_source === "manual";
}

function isTrustedIdentityCandidate(candidate: TiboReadSideSignalCandidate) {
  return candidate.signal.edit_metadata_source === "x_api";
}

function isChainPrefix(left: readonly string[], right: readonly string[]) {
  return left.length <= right.length && left.every((id, index) => id === right[index]);
}

function trustedIdentityCandidates(
  candidates: readonly TiboReadSideSignalCandidate[],
) {
  return candidates
    .filter(isTrustedIdentityCandidate)
    .map((candidate) => getTrustedTiboEditIdentity(candidate.signal, candidate.signal.tweet_id));
}

function hasTrustedIdentityConflict(
  candidates: readonly TiboReadSideSignalCandidate[],
) {
  const identities = trustedIdentityCandidates(candidates);
  if (identities.length < 2) return false;
  if (identities.some((identity) => identity === null)) return true;

  const first = identities[0]!;
  return identities.slice(1).some((identity) =>
    identity!.logical_post_id !== first.logical_post_id ||
    identity!.edit_version !== first.edit_version ||
    !(isChainPrefix(first.edit_history_tweet_ids, identity!.edit_history_tweet_ids) ||
      isChainPrefix(identity!.edit_history_tweet_ids, first.edit_history_tweet_ids)),
  );
}

function candidatesForField(
  candidates: readonly TiboReadSideSignalCandidate[],
  field: string,
) {
  const withValue = candidates.filter((candidate) =>
    hasMeaningfulValue((candidate.signal as Record<string, unknown>)[field]),
  );
  if (IDENTITY_FIELDS.has(field)) {
    const trustedCandidates = candidates.filter(isTrustedIdentityCandidate);
    if (trustedCandidates.length > 0) {
      return trustedCandidates.filter((candidate) =>
        hasMeaningfulValue((candidate.signal as Record<string, unknown>)[field]),
      );
    }
  }
  if (CLASSIFICATION_FIELDS.has(field)) {
    const manual = withValue.filter(isManualCandidate);
    if (manual.length > 0) return manual;
  }
  return withValue;
}

function getComparableCandidatesForField(
  candidates: readonly TiboReadSideSignalCandidate[],
  field: string,
) {
  return candidatesForField(candidates, field);
}

function getConflictingFields(candidates: readonly TiboReadSideSignalCandidate[]) {
  const conflicts: string[] = [];
  if (hasTrustedIdentityConflict(candidates)) {
    conflicts.push("edit_history_tweet_ids");
  }
  for (const field of SEMANTIC_FIELDS) {
    if (IDENTITY_FIELDS.has(field)) continue;
    const comparable = getComparableCandidatesForField(candidates, field);
    if (comparable.length < 2) continue;
    const firstValue = (comparable[0].signal as Record<string, unknown>)[field];
    if (comparable.slice(1).some((candidate) =>
      stableSerialize((candidate.signal as Record<string, unknown>)[field]) !== stableSerialize(firstValue),
    )) {
      conflicts.push(field);
    }
  }
  return conflicts;
}

function preferredCandidateForField(
  candidates: readonly TiboReadSideSignalCandidate[],
  field: string,
) {
  return candidatesForField(candidates, field)
    .slice()
    .sort((left, right) => {
      if (field === "edit_history_tweet_ids") {
        const leftChain = (left.signal as Record<string, unknown>)[field];
        const rightChain = (right.signal as Record<string, unknown>)[field];
        if (Array.isArray(leftChain) && Array.isArray(rightChain) &&
          leftChain.length !== rightChain.length) {
          return rightChain.length - leftChain.length;
        }
      }
      return compareCandidatePreference(left, right);
    })[0] ?? null;
}

function mergeRawTweetVersionCandidates(
  candidates: readonly TiboReadSideSignalCandidate[],
) {
  const trustedCandidates = candidates.filter(isTrustedIdentityCandidate);
  const preferredBase = (trustedCandidates.length > 0 ? trustedCandidates : candidates)
    .slice()
    .sort(compareCandidatePreference)[0];
  if (!preferredBase) return {} as TiboReadSideSignal;
  const merged = { ...preferredBase.signal } as Record<string, unknown>;
  const fields = new Set<string>();
  for (const candidate of candidates) {
    for (const field of Object.keys(candidate.signal as Record<string, unknown>)) {
      fields.add(field);
    }
  }
  fields.forEach((field) => {
    const preferred = preferredCandidateForField(candidates, field);
    if (!preferred) return;
    merged[field] = cloneMergedValue(
      (preferred.signal as Record<string, unknown>)[field],
    );
  });
  return merged as TiboReadSideSignal;
}

function compareStringArrays(left: readonly string[], right: readonly string[]) {
  const leftKey = left.join("\u0000");
  const rightKey = right.join("\u0000");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function uniqueSortedStrings(values: readonly string[]) {
  return Array.from(new Set(values)).sort();
}

function getConflictChains(candidates: readonly TiboReadSideSignalCandidate[]) {
  const chains: string[][] = [];
  for (const candidate of candidates) {
    const chain = candidate.signal.edit_history_tweet_ids;
    if (!Array.isArray(chain) || chain.length === 0) continue;
    if (!chains.some((existing) => stableSerialize(existing) === stableSerialize(chain))) {
      chains.push([...chain]);
    }
  }
  return chains.sort(compareStringArrays);
}

function collectRawSignalCandidates(
  input: TiboReadSideInput | readonly TiboReadSideSignal[],
) {
  if (Array.isArray(input)) {
    return input.map((signal): TiboReadSideSignalCandidate => ({ signal, source: "direct" }));
  }

  const objectInput = input as TiboReadSideInput;
  const candidates: TiboReadSideSignalCandidate[] = [];
  const add = (
    source: TiboReadSideSignalSource,
    signals: readonly TiboReadSideSignal[] | null | undefined,
  ) => {
    for (const signal of signals ?? []) candidates.push({ signal, source });
  };
  add("recent", objectInput.recent_tibo_signals);
  add("active", objectInput.active_tibo_signals);
  add("formal", objectInput.formal_tibo_resets);
  return candidates;
}

function deduplicateRawTweetVersions(
  candidates: readonly TiboReadSideSignalCandidate[],
) {
  const byTweetId = new Map<string, TiboReadSideSignalCandidate[]>();
  for (const candidate of candidates) {
    const group = byTweetId.get(candidate.signal.tweet_id) ?? [];
    group.push(candidate);
    byTweetId.set(candidate.signal.tweet_id, group);
  }

  const rows: TiboReadSideSignal[] = [];
  const conflicts: TiboRawTweetVersionConflict[] = [];
  byTweetId.forEach((group) => {
    const conflictingFields = getConflictingFields(group);
    if (conflictingFields.length === 0) {
      rows.push(mergeRawTweetVersionCandidates(group));
      return;
    }

    const chains = getConflictChains(group);
    const tweetIds = uniqueSortedStrings([
      ...group.map((candidate) => candidate.signal.tweet_id),
      ...chains.flat(),
    ]);
    conflicts.push({
      reason: "conflicting_raw_tweet_versions",
      rawVersions: group
        .slice()
        .sort(compareCandidatePreference)
        .map((candidate) => toLogicalPostRow(candidate.signal)),
      chains,
      tweetIds,
      fields: conflictingFields,
    });
  });

  conflicts.sort((left, right) => {
    const leftKey = left.tweetIds.join("\u0000");
    const rightKey = right.tweetIds.join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { rows, conflicts };
}

function isBlockedByRawConflict(
  signal: TiboReadSideSignal,
  blockedTweetIds: ReadonlySet<string>,
) {
  if (blockedTweetIds.has(signal.tweet_id)) return true;
  if (signal.logical_post_id && blockedTweetIds.has(signal.logical_post_id)) return true;
  return (signal.edit_history_tweet_ids ?? []).some((tweetId) =>
    blockedTweetIds.has(tweetId),
  );
}

function toEffectiveSignal(
  logicalPost: TiboLogicalPost<TiboLogicalPostRow>,
): ActiveTiboSignal | null {
  const row = toEffectiveTiboLogicalPostRow(logicalPost);
  if (!row) return null;
  return {
    ...row,
    tweet_url: row.tweet_url ?? undefined,
    confidence: row.confidence ?? undefined,
    classification_reason: row.classification_reason ?? undefined,
    classification_source: row.classification_source ?? undefined,
    verification_status: row.verification_status ?? undefined,
  } as ActiveTiboSignal;
}

export function buildTiboReadSideProjection(
  input: TiboReadSideInput | readonly TiboReadSideSignal[],
): TiboReadSideProjection {
  const deduplicated = deduplicateRawTweetVersions(collectRawSignalCandidates(input));
  const blockedTweetIds = new Set<string>();
  deduplicated.conflicts.forEach((conflict) => {
    conflict.tweetIds.forEach((tweetId) => blockedTweetIds.add(tweetId));
  });
  const rawSignals = deduplicated.rows.filter((signal) =>
    !isBlockedByRawConflict(signal, blockedTweetIds),
  );
  const collapsed = collapseTrustedTiboEditChains(
    rawSignals.map(toLogicalPostRow),
  );
  const suppressedLogicalPosts = collapsed.posts.filter(
    (post) => post.latestVersionPresent === false || post.effectiveClassification.status !== "resolved",
  );
  const effectiveSignals = collapsed.posts
    .map(toEffectiveSignal)
    .filter((signal): signal is ActiveTiboSignal => signal !== null);

  return {
    logicalPosts: collapsed.posts,
    effectiveSignals,
    suppressedLogicalPosts,
    conflicts: [...deduplicated.conflicts, ...collapsed.conflicts],
  };
}

function getScopeTweetIds(
  data: RadarData,
  scope: TiboReadSideSignalScope,
  includeFormalTiboResets: boolean,
) {
  const ids = new Set<string>();
  const add = (signals: readonly TiboReadSideSignal[] | null | undefined) => {
    for (const signal of signals ?? []) ids.add(signal.tweet_id);
  };

  if (scope === "active") {
    add(data.active_tibo_signals);
  } else if (scope === "recent") {
    add(data.recent_tibo_signals ?? data.active_tibo_signals);
  } else if (scope === "probability") {
    add(data.active_tibo_signals);
    add(data.formal_tibo_resets);
  } else if (scope === "teaser") {
    add(data.active_tibo_signals);
    add(data.recent_tibo_signals);
    if (includeFormalTiboResets) add(data.formal_tibo_resets);
  }
  return ids;
}

function indexEffectiveSignalsByRawTweetId(
  projection: TiboReadSideProjection,
) {
  const effectiveByLogicalPostId = new Map(
    projection.effectiveSignals.map((signal) => [
      signal.logical_post_id ?? signal.tweet_id,
      signal,
    ]),
  );
  const byRawTweetId = new Map<string, ActiveTiboSignal>();
  for (const post of projection.logicalPosts) {
    const effectiveSignal = effectiveByLogicalPostId.get(post.logicalPostId);
    if (!effectiveSignal) continue;
    for (const row of post.rawVersions) {
      byRawTweetId.set(row.tweet_id, effectiveSignal);
    }
  }
  return byRawTweetId;
}

function selectTiboReadSideSignals(
  data: RadarData,
  scope: TiboReadSideSignalScope,
  includeFormalTiboResets: boolean,
  effectiveSignals: ReadonlyArray<ActiveTiboSignal>,
  effectiveSignalByRawTweetId: ReadonlyMap<string, ActiveTiboSignal>,
) {
  if (scope === "all") return [...effectiveSignals];

  const allowedTweetIds = getScopeTweetIds(data, scope, includeFormalTiboResets);
  const allowedLogicalPostIds = new Set<string>();
  allowedTweetIds.forEach((tweetId) => {
    const effectiveSignal = effectiveSignalByRawTweetId.get(tweetId);
    if (effectiveSignal) {
      allowedLogicalPostIds.add(
        effectiveSignal.logical_post_id ?? effectiveSignal.tweet_id,
      );
    }
  });
  return effectiveSignals.filter((signal) =>
    allowedLogicalPostIds.has(signal.logical_post_id ?? signal.tweet_id),
  );
}

/**
 * Returns the canonical read-side signal set for one consumer scope. The
 * projection is cached once per immutable RadarData object and recomputed when
 * a caller supplies different raw array references, without adding a database
 * or API request.
 */
export function getTiboReadSideSignals(
  data: RadarData | null | undefined,
  scope: TiboReadSideSignalScope = "all",
  includeFormalTiboResets = false,
  projection?: TiboReadSideProjection,
) {
  if (!data) return [];

  if (projection) {
    return selectTiboReadSideSignals(
      data,
      scope,
      includeFormalTiboResets,
      projection.effectiveSignals,
      indexEffectiveSignalsByRawTweetId(projection),
    );
  }

  const cached = readSideProjectionCache.get(data);
  const sameRawInputs = cached &&
    cached.activeSignals === data.active_tibo_signals &&
    cached.recentSignals === data.recent_tibo_signals &&
    cached.formalResets === data.formal_tibo_resets;
  let entry = sameRawInputs ? cached : undefined;
  if (!entry) {
    const projection = buildTiboReadSideProjection(data);
    entry = {
      activeSignals: data.active_tibo_signals,
      recentSignals: data.recent_tibo_signals,
      formalResets: data.formal_tibo_resets,
      effectiveSignals: projection.effectiveSignals,
      effectiveSignalByRawTweetId: indexEffectiveSignalsByRawTweetId(projection),
    };
    readSideProjectionCache.set(data, entry);
  }
  return selectTiboReadSideSignals(
    data,
    scope,
    includeFormalTiboResets,
    entry.effectiveSignals,
    entry.effectiveSignalByRawTweetId,
  );
}
