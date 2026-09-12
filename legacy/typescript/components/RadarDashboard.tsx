"use client";

import {
  AlertTriangle,
  Bell,
  Clock3,
  ExternalLink,
  Gauge,
  History,
  MessageCircle,
  Radio,
  type LucideIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CachedRadarData } from "@/lib/radar/types";
import {
  applyRefreshFailure,
  applyRefreshSuccess,
  getDashboardDataState,
  parseCachedRadarData,
  type RadarLoadState,
} from "@/lib/radar/clientState";
import type {
  CodexOperationalStatus,
  HistorySourceKind,
  Locale,
  PublicRadarSnapshot,
} from "@/lib/radar/types";
import { translateUI, translateDynamic } from "@/lib/radar/i18n";
import {
  canStartRadarRefresh,
  getEventRefreshPlan,
  getInitialRefreshPlan,
  getRefreshRetryDelayMs,
  RADAR_FETCH_TIMEOUT_MS,
  startAbortTimeout,
} from "@/lib/radar/refreshPolicy";
import {
  beginResetMarkerRefresh,
  buildCurrentRadarFetchUrl,
  createResetMarkerState,
  deferResetMarker,
  getResetMarkerCatchUpPlan,
  getInitialResetMarkerPlan,
  getResetMarkerPollPlan,
  getResetMarkerRequestUrl,
  markResetMarkerAccepted,
  markResetMarkerRetry,
  observeResetMarker,
  parseResetMarkerPayload,
  RESET_MARKER_CATCH_UP_RETRY_DELAY_MS,
  RESET_MARKER_MAX_CATCH_UP_RETRIES,
  RESET_MARKER_POLL_INTERVAL_MS,
  type ResetMarkerPayload,
} from "@/lib/radar/resetMarker";
import { SITE_NAME, SITE_NAME_JA } from "@/lib/siteMetadata";
import { DeveloperLink } from "./DeveloperLink";
import { ObservationGuide } from "./ObservationGuide";
import { LocalizedDateTime } from "@/components/LocalizedDateTime";
import { ProbabilityMetrics } from "@/components/ProbabilityMetrics";
import { RandomResetTimeHeatmap } from "@/components/RandomResetTimeHeatmap";
import { ResetHistoryDetails } from "@/components/ResetHistoryDetails";
import { TiboActivityCard } from "@/components/TiboActivityCard";
import { formatElapsedResetDuration, isSafeHttpUrl } from "@/lib/radar/helpers";
import { resolveManualOutlook, type ActiveManualOutlook } from "@/data/manualOutlook";

function createUnavailableRadarViewModel(locale: Locale): PublicRadarSnapshot["viewModel"] {
  const unknown = translateUI("unknownProbability", locale);
  const noNotice = translateUI("noNoticeLabel", locale);

  return {
    status: noNotice,
    expectation: unknown,
    lastUpdated: null,
    regularResetForecast: {
      date: unknown,
      time: null,
      remaining: unknown,
      sourceResetAt: null,
      expectedAt: null,
      lastCompletedAt: null,
      remainingDays: null,
      isNoticeWindow: false,
    },
    activeWindow: {
      active: false,
      kind: "none",
      label: noNotice,
      summary: locale === "en"
        ? "At this moment, there are no official reset notices detected."
        : locale === "zh"
          ? "目前未检测到官方重置预告。"
          : "現時点で、このサイトで確認した公式リセット予告はありません。",
      openedAt: null,
      expectedAt: null,
      expectedEndAt: null,
      expectedPrecision: null,
      expectedTimeZone: null,
      source: null,
      sourceLabel: null,
      isOverduePending: false,
      overdueText: null,
    },
    displayReasoningSummary: null,
    codexOperationalStatus: "unknown",
    latestWindow: {
      kind: "observed",
      title: unknown,
      summary: unknown,
      scope: unknown,
      openedAt: null,
      closedAt: null,
      windowLength: unknown,
      source: null,
      sourceKind: "none",
    },
    recentHistory: [],
  };
}

function hasPriorSignal(signalAt: string | null | undefined, resetAt: string | null | undefined) {
  if (!signalAt || !resetAt) return false;
  const signalTime = new Date(signalAt).getTime();
  const resetTime = new Date(resetAt).getTime();
  return Number.isFinite(signalTime) && Number.isFinite(resetTime) && signalTime < resetTime;
}

function isTiboNoticeSource(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return false;

  try {
    const url = new URL(sourceUrl);
    if (
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase()) ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      return false;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length >= 3 &&
      segments[0]?.toLowerCase() === "thsottiaux" &&
      segments[1]?.toLowerCase() === "status";
  } catch {
    return false;
  }
}

function shouldShowTiboLocalTimeNote(
  activeWindow: PublicRadarSnapshot["viewModel"]["activeWindow"],
) {
  return activeWindow.kind === "official" &&
    isTiboNoticeSource(activeWindow.source) &&
    Boolean(activeWindow.expectedAt) &&
    Number.isFinite(Date.parse(activeWindow.expectedAt ?? "")) &&
    Boolean(activeWindow.expectedTimeZone) &&
    Boolean(activeWindow.expectedPrecision) &&
    activeWindow.expectedPrecision !== "unknown";
}

const RESET_DELIVERY_END_OF_DAY_PATTERN =
  /\b(?:lands?|arrives?|is\s+(?:delivered|available)|will\s+(?:land|arrive))\s+(?:by\s+)?end\s+of\s+day\b/i;
const RESET_DELIVERY_LOCALIZED_END_OF_DAY_PATTERNS = [
  /(?:一日の終わり|今日の終わり)(?:に)?(?:適用|実施|配布|付与|届|到着)/,
  /(?:今天结束时|一天结束时|日终)(?:落地|发放|执行|生效)/,
];
const RESET_DELIVERY_CONTEXT_PATTERN =
  /(?:\b(?:reset|banked|distribution|grant|credit(?:s)?|quota)\b|リセット|配布|付与|储蓄重置|重置|发放)/i;

