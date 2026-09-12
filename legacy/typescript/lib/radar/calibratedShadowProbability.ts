import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import {
  CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_LIMITATIONS,
  CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_VERSION,
  CALIBRATED_SHADOW_MODEL_VERSION,
  CALIBRATED_SHADOW_MODEL_VERSION_V2,
  SHADOW_PROBABILITY_MODEL_VERSION,
} from "@/data/shadowProbabilityConfig";
import {
  LOCAL_OBSERVATION_SIGNALS,
  type LocalObservationSignal,
} from "@/data/observationSignals";
import type { WindowEventLike, RadarData } from "./types";
import {
  calculatePrequentialLogitCalibration,
  createPrequentialOrigins,
  getActualWithinHorizon,
  getPointInTimeRadarData,
  PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
  PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
  type PrequentialCalibrationRow,
} from "./prequentialCalibration";
import { getEffectiveSignalStatus } from "./probability";
import {
  calculateShadowProbabilityForModel,
  getShadowCompletedResetEvents,
  type ShadowProbabilityOptions,
  type ShadowProbabilityResult,
  type ShadowProbabilityPair,
} from "./shadowProbability";

export { CALIBRATED_SHADOW_MODEL_VERSION } from "@/data/shadowProbabilityConfig";
export { getPointInTimeRadarData } from "./prequentialCalibration";

export type CalibratedShadowProbabilityResult = {
  modelVersion: typeof CALIBRATED_SHADOW_MODEL_VERSION | typeof CALIBRATED_SHADOW_MODEL_VERSION_V2;
  calculatedAt: string;
  rawModelVersion: typeof SHADOW_PROBABILITY_MODEL_VERSION;
  rawProbability24h: number;
  rawProbability48h: number;
  probability24h: number;
  probability48h: number;
  alpha24h: number;
  alpha48h: number;
  calibrationSampleCount24h: number;
  calibrationSampleCount48h: number;
  positiveCalibrationCount24h: number;
  positiveCalibrationCount48h: number;
  priorStdDev: number;
  minimumSamples: number;
  lastResolvedOrigin24h: string | null;
  lastResolvedOrigin48h: string | null;
  officialNoticeOverride: boolean;
  horizonCoherenceAdjusted: boolean;
  fallbackUsed: boolean;
  evaluationMode: "prospective";
  pointInTimeProjectionVersion: typeof CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_VERSION;
  pointInTimeProjectionLimitations: typeof CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_LIMITATIONS;
  targetDefinition: string;
};

export type CalibratedShadowCalculationOptions = ShadowProbabilityOptions & {
  shadowProbability?: ShadowProbabilityResult | null;
  modelVersion?: CalibratedShadowProbabilityResult["modelVersion"];
  includeTeaserStrengthBoost?: boolean;
  legacyOfficialNoticeOverride?: boolean;
};

// Keep the fitted audit for at least one public ten-minute calculation bucket.
// The fit inputs and point-in-time sample selection remain unchanged; this only
// prevents the same public bucket from repeating the walk-forward fit.
const CALIBRATION_CACHE_TTL_MS = 10 * 60 * 1000;
const CALIBRATION_CACHE_MAX_ENTRIES = 4;
const calibrationCache = new Map<string, {
  expiresAt: number;
  audit: ReturnType<typeof calculatePrequentialLogitCalibration> | null;
}>();

