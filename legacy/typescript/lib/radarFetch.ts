import { unstable_cache } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { fetchOpenAIStatusSignals } from "@/lib/openaiStatus";
import { createRadarCalculationContext, getLocalRadarData, getRandomResetHeatmapEventTimes } from "@/lib/radar";
import {
  combineDataSourceHealth,
  createRadarDataHealth,
  getDatabaseReadHealth,
  getRequiredConfigurationHealth,
} from "@/lib/radar/dataHealth";
import type {
  ActiveTiboSignal,
  DataFetchResult,
  DataSourceHealth,
  Locale,
  PublicRadarSnapshot,
  RadarData,
} from "@/lib/radar/types";
import { toPublicRadarSnapshot } from "@/lib/radar/publicDto";
import {
  fetchResetDisplayNamesResult,
  type ResetDisplayNameReadMode,
} from "@/lib/radar/resetDisplayNameStore";
import {
  getPublicRecoveryObservation,
  type CodexRecoveryObservation,
} from "@/lib/codexUsageRecovery";
import {
  readCodexRecoveryObservations,
  readResetExecutionEstimates,
} from "@/lib/codexUsageRecoveryStore";
import {
  isExcludedRecoveryObservationId,
  isExcludedResetEventKey,
} from "@/data/resetHistory";
import {
  readTiboFormalAdoptions,
  type TiboFormalAdoptionRecord,
} from "@/lib/radar/tiboFormalAdoptionStore";
import {
  findRelatedTiboNotices,
  getNoticeBackedRecoveryObservationIds,
  isFormalTiboResetSignal,
  selectRepresentativeTiboNotice,
  type FormalTiboResetSignal,
  type RejectedTiboResetSignal,
  type TiboNoticeSignal,
} from "@/lib/radar/tiboHistory";
import { getEffectiveTeaserStrength } from "@/lib/radar/teaserStrength";
import { expandTiboSignalVariants } from "@/lib/radar/tiboSecondarySignal";
import type { RegularResetEventRow } from "@/lib/radar/regularResetSchedule";
import { attachNextGenerationBPublicTrainingState } from "@/lib/radar/publishedProbability";
import {
  getNextGenerationRandomTargetEvents,
  loadNextGenerationTrainingState,
} from "@/lib/radar/nextGenerationTraining";
import { TIBO_EDIT_IDENTITY_COLUMNS } from "@/lib/radar/tiboEditIdentity";
import { isMissingTiboOptionalColumnError } from "@/lib/radar/tiboSchemaCompatibility";
import {
  hasFutureBankedDistributionIntent,
  isRecurringConditionalBankedDistributionNotice,
} from "@/lib/radar/bankedReset";
import {
  isExecutionBearingResetDisplayNameNotice,
  type ResetDisplayNameCandidateActivation,
} from "@/lib/radar/resetDisplayNameCandidateTypes";
import type { ResetDisplayNameCandidateNotice } from "@/lib/radar/resetDisplayNameReconciliation";

export const API_CACHE_CONTROL =
  "public, max-age=0, s-maxage=600, stale-while-revalidate=300";
export const RADAR_CORE_CACHE_TTL_SECONDS = 15 * 60;
export const PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS = 10 * 60;
export const PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS = 60 * 60;
export const RADAR_PAGE_CACHE_TTL_SECONDS = 60 * 60;
const PUBLIC_RADAR_SNAPSHOT_BUCKET_MS = PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS * 1000;
const RADAR_PAGE_CACHE_BUCKET_MS = RADAR_PAGE_CACHE_TTL_SECONDS * 1000;

export const ACTIVE_TIBO_SIGNAL_TYPES: ActiveTiboSignal["signal_type"][] = [
  "official_notice",
  "reset_executed",
  "teaser",
];
const TIBO_CACHE_BUCKET_MS = 60 * 1000;

// Keep the active query explicit. These are the persisted columns consumed by
// the read-side projection and public/probability paths; database-only audit
// columns are intentionally not transferred on every radar fetch.
export const ACTIVE_TIBO_SIGNAL_SELECT_FIELDS = [
  "tweet_id",
  "signal_type",
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "verification_status",
  "confidence",
  "classification_reason",
  "is_reply",
  "is_quote",
  "rule_signal_type",
  "ai_signal_type",
  "ai_temporal_direction",
  "ai_reason_ja",
  "ai_reset_type_ja",
  "ai_notice_to_execution",
  "ai_classification_status",
  "classification_source",
  "reply_to_handles",
  "reply_context_text",
  "source_timeline",
  "translated_text_ja",
  "translated_text_zh",
  "ai_teaser_strength",
  "ai_teaser_strength_confidence",
  "ai_teaser_strength_evidence_quote",
  "ai_teaser_strength_reason_ja",
  "ai_temporal_expression",
  "ai_temporal_kind",
  "ai_temporal_precision",
  "ai_temporal_timezone",
  "ai_temporal_confidence",
  "expected_start_at",
  "expected_end_at",
  "temporal_resolution_status",
  "temporal_resolution_version",
  "quote_context_text",
  "quote_tweet_url",
  "quote_author_handle",
  "teaser_strength",
  "temporal_expression",
  "temporal_kind",
  "temporal_precision",
  "temporal_timezone",
  "temporal_confidence",
  "temporal_resolution_source",
  "secondary_signal",
  ...TIBO_EDIT_IDENTITY_COLUMNS.split(","),
].join(",");

const ACTIVE_TIBO_SIGNAL_FALLBACK_SELECT_FIELDS = [
  "tweet_id",
  "signal_type",
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "verification_status",
  "confidence",
  "classification_reason",
  "is_reply",
  "is_quote",
].join(",");