function isResetDeliveryEndOfDayDeadline(
  activeWindow: PublicRadarSnapshot["viewModel"]["activeWindow"],
  activity: PublicRadarSnapshot["latestTiboActivity"],
) {
  if (
    activeWindow.kind !== "official" ||
    !activeWindow.expectedAt ||
    !activeWindow.expectedEndAt ||
    !activeWindow.source ||
    !activity ||
    activity.classification !== "official_notice" ||
    activity.isReply ||
    activity.sourceUrl !== activeWindow.source ||
    !activity.text
  ) {
    return false;
  }

  const startAt = Date.parse(activeWindow.expectedAt);
  const endAt = Date.parse(activeWindow.expectedEndAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) {
    return false;
  }

  const activityText = activity.text;
  const deadlineMatch = [
    RESET_DELIVERY_END_OF_DAY_PATTERN,
    ...RESET_DELIVERY_LOCALIZED_END_OF_DAY_PATTERNS,
  ]
    .map((pattern) => pattern.exec(activityText))
    .find((match) => match !== null);
  if (!deadlineMatch || deadlineMatch.index === undefined) {
    return false;
  }

  const contextStart = Math.max(0, deadlineMatch.index - 240);
  return RESET_DELIVERY_CONTEXT_PATTERN.test(activityText.slice(contextStart, deadlineMatch.index));
}

function getSourceLabel(sourceKind: HistorySourceKind | undefined, locale: Locale) {
  switch (sourceKind) {
    case "direct_post":
      return translateUI("sourceOriginalPost", locale);
    case "profile":
      return translateUI("sourceProfile", locale);
    case "official_status":
      return translateUI("sourceOfficialStatus", locale);
    default:
      return translateUI("sourceNotRecorded", locale);
  }
}

function getHistoryDisplayTitle(
  item: PublicRadarSnapshot["viewModel"]["recentHistory"][number],
  locale: Locale,
) {
  const title = translateDynamic(item.title, locale);
  if (
    item.recordKind !== "reference" ||
    item.details?.cycleType === translateDynamic("定期リセット", locale)
  ) {
    return title;
  }

  return locale === "en"
    ? `${title} (reference record)`
    : locale === "zh"
      ? `${title}（参考记录）`
      : `${title}（参考記録）`;
}

const HOMEPAGE_EXPLANATION_CONTENT = {
  ja: {
    title: "Codexリセット観測所について",
    paragraphs: [
      "Codexリセット観測所は、Codexの利用上限リセットに関する公開情報を整理する非公式サイトです。過去に確認された全体リセットや任意リセット配布、公式・開発関係者による予告、OpenAI Statusなどをもとに、現在の状況をまとめています。",
      "24時間・48時間以内のリセット期待度は、過去のランダムリセット間隔と現在の観測シグナルから算出した統計的な参考値です。OpenAIによる公式な確率ではありません。確定済みの事例はリセット履歴で、予測方法や用語についてはFAQで確認できます。",
    ],
    links: [
      { href: "/history", label: "リセット履歴" },
      { href: "/faq", label: "FAQ" },
      { href: "/about", label: "このサイトについて" },
    ],
  },
  en: {
    title: "About Codex Reset Observatory",
    paragraphs: [
      "Codex Reset Observatory is an unofficial site that organizes public information about Codex usage-limit resets. It summarizes the current situation using confirmed global resets and account-specific reset grants, official notices from OpenAI and people involved in development, and OpenAI Status.",
      "The 24-hour and 48-hour reset likelihoods are statistical reference values calculated from past random reset intervals and current observed signals. They are not official probabilities from OpenAI. Confirmed cases are listed in the reset history, while the FAQ explains how the forecast is calculated and how the site's terms are used.",
    ],
    links: [
      { href: "/en/history", label: "Reset history" },
      { href: "/en/faq", label: "FAQ" },
      { href: "/en/about", label: "About this site" },
    ],
  },
  zh: {
    title: "关于 Codex 重置观测站",
    paragraphs: [
      "Codex 重置观测站是一个整理 Codex 使用上限重置公开信息的非官方网站。本站参考过去确认的全局重置和按需发放的重置、OpenAI 及开发相关人员发布的官方预告，以及 OpenAI Status，汇总当前状况。",
      "未来24小时和48小时内的重置期望度，是根据过去的随机重置间隔和当前观测信号计算的统计参考值，并非 OpenAI 官方概率。已确认的事件会记录在重置历史中；预测方法和相关术语可在常见问题中查看。",
    ],
    links: [
      { href: "/zh/history", label: "重置历史" },
      { href: "/zh/faq", label: "常见问题" },
      { href: "/zh/about", label: "关于本网站" },
    ],
  },
} as const;

function getElapsedSinceLastRandomReset(
  sourceResetAt: string | null | undefined,
  fetchedAt: string | null | undefined,
  locale: Locale,
) {
  const resetTime = sourceResetAt ? Date.parse(sourceResetAt) : Number.NaN;
  const observedTime = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (!Number.isFinite(resetTime) || !Number.isFinite(observedTime) || observedTime < resetTime) {
    return translateUI("unknownProbability", locale);
  }

  return formatElapsedResetDuration(observedTime - resetTime, locale);
}

export function formatScheduledSourceDay(
  value: string,
  timeZone: string | null | undefined,
  locale: Locale,
) {
  if (!timeZone) return null;
  try {
    const localeName = locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP";
    const formatted = new Intl.DateTimeFormat(localeName, {
      timeZone,
      month: "long",
      day: "numeric",
      weekday: locale === "ja" ? "short" : "long",
    }).format(new Date(value));
    return locale === "ja" ? formatted.replace(/\(([^)]+)\)/, "（$1）") : formatted;
  } catch {
    return null;
  }
}

function getIncidentStatusLabel(status: CodexOperationalStatus, locale: Locale) {
  if (status === "active") return translateUI("activeCodexIncident", locale);
  if (status === "recovered") return translateUI("recoveredCodexIncident", locale);
  if (status === "none") return translateUI("noCodexIncident", locale);
  return translateUI("unknownProbability", locale);
}

type ResetTeaserStatus = "strong" | "weak" | "none" | "unknown";

function getResetTeaserStatus(
  status: PublicRadarSnapshot["resetTeaserStatus"] | null | undefined,
): ResetTeaserStatus {
  return status ?? "unknown";
}

