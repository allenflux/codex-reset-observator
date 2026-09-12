import type { WindowEventLike } from "./types";
import { isEligibleRandomResetEvent } from "./resetEligibility";

export type CommunicationType = "formal_notice" | "teaser" | "silent";
export type CommunicationProvenance = "observed_signal" | "legacy_history";
export type CommunicationCoverage = "confirmed" | "insufficient" | "unknown";
export type CommunicationSignalKind = "official_notice" | "teaser" | string;

export type CommunicationSignalInput = {
  tweetId: string;
  signalType: CommunicationSignalKind;
  tweetCreatedAt: string;
  availableAt: string | null;
  confidence: number | null;
  verificationStatus: string | null;
  isReply: boolean;
};

export type CommunicationEventInput = {
  eventId: string;
  completedAt: string;
  legacyNoticeType: string | null;
  legacyOpenedAt: string | null;
  legacyWindowMinutes: number | null;
};

export type SignalValidityPolicy = (
  signal: CommunicationSignalInput,
) => boolean;

export type CommunicationClassification = {
  primaryType: CommunicationType;
  provenance: CommunicationProvenance;
  coverage: CommunicationCoverage;
  /** False means the three-way label is only a placeholder, not evidence of silence. */
  classificationUsable: boolean;
  observedType: CommunicationType | null;
  legacyType: CommunicationType | null;
  observedSignalIds: string[];
  legacyAgreement: boolean | null;
  legacySignalAt: string | null;
  legacySignalAtUsable: boolean;
  signalToExecutionHours: number | null;
};

export type CommunicationRegimeMethod = "majority" | "ewma";

export type CommunicationRegimeSummary = {
  formalNoticeShare: number;
  teaserShare: number;
  silentShare: number;
  sampleSize: number;
  dominantType: CommunicationType | null;
};

const TYPE_PRIORITY: CommunicationType[] = ["formal_notice", "teaser", "silent"];
const OFFICIAL_NOTICE_CONFIDENCE = 0.95;
const TEASER_CONFIDENCE = 0.8;

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCompletedAt(item: WindowEventLike) {
  return item.closed_at ?? item.completed_at ?? item.opened_at ?? item.date ?? null;
}

/**
 * This is the current historical validity policy used by Production notice
 * association and teaser scoring. Study sensitivity analyses may replace it,
 * but the default is deliberately not tuned from the study result.
 */
export const productionCommunicationSignalValidity: SignalValidityPolicy = (signal) => {
  if (signal.verificationStatus === "rejected" || signal.isReply) return false;
  if (signal.signalType === "official_notice") {
    return (signal.confidence ?? 0) >= OFFICIAL_NOTICE_CONFIDENCE;
  }
  if (signal.signalType === "teaser") {
    return (signal.confidence ?? 0) >= TEASER_CONFIDENCE;
  }
  return false;
};

export function normalizeLegacyCommunicationType(
  noticeType: string | null | undefined,
): CommunicationType | null {
  const normalized = noticeType?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (/(公式予告|告知(?:投稿)?|official\s*notice|formal)/i.test(normalized)) return "formal_notice";
  if (/(匂わせ|teaser|hint)/i.test(normalized)) return "teaser";
  if (/(^なし$|none|silent|無言)/i.test(normalized)) return "silent";
  return null;
}

function isLegacySignalTimestampUsable(event: CommunicationEventInput) {
  const legacyType = normalizeLegacyCommunicationType(event.legacyNoticeType);
  const openedAt = timestamp(event.legacyOpenedAt);
  const completedAt = timestamp(event.completedAt);
  const windowMinutes = event.legacyWindowMinutes;
  if (
    (legacyType !== "formal_notice" && legacyType !== "teaser") ||
    openedAt === null ||
    completedAt === null ||
    openedAt >= completedAt ||
    typeof windowMinutes !== "number" ||
    !Number.isFinite(windowMinutes) ||
    windowMinutes <= 0
  ) {
    return false;
  }

  const actualMinutes = (completedAt - openedAt) / 60_000;
  return Math.abs(actualMinutes - windowMinutes) <= 2;
}

function getLegacySignalAt(event: CommunicationEventInput) {
  return isLegacySignalTimestampUsable(event) ? event.legacyOpenedAt : null;
}

function chooseObservedType(
  signals: CommunicationSignalInput[],
  coverage: CommunicationCoverage,
) {
  if (signals.some((signal) => signal.signalType === "official_notice")) {
    return "formal_notice" as const;
  }
  if (signals.some((signal) => signal.signalType === "teaser")) {
    return "teaser" as const;
  }
  return coverage === "confirmed" ? ("silent" as const) : null;
}

function getPrimaryObservedSignal(signals: CommunicationSignalInput[]) {
  return signals
    .slice()
    .sort((left, right) => {
      const leftPriority = left.signalType === "official_notice" ? 0 : 1;
      const rightPriority = right.signalType === "official_notice" ? 0 : 1;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return (timestamp(right.tweetCreatedAt) ?? 0) - (timestamp(left.tweetCreatedAt) ?? 0);
    })[0] ?? null;
}

