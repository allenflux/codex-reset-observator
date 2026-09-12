import type {
  TiboSignalType,
  TiboVerificationStatus,
} from "./tiboHistory";
import {
  getTrustedTiboEditIdentity,
  type TiboEditIdentityRecord,
  type TiboEditIdentityUpdate,
} from "./tiboEditIdentity";

export type TiboLogicalPostRow = TiboEditIdentityRecord & {
  tweet_id: string;
  text: string;
  tweet_url?: string | null;
  tweet_created_at: string;
  signal_type: TiboSignalType;
  confidence?: number | null;
  classification_reason?: string | null;
  classification_source?: string | null;
  verification_status?: TiboVerificationStatus | string | null;
};

export type TiboLogicalPostVersion<T extends TiboLogicalPostRow = TiboLogicalPostRow> = {
  row: T;
  editVersion: number;
  inputIndex: number;
};

export type TiboManualState =
  | { kind: "none" }
  | {
      kind: "consistent";
      signalType: TiboSignalType;
      representativeTweetId: string;
      tweetIds: string[];
    }
  | {
      kind: "conflict";
      signalTypes: TiboSignalType[];
      tweetIds: string[];
    };

export type TiboEffectiveClassification<T extends TiboLogicalPostRow = TiboLogicalPostRow> =
  | {
      status: "resolved";
      basis: "effective_content" | "manual";
      signalType: TiboSignalType;
      confidence: number | null;
      classificationReason: string | null;
      classificationSource: string | null;
      verificationStatus: TiboVerificationStatus | string | null;
      representativeTweetId: string;
      row: T;
    }
  | {
      status: "unresolved";
      reason: "manual_conflict" | "no_effective_content";
      signalType: null;
      confidence: null;
      classificationReason: null;
      classificationSource: null;
      verificationStatus: null;
      representativeTweetId: null;
      row: null;
    };

export type TiboLogicalPost<T extends TiboLogicalPostRow = TiboLogicalPostRow> = {
  logicalPostId: string;
  authoritative: boolean;
  rawVersions: T[];
  effectiveContent: T | null;
  sourceTweetIds: string[];
  manualState: TiboManualState;
  effectiveClassification: TiboEffectiveClassification<T>;
  latestAuthoritativeTweetId: string;
  latestVersionPresent: boolean;
};

export type TiboLogicalPostConflict<T extends TiboLogicalPostRow = TiboLogicalPostRow> = {
  reason: "conflicting_trusted_edit_chains" | "invalid_trusted_edit_identity";
  rawVersions: T[];
  chains: string[][];
  tweetIds: string[];
};

export type TiboLogicalPostCollapseResult<T extends TiboLogicalPostRow = TiboLogicalPostRow> = {
  posts: TiboLogicalPost<T>[];
  conflicts: TiboLogicalPostConflict<T>[];
};

type IndexedRow<T extends TiboLogicalPostRow> = {
  row: T;
  inputIndex: number;
};

type TrustedClaim<T extends TiboLogicalPostRow> = IndexedRow<T> & {
  identity: TiboEditIdentityUpdate;
};

type WorkingChainGroup<T extends TiboLogicalPostRow> = {
  claims: TrustedClaim<T>[];
  chainIds: string[];
  conflicted: boolean;
};

type LogicalPostOptions = {
  logicalPostId: string;
  sourceTweetIds: readonly string[];
  authoritative: boolean;
};