function getResetTeaserStatusLabel(status: ResetTeaserStatus, locale: Locale) {
  if (status === "strong") return translateUI("activeResetTeaser", locale);
  if (status === "weak") return translateUI("weakResetTeaser", locale);
  if (status === "none") return translateUI("noResetTeaser", locale);
  return translateUI("unknownProbability", locale);
}

function getCompactOutlookReason(
  reason: string | null | undefined,
  locale: Locale,
) {
  return reason?.trim() || translateUI("outlookUnavailable", locale);
}

function getTimedTeaserOutlookTemplate(
  activity: PublicRadarSnapshot["latestTiboActivity"] | null | undefined,
  resetTeaserStatus: ResetTeaserStatus,
  fetchedAt: string | null | undefined,
  locale: Locale,
) {
  if (
    !activity ||
    activity.classification !== "teaser" ||
    activity.temporalResolutionStatus !== "resolved" ||
    !activity.expectedStartAt ||
    !activity.expectedEndAt ||
    (resetTeaserStatus !== "strong" && resetTeaserStatus !== "weak")
  ) {
    return null;
  }

  const start = Date.parse(activity.expectedStartAt);
  const end = Date.parse(activity.expectedEndAt);
  const observedAt = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  const isGracePeriod = Number.isFinite(observedAt) && observedAt > end;
  const key = isGracePeriod
    ? resetTeaserStatus === "strong"
      ? "outlookStrongTimedTeaserGrace"
      : "outlookWeakTimedTeaserGrace"
    : resetTeaserStatus === "strong"
      ? "outlookStrongTimedTeaser"
      : "outlookWeakTimedTeaser";

  return {
    template: translateUI(key, locale),
    startAt: activity.expectedStartAt,
    endAt: activity.expectedEndAt,
  };
}

function TimedTeaserOutlook({
  template,
  startAt,
  endAt,
  locale,
}: {
  template: string;
  startAt: string;
  endAt: string;
  locale: Locale;
}) {
  const [beforeStart, afterStart = ""] = template.split("{start}", 2);
  const [between, afterEnd = ""] = afterStart.split("{end}", 2);

  return (
    <>
      {beforeStart}
      <LocalizedDateTime value={startAt} locale={locale} timeClassName="font-normal text-slate-700" />
      {between}
      <LocalizedDateTime value={endAt} locale={locale} timeClassName="font-normal text-slate-700" />
      {afterEnd}
    </>
  );
}

