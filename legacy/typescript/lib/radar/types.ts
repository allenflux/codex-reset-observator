import type { OpenAIStatusHistoryItem } from "@/lib/openaiStatus";
import type {
  FormalTiboResetSignal,
  RejectedTiboResetSignal,
} from "./tiboHistory";
import type { TeaserStrength } from "./teaserStrength";
import type { TiboSecondarySignal } from "./tiboSecondarySignal";
import type {
  TemporalKind,
  TemporalPrecision,
  TemporalResolutionSource,
  TemporalResolutionStatus,
} from "./tiboTemporal";
import type { RegularResetEventRow } from "./regularResetSchedule";
import type { TiboEditIdentityFields } from "./tiboEditIdentity";
import type {
  CodexRecoveryObservation,
  PublicRecoveryObservation,
} from "../codexUsageRecovery";
import type {
  ExecutionTimePrecision,
  ResetExecutionEstimate,
} from "./resetExecution";
import type { TiboFormalAdoptionRecord } from "./tiboFormalAdoptionStore";

export type Locale = "ja" | "en" | "zh";

export type CodexOperationalStatus = "active" | "recovered" | "none" | "unknown";

export type LocalizedString =
  | string
  | {
      ja: string;
      en?: string;
      zh?: string;
    };

export type ProbabilityLevel = "low" | "medium" | "high" | "very_high";

export type ResetCycleType =
  | "ランダムリセット"
  | "定期リセット"
  | "個人別リセット";

export type ResetReasonType =
  | "ご祝儀リセット"
  | "詫びリセット"
  | "定期更新";

export type HistoryNoticeType =
  | "公式予告あり"
  | "公式告知あり"
  | "告知投稿あり"
  | "匂わせ投稿あり"
  | "予告あり"
  | "予告なし"
  | "なし";

export type ResetMethodType =
  | "強制リセット"
  | "任意リセット権配布"
  | "利用上限更新"
  | "リセット実施";

export type ResetScopeType =
  | "全有料プラン"
  | "全ユーザー"
  | "任意リセット未使用アカウント";

export type HistoryRecordKind =
  | "confirmed_global"
  | "banked_distribution"
  | "reference"
  | "regular_completed";

export type HistorySourceKind =
  | "direct_post"
  | "profile"
  | "official_status"
  | "none";

