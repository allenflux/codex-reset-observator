/**
 * Manual policy for official notices whose lifecycle spans more than one
 * observed reset. Notice text is deliberately not inspected here: new
 * persistent notices must be registered explicitly.
 */
export type OfficialNoticeConsumption = "one_shot" | "persistent";

export type OfficialNoticeTermination = {
  endedAt: string;
  sourceTweetId?: string;
};

export const PERSISTENT_OFFICIAL_NOTICE_IDS = [
  "2095651088502591861",
] as const;

/** Explicit lifecycle corrections; signal text is never inspected to infer termination. */
export const TIBO_FORECAST_SIGNAL_TERMINATIONS: Readonly<Record<string, OfficialNoticeTermination>> = {
  "2097043464538264003": {
    endedAt: "2026-09-08T01:30:00.000Z",
  },
  "2095651088502591861": {
    endedAt: "2026-09-04T22:30:29.000Z",
    sourceTweetId: "2096002992046796932",
  },
  "2095979536043401428": {
    endedAt: "2026-09-04T22:30:29.000Z",
    sourceTweetId: "2096002992046796932",
  },
  "2095597168816226335": {
    endedAt: "2026-09-04T22:30:29.000Z",
    sourceTweetId: "2096002992046796932",
  },
  "2095538856296898868": {
    endedAt: "2026-09-04T15:46:11.000Z",
  },
};

/** Backwards-compatible name for callers that only handle official notices. */
export const OFFICIAL_NOTICE_TERMINATIONS = TIBO_FORECAST_SIGNAL_TERMINATIONS;

const persistentOfficialNoticeIds = new Set<string>(PERSISTENT_OFFICIAL_NOTICE_IDS);
const tiboForecastSignalTerminations = new Map(Object.entries(TIBO_FORECAST_SIGNAL_TERMINATIONS));

export function getOfficialNoticeConsumption(
  noticeId: string | null | undefined,
): OfficialNoticeConsumption {
  return typeof noticeId === "string" && persistentOfficialNoticeIds.has(noticeId.trim())
    ? "persistent"
    : "one_shot";
}

export function isTiboForecastSignalTerminatedAt(
  signalId: string | null | undefined,
  now: Date = new Date(),
) {
  if (typeof signalId !== "string") return false;
  const termination = tiboForecastSignalTerminations.get(signalId.trim());
  if (!termination) return false;

  const nowTime = now.getTime();
  const endedAt = Date.parse(termination.endedAt);
  return Number.isFinite(nowTime) && Number.isFinite(endedAt) && nowTime >= endedAt;
}

export function isOfficialNoticeTerminatedAt(
  noticeId: string | null | undefined,
  now: Date = new Date(),
) {
  return isTiboForecastSignalTerminatedAt(noticeId, now);
}