function uniqueStrings(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueChains(chains: readonly (readonly string[])[]) {
  const result: string[][] = [];
  for (const chain of chains) {
    if (result.some((existing) => existing.length === chain.length &&
      existing.every((id, index) => id === chain[index]))) continue;
    result.push([...chain]);
  }
  return result;
}

function isPrefix(left: readonly string[], right: readonly string[]) {
  return left.length <= right.length && left.every((id, index) => id === right[index]);
}

function chainsIntersect(left: readonly string[], right: readonly string[]) {
  return left.some((id) => right.includes(id));
}

function areCompatibleChains(
  left: TiboEditIdentityUpdate,
  right: TiboEditIdentityUpdate,
) {
  return left.logical_post_id === right.logical_post_id &&
    (isPrefix(left.edit_history_tweet_ids, right.edit_history_tweet_ids) ||
      isPrefix(right.edit_history_tweet_ids, left.edit_history_tweet_ids));
}

function mergeChainIds(claims: readonly TrustedClaim<TiboLogicalPostRow>[], conflicted: boolean) {
  if (conflicted) {
    const ids: string[] = [];
    for (const claim of claims) ids.push(...claim.identity.edit_history_tweet_ids);
    return uniqueStrings(ids);
  }
  const longest = claims.reduce<string[]>((current, claim) =>
    claim.identity.edit_history_tweet_ids.length > current.length
      ? [...claim.identity.edit_history_tweet_ids]
      : current,
    [],
  );
  return [...longest];
}

function claimsConflict<T extends TiboLogicalPostRow>(claims: readonly TrustedClaim<T>[]) {
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      if (!areCompatibleChains(claims[leftIndex].identity, claims[rightIndex].identity)) return true;
    }
  }
  return false;
}

function hasInvalidTrustedIdentity<T extends TiboLogicalPostRow>(entry: IndexedRow<T>) {
  return entry.row.edit_metadata_source === "x_api" &&
    getTrustedTiboEditIdentity(entry.row, entry.row.tweet_id) === null;
}

function getRepresentativeVersion<T extends TiboLogicalPostRow>(
  versions: readonly TiboLogicalPostVersion<T>[],
) {
  return versions.reduce<TiboLogicalPostVersion<T> | null>((current, version) =>
    current === null || version.editVersion >= current.editVersion ? version : current,
  null);
}

export function resolveTiboManualState<T extends TiboLogicalPostRow>(
  versions: readonly TiboLogicalPostVersion<T>[],
): TiboManualState {
  const manualVersions = versions.filter((version) => version.row.classification_source === "manual");
  if (manualVersions.length === 0) return { kind: "none" };

  const signalTypes = uniqueStrings(manualVersions.map((version) => version.row.signal_type));
  const tweetIds = manualVersions.map((version) => version.row.tweet_id);
  if (signalTypes.length !== 1) {
    return { kind: "conflict", signalTypes: signalTypes as TiboSignalType[], tweetIds };
  }

  const representative = getRepresentativeVersion(manualVersions);
  return {
    kind: "consistent",
    signalType: signalTypes[0] as TiboSignalType,
    representativeTweetId: representative?.row.tweet_id ?? tweetIds[tweetIds.length - 1],
    tweetIds,
  };
}

function resolvedClassification<T extends TiboLogicalPostRow>(
  row: T,
  basis: "effective_content" | "manual",
): TiboEffectiveClassification<T> {
  return {
    status: "resolved",
    basis,
    signalType: row.signal_type,
    confidence: row.confidence ?? null,
    classificationReason: row.classification_reason ?? null,
    classificationSource: row.classification_source ?? null,
    verificationStatus: row.verification_status ?? null,
    representativeTweetId: row.tweet_id,
    row,
  };
}

export function resolveTiboEffectiveClassification<T extends TiboLogicalPostRow>(
  versions: readonly TiboLogicalPostVersion<T>[],
  effectiveContent: T | null,
  manualState: TiboManualState,
): TiboEffectiveClassification<T> {
  if (manualState.kind === "conflict") {
    return {
      status: "unresolved",
      reason: "manual_conflict",
      signalType: null,
      confidence: null,
      classificationReason: null,
      classificationSource: null,
      verificationStatus: null,
      representativeTweetId: null,
      row: null,
    };
  }
  if (manualState.kind === "consistent") {
    const representative = versions.find(
      (version) => version.row.tweet_id === manualState.representativeTweetId,
    );
    if (representative) return resolvedClassification(representative.row, "manual");
  }
  if (effectiveContent) return resolvedClassification(effectiveContent, "effective_content");
  return {
    status: "unresolved",
    reason: "no_effective_content",
    signalType: null,
    confidence: null,
    classificationReason: null,
    classificationSource: null,
    verificationStatus: null,
    representativeTweetId: null,
    row: null,
  };
}