// History consumers need the semantic, temporal, reply, and edit-identity
// columns below. Write-time AI audit mirrors and quote-source metadata are not
// read from this path; nested secondary_signal keeps the data needed for its
// expansion, while the compatibility fallback remains unchanged.
export const TIBO_HISTORY_SELECT_FIELDS = [
  "tweet_id",
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "signal_type",
  "confidence",
  "classification_reason",
  "classification_source",
  "rule_signal_type",
  "ai_signal_type",
  "teaser_strength",
  "secondary_signal",
  "ai_teaser_strength",
  "ai_temporal_expression",
  "ai_temporal_kind",
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
  "translated_text_ja",
  "translated_text_zh",
  "is_reply",
  "reply_to_handles",
  "reply_context_text",
  "verification_status",
  ...TIBO_EDIT_IDENTITY_COLUMNS.split(","),
].join(",");

const TIBO_HISTORY_FALLBACK_SELECT_FIELDS = [
  "tweet_id",
  "text",
  "tweet_url",
  "tweet_created_at",
  "detected_at",
  "expires_at",
  "signal_type",
  "confidence",
  "verification_status",
  "classification_source",
  "ai_classification_status",
  "ai_reset_type_ja",
  "ai_notice_to_execution",
  "is_reply",
].join(",");

export const TIBO_HISTORY_MAX_ROWS = 1000;

type TiboHistoryQueryResult = {
  data: Array<FormalTiboResetSignal> | null;
  error: unknown | null;
};

type TiboHistoryQueryRunner = (
  fields: string,
  includeReplies: boolean,
) => Promise<TiboHistoryQueryResult>;

type TiboHistoryQueryBuilder = {
  or(filters: string): TiboHistoryQueryBuilder;
  order(column: string, options: { ascending: boolean }): TiboHistoryQueryBuilder;
  limit(count: number): Promise<TiboHistoryQueryResult>;
};

export type TiboHistoryReadResult = {
  withReplies: DataFetchResult<Array<FormalTiboResetSignal>>;
  withoutReplies: DataFetchResult<Array<FormalTiboResetSignal>>;
};

type ActiveTiboQueryBuilder = {
  not(column: string, operator: string, value: null): ActiveTiboQueryBuilder;
  gt(column: string, value: string): ActiveTiboQueryBuilder;
  or(filters: string): ActiveTiboQueryBuilder;
  in(column: string, values: string[]): ActiveTiboQueryBuilder;
  order(column: string, options: { ascending: boolean }): ActiveTiboQueryBuilder;
  limit(count: number): Promise<{ data: unknown[] | null; error: unknown | null }>;
};

export function applyActiveTiboQueryFilters(
  query: ActiveTiboQueryBuilder,
  expiryBoundaryIso: string,
) {
  return query
    .not("expires_at", "is", null)
    .gt("expires_at", expiryBoundaryIso)
    .or("verification_status.is.null,verification_status.neq.rejected")
    .or("is_reply.is.null,is_reply.eq.false")
    .in("signal_type", [...ACTIVE_TIBO_SIGNAL_TYPES]);
}

function getTiboCacheBoundary(now: Date) {
  const time = now.getTime();
  if (!Number.isFinite(time)) return new Date(0).toISOString();
  return new Date(Math.floor(time / TIBO_CACHE_BUCKET_MS) * TIBO_CACHE_BUCKET_MS).toISOString();
}

// 1. Raw Supabase fetch function. The boundary is both a safe query cutoff and
// an unstable_cache argument, so active expiry filters are not frozen forever
// under a constant cache key while avoiding a per-second cache key explosion.
async function fetchRawTiboSignals(expiryBoundaryIso: string): Promise<DataFetchResult<ActiveTiboSignal[]>> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { data: [], health: configuration };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const queryTiboSignals = (fields: string) => applyActiveTiboQueryFilters(
      supabase.from("tibo_signals").select(fields) as unknown as ActiveTiboQueryBuilder,
      expiryBoundaryIso,
    )
      .order("tweet_created_at", { ascending: false })
      .limit(20);
    let result = await queryTiboSignals(ACTIVE_TIBO_SIGNAL_SELECT_FIELDS);
    if (result.error && isMissingTiboOptionalColumnError(result.error)) {
      result = await queryTiboSignals(ACTIVE_TIBO_SIGNAL_FALLBACK_SELECT_FIELDS);
    }
    const { data, error } = result;

    const health = getDatabaseReadHealth(configuration, {
      hasData: data !== null,
      hasError: Boolean(error),
    });
    if (error) {
      console.error("Active Tibo signals query failed", error);
    }
    const activeSignals = data
      ? (data as Array<ActiveTiboSignal>).map((signal) => ({
          ...signal,
          teaser_strength: getEffectiveTeaserStrength(signal),
        }))
      : [];
    return { data: activeSignals, health };
  } catch (error) {
    console.error("Failed to load active Tibo signals", error);
    return { data: [], health: { state: "degraded", detail: "request_failed" } };
  }
}

// 2. Module-scoped unstable_cache wrapper (60s TTL, tagged "radar-data")
const getCachedTiboSignals = unstable_cache(
  fetchRawTiboSignals,
  ["tibo-signals-cache-v2"],
  {
    revalidate: 60,
    tags: ["radar-data"],
  }
);

export function splitTiboHistorySignals(
  signals: readonly FormalTiboResetSignal[],
) {
  return {
    // Keep the database ordering and complete row values for recent/UI use.
    withReplies: signals,
    // This matches the former PostgREST `is_reply IS NULL OR is_reply = false`
    // predicate without transferring the same wide rows twice.
    withoutReplies: signals.filter((signal) => signal.is_reply !== true),
  };
}

function toTiboHistoryFetchResult(
  configuration: DataSourceHealth,
  result: TiboHistoryQueryResult,
): DataFetchResult<Array<FormalTiboResetSignal>> {
  const health = getDatabaseReadHealth(configuration, {
    hasData: result.data !== null,
    hasError: Boolean(result.error),
  });
  return {
    data: result.data ?? [],
    health,
  };
}

async function executeTiboHistoryQuery(
  queryTiboHistory: TiboHistoryQueryRunner,
  fields: string,
  includeReplies: boolean,
): Promise<TiboHistoryQueryResult> {
  let result = await queryTiboHistory(fields, includeReplies);
  if (result.error && isMissingTiboOptionalColumnError(result.error)) {
    result = await queryTiboHistory(TIBO_HISTORY_FALLBACK_SELECT_FIELDS, includeReplies);
  }
  return result;
}

