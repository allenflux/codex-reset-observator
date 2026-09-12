import { getLocalRadarData } from "../lib/radar";
import {
  classifyTiboTweet,
  type ClassificationResult,
  type ClassificationSignalType,
} from "../lib/radar/classification";
import {
  applyTiboClassificationSafetyGuard,
  buildGeminiPrompt,
  type GeminiClassificationOutput,
} from "../lib/radar/geminiClassification";
import {
  selectTiboClassification,
  type SelectedTiboClassification,
} from "../lib/radar/tiboClassificationMode";
import {
  parseTeaserStrengthAssessment,
  type ResetTeaserStatus,
} from "../lib/radar/teaserStrength";
import {
  getTemporalNoticeExpiry,
  parseTiboTemporalSemantics,
  resolveTiboTemporalSchedule,
  TIBO_SOURCE_TIME_ZONE,
  type TemporalKind,
  type TemporalPrecision,
  type TemporalResolutionStatus,
  type TiboTemporalResolution,
} from "../lib/radar/tiboTemporal";
import {
  convertTiboResetSignalToHistoryEvent,
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { ActiveTiboSignal, PublicRadarSnapshot, RadarData } from "../lib/radar/types";

export type TiboScenarioExpected = {
  signalType?: ClassificationSignalType;
  temporalDirection?: "future" | "completed_now" | "historical" | "unclear";
  teaserStrength?: "strong" | "weak" | "none";
  temporalResolutionStatus?: TemporalResolutionStatus;
  temporalPrecision?: TemporalPrecision;
  expectedStartAt?: string | null;
  expectedEndAt?: string | null;
  shouldCreateActiveNotice?: boolean;
  shouldCreateTeaser?: boolean;
  shouldCreateResetHistoryEvent?: boolean;
  shouldAffectProbability?: boolean;
  shouldRemainActive?: boolean;
  shouldBeDeduplicated?: boolean;
  shouldBeRejected?: boolean;
};

export type TiboScenarioMockGeminiOutput = Partial<
  Pick<
    GeminiClassificationOutput,
    | "signalType"
    | "confidence"
    | "temporalDirection"
    | "evidenceQuote"
    | "reasonJa"
    | "teaserStrength"
    | "teaserStrengthConfidence"
    | "teaserStrengthEvidenceQuote"
    | "teaserStrengthReasonJa"
    | "futureSignal"
    | "temporalExpression"
    | "temporalKind"
    | "temporalPrecision"
    | "weekday"
    | "relativeDayOffset"
    | "relativeAmount"
    | "relativeUnit"
    | "explicitDateParts"
    | "explicitTimeParts"
    | "daypart"
    | "rangeKind"
    | "explicitTimezone"
    | "temporalConfidence"
  >
>;

export type TiboScenario = {
  id: string;
  category: string;
  description: string;
  tweetText: string;
  tweetCreatedAt: string;
  tweetUrl: string;
  isReply?: boolean;
  replyToHandles?: string[];
  replyContextText?: string | null;
  isQuote?: boolean;
  quoteAuthorHandle?: string | null;
  quoteContextText?: string | null;
  quoteTweetUrl?: string | null;
  sourceTimeline?: "profile" | "with_replies";
  expected: TiboScenarioExpected;
  ambiguous?: boolean;
  pipeline?: boolean;
  metamorphicGroup?: string;
  regressionGroup?: string;
  mockGeminiOutput?: TiboScenarioMockGeminiOutput;
};

export type TiboScenarioFixture = {
  schemaVersion: number;
  scenarios: TiboScenario[];
};

export type TiboScenarioRun = {
  scenario: TiboScenario;
  now: Date;
  ruleResult: ClassificationResult;
  geminiResult: GeminiClassificationOutput | null;
  selected: SelectedTiboClassification;
  teaserStatus: ResetTeaserStatus;
  temporalResolution: TiboTemporalResolution | null;
  activeSignal: ActiveTiboSignal;
  formalSignal: FormalTiboResetSignal;
  formalAccepted: boolean;
  historyEvent: ReturnType<typeof convertTiboResetSignalToHistoryEvent> | null;
  radarData: RadarData;
  publicSnapshot: PublicRadarSnapshot;
};

function defaultEvidence(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? text.trim();
  return firstLine.slice(0, 240) || null;
}

export function buildFixedGeminiOutput(scenario: TiboScenario): GeminiClassificationOutput {
  const expectedSignal = scenario.expected.signalType ?? "irrelevant";
  const expectedDirection = scenario.expected.temporalDirection ?? "unclear";
  const expectedTeaser = scenario.expected.teaserStrength ?? null;
  const mock = scenario.mockGeminiOutput ?? {};
  const evidenceQuote = mock.evidenceQuote ?? defaultEvidence(scenario.tweetText);

  return {
    signalType: mock.signalType ?? expectedSignal,
    confidence: mock.confidence ?? 0.98,
    temporalDirection: mock.temporalDirection ?? expectedDirection,
    evidenceQuote,
    reasonJa: mock.reasonJa ?? `Scenario fixture: ${scenario.description}`,
    resetTypeJa: null,
    noticeToExecution: null,
    teaserStrength: mock.teaserStrength ?? expectedTeaser,
    teaserStrengthConfidence: mock.teaserStrengthConfidence ?? (expectedTeaser ? 0.92 : null),
    teaserStrengthEvidenceQuote:
      mock.teaserStrengthEvidenceQuote ?? (expectedTeaser ? defaultEvidence(scenario.tweetText) : null),
    teaserStrengthReasonJa:
      mock.teaserStrengthReasonJa ?? (expectedTeaser ? "Fixture-defined UI-only teaser strength." : null),
    futureSignal: mock.futureSignal ?? null,
    temporalExpression: mock.temporalExpression ?? null,
    temporalKind: mock.temporalKind ?? (scenario.expected.temporalResolutionStatus ? "vague" : "none"),
    temporalPrecision: mock.temporalPrecision ?? scenario.expected.temporalPrecision ?? "unknown",
    weekday: mock.weekday ?? null,
    relativeDayOffset: mock.relativeDayOffset ?? null,
    relativeAmount: mock.relativeAmount ?? null,
    relativeUnit: mock.relativeUnit ?? null,
    explicitDateParts: mock.explicitDateParts ?? null,
    explicitTimeParts: mock.explicitTimeParts ?? null,
    daypart: mock.daypart ?? null,
    rangeKind: mock.rangeKind ?? null,
    explicitTimezone: mock.explicitTimezone ?? null,
    temporalConfidence: mock.temporalConfidence ?? (scenario.expected.temporalResolutionStatus ? 0.9 : 0),
    model: "fixture-gemini",
    status: "success",
    classifiedAt: scenario.tweetCreatedAt,
  };
}

export function getScenarioNow(scenario: TiboScenario) {
  const created = new Date(scenario.tweetCreatedAt);
  const offset = scenario.expected.temporalResolutionStatus === "resolved" ? 30 * 60_000 : 60 * 60_000;
  return new Date(created.getTime() + offset);
}

function buildActiveSignal(
  scenario: TiboScenario,
  selected: SelectedTiboClassification,
  geminiResult: GeminiClassificationOutput | null,
  temporalResolution: TiboTemporalResolution | null,
) {
  const createdAt = scenario.tweetCreatedAt;
  const expiresAt = temporalResolution
    ? getTemporalNoticeExpiry(temporalResolution, createdAt)
    : new Date(Date.parse(createdAt) + 24 * 60 * 60_000).toISOString();
  const teaser = geminiResult
    ? parseTeaserStrengthAssessment(geminiResult, scenario.tweetText)
    : null;

  return {
    tweet_id: scenario.tweetUrl.match(/\/status\/(\d+)/)?.[1] ?? scenario.id,
    signal_type: selected.signalType,
    text: scenario.tweetText,
    tweet_url: scenario.tweetUrl,
    tweet_created_at: createdAt,
    detected_at: createdAt,
    expires_at: expiresAt ?? undefined,
    verification_status: scenario.expected.shouldBeRejected ? "rejected" : "auto_unverified",
    confidence: selected.confidence,
    classification_reason: selected.reason,
    teaser_strength: teaser?.teaserStrength ?? null,
    ai_temporal_expression: geminiResult?.temporalExpression ?? null,
    ai_temporal_kind: geminiResult?.temporalKind ?? null,
    ai_temporal_precision: geminiResult?.temporalPrecision ?? null,
    ai_temporal_timezone: temporalResolution?.timezone ?? null,
    ai_temporal_confidence: temporalResolution?.confidence ?? null,
    expected_start_at: temporalResolution?.expectedStartAt ?? null,
    expected_end_at: temporalResolution?.expectedEndAt ?? null,
    temporal_resolution_status: temporalResolution?.status ?? null,
    temporal_resolution_version: temporalResolution?.version ?? null,
    is_reply: scenario.isReply ?? false,
    is_quote: scenario.isQuote ?? false,
    quote_context_text: scenario.quoteContextText ?? null,
    quote_tweet_url: scenario.quoteTweetUrl ?? null,
    quote_author_handle: scenario.quoteAuthorHandle ?? null,
    reply_to_handles: scenario.replyToHandles ?? null,
    reply_context_text: scenario.replyContextText ?? null,
  } satisfies ActiveTiboSignal;
}

function buildFormalSignal(
  activeSignal: ActiveTiboSignal,
  selected: SelectedTiboClassification,
  geminiResult: GeminiClassificationOutput | null,
  scenario: TiboScenario,
): FormalTiboResetSignal {
  return {
    ...activeSignal,
    text: activeSignal.text ?? scenario.tweetText,
    tweet_url: activeSignal.tweet_url ?? scenario.tweetUrl,
    tweet_created_at: activeSignal.tweet_created_at,
    signal_type: selected.signalType,
    confidence: selected.confidence,
    verification_status: scenario.expected.shouldBeRejected ? "rejected" : "auto_unverified",
    classification_source: selected.classificationSource,
    rule_signal_type: activeSignal.signal_type,
    ai_signal_type: geminiResult?.signalType ?? null,
    ai_classification_status: geminiResult?.status ?? "skipped",
    ai_reset_type_ja: geminiResult?.resetTypeJa ?? null,
    ai_notice_to_execution: geminiResult?.noticeToExecution ?? null,
    ai_teaser_strength: activeSignal.teaser_strength ?? null,
    ai_teaser_strength_confidence: geminiResult?.teaserStrengthConfidence ?? null,
    ai_teaser_strength_evidence_quote: geminiResult?.teaserStrengthEvidenceQuote ?? null,
    ai_teaser_strength_reason_ja: geminiResult?.teaserStrengthReasonJa ?? null,
    ai_temporal_expression: activeSignal.ai_temporal_expression ?? null,
    ai_temporal_kind: activeSignal.ai_temporal_kind ?? null,
    ai_temporal_precision: activeSignal.ai_temporal_precision ?? null,
    ai_temporal_timezone: activeSignal.ai_temporal_timezone ?? null,
    ai_temporal_confidence: activeSignal.ai_temporal_confidence ?? null,
    expected_start_at: activeSignal.expected_start_at ?? null,
    expected_end_at: activeSignal.expected_end_at ?? null,
    temporal_resolution_status: activeSignal.temporal_resolution_status ?? null,
    temporal_resolution_version: activeSignal.temporal_resolution_version ?? null,
    is_reply: scenario.isReply ?? false,
    is_quote: scenario.isQuote ?? false,
    quote_context_text: scenario.quoteContextText ?? null,
    quote_tweet_url: scenario.quoteTweetUrl ?? null,
    quote_author_handle: scenario.quoteAuthorHandle ?? null,
    reply_to_handles: scenario.replyToHandles ?? null,
    reply_context_text: scenario.replyContextText ?? null,
    source_timeline: scenario.sourceTimeline ?? "profile",
  };
}

export function runTiboScenario(scenario: TiboScenario, now = getScenarioNow(scenario)): TiboScenarioRun {
  const ruleResult = classifyTiboTweet(scenario.tweetText, scenario.tweetUrl, {
    isReply: scenario.isReply,
    isQuote: scenario.isQuote,
  });
  const geminiResult = scenario.pipeline
    ? applyTiboClassificationSafetyGuard(scenario.tweetText, buildFixedGeminiOutput(scenario))
    : null;
  const selected = selectTiboClassification(scenario.pipeline ? "primary" : "off", ruleResult, geminiResult);
  const semantics = geminiResult ? parseTiboTemporalSemantics(geminiResult, scenario.tweetText) : null;
  const temporalResolution = selected.signalType === "official_notice" && semantics
    ? resolveTiboTemporalSchedule(semantics, scenario.tweetCreatedAt, TIBO_SOURCE_TIME_ZONE)
    : null;
  const activeSignal = buildActiveSignal(scenario, selected, geminiResult, temporalResolution);
  const formalSignal = buildFormalSignal(activeSignal, selected, geminiResult, scenario);
  const formalAccepted = isFormalTiboResetSignal(formalSignal);
  const historyEvent = formalAccepted ? convertTiboResetSignalToHistoryEvent(formalSignal) : null;
  const recentSignals = [activeSignal];
  const radarData = getLocalRadarData({
    calculationNow: now,
    checkedAt: now.toISOString(),
    activeTiboSignals: selected.signalType === "irrelevant" ? [] : [activeSignal],
    recentTiboSignals: recentSignals,
    formalTiboResets: formalAccepted ? [formalSignal] : [],
    rejectedTiboResets: scenario.expected.shouldBeRejected
      ? [{ tweet_id: activeSignal.tweet_id, tweet_url: activeSignal.tweet_url, tweet_created_at: activeSignal.tweet_created_at }]
      : [],
  });
  const publicSnapshot = toPublicRadarSnapshot(radarData, "ja", {
    calculationNow: now,
    limitHistory: false,
  });

  return {
    scenario,
    now,
    ruleResult,
    geminiResult,
    selected,
    teaserStatus: publicSnapshot.resetTeaserStatus ?? "unknown",
    temporalResolution,
    activeSignal,
    formalSignal,
    formalAccepted,
    historyEvent,
    radarData,
    publicSnapshot,
  };
}

export function buildGeminiScenarioInput(scenario: TiboScenario) {
  return {
    text: scenario.tweetText,
    tweetCreatedAt: scenario.tweetCreatedAt,
    isReply: scenario.isReply,
    replyToHandles: scenario.replyToHandles,
    replyContextText: scenario.replyContextText ?? null,
    sourceTimeline: scenario.sourceTimeline,
    isQuote: scenario.isQuote,
    quoteAuthorHandle: scenario.quoteAuthorHandle ?? null,
    quoteContextText: scenario.quoteContextText ?? null,
    quoteTweetUrl: scenario.quoteTweetUrl ?? null,
    sourceTimeZone: TIBO_SOURCE_TIME_ZONE,
  };
}

export function buildScenarioPrompt(scenario: TiboScenario) {
  return buildGeminiPrompt(buildGeminiScenarioInput(scenario));
}
