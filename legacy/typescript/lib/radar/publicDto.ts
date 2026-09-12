import { getRadarViewModel } from "@/lib/radar";
import { createRadarCalculationContext } from "@/lib/radar";
import type { RadarCalculationContext } from "@/lib/radar";
import { translateTiboPostText } from "./i18n";
import { getLastResetBoundaryAt } from "./probability";
import {
  getLastRandomRecoveryResetAt,
  getLastRandomRecoveryResetWindow,
} from "./recoveryBoundary";
import {
  getEffectiveTemporalPrecision,
  getTemporalExecutionWindowRelation,
  isTemporalNoticeConsumedAtReset,
  type ResetExecutionWindow,
} from "./tiboTemporal";
import { getPublicRecoveryObservation } from "../codexUsageRecovery";
import {
  aggregateResetTeaserStatus,
  getEffectiveTeaserStrength,
  getUiResetTeaserSignals,
  isTeaserStrength,
} from "./teaserStrength";
import {
  compareTiboNoticeSpecificity,
  getNoticeBackedRecoveryObservationIds,
  type CanonicalResetHistoryContext,
  type TiboNoticeSignal,
} from "./tiboHistory";
import { isSupersededBankedNotice } from "./bankedReset";
import { expandTiboSignalVariants } from "./tiboSecondarySignal";
import { getTiboReadSideSignals } from "./tiboLogicalProjection";
import { isTiboForecastSignalTerminatedAt } from "./officialNoticePolicy";
import type {
  Locale,
  PublicDataHealth,
  PublicRadarSnapshot,
  PublicRadarViewModel,
  PublicTiboActivity,
  RadarData,
  RadarDataHealth,
} from "./types";

export type PublicRadarSnapshotOptions = {
  stale?: boolean;
  generatedAt?: string;
  limitHistory?: boolean;
  calculationNow?: Date;
  calculationContext?: RadarCalculationContext;
};

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const PUBLIC_TIBO_CLASSIFICATIONS = new Set<PublicTiboActivity["classification"]>([
  "official_notice",
  "reset_executed",
  "teaser",
  "irrelevant",
]);

function normalizePublicPostText(value: string | null | undefined) {
  const normalized = value?.replace(/\r\n?/g, "\n").trim();
  return normalized || null;
}

const PUBLIC_REPLY_CONTEXT_MAX_CHARS = 1000;
const PUBLIC_REPLY_HANDLES_MAX = 20;
const PUBLIC_REPLY_HANDLE_PATTERN = /^@?[A-Za-z0-9_]{1,15}$/;

function normalizePublicReplyContext(value: string | null | undefined) {
  return normalizePublicPostText(value)?.slice(0, PUBLIC_REPLY_CONTEXT_MAX_CHARS) ?? null;
}

function normalizePublicReplyHandles(value: string[] | null | undefined) {
  if (!Array.isArray(value)) return [];

  const handles: string[] = [];
  for (const handle of value) {
    if (typeof handle !== "string" || !PUBLIC_REPLY_HANDLE_PATTERN.test(handle.trim())) continue;
    const normalized = `@${handle.trim().replace(/^@/, "")}`;
    if (!handles.includes(normalized)) handles.push(normalized);
    if (handles.length >= PUBLIC_REPLY_HANDLES_MAX) break;
  }
  return handles;
}

function getLocalizedTiboPostText(
  signal: NonNullable<RadarData["recent_tibo_signals"]>[number],
  locale: Locale,
) {
  const storedTranslation =
    locale === "ja" ? signal.translated_text_ja : locale === "zh" ? signal.translated_text_zh : null;
  if (typeof storedTranslation === "string" && storedTranslation.trim()) {
    return storedTranslation;
  }

  return translateTiboPostText(signal.text, locale);
}