export async function readTiboHistorySignals(
  queryTiboHistory: TiboHistoryQueryRunner,
  configuration: DataSourceHealth,
): Promise<TiboHistoryReadResult> {
  const unifiedResult = await executeTiboHistoryQuery(
    queryTiboHistory,
    TIBO_HISTORY_SELECT_FIELDS,
    true,
  );
  const withReplies = toTiboHistoryFetchResult(configuration, unifiedResult);

  if (unifiedResult.error) {
    console.error("Tibo reset history query failed", unifiedResult.error);
  }

  if (unifiedResult.error || withReplies.data.length === TIBO_HISTORY_MAX_ROWS) {
    const formalResult = await executeTiboHistoryQuery(
      queryTiboHistory,
      TIBO_HISTORY_SELECT_FIELDS,
      false,
    );
    const withoutReplies = toTiboHistoryFetchResult(configuration, formalResult);
    if (formalResult.error) {
      console.error("Tibo formal history query failed", formalResult.error);
    }
    return { withReplies, withoutReplies };
  }

  return {
    withReplies,
    withoutReplies: {
      data: splitTiboHistorySignals(withReplies.data).withoutReplies,
      health: withReplies.health,
    },
  };
}

async function fetchRawTiboHistorySignals(): Promise<TiboHistoryReadResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return {
      withReplies: { data: [], health: configuration },
      withoutReplies: { data: [], health: configuration },
    };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const queryTiboHistory: TiboHistoryQueryRunner = async (fields, includeReplies) => {
      const query = supabase
        .from("tibo_signals")
        .select(fields) as unknown as TiboHistoryQueryBuilder;
      const filteredQuery = includeReplies
        ? query
        : query.or("is_reply.is.null,is_reply.eq.false");
      return await filteredQuery
        .order("tweet_created_at", { ascending: false })
        .limit(TIBO_HISTORY_MAX_ROWS);
    };
    return await readTiboHistorySignals(queryTiboHistory, configuration);
  } catch (error) {
    console.error("Failed to load Tibo reset history", error);
    const health = { state: "degraded", detail: "request_failed" } as const;
    return {
      withReplies: { data: [], health },
      withoutReplies: { data: [], health },
    };
  }
}

type CandidateNoticeRow = {
  tweet_id?: unknown;
  text?: unknown;
  tweet_url?: unknown;
  tweet_created_at?: unknown;
  detected_at?: unknown;
  signal_type?: unknown;
  verification_status?: unknown;
  is_reply?: unknown;
  logical_post_id?: unknown;
  edit_history_tweet_ids?: unknown;
  edit_metadata_source?: unknown;
  ai_temporal_kind?: unknown;
  ai_temporal_precision?: unknown;
  temporal_kind?: unknown;
  temporal_precision?: unknown;
  expected_start_at?: unknown;
  expected_end_at?: unknown;
  ai_reset_type_ja?: unknown;
  scope?: unknown;
};

type CandidateNoticeQueryResult = {
  data: unknown[] | null;
  error: unknown | null;
};

function candidateNoticeRow(value: unknown): ResetDisplayNameCandidateNotice | null {
  if (!value || typeof value !== "object") return null;
  const row = value as CandidateNoticeRow;
  if (
    typeof row.tweet_id !== "string" ||
    typeof row.text !== "string" ||
    typeof row.tweet_created_at !== "string" ||
    row.signal_type !== "official_notice"
  ) {
    return null;
  }

  const trusted = row.edit_metadata_source === "x_api" &&
    typeof row.logical_post_id === "string" &&
    row.logical_post_id.trim().length > 0 &&
    Array.isArray(row.edit_history_tweet_ids) &&
    row.edit_history_tweet_ids.every((id) => typeof id === "string" && id.length > 0);
  const noticeTweetIds = trusted
    ? Array.from(new Set([row.tweet_id, ...(row.edit_history_tweet_ids as string[])]))
    : [row.tweet_id];
  const isHistoricalOnly = row.temporal_kind === "historical" || row.ai_temporal_kind === "historical";
  const isPresentationOnlyOngoingBanked = isRecurringConditionalBankedDistributionNotice(row.text);

  return {
    officialNoticeTweetId: row.tweet_id,
    logicalPostId: trusted ? (row.logical_post_id as string) : null,
    noticeTweetIds,
    sourceTweetIds: [...noticeTweetIds],
    tweetCreatedAt: row.tweet_created_at,
    noticeObservedAt: typeof row.detected_at === "string" ? row.detected_at : row.tweet_created_at,
    expectedStartAt: typeof row.expected_start_at === "string" ? row.expected_start_at : null,
    expectedEndAt: typeof row.expected_end_at === "string" ? row.expected_end_at : null,
    temporalPrecision: typeof row.temporal_precision === "string"
      ? row.temporal_precision
      : typeof row.ai_temporal_precision === "string" ? row.ai_temporal_precision : null,
    scope: typeof row.scope === "string" ? row.scope : null,
    noticeType: typeof row.ai_reset_type_ja === "string" ? row.ai_reset_type_ja : null,
    sourceUrl: typeof row.tweet_url === "string" ? row.tweet_url : null,
    sourceContext: row.text,
    isExecutionBearing: isExecutionBearingResetDisplayNameNotice({
      signalType: "official_notice",
      verificationStatus: typeof row.verification_status === "string" ? row.verification_status : null,
      isReply: row.is_reply === true,
      isHistoricalOnly,
      isPresentationOnlyOngoingBanked,
      hasFutureBankedDistributionIntent: hasFutureBankedDistributionIntent(row.text),
    }),
  };
}

/**
 * Internal candidate input only. It deliberately has no RadarData/public DTO
 * path and is bypassed entirely when candidate activation is off.
 */
