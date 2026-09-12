export type ResetDisplayNameCandidateLifecycle =
  | "provisional"
  | "promoted"
  | "superseded"
  | "expired";

export type ResetDisplayNameCandidateAiStatus =
  | "unprocessed"
  | "pending"
  | "accepted"
  | "null"
  | "review_required"
  | "api_error"
  | "rate_limited"
  | "invalid_response";

export type ResetDisplayNameCandidateActivationMode = "off" | "seed" | "full";

export type ResetDisplayNameCandidateActivation = {
  mode: ResetDisplayNameCandidateActivationMode;
  adoptionAt: string | null;
};

export type ResetDisplayNameNoticeEligibilityInput = {
  signalType: "official_notice" | "reset_executed" | "teaser" | "irrelevant";
  verificationStatus: string | null;
  isReply: boolean;
  isHistoricalOnly: boolean;
  isPresentationOnlyOngoingBanked: boolean;
  hasFutureBankedDistributionIntent: boolean;
};

export type ResetDisplayNameCandidateIdentityInput = {
  officialNoticeTweetId: string;
  logicalPostId: string | null;
};

export type ResetDisplayNameCandidateSeed = {
  officialNoticeTweetId: string;
  logicalPostId: string | null;
  noticeTweetIds: string[];
  sourceTweetIds: string[];
};

export type ResetDisplayNameCandidateRecord = {
  candidateId: string;
  noticeDedupeKey: string;
  officialNoticeTweetId: string;
  logicalPostId: string | null;
  noticeTweetIds: string[];
  sourceTweetIds: string[];
  sourceSnapshotHash: string | null;
  inputHash: string | null;
  aiNameJa: string | null;
  aiNameEn: string | null;
  aiNameZh: string | null;
  aiConfidence: number | null;
  aiEvidence: string | null;
  aiReason: string | null;
  aiFlags: string[];
  aiModel: string | null;
  aiPromptVersion: string | null;
  aiInputMode: string | null;
  aiStatus: ResetDisplayNameCandidateAiStatus;
  lifecycleStatus: ResetDisplayNameCandidateLifecycle;
  generationAttempts: number;
  lastGeneratedAt: string | null;
  promotedEventKey: string | null;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
};

export function isExecutionBearingResetDisplayNameNotice(
  input: ResetDisplayNameNoticeEligibilityInput,
): boolean {
  return input.signalType === "official_notice" &&
    input.verificationStatus !== "rejected" &&
    !input.isReply &&
    !input.isHistoricalOnly &&
    (!input.isPresentationOnlyOngoingBanked || input.hasFutureBankedDistributionIntent);
}

export function getResetDisplayNameCandidateDedupeKey(
  input: ResetDisplayNameCandidateIdentityInput,
): string | null {
  const officialNoticeTweetId = input.officialNoticeTweetId.trim();
  if (!officialNoticeTweetId) return null;

  const logicalPostId = input.logicalPostId?.trim();
  return logicalPostId
    ? `logical-post:${logicalPostId}`
    : `official-notice:${officialNoticeTweetId}`;
}

export function canTransitionResetDisplayNameCandidateLifecycle(
  from: ResetDisplayNameCandidateLifecycle,
  to: ResetDisplayNameCandidateLifecycle,
): boolean {
  return from === "provisional" &&
    (to === "provisional" || to === "promoted" || to === "superseded" || to === "expired");
}

export type ResetDisplayNameCandidatePromotionResolution = {
  status: "new" | "existing" | "conflict" | "blocked";
  resetEventKey: string | null;
  matchedEvidenceEventKey: string | null;
};

export type ResetDisplayNameCandidateExecutionEvidence = {
  resetEventKey: string;
  kind: "formal_adoption" | "monitor_usage_estimate";
};

export function isCandidatePromotionAuthorized(
  resolution: ResetDisplayNameCandidatePromotionResolution,
  evidence: readonly ResetDisplayNameCandidateExecutionEvidence[],
): boolean {
  if (resolution.status !== "existing" || !resolution.resetEventKey ||
      resolution.matchedEvidenceEventKey !== resolution.resetEventKey) {
    return false;
  }

  return evidence.some((entry) =>
    entry.resetEventKey === resolution.resetEventKey &&
    (entry.kind === "formal_adoption" || entry.kind === "monitor_usage_estimate"),
  );
}
