import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import {
  CODEX_USAGE_SOURCE_KEY,
  USAGE_TIBO_MATCH_WINDOW_MS,
  canCorroborateTiboReset,
  evaluateCodexUsageRecovery,
  isCodexUsageAuthorizationValid,
  isBankedResetAvailableCountGrant,
  parseCodexUsageWebhookPayload,
  shouldCreateNoticeBackedEstimate,
  type CodexUsageSnapshot,
} from "@/lib/codexUsageRecovery";
import {
  findFormalTiboResetCluster,
  findLatestBankedGrant,
  findRecentFormalTiboReset,
  readCodexUsageMonitorState,
} from "@/lib/codexUsageRecoveryStore";
import {
  applyCodexUsageAtomicWrite,
  buildCodexUsageAtomicWritePlan,
  buildResetExecutionEstimateWrite,
} from "@/lib/codexUsageAtomic";
import {
  getActiveOfficialNotice,
  type ActiveOfficialNotice,
} from "@/lib/radar/probability";
import {
  getTemporalExecutionWindowRelation,
  type ResetExecutionWindow,
} from "@/lib/radar/tiboTemporal";
import { buildResetExecutionEstimate } from "@/lib/radar/resetExecution";
import {
  collectBankedDistributionSignals,
  collectOfficialTiboNoticeSignals,
  findRelatedBankedDistributionNotices,
  findRelatedTiboNoticeCluster,
  selectRepresentativeTiboNotice,
  NOTICE_LOOKBACK_MS,
  type BankedDistributionSignal,
  type TiboNoticeSignal,
} from "@/lib/radar/tiboHistory";
import {
  getBankedDistributionEventKey,
  isBankedObservationWithinNoticeWindow,
  isBroadBankedDistributionNotice,
} from "@/lib/radar/bankedReset";
import { PERSISTENT_OFFICIAL_NOTICE_IDS } from "@/lib/radar/officialNoticePolicy";
import type { ActiveTiboSignal, RadarData } from "@/lib/radar/types";

const NOTICE_COLUMNS = "tweet_id,text,tweet_url,tweet_created_at,expires_at,signal_type,confidence,verification_status,is_reply,ai_temporal_expression,ai_temporal_kind,ai_temporal_direction,ai_temporal_precision,ai_temporal_timezone,ai_temporal_confidence,temporal_expression,temporal_kind,temporal_precision,temporal_timezone,temporal_confidence,temporal_resolution_source,expected_start_at,expected_end_at,temporal_resolution_status,logical_post_id,edit_history_tweet_ids,edit_version,edit_metadata_source";
const REGULAR_COLUMNS = "schedule_key,window_start_at,window_end_at,representative_at,scheduled_at,completed_at,cycle_type,reset_method,scope,record_kind,status,correction_reason,corrected_at";

function getSupabaseServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function toTiboNoticeSignal(notice: ActiveOfficialNotice): TiboNoticeSignal {
  return {
    tweet_id: notice.id,
    text: notice.text ?? notice.title ?? "",
    tweet_url: notice.source ?? "",
    tweet_created_at: notice.observedAt,
    signal_type: "official_notice",
    confidence: 1,
    verification_status: "auto_unverified",
    expected_start_at: notice.expectedAt,
    expected_end_at: notice.expectedEndAt,
    ai_temporal_precision: notice.temporalPrecision ?? null,
    ai_temporal_timezone: notice.temporalTimezone ?? null,
    temporal_precision: notice.temporalPrecision ?? null,
    temporal_timezone: notice.temporalTimezone ?? null,
    temporal_resolution_status: notice.temporalResolutionStatus ?? null,
  };
}

function toTiboSignal(signal: ActiveTiboSignal): TiboNoticeSignal {
  return {
    tweet_id: signal.tweet_id,
    text: signal.text ?? "",
    tweet_url: signal.tweet_url ?? "",
    tweet_created_at: signal.tweet_created_at,
    signal_type: signal.signal_type === "teaser" ? "teaser" : "official_notice",
    confidence: signal.confidence ?? null,
    verification_status: signal.verification_status ?? "auto_unverified",
    expires_at: signal.expires_at ?? null,
    is_reply: signal.is_reply ?? null,
    logical_post_id: signal.logical_post_id ?? null,
    edit_history_tweet_ids: signal.edit_history_tweet_ids ?? null,
    edit_version: signal.edit_version ?? null,
    edit_metadata_source: signal.edit_metadata_source ?? null,
  };
}

