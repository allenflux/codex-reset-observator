import {
  getTiboLogicalIdentityAliases,
  type TiboLogicalPost,
  type TiboLogicalPostRow,
} from "./tiboLogicalPost";

export type TiboFormalAdoptionClaimSource =
  | "new_adoption"
  | "existing_estimate"
  | "existing_history"
  | "existing_dynamic";

export type TiboFormalAdoptionLedgerLike = {
  id?: string;
  logicalPostId: string;
  logicalPostTweetIds: readonly string[];
  resetEventKey: string;
  representativeTweetId: string;
  sourceTweetIds: readonly string[];
  claimSource: TiboFormalAdoptionClaimSource;
  adoptedAt?: string | null;
  claimedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TiboResetExecutionEstimateReference = {
  resetEventKey: string;
  recoveryObservationId?: string | null;
  tiboSourceTweetIds?: readonly string[] | null;
  executionTimeSource?: string | null;
  estimatorVersion?: string | null;
};

export type TiboResetEventReference = {
  eventKey: string;
  sourceTweetIds?: readonly string[] | null;
  sourceUrl?: string | null;
};

export type TiboResetEventIdentityEvidence = {
  recoveryObservationId?: string | null;
  adoptionLedgers?: readonly TiboFormalAdoptionLedgerLike[];
  estimates?: readonly TiboResetExecutionEstimateReference[];
  staticHistory?: readonly TiboResetEventReference[];
  dynamicEvents?: readonly TiboResetEventReference[];
  sourceTweetIds?: readonly string[];
};

export type TiboResetEventEvidenceKind =
  | "existing_ledger"
  | "existing_estimate"
  | "existing_history"
  | "existing_dynamic";

export type TiboResetEventIdentityResolution = {
  status: "new" | "existing" | "conflict" | "blocked";
  logicalPostId: string;
  logicalPostTweetIds: string[];
  sourceTweetIds: string[];
  resetEventKey: string | null;
  authoritative: boolean;
  canCreateNewSideEffects: boolean;
  canRunFormalEnrichments: boolean;
  matchedEvidence: {
    kind: TiboResetEventEvidenceKind;
    resetEventKey: string;
  } | null;
  reason?:
    | "conflicting_event_keys"
    | "ambiguous_existing_claims"
    | "canonical_existing_claims"
    | "missing_authoritative_tail"
    | "manual_conflict"
    | "unresolved_classification";
};

type EvidenceMatch = {
  kind: TiboResetEventEvidenceKind;
  resetEventKey: string;
  priority: number;
};

type EvidenceCollection = {
  matches: EvidenceMatch[];
  conflictingEventKeys: string[];
};

function canRunFormalEnrichments<T extends TiboLogicalPostRow>(
  logicalPost: TiboLogicalPost<T>,
) {
  const classification = logicalPost.effectiveClassification;
  const row = classification.status === "resolved" ? classification.row : null;
  return Boolean(
    logicalPost.latestVersionPresent &&
      logicalPost.manualState.kind !== "conflict" &&
      classification.status === "resolved" &&
      classification.signalType === "reset_executed" &&
      typeof classification.confidence === "number" &&
      classification.confidence >= 0.95 &&
      classification.verificationStatus !== "rejected" &&
      (row as TiboLogicalPostRow & { is_reply?: boolean | null } | null)?.is_reply !== true,
  );
}

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0)));
}

function normalizedEventKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getTweetIdFromUrl(value: string | null | undefined) {
  if (!value) return null;
  const match = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  return match?.[1] ?? null;
}

function getTweetIdFromEventKey(value: string | null) {
  if (!value) return null;
  const match = value.match(/^tibo-reset-(\d+)$/);
  return match?.[1] ?? null;
}

function getReferenceTweetIds(reference: TiboResetEventReference) {
  const sourceUrlTweetId = getTweetIdFromUrl(reference.sourceUrl);
  const eventKeyTweetId = getTweetIdFromEventKey(reference.eventKey);
  return uniqueStrings([
    ...(reference.sourceTweetIds ?? []),
    ...(sourceUrlTweetId ? [sourceUrlTweetId] : []),
    ...(eventKeyTweetId ? [eventKeyTweetId] : []),
  ]);
}

function hasAliasOverlap(left: readonly string[], right: readonly string[]) {
  const rightIds = new Set(right);
  return left.some((id) => rightIds.has(id));
}

function isMonitorBackedEstimate(reference: TiboResetExecutionEstimateReference) {
  return reference.executionTimeSource === "usage_observation" &&
    reference.estimatorVersion === "usage-execution-monitor-v1";
}