function ObservationStatusItem({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50/80 px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-sm font-medium text-slate-500">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="min-w-0 whitespace-normal break-words leading-snug">{label}</span>
      </dt>
      <dd className="mt-1 truncate text-base font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

export function RadarDashboard({
  initialData,
  initialFetchedAt,
  randomResetHeatmapEventTimes = [],
  locale = "ja",
}: {
  initialData?: PublicRadarSnapshot | null;
  initialFetchedAt?: string | null;
  randomResetHeatmapEventTimes?: string[];
  locale?: Locale;
}) {
  const resolvedInitialFetchedAt = initialFetchedAt ?? initialData?.checkedAt ?? null;
  const [state, setState] = useState<RadarLoadState>(() => ({
    data: initialData ?? null,
    fetchedAt: resolvedInitialFetchedAt,
    isStale: initialData?.dataHealth.stale ?? false,
    refreshError: null,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;
  const lifecycleIdRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const failureCountRef = useRef(0);
  const latestDataRef = useRef<PublicRadarSnapshot | null>(initialData ?? null);
  const latestFetchedAtRef = useRef<string | null>(resolvedInitialFetchedAt);
  const cacheKey = `codex-reset-observatory:last-success:${locale}`;
  const unavailableViewModel = useMemo(
    () => createUnavailableRadarViewModel(locale),
    [locale],
  );
  const [loadedFallbackViewModel, setLoadedFallbackViewModel] = useState<PublicRadarSnapshot["viewModel"] | null>(null);

  const loadCachedData = useCallback((): CachedRadarData | null => {
    try {
      return parseCachedRadarData(window.localStorage.getItem(cacheKey), locale);
    } catch {
      return null;
    }
  }, [cacheKey, locale]);

  const fetchRadar = useCallback(async (
    lifecycleId: number,
    options: { resetMarker?: string | null; resetMarkerRetry?: number } = {},
  ) => {
    const isCurrentLifecycle = () => lifecycleIdRef.current === lifecycleId;
    const environment = {
      visibilityState: typeof document === "undefined" ? "visible" : document.visibilityState,
      onLine: typeof navigator === "undefined" || navigator.onLine !== false,
      inFlight: inFlightRef.current !== null,
    };

    if (!isCurrentLifecycle() || !canStartRadarRefresh(environment)) {
      return { kind: "skipped" as const };
    }

    const controller = new AbortController();
    inFlightRef.current = controller;
    const timeout = startAbortTimeout(
      controller,
      RADAR_FETCH_TIMEOUT_MS,
      window.setTimeout.bind(window),
      window.clearTimeout.bind(window),
    );

    try {
      const response = await fetch(
        buildCurrentRadarFetchUrl(locale, options.resetMarker, options.resetMarkerRetry),
        {
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error("Failed to fetch current data");
      }

      const data = (await response.json()) as PublicRadarSnapshot;
      const fetchedAt = new Date().toISOString();
      if (!isCurrentLifecycle()) {
        return { kind: "aborted" as const };
      }

      const nextState = applyRefreshSuccess(data, fetchedAt);
      stateRef.current = nextState;
      setState(nextState);
      latestDataRef.current = data;
      latestFetchedAtRef.current = fetchedAt;
      failureCountRef.current = 0;

      try {
        window.localStorage.setItem(
          cacheKey,
          JSON.stringify({
            schemaVersion: "public-v1",
            locale,
            data,
            fetchedAt,
          } satisfies CachedRadarData),
        );
      } catch {
        // Cache persistence is best-effort; the successful live response remains current.
      }
      return { kind: "success" as const, data, fetchedAt };
    } catch {
      if (!isCurrentLifecycle() || (controller.signal.aborted && !timeout.hasTimedOut())) {
        return { kind: "aborted" as const };
      }

      const cached = loadCachedData();
      const nextState = applyRefreshFailure(stateRef.current, cached);
      stateRef.current = nextState;
      setState(nextState);
      latestDataRef.current = nextState.data;
      latestFetchedAtRef.current = nextState.fetchedAt;
      failureCountRef.current += 1;

      return {
        kind: "failure" as const,
        retryDelayMs: getRefreshRetryDelayMs(failureCountRef.current),
      };
    } finally {
      timeout.cancel();
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, [cacheKey, loadCachedData, locale]);

  useEffect(() => {
    const lifecycleId = lifecycleIdRef.current + 1;
    lifecycleIdRef.current = lifecycleId;
    failureCountRef.current = 0;

    const initialState: RadarLoadState = {
      data: initialData ?? null,
      fetchedAt: resolvedInitialFetchedAt,
      isStale: initialData?.dataHealth.stale ?? false,
      refreshError: null,
    };
    stateRef.current = initialState;
    setState(initialState);
    latestDataRef.current = initialData ?? null;
    latestFetchedAtRef.current = resolvedInitialFetchedAt;

    const clearRefreshTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const isCurrentLifecycle = () => lifecycleIdRef.current === lifecycleId;

    let markerTimer: number | null = null;
    let markerCheckInFlight = false;
    let markerLastCheckedAt: number | null = null;
    let markerState = createResetMarkerState();

    const clearMarkerTimer = () => {
      if (markerTimer !== null) {
        window.clearTimeout(markerTimer);
        markerTimer = null;
      }
    };

    const scheduleMarkerCheck = (delayMs: number) => {
      if (!isCurrentLifecycle()) return;
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;

      clearMarkerTimer();
      markerTimer = window.setTimeout(() => {
        markerTimer = null;
        void checkResetMarker();
      }, Math.max(0, delayMs));
    };

    const scheduleNextRefresh = (delayMs: number) => {
      if (!isCurrentLifecycle()) return;

      const canSchedule = canStartRadarRefresh({
        visibilityState: document.visibilityState,
        onLine: navigator.onLine !== false,
        inFlight: false,
      });
      if (!canSchedule) return;

      clearRefreshTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void runRefresh();
      }, Math.max(0, delayMs));
    };

    const runRefresh = async (markerRefresh?: {
      marker: ResetMarkerPayload;
      retryCount: number;
    }) => {
      if (!isCurrentLifecycle()) return;

      const result = await fetchRadar(lifecycleId, markerRefresh ? {
        resetMarker: markerRefresh.marker.marker,
        resetMarkerRetry: markerRefresh.retryCount,
      } : undefined);
      if (!isCurrentLifecycle()) return;

      if (result.kind === "success") {
        const plan = getInitialRefreshPlan(result.data, result.fetchedAt, Date.now());
        scheduleNextRefresh(
          plan.action === "wait"
            ? plan.delayMs
            : getRefreshRetryDelayMs(Math.max(1, failureCountRef.current + 1)),
        );
      } else if (result.kind === "failure") {
        scheduleNextRefresh(result.retryDelayMs);
      }
      return result;
    };

    const runMarkerCatchUp = async (marker: ResetMarkerPayload, retryCount: number) => {
      const result = await runRefresh({ marker, retryCount });
      if (!isCurrentLifecycle()) return null;

      if (result?.kind === "success") {
        const plan = getResetMarkerCatchUpPlan(result.data, marker, retryCount);
        if (plan.action === "accepted") {
          markerState = markResetMarkerAccepted(markerState, marker);
          return plan.delayMs;
        }
        if (plan.action === "retry") {
          markerState = markResetMarkerRetry(markerState, marker, retryCount + 1);
          return plan.delayMs;
        }
        markerState = deferResetMarker(markerState, marker);
        return plan.delayMs;
      }

      if (retryCount < RESET_MARKER_MAX_CATCH_UP_RETRIES) {
        markerState = markResetMarkerRetry(markerState, marker, retryCount + 1);
        return RESET_MARKER_CATCH_UP_RETRY_DELAY_MS;
      }
      markerState = deferResetMarker(markerState, marker);
      return RESET_MARKER_POLL_INTERVAL_MS;
    };

    const checkResetMarker = async () => {
      if (!isCurrentLifecycle() || markerCheckInFlight) return;
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;

      markerCheckInFlight = true;
      markerLastCheckedAt = Date.now();
      let nextDelayMs = RESET_MARKER_POLL_INTERVAL_MS;
      try {
        const response = await fetch(getResetMarkerRequestUrl());
        if (!response.ok) return;
        const incoming = parseResetMarkerPayload(await response.json());
        if (!incoming || !isCurrentLifecycle()) return;

        if (!markerState.initialized) {
          const initialPlan = getInitialResetMarkerPlan(latestDataRef.current, incoming);
          if (initialPlan.action === "refresh") {
            markerState = beginResetMarkerRefresh(markerState, incoming);
            nextDelayMs = (await runMarkerCatchUp(incoming, 0)) ?? nextDelayMs;
            return;
          }
        }

        const observation = observeResetMarker(markerState, incoming);
        markerState = observation.state;
        if (observation.action === "refresh" && observation.marker) {
          nextDelayMs = (await runMarkerCatchUp(observation.marker, markerState.retryCount)) ?? nextDelayMs;
        }
      } catch {
        // Marker failures are lightweight and must not disturb full snapshot state.
      } finally {
        markerCheckInFlight = false;
        if (isCurrentLifecycle()) scheduleMarkerCheck(nextDelayMs);
      }
    };

    const resumeMarkerLifecycle = () => {
      if (!isCurrentLifecycle()) return;
      const plan = getResetMarkerPollPlan(
        markerLastCheckedAt,
        Date.now(),
        document.visibilityState,
        navigator.onLine !== false,
      );
      if (plan.action === "check") {
        void checkResetMarker();
      } else if (plan.action === "wait") {
        scheduleMarkerCheck(plan.delayMs);
      }
    };

    const resumeRefreshLifecycle = () => {
      if (!isCurrentLifecycle()) return;

      const plan = getEventRefreshPlan(
        latestDataRef.current,
        latestFetchedAtRef.current,
        Date.now(),
      );
      if (plan.action === "fetch") {
        void runRefresh();
      } else {
        scheduleNextRefresh(plan.delayMs);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearRefreshTimer();
        clearMarkerTimer();
        return;
      }

      resumeRefreshLifecycle();
      resumeMarkerLifecycle();
    };

    const handleOnline = () => {
      resumeRefreshLifecycle();
      resumeMarkerLifecycle();
    };

    const handleFocus = () => {
      resumeRefreshLifecycle();
      resumeMarkerLifecycle();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);

    const initialPlan = getInitialRefreshPlan(
      initialData,
      resolvedInitialFetchedAt,
      Date.now(),
    );
    if (initialPlan.action === "fetch") {
      void runRefresh();
    } else {
      scheduleNextRefresh(initialPlan.delayMs);
    }
    scheduleMarkerCheck(0);

    return () => {
      lifecycleIdRef.current += 1;
      clearRefreshTimer();
      clearMarkerTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [fetchRadar, initialData, locale, resolvedInitialFetchedAt]);

  useEffect(() => {
    if (state.data) {
      setLoadedFallbackViewModel(null);
      return;
    }

    let cancelled = false;
    void import("@/lib/radar")
      .then(({ getRadarViewModel }) => {
        if (!cancelled) {
          setLoadedFallbackViewModel(getRadarViewModel(null, locale));
        }
      })
      .catch(() => {
        // The compact unavailable view remains usable if the fallback module cannot load.
      });

    return () => {
      cancelled = true;
    };
  }, [locale, state.data]);

  const viewModel = state.data?.viewModel ?? loadedFallbackViewModel ?? unavailableViewModel;
  const dashboardDataState = getDashboardDataState(state);
  const isDataUnavailable = dashboardDataState === "unavailable";
  const shouldShowDataWarning =
    dashboardDataState === "degraded" || dashboardDataState === "unavailable";
  const hasOfficialNotice = viewModel.activeWindow.active && viewModel.activeWindow.kind === "official";
  const hasNoticePresentation = hasOfficialNotice;
  const hideUntimedBankedSchedule = viewModel.activeWindow.noticeKind === "banked" &&
    viewModel.activeWindow.expectedPrecision === "unknown" &&
    !viewModel.activeWindow.expectedAt &&
    !viewModel.activeWindow.expectedEndAt;
  const showTiboLocalTimeNote = shouldShowTiboLocalTimeNote(viewModel.activeWindow);
  const showResetDeliveryDeadline = isResetDeliveryEndOfDayDeadline(
    viewModel.activeWindow,
    state.data?.latestTiboActivity,
  );
  const probability24h = isDataUnavailable
    ? undefined
    : viewModel.probability24h;
  const probability48h = isDataUnavailable
    ? undefined
    : viewModel.probability48h;
  const officialNoticeValue = isDataUnavailable
    ? translateUI("unknownProbability", locale)
    : viewModel.activeWindow.active && hasOfficialNotice
      ? translateUI("activeNoticeLabel", locale)
      : translateUI("noOfficialNotice", locale);
  const incidentStatus = isDataUnavailable
    ? "unknown" as const
    : viewModel.codexOperationalStatus ?? "unknown";
  const resetTeaserStatus = isDataUnavailable
    ? "unknown" as const
    : getResetTeaserStatus(state.data?.resetTeaserStatus);
  const selectedTiboActivity = state.data?.latestTiboActivity;
  const hasSelectedRelatedTibo = Boolean(
    selectedTiboActivity && (
      selectedTiboActivity.classification === "official_notice" ||
      selectedTiboActivity.teaserStrength === "strong" ||
      selectedTiboActivity.teaserStrength === "weak"
    ),
  );
  const shouldRenderRelatedTibo = !isDataUnavailable &&
    hasSelectedRelatedTibo &&
    (hasNoticePresentation || resetTeaserStatus === "strong" || resetTeaserStatus === "weak");
  const tiboActivityCard = state.data?.latestTiboActivity ? (
    <TiboActivityCard
      activity={state.data.latestTiboActivity}
      locale={locale}
      variant={shouldRenderRelatedTibo ? "related" : "latest"}
    />
  ) : null;
  const elapsedSinceLastReset = isDataUnavailable
    ? translateUI("unknownProbability", locale)
    : getElapsedSinceLastRandomReset(
        state.data?.lastRandomResetAt,
        state.fetchedAt,
        locale,
      );
  const compactOutlookReason = getCompactOutlookReason(
    isDataUnavailable
      ? null
      : viewModel.displayReasoningSummary,
    locale,
  );
  const activeManualOutlook = resolveManualOutlook(
    state.fetchedAt ?? initialFetchedAt ?? state.data?.checkedAt,
    locale,
  );
  const timedTeaserOutlook = getTimedTeaserOutlookTemplate(
    selectedTiboActivity,
    resetTeaserStatus,
    state.fetchedAt,
    locale,
  );
  const visibleHistory = viewModel.recentHistory.filter(
    (item) => item.recordKind === "confirmed_global" ||
      item.recordKind === "banked_distribution" ||
      item.recordKind === "reference" ||
      item.recordKind === "regular_completed",
  );
  const resetNoticeTone = {
    card: "border-amber-300 bg-amber-50 text-amber-950",
    icon: "text-amber-700",
  };
  const homepageExplanation = HOMEPAGE_EXPLANATION_CONTENT[locale];

  return (
    <main className="min-h-screen px-3 py-4 sm:px-6 sm:py-5 lg:px-8" lang={locale}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex flex-col gap-3 rounded-lg border border-slate-200/80 bg-white/82 p-3 shadow-sm backdrop-blur sm:gap-4 sm:p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 sm:gap-4">
            <div className="radar-grid relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-200 sm:h-16 sm:w-16">
              <div className="absolute inset-2 rounded-full border border-slate-300" />
              <div className="radar-sweep absolute inset-2 rounded-full" />
              <Radio className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-teal-700" />
            </div>
            <div>
              <p className="text-xs font-medium leading-5 text-teal-700 sm:text-sm sm:leading-6">
                {locale === "ja" || locale === "zh" ? SITE_NAME : translateUI("subTitle", locale)}
              </p>
              <h1 className="mt-0.5 whitespace-nowrap text-[1.15rem] font-semibold leading-tight tracking-normal text-slate-950 sm:mt-1 sm:text-4xl">
                {locale === "ja" ? SITE_NAME_JA : locale === "zh" ? "Codex 重置观测站" : SITE_NAME}
              </h1>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-600 sm:mt-3 sm:text-sm sm:leading-6">
                {translateUI("description", locale)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 sm:justify-start">
            {locale !== "ja" && (
              <Link
                className="inline-flex min-h-8 w-fit items-center rounded-md border border-transparent bg-transparent px-2.5 py-1 text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-800 hover:underline sm:border-slate-200 sm:bg-white sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold sm:text-slate-700"
                href="/"
              >
                日本語
              </Link>
            )}
            {locale !== "en" && (
              <Link
                className="inline-flex min-h-8 w-fit items-center rounded-md border border-transparent bg-transparent px-2.5 py-1 text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-800 hover:underline sm:border-slate-200 sm:bg-white sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold sm:text-slate-700"
                href="/en"
              >
                English
              </Link>
            )}
            {locale !== "zh" && (
              <Link
                className="inline-flex min-h-8 w-fit items-center rounded-md border border-transparent bg-transparent px-2.5 py-1 text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-800 hover:underline sm:border-slate-200 sm:bg-white sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold sm:text-slate-700"
                href="/zh"
              >
                简体中文
              </Link>
            )}
          </div>
        </header>

        {shouldShowDataWarning ? (
          <section
            role={dashboardDataState === "unavailable" ? "alert" : "status"}
            className={`rounded-lg border px-4 py-3 text-sm leading-6 ${
              dashboardDataState === "unavailable"
                ? "border-rose-200 bg-rose-50 text-rose-950"
                : "border-amber-200 bg-amber-50 text-amber-950"
            }`}
          >
            {translateUI(
              dashboardDataState === "degraded"
                ? "degradedDataWarning"
                : "dataUnavailable",
              locale,
            )}
          </section>
        ) : null}

        {hasNoticePresentation ? (
          <section className={`rounded-lg border p-4 shadow-sm sm:p-5 ${resetNoticeTone.card}`}>
            <div className="flex items-start gap-3">
              <Bell className={`mt-0.5 h-6 w-6 shrink-0 ${resetNoticeTone.icon}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-500">
                  {translateUI("officialNotice", locale)}
                </p>
                <h2 className="mt-1 text-xl font-semibold leading-tight text-slate-950 sm:text-2xl">
                  {viewModel.activeWindow.noticeKind === "banked"
                    ? viewModel.activeWindow.summary
                    : translateUI("activeNoticeLabel", locale)}
                </h2>
                {viewModel.activeWindow.noticeKind === "banked" ? (
                  <p className="mt-2 text-base font-normal leading-6 text-slate-700">
                    {translateUI("bankedNoticeAdvice", locale)}
                  </p>
                ) : null}
              </div>
            </div>

            <dl className="mt-4 space-y-3 border-t border-amber-200/80 pt-4">
              {!hideUntimedBankedSchedule ? (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                  <dt className="shrink-0 text-sm font-semibold text-slate-600">
                    {translateUI("scheduledResetTime", locale)}{locale === "en" ? ": " : "："}
                  </dt>
                  <dd className="min-w-0 text-lg font-semibold leading-tight text-slate-950 sm:text-xl">
                    {showResetDeliveryDeadline ? (
                      <span className="inline-flex flex-wrap items-baseline gap-y-1">
                        {translateUI("scheduledResetDeadlinePrefix", locale)}
                        <LocalizedDateTime
                          value={viewModel.activeWindow.expectedEndAt}
                          locale={locale}
                          weekday="short"
                          approximate
                        />
                        {translateUI("scheduledResetDeadlineSuffix", locale)}
                      </span>
                    ) : viewModel.activeWindow.expectedAt ? (
                      <span className="inline-flex flex-wrap items-baseline gap-y-1">
                        <LocalizedDateTime
                          value={viewModel.activeWindow.expectedAt}
                          locale={locale}
                          weekday="short"
                          approximate={
                            viewModel.activeWindow.kind === "official" &&
                            viewModel.activeWindow.expectedPrecision === "exact_time"
                          }
                        />
                        {viewModel.activeWindow.expectedPrecision !== "exact_time" && viewModel.activeWindow.expectedEndAt ? (
                          <>
                            <span className="mx-1.5 font-normal text-slate-500">
                              {translateUI("timeRangeSeparator", locale)}
                            </span>
                            <LocalizedDateTime
                              value={viewModel.activeWindow.expectedEndAt}
                              locale={locale}
                              weekday="short"
                            />
                          </>
                        ) : null}
                      </span>
                    ) : (
                      translateUI("scheduledResetTimeUnknown", locale)
                    )}
                    {showTiboLocalTimeNote ? (
                      <p className="mt-2 text-base font-normal leading-6 text-slate-600">
                        {translateUI("tiboNoticeLocalTime", locale)}
                      </p>
                    ) : null}
                    {viewModel.activeWindow.isOverduePending && viewModel.activeWindow.overdueText ? (
                      <p className="mt-2 text-base font-normal leading-6 text-slate-600">
                        {viewModel.activeWindow.overdueText}
                      </p>
                    ) : null}
                  </dd>
                </div>
              ) : null}

              <div className="flex flex-col gap-1 border-t border-amber-200/80 pt-3 sm:flex-row sm:items-baseline sm:gap-3">
                <dt className="shrink-0 text-sm font-semibold text-slate-600">
                  {translateUI("source", locale)}
                </dt>
                <dd className="min-w-0 text-sm font-semibold text-slate-900 sm:text-base">
                  {isSafeHttpUrl(viewModel.activeWindow.source) ? (
                    <a
                      className="inline-flex max-w-full items-center gap-1 break-words text-teal-700 underline-offset-4 hover:underline"
                      href={viewModel.activeWindow.source ?? undefined}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {viewModel.activeWindow.sourceLabel ?? "Unknown"}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    viewModel.activeWindow.sourceLabel ?? "Unknown"
                  )}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}

        <section>
          <article className="rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-500">{translateUI("currentStatus", locale)}</p>
                <h2 className="mt-1 text-2xl font-semibold text-slate-950 leading-tight break-words text-balance">
                  <span className="block">{translateUI("randomReset", locale)}</span>
                  <span className="block mt-1 text-lg sm:mt-0 sm:inline">
                    {translateUI("expectationLabel", locale)}{locale === "en" ? ": " : "："}{isDataUnavailable ? translateUI("unknownProbability", locale) : viewModel.expectation}
                  </span>
                </h2>
              </div>
              <Gauge className="h-7 w-7 text-teal-700" />
            </div>

            <div className="mt-4 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(28rem,1.1fr)]">
              <ProbabilityMetrics
                className="grid w-full grid-cols-2 gap-3"
                locale={locale}
                probability24h={probability24h}
                probability48h={probability48h}
              />

              <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-2">
                <ObservationStatusItem
                  icon={Bell}
                  label={translateUI("officialNoticeStatus", locale)}
                  value={officialNoticeValue}
                />
                <ObservationStatusItem
                  icon={MessageCircle}
                  label={translateUI("resetTeaserStatus", locale)}
                  value={getResetTeaserStatusLabel(resetTeaserStatus, locale)}
                />
                <ObservationStatusItem
                  icon={AlertTriangle}
                  label={translateUI("codexIncidentStatus", locale)}
                  value={getIncidentStatusLabel(incidentStatus, locale)}
                />
                <ObservationStatusItem
                  icon={Clock3}
                  label={translateUI("elapsedSinceRandomResetShort", locale)}
                  value={elapsedSinceLastReset}
                />
              </dl>
            </div>

            <dl className="mt-4 space-y-3">
              {activeManualOutlook || compactOutlookReason ? (
                <RecommendationRow
                  reason={
                    activeManualOutlook ? (
                      activeManualOutlook.message
                    ) : timedTeaserOutlook ? (
                      <TimedTeaserOutlook
                        template={timedTeaserOutlook.template}
                        startAt={timedTeaserOutlook.startAt}
                        endAt={timedTeaserOutlook.endAt}
                        locale={locale}
                      />
                    ) : (
                      compactOutlookReason
                    )
                  }
                  locale={locale}
                  manualOutlook={
                    activeManualOutlook
                      ? {
                          ...activeManualOutlook,
                          systemReason: activeManualOutlook.showSystemReasonBelow
                            ? timedTeaserOutlook ? (
                                <TimedTeaserOutlook
                                  template={timedTeaserOutlook.template}
                                  startAt={timedTeaserOutlook.startAt}
                                  endAt={timedTeaserOutlook.endAt}
                                  locale={locale}
                                />
                              ) : compactOutlookReason
                            : undefined,
                        }
                      : null
                  }
                />
              ) : null}
            </dl>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 border-t border-slate-100 pt-2 text-xs text-slate-500 sm:text-sm lg:justify-end">
              <span className="font-normal">
                {translateUI("lastSuccessfulRefresh", locale)}{locale === "en" ? ": " : "："}
              </span>
              <LocalizedDateTime
                value={state.fetchedAt}
                locale={locale}
                timeClassName="font-normal text-slate-700"
              />
            </div>
          </article>

        </section>

        {shouldRenderRelatedTibo ? tiboActivityCard : null}

        {!isDataUnavailable &&
        viewModel.regularResetForecast.isNoticeWindow &&
        viewModel.regularResetForecast.expectedAt ? (
          <section className="rounded-lg border border-slate-200 bg-white/80 p-4 text-slate-700 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500">
                  {translateUI("nextRegularResetReference", locale)}
                </p>
                <h2 className="mt-1 flex flex-wrap items-baseline text-lg font-semibold text-slate-950 sm:text-xl">
                  <LocalizedDateTime
                    value={viewModel.regularResetForecast.expectedAt}
                    locale={locale}
                  />
                  <span className="ml-2 text-sm font-medium text-slate-500 sm:text-base">
                    {locale === "en"
                      ? `(${viewModel.regularResetForecast.remaining})`
                      : `（${viewModel.regularResetForecast.remaining}）`}
                  </span>
                </h2>
              </div>
              <p className="text-balance text-sm leading-6 text-slate-500 sm:max-w-lg sm:text-right">
                {translateUI("regularResetReferenceNote", locale)}
              </p>
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border border-slate-200 bg-white/90 p-3 sm:p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-500">
                {translateUI("resetHistory", locale)}
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950 sm:text-2xl">
                {translateUI("recentResetEvents", locale)}
              </h2>
            </div>
            <History className="h-6 w-6 text-slate-700 sm:h-7 sm:w-7" />
          </div>

          <div className="mt-4 space-y-3 sm:mt-5 sm:space-y-0 sm:divide-y sm:divide-slate-100">
            {visibleHistory.length > 0 ? (
              visibleHistory.map((item, index) => (
                <div
                  className={`${index >= 7 ? "hidden sm:grid" : "grid"} gap-3 rounded-md border border-l-4 border-slate-200/90 border-l-teal-500 bg-slate-50/60 p-3 shadow-sm sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0 sm:py-4 sm:shadow-none sm:first:pt-0 sm:last:pb-0 md:grid-cols-[1fr_auto]`}
                  key={item.key}
                >
                  <div>
                    <h3 className="ui-heading text-lg font-bold text-slate-950 sm:text-base sm:font-semibold">
                      {getHistoryDisplayTitle(item, locale)}
                    </h3>
                    <ResetHistoryDetails
                      item={item}
                      locale={locale}
                      compact
                      hideReasonOnMobile
                      hideNoticeType
                      hideNoticeToExecutionOnMobile
                      hideNoteOnMobile
                    />
                    {item.details?.cycleType === translateDynamic("定期リセット", locale) ? (
                      <p className="mt-2 text-xs leading-5 text-slate-500 sm:hidden">
                        {translateUI("regularResetTimingNote", locale)}
                      </p>
                    ) : null}
                  </div>
                  <div className="border-t border-slate-200/80 pt-3 text-sm leading-6 text-slate-700 sm:border-t-0 sm:pt-0 md:text-right">
                    <div className="sm:grid sm:grid-cols-[auto_auto] sm:justify-end sm:gap-x-3">
                      {item.signalLabel && hasPriorSignal(item.signalAt, item.resetAt) ? (
                        <div className="hidden sm:contents">
                          <span className="text-slate-600">
                            {item.signalLabel}{locale === "en" ? ": " : "："}
                          </span>
                          <span className="tabular-nums">
                            <LocalizedDateTime value={item.signalAt} locale={locale} />
                          </span>
                        </div>
                      ) : null}
                      {item.resetAt || item.resetLabel ? (
                        <div className="sm:contents">
                          <span className="text-slate-600">
                            {translateDynamic(item.resetLabel, locale)}{locale === "en" ? ": " : "："}
                          </span>
                          <span className="tabular-nums font-bold text-slate-900 sm:font-normal sm:text-slate-700">
                            <LocalizedDateTime
                              value={item.resetAt}
                              locale={locale}
                              approximate={false}
                              className="font-bold text-slate-900 sm:font-normal sm:text-slate-700"
                            />
                          </span>
                        </div>
                      ) : null}
                    </div>
                    {item.details?.cycleType !== translateDynamic("定期リセット", locale) && isSafeHttpUrl(item.source) ? (
                      <div className="sm:text-right">
                        <a
                          className="inline-flex items-center gap-1 font-semibold text-teal-700 underline-offset-4 hover:underline"
                          href={item.source ?? undefined}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {translateUI("source", locale)}
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-600">
                {translateUI("noHistory", locale)}
              </p>
            )}
          </div>

          {visibleHistory.length > 0 ? (
            <div className="mt-5 flex justify-center border-t border-slate-100 pt-4">
              <Link
                className="inline-flex items-center gap-1 text-sm font-semibold text-teal-700 underline-offset-4 hover:underline hover:text-teal-800 transition"
                href={locale === "ja" ? "/history" : `/${locale}/history`}
              >
                {translateUI("viewAllHistoryLink", locale)}
              </Link>
            </div>
          ) : null}
        </section>

        <RandomResetTimeHeatmap
          eventTimes={randomResetHeatmapEventTimes}
          locale={locale}
        />

        {!shouldRenderRelatedTibo ? tiboActivityCard : null}

        <section
          aria-labelledby="homepage-explanation-title"
          className="border-t border-slate-200/80 pt-5 text-sm leading-6 text-slate-600"
        >
          <h2
            id="homepage-explanation-title"
            className="text-base font-semibold leading-6 text-slate-800"
          >
            {homepageExplanation.title}
          </h2>
          <div className="mt-2 space-y-3">
            {homepageExplanation.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <nav
            aria-label={homepageExplanation.title}
            className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm"
          >
            {homepageExplanation.links.map((link) => (
              <Link
                className="font-semibold text-teal-700 underline-offset-4 hover:underline"
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </section>

        <ObservationGuide locale={locale} />

        <footer className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
          <nav
            aria-label={SITE_NAME}
            className="flex flex-wrap gap-3 text-sm text-slate-300"
          >
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/about" : `/${locale}/about`}>
              {translateUI("about", locale)}
            </Link>
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/faq" : `/${locale}/faq`}>
              {translateUI("faq", locale)}
            </Link>
            <Link className="underline-offset-4 hover:underline" href={locale === "ja" ? "/history" : `/${locale}/history`}>
              {translateUI("history", locale)}
            </Link>
            {locale === "ja" ? (
              <>
                <Link className="underline-offset-4 hover:underline" href="/en">
                  English
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/zh">
                  简体中文
                </Link>
              </>
            ) : locale === "en" ? (
              <>
                <Link className="underline-offset-4 hover:underline" href="/">
                  日本語
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/zh">
                  简体中文
                </Link>
              </>
            ) : (
              <>
                <Link className="underline-offset-4 hover:underline" href="/">
                  日本語
                </Link>
                <Link className="underline-offset-4 hover:underline" href="/en">
                  English
                </Link>
              </>
            )}
          </nav>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs text-slate-400">
            <DeveloperLink
              locale={locale}
              className="text-xs text-slate-400 hover:text-white"
            />
            <a
              className="transition-colors hover:text-white"
              href="https://gussuriworks.com/"
              rel="noopener noreferrer"
              target="_blank"
            >
              by Gussuri Works
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}

function RecommendationRow({
  reason,
  locale = "ja",
  manualOutlook,
}: {
  reason: React.ReactNode;
  locale?: Locale;
  manualOutlook?: (ActiveManualOutlook & { systemReason?: React.ReactNode }) | null;
}) {
  if (manualOutlook) {
    const isAlert = manualOutlook.style === "alert";
    const isWarning = manualOutlook.style === "warning";

    const containerStyle = isAlert
      ? "border-red-300 bg-red-50/80 shadow-xs"
      : isWarning
        ? "border-amber-300 bg-amber-50/80 shadow-xs"
        : "border-sky-300 bg-sky-50/80 shadow-xs";

    const badgeStyle = isAlert
      ? "bg-red-600 text-white"
      : isWarning
        ? "bg-amber-600 text-white"
        : "bg-sky-600 text-white";

    const titleColor = isAlert
      ? "text-red-900"
      : isWarning
        ? "text-amber-900"
        : "text-sky-900";

    const textColor = isAlert
      ? "text-red-950"
      : isWarning
        ? "text-amber-950"
        : "text-sky-950";

    return (
      <div className={`rounded-lg border p-3.5 sm:p-4 ${containerStyle}`}>
        <div className="flex flex-col gap-2.5">
          <dt className="flex items-center gap-2 text-base font-semibold">
            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${badgeStyle}`}
            >
              {manualOutlook.badge}
            </span>
            <span className={titleColor}>
              {translateUI("forecastOutlook", locale)}
            </span>
          </dt>
          <dd className="min-w-0">
            <p className={`text-base font-medium leading-relaxed ${textColor}`}>
              {reason}
            </p>
            {manualOutlook.systemReason ? (
              <div className="mt-3 border-t border-red-200/60 pt-2 text-xs font-normal text-slate-600 sm:text-sm">
                <span className="font-semibold text-slate-700">
                  {translateUI("manualOutlookStandardForecast", locale)}
                  {locale === "en" ? ": " : "："}
                </span>
                <span>{manualOutlook.systemReason}</span>
              </div>
            ) : null}
          </dd>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 pt-4 sm:grid sm:grid-cols-[7rem_1fr] sm:items-start sm:gap-6">
      <dt className="whitespace-nowrap text-base font-medium text-slate-500">
        {translateUI("forecastOutlook", locale)}
      </dt>
      <dd className="text-base leading-6 text-slate-700">
        {reason}
      </dd>
    </div>
  );
}