export function resolveTiboLogicalPost<T extends TiboLogicalPostRow>(
  versions: readonly TiboLogicalPostVersion<T>[],
  options: LogicalPostOptions,
): TiboLogicalPost<T> {
  const orderedVersions = versions.slice().sort((left, right) =>
    left.editVersion - right.editVersion || left.inputIndex - right.inputIndex,
  );
  const rawVersions = orderedVersions.map((version) => version.row);
  const effectiveContent = orderedVersions.length > 0
    ? orderedVersions[orderedVersions.length - 1].row
    : null;
  const manualState = resolveTiboManualState(orderedVersions);

  return {
    logicalPostId: options.logicalPostId,
    authoritative: options.authoritative,
    rawVersions,
    effectiveContent,
    sourceTweetIds: [...options.sourceTweetIds],
    manualState,
    effectiveClassification: resolveTiboEffectiveClassification(
      orderedVersions,
      effectiveContent,
      manualState,
    ),
    latestAuthoritativeTweetId:
      options.sourceTweetIds[options.sourceTweetIds.length - 1] ?? options.logicalPostId,
    latestVersionPresent: options.sourceTweetIds.length > 0 && rawVersions.some(
      (row) => row.tweet_id === options.sourceTweetIds[options.sourceTweetIds.length - 1],
    ),
  };
}

/**
 * Projects one logical post into the row shape consumed by existing Tibo
 * helpers. Content fields come from the latest stored version while
 * classification fields come from the logical post's resolved classification
 * (which may be a protected manual representative).
 */
export function toEffectiveTiboLogicalPostRow<T extends TiboLogicalPostRow>(
  logicalPost: TiboLogicalPost<T>,
): T | null {
  const content = logicalPost.effectiveContent;
  const classification = logicalPost.effectiveClassification;
  if (
    !content ||
    !logicalPost.latestVersionPresent ||
    classification.status !== "resolved"
  ) {
    return null;
  }

  const editVersion = logicalPost.sourceTweetIds.indexOf(content.tweet_id) + 1;
  return {
    ...content,
    tweet_id: content.tweet_id,
    text: content.text,
    tweet_url: content.tweet_url ?? null,
    tweet_created_at: content.tweet_created_at,
    signal_type: classification.signalType,
    confidence: classification.confidence,
    classification_reason: classification.classificationReason,
    classification_source: classification.classificationSource,
    verification_status: classification.verificationStatus,
    logical_post_id: logicalPost.logicalPostId,
    edit_history_tweet_ids: logicalPost.sourceTweetIds.slice(),
    edit_version: editVersion > 0 ? editVersion : content.edit_version ?? undefined,
    edit_metadata_source: logicalPost.authoritative ? "x_api" : "none",
  } as T;
}

function toVersion<T extends TiboLogicalPostRow>(
  entry: IndexedRow<T>,
  sourceTweetIds: readonly string[],
): TiboLogicalPostVersion<T> {
  const authoritativeVersion = sourceTweetIds.indexOf(entry.row.tweet_id);
  return {
    row: entry.row,
    editVersion: authoritativeVersion >= 0 ? authoritativeVersion + 1 : 1,
    inputIndex: entry.inputIndex,
  };
}

function addClaimToGroups<T extends TiboLogicalPostRow>(
  groups: WorkingChainGroup<T>[],
  claim: TrustedClaim<T>,
) {
  const matchingGroups = groups.filter((group) => chainsIntersect(group.chainIds, claim.identity.edit_history_tweet_ids));
  if (matchingGroups.length === 0) {
    groups.push({
      claims: [claim],
      chainIds: [...claim.identity.edit_history_tweet_ids],
      conflicted: false,
    });
    return;
  }

  const claims = matchingGroups.flatMap((group) => group.claims).concat(claim);
  const conflicted = matchingGroups.some((group) => group.conflicted) || claimsConflict(claims);
  const matchingSet = new Set(matchingGroups);
  const remainingGroups = groups.filter((group) => !matchingSet.has(group));
  remainingGroups.push({
    claims,
    chainIds: mergeChainIds(claims, conflicted),
    conflicted,
  });
  groups.splice(0, groups.length, ...remainingGroups);
}