export function classifyCommunicationEvent(
  event: CommunicationEventInput,
  signals: CommunicationSignalInput[],
  options: {
    previousRandomResetAt?: string | null;
    coverage: CommunicationCoverage;
    availableAt?: string | null;
    validityPolicy?: SignalValidityPolicy;
  },
): CommunicationClassification {
  const completedTime = timestamp(event.completedAt);
  if (completedTime === null) {
    throw new RangeError(`Invalid completedAt for communication event ${event.eventId}`);
  }

  const previousTime = timestamp(options.previousRandomResetAt);
  const availabilityCutoff = timestamp(options.availableAt);
  const validityPolicy = options.validityPolicy ?? productionCommunicationSignalValidity;
  const observedSignals = signals
    .filter((signal) => {
      const createdTime = timestamp(signal.tweetCreatedAt);
      const availableTime = timestamp(signal.availableAt ?? signal.tweetCreatedAt);
      return Boolean(
        createdTime !== null &&
          createdTime < completedTime &&
          (previousTime === null || previousTime === undefined || createdTime > previousTime) &&
          (availabilityCutoff === null || availabilityCutoff === undefined || (availableTime !== null && availableTime <= availabilityCutoff)) &&
          validityPolicy(signal),
      );
    })
    .sort((left, right) => {
      const leftPriority = left.signalType === "official_notice" ? 0 : 1;
      const rightPriority = right.signalType === "official_notice" ? 0 : 1;
      return leftPriority - rightPriority ||
        (timestamp(right.tweetCreatedAt) ?? 0) - (timestamp(left.tweetCreatedAt) ?? 0) ||
        left.tweetId.localeCompare(right.tweetId);
    });

  const observedType = chooseObservedType(observedSignals, options.coverage);
  const legacyType = normalizeLegacyCommunicationType(event.legacyNoticeType);
  const primaryType = observedType ?? legacyType ?? "silent";
  const legacySignalAt = getLegacySignalAt(event);
  const primarySignal = getPrimaryObservedSignal(observedSignals);
  const signalAt = primarySignal?.tweetCreatedAt ?? legacySignalAt;
  const signalTime = timestamp(signalAt);
  const signalToExecutionHours = signalTime === null
    ? null
    : Math.max(0, (completedTime - signalTime) / 3_600_000);
  const classificationUsable = observedType !== null || legacyType !== null || options.coverage === "confirmed";

  return {
    primaryType,
    provenance: observedType === null ? "legacy_history" : "observed_signal",
    coverage: options.coverage,
    classificationUsable,
    observedType,
    legacyType,
    observedSignalIds: observedSignals.map((signal) => signal.tweetId),
    legacyAgreement: observedType !== null && legacyType !== null
      ? observedType === legacyType
      : null,
    legacySignalAt,
    legacySignalAtUsable: legacySignalAt !== null,
    signalToExecutionHours,
  };
}

export function projectSignalsToOrigin(
  signals: CommunicationSignalInput[],
  origin: string,
) {
  const originTime = timestamp(origin);
  if (originTime === null) throw new RangeError("origin must be a valid timestamp");
  return signals.filter((signal) => {
    const availableTime = timestamp(signal.availableAt ?? signal.tweetCreatedAt);
    return availableTime !== null && availableTime <= originTime;
  });
}

export function buildRollingCommunicationRegime(
  events: Array<Pick<CommunicationClassification, "primaryType">>,
  currentIndex: number,
  options: { window: number; method: CommunicationRegimeMethod },
): CommunicationRegimeSummary {
  const window = Math.max(1, Math.floor(options.window));
  const prior = events
    .slice(Math.max(0, currentIndex - window), Math.max(0, currentIndex))
    .map((event) => event.primaryType);
  if (prior.length === 0) {
    return {
      formalNoticeShare: 0,
      teaserShare: 0,
      silentShare: 0,
      sampleSize: 0,
      dominantType: null,
    };
  }

  const weights = prior.map((type, index) => {
    if (options.method === "majority") return { type, weight: 1 };
    const alpha = 2 / (Math.min(window, prior.length) + 1);
    return { type, weight: Math.pow(1 - alpha, prior.length - index - 1) * alpha };
  });
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  const shares = TYPE_PRIORITY.reduce<Record<CommunicationType, number>>((result, type) => {
    result[type] = weights
      .filter((item) => item.type === type)
      .reduce((sum, item) => sum + item.weight, 0) / totalWeight;
    return result;
  }, { formal_notice: 0, teaser: 0, silent: 0 });
  const dominantType = TYPE_PRIORITY
    .slice()
    .sort((left, right) => shares[right] - shares[left])[0] ?? null;

  return {
    formalNoticeShare: shares.formal_notice,
    teaserShare: shares.teaser,
    silentShare: shares.silent,
    sampleSize: prior.length,
    dominantType,
  };
}

export function seededPermutation<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function selectEligibleCommunicationEvents(
  events: WindowEventLike[],
  nowTime: number,
) {
  return events.filter((event) => {
    const completedAt = getCompletedAt(event);
    const completedTime = timestamp(completedAt);
    return isEligibleRandomResetEvent(event, completedTime, nowTime);
  });
}
