import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { getCanonicalResetHistoryForDisplayNameReconciliation } from "../radar";
import { fetchCurrentRadarData } from "../radarFetch";
import { fetchResetDisplayNameCandidateNoticeSignals } from "../radarFetch";
import {
  getCanonicalResetDisplayNameEventKey,
  isAutoNameableCanonicalEvent,
} from "./resetDisplayNameEligibility";
import { getCompletedResetTimestamp } from "./probability";
import {
  buildResetDisplayNameSourceContext,
  type ResetDisplayNameSourceRow,
} from "./resetDisplayNameSourceContext";
import {
  buildTiboReadSideProjection,
} from "./tiboLogicalProjection";
import {
  resolveTiboResetEventIdentity,
  type TiboResetEventReference,
} from "./tiboResetEventIdentity";
import {
  ensureResetDisplayNameForEvent,
  hashResetDisplayNameInput,
  isSafeAcceptedPrecomputedResetDisplayName,
  shouldPreserveExistingAcceptedResetDisplayName,
  shouldReuseResetDisplayNameResult,
  type ResetDisplayNameGenerationOutcome,
} from "./resetDisplayNameStore";
import {
  RANDOM_RESET_NAME_MODEL,
  toRandomResetNameInput,
  assessRandomResetNameResult,
  type RandomResetNameGenerationResult,
} from "./randomResetNaming";
import {
  generateResetDisplayNameCandidate,
  type ResetDisplayNameCandidateNamingInput,
} from "./resetDisplayNameCandidateNaming";
import {
  claimResetDisplayNameCandidateGeneration,
  listResetDisplayNameCandidates,
  promoteResetDisplayNameCandidate,
  upsertResetDisplayNameCandidateSeed,
  writeResetDisplayNameCandidateGeneration,
  type ResetDisplayNameCandidateStoreClient,
} from "./resetDisplayNameCandidateStore";
import {
  isResetDisplayNameCandidateNoticeAfterAdoption,
} from "./resetDisplayNameCandidateActivation";
import {
  type ResetDisplayNameCandidateActivation,
  type ResetDisplayNameCandidateExecutionEvidence,
  type ResetDisplayNameCandidatePromotionResolution,
  type ResetDisplayNameCandidateRecord,
  type ResetDisplayNameCandidateSeed,
} from "./resetDisplayNameCandidateTypes";
import type { TiboFormalAdoptionRecord } from "./tiboFormalAdoptionStore";
import {
  isPublicRandomResetExecutionEstimate,
  type ResetExecutionEstimate,
} from "./resetExecution";
import type { RadarData, ResetDisplayNameRecord, WindowEventLike } from "./types";

export { isAutoNameableCanonicalEvent } from "./resetDisplayNameEligibility";

const DEFAULT_MAX_GEMINI_REQUESTS = 3;
const RESET_DISPLAY_NAME_CANDIDATE_STALE_PENDING_MS = 15 * 60 * 1000;

export type ResetDisplayNameCandidateNotice = {
  officialNoticeTweetId: string;
  logicalPostId: string | null;
  noticeTweetIds: string[];
  sourceTweetIds: string[];
  tweetCreatedAt: string;
  noticeObservedAt: string;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  temporalPrecision: string | null;
  scope: string | null;
  noticeType: string | null;
  sourceUrl: string | null;
  sourceContext: string | null;
  isExecutionBearing: boolean;
};

export type ResetDisplayNameReconciliationOutcome = {
  eventKey: string | null;
  sourceTweetId: string | null;
  sourceReady: boolean;
  attempted: boolean;
  status: string;
  displayName: string | null;
};

export type ResetDisplayNameReconciliationResult = {
  scanned: number;
  candidates: number;
  attempted: number;
  geminiRequests: number;
  writes: number;
  invalidated: boolean;
  outcomes: ResetDisplayNameReconciliationOutcome[];
  candidateSeeds?: number;
  candidateGeminiRequests?: number;
  candidatePromotions?: number;
};

export type ResetDisplayNameReconciliationOptions = {
  data?: RadarData;
  canonicalHistory?: ReadonlyArray<WindowEventLike>;
  sourceRows?: ReadonlyArray<ResetDisplayNameSourceRow>;
  now?: Date;
  adoptionAt?: Date;
  apiKey?: string | null;
  model?: string;
  timeoutMs?: number;
  maxGeminiRequests?: number;
  dryRun?: boolean;
  fetchData?: (now: Date) => Promise<RadarData>;
  ensure?: typeof ensureResetDisplayNameForEvent;
  invalidateRadarData?: () => void | Promise<void>;
  candidateActivation?: ResetDisplayNameCandidateActivation;
  candidateNotices?: ReadonlyArray<ResetDisplayNameCandidateNotice>;
  candidateStore?: ResetDisplayNameCandidateStoreClient;
  candidateGenerate?: typeof generateResetDisplayNameCandidate;
};

