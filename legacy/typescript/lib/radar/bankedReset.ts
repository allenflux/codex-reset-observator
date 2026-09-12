import { hasHistoricalResetScopeCorrection } from "./historicalResetCorrections";

export const BANKED_NOTICE_MATCH_WINDOW_MS = 90 * 60 * 1000;
export const BANKED_DISTRIBUTION_ESTIMATOR_VERSION = "banked-distribution-observation-v2";
export const LEGACY_BANKED_DISTRIBUTION_ESTIMATOR_VERSION = "usage-execution-banked-v1";

export {
  ASTRA_BANKED_HISTORY_EVENT_KEY,
  ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY,
  ASTRA_BANKED_HISTORY_SOURCE_TWEET_ID,
} from "./historicalResetCorrections";
export const BANKED_DISTRIBUTION_ESTIMATOR_VERSIONS = [
  BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
  LEGACY_BANKED_DISTRIBUTION_ESTIMATOR_VERSION,
] as const;

export function isManualBroadBankedScopeCorrection(eventKey: string | null | undefined) {
  return hasHistoricalResetScopeCorrection(eventKey);
}

const bankedDistributionEstimatorVersions = new Set<string>(BANKED_DISTRIBUTION_ESTIMATOR_VERSIONS);

export function isBankedDistributionEstimatorVersion(value: string | null | undefined) {
  return typeof value === "string" && bankedDistributionEstimatorVersions.has(value);
}

export type BankedDistributionEventKeyInput = {
  noticeTweetId: string;
  observedAt: string;
  persistent: boolean;
  previousGrantAt?: string | null;
  previousEventKey?: string | null;
};

function getStableObservationToken(observedAt: string) {
  const timestamp = Date.parse(observedAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().replace(/[-:.]/g, "")
    : null;
}

/** Keeps retries idempotent while giving each later persistent observation its own event. */
export function getBankedDistributionEventKey(input: BankedDistributionEventKeyInput) {
  const baseKey = `banked-reset-${input.noticeTweetId}`;
  if (!input.persistent) return baseKey;

  const observedTime = Date.parse(input.observedAt);
  const previousTime = Date.parse(input.previousGrantAt ?? "");
  if (
    input.previousEventKey &&
    Number.isFinite(observedTime) &&
    Number.isFinite(previousTime) &&
    observedTime === previousTime
  ) {
    return input.previousEventKey;
  }

  const hasPreviousGrant = typeof input.previousGrantAt === "string" && input.previousGrantAt.trim().length > 0;
  const observationToken = getStableObservationToken(input.observedAt);
  if (!hasPreviousGrant || !observationToken) return baseKey;
  return `${baseKey}-observation-${observationToken}`;
}

export type BankedNoticeTiming = {
  observedAt: string;
  expectedAt?: string | null;
  expectedEndAt?: string | null;
};

const BANKED_RESET_TERM_PATTERN = /\bbanked\s+resets?\b|\breset\s+credits?\b|任意リセット権|リセット権/i;
const DISTRIBUTION_TERM_PATTERN = /\b(?:credit|grant|giv|gift|distribut|provide|deliver|issue|send)\w*\b|配布|付与|配る|プレゼント/i;
const COMPENSATION_DISTRIBUTION_PATTERN =
  /\b(?:get|gets|getting|receive|receives|receiving|be\s+(?:given|sent|issued|delivered))\b[\s\S]{0,60}\b(?:another\s+(?:one|banked\s+resets?|reset(?:\s+credits?)?|credits?)|(?:an?\s+)?(?:additional|replacement)\s+(?:banked\s+)?(?:resets?|credits?))\b/i;
const NOTICE_CLAUSE_SEPARATOR = /[.!?。！？]+|\bPS\s*:\s*/i;

function hasResetCreditTerm(text: string) {
  return BANKED_RESET_TERM_PATTERN.test(text);
}

function hasDistributionTerm(text: string) {
  return text.split(NOTICE_CLAUSE_SEPARATOR).some((clause) => {
    const resetIndex = clause.search(BANKED_RESET_TERM_PATTERN);
    const distributionMatch = clause.match(DISTRIBUTION_TERM_PATTERN);
    if (resetIndex < 0 || !distributionMatch || distributionMatch.index === undefined) return false;

    const isNounIssue = /^issues?$/i.test(distributionMatch[0]) &&
      /\b(?:an?|the)\s+issues?\b/i.test(clause);
    return !isNounIssue && Math.abs(resetIndex - distributionMatch.index) <= 120;
  });
}

function hasAdjacentConditionalCompensationDistribution(text: string) {
  const clauses = text.split(NOTICE_CLAUSE_SEPARATOR);
  return clauses.some((_, index) => {
    const windowStart = Math.max(0, index - 1);
    const windowEnd = Math.min(clauses.length, index + 2);
    const adjacentText = clauses.slice(windowStart, windowEnd).join(" ");
    return hasResetCreditTerm(adjacentText) &&
      hasBroadScopeTerm(adjacentText) &&
      hasLocallyAttachedConditionalAudience(adjacentText) &&
      COMPENSATION_DISTRIBUTION_PATTERN.test(adjacentText);
  });
}

const FUTURE_BANKED_ACTION_PATTERN =
  /\b(?:will|shall|(?:am|is|are)\s+going\s+to|gonna)\s+(?:do|run|perform|execute|issue|grant|give|distribut|provide|deliver|send)\w*\b[\s\S]{0,100}\b(?:banked\s+resets?|reset\s+credits?)\b/i;
const FUTURE_BANKED_AVAILABILITY_PATTERN =
  /\b(?:banked\s+resets?|reset\s+credits?)\b[\s\S]{0,80}\b(?:will|shall|(?:is|are)\s+going\s+to|gonna)\s+(?:land|arrive|be\s+(?:there|available|ready)|be\s+(?:issued|delivered|distributed|granted|provided))\b/i;

function hasFutureAvailabilityTerm(text: string) {
  return text.split(NOTICE_CLAUSE_SEPARATOR).some((clause) => FUTURE_BANKED_AVAILABILITY_PATTERN.test(clause));
}

function hasFutureBankedExecutionCue(text: string) {
  return text.split(NOTICE_CLAUSE_SEPARATOR).some((clause) => FUTURE_BANKED_ACTION_PATTERN.test(clause)) ||
    hasFutureAvailabilityTerm(text);
}

/** Detects an explicit future BANKED delivery/execution clause. */
export function hasFutureBankedDistributionIntent(text: string | null | undefined) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  return normalized.length > 0 && normalized.split(NOTICE_CLAUSE_SEPARATOR).some((clause) =>
    hasResetCreditTerm(clause) && hasFutureBankedExecutionCue(clause)
  );
}