function findRecentTiboTeaser(
  signals: ActiveTiboSignal[],
  observedAt: Date,
  executionWindow: ResetExecutionWindow | null = null,
) {
  const observedTime = observedAt.getTime();
  return signals
    .filter((signal) => {
      if (signal.signal_type !== "teaser" || signal.is_reply === true || signal.verification_status === "rejected") {
        return false;
      }
      if ((signal.confidence ?? 0) < 0.8) return false;
      const createdTime = Date.parse(signal.tweet_created_at);
      if (!Number.isFinite(createdTime) || observedTime < createdTime) {
        return false;
      }
      const temporalRelation = getTemporalExecutionWindowRelation(
        signal.temporal_resolution_status === "resolved"
          ? {
              status: signal.temporal_resolution_status,
              expectedStartAt: signal.expected_start_at ?? null,
              expectedEndAt: signal.expected_end_at ?? null,
            }
          : null,
        executionWindow,
      );
      if (temporalRelation === "before" || temporalRelation === "after") return false;
      if (temporalRelation === "unknown" && observedTime - createdTime > USAGE_TIBO_MATCH_WINDOW_MS) {
        return false;
      }
      return !signal.expires_at || Date.parse(signal.expires_at) > observedTime;
    })
    .sort((left, right) => {
      const leftDistance = Math.abs(observedTime - Date.parse(left.tweet_created_at));
      const rightDistance = Math.abs(observedTime - Date.parse(right.tweet_created_at));
      return leftDistance - rightDistance;
    })[0] ?? null;
}

type OfficialNoticeLookup = {
  active: boolean;
  noticeSignal: ActiveOfficialNotice | null;
  bankedNoticeSignal: ActiveOfficialNotice | null;
  noticeSignals: TiboNoticeSignal[];
  teaserSignal: ActiveTiboSignal | null;
  bankedNoticeSignals: BankedDistributionSignal[];
  error: unknown;
};

async function hasActiveOfficialNotice(
  client: SupabaseClient<any>,
  observedAt: Date,
  executionWindow: ResetExecutionWindow | null = null,
  includeTerminatedExecutionEvidence = false,
): Promise<OfficialNoticeLookup> {
  const observedAtIso = observedAt.toISOString();
  const noticeLookbackStartIso = new Date(
    observedAt.getTime() - NOTICE_LOOKBACK_MS,
  ).toISOString();
  const persistentTiboResultPromise = PERSISTENT_OFFICIAL_NOTICE_IDS.length > 0
    ? client
      .from("tibo_signals")
      .select(NOTICE_COLUMNS)
      .in("tweet_id", [...PERSISTENT_OFFICIAL_NOTICE_IDS])
      .in("signal_type", ["official_notice", "reset_executed", "teaser", "irrelevant"])
      .or("is_reply.is.null,is_reply.eq.false")
      .neq("verification_status", "rejected")
      .lte("tweet_created_at", observedAtIso)
      .order("tweet_created_at", { ascending: false })
      .order("tweet_id", { ascending: false })
      .limit(1000)
    : Promise.resolve({ data: [], error: null });
  const [tiboResult, persistentTiboResult, regularResult] = await Promise.all([
    client
      .from("tibo_signals")
      .select(NOTICE_COLUMNS)
      .in("signal_type", ["official_notice", "reset_executed", "teaser", "irrelevant"])
      .or("is_reply.is.null,is_reply.eq.false")
      .neq("verification_status", "rejected")
      .lte("tweet_created_at", observedAtIso)
      .or(`tweet_created_at.gte.${noticeLookbackStartIso},expires_at.gt.${observedAtIso}`)
      .order("tweet_created_at", { ascending: false })
      .order("tweet_id", { ascending: false })
      .limit(1000),
    persistentTiboResultPromise,
    client
      .from("regular_reset_events")
      .select(REGULAR_COLUMNS)
      .eq("cycle_type", "定期リセット")
      .eq("record_kind", "regular_completed")
      .in("status", ["completed", "corrected"])
      .lte("completed_at", observedAtIso)
      .order("completed_at", { ascending: false })
      .limit(1),
  ]);

  if (tiboResult.error || persistentTiboResult.error || regularResult.error) {
    return {
      active: false,
      noticeSignal: null,
      bankedNoticeSignal: null,
      noticeSignals: [],
      teaserSignal: null,
      bankedNoticeSignals: [],
      error: tiboResult.error ?? persistentTiboResult.error ?? regularResult.error,
    };
  }

  const signals = Array.from(new Map(
    [
      ...((tiboResult.data ?? []) as unknown as ActiveTiboSignal[]),
      ...((persistentTiboResult.data ?? []) as unknown as ActiveTiboSignal[]),
    ].map((signal) => [signal.tweet_id, signal] as const),
  ).values());
  const data: RadarData = {
    active_tibo_signals: signals,
    formal_tibo_resets: signals
      .filter((signal) => signal.signal_type === "reset_executed")
      .map((signal) => ({
        ...signal,
        text: signal.text ?? "",
        tweet_url: signal.tweet_url ?? "",
        confidence: signal.confidence ?? null,
        verification_status: signal.verification_status ?? "auto_unverified",
      })),
    regular_reset_events: regularResult.data as RadarData["regular_reset_events"],
  };
  const activeNotice = getActiveOfficialNotice(
    data,
    null,
    observedAt,
    undefined,
    executionWindow,
    true,
    false,
  );
  // A terminated notice may remain evidence for a BANKED grant, but it must
  // not become the active notice that corroborates an ordinary recovery.
  const activeBankedNotice = getActiveOfficialNotice(
    {
      ...data,
      active_tibo_signals: signals.filter((signal) => isBroadBankedDistributionNotice(signal.text)),
    },
    null,
    observedAt,
    undefined,
    executionWindow,
    true,
    includeTerminatedExecutionEvidence,
  );
  const noticeSignals = collectOfficialTiboNoticeSignals(signals, []);
  const teaserSignal = findRecentTiboTeaser(signals, observedAt, executionWindow);
  const bankedSignals = collectBankedDistributionSignals(signals, []);
  const bankedNoticeSignals = findRelatedBankedDistributionNotices(
    bankedSignals,
    activeBankedNotice?.id ?? "",
    observedAt.toISOString(),
  );
  return {
    active: Boolean(activeNotice),
    noticeSignal: activeNotice ?? null,
    bankedNoticeSignal: activeBankedNotice ?? null,
    noticeSignals,
    teaserSignal,
    bankedNoticeSignals,
    error: null,
  };
}