export function collapseTrustedTiboEditChains<T extends TiboLogicalPostRow>(
  rows: readonly T[],
): TiboLogicalPostCollapseResult<T> {
  const entries: IndexedRow<T>[] = rows.map((row, inputIndex) => ({ row, inputIndex }));
  const invalidTrustedEntries = entries.filter(hasInvalidTrustedIdentity);
  const claims: TrustedClaim<T>[] = [];
  for (const entry of entries) {
    const identity = getTrustedTiboEditIdentity(entry.row, entry.row.tweet_id);
    if (identity) claims.push({ ...entry, identity });
  }

  const groups: WorkingChainGroup<T>[] = [];
  for (const claim of claims) addClaimToGroups(groups, claim);

  const assigned = new Set<number>();
  const posts: Array<{ inputIndex: number; post: TiboLogicalPost<T> }> = [];
  const conflicts: TiboLogicalPostConflict<T>[] = [];

  for (const group of groups) {
    const memberIds = new Set(group.chainIds);
    const groupEntries = entries.filter((entry) => memberIds.has(entry.row.tweet_id));
    groupEntries.forEach((entry) => assigned.add(entry.inputIndex));

    if (groupEntries.some(hasInvalidTrustedIdentity)) {
      conflicts.push({
        reason: "invalid_trusted_edit_identity",
        rawVersions: groupEntries.map((entry) => entry.row),
        chains: uniqueChains(
          group.claims.map((claim) => claim.identity.edit_history_tweet_ids),
        ),
        tweetIds: groupEntries.map((entry) => entry.row.tweet_id),
      });
      continue;
    }

    if (group.conflicted) {
      conflicts.push({
        reason: "conflicting_trusted_edit_chains",
        rawVersions: groupEntries.map((entry) => entry.row),
        chains: uniqueChains(
          group.claims.map((claim) => claim.identity.edit_history_tweet_ids),
        ),
        tweetIds: [...group.chainIds],
      });
      continue;
    }

    const versions = groupEntries.map((entry) => toVersion(entry, group.chainIds));
    posts.push({
      inputIndex: groupEntries.reduce((first, entry) => Math.min(first, entry.inputIndex), Number.MAX_SAFE_INTEGER),
      post: resolveTiboLogicalPost(versions, {
        logicalPostId: group.chainIds[0],
        sourceTweetIds: group.chainIds,
        authoritative: true,
      }),
    });
  }

  for (const entry of entries) {
    if (assigned.has(entry.inputIndex)) continue;
    if (invalidTrustedEntries.some((invalid) => invalid.inputIndex === entry.inputIndex)) {
      assigned.add(entry.inputIndex);
      conflicts.push({
        reason: "invalid_trusted_edit_identity",
        rawVersions: [entry.row],
        chains: [],
        tweetIds: [entry.row.tweet_id],
      });
      continue;
    }
    posts.push({
      inputIndex: entry.inputIndex,
      post: resolveTiboLogicalPost([toVersion(entry, [entry.row.tweet_id])], {
        logicalPostId: entry.row.tweet_id,
        sourceTweetIds: [entry.row.tweet_id],
        authoritative: false,
      }),
    });
  }

  posts.sort((left, right) => left.inputIndex - right.inputIndex);
  return { posts: posts.map((entry) => entry.post), conflicts };
}

export function getTiboLogicalIdentityAliases<T extends TiboLogicalPostRow>(
  logicalPost: TiboLogicalPost<T>,
) {
  return logicalPost.sourceTweetIds.slice();
}
