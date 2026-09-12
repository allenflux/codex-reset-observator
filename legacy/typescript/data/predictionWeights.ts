export const EXPECTATION_THRESHOLDS = {
  medium: { p24h: 0.30, p48h: 0.30 },
  high: { p24h: 0.61, p48h: 0.61 },
  veryHigh: { p24h: 0.80, p48h: 0.85 },
} as const;

export const REFRESH_INTERVAL_THRESHOLDS = {
  medium: 0.20,
  high: EXPECTATION_THRESHOLDS.high.p24h,
  veryHigh: EXPECTATION_THRESHOLDS.veryHigh.p24h,
} as const;

export const PROBABILITY_MODEL_VERSION = "heuristic-v2-time-consistent";

export const RECOMMENDED_ACTION_THRESHOLDS = {
  watch: 0.1,
  medium: 0.3,
  high: 0.6,
} as const;

export const REFRESH_INTERVAL_MS = {
  unknown: 15 * 60 * 1000,
  low: 30 * 60 * 1000,
  medium: 30 * 60 * 1000,
  high: 20 * 60 * 1000,
  veryHigh: 10 * 60 * 1000,
} as const;

export const AUTOMATED_TIBO_SIGNAL_WEIGHTS = {
  teaser: {
    within24h: 0.2,
    within48h: 0.3,
  },
  afterFeatureRelease: {
    within24h: 0.2,
    within48h: 0.3,
  },
} as const;

export const TIBO_TEASER_DECAY_HOURS = 48;

export const LOCAL_PROBABILITY_WEIGHTS = {
  min: {
    within24h: 0.02,
    within48h: 0.05,
  },
  max: {
    within24h: 0.72,
    within48h: 0.82,
  },
  momentumBoost: {
    level1: { within24h: 0.195, within48h: 0.26 },
    level2: { within24h: 0.55, within48h: 0.74 },
  },
  officialNotice: {
    within24h: 0.9,
    within48h: 0.96,
  },
  base: {
    within24h: 0.025,
    within48h: 0.06,
  },
  countLimits: {
    statusIncidents: 5,
    officialIncidentHints: 3,
    officialUpdates: 8,
    communityMentions: 80,
    issueAnomalies: 30,
  },
  signalWeights: {
    statusIncident: {
      within24h: 0.05,
      within48h: 0.07,
    },
    officialUpdate: {
      within24h: 0.004,
      within48h: 0.007,
    },
    officialIncidentHint: {
      within24h: 0.25,
      within48h: 0.32,
    },
    communityMention: {
      within24h: 0.0008,
      within48h: 0.0015,
    },
    issueAnomaly: {
      within24h: 0.004,
      within48h: 0.007,
    },
  },
  pressureBoost: {
    high: 0.12,
    medium: 0.05,
    low: 0,
  },
  elapsedDayBoost: {
    perDay: 0.01,
  },
  regularResetProximity: {
    forecast24h: {
      leadInHours: 24,
      entry: 0.02,
      max: 0.05,
    },
    forecast48h: {
      leadInHours: 7 * 24,
      entry: 0,
      max: 0.07,
    },
  },
  historicalResetPressure: {
    priorWeight: 8,
    forecast24h: {
      priorRate: 0.12,
      maxBoost: 0.08,
    },
    forecast48h: {
      priorRate: 0.25,
      maxBoost: 0.12,
    },
  },
  historyPressure: [
    {
      // リセットから24時間以内 (0日経過)
      maxDaysSinceReset: 1,
      within24h: -0.08,
      within48h: -0.14,
    },
    {
      // リセットから48時間以内 (1日経過)
      maxDaysSinceReset: 2,
      within24h: -0.06,
      within48h: -0.08,
    },
    {
      // 48時間 (2日) 超過以降はマイナスなし (0%)
      maxDaysSinceReset: Number.POSITIVE_INFINITY,
      within24h: 0,
      within48h: 0,
    },
  ],
} as const;