function getCorroboratedBankedDistribution(
  snapshot: CodexUsageSnapshot,
  lookup: OfficialNoticeLookup | null,
  effectiveBankedResetCountChange: boolean,
  previousBankedGrantAt: string | null = null,
  previousBankedGrantEventKey: string | null = null,
) {
  const notice = lookup?.bankedNoticeSignal;
  const relatedNotices = lookup?.bankedNoticeSignals?.length
    ? lookup.bankedNoticeSignals
    : notice
      ? [toTiboNoticeSignal(notice)]
      : [];
  const officialNotices = relatedNotices.filter(
    (signal): signal is TiboNoticeSignal => signal.signal_type === "official_notice",
  );
  const representativeNotice = selectRepresentativeTiboNotice(officialNotices) ??
    (notice ? toTiboNoticeSignal(notice) : null);
  const firstAnnouncement = officialNotices[0] ?? representativeNotice;
  const isPersistentNotice = notice?.consumption === "persistent";
  const eventNoticeTweetId = firstAnnouncement?.tweet_id ?? notice?.id ?? null;
  if (
    effectiveBankedResetCountChange !== true ||
    typeof snapshot.bankedResetAvailableCount !== "number" ||
    snapshot.bankedResetAvailableCount < 1 ||
    !notice?.isBankedDistribution ||
    !isBroadBankedDistributionNotice(notice.text) ||
    (!isPersistentNotice && !isBankedObservationWithinNoticeWindow(notice, snapshot.observedAt))
  ) {
    return { observed: false, input: null };
  }

  const eventKey = getBankedDistributionEventKey({
    noticeTweetId: eventNoticeTweetId ?? notice.id,
    observedAt: snapshot.observedAt,
    persistent: isPersistentNotice,
    previousGrantAt: previousBankedGrantAt,
    previousEventKey: previousBankedGrantEventKey,
  });
  const isSubsequentPersistentObservation = isPersistentNotice &&
    eventKey !== `banked-reset-${eventNoticeTweetId ?? notice.id}`;

  return {
    observed: true,
    input: {
      resetEventKey: eventKey,
      displayExecutionAt: snapshot.observedAt,
      tiboAnnouncedAt: firstAnnouncement?.tweet_created_at ?? notice.observedAt,
      tiboPrimaryTweetId: representativeNotice?.tweet_id ?? notice.id,
      // Later persistent observations retain the official notice separately;
      // omitting it here prevents the legacy source-overlap lookup from
      // collapsing a new observation into the first estimate.
      tiboSourceTweetIds: isSubsequentPersistentObservation
        ? []
        : relatedNotices.map((item) => item.tweet_id),
      officialNoticeTweetId: representativeNotice?.tweet_id ?? notice.id,
      officialNoticeAt: representativeNotice?.tweet_created_at ?? notice.observedAt,
    },
  };
}

