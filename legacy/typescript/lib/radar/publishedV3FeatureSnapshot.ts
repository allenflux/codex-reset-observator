import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import { getPointInTimeRadarData } from "./prequentialCalibration";
import {
  buildCanonicalResetHistoryContext,
  getCanonicalResetHistoryForStaticHistory,
} from "./tiboHistory";
import { getEffectiveTeaserStrength, isTeaserStrength, type TeaserStrength } from "./teaserStrength";
import { getTiboReadSideSignals, type TiboReadSideSignal } from "./tiboLogicalProjection";
import type { RadarData } from "./types";
import type { TiboSignalType } from "./tiboHistory";

export const PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION = "v1" as const;

export type PublishedV3FeatureSnapshot = {
  featureSnapshotVersion: typeof PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION;
  bankedEventWithin48h: boolean | null;
  usableTiboSignal: boolean | null;
  statusIncident: boolean | null;
  tiboSignalAgeHours: number | null;
  tiboSignalType: TiboSignalType | null;
  tiboSignalConfidence: number | null;
  tiboTeaserStrength: TeaserStrength | null;
};

const TIBO_SIGNAL_TYPES: readonly TiboSignalType[] = [
  "official_notice",
  "reset_executed",
  "teaser",
  "irrelevant",
];
const HOUR_MS = 60 * 60 * 1000;

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getHistoryEventTime(item: {
  closed_at?: string | null;
  completed_at?: string | null;
  opened_at?: string | null;
  date?: string | null;
}) {
  return item.closed_at ?? item.completed_at ?? item.opened_at ?? item.date ?? null;
}

export function createUnknownPublishedV3FeatureSnapshot(): PublishedV3FeatureSnapshot {
  return {
    featureSnapshotVersion: PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION,
    bankedEventWithin48h: null,
    usableTiboSignal: null,
    statusIncident: null,
    tiboSignalAgeHours: null,
    tiboSignalType: null,
    tiboSignalConfidence: null,
    tiboTeaserStrength: null,
  };
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNullableFiniteNumber(value: unknown, minimum: number): value is number | null {
  return value === null || (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
  );
}

function isNullableSignalType(value: unknown): value is TiboSignalType | null {
  return value === null || (
    typeof value === "string"
    && TIBO_SIGNAL_TYPES.includes(value as TiboSignalType)
  );
}

function isNullableTeaserStrength(value: unknown): value is TeaserStrength | null {
  return value === null || isTeaserStrength(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read only the versioned, scalar feature snapshot persisted with a v3
 * forecast. Missing or malformed snapshots intentionally remain unknown.
 */
export function readPublishedV3FeatureSnapshot(value: unknown): PublishedV3FeatureSnapshot | null {
  const record = asRecord(value);
  if (!record || record.featureSnapshotVersion !== PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION) return null;
  if (!isNullableBoolean(record.bankedEventWithin48h)) return null;
  if (!isNullableBoolean(record.usableTiboSignal)) return null;
  if (!isNullableBoolean(record.statusIncident)) return null;
  if (!isNullableFiniteNumber(record.tiboSignalAgeHours, 0)) return null;
  if (!isNullableSignalType(record.tiboSignalType)) return null;
  if (!isNullableFiniteNumber(record.tiboSignalConfidence, 0)) return null;
  if (!isNullableTeaserStrength(record.tiboTeaserStrength)) return null;

  return {
    featureSnapshotVersion: PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION,
    bankedEventWithin48h: record.bankedEventWithin48h,
    usableTiboSignal: record.usableTiboSignal,
    statusIncident: record.statusIncident,
    tiboSignalAgeHours: record.tiboSignalAgeHours,
    tiboSignalType: record.tiboSignalType,
    tiboSignalConfidence: record.tiboSignalConfidence,
    tiboTeaserStrength: record.tiboTeaserStrength,
  };
}

function isUsableTiboSignal(signal: TiboReadSideSignal) {
  return signal.is_reply !== true
    && signal.verification_status !== "rejected"
    && signal.signal_type !== "irrelevant";
}

function getRepresentativeSignal(signals: readonly TiboReadSideSignal[], originTime: number) {
  return signals
    .filter(isUsableTiboSignal)
    .flatMap((signal) => {
      const createdAt = timestamp(signal.tweet_created_at);
      return createdAt !== null && createdAt <= originTime
        ? [{ signal, createdAt }]
        : [];
    })
    .sort((left, right) => {
      const timeDifference = right.createdAt - left.createdAt;
      if (timeDifference !== 0) return timeDifference;
      return left.signal.tweet_id.localeCompare(right.signal.tweet_id);
    })[0]?.signal ?? null;
}

/**
 * Build the feature metadata from a single point-in-time view. This helper is
 * shared by forecast generation and any future PIT feature consumers so that
 * segment definitions do not drift from the saved artifact.
 */
export function buildPublishedV3FeatureSnapshot(
  data: RadarData | null | undefined,
  origin: Date,
): PublishedV3FeatureSnapshot {
  const originTime = origin.getTime();
  const pointInTimeData = getPointInTimeRadarData(data ?? null, origin);
  if (!pointInTimeData || !Number.isFinite(originTime)) {
    return createUnknownPublishedV3FeatureSnapshot();
  }

  const canonicalContext = buildCanonicalResetHistoryContext(pointInTimeData, {
    defaultStaticHistory: LOCAL_RESET_HISTORY,
  });
  const canonicalHistory = getCanonicalResetHistoryForStaticHistory(
    canonicalContext,
    LOCAL_RESET_HISTORY,
  ) ?? canonicalContext.defaultHistory;
  const bankedEventWithin48h = canonicalHistory.some((item) => {
    if (item.recordKind !== "banked_distribution") return false;
    const eventTime = timestamp(getHistoryEventTime(item));
    return eventTime !== null
      && eventTime > originTime - 48 * HOUR_MS
      && eventTime <= originTime;
  });

  const signals = getTiboReadSideSignals(
    pointInTimeData,
    "all",
    true,
    canonicalContext.readSideProjection,
  );
  const representativeSignal = getRepresentativeSignal(signals, originTime);
  const signalCreatedAt = representativeSignal
    ? timestamp(representativeSignal.tweet_created_at)
    : null;
  const signalAge = signalCreatedAt === null
    ? null
    : (originTime - signalCreatedAt) / HOUR_MS;
  const signalConfidence = representativeSignal && typeof representativeSignal.confidence === "number"
    && Number.isFinite(representativeSignal.confidence)
    && representativeSignal.confidence >= 0
    && representativeSignal.confidence <= 1
    ? representativeSignal.confidence
    : null;

  return {
    featureSnapshotVersion: PUBLISHED_V3_FEATURE_SNAPSHOT_VERSION,
    bankedEventWithin48h,
    usableTiboSignal: representativeSignal !== null,
    statusIncident: (pointInTimeData.openai_status_history ?? []).length > 0,
    tiboSignalAgeHours: signalAge !== null && Number.isFinite(signalAge) && signalAge >= 0
      ? signalAge
      : null,
    tiboSignalType: representativeSignal?.signal_type ?? null,
    tiboSignalConfidence: signalConfidence,
    tiboTeaserStrength: representativeSignal
      ? getEffectiveTeaserStrength(representativeSignal)
      : null,
  };
}