function isSelfLogicalEventKey(eventKey: string, logicalPostId: string) {
  return eventKey === `tibo-reset-${logicalPostId}`;
}

function isCompatibleLedgerChain(
  existing: readonly string[],
  incoming: readonly string[],
) {
  if (existing.length === 0 || incoming.length === 0) return false;
  if (existing.length === 1 && incoming.includes(existing[0])) return true;
  if (incoming.length === 1 && existing.includes(incoming[0])) return true;
  const isPrefix = (shorter: readonly string[], longer: readonly string[]) =>
    shorter.length <= longer.length && shorter.every((id, index) => id === longer[index]);
  return isPrefix(existing, incoming) || isPrefix(incoming, existing);
}

function collectEvidenceMatches(
  logicalPostTweetIds: readonly string[],
  logicalPostId: string,
  evidence: TiboResetEventIdentityEvidence,
): EvidenceCollection {
  const matches: EvidenceMatch[] = [];
  const conflictingEventKeys: string[] = [];
  const add = (
    kind: TiboResetEventEvidenceKind,
    resetEventKey: unknown,
    priority: number,
  ) => {
    const key = normalizedEventKey(resetEventKey);
    if (key) matches.push({ kind, resetEventKey: key, priority });
  };

  for (const ledger of evidence.adoptionLedgers ?? []) {
    const key = normalizedEventKey(ledger.resetEventKey);
    if (!key) continue;
    const sameIdentity = ledger.logicalPostId === logicalPostId ||
      hasAliasOverlap(ledger.logicalPostTweetIds, logicalPostTweetIds);
    if (!sameIdentity) continue;
    if (!isCompatibleLedgerChain(ledger.logicalPostTweetIds, logicalPostTweetIds)) {
      conflictingEventKeys.push(key);
      continue;
    }
    add("existing_ledger", key, 500);
  }

  for (const estimate of evidence.estimates ?? []) {
    if (
      evidence.recoveryObservationId &&
      estimate.recoveryObservationId === evidence.recoveryObservationId
    ) {
      add("existing_estimate", estimate.resetEventKey, 400);
      continue;
    }
    if (hasAliasOverlap(logicalPostTweetIds, estimate.tiboSourceTweetIds ?? [])) {
      add("existing_estimate", estimate.resetEventKey, 300);
    }
  }

  for (const reference of evidence.staticHistory ?? []) {
    if (hasAliasOverlap(logicalPostTweetIds, getReferenceTweetIds(reference))) {
      add("existing_history", reference.eventKey, 200);
    }
  }

  for (const reference of evidence.dynamicEvents ?? []) {
    if (hasAliasOverlap(logicalPostTweetIds, getReferenceTweetIds(reference))) {
      add("existing_dynamic", reference.eventKey, 100);
    }
  }

  return { matches, conflictingEventKeys };
}

function buildBaseResolution<T extends TiboLogicalPostRow>(
  logicalPost: TiboLogicalPost<T>,
  sourceTweetIds: readonly string[],
): Pick<
  TiboResetEventIdentityResolution,
  "logicalPostId" | "logicalPostTweetIds" | "sourceTweetIds" | "authoritative"
> {
  return {
    logicalPostId: logicalPost.logicalPostId,
    logicalPostTweetIds: getTiboLogicalIdentityAliases(logicalPost),
    sourceTweetIds: uniqueStrings([
      ...getTiboLogicalIdentityAliases(logicalPost),
      ...sourceTweetIds,
    ]),
    authoritative: logicalPost.authoritative,
  };
}

