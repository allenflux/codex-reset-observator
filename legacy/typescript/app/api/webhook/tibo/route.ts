import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import { classifyTiboTweet, isCurrentUsageResetAnnouncement } from "@/lib/radar/classification";
import { classifyWithGemini } from "@/lib/radar/geminiClassification";
import {
  buildTiboClassificationResponse,
  normalizeTiboClassificationMode,
  selectTiboClassification,
  shouldRunGeminiClassification,
} from "@/lib/radar/tiboClassificationMode";
import {
  convertTiboResetSignalToHistoryEvent,
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
} from "@/lib/radar/tiboHistory";
import {
  confirmNearestCodexRecoveryObservation,
  findNearestCodexRecoveryObservation,
  findFormalTiboResetCluster,
  readCodexUsageMonitorState,
  readResetExecutionEstimates,
  upsertResetExecutionEstimate,
} from "@/lib/codexUsageRecoveryStore";
import { USAGE_TIBO_MATCH_WINDOW_MS } from "@/lib/codexUsageRecovery";
import { getUsageMonitorCoverageAtEvent } from "@/lib/codexUsageMonitorCoverage";
import {
  buildFormalAdoptionResult,
  hasExistingFormalResetCluster,
  shouldDeferFormalTiboReset,
} from "@/lib/radar/formalAdoption";
import { preserveTiboWebhookState } from "@/lib/radar/tiboWebhookState";
import type { TiboSecondarySignal } from "@/lib/radar/tiboSecondarySignal";
import { parseTiboReplyMetadata } from "@/lib/radar/tiboReplyMetadata";
import { getTiboContextSafetyDecision } from "@/lib/radar/tiboContextSafety";
import { translateWithGemini } from "@/lib/radar/geminiTranslation";
import {
  ensureResetDisplayNameForEvent,
} from "@/lib/radar/resetDisplayNameStore";
import { RANDOM_RESET_NAME_MODEL } from "@/lib/radar/randomResetNaming";
import {
  buildResetDisplayNameSourceContext,
  type ResetDisplayNameSourceRow,
} from "@/lib/radar/resetDisplayNameSourceContext";
import { isBearerAuthorizationValid } from "@/lib/security/bearerAuth";
import {
  getTemporalNoticeExpiry,
  parseTiboTemporalSemantics,
  resolveTiboTemporalSchedule,
  TIBO_SOURCE_TIME_ZONE,
} from "@/lib/radar/tiboTemporal";
import { resolveTiboPostEditHistory } from "@/lib/radar/xPostEditHistory";
import {
  createUntrustedTiboEditIdentity,
  getTrustedTiboEditIdentity,
  mergeTiboEditIdentity,
  reconcileTiboEditChainMetadata,
  toTiboEditIdentityFields,
  type TiboEditIdentityStore,
} from "@/lib/radar/tiboEditIdentity";
import {
  collapseTrustedTiboEditChains,
  toEffectiveTiboLogicalPostRow,
  type TiboLogicalPost,
  type TiboLogicalPostRow,
} from "@/lib/radar/tiboLogicalPost";
import {
  claimTiboFormalAdoption,
  readTiboFormalAdoptions,
  type TiboFormalAdoptionRecord,
  type TiboFormalAdoptionClaimResult,
} from "@/lib/radar/tiboFormalAdoptionStore";
import {
  resolveTiboResetEventIdentity,
  type TiboResetEventIdentityResolution,
} from "@/lib/radar/tiboResetEventIdentity";
import { isMissingTiboOptionalColumnError } from "@/lib/radar/tiboSchemaCompatibility";
import {
  isResetDisplayNameCandidateNoticeAfterAdoption,
  isResetDisplayNameCandidateOperationEnabled,
  readResetDisplayNameCandidateActivation,
} from "@/lib/radar/resetDisplayNameCandidateActivation";
import {
  isExecutionBearingResetDisplayNameNotice,
  type ResetDisplayNameCandidateSeed,
} from "@/lib/radar/resetDisplayNameCandidateTypes";
import {
  upsertResetDisplayNameCandidateSeed,
  type ResetDisplayNameCandidateStoreClient,
} from "@/lib/radar/resetDisplayNameCandidateStore";
import {
  hasFutureBankedDistributionIntent,
  isRecurringConditionalBankedDistributionNotice,
} from "@/lib/radar/bankedReset";

// Keep the webhook bounded while accepting X long-form/note text. The former
// 2,000-character ceiling rejected fully expanded posts before classification.
const MAX_TIBO_SOURCE_TEXT_LENGTH = 25_000;

function normalizeStoredTranslation(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized && normalized.length <= 6000 ? normalized : null;
}

const FORMAL_FLOW_STATUSES = new Set(["claimed_new", "existing", "reconciled"]);

function isTiboSignalType(value: unknown): value is FormalTiboResetSignal["signal_type"] {
  return value === "official_notice" ||
    value === "reset_executed" ||
    value === "teaser" ||
    value === "irrelevant";
}

function toLogicalPostRow(value: unknown): TiboLogicalPostRow | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.tweet_id !== "string" ||
    typeof source.tweet_created_at !== "string" ||
    typeof source.text !== "string" ||
    !isTiboSignalType(source.signal_type)
  ) {
    return null;
  }

  return {
    ...source,
    tweet_id: source.tweet_id,
    text: source.text,
    tweet_url: typeof source.tweet_url === "string" ? source.tweet_url : null,
    tweet_created_at: source.tweet_created_at,
    signal_type: source.signal_type,
    confidence: typeof source.confidence === "number" ? source.confidence : null,
    classification_reason: typeof source.classification_reason === "string"
      ? source.classification_reason
      : null,
    classification_source: typeof source.classification_source === "string"
      ? source.classification_source
      : null,
    verification_status: typeof source.verification_status === "string"
      ? source.verification_status
      : null,
    logical_post_id: typeof source.logical_post_id === "string"
      ? source.logical_post_id
      : null,
    edit_history_tweet_ids: Array.isArray(source.edit_history_tweet_ids)
      ? source.edit_history_tweet_ids.filter((id): id is string => typeof id === "string")
      : null,
    edit_version: typeof source.edit_version === "number" ? source.edit_version : null,
    edit_metadata_source: source.edit_metadata_source === "x_api" || source.edit_metadata_source === "none"
      ? source.edit_metadata_source
      : null,
  } as TiboLogicalPostRow;
}

function toFormalTiboResetSignal(value: TiboLogicalPostRow | Record<string, unknown>): FormalTiboResetSignal | null {
  const row = toLogicalPostRow(value);
  if (!row || !row.tweet_url || !row.verification_status || row.confidence === null) return null;
  return {
    ...row,
    tweet_url: row.tweet_url,
    confidence: row.confidence,
    verification_status: row.verification_status as FormalTiboResetSignal["verification_status"],
  } as FormalTiboResetSignal;
}