export async function fetchResetDisplayNameCandidateNoticeSignals(
  activation: ResetDisplayNameCandidateActivation,
): Promise<ResetDisplayNameCandidateNotice[]> {
  if (activation.mode === "off" || !activation.adoptionAt) return [];

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return [];

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const fields = [
      "tweet_id",
      "text",
      "tweet_url",
      "tweet_created_at",
      "detected_at",
      "signal_type",
      "verification_status",
      "is_reply",
      "logical_post_id",
      "edit_history_tweet_ids",
      "edit_metadata_source",
      "ai_temporal_kind",
      "ai_temporal_precision",
      "temporal_kind",
      "temporal_precision",
      "expected_start_at",
      "expected_end_at",
      "ai_reset_type_ja",
    ].join(",");
    let result = (await supabase
      .from("tibo_signals")
      .select(fields)
      .eq("signal_type", "official_notice")
      .or("verification_status.is.null,verification_status.neq.rejected")
      .or("is_reply.is.null,is_reply.eq.false")
      .gte("tweet_created_at", activation.adoptionAt)
      .order("tweet_created_at", { ascending: true })
      .limit(1000)) as CandidateNoticeQueryResult;

    if (result.error && isMissingTiboOptionalColumnError(result.error)) {
      result = (await supabase
        .from("tibo_signals")
        .select("tweet_id,text,tweet_url,tweet_created_at,detected_at,signal_type,verification_status,is_reply")
        .eq("signal_type", "official_notice")
        .or("verification_status.is.null,verification_status.neq.rejected")
        .or("is_reply.is.null,is_reply.eq.false")
        .gte("tweet_created_at", activation.adoptionAt)
        .order("tweet_created_at", { ascending: true })
        .limit(1000)) as CandidateNoticeQueryResult;
    }
    if (result.error || !Array.isArray(result.data)) return [];
    return result.data
      .map(candidateNoticeRow)
      .filter((notice): notice is ResetDisplayNameCandidateNotice => Boolean(notice));
  } catch {
    return [];
  }
}

const getCachedTiboHistorySignals = unstable_cache(
  () => fetchRawTiboHistorySignals(),
  ["tibo-history-signals-cache-v3"],
  {
    revalidate: 60,
    tags: ["radar-data"],
  },
);

function isRegularResetEventRow(value: unknown): value is RegularResetEventRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RegularResetEventRow>;
  return (
    typeof row.schedule_key === "string" &&
    typeof row.window_start_at === "string" &&
    typeof row.window_end_at === "string" &&
    typeof row.representative_at === "string" &&
    typeof row.scheduled_at === "string" &&
    typeof row.completed_at === "string" &&
    row.cycle_type === "定期リセット" &&
    typeof row.reset_method === "string" &&
    typeof row.scope === "string" &&
    row.record_kind === "regular_completed" &&
    (row.status === "completed" || row.status === "corrected" || row.status === "voided")
  );
}

async function fetchRawRegularResetEvents(): Promise<
  DataFetchResult<RegularResetEventRow[]>
> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { data: [], health: configuration };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from("regular_reset_events")
      .select(
        "schedule_key,window_start_at,window_end_at,representative_at,scheduled_at,completed_at,cycle_type,reset_method,scope,record_kind,status,correction_reason,corrected_at",
      )
      .order("completed_at", { ascending: false })
      .limit(1000);

    const health = getDatabaseReadHealth(configuration, {
      hasData: data !== null,
      hasError: Boolean(error),
    });
    if (error) {
      console.error("Regular reset events query failed", { detail: "database_error" });
      return { data: [], health };
    }

    const rows = (data ?? []).filter(isRegularResetEventRow);
    return { data: rows, health };
  } catch {
    console.error("Failed to load regular reset events", { detail: "request_failed" });
    return { data: [], health: { state: "degraded", detail: "request_failed" } };
  }
}

const getCachedRegularResetEvents = unstable_cache(
  () => fetchRawRegularResetEvents(),
  ["regular-reset-events-cache-v1"],
  {
    revalidate: 60,
    tags: ["radar-data"],
  },
);

async function fetchRawCodexRecoveryObservations(): Promise<
  DataFetchResult<CodexRecoveryObservation[]>
> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { data: [], health: configuration };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const result = await readCodexRecoveryObservations(supabase);
    const rows = result.rows.filter(
      (row) => !isExcludedRecoveryObservationId(row.id),
    );
    const health = getDatabaseReadHealth(configuration, {
      hasData: rows.length > 0 || result.error === null,
      hasError: Boolean(result.error),
    });
    if (result.error) {
      console.error("Codex recovery observations query failed", { detail: "database_error" });
    }
    return { data: rows, health };
  } catch {
    console.error("Failed to load codex recovery observations", { detail: "request_failed" });
    return { data: [], health: { state: "degraded", detail: "request_failed" } };
  }
}

const getCachedCodexRecoveryObservations = unstable_cache(
  () => fetchRawCodexRecoveryObservations(),
  ["codex-recovery-observations-cache-v2"],
  {
    revalidate: 30,
    tags: ["radar-data"],
  },
);

async function fetchRawResetExecutionEstimates() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { data: [], health: configuration };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const result = await readResetExecutionEstimates(supabase);
    const rows = result.rows.filter(
      (row) =>
        !isExcludedResetEventKey(row.resetEventKey) &&
        !isExcludedRecoveryObservationId(row.recoveryObservationId),
    );
    const health = getDatabaseReadHealth(configuration, {
      hasData: rows.length > 0 || result.error === null,
      hasError: Boolean(result.error),
    });
    if (result.error) {
      console.error("Reset execution estimates query failed", { detail: "database_error" });
    }
    return { data: rows, health };
  } catch {
    console.error("Failed to load reset execution estimates", { detail: "request_failed" });
    return { data: [], health: { state: "degraded" as const, detail: "request_failed" as const } };
  }
}

const getCachedResetExecutionEstimates = unstable_cache(
  () => fetchRawResetExecutionEstimates(),
  ["reset-execution-estimates-cache-v2"],
  {
    revalidate: 30,
    tags: ["radar-data"],
  },
);

async function fetchRawTiboFormalAdoptions(): Promise<
  DataFetchResult<TiboFormalAdoptionRecord[]>
> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configuration = getRequiredConfigurationHealth([
    supabaseUrl,
    supabaseServiceRoleKey,
  ]);

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return { data: [], health: configuration };
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const result = await readTiboFormalAdoptions(supabase);
    const health = getDatabaseReadHealth(configuration, {
      hasData: result.ledgers.length > 0 || result.error === null,
      hasError: Boolean(result.error),
    });
    if (result.error) {
      console.error("Tibo formal adoption ledger query failed", { detail: "database_error" });
    }
    return { data: result.ledgers, health };
  } catch {
    console.error("Failed to load Tibo formal adoption ledger", { detail: "request_failed" });
    return { data: [], health: { state: "degraded", detail: "request_failed" } };
  }
}

const getCachedTiboFormalAdoptions = unstable_cache(
  () => fetchRawTiboFormalAdoptions(),
  ["tibo-formal-adoptions-cache-v1"],
  {
    revalidate: 30,
    tags: ["radar-data"],
  },
);

const getCachedResetDisplayNames = unstable_cache(
  () => fetchResetDisplayNamesResult("public"),
  ["reset-display-names-cache-v2"],
  {
    revalidate: 60,
    tags: ["radar-data"],
  },
);

function toNoticeSignal(signal: FormalTiboResetSignal): TiboNoticeSignal | null {
  if (signal.is_reply === true) return null;
  if (signal.signal_type !== "official_notice" && signal.signal_type !== "teaser") {
    return null;
  }

  return {
    tweet_id: signal.tweet_id,
    text: signal.text,
    tweet_url: signal.tweet_url,
    tweet_created_at: signal.tweet_created_at,
    signal_type: signal.signal_type,
    confidence: signal.confidence,
    verification_status: signal.verification_status,
    ai_temporal_expression: signal.ai_temporal_expression ?? null,
    ai_temporal_kind: signal.ai_temporal_kind ?? null,
    ai_temporal_precision: signal.ai_temporal_precision ?? null,
    ai_temporal_timezone: signal.ai_temporal_timezone ?? null,
    temporal_expression: signal.temporal_expression ?? null,
    temporal_kind: signal.temporal_kind ?? null,
    temporal_precision: signal.temporal_precision ?? null,
    temporal_timezone: signal.temporal_timezone ?? null,
    temporal_confidence: signal.temporal_confidence ?? null,
    temporal_resolution_source: signal.temporal_resolution_source ?? null,
    expected_start_at: signal.expected_start_at ?? null,
    expected_end_at: signal.expected_end_at ?? null,
    temporal_resolution_status: signal.temporal_resolution_status ?? null,
    logical_post_id: signal.logical_post_id ?? null,
    edit_history_tweet_ids: signal.edit_history_tweet_ids ?? null,
    edit_version: signal.edit_version ?? null,
    edit_metadata_source: signal.edit_metadata_source ?? null,
  };
}

type TiboSignalBundle = {
  activeSignals: Array<ActiveTiboSignal>;
  recentSignals: Array<ActiveTiboSignal>;
  formalResets: Array<FormalTiboResetSignal>;
  rejectedResets: Array<RejectedTiboResetSignal>;
  health: DataSourceHealth;
};

export function associateTiboNotices(
  acceptedResets: Array<FormalTiboResetSignal>,
  notices: Array<TiboNoticeSignal>,
) {
  const sortedResets = acceptedResets
    .slice()
    .sort(
      (left, right) =>
        new Date(left.tweet_created_at).getTime() - new Date(right.tweet_created_at).getTime(),
    );
  const associated: Array<FormalTiboResetSignal> = [];
  let previousResetAt: string | null = null;
  let index = 0;

  while (index < sortedResets.length) {
    const groupTime = new Date(sortedResets[index].tweet_created_at).getTime();
    const groupPreviousResetAt = previousResetAt;
    while (
      index < sortedResets.length &&
      new Date(sortedResets[index].tweet_created_at).getTime() === groupTime
    ) {
      const signal = sortedResets[index];
      const relatedNotices = findRelatedTiboNotices(signal, notices, groupPreviousResetAt);
      associated.push({
        ...signal,
        related_notice: selectRepresentativeTiboNotice(relatedNotices),
        related_notices: relatedNotices,
      });
      index += 1;
    }
    previousResetAt = sortedResets[index - 1].tweet_created_at;
  }

  return associated.reverse();
}