export function resolveTiboResetEventIdentity<T extends TiboLogicalPostRow>(
  logicalPost: TiboLogicalPost<T>,
  evidence: TiboResetEventIdentityEvidence = {},
): TiboResetEventIdentityResolution {
  const base = buildBaseResolution(logicalPost, evidence.sourceTweetIds ?? []);
  const evidenceCollection = collectEvidenceMatches(
    base.logicalPostTweetIds,
    base.logicalPostId,
    evidence,
  );
  const matches = evidenceCollection.matches;
  const eventKeys = uniqueStrings(matches.map((match) => match.resetEventKey));
  const ledgerEventKeys = uniqueStrings(
    matches
      .filter((match) => match.kind === "existing_ledger")
      .map((match) => match.resetEventKey),
  );
  const externalEventKeys = uniqueStrings(
    matches
      .filter((match) => match.kind !== "existing_ledger")
      .map((match) => match.resetEventKey),
  );

  let existingEventKey: string | null = eventKeys.length === 1 ? eventKeys[0] : null;
  let existingConflictReason:
    | "conflicting_event_keys"
    | "ambiguous_existing_claims"
    | "canonical_existing_claims"
    | null = null;
  if (evidenceCollection.conflictingEventKeys.length > 0) {
    existingConflictReason = "conflicting_event_keys";
  } else if (eventKeys.length > 1) {
    const monitorEstimateKeys = uniqueStrings(
      matches
        .filter((match) => match.kind === "existing_estimate")
        .filter((match) => (evidence.estimates ?? []).some((estimate) =>
          normalizedEventKey(estimate.resetEventKey) === match.resetEventKey &&
          isMonitorBackedEstimate(estimate),
        ))
        .map((match) => match.resetEventKey),
    );
    if (monitorEstimateKeys.length === 1) {
      const monitorEstimateKey = monitorEstimateKeys[0];
      const nonMonitorMatches = matches.filter(
        (match) => match.resetEventKey !== monitorEstimateKey,
      );
      const onlySelfReferences = nonMonitorMatches.length > 0 && nonMonitorMatches.every(
        (match) =>
          (match.kind === "existing_ledger" || match.kind === "existing_dynamic") &&
          isSelfLogicalEventKey(match.resetEventKey, base.logicalPostId),
      );
      if (onlySelfReferences) existingEventKey = monitorEstimateKey;
    }

    if (existingEventKey) {
      // A monitor-backed estimate is the canonical event evidence when the
      // other matches are only self-derived tibo-reset keys.
    } else {
      const externallyProvenLedgerKeys = ledgerEventKeys.filter((key) =>
        externalEventKeys.includes(key),
      );
      if (
        ledgerEventKeys.length > 1 &&
        externallyProvenLedgerKeys.length === 1 &&
        externalEventKeys.every((key) => key === externallyProvenLedgerKeys[0])
      ) {
        existingEventKey = externallyProvenLedgerKeys[0];
      } else if (ledgerEventKeys.length > 1) {
        existingConflictReason = "ambiguous_existing_claims";
      } else {
        existingConflictReason = "conflicting_event_keys";
      }
    }
  }

  if (existingEventKey) {
    const selectedLedger = (evidence.adoptionLedgers ?? []).find(
      (ledger) => normalizedEventKey(ledger.resetEventKey) === existingEventKey,
    );
    const hasExistingRootLedger = (evidence.adoptionLedgers ?? []).some(
      (ledger) => normalizedEventKey(ledger.resetEventKey) !== existingEventKey &&
        ledger.logicalPostId === base.logicalPostId,
    );
    if (
      selectedLedger &&
      selectedLedger.logicalPostId !== base.logicalPostId &&
      hasExistingRootLedger
    ) {
      existingConflictReason = "canonical_existing_claims";
    }
  }

  if (existingConflictReason) {
    return {
      ...base,
      status: "conflict",
      resetEventKey: null,
      canCreateNewSideEffects: false,
      canRunFormalEnrichments: false,
      matchedEvidence: null,
      reason: existingConflictReason,
    };
  }

  if (existingEventKey) {
    const match = matches
      .filter((candidate) => candidate.resetEventKey === existingEventKey)
      .sort((left, right) => right.priority - left.priority)[0];
    return {
      ...base,
      status: "existing",
      resetEventKey: existingEventKey,
      canCreateNewSideEffects: false,
      canRunFormalEnrichments: canRunFormalEnrichments(logicalPost),
      matchedEvidence: match
        ? { kind: match.kind, resetEventKey: match.resetEventKey }
        : null,
    };
  }

  if (!logicalPost.latestVersionPresent) {
    return {
      ...base,
      status: "blocked",
      resetEventKey: null,
      canCreateNewSideEffects: false,
      canRunFormalEnrichments: false,
      matchedEvidence: null,
      reason: "missing_authoritative_tail",
    };
  }

  if (logicalPost.manualState.kind === "conflict") {
    return {
      ...base,
      status: "blocked",
      resetEventKey: null,
      canCreateNewSideEffects: false,
      canRunFormalEnrichments: false,
      matchedEvidence: null,
      reason: "manual_conflict",
    };
  }

  if (logicalPost.effectiveClassification.status !== "resolved") {
    return {
      ...base,
      status: "blocked",
      resetEventKey: null,
      canCreateNewSideEffects: false,
      canRunFormalEnrichments: false,
      matchedEvidence: null,
      reason: "unresolved_classification",
    };
  }

  return {
    ...base,
    status: "new",
    resetEventKey: `tibo-reset-${logicalPost.logicalPostId}`,
    canCreateNewSideEffects: true,
    canRunFormalEnrichments: canRunFormalEnrichments(logicalPost),
    matchedEvidence: null,
  };
}