export type ResetDisplayNameRecord = {
  event_key: string;
  source_tweet_id: string | null;
  manual_name_ja: string | null;
  manual_name_en?: string | null;
  manual_name_zh?: string | null;
  ai_name_ja: string | null;
  ai_name_en?: string | null;
  ai_name_zh?: string | null;
  ai_confidence: number | null;
  ai_evidence: string | null;
  ai_reason: string | null;
  ai_model: string | null;
  ai_prompt_version: string | null;
  ai_input_mode: string | null;
  ai_status: string | null;
  ai_flags: string[] | null;
  ai_generated_at: string | null;
  input_hash: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ResetHistoryDetails = {
  cycleType: ResetCycleType | string;
  reasonType?: ResetReasonType | string;
  resetMethod: ResetMethodType | string;
  scope: ResetScopeType | string;
  noticeToExecution: string;
  noticeType?: HistoryNoticeType | string;
  note?: LocalizedString | null;
};

export type LocalizedResetHistoryDetails = Omit<ResetHistoryDetails, "note"> & {
  note?: string | null;
};

export type CanonicalResetHistoryDetails = Omit<
  ResetHistoryDetails,
  "cycleType" | "reasonType" | "resetMethod" | "scope" | "noticeType"
> & {
  cycleType: ResetCycleType;
  reasonType: ResetReasonType;
  resetMethod?: ResetMethodType | string;
  scope?: ResetScopeType | string;
  noticeType?: HistoryNoticeType | string;
};

export type WindowLike = {
  id?: string;
  guid?: string;
  title?: LocalizedString;
  status?: string;
  opened_at?: string | null;
  closed_at?: string | null;
  completed_at?: string | null;
  date?: string | null;
  window_minutes?: number;
  window_human?: string;
  scopeLabel?: string;
  scope?: string;
  summary?: LocalizedString;
  source?: string | null;
  source_url?: string | null;
  sourceKind?: HistorySourceKind;
  sourceTweetIds?: string[];
  /** Internal trusted X logical-post identity used to keep separate posts apart. */
  tiboLogicalPostId?: string;
  /** Internal probability-target marker; intentionally omitted from public DTOs. */
  randomResetTargetScope?: "conditional";
  recordKind?: HistoryRecordKind;
  presentation?: "notice_backed_recovery";
  officialNoticeTweetId?: string;
  recoveryObservationId?: string;
  link?: string | null;
  sources?: Array<{
    type?: string;
    url?: string | null;
  }>;
  windowLabel?: string;
  details?: ResetHistoryDetails;
};

export type WindowEventLike = WindowLike & {
  kind?: string;
  date?: string | null;
  label?: string;
};

export type SignalSummaryLike = {
  observation_total?: number;
  candidate_total?: number;
  new_total?: number;
  seen_total?: number;
  observation_counts?: Record<string, number>;
  new_counts?: Record<string, number>;
  total?: number;
  counts?: Record<string, number>;
};

export type ActiveTiboSignal = TiboEditIdentityFields & {
  tweet_id: string;
  signal_type: "official_notice" | "reset_executed" | "teaser" | "irrelevant";
  text?: string;
  tweet_url?: string;
  tweet_created_at: string;
  detected_at?: string;
  expires_at?: string;
  verification_status?: "auto_unverified" | "confirmed" | "rejected";
  confidence?: number;
  classification_reason?: string;
  classification_source?: string | null;
  teaser_strength?: TeaserStrength | null;
  ai_teaser_strength?: TeaserStrength | null;
  secondary_signal?: TiboSecondarySignal | null;
  is_secondary_future_signal?: boolean;
  parent_tweet_id?: string;
  primary_event_at?: string;
  translated_text_ja?: string | null;
  translated_text_zh?: string | null;
  ai_temporal_expression?: string | null;
  ai_temporal_kind?: TemporalKind | null;
  ai_temporal_direction?: string | null;
  ai_temporal_precision?: TemporalPrecision | null;
  ai_temporal_timezone?: string | null;
  ai_temporal_confidence?: number | null;
  temporal_expression?: string | null;
  temporal_kind?: TemporalKind | null;
  temporal_precision?: TemporalPrecision | null;
  temporal_timezone?: string | null;
  temporal_confidence?: number | null;
  temporal_resolution_source?: TemporalResolutionSource | null;
  expected_start_at?: string | null;
  expected_end_at?: string | null;
  temporal_resolution_status?: TemporalResolutionStatus | null;
  temporal_resolution_version?: string | null;
  is_reply?: boolean;
  is_quote?: boolean;
  quote_context_text?: string | null;
  quote_tweet_url?: string | null;
  quote_author_handle?: string | null;
  reply_to_handles?: string[] | null;
  reply_context_text?: string | null;
};

export type PublicTiboActivity = {
  classification: "official_notice" | "reset_executed" | "teaser" | "irrelevant";
  teaserStrength: TeaserStrength | null;
  text: string | null;
  createdAt: string;
  sourceUrl: string | null;
  isReply: boolean;
  replyContextText: string | null;
  replyToHandles: string[];
  temporalResolutionStatus?: TemporalResolutionStatus | null;
  expectedStartAt?: string | null;
  expectedEndAt?: string | null;
};

export type DataSourceState = "ok" | "degraded" | "misconfigured";

export type DataSourceDetail =
  | "missing_configuration"
  | "request_failed"
  | "invalid_response"
  | "database_error"
  | "partial_response";

export type DataSourceHealth = {
  state: DataSourceState;
  detail?: DataSourceDetail;
};

export type DataFetchResult<T> = {
  data: T;
  health: DataSourceHealth;
};

export type RadarDataHealth = {
  overall: "ok" | "degraded";
  checkedAt: string;
  sources: {
    supabaseSignals: DataSourceHealth;
    openAIStatus: DataSourceHealth;
  };
};

export type RadarData = {
  data?: RadarData;
  result?: RadarData;
  current?: RadarData;
  schema_version?: string;
  service?: string;
  purpose?: string;
  timezone?: string;
  checked_at?: string;
  data_health?: RadarDataHealth;
  monitored_at?: string;
  updated_at?: string;
  status?: string;
  window_open?: boolean;
  message?: string;
  recommended_action?: string;
  window?: WindowLike & {
    open?: boolean;
    action?: string;
    message?: string;
    source_url?: string | null;
  };
  current_window?: {
    state?: string;
    message?: string;
    opened_at?: string | null;
    source?: string | null;
  };
  last_window?: WindowLike;
  latest_reset?: WindowLike;
  last_reset?: WindowLike;
  latest_window?: WindowLike;
  recent_windows?: Array<WindowLike>;
  metrics?: {
    last_3_months_window_minutes?: number;
    last_3_months_window_human?: string;
  };
  prediction?: {
    level?: ProbabilityLevel | string;
    probability_12h?: number;
    probability12h?: number;
    probability_12_hours?: number;
    probability_24h?: number;
    probability24h?: number;
    probability_24_hours?: number;
    probability_48h?: number;
    probability48h?: number;
    probability_48_hours?: number;
    probability_72h?: number;
    probability72h?: number;
    probability_72_hours?: number;
    expected_window?: string;
    summary?: string;
    summary_en?: string;
    reasoning_summary?: string;
    display_summary?: string;
    display_summary_en?: string;
    updated_at?: string;
    signal_summary_24h?: SignalSummaryLike;
    probability_history?: {
      events?: Array<WindowEventLike>;
    };
    cooldown?: {
      active?: boolean;
      until?: string | null;
    };
    should_notify?: boolean;
  };
  probabilities?: {
    probability_12h?: number;
    probability12h?: number;
    within_12h?: number;
    "12h"?: number;
    probability_24h?: number;
    probability24h?: number;
    probability_48h?: number;
    probability48h?: number;
    probability_72h?: number;
    probability72h?: number;
    within_72h?: number;
    within_24h?: number;
    within_48h?: number;
    "24h"?: number;
    "48h"?: number;
  };
  links?: {
    html?: string;
    rss?: string;
  };
  openai_status_history?: Array<OpenAIStatusHistoryItem>;
  active_tibo_signals?: Array<ActiveTiboSignal>;
  recent_tibo_signals?: Array<ActiveTiboSignal>;
  formal_tibo_resets?: Array<FormalTiboResetSignal>;
  rejected_tibo_resets?: Array<RejectedTiboResetSignal>;
  regular_reset_events?: Array<RegularResetEventRow>;
  codex_usage_recovery?: CodexRecoveryObservation | null;
  codex_recovery_observations?: Array<CodexRecoveryObservation>;
  reset_execution_estimates?: Array<ResetExecutionEstimate>;
  tibo_formal_adoptions?: Array<TiboFormalAdoptionRecord>;
  /** Internal read health for the optional adoption ledger; not public DTO data. */
  tibo_formal_adoptions_health?: DataSourceHealth;
  reset_display_names?: Array<ResetDisplayNameRecord>;
  /** Internal read health for display-name reconciliation; never public DTO data. */
  reset_display_names_health?: DataSourceHealth;
  codex_environment?: {
    updated_at?: string;
    status_incidents_24h?: number;
    official_incident_hints_24h?: number;
    official_updates_24h?: number;
    community_mentions_24h?: number;
    issue_or_limit_anomalies_24h?: number;
    complaint_pressure?: "low" | "medium" | "high" | string;
    complaint_pressure_sources?: Array<string>;
    openai_status_updated_at?: string | null;
    openai_status_active_codex_incidents?: number;
    openai_status_recent_codex_incidents?: number;
    openai_status_affected_codex_components?: number;
    openai_status_incidents_suppressed?: boolean;
    openai_status_latest_codex_incident?: string | null;
    codex_operational_status?: CodexOperationalStatus;
    reset_card?: {
      probability_24h?: number;
      probability_48h?: number;
      level?: ProbabilityLevel | string;
      status?: string;
      note?: string;
    };
  };
};

export type RadarViewModel = {
  status: string;
  expectation: string;
  probability12h?: number;
  probability24h?: number;
  probability48h?: number;
  probability72h?: number;
  action: string;
  lastUpdated?: string | null;
  regularResetForecast: {
    date: string;
    time?: string | null;
    remaining: string;
    sourceResetAt?: string | null;
    expectedAt?: string | null;
    lastCompletedAt?: string | null;
    remainingDays?: number | null;
    isNoticeWindow: boolean;
  };
  activeWindow: {
    active: boolean;
    kind: "official" | "regular" | "none";
    noticeKind?: "forced" | "banked";
    label: string;
    summary: string;
    openedAt?: string | null;
    expectedAt?: string | null;
    expectedEndAt?: string | null;
    expectedPrecision?: TemporalPrecision | null;
    expectedTimeZone?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    forecastDate?: string;
    forecastTime?: string | null;
    remaining?: string;
    isOverduePending?: boolean;
    overdueText?: string | null;
  };
  reasoningSummary: string | null;
  displayReasoningSummary: string | null;
  codexOperationalStatus: CodexOperationalStatus;
  latestWindow: {
    kind: "observed" | "regular";
    recordKind?: HistoryRecordKind;
    title: string;
    summary: string;
    scopeLabel?: string;
    scope: string;
    openedAt?: string | null;
    closedAt?: string | null;
    windowLabel?: string;
    windowLength: string;
    source?: string | null;
    sourceKind?: HistorySourceKind;
  };
  recentHistory: Array<{
    key: string;
    title: string;
    resetType: string;
    resetTypes?: Array<string>;
    status: string;
    details?: LocalizedResetHistoryDetails;
    date?: string | null;
    signalAt?: string | null;
    resetAt?: string | null;
    executionTimePrecision?: ExecutionTimePrecision | null;
    signalLabel: string;
    resetLabel: string;
    scopeLabel?: string;
    scope: string;
    windowLabel?: string;
    windowLength: string;
    source?: string | null;
    sourceKind?: HistorySourceKind;
    recordKind?: HistoryRecordKind;
    summary?: string | null;
  }>;
};

// The browser-facing view model is an explicit projection of the internal
// model. Audit-only action and reasoning fields stay server-side.
export type PublicRadarViewModel = Pick<
  RadarViewModel,
  | "status"
  | "expectation"
  | "probability12h"
  | "probability24h"
  | "probability48h"
  | "probability72h"
  | "lastUpdated"
  | "regularResetForecast"
  | "activeWindow"
  | "displayReasoningSummary"
  | "codexOperationalStatus"
  | "latestWindow"
  | "recentHistory"
>;

export type PublicDataHealth = {
  overall: "ok" | "degraded";
  stale: boolean;
  generatedAt: string;
  sources: {
    supabaseSignals: DataSourceHealth;
    openAIStatus: DataSourceHealth;
  };
};

export type PublicRadarSnapshot = {
  schemaVersion: string;
  checkedAt: string;
  updatedAt: string | null;
  lastRandomResetAt: string | null;
  dataHealth: PublicDataHealth;
  viewModel: PublicRadarViewModel;
  resetTeaserStatus?: TeaserStrength | "unknown";
  latestTiboActivity?: PublicTiboActivity | null;
  recoveryObservation?: PublicRecoveryObservation | null;
};

export type CachedRadarData = {
  schemaVersion: "public-v1";
  locale: Locale;
  data: PublicRadarSnapshot;
  fetchedAt: string;
};