function recoveryResponse(status: string) {
  return NextResponse.json({ accepted: true, recovery: status });
}

type MatchingTiboResult = {
  tweetId: string | null;
  tweetCreatedAt: string | null;
  needsPromotion: boolean;
  confidence: number | null;
  error: unknown;
};

function createRecoveryObservation(
  decision: Extract<ReturnType<typeof evaluateCodexUsageRecovery>, { kind: "recovery" }>,
  matchingTibo: MatchingTiboResult,
  now: Date,
) {
  const confirmedAt = matchingTibo.tweetId ? now.toISOString() : null;
  return {
    sourceKey: CODEX_USAGE_SOURCE_KEY,
    observedAt: decision.current.observedAt,
    previousObservedAt: decision.previous.observedAt,
    previousUsedPercent: decision.previous.usedPercent,
    currentUsedPercent: decision.current.usedPercent,
    previousResetsAt: decision.previous.resetsAt,
    currentResetsAt: decision.current.resetsAt,
    cycleHint: decision.cycleHint,
    confidence: decision.confidence,
    // A personal BANKED consumption remains an audit observation, but it is
    // explicitly rejected as a public/global recovery candidate.
    status: decision.isPersonalReset
      ? "rejected" as const
      : matchingTibo.tweetId
        ? "confirmed" as const
        : "observed" as const,
    matchedTiboTweetId: matchingTibo.tweetId,
    confirmedAt,
  };
}

async function applyAtomicPlanOrRetry(
  client: SupabaseClient<any>,
  plan: ReturnType<typeof buildCodexUsageAtomicWritePlan>,
  snapshot: CodexUsageSnapshot,
  now: Date,
  retryCount: number,
): Promise<NextResponse | null> {
  const result = await applyCodexUsageAtomicWrite(client, plan);
  if (result.error) {
    console.warn("[Codex usage] atomic write failed", { reason: "database_error" });
    return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
  }
  if (result.result?.status === "stale") {
    if (result.result.retryRequired && retryCount === 0) {
      return processCodexUsageSnapshot(client, snapshot, now, retryCount + 1);
    }
    return recoveryResponse("ignored_stale");
  }
  return null;
}

