import type { LocalObservationSignal } from "../data/observationSignals";
import {
  AUTOMATED_TIBO_SIGNAL_WEIGHTS,
  TIBO_TEASER_DECAY_HOURS,
} from "../data/predictionWeights";

export type TiboClassificationResult = {
  category:
    | "RESET_COMPLETED"
    | "OFFICIAL_NOTICE"
    | "TEASER_HINT"
    | "TEASER_RESOLVED_BY_FEATURE"
    | "IRRELEVANT";
  confidence: number;
  reason_ja: string;
  reset_title_ja?: string;
  reset_type_ja?:
    | "ご祝儀リセット"
    | "詫びリセット";
  notice_to_execution?: string;
  key_phrase?: string;
  parsed_notice_time?: string | null;
  resolved_feature_summary_ja?: string;
};

export type TiboTweetItem = {
  id: string;
  createdAt: string;
  text: string;
  url: string;
};

export type TiboProcessedState = {
  lastProcessedTweetId: string;
  processedTweetIds: string[];
  lastProcessedTweetCreatedAt?: string;
};

export const TIBO_TWEET_LOOKBACK_DAYS = 7;

function getTweetTime(tweet: TiboTweetItem) {
  const timestamp = Date.parse(tweet.createdAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function sortTweetsNewestFirst(tweets: TiboTweetItem[]) {
  return [...tweets].sort((left, right) => {
    const leftTime = getTweetTime(left);
    const rightTime = getTweetTime(right);

    if (leftTime === null && rightTime === null) return 0;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  });
}

export function getNewestTweet(tweets: TiboTweetItem[]) {
  return sortTweetsNewestFirst(tweets)[0];
}

export function getNewTweets(
  tweets: TiboTweetItem[],
  state: TiboProcessedState,
  now: Date = new Date(),
) {
  const processedIds = new Set([
    state.lastProcessedTweetId,
    ...state.processedTweetIds,
  ]);
  const baselineTweet = tweets.find((tweet) => tweet.id === state.lastProcessedTweetId);
  const baselineTime = Date.parse(
    state.lastProcessedTweetCreatedAt ?? baselineTweet?.createdAt ?? "",
  );

  if (Number.isNaN(baselineTime)) {
    return [];
  }

  const nowTime = now.getTime();
  const earliestAllowedTime = nowTime - TIBO_TWEET_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  return sortTweetsNewestFirst(tweets)
    .filter((tweet) => {
      const tweetTime = getTweetTime(tweet);
      return (
        tweetTime !== null &&
        tweetTime > baselineTime &&
        tweetTime >= earliestAllowedTime &&
        tweetTime <= nowTime &&
        !processedIds.has(tweet.id)
      );
    })
    .sort((left, right) => (getTweetTime(left) ?? 0) - (getTweetTime(right) ?? 0));
}

export function buildAutomatedTiboSignal(
  tweet: TiboTweetItem,
  classification: TiboClassificationResult,
  now: Date = new Date(),
): LocalObservationSignal {
  const isTeaser = classification.category === "TEASER_HINT";
  const parsedCreatedAt = new Date(tweet.createdAt);
  const observedAt = Number.isNaN(parsedCreatedAt.getTime())
    ? now.toISOString()
    : parsedCreatedAt.toISOString();
  const dateSlug = observedAt.split("T")[0];
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  return {
    id: `official-tibo-auto-${isTeaser ? "hint" : "notice"}-${dateSlug}-${tweet.id.slice(-4)}`,
    observedAt,
    type: isTeaser ? "probability_boost" : "official_notice",
    status: "active",
    expiresAt,
    boostValue24h: isTeaser
      ? AUTOMATED_TIBO_SIGNAL_WEIGHTS.teaser.within24h
      : undefined,
    boostValue48h: isTeaser
      ? AUTOMATED_TIBO_SIGNAL_WEIGHTS.teaser.within48h
      : undefined,
    boostDecayHours: isTeaser ? TIBO_TEASER_DECAY_HOURS : undefined,
    boostReason: `Tibo氏のX投稿（AI自動判定: ${classification.reason_ja}）`,
    title: isTeaser
      ? `Tibo氏がXにて投稿（${classification.reason_ja}）`
      : "Tibo氏がリセット/制限緩和を正式発表",
    source: tweet.url,
    sourceLabel: "Tibo氏（OpenAI Codex開発者）のXポストより（自動判定）",
  };
}

export function adjustActiveTiboTeaserBoosts(source: string) {
  return source.replace(/\{[\s\S]*?\n\s*\},?/g, (block) => {
    const id = block.match(/id:\s*"([^"]+)"/)?.[1] ?? "";
    const isTiboTeaser =
      id.startsWith("official-tibo-") &&
      (id.includes("hint") || id.includes("teaser"));
    const isActive = /status:\s*"active"/.test(block);
    const isProbabilityBoost = /type:\s*"probability_boost"/.test(block);

    if (!isTiboTeaser || !isActive || !isProbabilityBoost) {
      return block;
    }

    return block
      .replace(
        /boostValue24h:\s*-?[\d.]+/,
        `boostValue24h: ${AUTOMATED_TIBO_SIGNAL_WEIGHTS.afterFeatureRelease.within24h}`,
      )
      .replace(
        /boostValue48h:\s*-?[\d.]+/,
        `boostValue48h: ${AUTOMATED_TIBO_SIGNAL_WEIGHTS.afterFeatureRelease.within48h}`,
      )
      .replace(/\s*boostReason:\s*"[^"]*",?/g, "");
  });
}
