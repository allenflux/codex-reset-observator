import type { ClassificationSignalType } from "./classification";
import type { TeaserStrength } from "./teaserStrength";

export type TiboContextSafetyInput = {
  authorText: string;
  replyContextText?: string | null;
  quoteContextText?: string | null;
  selectedSignalType: ClassificationSignalType;
  aiTeaserStrength?: TeaserStrength | null;
};

export type TiboContextSafetyDecision =
  | {
      signalType: "irrelevant";
      teaserStrength: "none";
      reasonJa: string;
    }
  | {
      signalType: "irrelevant";
      teaserStrength: "weak";
      reasonJa: string;
    }
  | {
      signalType: "teaser";
      teaserStrength: "weak";
      reasonJa: string;
    }
  | {
      signalType: "teaser";
      teaserStrength: "strong";
      reasonJa: string;
    };

// Keep this deliberately narrow: ordinary "got" or "received" statements
// must not be treated as physical-item receipts without an item noun.
const ITEM_RECEIPT_PATTERN = /\b(?:me\s+receiving|i\s+(?:am|'m)\s+receiving|i\s+received|i\s+got|i\s+was\s+(?:gifted|given))\s+(?:(?:this|that|a|an|the)\s+)?(?:(?:very|important|fancy|new|special|nice)\s+){0,3}(?:item|gift|present|package|box)\b/i;

const EXPLICIT_RESET_CONTEXT_PATTERN = /\b(?:reset(?:s|ting)?|usage[-\s]+limits?|rate[-\s]+limits?|quotas?|allowances?|fresh[-\s]+limits?|topped\s+up|limit\s+reset)\b/i;
const PHYSICAL_ITEM_SHOWCASE_PATTERN = /\bfor\s+scale\b/i;
const PHYSICAL_ITEM_SHOWCASE_CUE_PATTERN = /\b(?:not\s+used\s+yet|(?:would\s+you\s+)?look\s+at\s+(?:this|that))\b/i;
const USAGE_LIMIT_CONTEXT_PATTERN = /\b(?:usage|quota|rate\s+limit|allowance|capacity)\b/i;
const PERSON_TARGETED_RESET_PATTERN = /\b(?!codex\b|usage\b|quota\b|limits?\b|allowances?\b)[a-z][a-z'-]{1,30}\s+is\s+in\s+need\s+of\s+(?:a\s+)?reset\b/i;
const HISTORICAL_RESET_CONTEXT_PATTERN = /\b(?:previously\s+promised\s+a\s+reset|one\s+day\s+(?:we|i)\s+(?:created|made)\s+the\s+reset\s+button|remember\s+when|long\s+time\s+ago|rest\s+is\s+history|(?:last\s+)?(?:year|month)s?\s+ago)\b/i;
const FUTURE_CUE_PATTERN = /\b(?:tomorrow|tonight|later|soon|next\s+(?:day|week|month|year)|in\s+(?:the\s+)?(?:next|an?|one|two|\d+)\s+(?:minute|minutes|hour|hours|day|days|week|weeks))\b/i;
const AMBIGUOUS_FUTURE_NOUN_PATTERN = /\b(?:surprise|something|news|announcement|update)\b/i;
const EXPLICIT_FUTURE_RESET_INTENT_PATTERNS = [
  /\b(?:will|going\s+to|plan(?:s|ned)?\s+to|i['’]ll|we['’]ll)\b[^.!?]{0,100}\b(?:reset|resetting|usage[-\s]+limits?|quotas?|allowances?)\b/i,
  /\b(?:reset|resetting)\b[^.!?]{0,60}\b(?:tomorrow|tonight|later|soon|next\s+(?:day|week|month|year)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+(?:the\s+)?(?:next|an?|one|two|\d+)\s+(?:minute|minutes|hour|hours|day|days|week|weeks))\b/i,
  /\b(?:reset|resetting)\b.{0,80}\b(?:landing|coming|arriving)\b/i,
];

function normalizeContext(value: string | null | undefined) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim()
    : "";
}

function hasExplicitFutureResetIntent(text: string) {
  return EXPLICIT_FUTURE_RESET_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Apply narrow post-classification context guards without rewriting the AI audit fields.
 * The guard can suppress or downgrade a result, but never creates a stronger signal.
 */
export function getTiboContextSafetyDecision(
  input: TiboContextSafetyInput,
): TiboContextSafetyDecision | null {
  const authorText = normalizeContext(input.authorText);
  const context = [
    authorText,
    normalizeContext(input.replyContextText),
    normalizeContext(input.quoteContextText),
  ].filter(Boolean).join("\n");

  const hasResetSignal = input.selectedSignalType !== "irrelevant" ||
    input.aiTeaserStrength === "strong" ||
    input.aiTeaserStrength === "weak";

  if (!hasResetSignal) return null;

  if (
    input.selectedSignalType === "official_notice" &&
    HISTORICAL_RESET_CONTEXT_PATTERN.test(context) &&
    FUTURE_CUE_PATTERN.test(context) &&
    AMBIGUOUS_FUTURE_NOUN_PATTERN.test(context) &&
    !hasExplicitFutureResetIntent(context)
  ) {
    return {
      signalType: "teaser",
      teaserStrength: "strong",
      reasonJa: "Context safety guard: 未来の出来事がリセットだとは明示されていないため、公式予告ではなく強い匂わせとして扱います。",
    };
  }

  if (
    PERSON_TARGETED_RESET_PATTERN.test(authorText) &&
    !USAGE_LIMIT_CONTEXT_PATTERN.test(context)
  ) {
    return {
      signalType: "irrelevant",
      teaserStrength: "none",
      reasonJa: "Context safety guard: 人物へのリセット言及で、利用枠リセットの文脈がないため、無関係として扱います。",
    };
  }

  if (
    HISTORICAL_RESET_CONTEXT_PATTERN.test(context) &&
    !hasExplicitFutureResetIntent(context)
  ) {
    return {
      signalType: "irrelevant",
      teaserStrength: "none",
      reasonJa: "Context safety guard: 過去のリセットへの言及で、現在または未来のリセット意図がないため、無関係として扱います。",
    };
  }

  if (
    PHYSICAL_ITEM_SHOWCASE_PATTERN.test(authorText) &&
    PHYSICAL_ITEM_SHOWCASE_CUE_PATTERN.test(authorText) &&
    !EXPLICIT_RESET_CONTEXT_PATTERN.test(context)
  ) {
    return {
      signalType: "irrelevant",
      teaserStrength: "none",
      reasonJa: "Context safety guard: 物品の展示・受領を示す投稿ですが、利用枠リセットの明示的な根拠がないため、無関係として扱います。",
    };
  }

  if (ITEM_RECEIPT_PATTERN.test(authorText)) {
    if (EXPLICIT_RESET_CONTEXT_PATTERN.test(context)) return null;

    return {
      signalType: "irrelevant",
      teaserStrength: "none",
      reasonJa: "Context safety guard: 物品の受領を示す投稿ですが、本文・返信元・引用文脈に利用枠リセットの明示的な根拠がないため、無関係として扱います。",
    };
  }

  return null;
}
