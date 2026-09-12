import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import {
  areFormalTiboResetSignalsSameCluster,
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
} from "./tiboHistory";
import type { UsageMonitorCoverage } from "../codexUsageMonitorCoverage";

export type FormalAdoptionResult = {
  newlyAdopted: boolean;
  tweetId: string | null;
  title: string | null;
  confidence: number | null;
  sourceUrl: string | null;
};

export type UsageMonitorRecoveryLookup = {
  available: boolean;
  matched: boolean;
};

/**
 * Fresh monitor coverage can use the absence of a meaningful quota recovery
 * as a safety signal for an unverified Tibo completion. Stale or unavailable
 * coverage is deliberately non-blocking: absence there is not evidence.
 */
export function shouldDeferFormalTiboReset(
  candidate: FormalTiboResetSignal,
  coverage: UsageMonitorCoverage,
  recoveryLookup: UsageMonitorRecoveryLookup,
) {
  return (
    candidate.verification_status !== "confirmed" &&
    isFormalTiboResetSignal(candidate) &&
    coverage.state === "fresh" &&
    recoveryLookup.available &&
    !recoveryLookup.matched
  );
}

function hasStaticHistoryTweet(tweetId: string) {
  return LOCAL_RESET_HISTORY.some((item) => {
    const sourceTweetId = item.source_url?.match(/\/status\/(\d+)/i)?.[1];
    return sourceTweetId === tweetId || item.sourceTweetIds?.includes(tweetId) === true;
  });
}
function wasAlreadyFormal(
  existing: Partial<FormalTiboResetSignal> | null | undefined,
  candidate: FormalTiboResetSignal,
) {
  if (!existing) return false;

  return isFormalTiboResetSignal({
    tweet_id: existing.tweet_id ?? candidate.tweet_id,
    text: existing.text ?? "",
    tweet_url: existing.tweet_url ?? candidate.tweet_url,
    tweet_created_at: existing.tweet_created_at ?? candidate.tweet_created_at,
    signal_type: existing.signal_type ?? "irrelevant",
    confidence: existing.confidence ?? null,
    verification_status: existing.verification_status ?? "auto_unverified",
    classification_source: existing.classification_source ?? null,
  });
}

export function isNewFormalAdoption(
  candidate: FormalTiboResetSignal,
  existing: Partial<FormalTiboResetSignal> | null | undefined,
  lookupAvailable = true,
) {
  if (!lookupAvailable || !isFormalTiboResetSignal(candidate)) return false;
  if (hasStaticHistoryTweet(candidate.tweet_id)) return false;
  return !wasAlreadyFormal(existing, candidate);
}

export function hasExistingFormalResetCluster(
  candidate: FormalTiboResetSignal,
  existingSignals: Array<FormalTiboResetSignal>,
) {
  return existingSignals.some((existing) =>
    existing.tweet_id !== candidate.tweet_id &&
    areFormalTiboResetSignalsSameCluster(candidate, existing),
  );
}

export function buildFormalAdoptionResult(
  newlyAdopted: boolean,
  candidate: FormalTiboResetSignal,
): FormalAdoptionResult {
  return {
    newlyAdopted,
    tweetId: newlyAdopted ? candidate.tweet_id : null,
    title: newlyAdopted ? "ランダムリセット" : null,
    confidence: newlyAdopted ? candidate.confidence : null,
    sourceUrl: newlyAdopted ? candidate.tweet_url : null,
  };
}