function toNoticeSpecificitySignal(
  signal: NonNullable<RadarData["recent_tibo_signals"]>[number],
): TiboNoticeSignal {
  return {
    tweet_id: signal.tweet_id,
    text: signal.text ?? "",
    tweet_url: signal.tweet_url ?? "",
    tweet_created_at: signal.tweet_created_at,
    signal_type: signal.signal_type === "official_notice" ? "official_notice" : "teaser",
    confidence: signal.confidence ?? null,
    verification_status: signal.verification_status ?? "auto_unverified",
    expires_at: signal.expires_at ?? null,
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
  };
}

function isCurrentOfficialNotice(
  signal: NonNullable<RadarData["recent_tibo_signals"]>[number],
  latestResetAt: string | null,
  nowTime: number,
  sourceSignals: NonNullable<RadarData["recent_tibo_signals"]>,
  resetExecutionWindow: ResetExecutionWindow | null = null,
) {
  if (signal.signal_type !== "official_notice" || signal.is_reply === true) return false;
  if (isTiboForecastSignalTerminatedAt(signal.tweet_id, new Date(nowTime))) return false;
  if (signal.verification_status === "rejected") return false;
  if (isSupersededBankedNotice(signal, sourceSignals)) return false;

  const createdTime = Date.parse(signal.tweet_created_at);
  const expiresTime = Date.parse(signal.expires_at ?? "");
  const latestResetTime = latestResetAt ? Date.parse(latestResetAt) : Number.NaN;
  const secondaryFollowsLatestReset = signal.is_secondary_future_signal === true &&
    Number.isFinite(latestResetTime) &&
    Date.parse(signal.primary_event_at ?? "") === latestResetTime;
  const temporalResolution = signal.temporal_resolution_status === "resolved"
    ? {
        status: signal.temporal_resolution_status,
        expectedStartAt: signal.expected_start_at ?? null,
        expectedEndAt: signal.expected_end_at ?? null,
      }
    : null;
  const temporalRelation = getTemporalExecutionWindowRelation(
    temporalResolution,
    resetExecutionWindow,
  );
  const isFutureWindowAfterBoundary = temporalRelation === "before";
  return (
    Number.isFinite(createdTime) &&
    createdTime <= nowTime &&
    Number.isFinite(expiresTime) &&
    expiresTime > nowTime &&
    (!Number.isFinite(latestResetTime) ||
      createdTime > latestResetTime ||
      secondaryFollowsLatestReset ||
      isFutureWindowAfterBoundary ||
      (temporalRelation === "unknown" && !isTemporalNoticeConsumedAtReset(
        temporalResolution
          ? {
              status: temporalResolution.status,
              temporalPrecision: getEffectiveTemporalPrecision({
                status: temporalResolution.status,
                temporalPrecision: signal.temporal_precision ?? signal.ai_temporal_precision,
                expectedStartAt: signal.expected_start_at,
                expectedEndAt: signal.expected_end_at,
              }) ?? "unknown",
              expectedStartAt: signal.expected_start_at ?? null,
              expectedEndAt: signal.expected_end_at ?? null,
            }
          : null,
        latestResetAt,
      )))
  );
}

/**
 * Projects the newest stored Tibo signal to the small public activity card.
 * Audit fields and the raw tweet identifier never cross the public boundary.
 */