export const RESET_DISPLAY_NAME_TRANSIENT_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

type ReconciliationCandidate = {
  item: WindowEventLike;
  eventKey: string;
  completedAt: number;
  sourceTweetId: string | null;
  sourcePostText: string | null;
  inputHash: string;
  existing: ResetDisplayNameRecord | null;
};

function getText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function toSourceRow(value: unknown): ResetDisplayNameSourceRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const tweetId = getText(row.tweet_id)?.trim();
  const text = getText(row.text)?.trim();
  if (!tweetId || !text) return null;

  return {
    tweet_id: tweetId,
    text,
    tweet_created_at: getText(row.tweet_created_at),
    is_reply: row.is_reply === true,
    verification_status: getText(row.verification_status),
  };
}

function sourceRowScore(row: ResetDisplayNameSourceRow) {
  const timestamp = row.tweet_created_at ? Date.parse(row.tweet_created_at) : Number.NaN;
  return [
    row.is_reply === true ? 0 : 1,
    row.verification_status === "rejected" ? 0 : 1,
    row.text.trim() ? 1 : 0,
    Number.isFinite(timestamp) ? 1 : 0,
    row.text.length,
  ];
}

function isBetterSourceRow(candidate: ResetDisplayNameSourceRow, current: ResetDisplayNameSourceRow) {
  const candidateScore = sourceRowScore(candidate);
  const currentScore = sourceRowScore(current);
  for (let index = 0; index < candidateScore.length; index += 1) {
    if (candidateScore[index] !== currentScore[index]) {
      return candidateScore[index] > currentScore[index];
    }
  }
  return candidate.text.localeCompare(current.text) < 0;
}

function normalizeSourceRows(rows: readonly ResetDisplayNameSourceRow[]) {
  const rowsByTweetId = new Map<string, ResetDisplayNameSourceRow>();
  for (const row of rows) {
    const tweetId = row.tweet_id.trim();
    if (!tweetId) continue;
    const normalized = { ...row, tweet_id: tweetId };
    const current = rowsByTweetId.get(tweetId);
    if (!current || isBetterSourceRow(normalized, current)) {
      rowsByTweetId.set(tweetId, normalized);
    }
  }
  return Array.from(rowsByTweetId.values()).sort((left, right) =>
    left.tweet_id.localeCompare(right.tweet_id),
  );
}

function collectSourceRows(data: RadarData): ResetDisplayNameSourceRow[] {
  const values: unknown[] = [
    ...(data.formal_tibo_resets ?? []),
    ...(data.active_tibo_signals ?? []),
    ...(data.recent_tibo_signals ?? []),
  ];
  const rowsByTweetId = new Map<string, ResetDisplayNameSourceRow>();

  const add = (value: unknown) => {
    const row = toSourceRow(value);
    if (row) {
      const current = rowsByTweetId.get(row.tweet_id);
      if (!current || isBetterSourceRow(row, current)) {
        rowsByTweetId.set(row.tweet_id, row);
      }
    }

    if (!value || typeof value !== "object") return;
    const related = value as {
      related_notice?: unknown;
      related_notices?: unknown[];
    };
    if (related.related_notice) add(related.related_notice);
    for (const notice of related.related_notices ?? []) add(notice);
  };

  for (const value of values) add(value);
  return normalizeSourceRows(Array.from(rowsByTweetId.values()));
}

