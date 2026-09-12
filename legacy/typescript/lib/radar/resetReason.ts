import type {
  ResetCycleType,
  ResetReasonType,
} from "./types";

export const RESET_CYCLE_TYPES: readonly ResetCycleType[] = [
  "ランダムリセット",
  "定期リセット",
  "個人別リセット",
];

export const RESET_REASON_TYPES: readonly ResetReasonType[] = [
  "ご祝儀リセット",
  "詫びリセット",
  "定期更新",
];

type ResetReasonDetailsInput = {
  cycleType?: string | null;
  reasonType?: string | null;
};

export type ResetReasonContext = {
  recordKind?: string | null;
  cycleType?: string | null;
  reasonType?: string | null;
  title?: string | null;
  summary?: string | null;
  windowHuman?: string | null;
  scope?: string | null;
  text?: string | null;
  details?: ResetReasonDetailsInput | null;
};

const REGULAR_RESET_PATTERN =
  /定期|weekly\s+(?:reset|refresh|update|cycle|schedule|timing)|one[- ]?week|regular\s+(?:reset|refresh|update)|1週間サイクル|常规|每周|周期更新/i;
const COMPENSATION_PATTERN =
  /compensation|reliability|incident|outage|bug|degradation|rate[- ]?limit|rate[- ]?limiting|障害|不具合|補償|詫び|復旧|信頼性|故障|补偿|可靠性|事故|中断|限流|速率限制/i;
const USAGE_FIX_COMPENSATION_PATTERN =
  /(?:usage\s+(?:limits?|allowances?)|rate\s+limits?|quotas?|allowances?|codex\s+(?:usage\s+)?limits?|chatgpt\s+work\s+(?:usage\s+)?limits?)[\s\S]{0,240}\b(?:fix(?:es|ed)?|issue(?:s)?|problem(?:s)?|over[- ]?consum(?:e|ed|ption)|excess(?:ive)?\s+usage)\b|\b(?:fix(?:es|ed)?|issue(?:s)?|problem(?:s)?|over[- ]?consum(?:e|ed|ption)|excess(?:ive)?\s+usage)\b[\s\S]{0,240}(?:usage\s+(?:limits?|allowances?)|rate\s+limits?|quotas?|allowances?|codex\s+(?:usage\s+)?limits?|chatgpt\s+work\s+(?:usage\s+)?limits?)/i;
const PERSONAL_RESET_PATTERN =
  /任意|manual\s+reset|banked\s+reset|reset\s+credit|referral|account[- ]specific|招待|个人/i;

function getContextText(input: ResetReasonContext) {
  return [
    input.title,
    input.summary,
    input.windowHuman,
    input.scope,
    input.text,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

export function isRegularResetContext(input: ResetReasonContext) {
  return Boolean(
    input.recordKind === "regular_completed" ||
      input.cycleType === "定期リセット" ||
      input.details?.cycleType === "定期リセット" ||
      REGULAR_RESET_PATTERN.test(getContextText(input)),
  );
}

function hasCompensationEvidence(input: ResetReasonContext) {
  return COMPENSATION_PATTERN.test(getContextText(input));
}

function hasUsageFixCompensationEvidence(input: ResetReasonContext) {
  return USAGE_FIX_COMPENSATION_PATTERN.test(getContextText(input));
}

export function inferResetCycleType(input: ResetReasonContext): ResetCycleType {
  const explicitCycleType = input.cycleType ?? input.details?.cycleType;
  if (explicitCycleType && RESET_CYCLE_TYPES.includes(explicitCycleType as ResetCycleType)) {
    return explicitCycleType as ResetCycleType;
  }

  if (isRegularResetContext(input)) return "定期リセット";
  if (PERSONAL_RESET_PATTERN.test(getContextText(input))) return "個人別リセット";
  return "ランダムリセット";
}

const CELEBRATION_PATTERN =
  /celebrat|launch|milestone|users|anniversary|gift|happy|campaign|thank|monday|記念|祝|周年|感謝|キャンペーン|突破|達成|ご祝儀/i;

export function normalizeResetReasonType(input: ResetReasonContext): ResetReasonType | undefined {
  if (isRegularResetContext(input)) return "定期更新";

  const explicitReasonType = input.reasonType ?? input.details?.reasonType;
  if (explicitReasonType === "通常更新" || explicitReasonType === "定期更新") {
    return "定期更新";
  }
  if (
    explicitReasonType &&
    RESET_REASON_TYPES.includes(explicitReasonType as ResetReasonType)
  ) {
    return explicitReasonType as ResetReasonType;
  }
  if (explicitReasonType === "ランダムリセット" || explicitReasonType === "その他") {
    return "ご祝儀リセット";
  }

  if (hasCompensationEvidence(input) || hasUsageFixCompensationEvidence(input)) return "詫びリセット";
  if (CELEBRATION_PATTERN.test(getContextText(input))) return "ご祝儀リセット";

  return undefined;
}