export function toPublicTiboActivity(
  internal: RadarData,
  now: Date = new Date(),
  locale: Locale = "ja",
  latestResetAt: string | null = getLastResetBoundaryAt(internal, now)?.toISOString() ?? null,
  latestTeaserConsumingResetAt: string | null = getLastRandomRecoveryResetAt(internal, now),
  latestTeaserExecutionWindow: ResetExecutionWindow | null = getLastRandomRecoveryResetWindow(internal, now),
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): PublicTiboActivity | null {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return null;

  const recentSignals = internal.recent_tibo_signals;
  const sourceSignals = getTiboReadSideSignals(
    internal,
    "recent",
    false,
    canonicalHistoryContext?.readSideProjection,
  );
  const resetExecutionWindow = latestTeaserExecutionWindow &&
      latestResetAt &&
      Date.parse(latestTeaserExecutionWindow.executionWindowEndAt ?? "") === Date.parse(latestResetAt)
    ? latestTeaserExecutionWindow
    : null;
  const candidates = sourceSignals
    .filter((signal) => {
      if (isTiboForecastSignalTerminatedAt(signal.tweet_id, now)) return false;
      if (signal.is_reply === true) return false;
      if (!PUBLIC_TIBO_CLASSIFICATIONS.has(signal.signal_type as PublicTiboActivity["classification"])) {
        return false;
      }
      if (signal.verification_status === "rejected") return false;
      if (isSupersededBankedNotice(signal, sourceSignals)) return false;

      const createdAt = Date.parse(signal.tweet_created_at);
      if (!Number.isFinite(createdAt) || createdAt > nowTime) return false;

      if (recentSignals === undefined && signal.expires_at) {
        const expiresAt = Date.parse(signal.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt <= nowTime) return false;
      }

      return true;
    })
    .sort(
      (left, right) =>
        Date.parse(right.tweet_created_at) - Date.parse(left.tweet_created_at),
    );

  const eligibleTeaserSignals = getUiResetTeaserSignals(
    sourceSignals,
    latestTeaserConsumingResetAt,
    now,
    latestTeaserExecutionWindow,
  ).filter((signal) => {
    const strength = getEffectiveTeaserStrength(signal);
    return strength === "strong" || strength === "weak";
  });
  const eligibleTeaserIds = new Set(
    eligibleTeaserSignals
      .map((signal) => signal.tweet_id)
      .filter((tweetId): tweetId is string => typeof tweetId === "string"),
  );
  const expandedSignals = expandTiboSignalVariants(sourceSignals.filter((signal) =>
    !isTiboForecastSignalTerminatedAt(signal.tweet_id, now)
  ));
  // UI teaser eligibility is the source of truth here; unlike official notices,
  // teaser expiry is intentionally not reapplied to the related card.
  const relatedCandidates = expandedSignals
    .filter((signal) => {
      const strength = getEffectiveTeaserStrength(signal);
      return isCurrentOfficialNotice(
        signal,
        latestResetAt,
        nowTime,
        sourceSignals,
        resetExecutionWindow,
      ) ||
        (typeof signal.tweet_id === "string" &&
          eligibleTeaserIds.has(signal.tweet_id) &&
          (strength === "strong" || strength === "weak"));
    })
    .sort(
      (left, right) =>
        Date.parse(right.tweet_created_at) - Date.parse(left.tweet_created_at),
    );

  const relatedOfficialNotices = relatedCandidates
    .filter((signal) => signal.signal_type === "official_notice")
    .sort((left, right) =>
      compareTiboNoticeSpecificity(
        toNoticeSpecificitySignal(left),
        toNoticeSpecificitySignal(right),
      ),
    );
  const latest = relatedOfficialNotices[0] ?? relatedCandidates[0] ?? candidates[0];
  if (!latest) return null;

  return {
    classification: latest.signal_type as PublicTiboActivity["classification"],
    teaserStrength: isTeaserStrength(getEffectiveTeaserStrength(latest))
      ? getEffectiveTeaserStrength(latest)
      : null,
    text: normalizePublicPostText(getLocalizedTiboPostText(latest, locale)),
    createdAt: latest.tweet_created_at,
    sourceUrl: safeHttpUrl(latest.tweet_url),
    isReply: latest.is_reply === true,
    replyContextText: latest.is_reply === true
      ? normalizePublicReplyContext(latest.reply_context_text)
      : null,
    replyToHandles: latest.is_reply === true
      ? normalizePublicReplyHandles(latest.reply_to_handles)
      : [],
    ...(latest.temporal_resolution_status
      ? { temporalResolutionStatus: latest.temporal_resolution_status }
      : {}),
    ...(latest.expected_start_at
      ? { expectedStartAt: latest.expected_start_at }
      : {}),
    ...(latest.expected_end_at
      ? { expectedEndAt: latest.expected_end_at }
      : {}),
  };
}

