export type MajorModelReleasePhase = "strong" | "medium" | "weak";

export type MajorModelRelease = {
  readonly id: string;
  readonly displayName: string;
  readonly releaseStartAt: string;
  readonly source: "tibo";
  readonly sourceTweetId: string;
  readonly sourceUrl: string;
};

export type MajorModelReleaseRegime = MajorModelRelease & {
  readonly phase: MajorModelReleasePhase;
  readonly floor24h: number;
  readonly floor48h: number;
  readonly ageHours: number;
};

export type MajorModelReleaseAdjustment =
  | {
      readonly active: false;
      readonly releaseId: null;
      readonly displayName: null;
      readonly releaseStartAt: null;
      readonly phase: null;
      readonly floor24h: null;
      readonly floor48h: null;
      readonly baseProbability24h: null;
      readonly baseProbability48h: null;
      readonly applied24h: null;
      readonly applied48h: null;
    }
  | {
      readonly active: true;
      readonly releaseId: string;
      readonly displayName: string;
      readonly releaseStartAt: string;
      readonly phase: MajorModelReleasePhase;
      readonly floor24h: number;
      readonly floor48h: number;
      readonly baseProbability24h: number;
      readonly baseProbability48h: number;
      readonly applied24h: number;
      readonly applied48h: number;
    };

export const MAJOR_MODEL_RELEASES = [
  {
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    releaseStartAt: "2026-09-03T19:37:54.000Z",
    source: "tibo",
    sourceTweetId: "2095597168816226335",
    sourceUrl: "https://x.com/thsottiaux/status/2095597168816226335",
  },
] as const satisfies readonly MajorModelRelease[];

const HOUR_MS = 60 * 60 * 1000;
const RELEASE_REGIME_END_HOURS = 240;

function getPhaseForAge(ageHours: number) {
  if (ageHours < 72) {
    return { phase: "strong" as const, floor24h: 0.52, floor48h: 0.75 };
  }
  if (ageHours < 168) {
    return { phase: "medium" as const, floor24h: 0.42, floor48h: 0.65 };
  }
  return { phase: "weak" as const, floor24h: 0.30, floor48h: 0.50 };
}

export function getMajorModelReleaseRegime(
  now: Date,
  releases: readonly MajorModelRelease[] = MAJOR_MODEL_RELEASES,
): MajorModelReleaseRegime | null {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return null;

  for (const release of releases) {
    const releaseStartTime = Date.parse(release.releaseStartAt);
    if (!Number.isFinite(releaseStartTime)) continue;

    const ageHours = (nowTime - releaseStartTime) / HOUR_MS;
    if (ageHours < 0 || ageHours >= RELEASE_REGIME_END_HOURS) continue;

    return {
      ...release,
      ...getPhaseForAge(ageHours),
      ageHours,
    };
  }

  return null;
}