function getStaticHistoryEvidence() {
  return LOCAL_RESET_HISTORY
    .map((item) => ({
      eventKey: item.id?.trim() || item.guid?.trim() || "",
      sourceTweetIds: item.sourceTweetIds ?? [],
      sourceUrl: item.source_url ?? null,
    }))
    .filter((item) => item.eventKey.length > 0);
}

function getDynamicHistoryEvidence(rows: readonly TiboLogicalPostRow[]) {
  return rows
    .filter((row) => row.signal_type === "reset_executed")
    .map((row) => ({
      eventKey: `tibo-reset-${row.tweet_id}`,
      sourceTweetIds: row.edit_history_tweet_ids ?? [row.tweet_id],
      sourceUrl: row.tweet_url ?? null,
    }));
}

function hasFormalRawVersion(logicalPost: TiboLogicalPost<TiboLogicalPostRow>) {
  return logicalPost.rawVersions.some((row) =>
    row.signal_type === "reset_executed" &&
    typeof row.confidence === "number" &&
    row.confidence >= 0.95 &&
    row.verification_status !== "rejected" &&
    (row as TiboLogicalPostRow & { is_reply?: boolean | null }).is_reply !== true,
  );
}

function getClaimSource(
  resolution: TiboResetEventIdentityResolution,
  ledger: TiboFormalAdoptionRecord | null,
) {
  if (ledger) return ledger.claimSource;
  switch (resolution.matchedEvidence?.kind) {
    case "existing_estimate":
      return "existing_estimate" as const;
    case "existing_history":
      return "existing_history" as const;
    case "existing_dynamic":
      return "existing_dynamic" as const;
    default:
      return "new_adoption" as const;
  }
}

function getFormalCandidateForDisplay(
  logicalPost: TiboLogicalPost<TiboLogicalPostRow>,
) {
  const row = toEffectiveTiboLogicalPostRow(logicalPost);
  return row ? toFormalTiboResetSignal(row) : null;
}

function buildSecondarySignal(
  aiResult: Awaited<ReturnType<typeof classifyWithGemini>> | null,
  sourceText: string,
  createdAt: string,
  primarySignalType: string | null | undefined,
): TiboSecondarySignal | null {
  const futureSignal = aiResult?.futureSignal;
  if (
    primarySignalType !== "reset_executed" ||
    !futureSignal ||
    (futureSignal.signalType !== "official_notice" &&
      futureSignal.signalType !== "teaser" &&
      futureSignal.signalType !== "none")
  ) {
    return null;
  }

  const temporalSemantics = futureSignal.signalType === "official_notice"
    ? parseTiboTemporalSemantics(futureSignal, sourceText)
    : null;
  const temporalResolution = futureSignal.signalType === "official_notice"
    ? resolveTiboTemporalSchedule(temporalSemantics, createdAt, TIBO_SOURCE_TIME_ZONE)
    : null;
  const fallbackExpiresAt = new Date(new Date(createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const expiresAt = temporalResolution?.status === "resolved"
    ? new Date(
        getTemporalNoticeExpiry(temporalResolution, createdAt) ?? fallbackExpiresAt,
      ).toISOString()
    : fallbackExpiresAt;

  return {
    signalType: futureSignal.signalType,
    teaserStrength: futureSignal.signalType === "teaser"
      ? futureSignal.teaserStrength ?? null
      : null,
    confidence: futureSignal.confidence,
    evidenceQuote: futureSignal.evidenceQuote,
    reasonJa: futureSignal.reasonJa,
    expiresAt,
    temporal: temporalResolution
      ? {
          status: temporalResolution.status,
          version: temporalResolution.version,
          temporalExpression: temporalResolution.temporalExpression,
          temporalKind: temporalResolution.temporalKind,
          temporalPrecision: temporalResolution.temporalPrecision,
          timezone: temporalResolution.timezone,
          confidence: temporalResolution.confidence,
          expectedStartAt: temporalResolution.expectedStartAt,
          expectedEndAt: temporalResolution.expectedEndAt,
          resolutionSource: temporalResolution.resolutionSource,
        }
      : null,
  };
}

function getSupabaseServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase Service Role configuration.");
  }
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}

async function fetchCanonicalTiboSourceRows(
  supabase: ReturnType<typeof getSupabaseServiceClient>,
  sourceTweetIds: readonly string[],
): Promise<ResetDisplayNameSourceRow[]> {
  const tweetIds = Array.from(new Set(
    sourceTweetIds.map((tweetId) => tweetId.trim()).filter(Boolean),
  ));
  if (tweetIds.length === 0) return [];

  try {
    const result = await supabase
      .from("tibo_signals")
      .select("tweet_id,text,tweet_created_at,is_reply,verification_status")
      .in("tweet_id", tweetIds)
      .limit(32);
    if (result.error) {
      console.warn("[Webhook Warning] Canonical Tibo naming context lookup failed", {
        reason: "lookup_failed",
      });
      return [];
    }

    return (result.data ?? []).flatMap((row) => {
      if (
        !row ||
        typeof row.tweet_id !== "string" ||
        typeof row.text !== "string"
      ) {
        return [];
      }
      return [{
        tweet_id: row.tweet_id,
        text: row.text,
        tweet_created_at: typeof row.tweet_created_at === "string"
          ? row.tweet_created_at
          : null,
        is_reply: row.is_reply === true,
        verification_status: typeof row.verification_status === "string"
          ? row.verification_status
          : null,
      }];
    });
  } catch {
    console.warn("[Webhook Warning] Canonical Tibo naming context lookup failed", {
      reason: "request_failed",
    });
    return [];
  }
}

