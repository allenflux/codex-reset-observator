import {
  hasFutureBankedDistributionIntent,
  isBankedDistributionCompletionSignal,
} from "./bankedReset";

export type ClassificationSignalType =
  | "official_notice"
  | "reset_executed"
  | "teaser"
  | "irrelevant";

export type ClassificationResult = {
  signalType: ClassificationSignalType;
  confidence: number;
  reason: string;
  isReply: boolean;
  isQuote: boolean;
};

export type TiboReplyClassificationMetadata = {
  isReply?: boolean;
  isQuote?: boolean;
};

export type TiboClassificationSafetyReason =
  | "non_usage_reset_object"
  | "non_usage_activation"
  | "banked_distribution_completion"
  | "pure_hypothetical"
  | "explicit_negation"
  | "current_execution"
  | "historical_reset"
  | "historical_then_future"
  | "future_reschedule"
  | null;

export type TiboClassificationSafetyDecision = {
  signalType: ClassificationSignalType;
  reasonJa: string | null;
  reasonCode: TiboClassificationSafetyReason;
  suppressTeaserStrength: boolean;
};

const NON_USAGE_RESET_OBJECT_PATTERN = /(?:\b(?:reset|resetting|restart|restarting|reboot|rebooting)\s+(?:the|my|our|a|an)?\s*(?:cache(?:s)?|server(?:s)?|benchmark(?:s)?|model(?:s)?(?:'s)?|conversation(?:s)?|chat(?:s)?|thread(?:s)?|sleep\s+schedule|laptop(?:s)?|database(?:s)?|db|ui|interface|test\s+(?:environment|suite)|app(?:s)?|application(?:s)?)\b|\b(?:cache(?:s)?|server(?:s)?|benchmark(?:s)?|model(?:s)?(?:'s)?|conversation(?:s)?|chat(?:s)?|thread(?:s)?|sleep\s+schedule|laptop(?:s)?|database(?:s)?|db|ui|interface|test\s+(?:environment|suite)|app(?:s)?|application(?:s)?)\s+(?:reset|restart|reboot)\b)/i;
const USAGE_LIMIT_CONTEXT_PATTERN = /\b(?:usage\s+(?:limits?|allowances?)|rate\s+limits?|quotas?|allowances?|capacity|paid\s+users?|all\s+users?|everyone(?:'s)?\s+limits?|fresh\s+limits?|topped\s+up|codex\s+(?:usage\s+)?limits?|chatgpt\s+work\s+(?:usage\s+)?limits?)\b/i;
const NON_USAGE_ACTIVATION_OBJECT_PATTERN = /\b(?:context\s+windows?|features?|models?(?:\s+availability)?|api\s+keys?|chatgpt\s+accounts?|account\s+support|rollouts?|deployments?|availability|products?|settings?|switch)\b/i;
const NON_USAGE_ACTIVATION_ACTION_PATTERN = /\b(?:flipped\s+the\s+switch|turned\s+(?:it|that|this|the)\s+on|enabled|activated|now\s+live|is\s+live|are\s+live|works?\s+(?:through|for|with)|support(?:s|ed)?|rolled\s+out|deployed|released|expanded|extended)\b/i;
const EXPLICIT_USAGE_LIMIT_RESET_PATTERN = /(?:\b(?:usage\s+limits?|rate\s+limits?|quotas?|allowances?|fresh\s+limits?|everyone(?:'s)?\s+limits?)\b[^.!?]{0,100}\b(?:reset|refreshed|topped\s+up|restored|replenished|landed|done|complete(?:d)?)\b|\b(?:reset|refreshed|topped\s+up|restored|replenished|landed|done|complete(?:d)?)\b[^.!?]{0,100}\b(?:usage\s+limits?|rate\s+limits?|quotas?|allowances?|fresh\s+limits?|everyone(?:'s)?\s+limits?)\b)/i;
const PURE_HYPOTHETICAL_PATTERN = /\b(?:what\s+if|would\s+be\s+nice\s+to|imagine\s+if|i\s+wish|if\s+only)\b|\b(?:could|would)\s+use\s+(?:a\s+)?reset\b|\bworld\s+with\s+unlimited\s+resets?\b/i;
const INDEPENDENT_INTENT_AFTER_HYPOTHETICAL_PATTERN = /\b(?:but|however|so)\b[^.!?]{0,100}\b(?:i|we)\s+(?:will|might|may|could)\b/i;
const HISTORICAL_RESET_PATTERN = /\b(?:yesterday|last\s+(?:week|month|night|year)|(?:one|two|three|four|five|six|seven|ten|\d+)\s+days?\s+ago|back\s+in|earlier|old\s+news|previously|remember\s+when|was\s+(?:completed|planned)|the\s+reset\s+button.*history)\b/i;
const UNRELATED_HISTORICAL_REFERENCE_PATTERN = /\b(?:things?|issues?|problems?|fixes?|topics?)\s+(?:mentioned|discussed|found|raised)\s+(?:yesterday|last\s+(?:week|month|night|year))\b/i;
const FUTURE_RESET_PATTERN = /\b(?:will|going\s+to|coming|tonight|tomorrow|later|soon|next|scheduled|planned|in\s+(?:an?|one|two|half\s+an?|\d+)\s+(?:minute|minutes|hour|hours|day|days))\b/i;
const CANCELLATION_PATTERN = /\b(?:no|not|never|cancel(?:led|ed)?|canceled|not\s+anymore|changed\s+my\s+mind|scratch\s+that)\b/i;
const EXPLICIT_FUTURE_RESET_RESCHEDULE_PATTERN =
  /(?:\b(?:reset|usage\s+limits?|rate\s+limits?|quotas?|allowances?)\b[^.!?]{0,140}\b(?:moved|postponed|delayed|rescheduled|pushed\s+back|put\s+off)\b[^.!?]{0,100}\b(?:tomorrow|later|next\s+(?:day|week|month|year)|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\b(?:moved|postponed|delayed|rescheduled|pushed\s+back|put\s+off)\b[^.!?]{0,100}\b(?:reset|usage\s+limits?|rate\s+limits?|quotas?|allowances?)\b[^.!?]{0,100}\b(?:tomorrow|later|next\s+(?:day|week|month|year)|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b)/i;
const CANCELLED_FUTURE_RESET_PATTERN =
  /(?:\b(?:reset|usage\s+limits?|rate\s+limits?|quotas?|allowances?|celebration)\b[^.!?]{0,140}\b(?:cancel(?:led|ed)?|canceled|no\s+longer|not\s+happening|scrapped)\b|\b(?:cancel(?:led|ed)?|canceled|no\s+longer|not\s+happening|scrapped)\b[^.!?]{0,140}\b(?:reset|usage\s+limits?|rate\s+limits?|quotas?|allowances?|celebration)\b)/i;
const NEGATED_FUTURE_RESET_PATTERN =
  /\b(?:no|not|never)\s+(?:[^.!?]{0,40}\b)?(?:reset|celebration)\b[^.!?]{0,80}\b(?:tomorrow|tonight|later|soon|next\s+(?:day|week|month|year))\b/i;
const EXPLICIT_RESET_NEGATION_PATTERN =
  /\b(?:no\s+reset|(?:will|would|going\s+to|can|could|should|do|does|did|am|is|are)\s+not\s+(?:going\s+to\s+|planning\s+to\s+)?(?:reset|restart|reboot)|(?:will|would|going\s+to)\s+not\s+(?:happen|occur)|not\s+(?:reset|happen|occur)\b)/i;
const RECENT_RESET_BUTTON_ACQUISITION_PATTERN =
  /\b(?:i|we)\s+(?:(?:was|were)\s+)?(?:just\s+)?(?:gifted|given|got|received|acquired)\b[^.!?]{0,100}\b(?:new\s+)?reset\s+button\b/i;
const RECENT_RESET_BUTTON_CUE_PATTERN = /\b(?:just|today|recently|new)\b/i;
const HISTORICAL_RESET_BUTTON_ACQUISITION_PATTERN =
  /\b(?:years?|months?|long)\s+ago\b|\blast\s+(?:year|month)\b/i;

const FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN =
  /\b(?:i|we)(?:\s+have|'ve)\s+(?:now\s+)?reset\s+(?:(?:the|our|all)\s+)?usage(?:\s+(?:limits?|allowances?))?(?=\s*(?:for|across|to|on|of|[.!?,;:]|$))/i;

const CURRENT_EXECUTION_PATTERNS = [
  /\b(?:one\s+|a\s+)?reset\s+now\b/i,
  /\b(?:reset|limits?|usage\s+limits?)\s+(?:is|are|was|were)\s+(?:already\s+)?(?:done|complete|completed|landed|reset|refreshed)\b/i,
  /\b(?:reset|usage\s+limits?)\s+(?:has|have|was|were|are)\s+been\s+(?:reset|completed|refreshed)\b/i,
  /\b(?:reset|usage\s+limits?|rate\s+limits?)\s+(?:has|have)\s+been\s+(?:propagated|applied)\s+to\s+(?:accounts?|users?|everyone)\b/i,
  FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN,
  /\b(?:i|we)\s+(?:have|has|just|already)\s+reset\b/i,
  /\b(?:i|we)\s+reset\b[^.!?]{0,80}\bnow\b/i,
  /\b(?:enjoy|go\s+use)\s+(?:a\s+)?reset\b/i,
  /\bfresh\s+limits\b/i,
  /\btopped\s+up\s+now\b/i,
  /\breset\s+landed\b/i,
];

// A present-progressive usage-limit announcement describes an execution that
// is being carried out now. Keep the domain narrow so technical resets such as
// "resetting the server" do not enter the usage-reset taxonomy.
const CURRENT_USAGE_RESET_ANNOUNCEMENT_PATTERN =
  /\b(?:i(?:\s+am|'m)|we(?:\s+are|'re))\s+reset(?:t)?ing\s+(?:(?:the|our|all)\s+)?(?:usage(?:\s+(?:limits?|allowances?))?|rate\s+limits?|quotas?|allowances?)\b/i;
const EXPLICIT_FUTURE_USAGE_RESET_PATTERN =
  /(?:\b(?:will|shall|going\s+to|plan(?:ned)?\s+to|planning\s+to)\b[^.!?]{0,120}\b(?:reset|resetting)\s+(?:(?:the|our|all)\s+)?(?:usage(?:\s+(?:limits?|allowances?))?|rate\s+limits?|quotas?|allowances?)\b|\b(?:reset|resetting)\s+(?:(?:the|our|all)\s+)?(?:usage(?:\s+(?:limits?|allowances?))?|rate\s+limits?|quotas?|allowances?)\b[^.!?]{0,120}\b(?:tonight|tomorrow|later|soon|next\s+(?:day|week|month|year)|in\s+(?:an?|one|two|\d+)\s+(?:hour|hours|day|days))\b)/i;

function normalizedClassificationText(text: string) {
  return text.toLowerCase().replace(/[’‘]/g, "'");
}

export function isCurrentUsageResetAnnouncement(text: string) {
  return CURRENT_USAGE_RESET_ANNOUNCEMENT_PATTERN.test(normalizedClassificationText(text));
}

function hasRecentResetButtonAcquisition(text: string) {
  const normalized = normalizedClassificationText(text);
  return (
    RECENT_RESET_BUTTON_ACQUISITION_PATTERN.test(normalized) &&
    RECENT_RESET_BUTTON_CUE_PATTERN.test(normalized) &&
    !HISTORICAL_RESET_BUTTON_ACQUISITION_PATTERN.test(normalized)
  );
}

export function hasExplicitNonUsageResetObject(text: string) {
  const normalized = normalizedClassificationText(text);
  return NON_USAGE_RESET_OBJECT_PATTERN.test(normalized) && !USAGE_LIMIT_CONTEXT_PATTERN.test(normalized);
}

/**
 * Feature, model, account-support, rollout, and deployment completions are
 * not usage-limit resets. Keep this semantic guard broad enough to cover
 * product activations, but let an explicit quota/limit reset take priority.
 */
export function hasNonUsageActivationCompletion(text: string) {
  const normalized = normalizedClassificationText(text);
  if (hasCurrentResetExecution(normalized) || EXPLICIT_USAGE_LIMIT_RESET_PATTERN.test(normalized)) {
    return false;
  }

  return (
    NON_USAGE_ACTIVATION_OBJECT_PATTERN.test(normalized) &&
    NON_USAGE_ACTIVATION_ACTION_PATTERN.test(normalized)
  );
}

export function isPureHypotheticalReset(text: string) {
  const normalized = normalizedClassificationText(text);
  return PURE_HYPOTHETICAL_PATTERN.test(normalized) && !INDEPENDENT_INTENT_AFTER_HYPOTHETICAL_PATTERN.test(normalized);
}

export function hasCurrentResetExecution(text: string) {
  const normalized = normalizedClassificationText(text);
  const hasHistoricalReset = HISTORICAL_RESET_PATTERN.test(normalized) &&
    !UNRELATED_HISTORICAL_REFERENCE_PATTERN.test(normalized);
  const hasHistoricalTimestampAfterFirstPersonExecution =
    /\b(?:i|we)(?:\s+(?:have|has|just|already)|'ve)(?:\s+now)?\s+reset\b[^.!?]{0,100}\b(?:yesterday|last\s+(?:week|month|night|year)|(?:one|two|three|four|five|six|seven|ten|\d+)\s+days?\s+ago)\b/i.test(
      normalized,
    );
  if (hasHistoricalTimestampAfterFirstPersonExecution) return false;

  const hasDirectExecution = isCurrentUsageResetAnnouncement(normalized) ||
    CURRENT_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasReconsideredExecution =
    (/\bchanged\s+my\s+mind\b[^\r\n]{0,80}\benjoy\b/i.test(normalized) && /\breset\b/i.test(normalized)) ||
    (/\b(?:changed\s+my\s+mind|reconsidered)\b[^\r\n]{0,80}\b(?:done|complete|reset\s+now|reset\s+(?:everyone|limits?))\b/i.test(
      normalized,
    ) && !/\b(?:not|no)\s+(?:reset|going\s+to\s+reset)\b/i.test(normalized));

  if (
    hasHistoricalReset &&
    !/\b(?:now|today|just)\b/i.test(normalized) &&
    !hasReconsideredExecution &&
    !/\benjoy\s+(?:a\s+)?reset\b/i.test(normalized)
  ) {
    return false;
  }

  return hasDirectExecution || hasReconsideredExecution;
}

export function getTiboClassificationSafetyDecision(
  text: string,
  candidate: ClassificationSignalType,
): TiboClassificationSafetyDecision {
  if (isBankedDistributionCompletionSignal(text) && candidate !== "irrelevant") {
    const hasFutureBankedDistribution = hasFutureBankedDistributionIntent(text);
    return {
      signalType: hasFutureBankedDistribution ? "official_notice" : "irrelevant",
      reasonJa: hasFutureBankedDistribution
        ? "完了済みのBANKED配布は全体resetとして扱わず、明示された将来のBANKED配布予告のみを採用します。"
        : "BANKEDリセット権の配布完了であり、全体の利用上限リセット実施とは別のため、正式resetには採用しません。",
      reasonCode: "banked_distribution_completion",
      suppressTeaserStrength: true,
    };
  }

  if (hasExplicitNonUsageResetObject(text) && candidate !== "irrelevant") {
    return {
      signalType: "irrelevant",
      reasonJa: "利用枠ではなく、別の対象のresetを示しているため無関係として扱います。",
      reasonCode: "non_usage_reset_object",
      suppressTeaserStrength: true,
    };
  }

  if (hasNonUsageActivationCompletion(text) && candidate !== "irrelevant") {
    return {
      signalType: "irrelevant",
      reasonJa: "利用上限のresetではなく、機能・モデル・アカウント対応などの有効化完了を示しているため無関係として扱います。",
      reasonCode: "non_usage_activation",
      suppressTeaserStrength: true,
    };
  }

  if (isPureHypotheticalReset(text) && candidate !== "irrelevant") {
    return {
      signalType: "irrelevant",
      reasonJa: "純粋な仮定や願望であり、現在のreset実施意思・予告ではないため無関係として扱います。",
      reasonCode: "pure_hypothetical",
      suppressTeaserStrength: true,
    };
  }

  if (
    EXPLICIT_RESET_NEGATION_PATTERN.test(normalizedClassificationText(text)) &&
    !hasCurrentResetExecution(text) &&
    candidate !== "irrelevant"
  ) {
    return {
      signalType: "irrelevant",
      reasonJa: "resetの否定または取り消しを示しているため、現在のresetシグナルにはしません。",
      reasonCode: "explicit_negation",
      suppressTeaserStrength: true,
    };
  }

  const normalizedText = normalizedClassificationText(text);
  if (
    (CANCELLED_FUTURE_RESET_PATTERN.test(normalizedText) || NEGATED_FUTURE_RESET_PATTERN.test(normalizedText)) &&
    !hasCurrentResetExecution(text) &&
    candidate !== "irrelevant"
  ) {
    return {
      signalType: "irrelevant",
      reasonJa: "resetの延期・予定ではなく、取り消しまたは否定を示しているため、現在のresetシグナルにはしません。",
      reasonCode: "explicit_negation",
      suppressTeaserStrength: true,
    };
  }

  if (hasCurrentResetExecution(text)) {
    if (candidate !== "reset_executed") {
      return {
        signalType: "reset_executed",
        reasonJa: "現在のreset実施を示す表現を優先します。",
        reasonCode: "current_execution",
        suppressTeaserStrength: true,
      };
    }
    return {
      signalType: candidate,
      reasonJa: null,
      reasonCode: "current_execution",
      // A completed reset is never a teaser, even when Gemini returns the
      // correct primary class but an inconsistent auxiliary strength.
      suppressTeaserStrength: true,
    };
  }

  if (
    EXPLICIT_FUTURE_RESET_RESCHEDULE_PATTERN.test(normalizedText) &&
    candidate === "reset_executed"
  ) {
    return {
      signalType: "official_notice",
      reasonJa: "resetの実施予定が延期・変更されており、完了ではなく未来の予告として扱います。",
      reasonCode: "future_reschedule",
      suppressTeaserStrength: false,
    };
  }

  const normalized = normalizedText;
  const hasHistoricalReset = HISTORICAL_RESET_PATTERN.test(normalized);
  if (hasHistoricalReset && candidate !== "irrelevant") {
    const hasFutureEvent = FUTURE_RESET_PATTERN.test(normalized);
    const isCancelled = CANCELLATION_PATTERN.test(normalized);
    if (hasFutureEvent && !isCancelled && candidate === "reset_executed") {
      return {
        signalType: "official_notice",
        reasonJa: "過去のresetではなく、後続の未来予告を現在のシグナルとして扱います。",
        reasonCode: "historical_then_future",
        suppressTeaserStrength: false,
      };
    }
    if (!hasFutureEvent || isCancelled) {
      return {
        signalType: "irrelevant",
        reasonJa: "過去または取り消されたresetの回顧であり、現在の実施ではないため無関係として扱います。",
        reasonCode: "historical_reset",
        suppressTeaserStrength: true,
      };
    }
  }

  return {
    signalType: candidate,
    reasonJa: null,
    reasonCode: null,
    suppressTeaserStrength: false,
  };
}

function applyRuleSafetyDecision(text: string, result: ClassificationResult): ClassificationResult {
  const decision = getTiboClassificationSafetyDecision(text, result.signalType);
  if (decision.signalType === result.signalType && !decision.reasonJa) return result;
  return {
    ...result,
    signalType: decision.signalType,
    reason: decision.reasonJa ?? result.reason,
  };
}

/**
 * Tibo氏のポストテキストを分類・解析し、シグナル種別・信頼度スコアを算出する
 * Supabase実データ分析に基づく高精度ルールエンジン
 */
export function classifyTiboTweet(
  text: string,
  url: string = "",
  metadata?: TiboReplyClassificationMetadata,
): ClassificationResult {
  const normalized = text.toLowerCase();

  const isReply = typeof metadata?.isReply === "boolean"
    ? metadata.isReply
    : url.includes("/status/") &&
      (text.startsWith("@") || normalized.includes("reply"));
  const isQuote = typeof metadata?.isQuote === "boolean"
    ? metadata.isQuote
    : normalized.includes("quote") || false;

  // 1. 否定・過去・昔話回想パターンの先頭評価 (Negative / Past / Retrospective Exclusion -> irrelevant)
  const negativeOrPastPatterns = [
    "already reset everyone yesterday",
    "reset was completed last week",
    "no reset tonight",
    "not going to reset",
    "don't think we should reset",
    "dont think we should reset",
    "no reset scheduled",
    "won't be a reset",
    "wont be a reset",
    "one day we created the reset button",
    "created the reset button a long time ago",
    "remember when we built the reset button",
    "remember when we created the reset button",
    "rest is history",
  ];

  for (const pattern of negativeOrPastPatterns) {
    if (normalized.includes(pattern)) {
      return applyRuleSafetyDecision(text, {
        signalType: "irrelevant",
        confidence: 0.1,
        reason: `Matched negative, past, or retrospective pattern: "${pattern}"`,
        isReply,
        isQuote,
      });
    }
  }

  // 2. 即時実施・完了報告 (reset_executed)
  // An explicit future usage-limit announcement must win over the legacy
  // broad "reset usage limits" completion phrase below.
  if (
    EXPLICIT_FUTURE_USAGE_RESET_PATTERN.test(normalizedClassificationText(text)) &&
    !isCurrentUsageResetAnnouncement(text)
  ) {
    return applyRuleSafetyDecision(text, {
      signalType: "official_notice",
      confidence: 0.96,
      reason: "Matched explicit future usage-limit reset announcement.",
      isReply,
      isQuote,
    });
  }

  if (FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN.test(normalizedClassificationText(text))) {
    return applyRuleSafetyDecision(text, {
      signalType: "reset_executed",
      confidence: 0.98,
      reason: "Matched first-person present-perfect usage reset completion.",
      isReply,
      isQuote,
    });
  }

  const executedPatterns = [
    "i've reset usage limits",
    "i have reset usage limits",
    "i've reset the usage limits",
    "i reset usage limits for all paid users",
    "reset usage limits",
    "just reset",
    "reset is complete",
    "reset completed",
    "limits have been reset",
    "reset done",
    "already reset",
    "reset everyone's limits",
    "rate limits are reset",
    "fresh limits for everyone",
    "reset all paid users",
    "reset for all users",
  ];

  for (const pattern of executedPatterns) {
    if (normalized.includes(pattern)) {
      return applyRuleSafetyDecision(text, {
        signalType: "reset_executed",
        confidence: 0.98,
        reason: `Matched immediate reset execution pattern: "${pattern}"`,
        isReply,
        isQuote,
      });
    }
  }

  // 3. 今後の実施予告 (official_notice)
  const noticePatterns = [
    "reset in ",
    "reset tonight",
    "reset tomorrow",
    "reset scheduled",
    "full reset coming",
    "reset at ",
    "reset within ",
    "will reset",
    "going to reset",
    "preparing a reset",
  ];

  for (const pattern of noticePatterns) {
    if (normalized.includes(pattern)) {
      return applyRuleSafetyDecision(text, {
        signalType: "official_notice",
        confidence: 0.96,
        reason: `Matched official notice pattern: "${pattern}"`,
        isReply,
        isQuote,
      });
    }
  }

  // A recent first-person acquisition of the reset mechanism is a narrow
  // teaser case; it does not assert that the reset has already been used.
  if (hasRecentResetButtonAcquisition(text)) {
    return applyRuleSafetyDecision(text, {
      signalType: "teaser",
      confidence: 0.85,
      reason: "Matched recent first-person reset button acquisition",
      isReply,
      isQuote,
    });
  }

  // 4. 将来の可能性の示唆 (teaser) - 明示的なreset機構と未来志向表現の同居を必須化
  // Generic productivity, capacity, and progress language belongs to Gemini's
  // semantic pass rather than the deterministic fallback.
  const teaserBaseKeywords = [
    "reset button",
    "working on reset",
    "thinking about a reset",
    "sol model caps",
  ];

  const futureIndicators = [
    "incoming",
    "soon",
    "should we",
    "time to press",
    "tonight",
    "tomorrow",
    "working on",
    "next",
    "later",
    "there will be",
  ];

  const matchedBase = teaserBaseKeywords.find((kw) => normalized.includes(kw));

  if (matchedBase) {
    // Check if future-oriented indicator co-occurs
    const hasFutureIndicator = futureIndicators.some((ind) => normalized.includes(ind));

    if (hasFutureIndicator) {
      return applyRuleSafetyDecision(text, {
        signalType: "teaser",
        confidence: 0.85,
        reason: `Matched teaser keyword "${matchedBase}" with future indicator`,
        isReply,
        isQuote,
      });
    }
  }

  // 5. デフォルト (irrelevant)
  return applyRuleSafetyDecision(text, {
    signalType: "irrelevant",
    confidence: 0.2,
    reason: "No reset notice or execution patterns matched.",
    isReply,
    isQuote,
  });
}
