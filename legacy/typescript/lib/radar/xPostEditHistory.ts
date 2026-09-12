const TIBO_USERNAME = "thsottiaux";
const X_POST_LOOKUP_URL = "https://api.x.com/2/tweets";
const DEFAULT_TIMEOUT_MS = 5_000;

export type TiboEditMetadataSource = "x_api" | "none";

export type TiboEditHistoryMetadata = {
  trusted: boolean;
  logicalPostId: string;
  editHistoryTweetIds: string[];
  editVersion: number;
  editMetadataSource: TiboEditMetadataSource;
};

export type ResolveTiboPostEditHistoryOptions = {
  token?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function isNumericPostId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createUntrustedTiboEditHistoryMetadata(tweetId: string): TiboEditHistoryMetadata {
  return {
    trusted: false,
    logicalPostId: tweetId,
    editHistoryTweetIds: [tweetId],
    editVersion: 1,
    editMetadataSource: "none",
  };
}

export function parseTrustedTiboEditHistoryResponse(
  payload: unknown,
  tweetId: string,
): TiboEditHistoryMetadata | null {
  if (!isNumericPostId(tweetId) || !isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }

  const data = payload.data;
  if (data.id !== tweetId || !isNumericPostId(data.author_id)) return null;

  const rawHistory = data.edit_history_tweet_ids;
  if (!Array.isArray(rawHistory) || rawHistory.length === 0 || rawHistory.length > 6) return null;

  const editHistoryTweetIds = rawHistory.every(isNumericPostId)
    ? [...rawHistory]
    : null;
  if (!editHistoryTweetIds || new Set(editHistoryTweetIds).size !== editHistoryTweetIds.length) {
    return null;
  }

  const editVersionIndex = editHistoryTweetIds.indexOf(tweetId);
  if (editVersionIndex < 0) return null;

  const includes = isRecord(payload.includes) ? payload.includes : null;
  const users = includes?.users;
  if (!Array.isArray(users)) return null;
  const author = users.find((user) => isRecord(user) && user.id === data.author_id);
  if (!isRecord(author) || typeof author.username !== "string") return null;
  if (author.username.toLowerCase() !== TIBO_USERNAME) return null;

  return {
    trusted: true,
    logicalPostId: editHistoryTweetIds[0],
    editHistoryTweetIds,
    editVersion: editVersionIndex + 1,
    editMetadataSource: "x_api",
  };
}

export async function resolveTiboPostEditHistory(
  tweetId: string,
  options: ResolveTiboPostEditHistoryOptions = {},
): Promise<TiboEditHistoryMetadata> {
  const fallback = createUntrustedTiboEditHistoryMetadata(tweetId);
  const token = options.token === undefined
    ? process.env.X_API_BEARER_TOKEN?.trim()
    : options.token?.trim();
  if (!token) return fallback;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const lookupUrl = new URL(`${X_POST_LOOKUP_URL}/${encodeURIComponent(tweetId)}`);
  lookupUrl.searchParams.set("tweet.fields", "author_id,edit_history_tweet_ids");
  lookupUrl.searchParams.set("expansions", "author_id");
  lookupUrl.searchParams.set("user.fields", "username");

  try {
    const response = await fetchImpl(lookupUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return fallback;

    const payload = await response.json() as unknown;
    return parseTrustedTiboEditHistoryResponse(payload, tweetId) ?? fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