function uniqueNonEmptyTweetIds(values: readonly string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function seedResetDisplayNameCandidateIfEligible(
  supabase: ReturnType<typeof getSupabaseServiceClient>,
  candidate: FormalTiboResetSignal,
  editHistoryMetadata: {
    trusted: boolean;
    logicalPostId: string;
    editHistoryTweetIds: string[];
  },
) {
  const activation = readResetDisplayNameCandidateActivation(process.env);
  if (!isResetDisplayNameCandidateOperationEnabled(activation, "seed") || !activation.adoptionAt) {
    return;
  }

  // The cutoff is anchored to the persisted signal's creation timestamp. Do
  // not substitute webhook receipt time or any resolved notice timestamp.
  if (!isResetDisplayNameCandidateNoticeAfterAdoption(candidate.tweet_created_at, activation.adoptionAt)) {
    return;
  }

  const isHistoricalOnly = (candidate.temporal_kind as unknown) === "historical" ||
    (candidate.ai_temporal_kind as unknown) === "historical";
  const isPresentationOnlyOngoingBanked = isRecurringConditionalBankedDistributionNotice(candidate.text);
  if (!isExecutionBearingResetDisplayNameNotice({
    signalType: candidate.signal_type,
    verificationStatus: candidate.verification_status,
    isReply: candidate.is_reply === true,
    isHistoricalOnly,
    isPresentationOnlyOngoingBanked,
    hasFutureBankedDistributionIntent: hasFutureBankedDistributionIntent(candidate.text),
  })) {
    return;
  }

  const trustedNoticeIds = editHistoryMetadata.trusted
    ? editHistoryMetadata.editHistoryTweetIds
    : [candidate.tweet_id];
  const seed: ResetDisplayNameCandidateSeed = {
    officialNoticeTweetId: candidate.tweet_id,
    logicalPostId: editHistoryMetadata.trusted ? editHistoryMetadata.logicalPostId : null,
    noticeTweetIds: uniqueNonEmptyTweetIds([candidate.tweet_id, ...trustedNoticeIds]),
    sourceTweetIds: uniqueNonEmptyTweetIds([candidate.tweet_id, ...trustedNoticeIds]),
  };

  try {
    await upsertResetDisplayNameCandidateSeed(
      supabase as unknown as ResetDisplayNameCandidateStoreClient,
      seed,
    );
  } catch {
    // Candidate naming is auxiliary. A seed failure must never change the
    // webhook's persisted signal or formal adoption behavior.
    console.warn("[Webhook Warning] Reset display name candidate seed failed", {
      reason: "best_effort_failed",
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. Fail closed if TIBO_WEBHOOK_SECRET is not configured
    const expectedSecret = process.env.TIBO_WEBHOOK_SECRET;
    if (!expectedSecret) {
      return NextResponse.json(
        { error: "Server Configuration Error: TIBO_WEBHOOK_SECRET is not configured." },
        { status: 503 }
      );
    }

    if (!isBearerAuthorizationValid(req.headers.get("authorization"), expectedSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { tweetId, text, tweetUrl, tweetCreatedAt } = body;

    // 2. Strict Input Validation
    if (!tweetId || typeof tweetId !== "string" || !/^\d+$/.test(tweetId)) {
      return NextResponse.json({ error: "Invalid tweetId" }, { status: 400 });
    }

    if (
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.length > MAX_TIBO_SOURCE_TEXT_LENGTH
    ) {
      return NextResponse.json({ error: "Invalid text" }, { status: 400 });
    }

    if (
      !tweetUrl ||
      typeof tweetUrl !== "string" ||
      !/^https:\/\/(x|twitter)\.com\/thsottiaux\/status\/\d+/i.test(tweetUrl)
    ) {
      return NextResponse.json(
        { error: "Invalid tweetUrl: Must belong to @thsottiaux status path" },
        { status: 400 }
      );
    }

    if (!tweetCreatedAt || typeof tweetCreatedAt !== "string") {
      return NextResponse.json({ error: "tweetCreatedAt is required" }, { status: 400 });
    }

    const createdDate = new Date(tweetCreatedAt);
    const nowTime = Date.now();

    if (isNaN(createdDate.getTime())) {
      return NextResponse.json({ error: "Invalid tweetCreatedAt date format" }, { status: 400 });
    }

    if (createdDate.getTime() > nowTime + 5 * 60 * 1000) {
      return NextResponse.json(
        { error: "Invalid tweetCreatedAt: Timestamp is more than 5 minutes in the future" },
        { status: 400 }
      );
    }

    const replyMetadataResult = parseTiboReplyMetadata(body);
    if (!replyMetadataResult.ok) {
      return NextResponse.json({ error: "Invalid reply metadata" }, { status: 400 });
    }
    const replyMetadata = replyMetadataResult.value;
    const editHistoryMetadata = await resolveTiboPostEditHistory(tweetId);

    // 3. Existing Rule Classification
    const ruleResult = classifyTiboTweet(text, tweetUrl, replyMetadata);

    // 4. Gemini Classification (Optional based on GEMINI_CLASSIFICATION_MODE)
    const mode = normalizeTiboClassificationMode(process.env.GEMINI_CLASSIFICATION_MODE);

    let aiResult = null;
    if (shouldRunGeminiClassification(mode)) {
      try {
        aiResult = await classifyWithGemini(
          { text, tweetCreatedAt, sourceTimeZone: TIBO_SOURCE_TIME_ZONE, ...replyMetadata },
          { mode },
        );
      } catch {
        // Keep the webhook successful and let primary mode select the rule fallback.
        console.warn("[Webhook Warning] Gemini classification failed; using the rule fallback.");
          aiResult = {
          signalType: null,
          confidence: null,
          temporalDirection: null,
          evidenceQuote: null,
          reasonJa: null,
          resetTypeJa: null,
          noticeToExecution: null,
          teaserStrength: null,
          teaserStrengthConfidence: null,
          teaserStrengthEvidenceQuote: null,
          teaserStrengthReasonJa: null,
          futureSignal: null,
          temporalExpression: null,
          temporalKind: null,
          temporalPrecision: null,
          weekday: null,
          relativeDayOffset: null,
          relativeAmount: null,
          relativeUnit: null,
          explicitDateParts: null,
          explicitTimeParts: null,
          daypart: null,
          rangeKind: null,
          explicitTimezone: null,
          temporalConfidence: null,
          model: process.env.GEMINI_MODEL || null,
          status: "api_error" as const,
          classifiedAt: new Date().toISOString(),
        };
      }
    }

    const selectedClassification = selectTiboClassification(mode, ruleResult, aiResult);
    const contextSafetyDecision = getTiboContextSafetyDecision({
      authorText: text,
      replyContextText: replyMetadata.replyContextText,
      quoteContextText: replyMetadata.quoteContextText,
      selectedSignalType: selectedClassification.signalType,
      aiTeaserStrength: aiResult?.teaserStrength,
    });
    const effectiveClassification = contextSafetyDecision
      ? {
          ...selectedClassification,
          signalType: contextSafetyDecision.signalType,
          reason: contextSafetyDecision.reasonJa,
        }
      : selectedClassification;
    const baseClassificationResponse = buildTiboClassificationResponse(mode, ruleResult, aiResult);
    const classificationResponse = contextSafetyDecision
      ? {
          ...baseClassificationResponse,
          signalType: effectiveClassification.signalType,
          teaserStrength: contextSafetyDecision.teaserStrength,
        }
      : baseClassificationResponse;

    const hasForwardTimingSignal =
      effectiveClassification.signalType === "official_notice" ||
      effectiveClassification.signalType === "teaser";
    const temporalSemantics = hasForwardTimingSignal
      ? parseTiboTemporalSemantics(aiResult, text)
      : null;
    const temporalResolution = hasForwardTimingSignal
      ? resolveTiboTemporalSchedule(
          temporalSemantics,
          createdDate.toISOString(),
          TIBO_SOURCE_TIME_ZONE,
        )
      : null;

    // 5. Expiration follows the resolved notice window when available. Other
    // signals retain the existing tweet-created-at + 24h behavior.
    const expiresAt = temporalResolution?.status === "resolved"
      ? new Date(getTemporalNoticeExpiry(temporalResolution, createdDate.toISOString()) ?? createdDate.toISOString())
      : new Date(createdDate.getTime() + 24 * 60 * 60 * 1000);
    const receivedAt = new Date().toISOString();
    const rawAiAudit = aiResult?.rawAudit;

    // 6. Build Supabase Payload
    const secondarySignal = buildSecondarySignal(
      aiResult,
      text,
      createdDate.toISOString(),
      effectiveClassification.signalType,
    );
    const secondaryExpiresTime = secondarySignal?.expiresAt
      ? new Date(secondarySignal.expiresAt).getTime()
      : Number.NaN;
    const payloadExpiresAt = Number.isFinite(secondaryExpiresTime) &&
        secondaryExpiresTime > expiresAt.getTime()
      ? new Date(secondaryExpiresTime)
      : expiresAt;

    const payload = {
      tweet_id: tweetId,
      signal_type: effectiveClassification.signalType,
      confidence: effectiveClassification.confidence,
      text: text.trim(),
      tweet_url: tweetUrl,
      tweet_created_at: createdDate.toISOString(),
      detected_at: receivedAt,
      expires_at: payloadExpiresAt.toISOString(),
      verification_status: "auto_unverified" as const,
      classification_reason: effectiveClassification.reason,
      teaser_strength: contextSafetyDecision?.teaserStrength ?? null,
      secondary_signal: secondarySignal,
      is_reply: ruleResult.isReply,
      reply_to_handles: replyMetadata.replyToHandles ?? null,
      reply_context_text: replyMetadata.replyContextText ?? null,
      source_timeline: replyMetadata.sourceTimeline ?? null,
      is_quote: ruleResult.isQuote || replyMetadata.isQuote === true,
      quote_context_text: replyMetadata.quoteContextText ?? null,
      quote_tweet_url: replyMetadata.quoteTweetUrl ?? null,
      quote_author_handle: replyMetadata.quoteAuthorHandle ?? null,
      logical_post_id: editHistoryMetadata.logicalPostId,
      edit_history_tweet_ids: editHistoryMetadata.editHistoryTweetIds,
      edit_version: editHistoryMetadata.editVersion,
      edit_metadata_source: editHistoryMetadata.editMetadataSource,

      // Audit columns
      rule_signal_type: ruleResult.signalType,
      rule_confidence: ruleResult.confidence,
      ai_signal_type: rawAiAudit ? rawAiAudit.signalType : aiResult?.signalType ?? null,
      ai_confidence: aiResult?.confidence ?? null,
      ai_temporal_direction: rawAiAudit ? rawAiAudit.temporalDirection : aiResult?.temporalDirection || null,
      ai_evidence_quote: aiResult?.evidenceQuote || null,
      ai_reason_ja: rawAiAudit ? rawAiAudit.reasonJa : aiResult?.reasonJa || null,
      ai_reset_type_ja: aiResult?.resetTypeJa || null,
      ai_notice_to_execution: aiResult?.noticeToExecution || null,
      ai_teaser_strength: aiResult?.teaserStrength || null,
      ai_teaser_strength_confidence: aiResult?.teaserStrengthConfidence ?? null,
      ai_teaser_strength_evidence_quote: aiResult?.teaserStrengthEvidenceQuote || null,
      ai_teaser_strength_reason_ja: aiResult?.teaserStrengthReasonJa || null,
      ai_temporal_expression: aiResult?.temporalExpression || null,
      ai_temporal_kind: aiResult?.temporalKind || null,
      ai_temporal_precision: aiResult?.temporalPrecision || null,
      ai_temporal_timezone: aiResult?.explicitTimezone ?? null,
      ai_temporal_confidence: aiResult?.temporalConfidence ?? null,
      temporal_expression: temporalResolution?.temporalExpression ?? null,
      temporal_kind: temporalResolution?.temporalKind ?? null,
      temporal_precision: temporalResolution?.temporalPrecision ?? null,
      temporal_timezone: temporalResolution?.timezone ?? null,
      temporal_confidence: temporalResolution?.confidence ?? null,
      temporal_resolution_source: temporalResolution?.resolutionSource ?? null,
      expected_start_at: temporalResolution?.expectedStartAt ?? null,
      expected_end_at: temporalResolution?.expectedEndAt ?? null,
      temporal_resolution_status: temporalResolution?.status ?? null,
      temporal_resolution_version: temporalResolution?.version ?? null,
      ai_model: aiResult?.model || null,
      ai_classification_status: aiResult?.status || "skipped",
      ai_classified_at: aiResult?.classifiedAt || null,
      classification_source: selectedClassification.classificationSource,
    };

    // 7. Load existing state before the upsert. State lookup is fail-closed
    // so an unknown existing state can never be overwritten.
    const supabase = getSupabaseServiceClient();
    let existingSignal: Partial<FormalTiboResetSignal> | null = null;
    try {
      const { data, error: lookupError } = await supabase
        .from("tibo_signals")
        .select("tweet_id,text,tweet_url,tweet_created_at,detected_at,expires_at,signal_type,confidence,classification_reason,verification_status,classification_source,teaser_strength,secondary_signal,is_reply,reply_to_handles,reply_context_text,source_timeline,translated_text_ja,translated_text_zh,ai_teaser_strength,ai_teaser_strength_confidence,ai_teaser_strength_evidence_quote,ai_teaser_strength_reason_ja,logical_post_id,edit_history_tweet_ids,edit_version,edit_metadata_source")
        .eq("tweet_id", tweetId)
        .maybeSingle();

      if (lookupError) {
        // Optional Tibo schema migrations or schema-cache propagation may lag
        // application deployment. Keep the existing state lookup usable during
        // that window, while all real lookup failures remain fail-closed.
        if (isMissingTiboOptionalColumnError(lookupError)) {
          const legacyLookup = await supabase
            .from("tibo_signals")
            .select("tweet_id,text,tweet_url,tweet_created_at,detected_at,signal_type,confidence,classification_reason,verification_status,classification_source,is_reply,reply_to_handles,reply_context_text,source_timeline")
            .eq("tweet_id", tweetId)
            .maybeSingle();
          if (legacyLookup.error) {
            console.warn("[Webhook Warning] Existing Tibo state lookup failed", {
              reason: "lookup_failed",
            });
            return NextResponse.json(
              { error: "Tibo state lookup unavailable" },
              { status: 503 },
            );
          }
          existingSignal = legacyLookup.data as Partial<FormalTiboResetSignal> | null;
        } else {
          console.warn("[Webhook Warning] Existing Tibo state lookup failed", {
            reason: "lookup_failed",
          });
          return NextResponse.json(
            { error: "Tibo state lookup unavailable" },
            { status: 503 },
          );
        }
      } else {
        existingSignal = data as Partial<FormalTiboResetSignal> | null;
      }

    } catch {
      console.warn("[Webhook Warning] Existing Tibo state lookup failed", {
        reason: "lookup_failed",
      });
      return NextResponse.json(
        { error: "Tibo state lookup unavailable" },
        { status: 503 },
      );
    }

    const incomingEditIdentity = toTiboEditIdentityFields(editHistoryMetadata);
    const editIdentityMerge = mergeTiboEditIdentity(
      existingSignal,
      incomingEditIdentity,
      tweetId,
    );
    let editIdentityForPayload = editIdentityMerge.identity;
    let editIdentityFlowBlocked = editIdentityMerge.status === "conflict";

    if (editHistoryMetadata.trusted) {
      const reconciliation = await reconcileTiboEditChainMetadata(
        supabase as unknown as TiboEditIdentityStore,
        tweetId,
        incomingEditIdentity,
      );
      if (reconciliation.status === "conflict") {
        editIdentityFlowBlocked = true;
        console.warn("[Tibo Warning] Conflicting edit-chain metadata; incoming identity was not applied", {
          reason: "identity_conflict",
        });
        editIdentityForPayload = getTrustedTiboEditIdentity(existingSignal, tweetId) ??
          (existingSignal?.edit_metadata_source === "x_api"
            ? editIdentityMerge.identity
            : createUntrustedTiboEditIdentity(tweetId));
      } else if (
        reconciliation.status === "reconciled" ||
        reconciliation.status === "unchanged"
      ) {
        editIdentityForPayload = reconciliation.identity;
      } else if (reconciliation.status === "error") {
        editIdentityFlowBlocked = true;
        console.warn("[Tibo Warning] Edit-chain metadata reconciliation unavailable", {
          reason: "identity_lookup_failed",
        });
      }
    }

    const existingTranslationJa = normalizeStoredTranslation(existingSignal?.translated_text_ja);
    const existingTranslationZh = normalizeStoredTranslation(existingSignal?.translated_text_zh);
    let translationResult: Awaited<ReturnType<typeof translateWithGemini>> | null = null;

    if (!existingTranslationJa || !existingTranslationZh) {
      translationResult = await translateWithGemini({
        text: text.trim(),
        tweetCreatedAt: createdDate.toISOString(),
      });
      if (
        translationResult.status !== "success" &&
        translationResult.status !== "skipped" &&
        translationResult.status !== "model_not_configured"
      ) {
        console.warn("[Webhook Warning] Tibo translation unavailable", {
          reason: translationResult.status,
        });
      }
    }

    const payloadWithTranslations = {
      ...payload,
      ...editIdentityForPayload,
      translated_text_ja: translationResult?.textJa ?? existingTranslationJa,
      translated_text_zh: translationResult?.textZh ?? existingTranslationZh,
    };
    let persistedPayload = preserveTiboWebhookState(
      payloadWithTranslations,
      existingSignal,
      receivedAt,
    );

    const initialFormalCandidate = toFormalTiboResetSignal(persistedPayload);
    if (!initialFormalCandidate) {
      return NextResponse.json({ error: "Invalid Tibo classification payload" }, { status: 500 });
    }
    let formalCandidate = initialFormalCandidate;
    let preflightRecoveryLookup: Awaited<ReturnType<typeof findNearestCodexRecoveryObservation>> | null = null;

    // A fresh local quota observation is the only state in which absence of
    // recovery can safely defer an unverified Tibo completion. If the monitor
    // or recovery lookup is unavailable, preserve the existing non-blocking
    // behavior because absence is not evidence there.
    if (isFormalTiboResetSignal(formalCandidate)) {
      const monitorState = await readCodexUsageMonitorState(supabase);
      if (monitorState.error) {
        console.warn("[Tibo Warning] Usage monitor coverage lookup unavailable", {
          reason: "lookup_failed",
        });
      } else {
        const coverage = getUsageMonitorCoverageAtEvent(
          monitorState.state,
          formalCandidate.tweet_created_at,
          new Date(receivedAt),
        );
        if (coverage.state === "fresh") {
          const recoveryLookup = await findNearestCodexRecoveryObservation(
            supabase,
            formalCandidate.tweet_created_at,
            USAGE_TIBO_MATCH_WINDOW_MS,
          );
          preflightRecoveryLookup = recoveryLookup;
          const shouldDefer = shouldDeferFormalTiboReset(
            formalCandidate,
            coverage,
            {
              available: !recoveryLookup.error,
              matched: Boolean(recoveryLookup.observation),
            },
          );
          if (shouldDefer) {
            persistedPayload = {
              ...persistedPayload,
              signal_type: "irrelevant",
              classification_reason: "Usage Monitorがfreshですが、quota recoveryが未確認のため正式resetとして保留しています。",
            };
            formalCandidate = {
              ...formalCandidate,
              signal_type: "irrelevant",
            };
          }
        }
      }
    }

    // 8. Supabase Upsert
    let upsertResult = await supabase
      .from("tibo_signals")
      .upsert(persistedPayload, { onConflict: "tweet_id" });

    if (upsertResult.error && isMissingTiboOptionalColumnError(upsertResult.error)) {
      const {
        translated_text_ja: _translatedTextJa,
        translated_text_zh: _translatedTextZh,
        teaser_strength: _teaserStrength,
        ai_teaser_strength: _aiTeaserStrength,
        ai_teaser_strength_confidence: _aiTeaserStrengthConfidence,
        ai_teaser_strength_evidence_quote: _aiTeaserStrengthEvidenceQuote,
        ai_teaser_strength_reason_ja: _aiTeaserStrengthReasonJa,
        ai_temporal_expression: _aiTemporalExpression,
        ai_temporal_kind: _aiTemporalKind,
        ai_temporal_precision: _aiTemporalPrecision,
        ai_temporal_timezone: _aiTemporalTimezone,
        ai_temporal_confidence: _aiTemporalConfidence,
        temporal_expression: _temporalExpression,
        temporal_kind: _temporalKind,
        temporal_precision: _temporalPrecision,
        temporal_timezone: _temporalTimezone,
        temporal_confidence: _temporalConfidence,
        temporal_resolution_source: _temporalResolutionSource,
        expected_start_at: _expectedStartAt,
        expected_end_at: _expectedEndAt,
        temporal_resolution_status: _temporalResolutionStatus,
        temporal_resolution_version: _temporalResolutionVersion,
        quote_context_text: _quoteContextText,
        quote_tweet_url: _quoteTweetUrl,
        quote_author_handle: _quoteAuthorHandle,
        logical_post_id: _logicalPostId,
        edit_history_tweet_ids: _editHistoryTweetIds,
        edit_version: _editVersion,
        edit_metadata_source: _editMetadataSource,
        secondary_signal: _secondarySignal,
        ...legacyPayload
      } = persistedPayload;
      upsertResult = await supabase
        .from("tibo_signals")
        .upsert(legacyPayload, { onConflict: "tweet_id" });
    }

    if (upsertResult.error) {
      console.error("[Webhook Error] Supabase upsert failed", {
        reason: "database_error",
      });
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    await seedResetDisplayNameCandidateIfEligible(
      supabase,
      formalCandidate,
      editHistoryMetadata,
    );

    const shouldResolveFormalFlow =
      isFormalTiboResetSignal(formalCandidate) ||
      editHistoryMetadata.trusted ||
      existingSignal?.signal_type === "reset_executed";
    let logicalPost: TiboLogicalPost<TiboLogicalPostRow> | null = null;
    let effectiveFormalCandidate: FormalTiboResetSignal | null = null;
    let adoptionResolution: TiboResetEventIdentityResolution | null = null;
    let adoptionClaim: TiboFormalAdoptionClaimResult | null = null;
    let matchedLedger: TiboFormalAdoptionRecord | null = null;
    let formalFlowError: unknown = null;
    let formalFlowRecoveryLookup = preflightRecoveryLookup;
    let formalFlowCluster: Awaited<ReturnType<typeof findFormalTiboResetCluster>> | null = null;
    let formalFlowSourceTweetIds: string[] = [];
    let formalEnrichmentFailed = false;

    if (shouldResolveFormalFlow && !editIdentityFlowBlocked) {
      const incomingRow = toLogicalPostRow(persistedPayload);
      if (!incomingRow) {
        formalFlowError = new Error("Invalid persisted Tibo signal row");
      } else {
        let existingChainRows: TiboLogicalPostRow[] = [];
        const flowIdentity = getTrustedTiboEditIdentity(
          editIdentityForPayload,
          tweetId,
        );
        if (editIdentityForPayload.edit_metadata_source === "x_api" && !flowIdentity) {
          formalFlowError = new Error("Trusted Tibo edit identity is invalid");
        } else if (flowIdentity) {
          try {
            const chainResult = await supabase
              .from("tibo_signals")
              .select("*")
              .in("tweet_id", flowIdentity.edit_history_tweet_ids);
            if (chainResult.error) {
              formalFlowError = chainResult.error;
            } else {
              existingChainRows = (chainResult.data ?? [])
                .map(toLogicalPostRow)
                .filter((row): row is TiboLogicalPostRow => Boolean(row));
            }
          } catch (error) {
            formalFlowError = error;
          }
        }

        if (!formalFlowError) {
          const rawRows = [
            incomingRow,
            ...existingChainRows.filter((row) => row.tweet_id !== incomingRow.tweet_id),
          ];
          const collapsed = collapseTrustedTiboEditChains(rawRows);
          if (collapsed.conflicts.length > 0) {
            console.warn("[Tibo Warning] Logical edit-chain conflict; formal side effects skipped", {
              reason: "identity_conflict",
            });
          } else {
            logicalPost = collapsed.posts.find((post) =>
              post.rawVersions.some((row) => row.tweet_id === incomingRow.tweet_id),
            ) ?? null;
            if (!logicalPost) {
              formalFlowError = new Error("Tibo logical post could not be resolved");
            } else {
              effectiveFormalCandidate = getFormalCandidateForDisplay(logicalPost);
              const hasFormalVersionInPost = hasFormalRawVersion(logicalPost);
              const existingDynamicRows = existingChainRows.filter((row) =>
                row.tweet_id !== incomingRow.tweet_id && row.signal_type === "reset_executed",
              );
              const dynamicEvents = getDynamicHistoryEvidence(existingDynamicRows);

              const existingSameTweet = toLogicalPostRow({
                ...createUntrustedTiboEditIdentity(tweetId),
                ...(existingSignal ?? {}),
                tweet_id: existingSignal?.tweet_id ?? tweetId,
                text: existingSignal?.text ?? "",
                tweet_url: existingSignal?.tweet_url ?? tweetUrl,
                tweet_created_at: existingSignal?.tweet_created_at ?? createdDate.toISOString(),
                signal_type: existingSignal?.signal_type ?? "irrelevant",
                confidence: existingSignal?.confidence ?? null,
                classification_reason: existingSignal?.classification_reason ?? null,
                classification_source: existingSignal?.classification_source ?? null,
                verification_status: existingSignal?.verification_status ?? "auto_unverified",
              });
              if (existingSameTweet?.signal_type === "reset_executed") {
                dynamicEvents.push(...getDynamicHistoryEvidence([existingSameTweet]));
              }

              // Preserve the legacy five-minute suppression only for self
              // identities. Trusted X edit identities use the authoritative
              // chain instead of time or text as identity evidence.
              if (
                !logicalPost.authoritative &&
                effectiveFormalCandidate &&
                isFormalTiboResetSignal(effectiveFormalCandidate)
              ) {
                const createdTime = Date.parse(effectiveFormalCandidate.tweet_created_at);
                if (Number.isFinite(createdTime)) {
                  try {
                    const nearbyResult = await supabase
                      .from("tibo_signals")
                      .select("tweet_id,text,tweet_url,tweet_created_at,signal_type,confidence,verification_status,classification_source,rule_signal_type,ai_signal_type,is_reply")
                      .eq("signal_type", "reset_executed")
                      .neq("tweet_id", tweetId)
                      .gte("tweet_created_at", new Date(createdTime - 5 * 60 * 1000).toISOString())
                      .lte("tweet_created_at", new Date(createdTime + 5 * 60 * 1000).toISOString())
                      .limit(20);
                    if (!nearbyResult.error && hasExistingFormalResetCluster(
                      effectiveFormalCandidate,
                      (nearbyResult.data ?? []) as Array<FormalTiboResetSignal>,
                    )) {
                      dynamicEvents.push({
                        eventKey: `tibo-reset-${tweetId}`,
                        sourceTweetIds: [tweetId],
                        sourceUrl: tweetUrl,
                      });
                    }
                  } catch {
                    console.warn("[Tibo Warning] Legacy formal cluster lookup unavailable", {
                      reason: "lookup_failed",
                    });
                  }
                }
              }

              const flowTweetCreatedAt = effectiveFormalCandidate?.tweet_created_at ??
                logicalPost.effectiveContent?.tweet_created_at ??
                formalCandidate.tweet_created_at;
              if (hasFormalVersionInPost || (
                effectiveFormalCandidate &&
                isFormalTiboResetSignal(effectiveFormalCandidate)
              )) {
                if (!formalFlowRecoveryLookup) {
                  formalFlowRecoveryLookup = await findNearestCodexRecoveryObservation(
                    supabase,
                    flowTweetCreatedAt,
                    USAGE_TIBO_MATCH_WINDOW_MS,
                  );
                }
                if (formalFlowRecoveryLookup.error) {
                  formalFlowError = formalFlowRecoveryLookup.error;
                }
              }

              if (!formalFlowError && (hasFormalVersionInPost || effectiveFormalCandidate)) {
                const [ledgerResult, estimateResult] = await Promise.all([
                  readTiboFormalAdoptions(supabase),
                  readResetExecutionEstimates(supabase),
                ]);
                if (ledgerResult.error) {
                  formalFlowError = ledgerResult.error;
                } else if (estimateResult.error) {
                  formalFlowError = estimateResult.error;
                } else {
                  const evidence = {
                    recoveryObservationId: formalFlowRecoveryLookup?.observation?.id ?? null,
                    adoptionLedgers: ledgerResult.ledgers,
                    estimates: estimateResult.rows.map((estimate) => ({
                      resetEventKey: estimate.resetEventKey,
                      recoveryObservationId: estimate.recoveryObservationId ?? null,
                      tiboSourceTweetIds: estimate.tiboSourceTweetIds,
                    })),
                    staticHistory: getStaticHistoryEvidence(),
                    dynamicEvents,
                    sourceTweetIds: logicalPost.sourceTweetIds,
                  };
                  adoptionResolution = resolveTiboResetEventIdentity(logicalPost, evidence);
                  matchedLedger = adoptionResolution.resetEventKey
                    ? ledgerResult.ledgers.find((ledger) =>
                      ledger.resetEventKey === adoptionResolution!.resetEventKey,
                    ) ?? null
                    : null;

                  const effectiveIsFormal = Boolean(
                    effectiveFormalCandidate &&
                    isFormalTiboResetSignal(effectiveFormalCandidate),
                  );
                  const resolvedResetEventKey = adoptionResolution.resetEventKey;
                  const shouldReconcileExisting = adoptionResolution.status === "existing" &&
                    adoptionResolution.matchedEvidence !== null &&
                    hasFormalVersionInPost &&
                    logicalPost.manualState.kind !== "conflict";
                  const shouldClaim = !editIdentityMerge.status.includes("conflict") &&
                    resolvedResetEventKey !== null &&
                    (
                      (adoptionResolution.status === "new" && effectiveIsFormal) ||
                      shouldReconcileExisting
                    );

                  if (shouldClaim && resolvedResetEventKey) {
                    const matchedEstimate = estimateResult.rows.find((estimate) =>
                      estimate.resetEventKey === resolvedResetEventKey,
                    );
                    const matchedStaticHistory = getStaticHistoryEvidence().filter((item) =>
                      item.eventKey === resolvedResetEventKey,
                    );
                    const matchedDynamicEvents = dynamicEvents.filter((item) =>
                      item.eventKey === resolvedResetEventKey,
                    );
                    formalFlowSourceTweetIds = Array.from(new Set([
                      ...adoptionResolution.sourceTweetIds,
                      ...(matchedLedger?.sourceTweetIds ?? []),
                      ...(matchedEstimate?.tiboSourceTweetIds ?? []),
                      ...matchedStaticHistory.flatMap((item) => item.sourceTweetIds),
                      ...matchedDynamicEvents.flatMap((item) => item.sourceTweetIds ?? []),
                    ]));
                    const resolvedClassification = logicalPost.effectiveClassification.status === "resolved"
                      ? logicalPost.effectiveClassification
                      : null;
                    const representativeTweetId = matchedLedger?.representativeTweetId ??
                      matchedEstimate?.tiboPrimaryTweetId ??
                      matchedStaticHistory.flatMap((item) => item.sourceTweetIds)[0] ??
                      matchedDynamicEvents.flatMap((item) => item.sourceTweetIds ?? [])[0] ??
                      resolvedClassification?.representativeTweetId ??
                      logicalPost.effectiveContent?.tweet_id ??
                      tweetId;
                    adoptionClaim = await claimTiboFormalAdoption(supabase, {
                      logicalPostId: adoptionResolution.logicalPostId,
                      logicalPostTweetIds: adoptionResolution.logicalPostTweetIds,
                      resetEventKey: resolvedResetEventKey,
                      representativeTweetId,
                      sourceTweetIds: formalFlowSourceTweetIds,
                      claimSource: getClaimSource(adoptionResolution, matchedLedger),
                      identitySource: adoptionResolution.authoritative ? "x_api" : "none",
                      adoptedAt: getClaimSource(adoptionResolution, matchedLedger) === "new_adoption"
                        ? receivedAt
                        : null,
                      claimedAt: receivedAt,
                    });
                    if (adoptionClaim.status === "error") {
                      formalFlowError = adoptionClaim.error ?? new Error("Formal adoption claim failed");
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    const formalCandidateForResponse = effectiveFormalCandidate ?? formalCandidate;
    const canEnrichFormalEvent = Boolean(
      adoptionClaim &&
      FORMAL_FLOW_STATUSES.has(adoptionClaim.status) &&
      adoptionResolution?.canRunFormalEnrichments &&
      effectiveFormalCandidate &&
      isFormalTiboResetSignal(effectiveFormalCandidate),
    );

    if (canEnrichFormalEvent && effectiveFormalCandidate && adoptionResolution?.resetEventKey) {
      try {
        const recoveryMatch = await confirmNearestCodexRecoveryObservation(
          supabase,
          effectiveFormalCandidate.tweet_id,
          effectiveFormalCandidate.tweet_created_at,
          USAGE_TIBO_MATCH_WINDOW_MS,
          receivedAt,
          logicalPost?.sourceTweetIds ?? [effectiveFormalCandidate.tweet_id],
        );
        if (recoveryMatch.error) {
          formalEnrichmentFailed = true;
          console.warn("[Tibo Warning] Codex recovery reconciliation unavailable", {
            reason: "lookup_failed",
          });
        } else if (recoveryMatch.observation) {
          formalFlowCluster = await findFormalTiboResetCluster(
            supabase,
            effectiveFormalCandidate.tweet_id,
            effectiveFormalCandidate.tweet_created_at,
            undefined,
            {
              tweet_id: effectiveFormalCandidate.tweet_id,
              tweet_created_at: effectiveFormalCandidate.tweet_created_at,
              confidence: effectiveFormalCandidate.confidence ?? 0,
            },
          );
          if (formalFlowCluster.error) {
            formalEnrichmentFailed = true;
          } else {
            const enrichedSourceTweetIds = Array.from(new Set([
              ...formalFlowSourceTweetIds,
              ...formalFlowCluster.sourceTweetIds,
            ]));
            if (
              enrichedSourceTweetIds.length !== formalFlowSourceTweetIds.length &&
              adoptionClaim?.record &&
              adoptionResolution.resetEventKey
            ) {
              const provenanceClaim = await claimTiboFormalAdoption(supabase, {
                logicalPostId: adoptionResolution.logicalPostId,
                logicalPostTweetIds: adoptionResolution.logicalPostTweetIds,
                resetEventKey: adoptionResolution.resetEventKey,
                representativeTweetId: adoptionClaim.record.representativeTweetId,
                sourceTweetIds: enrichedSourceTweetIds,
                claimSource: adoptionClaim.record.claimSource,
                identitySource: adoptionResolution.authoritative ? "x_api" : "none",
                adoptedAt: null,
                claimedAt: receivedAt,
              });
              if (provenanceClaim.status === "error" || provenanceClaim.status === "conflict") {
                formalEnrichmentFailed = true;
                console.warn("[Tibo Warning] Formal adoption provenance reconciliation unavailable", {
                  reason: provenanceClaim.status,
                });
              } else {
                formalFlowSourceTweetIds = enrichedSourceTweetIds;
              }
            }

            if (!formalEnrichmentFailed) {
              const isExecutionAnnouncement = isCurrentUsageResetAnnouncement(effectiveFormalCandidate.text);
              const estimateResult = await upsertResetExecutionEstimate(supabase, {
                resetEventKey: adoptionResolution.resetEventKey,
                tiboAnnouncedAt: isExecutionAnnouncement
                  ? effectiveFormalCandidate.tweet_created_at
                  : formalFlowCluster.announcedAt ?? effectiveFormalCandidate.tweet_created_at,
                tiboPrimaryTweetId: effectiveFormalCandidate.tweet_id,
                tiboSourceTweetIds: enrichedSourceTweetIds,
                usageObservation: recoveryMatch.observation,
                officialNoticeTweetId: isExecutionAnnouncement
                  ? effectiveFormalCandidate.tweet_id
                  : formalFlowCluster.representativeNoticeId,
                officialNoticeAt: isExecutionAnnouncement
                  ? effectiveFormalCandidate.tweet_created_at
                  : formalFlowCluster.representativeNoticeAt,
              });
              if (estimateResult.error) {
                formalEnrichmentFailed = true;
                console.warn("[Tibo Warning] Reset execution estimate write failed", {
                  reason: "database_error",
                });
              }
            }
          }
        }

        if (!formalEnrichmentFailed) {
          try {
            const displayNameSourceTweetIds = Array.from(new Set([
              ...formalFlowSourceTweetIds,
              ...logicalPost?.sourceTweetIds ?? [],
              ...(formalFlowCluster?.sourceTweetIds ?? []),
            ]));
            const canonicalSourceRows = await fetchCanonicalTiboSourceRows(
              supabase,
              displayNameSourceTweetIds,
            );
            const sourcePostText = buildResetDisplayNameSourceContext({
              effectiveFormalCandidate,
              sourceTweetIds: displayNameSourceTweetIds,
              sourceRows: canonicalSourceRows,
            });
            const displayNameItem = {
              ...convertTiboResetSignalToHistoryEvent(effectiveFormalCandidate),
              id: adoptionResolution.resetEventKey,
              source_url: effectiveFormalCandidate.tweet_url,
              sourceTweetIds: displayNameSourceTweetIds,
            };
            const displayNameResult = await ensureResetDisplayNameForEvent(
              displayNameItem,
              {
                canonicalEventKey: adoptionResolution.resetEventKey,
                sourcePostText,
                sourceTweetId: effectiveFormalCandidate.tweet_id,
                apiKey: process.env.GEMINI_API_KEY?.trim() || null,
                model: RANDOM_RESET_NAME_MODEL,
                timeoutMs: 8_000,
              },
            );
            // Display-name generation remains best-effort. The raw signal and
            // formal ledger are already durable, so a naming-model failure must
            // not turn an otherwise successful webhook into a retry storm.
            if (displayNameResult.status === "api_error") {
              console.warn("[Webhook Warning] Reset display-name generation skipped", {
                reason: "best_effort_failed",
              });
            }
          } catch {
            console.warn("[Webhook Warning] Reset display-name generation skipped", {
              reason: "best_effort_failed",
            });
          }
        }
      } catch {
        formalEnrichmentFailed = true;
        console.warn("[Tibo Warning] Codex recovery reconciliation unavailable", {
          reason: "request_failed",
        });
      }
    }

    if (formalFlowError) {
      console.warn("[Tibo Warning] Formal adoption flow unavailable after raw save", {
        reason: "retryable_database_error",
      });
      return NextResponse.json(
        { error: "Formal adoption flow unavailable" },
        { status: 503 },
      );
    }

    if (formalEnrichmentFailed) {
      console.warn("[Tibo Warning] Formal adoption enrichment unavailable after ledger claim", {
        reason: "retryable_enrichment_error",
      });
      return NextResponse.json(
        { error: "Formal adoption enrichment unavailable" },
        { status: 503 },
      );
    }

    const newlyAdopted = adoptionClaim?.status === "claimed_new";
    const formalAdoption = buildFormalAdoptionResult(newlyAdopted, formalCandidateForResponse);

    if (newlyAdopted) {
      console.info("[Tibo Formal Adoption]", {
        tweetId: formalCandidateForResponse.tweet_id,
        signalType: formalCandidateForResponse.signal_type,
        confidence: formalCandidateForResponse.confidence,
        sourceUrl: formalCandidateForResponse.tweet_url,
        adoptedAt: new Date().toISOString(),
      });
    }

    // 9. Purge Next.js Cache
    try {
      revalidateTag("radar-data");
    } catch (e) {
      console.warn("[Webhook Warning] Cache revalidation skipped:", e);
    }

    return NextResponse.json({
      success: true,
      ...classificationResponse,
      formalAdoption,
    });
  } catch {
    console.error("[Webhook Error] Request processing failed.");
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