function copySourceHealth(
  health: RadarDataHealth["sources"][keyof RadarDataHealth["sources"]] | undefined,
) {
  return {
    state: health?.state ?? "ok",
    ...(health?.detail ? { detail: health.detail } : {}),
  } as PublicDataHealth["sources"][keyof PublicDataHealth["sources"]];
}

function toPublicViewModel(viewModel: ReturnType<typeof getRadarViewModel>): PublicRadarViewModel {
  return {
    status: viewModel.status,
    expectation: viewModel.expectation,
    probability12h: viewModel.probability12h,
    probability24h: viewModel.probability24h,
    probability48h: viewModel.probability48h,
    probability72h: viewModel.probability72h,
    lastUpdated: viewModel.lastUpdated ?? null,
    regularResetForecast: {
      date: viewModel.regularResetForecast.date,
      time: viewModel.regularResetForecast.time ?? null,
      remaining: viewModel.regularResetForecast.remaining,
      sourceResetAt: viewModel.regularResetForecast.sourceResetAt ?? null,
      expectedAt: viewModel.regularResetForecast.expectedAt ?? null,
      lastCompletedAt: viewModel.regularResetForecast.lastCompletedAt ?? null,
      remainingDays: viewModel.regularResetForecast.remainingDays ?? null,
      isNoticeWindow: viewModel.regularResetForecast.isNoticeWindow,
    },
    activeWindow: {
      active: viewModel.activeWindow.active,
      kind: viewModel.activeWindow.kind,
      ...(viewModel.activeWindow.noticeKind
        ? { noticeKind: viewModel.activeWindow.noticeKind }
        : {}),
      label: viewModel.activeWindow.label,
      summary: viewModel.activeWindow.summary,
      openedAt: viewModel.activeWindow.openedAt ?? null,
      expectedAt: viewModel.activeWindow.expectedAt ?? null,
      expectedEndAt: viewModel.activeWindow.expectedEndAt ?? null,
      expectedPrecision: viewModel.activeWindow.expectedPrecision ?? null,
      expectedTimeZone: viewModel.activeWindow.expectedTimeZone ?? null,
      source: safeHttpUrl(viewModel.activeWindow.source),
      sourceLabel: viewModel.activeWindow.sourceLabel ?? null,
      forecastDate: viewModel.activeWindow.forecastDate,
      forecastTime: viewModel.activeWindow.forecastTime ?? null,
      remaining: viewModel.activeWindow.remaining,
      isOverduePending: viewModel.activeWindow.isOverduePending ?? false,
      overdueText: viewModel.activeWindow.overdueText ?? null,
    },
    displayReasoningSummary: viewModel.displayReasoningSummary,
    codexOperationalStatus: viewModel.codexOperationalStatus,
    latestWindow: {
      kind: viewModel.latestWindow.kind,
      recordKind: viewModel.latestWindow.recordKind,
      title: viewModel.latestWindow.title,
      summary: viewModel.latestWindow.summary,
      scopeLabel: viewModel.latestWindow.scopeLabel,
      scope: viewModel.latestWindow.scope,
      openedAt: viewModel.latestWindow.openedAt ?? null,
      closedAt: viewModel.latestWindow.closedAt ?? null,
      windowLabel: viewModel.latestWindow.windowLabel,
      windowLength: viewModel.latestWindow.windowLength,
      source: safeHttpUrl(viewModel.latestWindow.source),
      sourceKind: viewModel.latestWindow.sourceKind,
    },
    recentHistory: viewModel.recentHistory.map((item) => ({
      key: item.key,
      recordKind: item.recordKind,
      title: item.title,
      resetType: item.resetType,
      resetTypes: item.resetTypes ? [...item.resetTypes] : undefined,
      status: item.status,
      details: item.details
        ? {
            cycleType: item.details.cycleType,
            reasonType: item.details.reasonType,
            resetMethod: item.details.resetMethod,
            scope: item.details.scope,
            noticeToExecution: item.details.noticeToExecution,
            noticeType: item.details.noticeType,
            note: item.details.note ?? null,
          }
        : undefined,
      date: item.date ?? null,
      signalAt: item.signalAt ?? null,
      resetAt: item.resetAt ?? null,
      executionTimePrecision: item.executionTimePrecision ?? null,
      signalLabel: item.signalLabel,
      resetLabel: item.resetLabel,
      scopeLabel: item.scopeLabel,
      scope: item.scope,
      windowLabel: item.windowLabel,
      windowLength: item.windowLength,
      source: safeHttpUrl(item.source),
      sourceKind: item.sourceKind,
      summary: item.summary ?? null,
    })),
  };
}

