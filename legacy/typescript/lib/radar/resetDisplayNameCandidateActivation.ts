import type {
  ResetDisplayNameCandidateActivation,
  ResetDisplayNameCandidateActivationMode,
} from "./resetDisplayNameCandidateTypes";

const MODE_ENV = "RESET_DISPLAY_NAME_CANDIDATE_MODE";
const ADOPTION_AT_ENV = "RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT";
export type ResetDisplayNameCandidateOperation = "seed" | "generate" | "promote";

function isValidIsoTimestamp(value: string | undefined): value is string {
  if (value === undefined) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[8].slice(1, 3));
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[8].slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

export function readResetDisplayNameCandidateActivation(
  env: Readonly<Record<string, string | undefined>>,
): ResetDisplayNameCandidateActivation {
  const rawMode = env[MODE_ENV]?.trim();
  const mode: ResetDisplayNameCandidateActivationMode | undefined =
    rawMode === "off" || rawMode === "seed" || rawMode === "full" ? rawMode : undefined;

  if (!mode || mode === "off") return { mode: "off", adoptionAt: null };

  const adoptionAt = env[ADOPTION_AT_ENV];
  return isValidIsoTimestamp(adoptionAt)
    ? { mode, adoptionAt }
    : { mode: "off", adoptionAt: null };
}

export function isResetDisplayNameCandidateOperationEnabled(
  activation: ResetDisplayNameCandidateActivation,
  operation: ResetDisplayNameCandidateOperation,
): boolean {
  if (activation.mode === "full") return true;
  return activation.mode === "seed" && operation === "seed";
}

export function isResetDisplayNameCandidateNoticeAfterAdoption(
  tweetCreatedAt: string,
  adoptionAt: string,
): boolean {
  const tweetTime = Date.parse(tweetCreatedAt);
  const adoptionTime = Date.parse(adoptionAt);
  return Number.isFinite(tweetTime) && Number.isFinite(adoptionTime) && tweetTime >= adoptionTime;
}
