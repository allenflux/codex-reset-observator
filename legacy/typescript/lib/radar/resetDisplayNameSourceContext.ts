export type ResetDisplayNameSourceRow = {
  tweet_id: string;
  text: string;
  tweet_created_at?: string | null;
  is_reply?: boolean | null;
  verification_status?: string | null;
};

export type ResetDisplayNameSourceContextInput = {
  effectiveFormalCandidate: ResetDisplayNameSourceRow;
  sourceTweetIds: readonly string[];
  sourceRows?: readonly ResetDisplayNameSourceRow[];
};

export const MAX_RESET_DISPLAY_NAME_SOURCE_CONTEXT_LENGTH = 25_000;

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareRows(left: ResetDisplayNameSourceRow, right: ResetDisplayNameSourceRow) {
  const leftTimestamp = parseTimestamp(left.tweet_created_at);
  const rightTimestamp = parseTimestamp(right.tweet_created_at);
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  if (leftTimestamp !== null && rightTimestamp === null) return -1;
  if (leftTimestamp === null && rightTimestamp !== null) return 1;
  return left.tweet_id.localeCompare(right.tweet_id);
}

function isUsableSourceRow(row: ResetDisplayNameSourceRow) {
  return row.is_reply !== true &&
    row.verification_status !== "rejected" &&
    row.tweet_id.trim().length > 0 &&
    row.text.trim().length > 0;
}

/**
 * Builds the naming source from explicit event provenance only. Nearby posts
 * are deliberately invisible to this helper unless their IDs were persisted
 * as part of the canonical event evidence.
 */
export function buildResetDisplayNameSourceContext({
  effectiveFormalCandidate,
  sourceTweetIds,
  sourceRows = [],
}: ResetDisplayNameSourceContextInput) {
  const canonicalIds = new Set(
    sourceTweetIds
      .map((tweetId) => tweetId.trim())
      .filter(Boolean),
  );
  if (canonicalIds.size === 0) return null;

  const rowsByTweetId = new Map<string, ResetDisplayNameSourceRow>();
  for (const row of sourceRows) {
    const tweetId = row.tweet_id.trim();
    if (!canonicalIds.has(tweetId) || !isUsableSourceRow(row)) continue;
    if (!rowsByTweetId.has(tweetId)) rowsByTweetId.set(tweetId, { ...row, tweet_id: tweetId });
  }

  const candidateId = effectiveFormalCandidate.tweet_id.trim();
  if (canonicalIds.has(candidateId) && isUsableSourceRow(effectiveFormalCandidate)) {
    rowsByTweetId.set(candidateId, { ...effectiveFormalCandidate, tweet_id: candidateId });
  }

  const rows = Array.from(rowsByTweetId.values()).sort(compareRows);
  if (rows.length === 0) return null;

  const context = rows
    .map((row, index) => [
      `[Tibo post ${index + 1} | tweet_id=${row.tweet_id}]`,
      row.text,
      `[End Tibo post ${index + 1}]`,
    ].join("\n"))
    .join("\n\n");

  return context.length <= MAX_RESET_DISPLAY_NAME_SOURCE_CONTEXT_LENGTH
    ? context
    : null;
}