function parseTimestamp(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function getPointInTimeLocalObservationSignals(
  origin: Date,
  signals: Array<LocalObservationSignal> = LOCAL_OBSERVATION_SIGNALS,
) {
  const originTime = origin.getTime();
  if (!Number.isFinite(originTime)) return [];

  return signals
    .filter((signal) => {
      const observedAt = parseTimestamp(signal.observedAt);
      return observedAt !== null && observedAt <= originTime;
    })
    .map((signal) => {
      return {
        ...signal,
        status: getEffectiveSignalStatus(signal, origin) as LocalObservationSignal["status"],
      };
    });
}

function clampProbability(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function isValidProbabilityPair(pair: ShadowProbabilityPair) {
  return Number.isFinite(pair.probability24h)
    && Number.isFinite(pair.probability48h)
    && pair.probability24h >= 0
    && pair.probability24h <= 1
    && pair.probability48h >= 0
    && pair.probability48h <= 1;
}

export function enforceProbabilityHorizonCoherence(
  probability24h: number,
  probability48h: number,
) {
  const safe24h = clampProbability(probability24h);
  const safe48h = clampProbability(probability48h);
  if (safe48h < safe24h) {
    return {
      probability24h: safe24h,
      probability48h: safe24h,
      adjusted: true,
    };
  }
  return {
    probability24h: safe24h,
    probability48h: safe48h,
    adjusted: false,
  };
}

function getLastCalibrationAudit(
  data: RadarData | null,
  now: Date,
  options: CalibratedShadowCalculationOptions,
  currentRaw: ShadowProbabilityPair,
) {
  const staticHistory = options.staticHistory ?? LOCAL_RESET_HISTORY;
  const localObservationSignals = options.localObservationSignals ?? LOCAL_OBSERVATION_SIGNALS;
  const cacheKey = getCalibrationCacheKey(
    data,
    now,
    staticHistory,
    localObservationSignals,
    currentRaw,
    options.includeTeaserStrengthBoost !== false,
  );
  const cached = calibrationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.audit;
  }
  const events = getShadowCompletedResetEvents(
    data,
    now,
    staticHistory,
    {},
    options.canonicalHistoryContext,
  );
  const origins = createPrequentialOrigins(events, now.toISOString(), undefined, 24);
  const rows: Array<PrequentialCalibrationRow> = [];

  for (const recordedAt of origins) {
    const origin = new Date(recordedAt);
    const pointInTimeData = getPointInTimeRadarData(data, origin);
    const raw = calculateShadowProbabilityForModel(pointInTimeData, {
      now: origin,
      staticHistory,
      regularResetExpectedAt: null,
      activeOfficialNotice: undefined,
      localObservationSignals: getPointInTimeLocalObservationSignals(origin, localObservationSignals),
    }, {
      includeTeaserStrengthBoost: options.includeTeaserStrengthBoost !== false,
    });
    const row: PrequentialCalibrationRow = {
      recordedAt,
      probability24h: raw.predictions.probability24h,
      probability48h: raw.predictions.probability48h,
      actual24h: getActualWithinHorizon(events, recordedAt, 24),
      actual48h: getActualWithinHorizon(events, recordedAt, 48),
    };
    rows.push(row);
  }

  const lastAudit = calculatePrequentialLogitCalibration({
    recordedAt: now.toISOString(),
    probability24h: currentRaw.probability24h,
    probability48h: currentRaw.probability48h,
    actual24h: false,
    actual48h: false,
  }, rows);

  calibrationCache.set(cacheKey, {
    expiresAt: Date.now() + CALIBRATION_CACHE_TTL_MS,
    audit: lastAudit,
  });
  while (calibrationCache.size > CALIBRATION_CACHE_MAX_ENTRIES) {
    const oldestKey = calibrationCache.keys().next().value;
    if (typeof oldestKey === "string") calibrationCache.delete(oldestKey);
    else break;
  }
  return lastAudit;
}

function getJstDayKey(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getCalibrationCacheKey(
  data: RadarData | null,
  now: Date,
  staticHistory: Array<WindowEventLike>,
  localObservationSignals: Array<LocalObservationSignal>,
  currentRaw: ShadowProbabilityPair,
  includeTeaserStrengthBoost: boolean,
) {
  return JSON.stringify({
    modelVersion: CALIBRATED_SHADOW_MODEL_VERSION,
    currentJstDate: getJstDayKey(now),
    currentRaw,
    includeTeaserStrengthBoost,
    staticHistory: staticHistory.map((item) => [item.id, item.closed_at, item.completed_at, item.opened_at]),
    formalResets: (data?.formal_tibo_resets ?? []).map((signal) => [signal.tweet_id, signal.tweet_created_at, signal.detected_at, signal.verification_status]),
    activeSignals: (data?.active_tibo_signals ?? []).map((signal) => [signal.tweet_id, signal.tweet_created_at, signal.detected_at, signal.expires_at, signal.signal_type]),
    rejectedResets: (data?.rejected_tibo_resets ?? []).map((signal) => [signal.tweet_id, signal.tweet_created_at]),
    statusHistory: (data?.openai_status_history ?? []).map((incident) => [
      incident.id,
      incident.createdAt,
      incident.updatedAt,
      incident.resolvedAt,
      incident.status,
      incident.impact,
      incident.title,
    ]),
    localSignals: localObservationSignals.map((signal) => [signal.id, signal.status, signal.observedAt, signal.resolvedAt, signal.expiresAt]),
  });
}

export function calculateCalibratedShadowProbability(
  data: RadarData | null,
  options: CalibratedShadowCalculationOptions = {},
): CalibratedShadowProbabilityResult {
  const now = options.now ?? new Date();
  const {
    shadowProbability,
    modelVersion = CALIBRATED_SHADOW_MODEL_VERSION,
    includeTeaserStrengthBoost = true,
    legacyOfficialNoticeOverride = false,
    ...rawOptions
  } = options;
  const rawV2 = shadowProbability ?? calculateShadowProbabilityForModel(data, rawOptions, {
    includeTeaserStrengthBoost,
    legacyOfficialNoticeOverride,
  });
  const rawPair = rawV2.predictions;
  const baseResult: CalibratedShadowProbabilityResult = {
    modelVersion,
    calculatedAt: now.toISOString(),
    rawModelVersion: SHADOW_PROBABILITY_MODEL_VERSION,
    rawProbability24h: rawPair.probability24h,
    rawProbability48h: rawPair.probability48h,
    probability24h: rawPair.probability24h,
    probability48h: rawPair.probability48h,
    alpha24h: 0,
    alpha48h: 0,
    calibrationSampleCount24h: 0,
    calibrationSampleCount48h: 0,
    positiveCalibrationCount24h: 0,
    positiveCalibrationCount48h: 0,
    priorStdDev: PREQUENTIAL_CALIBRATION_PRIOR_STD_DEV,
    minimumSamples: PREQUENTIAL_CALIBRATION_MIN_SAMPLES,
    lastResolvedOrigin24h: null,
    lastResolvedOrigin48h: null,
    officialNoticeOverride: rawV2.officialNoticeOverride.active,
    horizonCoherenceAdjusted: false,
    fallbackUsed: false,
    evaluationMode: "prospective",
    pointInTimeProjectionVersion: CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_VERSION,
    pointInTimeProjectionLimitations: CALIBRATED_SHADOW_POINT_IN_TIME_PROJECTION_LIMITATIONS,
    targetDefinition: rawV2.targetDefinition,
  };

  try {
    if (!isValidProbabilityPair(rawPair)) {
      return { ...baseResult, fallbackUsed: true };
    }

    const audit = getLastCalibrationAudit(data, now, options, rawPair);
    if (audit) {
      baseResult.alpha24h = audit.alpha24h;
      baseResult.alpha48h = audit.alpha48h;
      baseResult.calibrationSampleCount24h = audit.calibrationSampleCount24h;
      baseResult.calibrationSampleCount48h = audit.calibrationSampleCount48h;
      baseResult.positiveCalibrationCount24h = audit.positiveCalibrationCount24h;
      baseResult.positiveCalibrationCount48h = audit.positiveCalibrationCount48h;
      baseResult.lastResolvedOrigin24h = audit.lastResolvedOrigin24h;
      baseResult.lastResolvedOrigin48h = audit.lastResolvedOrigin48h;
      baseResult.probability24h = audit.calibratedProbability24h;
      baseResult.probability48h = audit.calibratedProbability48h;
    }

    const coherent = enforceProbabilityHorizonCoherence(
      baseResult.probability24h,
      baseResult.probability48h,
    );
    baseResult.probability24h = coherent.probability24h;
    baseResult.probability48h = coherent.probability48h;
    baseResult.horizonCoherenceAdjusted = coherent.adjusted;

    if (baseResult.officialNoticeOverride) {
      if (legacyOfficialNoticeOverride) {
        baseResult.probability24h = 0.9;
        baseResult.probability48h = 0.96;
      } else {
        baseResult.probability24h = rawV2.officialNoticeOverride.probability24h ?? baseResult.probability24h;
        baseResult.probability48h = rawV2.officialNoticeOverride.probability48h ?? baseResult.probability48h;
      }
      baseResult.horizonCoherenceAdjusted = false;
    }

    if (!isValidProbabilityPair({
      probability24h: baseResult.probability24h,
      probability48h: baseResult.probability48h,
    })) {
      return { ...baseResult, probability24h: rawPair.probability24h, probability48h: rawPair.probability48h, fallbackUsed: true };
    }
    return baseResult;
  } catch {
    return {
      ...baseResult,
      probability24h: rawPair.probability24h,
      probability48h: rawPair.probability48h,
      alpha24h: 0,
      alpha48h: 0,
      calibrationSampleCount24h: 0,
      calibrationSampleCount48h: 0,
      positiveCalibrationCount24h: 0,
      positiveCalibrationCount48h: 0,
      lastResolvedOrigin24h: null,
      lastResolvedOrigin48h: null,
      horizonCoherenceAdjusted: false,
      fallbackUsed: true,
    };
  }
}

export type { PrequentialCalibrationRow } from "./prequentialCalibration";