function toPublicHealth(
  internal: RadarData,
  options: PublicRadarSnapshotOptions,
  checkedAt: string,
): PublicDataHealth {
  const health = internal.data_health;
  return {
    overall: health?.overall ?? "ok",
    stale: options.stale ?? false,
    generatedAt: options.generatedAt ?? checkedAt,
    sources: {
      supabaseSignals: copySourceHealth(health?.sources.supabaseSignals),
      openAIStatus: copySourceHealth(health?.sources.openAIStatus),
    },
  };
}

/**
 * Builds the browser-facing response with an explicit allowlist. Internal
 * RadarData fields are intentionally never spread into this object.
 */
export function toPublicRadarSnapshot(
  internal: RadarData,
  locale: Locale,
  options: PublicRadarSnapshotOptions = {},
): PublicRadarSnapshot {
  const calculationNow = options.calculationNow ?? new Date();
  const checkedAt = internal.checked_at ?? calculationNow.toISOString();
  const calculationContext = options.calculationContext ?? createRadarCalculationContext(internal, calculationNow);
  const viewModel = getRadarViewModel(
    internal,
    locale,
    options.limitHistory ?? true,
    undefined,
    calculationNow,
    calculationContext,
  );
  const latestResetAt = getLastResetBoundaryAt(
    internal,
    calculationNow,
    calculationContext.canonicalHistoryContext,
  )?.toISOString() ?? null;
  const latestTeaserConsumingResetAt = getLastRandomRecoveryResetAt(
    internal,
    calculationNow,
    undefined,
    calculationContext.canonicalHistoryContext,
  );
  const latestTeaserExecutionWindow = getLastRandomRecoveryResetWindow(
    internal,
    calculationNow,
    undefined,
    calculationContext.canonicalHistoryContext,
  );
  const consumedRecoveryObservationIds = getNoticeBackedRecoveryObservationIds(
    internal.reset_execution_estimates,
  );

  return {
    schemaVersion: "public-v1",
    checkedAt,
    updatedAt: internal.updated_at ?? null,
    lastRandomResetAt: latestTeaserConsumingResetAt,
    dataHealth: toPublicHealth(internal, options, checkedAt),
    viewModel: toPublicViewModel(viewModel),
    resetTeaserStatus: aggregateResetTeaserStatus(
      getTiboReadSideSignals(
        internal,
        "recent",
        false,
        calculationContext.canonicalHistoryContext.readSideProjection,
      ),
      latestTeaserConsumingResetAt,
      calculationNow,
      latestTeaserExecutionWindow,
    ),
    latestTiboActivity: toPublicTiboActivity(
      internal,
      calculationNow,
      locale,
      latestResetAt,
      latestTeaserConsumingResetAt,
      latestTeaserExecutionWindow,
      calculationContext.canonicalHistoryContext,
    ),
    recoveryObservation: getPublicRecoveryObservation(
      internal.codex_usage_recovery,
      calculationNow,
      consumedRecoveryObservationIds,
    ),
  };
}