async function processCodexUsageSnapshot(
  client: SupabaseClient<any>,
  snapshot: CodexUsageSnapshot,
  now: Date,
  retryCount = 0,
): Promise<NextResponse> {
  const previousResult = await readCodexUsageMonitorState(client);
  if (previousResult.error) {
    console.warn("[Codex usage] state lookup failed", { reason: "database_error" });
    return NextResponse.json({ error: "Usage monitor state unavailable" }, { status: 503 });
  }

  const previousBankedResetAvailableCount =
    previousResult.row?.bankedResetAvailableCount ??
    previousResult.state?.bankedResetAvailableCount;
  const serverObservedBankedIncrease = isBankedResetAvailableCountGrant(
    previousBankedResetAvailableCount,
    snapshot.bankedResetAvailableCount,
  );
  const effectiveBankedResetCountChange =
    snapshot.bankedResetCountChange === true || serverObservedBankedIncrease;
  const bankedNotice = effectiveBankedResetCountChange
    ? await hasActiveOfficialNotice(client, new Date(snapshot.observedAt), null, true)
    : null;
  if (bankedNotice?.error) {
    console.warn("[Codex usage] BANKED notice lookup failed", { reason: "database_error" });
    return NextResponse.json({ error: "Usage monitor corroboration unavailable" }, { status: 503 });
  }

  const latestBankedGrant = previousResult.row && typeof previousResult.row.bankedResetAvailableCount === "number"
    ? await findLatestBankedGrant(
        client,
        snapshot.observedAt,
        bankedNotice?.bankedNoticeSignal?.consumption === "persistent"
          ? bankedNotice.bankedNoticeSignal.id
          : null,
      )
    : null;
  const lastBankedGrantAt =
    previousResult.row?.lastBankedGrantAt ??
    previousResult.state?.lastBankedGrantAt ??
    latestBankedGrant?.observedAt ??
    null;
  const lastBankedGrantEventKey = bankedNotice?.bankedNoticeSignal?.consumption === "persistent"
    ? latestBankedGrant?.resetEventKey ?? null
    : null;

  const initialDecision = evaluateCodexUsageRecovery(previousResult.row, snapshot, {
    lastBankedGrantAt,
  });
  if (initialDecision.kind === "stale") return recoveryResponse("ignored_stale");

  const isAuthorizedRecovery =
    snapshot.monitorProtocolVersion === 2
      ? snapshot.postReason === "recovery_candidate"
      : true;

  if (
    !isAuthorizedRecovery ||
    initialDecision.kind === "baseline" ||
    initialDecision.kind === "rebase" ||
    initialDecision.kind === "invalid" ||
    initialDecision.kind === "no_recovery"
  ) {
    const bankedResult = getCorroboratedBankedDistribution(
      snapshot,
      bankedNotice,
      effectiveBankedResetCountChange,
      lastBankedGrantAt,
      lastBankedGrantEventKey,
    );
    const plan = buildCodexUsageAtomicWritePlan({
      expectedPreviousObservedAt: previousResult.state?.observedAt ?? null,
      snapshot,
      receivedAt: now.toISOString(),
      previousState: previousResult.state,
      bankedDistribution: bankedResult.input,
    });
    const atomicResponse = await applyAtomicPlanOrRetry(client, plan, snapshot, now, retryCount);
    if (atomicResponse) return atomicResponse;
    console.info("[Codex usage] snapshot accepted", {
      source: CODEX_USAGE_SOURCE_KEY,
      recovery: isAuthorizedRecovery ? initialDecision.kind : `unauthorized_${snapshot.postReason}`,
      bankedDistributionObserved: bankedResult.observed,
    });
    if (bankedResult.observed) {
      try {
        revalidateTag("radar-data");
      } catch {
        console.warn("[Codex usage] cache revalidation skipped", { reason: "runtime_context" });
      }
    }
    const nonRecoveryStatus = bankedResult.observed
      ? "banked_distribution_observed"
      : initialDecision.kind === "recovery"
        ? (snapshot.postReason ?? "no_recovery")
        : (snapshot.postReason === "structure_change" ? "structure_change" : initialDecision.kind);
    return recoveryResponse(nonRecoveryStatus);
  }

  const recoveryExecutionWindow: ResetExecutionWindow = {
    executionWindowStartAt: initialDecision.previous.observedAt,
    executionWindowEndAt: snapshot.observedAt,
  };
  const recoveryNotice = await hasActiveOfficialNotice(
    client,
    new Date(snapshot.observedAt),
    recoveryExecutionWindow,
    true,
  );
  if (recoveryNotice.error) {
    console.warn("[Codex usage] official notice lookup failed", { reason: "database_error" });
    return NextResponse.json({ error: "Usage monitor corroboration unavailable" }, { status: 503 });
  }

  const decision = evaluateCodexUsageRecovery(previousResult.row, snapshot, {
    activeOfficialNotice: recoveryNotice.active,
    activeResetEvidence: recoveryNotice.active || Boolean(recoveryNotice.teaserSignal),
    lastBankedGrantAt,
  });
  if (decision.kind !== "recovery") {
    const plan = buildCodexUsageAtomicWritePlan({
      expectedPreviousObservedAt: previousResult.state?.observedAt ?? null,
      snapshot,
      receivedAt: now.toISOString(),
      previousState: previousResult.state,
    });
    const atomicResponse = await applyAtomicPlanOrRetry(client, plan, snapshot, now, retryCount);
    if (atomicResponse) return atomicResponse;
    return recoveryResponse(decision.kind);
  }

  // A recovery near the regular schedule is not Tibo evidence. This also
  // covers the `unknown` near-regular case where an official notice exists:
  // a notice must not turn a regular quota recovery into a Tibo confirmation.
  const matchingTibo: MatchingTiboResult = !canCorroborateTiboReset(decision)
    ? { tweetId: null, tweetCreatedAt: null, needsPromotion: false, confidence: null, error: null }
    : await findRecentFormalTiboReset(
        client,
        snapshot.observedAt,
        USAGE_TIBO_MATCH_WINDOW_MS,
      );
  if (matchingTibo.error) {
    console.warn("[Codex usage] Tibo match lookup failed", { reason: "database_error" });
    return NextResponse.json({ error: "Usage monitor corroboration unavailable" }, { status: 503 });
  }

  const observation = createRecoveryObservation(decision, matchingTibo, now);
  if (decision.isPersonalReset === true) {
    const plan = buildCodexUsageAtomicWritePlan({
      expectedPreviousObservedAt: previousResult.state?.observedAt ?? null,
      snapshot,
      receivedAt: now.toISOString(),
      previousState: previousResult.state,
      observation,
    });
    const atomicResponse = await applyAtomicPlanOrRetry(client, plan, snapshot, now, retryCount);
    if (atomicResponse) return atomicResponse;
    console.info("[Codex usage] personal reset observed and suppressed from public history", {
      source: CODEX_USAGE_SOURCE_KEY,
    });
    return recoveryResponse("personal_reset");
  }

  const noticeSignal = recoveryNotice.noticeSignal;
  const teaserSignal = recoveryNotice.teaserSignal;
  let teaserEstimateObserved = false;
  let estimateObserved = false;
  let executionEstimate = null;

  if (matchingTibo.tweetId && matchingTibo.tweetCreatedAt) {
    try {
      const cluster = await findFormalTiboResetCluster(
        client,
        matchingTibo.tweetId,
        matchingTibo.tweetCreatedAt,
        undefined,
        matchingTibo.needsPromotion
          ? {
              tweet_id: matchingTibo.tweetId,
              tweet_created_at: matchingTibo.tweetCreatedAt,
              confidence: matchingTibo.confidence ?? 0.95,
            }
          : undefined,
      );
      if (cluster.error) {
        console.warn("[Codex usage] reset execution estimate lookup failed", { reason: "database_error" });
        return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
      }
      const estimate = buildResetExecutionEstimate({
        resetEventKey: `tibo-reset-${cluster.primaryTweetId}`,
        tiboAnnouncedAt: cluster.announcedAt,
        tiboPrimaryTweetId: cluster.representativeTweetId,
        tiboSourceTweetIds: cluster.sourceTweetIds,
        usageObservation: observation,
        officialNoticeTweetId: cluster.representativeNoticeId,
        officialNoticeAt: cluster.representativeNoticeAt,
      });
      if (!estimate) return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
      executionEstimate = buildResetExecutionEstimateWrite(estimate);
      estimateObserved = true;
    } catch {
      console.warn("[Codex usage] reset execution estimate failed", { reason: "request_failed" });
      return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
    }
  } else if (shouldCreateNoticeBackedEstimate(noticeSignal, decision, observation)) {
    try {
      const noticeSignals = recoveryNotice.noticeSignals.length > 0
        ? recoveryNotice.noticeSignals
        : [toTiboNoticeSignal(noticeSignal)];
      const relatedNoticeSignals = findRelatedTiboNoticeCluster(
        noticeSignals,
        noticeSignal.id,
        snapshot.observedAt,
      );
      const normalizedRelatedNoticeSignals = relatedNoticeSignals.length > 0
        ? relatedNoticeSignals
        : [toTiboNoticeSignal(noticeSignal)];
      const representativeNotice = selectRepresentativeTiboNotice(normalizedRelatedNoticeSignals)!;
      const firstAnnouncement = normalizedRelatedNoticeSignals[0] ?? representativeNotice;
      const estimate = buildResetExecutionEstimate({
        resetEventKey: `tibo-reset-${firstAnnouncement.tweet_id}`,
        tiboAnnouncedAt: firstAnnouncement.tweet_created_at,
        tiboPrimaryTweetId: representativeNotice.tweet_id,
        tiboSourceTweetIds: normalizedRelatedNoticeSignals.map((relatedNotice) => relatedNotice.tweet_id),
        usageObservation: observation,
        officialNoticeTweetId: representativeNotice.tweet_id,
        officialNoticeAt: representativeNotice.tweet_created_at,
      });
      if (!estimate) return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
      executionEstimate = buildResetExecutionEstimateWrite(estimate);
      estimateObserved = true;
    } catch {
      console.warn("[Codex usage] notice-backed reset execution estimate failed", { reason: "request_failed" });
      return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
    }
  } else if (
    teaserSignal &&
    decision.confidence === "strong" &&
    decision.cycleHint === "unexpected"
  ) {
    try {
      const teaser = toTiboSignal(teaserSignal);
      const estimate = buildResetExecutionEstimate({
        resetEventKey: `tibo-reset-${teaser.tweet_id}`,
        tiboAnnouncedAt: teaser.tweet_created_at,
        tiboPrimaryTweetId: teaser.tweet_id,
        tiboSourceTweetIds: [teaser.tweet_id],
        usageObservation: observation,
        corroboratingTiboTweetId: teaser.tweet_id,
      });
      if (!estimate) return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
      executionEstimate = buildResetExecutionEstimateWrite(estimate);
      teaserEstimateObserved = true;
      estimateObserved = true;
    } catch {
      console.warn("[Codex usage] teaser-backed reset execution estimate failed", { reason: "request_failed" });
      return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
    }
  } else if (
    decision.confidence === "strong" &&
    decision.cycleHint === "unexpected"
  ) {
    try {
      const estimate = buildResetExecutionEstimate({
        resetEventKey: "usage-reset-pending",
        usageObservation: observation,
        isMonitorObserved: true,
        tiboAnnouncedAt: null,
        tiboPrimaryTweetId: null,
        tiboSourceTweetIds: [],
      });
      if (!estimate) return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
      executionEstimate = buildResetExecutionEstimateWrite(estimate, { monitorObserved: true });
      estimateObserved = true;
    } catch {
      console.warn("[Codex usage] monitor standalone reset execution estimate failed", { reason: "request_failed" });
      return NextResponse.json({ error: "Usage monitor storage unavailable" }, { status: 503 });
    }
  }

  const bankedResult = getCorroboratedBankedDistribution(
    snapshot,
    bankedNotice,
    effectiveBankedResetCountChange,
    lastBankedGrantAt,
    lastBankedGrantEventKey,
  );
  const plan = buildCodexUsageAtomicWritePlan({
    expectedPreviousObservedAt: previousResult.state?.observedAt ?? null,
    snapshot,
    receivedAt: now.toISOString(),
    previousState: previousResult.state,
    observation,
    regularReset: decision.nearRegularSchedule
      ? {
          scheduledAt: new Date(decision.previous.resetsAt * 1000).toISOString(),
          completedAt: snapshot.observedAt,
        }
      : undefined,
    executionEstimate,
    bankedDistribution: bankedResult.input,
    promotion: matchingTibo.tweetId && matchingTibo.needsPromotion
      ? {
          tweetId: matchingTibo.tweetId,
          confidence: matchingTibo.confidence ?? 0.95,
        }
      : undefined,
  });
  const atomicResponse = await applyAtomicPlanOrRetry(client, plan, snapshot, now, retryCount);
  if (atomicResponse) return atomicResponse;

  console.info("[Codex usage] recovery observation accepted", {
    cycleHint: decision.cycleHint,
    confidence: decision.confidence,
    matchedTibo: Boolean(matchingTibo.tweetId),
    bankedDistributionObserved: bankedResult.observed,
    estimateObserved,
  });
  try {
    revalidateTag("radar-data");
  } catch {
    console.warn("[Codex usage] cache revalidation skipped", { reason: "runtime_context" });
  }
  return recoveryResponse(
    bankedResult.observed
      ? "banked_distribution_observed"
    : matchingTibo.tweetId
      ? "confirmed"
      : teaserEstimateObserved
        ? "teaser_corroborated"
        : estimateObserved
          ? "confirmed"
          : "observed_unconfirmed",
  );
}

export async function POST(request: Request) {
  const expectedSecret = process.env.CODEX_USAGE_MONITOR_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ error: "Usage monitor is not configured" }, { status: 503 });
  }

  if (!isCodexUsageAuthorizationValid(request.headers.get("authorization"), expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const now = new Date();
  const snapshot = parseCodexUsageWebhookPayload(body, now);
  if (!snapshot) {
    return NextResponse.json({ error: "Invalid usage snapshot" }, { status: 400 });
  }

  const client = getSupabaseServiceClient();
  if (!client) {
    return NextResponse.json({ error: "Usage monitor storage is not configured" }, { status: 503 });
  }

  try {
    return await processCodexUsageSnapshot(client, snapshot, now);
  } catch {
    console.warn("[Codex usage] request failed", { reason: "request_failed" });
    return NextResponse.json({ error: "Usage monitor unavailable" }, { status: 503 });
  }
}