function uniqueExact(values: readonly string[]) {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function candidateIdentityIds(candidate: ResetDisplayNameCandidateRecord) {
  return uniqueExact([
    candidate.officialNoticeTweetId,
    ...candidate.noticeTweetIds,
    ...candidate.sourceTweetIds,
  ]);
}

function noticeIdentityIds(notice: ResetDisplayNameCandidateNotice) {
  return uniqueExact([
    notice.officialNoticeTweetId,
    ...notice.noticeTweetIds,
    ...notice.sourceTweetIds,
  ]);
}

function candidateMatchesNotice(
  candidate: ResetDisplayNameCandidateRecord,
  notice: ResetDisplayNameCandidateNotice,
) {
  const candidateIds = new Set(candidateIdentityIds(candidate));
  if (noticeIdentityIds(notice).some((id) => candidateIds.has(id))) return true;
  return notice.logicalPostId !== null && candidate.logicalPostId === notice.logicalPostId;
}

function candidateSeedNeedsRefresh(
  candidate: ResetDisplayNameCandidateRecord,
  notice: ResetDisplayNameCandidateNotice,
) {
  const candidateNoticeIds = new Set(candidate.noticeTweetIds);
  const candidateSourceIds = new Set(candidate.sourceTweetIds);
  return (notice.logicalPostId !== null && candidate.logicalPostId === null) ||
    notice.noticeTweetIds.some((id) => !candidateNoticeIds.has(id)) ||
    notice.sourceTweetIds.some((id) => !candidateSourceIds.has(id));
}

function candidateSeedFromNotice(notice: ResetDisplayNameCandidateNotice): ResetDisplayNameCandidateSeed {
  return {
    officialNoticeTweetId: notice.officialNoticeTweetId,
    logicalPostId: notice.logicalPostId,
    noticeTweetIds: [...notice.noticeTweetIds],
    sourceTweetIds: [...notice.sourceTweetIds],
  };
}

export function discoverMissingResetDisplayNameCandidateSeeds(
  notices: readonly ResetDisplayNameCandidateNotice[],
  existing: readonly ResetDisplayNameCandidateRecord[],
  activation: ResetDisplayNameCandidateActivation,
) {
  if (activation.mode === "off" || !activation.adoptionAt) return [];

  return notices
    .filter((notice) => notice.isExecutionBearing)
    .filter((notice) => isResetDisplayNameCandidateNoticeAfterAdoption(
      notice.tweetCreatedAt,
      activation.adoptionAt!,
    ))
    .filter((notice) => {
      const match = existing.find((candidate) => candidateMatchesNotice(candidate, notice));
      return !match || candidateSeedNeedsRefresh(match, notice);
    })
    .map(candidateSeedFromNotice);
}

export function collectPersistedAuthoritativeCandidateExecutionEvidence(
  adoptionLedgers: readonly TiboFormalAdoptionRecord[],
  estimates: readonly ResetExecutionEstimate[],
): ResetDisplayNameCandidateExecutionEvidence[] {
  const formalEvidence = adoptionLedgers.map((ledger) => ({
    resetEventKey: ledger.resetEventKey,
    kind: "formal_adoption" as const,
  }));
  const monitorEvidence = estimates
    .filter((estimate) => isPublicRandomResetExecutionEstimate(estimate))
    .map((estimate) => ({
      resetEventKey: estimate.resetEventKey,
      kind: "monitor_usage_estimate" as const,
    }));
  const seen = new Set<string>();
  return [...formalEvidence, ...monitorEvidence].filter((evidence) => {
    const key = `${evidence.kind}:${evidence.resetEventKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasExactIdentityOverlap(left: readonly string[], right: readonly string[]) {
  const rightIds = new Set(right);
  return left.some((id) => rightIds.has(id));
}

function hasPersistedAuthoritativeExecutionForCandidate(
  candidate: ResetDisplayNameCandidateRecord,
  adoptionLedgers: readonly TiboFormalAdoptionRecord[],
  estimates: readonly ResetExecutionEstimate[],
) {
  const candidateIds = candidateIdentityIds(candidate);
  const hasFormalAdoption = adoptionLedgers.some((ledger) =>
    (candidate.logicalPostId !== null && ledger.logicalPostId === candidate.logicalPostId) ||
    hasExactIdentityOverlap(candidateIds, [
      ...ledger.logicalPostTweetIds,
      ...ledger.sourceTweetIds,
    ]),
  );
  if (hasFormalAdoption) return true;

  const candidateNoticeIds = new Set(candidate.noticeTweetIds.map((id) => id.trim()));
  const candidateSourceIds = new Set(candidateIds.map((id) => id.trim()));
  return estimates
    .filter((estimate) => isPublicRandomResetExecutionEstimate(estimate))
    .some((estimate) => {
      const officialNoticeTweetId = estimate.officialNoticeTweetId?.trim();
      if (officialNoticeTweetId) return candidateNoticeIds.has(officialNoticeTweetId);
      return estimate.tiboSourceTweetIds.some((tweetId) => candidateSourceIds.has(tweetId.trim()));
    });
}

function getCandidateStoreClient() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  }) as unknown as ResetDisplayNameCandidateStoreClient;
}

function hashCandidateValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function candidateNoticeForRecord(
  candidate: ResetDisplayNameCandidateRecord,
  notices: readonly ResetDisplayNameCandidateNotice[],
) {
  return notices.find((notice) => candidateMatchesNotice(candidate, notice)) ?? null;
}

function candidateSourcePostText(
  candidate: ResetDisplayNameCandidateRecord,
  notice: ResetDisplayNameCandidateNotice,
  notices: readonly ResetDisplayNameCandidateNotice[],
) {
  const sourceIds = new Set(candidate.sourceTweetIds);
  const contexts = notices
    .filter((source) => noticeIdentityIds(source).some((id) => sourceIds.has(id)))
    .map((source) => source.sourceContext?.trim() ?? "")
    .filter(Boolean);
  if (contexts.length === 0 && notice.sourceContext?.trim()) contexts.push(notice.sourceContext.trim());
  return uniqueExact(contexts).join("\n\n") || null;
}

function buildCandidateNamingInput(
  candidate: ResetDisplayNameCandidateRecord,
  notice: ResetDisplayNameCandidateNotice,
  sourcePostText: string,
): ResetDisplayNameCandidateNamingInput {
  return {
    officialNoticeTweetId: candidate.officialNoticeTweetId,
    logicalPostId: candidate.logicalPostId ?? notice.logicalPostId,
    noticeObservedAt: notice.noticeObservedAt,
    expectedStartAt: notice.expectedStartAt,
    expectedEndAt: notice.expectedEndAt,
    temporalPrecision: notice.temporalPrecision,
    scope: notice.scope,
    noticeType: notice.noticeType,
    sourceUrl: notice.sourceUrl,
    sourcePostText,
    sourceContext: notice.sourceContext,
  };
}

function toResetEventReference(item: WindowEventLike): TiboResetEventReference | null {
  const eventKey = typeof item.id === "string" ? item.id.trim() : "";
  if (!eventKey) return null;
  return {
    eventKey,
    sourceTweetIds: item.sourceTweetIds ?? [],
    sourceUrl: item.source_url ?? null,
  };
}

function findCandidateLogicalPost(
  candidate: ResetDisplayNameCandidateRecord,
  data: RadarData,
) {
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: data.active_tibo_signals,
    recent_tibo_signals: data.recent_tibo_signals,
    formal_tibo_resets: data.formal_tibo_resets,
  });
  const candidateIds = new Set(candidateIdentityIds(candidate));
  return projection.logicalPosts.find((post) =>
    (candidate.logicalPostId !== null && post.logicalPostId === candidate.logicalPostId) ||
    post.sourceTweetIds.some((tweetId) => candidateIds.has(tweetId)),
  ) ?? null;
}

function getCandidatePromotionContext(
  candidate: ResetDisplayNameCandidateRecord,
  data: RadarData,
  history: readonly WindowEventLike[],
): {
  identityResolution: ResetDisplayNameCandidatePromotionResolution;
  authoritativeEvidence: readonly ResetDisplayNameCandidateExecutionEvidence[];
  canonicalSourceTweetId: string | null;
} | null {
  const logicalPost = findCandidateLogicalPost(candidate, data);
  if (!logicalPost) return null;

  const resolution = resolveTiboResetEventIdentity(logicalPost, {
    adoptionLedgers: data.tibo_formal_adoptions ?? [],
    estimates: data.reset_execution_estimates ?? [],
    staticHistory: history
      .map(toResetEventReference)
      .filter((reference): reference is TiboResetEventReference => Boolean(reference)),
    sourceTweetIds: candidateIdentityIds(candidate),
  });
  return {
    identityResolution: {
      status: resolution.status,
      resetEventKey: resolution.resetEventKey,
      matchedEvidenceEventKey: resolution.matchedEvidence?.resetEventKey ?? null,
    },
    authoritativeEvidence: collectPersistedAuthoritativeCandidateExecutionEvidence(
      data.tibo_formal_adoptions ?? [],
      data.reset_execution_estimates ?? [],
    ),
    canonicalSourceTweetId: resolution.sourceTweetIds[0] ?? candidate.officialNoticeTweetId,
  };
}

function getCanonicalSourceTweetIds(item: WindowEventLike) {
  return Array.from(new Set([
    ...(item.sourceTweetIds ?? []),
    item.officialNoticeTweetId,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())));
}

function compareSourceRows(left: ResetDisplayNameSourceRow, right: ResetDisplayNameSourceRow) {
  const leftTime = left.tweet_created_at ? Date.parse(left.tweet_created_at) : Number.NaN;
  const rightTime = right.tweet_created_at ? Date.parse(right.tweet_created_at) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return -1;
  if (!Number.isFinite(leftTime) && Number.isFinite(rightTime)) return 1;
  return left.tweet_id.localeCompare(right.tweet_id);
}

function resolveCandidateSource(
  sourceTweetIds: readonly string[],
  sourceRows: readonly ResetDisplayNameSourceRow[],
) {
  const canonicalIds = new Set(sourceTweetIds);
  return sourceRows
    .filter((row) => canonicalIds.has(row.tweet_id.trim()))
    .filter((row) => row.is_reply !== true && row.verification_status !== "rejected" && row.text.trim())
    .slice()
    .sort(compareSourceRows)[0] ?? null;
}

function getApiKey(options: ResetDisplayNameReconciliationOptions) {
  if (options.apiKey !== undefined) return options.apiKey?.trim() || null;
  return process.env.GEMINI_API_KEY?.trim() || null;
}

function getMaxGeminiRequests(value: number | undefined) {
  if (!Number.isInteger(value)) return DEFAULT_MAX_GEMINI_REQUESTS;
  return Math.max(0, Math.min(DEFAULT_MAX_GEMINI_REQUESTS, value as number));
}

function isWithinTransientRetryCooldown(
  record: ResetDisplayNameRecord | null,
  now: Date,
) {
  if (!record || !["api_error", "invalid_response"].includes(record.ai_status ?? "")) {
    return false;
  }
  const updatedAt = record.updated_at ? Date.parse(record.updated_at) : Number.NaN;
  const elapsed = now.getTime() - updatedAt;
  return Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed < RESET_DISPLAY_NAME_TRANSIENT_RETRY_COOLDOWN_MS;
}

function isWithinCandidateRetryCooldown(
  record: ResetDisplayNameCandidateRecord,
  now: Date,
) {
  if (record.aiStatus !== "rate_limited" || !record.nextRetryAt) return false;
  const nextRetryAt = Date.parse(record.nextRetryAt);
  return Number.isFinite(nextRetryAt) && nextRetryAt > now.getTime();
}

function shouldReuseCandidateResult(
  record: ResetDisplayNameCandidateRecord,
  inputHash: string,
  model: string,
) {
  return record.inputHash === inputHash &&
    record.aiModel === model &&
    record.aiPromptVersion === "random-reset-name-v3" &&
    record.aiInputMode === "notice-precompute-v1" &&
    ["accepted", "null", "review_required"].includes(record.aiStatus);
}

function isSupabaseReadUnavailable(data: RadarData) {
  const state = data.data_health?.sources.supabaseSignals.state;
  const resetDisplayNamesState = data.reset_display_names_health?.state;
  return (
    state === "misconfigured" ||
    state === "degraded" ||
    resetDisplayNamesState === "misconfigured" ||
    resetDisplayNamesState === "degraded"
  );
}

function outcome(
  candidate: Pick<ReconciliationCandidate, "eventKey" | "sourceTweetId" | "sourcePostText">,
  status: string,
  attempted = false,
  displayName: string | null = null,
): ResetDisplayNameReconciliationOutcome {
  return {
    eventKey: candidate.eventKey,
    sourceTweetId: candidate.sourceTweetId,
    sourceReady: Boolean(candidate.sourcePostText),
    attempted,
    status,
    displayName,
  };
}

export async function reconcileResetDisplayNames(
  options: ResetDisplayNameReconciliationOptions = {},
): Promise<ResetDisplayNameReconciliationResult> {
  const now = options.now ?? new Date();
  const data = options.data ?? await (
    options.fetchData ?? ((calculationNow: Date) => fetchCurrentRadarData({
      bypassCache: true,
      calculationNow,
      resetDisplayNameReadMode: "full",
    }))
  )(now);
  const history = options.canonicalHistory ?? getCanonicalResetHistoryForDisplayNameReconciliation(data);
  const sourceRows = options.sourceRows
    ? normalizeSourceRows(options.sourceRows)
    : collectSourceRows(data);
  const namesByKey = new Map<string, ResetDisplayNameRecord>();
  for (const record of data.reset_display_names ?? []) {
    const eventKey = record.event_key?.trim();
    if (eventKey && !namesByKey.has(eventKey)) namesByKey.set(eventKey, record);
  }

  const results: ResetDisplayNameReconciliationResult = {
    scanned: history.length,
    candidates: 0,
    attempted: 0,
    geminiRequests: 0,
    writes: 0,
    invalidated: false,
    outcomes: [],
    candidateSeeds: 0,
    candidateGeminiRequests: 0,
    candidatePromotions: 0,
  };

  if (isSupabaseReadUnavailable(data)) {
    results.outcomes.push({
      eventKey: null,
      sourceTweetId: null,
      sourceReady: false,
      attempted: false,
      status: "data_unavailable",
      displayName: null,
    });
    return results;
  }

  const candidateActivation = options.candidateActivation ?? {
    mode: "off" as const,
    adoptionAt: null,
  };
  const candidateModeEnabled = candidateActivation.mode !== "off" &&
    candidateActivation.adoptionAt !== null;
  let candidateStore: ResetDisplayNameCandidateStoreClient | null = null;
  let candidateNotices: ReadonlyArray<ResetDisplayNameCandidateNotice> = [];
  let candidateRecords: ResetDisplayNameCandidateRecord[] = [];

  if (candidateModeEnabled) {
    candidateStore = options.candidateStore ?? getCandidateStoreClient();
    candidateNotices = options.candidateNotices ?? await fetchResetDisplayNameCandidateNoticeSignals(candidateActivation);
    if (candidateStore) {
      try {
        candidateRecords = await listResetDisplayNameCandidates(candidateStore);
      } catch {
        candidateRecords = [];
      }
    }
  }

  if (candidateModeEnabled && candidateStore) {
    const seeds = discoverMissingResetDisplayNameCandidateSeeds(
      candidateNotices,
      candidateRecords,
      candidateActivation,
    );
    if (options.dryRun) {
      results.candidateSeeds = seeds.length;
    } else {
      for (const seed of seeds) {
        try {
          const record = await upsertResetDisplayNameCandidateSeed(candidateStore, seed);
          results.candidateSeeds = (results.candidateSeeds ?? 0) + 1;
          candidateRecords = [
            ...candidateRecords.filter((candidate) => candidate.candidateId !== record.candidateId),
            record,
          ];
        } catch {
          // Candidate self-healing is auxiliary and cannot fail the canonical
          // completed-event reconciliation.
        }
      }
    }
  }

  const preCompletedPromotionEventKeys = new Set<string>();
  let wrote = false;

  if (candidateActivation.mode === "full" && candidateStore && !options.dryRun) {
    for (const candidate of candidateRecords) {
      if (candidate.lifecycleStatus !== "provisional" || candidate.aiStatus !== "accepted") continue;
      const notice = candidateNoticeForRecord(candidate, candidateNotices);
      if (!notice || !notice.isExecutionBearing) continue;
      if (!candidateActivation.adoptionAt || !isResetDisplayNameCandidateNoticeAfterAdoption(
        notice.tweetCreatedAt,
        candidateActivation.adoptionAt,
      )) continue;

      const context = getCandidatePromotionContext(candidate, data, history);
      if (!context) continue;

      try {
        const promotion = await promoteResetDisplayNameCandidate(candidateStore, {
          candidateId: candidate.candidateId,
          canonicalEventKey: context.identityResolution.resetEventKey ?? "",
          canonicalSourceTweetId: context.canonicalSourceTweetId,
          promotedAt: now.toISOString(),
          identityResolution: context.identityResolution,
          authoritativeEvidence: context.authoritativeEvidence,
        });
        if (promotion.status === "promoted" || promotion.status === "already_promoted") {
          results.candidatePromotions = (results.candidatePromotions ?? 0) + 1;
        }
        if (
          promotion.status === "promoted" ||
          promotion.status === "reused" ||
          promotion.status === "already_promoted"
        ) {
          const eventKey = promotion.canonicalEventKey ?? context.identityResolution.resetEventKey;
          if (eventKey) preCompletedPromotionEventKeys.add(eventKey);
        }
        if (promotion.canonicalWrite) {
          results.writes += 1;
          wrote = true;
        }
      } catch {
        // Promotion is best-effort and cannot roll back authoritative execution evidence.
      }
    }
  }

  const candidates: ReconciliationCandidate[] = [];
  const seenEventKeys = new Set<string>();
  for (const item of history) {
    const eventKey = getCanonicalResetDisplayNameEventKey(item);
    if (!eventKey) {
      results.outcomes.push({
        eventKey: null,
        sourceTweetId: null,
        sourceReady: false,
        attempted: false,
        status: "missing_canonical_key",
        displayName: null,
      });
      continue;
    }
    if (seenEventKeys.has(eventKey)) continue;
    seenEventKeys.add(eventKey);

    if (!isAutoNameableCanonicalEvent(item, now)) {
      results.outcomes.push({
        eventKey,
        sourceTweetId: null,
        sourceReady: false,
        attempted: false,
        status: "not_nameable",
        displayName: null,
      });
      continue;
    }

    const completedAt = getCompletedResetTimestamp(item);
    if (completedAt === null) continue;
    const adoptionAt = options.adoptionAt?.getTime();
    if (adoptionAt !== undefined && Number.isFinite(adoptionAt) && completedAt < adoptionAt) {
      results.outcomes.push({
        eventKey,
        sourceTweetId: null,
        sourceReady: false,
        attempted: false,
        status: "before_adoption_boundary",
        displayName: null,
      });
      continue;
    }
    const sourceTweetIds = getCanonicalSourceTweetIds(item);
    const effectiveSource = resolveCandidateSource(sourceTweetIds, sourceRows);
    const sourcePostText = effectiveSource
      ? buildResetDisplayNameSourceContext({
          effectiveFormalCandidate: effectiveSource,
          sourceTweetIds,
          sourceRows,
        })
      : null;
    const input = toRandomResetNameInput(item, completedAt);
    input.sourcePostText = sourcePostText;

    candidates.push({
      item,
      eventKey,
      completedAt,
      sourceTweetId: effectiveSource?.tweet_id ?? null,
      sourcePostText,
      inputHash: hashResetDisplayNameInput(input, sourcePostText),
      existing: namesByKey.get(eventKey) ?? null,
    });
  }

  candidates.sort((left, right) => {
    if (left.completedAt !== right.completedAt) return right.completedAt - left.completedAt;
    return left.eventKey.localeCompare(right.eventKey);
  });
  results.candidates = candidates.length;

  const model = options.model ?? RANDOM_RESET_NAME_MODEL;
  const apiKey = getApiKey(options);
  const maxGeminiRequests = getMaxGeminiRequests(options.maxGeminiRequests);
  const ensure = options.ensure ?? ensureResetDisplayNameForEvent;

  for (const candidate of candidates) {
    if (preCompletedPromotionEventKeys.has(candidate.eventKey)) {
      results.outcomes.push(outcome(candidate, "preserved_precomputed"));
      continue;
    }
    const existingManualName = candidate.existing?.manual_name_ja?.trim();
    if (existingManualName) {
      results.outcomes.push(outcome(candidate, "manual", false, existingManualName));
      continue;
    }
    if (shouldPreserveExistingAcceptedResetDisplayName(candidate.existing)) {
      results.outcomes.push(outcome(
        candidate,
        "preserved_legacy_accepted",
        false,
        candidate.existing?.ai_name_ja ?? null,
      ));
      continue;
    }
    if (isSafeAcceptedPrecomputedResetDisplayName(candidate.existing)) {
      results.outcomes.push(outcome(
        candidate,
        "preserved_precomputed",
        false,
        candidate.existing?.ai_name_ja ?? null,
      ));
      continue;
    }
    if (!candidate.sourcePostText) {
      results.outcomes.push(outcome(
        candidate,
        candidate.existing?.ai_status === "accepted" ? "preserved_existing" : "source_unavailable",
        false,
        candidate.existing?.ai_status === "accepted" ? candidate.existing.ai_name_ja : null,
      ));
      continue;
    }
    if (isWithinTransientRetryCooldown(candidate.existing, now)) {
      results.outcomes.push(outcome(candidate, "retry_cooldown"));
      continue;
    }
    if (shouldReuseResetDisplayNameResult(candidate.existing, candidate.inputHash, model)) {
      results.outcomes.push(outcome(
        candidate,
        candidate.existing?.ai_status ?? "reused",
        false,
        candidate.existing?.ai_name_ja ?? null,
      ));
      continue;
    }
    if (!apiKey) {
      results.outcomes.push(outcome(candidate, "api_error"));
      continue;
    }
    if (results.geminiRequests >= maxGeminiRequests) {
      results.outcomes.push(outcome(candidate, "gemini_cap_reached"));
      continue;
    }
    if (options.dryRun) {
      results.outcomes.push(outcome(candidate, "dry_run"));
      continue;
    }

    results.geminiRequests += 1;
    results.attempted += 1;
    let generation: ResetDisplayNameGenerationOutcome;
    try {
      generation = await ensure(candidate.item, {
        canonicalEventKey: candidate.eventKey,
        existingRecord: candidate.existing,
        sourcePostText: candidate.sourcePostText,
        sourceTweetId: candidate.sourceTweetId,
        now,
        apiKey,
        model,
        timeoutMs: options.timeoutMs,
      });
    } catch {
      results.outcomes.push(outcome(candidate, "api_error", true));
      continue;
    }

    if (!generation.skipped) {
      results.writes += 1;
      wrote = true;
    }
    results.outcomes.push(outcome(
      candidate,
      generation.status,
      true,
      generation.displayName,
    ));
  }

  if (candidateActivation.mode === "full" && candidateStore) {
    const candidateGenerate = options.candidateGenerate ?? generateResetDisplayNameCandidate;
    const stalePendingBefore = new Date(
      now.getTime() - RESET_DISPLAY_NAME_CANDIDATE_STALE_PENDING_MS,
    ).toISOString();

    for (const candidate of candidateRecords) {
      if (candidate.lifecycleStatus !== "provisional") continue;
      const notice = candidateNoticeForRecord(candidate, candidateNotices);
      if (!notice || !notice.isExecutionBearing) continue;
      if (!candidateActivation.adoptionAt || !isResetDisplayNameCandidateNoticeAfterAdoption(
        notice.tweetCreatedAt,
        candidateActivation.adoptionAt,
      )) continue;

      if (hasPersistedAuthoritativeExecutionForCandidate(
        candidate,
        data.tibo_formal_adoptions ?? [],
        data.reset_execution_estimates ?? [],
      )) {
        // Authoritative execution is handed to the completed-event reconciler;
        // candidate generation must never race that canonical path.
        continue;
      }

      const sourcePostText = candidateSourcePostText(candidate, notice, candidateNotices);
      if (!sourcePostText) continue;
      const namingInput = buildCandidateNamingInput(candidate, notice, sourcePostText);
      const sourceSnapshotHash = hashCandidateValue({
        officialNoticeTweetId: candidate.officialNoticeTweetId,
        logicalPostId: candidate.logicalPostId,
        noticeTweetIds: candidate.noticeTweetIds,
        sourceTweetIds: candidate.sourceTweetIds,
        notice,
        sourcePostText,
      });
      const inputHash = hashCandidateValue(namingInput);

      if (shouldReuseCandidateResult(candidate, inputHash, model)) continue;
      if (isWithinCandidateRetryCooldown(candidate, now)) continue;
      if (!apiKey || results.geminiRequests >= maxGeminiRequests) continue;
      if (options.dryRun) continue;

      let claimed: ResetDisplayNameCandidateRecord | null;
      try {
        claimed = await claimResetDisplayNameCandidateGeneration(candidateStore, {
          candidateId: candidate.candidateId,
          sourceSnapshotHash,
          inputHash,
          now: now.toISOString(),
          stalePendingBefore,
        });
      } catch {
        continue;
      }
      if (!claimed) continue;

      results.geminiRequests += 1;
      results.attempted += 1;
      results.candidateGeminiRequests = (results.candidateGeminiRequests ?? 0) + 1;

      let generation: RandomResetNameGenerationResult;
      try {
        generation = await candidateGenerate(namingInput, {
          apiKey,
          model,
          timeoutMs: options.timeoutMs,
        });
      } catch {
        generation = {
          name: null,
          nameEn: null,
          nameZh: null,
          confidence: null,
          evidence: null,
          reason: null,
          evidenceGrounded: null,
          flags: [],
          status: "api_error",
          model,
          latencyMs: 0,
          httpStatus: null,
          retryAfterSeconds: null,
        };
      }

      const acceptance = assessRandomResetNameResult(generation);
      try {
        await writeResetDisplayNameCandidateGeneration(candidateStore, {
          candidateId: candidate.candidateId,
          sourceSnapshotHash,
          inputHash,
          aiStatus: acceptance.status,
          aiInputMode: "notice-precompute-v1",
          result: generation,
          retryAfterSeconds: generation.retryAfterSeconds,
          generatedAt: now.toISOString(),
          claimedAt: claimed.updatedAt,
        });
      } catch {
        // A stale or unavailable candidate result is isolated from the
        // canonical event reconciliation and public cache.
      }
    }

    if (!options.dryRun) {
      try {
        candidateRecords = await listResetDisplayNameCandidates(candidateStore);
      } catch {
        // A stale read can only defer promotion; it must not affect canonical work.
      }
    }

  }

  if (wrote && options.invalidateRadarData) {
    try {
      await options.invalidateRadarData();
      results.invalidated = true;
    } catch {
      results.invalidated = false;
    }
  }

  return results;
}