async function getTiboSignalBundle(
  now: Date = new Date(),
  bypassCache = false,
): Promise<TiboSignalBundle> {
  const tiboCacheBoundary = getTiboCacheBoundary(now);
  const [activeResult, historyResult] = await Promise.all([
    bypassCache
      ? fetchRawTiboSignals(tiboCacheBoundary)
      : getCachedTiboSignals(tiboCacheBoundary),
    bypassCache
      ? fetchRawTiboHistorySignals()
      : getCachedTiboHistorySignals(),
  ]);
  const activeSignals = activeResult.data.filter((signal) => {
    if (signal.verification_status === "rejected") return false;
    if (!signal.expires_at) return false;
    const expiresTime = new Date(signal.expires_at).getTime();
    return !isNaN(expiresTime) && expiresTime > now.getTime();
  });
  const signals = historyResult.withoutReplies.data;
  const recentSignalsSource = historyResult.withReplies.data;
  const acceptedResets = signals.filter(isFormalTiboResetSignal);
  const notices = expandTiboSignalVariants(signals)
    .map(toNoticeSignal)
    .filter((signal): signal is TiboNoticeSignal => Boolean(signal));

  const formalResets = associateTiboNotices(acceptedResets, notices);
  const recentSignals = recentSignalsSource.map((signal) => ({
    tweet_id: signal.tweet_id,
    signal_type: signal.signal_type,
    text: signal.text,
    tweet_url: signal.tweet_url,
    tweet_created_at: signal.tweet_created_at,
    detected_at: signal.detected_at ?? undefined,
    expires_at: signal.expires_at ?? undefined,
    confidence: signal.confidence ?? undefined,
    verification_status: signal.verification_status,
    translated_text_ja: signal.translated_text_ja ?? null,
    translated_text_zh: signal.translated_text_zh ?? null,
    teaser_strength: getEffectiveTeaserStrength(signal),
    secondary_signal: signal.secondary_signal ?? null,
    ai_temporal_expression: signal.ai_temporal_expression ?? null,
    ai_temporal_kind: signal.ai_temporal_kind ?? null,
    ai_temporal_precision: signal.ai_temporal_precision ?? null,
    ai_temporal_timezone: signal.ai_temporal_timezone ?? null,
    ai_temporal_confidence: signal.ai_temporal_confidence ?? null,
    temporal_expression: signal.temporal_expression ?? null,
    temporal_kind: signal.temporal_kind ?? null,
    temporal_precision: signal.temporal_precision ?? null,
    temporal_timezone: signal.temporal_timezone ?? null,
    temporal_confidence: signal.temporal_confidence ?? null,
    temporal_resolution_source: signal.temporal_resolution_source ?? null,
    expected_start_at: signal.expected_start_at ?? null,
    expected_end_at: signal.expected_end_at ?? null,
    temporal_resolution_status: signal.temporal_resolution_status ?? null,
    temporal_resolution_version: signal.temporal_resolution_version ?? null,
    is_reply: signal.is_reply ?? undefined,
    reply_to_handles: signal.reply_to_handles ?? null,
    reply_context_text: signal.reply_context_text ?? null,
    logical_post_id: signal.logical_post_id ?? null,
    edit_history_tweet_ids: signal.edit_history_tweet_ids ?? null,
    edit_version: signal.edit_version ?? null,
    edit_metadata_source: signal.edit_metadata_source ?? null,
  }));
  const rejectedResets = signals
    .filter(
      (signal) =>
        signal.signal_type === "reset_executed" &&
        signal.is_reply !== true &&
        (signal.confidence ?? 0) >= 0.95 &&
        signal.verification_status === "rejected",
    )
    .map(({ tweet_id, tweet_url, tweet_created_at }) => ({
      tweet_id,
      tweet_url,
      tweet_created_at,
    }));

  return {
    activeSignals,
    recentSignals,
    formalResets,
    rejectedResets,
    health: combineDataSourceHealth(
      activeResult.health,
      historyResult.withReplies.health,
      historyResult.withoutReplies.health,
    ),
  };
}

export async function fetchFormalTiboResetSignals(): Promise<Array<FormalTiboResetSignal>> {
  return (await getTiboSignalBundle()).formalResets;
}

export async function fetchRejectedTiboResetSignals(): Promise<Array<RejectedTiboResetSignal>> {
  return (await getTiboSignalBundle()).rejectedResets;
}

/**
 * Fetches recent active Tibo signals with dynamic time-filtering performed OUTSIDE the cache.
 */
export async function getActiveTiboSignals(): Promise<ActiveTiboSignal[]> {
  return (await getTiboSignalBundle()).activeSignals;
}

async function attachPublicBTrainingState(
  data: RadarData,
  calculationNow: Date,
): Promise<RadarData> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return attachNextGenerationBPublicTrainingState(data, {
      trainingRows: [],
      trainingReadStatus: "error",
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const trainingState = await loadNextGenerationTrainingState(supabase, {
      asOf: calculationNow,
      randomEvents: getNextGenerationRandomTargetEvents(data, calculationNow),
    });
    return attachNextGenerationBPublicTrainingState(data, {
      trainingRows: trainingState.bRows,
      trainingReadStatus: trainingState.status,
    });
  } catch {
    return attachNextGenerationBPublicTrainingState(data, {
      trainingRows: [],
      trainingReadStatus: "error",
    });
  }
}

export async function fetchCurrentRadarData(
  options: {
    cache?: RequestCache;
    revalidate?: number;
    calculationNow?: Date;
    /** Bypass Next's Data Cache while preserving the Production normalizer. */
    bypassCache?: boolean;
    /** Selects the reset-name row projection for this internal read. */
    resetDisplayNameReadMode?: ResetDisplayNameReadMode;
  } = {},
): Promise<RadarData> {
  const calculationNow = options.calculationNow ?? new Date();
  const checkedAt = calculationNow.toISOString();
  const resetDisplayNameReadMode = options.resetDisplayNameReadMode ?? "public";
  const resetDisplayNamesPromise = options.bypassCache
    ? fetchResetDisplayNamesResult(resetDisplayNameReadMode)
    : resetDisplayNameReadMode === "full"
      ? fetchResetDisplayNamesResult("full")
      : getCachedResetDisplayNames();
  const [openAIStatus, tiboSignals, regularResetEvents, resetDisplayNames, codexRecovery, resetExecutionEstimates, tiboFormalAdoptions] = await Promise.all([
    fetchOpenAIStatusSignals(options),
    getTiboSignalBundle(calculationNow, options.bypassCache === true),
    options.bypassCache ? fetchRawRegularResetEvents() : getCachedRegularResetEvents(),
    resetDisplayNamesPromise,
    options.bypassCache ? fetchRawCodexRecoveryObservations() : getCachedCodexRecoveryObservations(),
    options.bypassCache ? fetchRawResetExecutionEstimates() : getCachedResetExecutionEstimates(),
    options.bypassCache ? fetchRawTiboFormalAdoptions() : getCachedTiboFormalAdoptions(),
  ]);

  const codexRecoveryObservation = codexRecovery.data.find((observation) =>
    getPublicRecoveryObservation(
      observation,
      calculationNow,
      getNoticeBackedRecoveryObservationIds(resetExecutionEstimates.data),
    ),
  ) ?? null;

  const radarData = getLocalRadarData({
    checkedAt,
    calculationNow,
    dataHealth: createRadarDataHealth(
      checkedAt,
      combineDataSourceHealth(
        tiboSignals.health,
        regularResetEvents.health,
        codexRecovery.health,
        resetExecutionEstimates.health,
      ),
      openAIStatus.health,
    ),
    openAIStatus: openAIStatus.data,
    activeTiboSignals: tiboSignals.activeSignals,
    recentTiboSignals: tiboSignals.recentSignals,
    formalTiboResets: tiboSignals.formalResets,
    rejectedTiboResets: tiboSignals.rejectedResets,
    regularResetEvents: regularResetEvents.data,
    resetDisplayNames: resetDisplayNames.data,
    resetDisplayNamesHealth: resetDisplayNames.health,
    resetExecutionEstimates: resetExecutionEstimates.data,
    tiboFormalAdoptions: tiboFormalAdoptions.data,
    tiboFormalAdoptionsHealth: tiboFormalAdoptions.health,
    codexRecoveryObservation,
    codexRecoveryObservations: codexRecovery.data,
  });

  return attachPublicBTrainingState(radarData, calculationNow);
}