const BANKED_COMPLETION_PATTERN = /\b(?:banked\s+(?:resets?|credits?)|reset\s+credits?)\b[\s\S]{0,100}\b(?:(?:has|have)\s+(?:been\s+)?(?:landed|arrived|distributed|credited|granted|issued|delivered|added)|(?:was|were)\s+(?:distributed|credited|granted|issued|delivered|added)|(?:is|are)\s+(?:now\s+)?available)\b/i;
const GENERALIZED_PAID_CHATGPT_PLAN_SCOPE_PATTERN =
  /\bfor\s+(?:each|every)\s+day\s+you\s+(?:do\s+not|don't)\s+have\s+access\s+to\b[\s\S]{0,120}\bon\s+your\s+paid\s+chatgpt\s+plan\b/i;
const PERSONAL_DIRECT_ADDRESS_PATTERN =
  /\bI\s+(?:(?:can|could|will|would)\s+)?(?:(?:have|just)\s+)?(?:give|gave|given|provide|provided|am\s+giving)\s+you\b/i;
const PERSONAL_BANKED_OPERATION_PATTERN =
  /\b(?:i|you)\b[\s\S]{0,80}\b(?:use|used|using|spend|spent|consume|consumed|apply|applied|do|did|run|ran|perform|performed|execute|executed|give|gave|given|giving|provide|provided|grant|granted|issue|issued|deliver|delivered|distribute|distributed)\b[\s\S]{0,80}\b(?:banked\s+resets?|reset\s+credits?)\b|\b(?:here(?:'s|\s+is)\s+how\s+to|how\s+to)\s+(?:use|do|run|perform|execute|spend|consume|apply)\b[\s\S]{0,80}\b(?:banked\s+resets?|reset\s+credits?)\b|\b(?:my|your|one\s+of\s+(?:my|your))\s+(?:banked\s+resets?|reset\s+credits?)\b[\s\S]{0,80}\b(?:use|used|using|spend|spent|consume|consumed|apply|applied)\b/i;
const CHATGPT_PLAN_SCOPE_PATTERN = "(?:plus|pro|business|enterprise)";
const BROAD_PLAN_SCOPE_PATTERN = new RegExp(
  `\\b(?:all|every)\\s+${CHATGPT_PLAN_SCOPE_PATTERN}(?:(?:\\s*,\\s*|\\s*(?:,\\s*)?and\\s+)${CHATGPT_PLAN_SCOPE_PATTERN}){0,3}\\s+users?\\b`,
  "i",
);
const BROAD_SCOPE_PATTERNS = [
  /\b(?:everyone|global)\b/i,
  /\b(?:all|every)\s+(?:codex\s+and\s+)?chatgpt\s+work\s+users?\b/i,
  /\b(?:all|every)\s+paid\s+users?\s+of\s+(?:chatgpt\s+work\s+and\s+codex|codex\s+and\s+chatgpt\s+work)\b/i,
  /\b(?:all|every)\s+paid\s+users?\b/i,
  BROAD_PLAN_SCOPE_PATTERN,
  /\b(?:all|every)\s+(?:users?|accounts?)\b/i,
  /全(?:ての|て|有料)?(?:ユーザー|利用者|アカウント|プラン)/i,
] as const;
const CONDITIONAL_AUDIENCE_CUE_PATTERN =
  /\b(?:who|that|whom|whose|without|if|unless|only|excluding|except|don't|do\s+not|doesn't|does\s+not|not\s+yet|with\s+(?:no|out|limited|restricted|ineligible|eligible))\b/i;

function hasGeneralizedPaidChatGptPlanScopeTerm(text: string) {
  return GENERALIZED_PAID_CHATGPT_PLAN_SCOPE_PATTERN.test(text) &&
    !PERSONAL_DIRECT_ADDRESS_PATTERN.test(text);
}

function getBroadScopeMatch(text: string) {
  return BROAD_SCOPE_PATTERNS.reduce<RegExpExecArray | null>((best, pattern) => {
    const match = pattern.exec(text);
    return match && (!best || match.index < best.index) ? match : best;
  }, null);
}

function hasBroadScopeTerm(text: string) {
  return getBroadScopeMatch(text) !== null || hasGeneralizedPaidChatGptPlanScopeTerm(text);
}

function hasBroadBankedDistributionClause(text: string) {
  return hasBroadScopeTerm(text) &&
    (hasDistributionTerm(text) || hasFutureBankedExecutionCue(text));
}

function hasPersonalBankedOperation(text: string) {
  return PERSONAL_BANKED_OPERATION_PATTERN.test(text);
}

function hasLocallyAttachedConditionalAudience(text: string) {
  return text.split(NOTICE_CLAUSE_SEPARATOR).some((clause) => {
    const scopeMatch = getBroadScopeMatch(clause);
    if (!scopeMatch) return false;

    const scopeStart = scopeMatch.index;
    const scopeEnd = scopeStart + scopeMatch[0].length;
    const beforeScope = clause.slice(Math.max(0, scopeStart - 100), scopeStart);
    const afterScope = clause.slice(scopeEnd, Math.min(clause.length, scopeEnd + 100));
    return CONDITIONAL_AUDIENCE_CUE_PATTERN.test(beforeScope) || CONDITIONAL_AUDIENCE_CUE_PATTERN.test(afterScope);
  });
}

/** Detects a distribution statement, not generic reset-button language. */
export function isBankedDistributionNotice(text: string | null | undefined) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  return normalized.length > 0 && (
    normalized.split(NOTICE_CLAUSE_SEPARATOR).some((clause) =>
      hasResetCreditTerm(clause) &&
      (!hasPersonalBankedOperation(clause) || hasBroadBankedDistributionClause(clause)) &&
      (hasDistributionTerm(clause) || hasFutureBankedExecutionCue(clause))
    ) || hasAdjacentConditionalCompensationDistribution(normalized)
  );
}

/** Canonical history requires the post to explicitly cover a broad audience. */
export function isBroadBankedDistributionNotice(text: string | null | undefined) {
  return isBankedDistributionNotice(text) && hasBroadScopeTerm(text ?? "");
}

/**
 * Identifies broad-audience BANKED delivery that is still conditional on
 * user eligibility. This is separate from the history broad-scope gate:
 * the event can remain canonical history while staying out of the random
 * reset probability target.
 */
export function isConditionalBankedDistributionNotice(text: string | null | undefined) {
  if (typeof text !== "string" || !isBankedDistributionNotice(text)) return false;
  const normalized = text.trim();
  return hasGeneralizedPaidChatGptPlanScopeTerm(normalized) ||
    hasLocallyAttachedConditionalAudience(normalized);
}

const RECURRING_BANKED_POLICY_PATTERN = /\b(?:for\s+)?(?:every|each)\s+(?:day|week|month)\b|\b(?:daily|weekly|monthly)\b/i;

/** Requires explicit recurrence evidence in addition to conditional eligibility. */
export function isRecurringConditionalBankedDistributionNotice(text: string | null | undefined) {
  return isConditionalBankedDistributionNotice(text) &&
    RECURRING_BANKED_POLICY_PATTERN.test(text ?? "");
}

/**
 * A completed BANKED delivery is not evidence that the global usage limits
 * were reset. Keep it out of the generic Tibo reset adoption path; a real
 * BANKED history row still requires the Usage Monitor credit transition.
 */
export function isBankedDistributionCompletionSignal(text: string | null | undefined) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  return normalized.length > 0 && normalized.split(NOTICE_CLAUSE_SEPARATOR).some((clause) =>
    BANKED_COMPLETION_PATTERN.test(clause) &&
    !hasFutureBankedExecutionCue(clause)
  );
}

export type BankedNoticeSupersessionInput = {
  text?: string | null;
  tweet_created_at?: string | null;
  expected_start_at?: string | null;
  expected_end_at?: string | null;
  temporal_resolution_status?: string | null;
};

function isConcreteResolvedBankedNotice(notice: BankedNoticeSupersessionInput) {
  const start = notice.expected_start_at ? Date.parse(notice.expected_start_at) : Number.NaN;
  const end = notice.expected_end_at ? Date.parse(notice.expected_end_at) : Number.NaN;
  return (
    isBroadBankedDistributionNotice(notice.text) &&
    notice.temporal_resolution_status === "resolved" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  );
}

/** Older broad BANKED notices are superseded once a newer concrete window exists. */
export function isSupersededBankedNotice<T extends BankedNoticeSupersessionInput>(
  notice: T,
  notices: readonly T[],
) {
  if (!isBroadBankedDistributionNotice(notice.text)) return false;
  const noticeTime = notice.tweet_created_at ? Date.parse(notice.tweet_created_at) : Number.NaN;
  if (!Number.isFinite(noticeTime)) return false;
  return notices.some((candidate) => {
    const candidateTime = candidate.tweet_created_at ? Date.parse(candidate.tweet_created_at) : Number.NaN;
    return candidate !== notice &&
      Number.isFinite(candidateTime) &&
      candidateTime > noticeTime &&
      isConcreteResolvedBankedNotice(candidate);
  });
}

function parseFiniteTime(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Match a local observation to the notice window without treating it as proof by itself. */
export function isBankedObservationWithinNoticeWindow(
  notice: BankedNoticeTiming,
  observedAt: string,
  matchWindowMs = BANKED_NOTICE_MATCH_WINDOW_MS,
) {
  const observedTime = parseFiniteTime(observedAt);
  const announcedTime = parseFiniteTime(notice.observedAt);
  if (observedTime === null || announcedTime === null || matchWindowMs < 0) return false;

  const expectedStart = parseFiniteTime(notice.expectedAt);
  const expectedEnd = parseFiniteTime(notice.expectedEndAt);
  if (expectedStart !== null && expectedEnd !== null && expectedEnd >= expectedStart) {
    return observedTime >= expectedStart - matchWindowMs && observedTime <= expectedEnd + matchWindowMs;
  }
  if (expectedStart !== null) {
    return Math.abs(observedTime - expectedStart) <= matchWindowMs;
  }
  return Math.abs(observedTime - announcedTime) <= matchWindowMs;
}