type SharedRadarCore = {
  data: RadarData;
  generatedAt: string;
};

export function getPublicRadarSnapshotCalculationBucket(
  calculationNow: Date | number = Date.now(),
) {
  const timestamp = typeof calculationNow === "number"
    ? calculationNow
    : calculationNow.getTime();
  return Number.isFinite(timestamp)
    ? Math.floor(timestamp / PUBLIC_RADAR_SNAPSHOT_BUCKET_MS)
    : 0;
}

export function getPublicRadarSnapshotCacheDimensions(
  calculationNow: Date | number,
  limitHistory = true,
) {
  return {
    calculationBucket: getPublicRadarSnapshotCalculationBucket(calculationNow),
    limitHistory,
  };
}

export function getRandomResetHeatmapCacheDimensions(
  calculationNow: Date | number,
) {
  return {
    calculationBucket: getPublicRadarSnapshotCalculationBucket(calculationNow),
  };
}

export function getRadarPageCacheDimensions(
  locale: Locale,
  calculationNow: Date | number,
  limitHistory = true,
  includeHeatmap = true,
) {
  const timestamp = typeof calculationNow === "number"
    ? calculationNow
    : calculationNow.getTime();
  return {
    locale,
    calculationBucket: Number.isFinite(timestamp)
      ? Math.floor(timestamp / RADAR_PAGE_CACHE_BUCKET_MS)
      : 0,
    limitHistory,
    includeHeatmap,
  };
}

function getEffectiveRadarCalculationNowForBucket(
  calculationBucket: number,
  coreGeneratedAt: string,
  bucketMs: number,
) {
  const bucketStart = calculationBucket * bucketMs;
  const generatedAt = Date.parse(coreGeneratedAt);
  const effectiveTime = Number.isFinite(generatedAt)
    ? Math.max(bucketStart, generatedAt)
    : bucketStart;
  return new Date(effectiveTime);
}

export function getEffectiveRadarCalculationNow(
  calculationBucket: number,
  coreGeneratedAt: string,
) {
  return getEffectiveRadarCalculationNowForBucket(
    calculationBucket,
    coreGeneratedAt,
    PUBLIC_RADAR_SNAPSHOT_BUCKET_MS,
  );
}

export type PublicRadarSnapshotBundle = Record<Locale, PublicRadarSnapshot>;

type SharedRadarSnapshotInput = SharedRadarCore & {
  stale: boolean;
};

export function buildPublicRadarSnapshotBundle(
  core: SharedRadarSnapshotInput,
  calculationBucket: number,
  limitHistory: boolean,
): PublicRadarSnapshotBundle {
  const calculationNow = getEffectiveRadarCalculationNow(calculationBucket, core.generatedAt);
  const calculationContext = createRadarCalculationContext(core.data, calculationNow);

  return {
    ja: toPublicRadarSnapshot(core.data, "ja", {
      stale: core.stale,
      generatedAt: core.generatedAt,
      limitHistory,
      calculationNow,
      calculationContext,
    }),
    en: toPublicRadarSnapshot(core.data, "en", {
      stale: core.stale,
      generatedAt: core.generatedAt,
      limitHistory,
      calculationNow,
      calculationContext,
    }),
    zh: toPublicRadarSnapshot(core.data, "zh", {
      stale: core.stale,
      generatedAt: core.generatedAt,
      limitHistory,
      calculationNow,
      calculationContext,
    }),
  };
}

/**
 * One locale-independent Data Cache entry feeds the pages and the API. Next's
 * persistent Data Cache keeps the last successful value available during a
 * stale-while-revalidate cycle and across normal cold starts.
 */
const getCachedRadarCore = unstable_cache(
  async (): Promise<SharedRadarCore> => {
    const computeStartedAt = performance.now();
    let dataHealth: "ok" | "degraded" | null = null;
    try {
      const data = await fetchCurrentRadarData({ cache: "no-store" });
      dataHealth = data.data_health?.overall ?? null;
      if (dataHealth === "degraded") {
        // Do not replace a healthy Data Cache entry with a partial live result.
        // Next can continue serving the previous value while this revalidates.
        throw new Error("required_source_degraded");
      }
      return {
        data,
        generatedAt: data.checked_at ?? new Date().toISOString(),
      };
    } finally {
      console.info(JSON.stringify({
        event: "radar_core_compute",
        durationMs: performance.now() - computeStartedAt,
        dataHealth,
      }));
    }
  },
  ["radar-core-cache-v6"],
  {
    revalidate: RADAR_CORE_CACHE_TTL_SECONDS,
    tags: ["radar-data"],
  },
);

/**
 * The arguments to unstable_cache are part of Next's generated cache key.
 * The bucket remains the cache identity, while a refreshed core timestamp
 * lets an invalidated entry observe a mid-bucket reset immediately.
 */
const getCachedPublicRadarSnapshotBundle = unstable_cache(
  async (
    calculationBucket: number,
    limitHistory: boolean,
  ): Promise<PublicRadarSnapshotBundle> => {
    const computeStartedAt = performance.now();
    try {
      const core = await fetchSharedRadarCore();
      return buildPublicRadarSnapshotBundle(core, calculationBucket, limitHistory);
    } finally {
      console.info(JSON.stringify({
        event: "public_snapshot_bundle_compute",
        calculationBucket,
        limitHistory,
        durationMs: performance.now() - computeStartedAt,
      }));
    }
  },
  ["radar-public-snapshot-bundle-cache-v5"],
  {
    revalidate: PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS,
    tags: ["radar-data"],
  },
);

const getCachedRandomResetHeatmapEventTimes = unstable_cache(
  async (calculationBucket: number): Promise<string[]> => {
    const core = await fetchSharedRadarCore();
    const calculationNow = getEffectiveRadarCalculationNow(calculationBucket, core.generatedAt);
    const calculationContext = createRadarCalculationContext(core.data, calculationNow);
    return getRandomResetHeatmapEventTimes(
      core.data,
      calculationNow,
      calculationContext.canonicalHistoryContext,
    );
  },
  ["radar-random-reset-heatmap-cache-v1"],
  {
    revalidate: PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS,
    tags: ["radar-data"],
  },
);

const getCachedRadarPageData = unstable_cache(
  async (
    locale: Locale,
    calculationBucket: number,
    limitHistory: boolean,
    includeHeatmap: boolean,
  ) => {
    const totalStartedAt = performance.now();
    let fetchSharedRadarCoreMs: number | null = null;
    let createRadarCalculationContextMs: number | null = null;
    let toPublicRadarSnapshotMs: number | null = null;
    let heatmapMs: number | null = null;

    try {
      const coreStartedAt = performance.now();
      const core = await fetchSharedRadarCore();
      fetchSharedRadarCoreMs = performance.now() - coreStartedAt;
      const calculationNow = getEffectiveRadarCalculationNowForBucket(
        calculationBucket,
        core.generatedAt,
        RADAR_PAGE_CACHE_BUCKET_MS,
      );

      const contextStartedAt = performance.now();
      const calculationContext = createRadarCalculationContext(core.data, calculationNow);
      createRadarCalculationContextMs = performance.now() - contextStartedAt;

      const snapshotStartedAt = performance.now();
      const initialData = toPublicRadarSnapshot(core.data, locale, {
        stale: core.stale,
        generatedAt: core.generatedAt,
        limitHistory,
        calculationNow,
        calculationContext,
      });
      toPublicRadarSnapshotMs = performance.now() - snapshotStartedAt;

      const heatmapStartedAt = performance.now();
      const randomResetHeatmapEventTimes = includeHeatmap
        ? getRandomResetHeatmapEventTimes(
            core.data,
            calculationNow,
            calculationContext.canonicalHistoryContext,
          )
        : [];
      heatmapMs = performance.now() - heatmapStartedAt;

      return { initialData, randomResetHeatmapEventTimes };
    } finally {
      console.info(JSON.stringify({
        event: "radar_page_compute",
        locale,
        calculationBucket,
        limitHistory,
        includeHeatmap,
        fetchSharedRadarCoreMs,
        createRadarCalculationContextMs,
        toPublicRadarSnapshotMs,
        heatmapMs,
        totalMs: performance.now() - totalStartedAt,
      }));
    }
  },
  ["radar-page-cache-v1"],
  {
    revalidate: RADAR_PAGE_CACHE_TTL_SECONDS,
    tags: ["radar-data"],
  },
);

function isOlderThanCacheTtl(generatedAt: string) {
  const generatedTime = new Date(generatedAt).getTime();
  return (
    !Number.isNaN(generatedTime) &&
    Date.now() - generatedTime > RADAR_CORE_CACHE_TTL_SECONDS * 1000
  );
}

async function getSafeRadarFallback(): Promise<SharedRadarCore> {
  const data = await fetchCurrentRadarData({ cache: "no-store" });
  return {
    data,
    generatedAt: data.checked_at ?? new Date().toISOString(),
  };
}

export async function fetchSharedRadarCore() {
  try {
    const core = await getCachedRadarCore();
    const stale = isOlderThanCacheTtl(core.generatedAt);
    if (stale) {
      console.warn("[Radar stale fallback] serving an older cached snapshot", {
        reason: "cached_data_stale",
      });
    }
    return {
      ...core,
      stale,
    };
  } catch {
    // A first-request failure has no Data Cache value to serve. The existing
    // local/static fallback remains renderable and is marked degraded/stale.
    console.warn("[Radar stale fallback] live radar data was unavailable", {
      reason: "live_data_unavailable",
    });
    try {
      const fallback = await getSafeRadarFallback();
      return { ...fallback, stale: true };
    } catch {
      const checkedAt = new Date().toISOString();
      const fallback = getLocalRadarData({
        checkedAt,
        dataHealth: {
          overall: "degraded",
          checkedAt,
          sources: {
            supabaseSignals: { state: "degraded", detail: "request_failed" },
            openAIStatus: { state: "degraded", detail: "request_failed" },
          },
        },
      });
      return { data: fallback, generatedAt: checkedAt, stale: true };
    }
  }
}

export async function fetchPublicRadarSnapshot(
  locale: Locale,
  options: { limitHistory?: boolean; calculationNow?: Date | number } = {},
): Promise<PublicRadarSnapshot> {
  const dimensions = getPublicRadarSnapshotCacheDimensions(
    options.calculationNow ?? new Date(),
    options.limitHistory ?? true,
  );
  const bundle = await getCachedPublicRadarSnapshotBundle(
    dimensions.calculationBucket,
    dimensions.limitHistory,
  );
  return bundle[locale];
}

export async function fetchRandomResetHeatmapEventTimes(
  calculationNow: Date | number = new Date(),
) {
  const { calculationBucket } = getRandomResetHeatmapCacheDimensions(calculationNow);
  return getCachedRandomResetHeatmapEventTimes(calculationBucket);
}

export async function fetchRadarPageData(
  locale: Locale,
  options: { limitHistory?: boolean; includeHeatmap?: boolean } = {},
) {
  const calculationNow = new Date();
  const dimensions = getRadarPageCacheDimensions(
    locale,
    calculationNow,
    options.limitHistory ?? true,
    options.includeHeatmap ?? true,
  );
  return getCachedRadarPageData(
    dimensions.locale,
    dimensions.calculationBucket,
    dimensions.limitHistory,
    dimensions.includeHeatmap,
  );
}
