import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const SIGNALS_PATH = path.join(DATA_DIR, "redditSignals.json");
const SUMMARY_PATH = path.join(DATA_DIR, "redditSignalSummary.json");

const SUBREDDITS = ["OpenAI", "ChatGPT", "codex"];
const FETCHED_AT = new Date().toISOString();
const USER_AGENT =
  process.env.REDDIT_USER_AGENT ??
  "codex-reset-observatory/0.1 internal-signal-research";
const REQUEST_DELAY_MS = Number(process.env.REDDIT_FETCH_DELAY_MS ?? 2500);

const SEARCH_KEYWORDS = [
  "codex",
  "usage limit",
  "rate limit",
  "capacity",
  "at capacity",
  "reached capacity",
  "reset",
  "limit reset",
  "high error",
  "unavailable",
];

const SIGNAL_RULES = [
  {
    type: "limit_anomaly",
    score: 4,
    keywords: ["usage limit", "rate limit", "limit reset"],
  },
  {
    type: "capacity",
    score: 4,
    keywords: ["capacity", "at capacity", "reached capacity"],
  },
  {
    type: "reset_talk",
    score: 3,
    keywords: ["reset", "limit reset"],
  },
  {
    type: "incident_complaint",
    score: 3,
    keywords: ["high error", "unavailable"],
  },
];

const XML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const existingSignals = await readJsonArray(SIGNALS_PATH);
  const fetchedPosts = [];
  const fetchResults = [];

  for (const [index, subreddit] of SUBREDDITS.entries()) {
    if (index > 0) {
      await sleep(REQUEST_DELAY_MS);
    }

    const result = await fetchSubredditSignals(subreddit);
    fetchResults.push(result.meta);
    fetchedPosts.push(...result.posts);
  }

  const nextSignals = mergeSignals(existingSignals, fetchedPosts);
  const summary = buildSummary(nextSignals, fetchResults);

  await writeJson(SIGNALS_PATH, nextSignals);
  await writeJson(SUMMARY_PATH, summary);

  console.log(
    JSON.stringify(
      {
        fetchedAt: FETCHED_AT,
        fetchedPosts: fetchedPosts.length,
        savedSignals: nextSignals.length,
        newSignals: nextSignals.length - existingSignals.length,
        summary: summary.windows,
        fetchResults,
      },
      null,
      2,
    ),
  );
}

async function fetchSubredditSignals(subreddit) {
  const jsonResult = await fetchSubredditJson(subreddit);
  if (jsonResult.ok) {
    return {
      posts: jsonResult.posts,
      meta: {
        subreddit,
        method: "reddit_json",
        ok: true,
        status: jsonResult.status,
        count: jsonResult.posts.length,
      },
    };
  }

  const rssResult = await fetchSubredditRss(subreddit);
  return {
    posts: rssResult.posts,
    meta: {
      subreddit,
      method: "reddit_rss_fallback",
      ok: rssResult.ok,
      status: rssResult.status,
      count: rssResult.posts.length,
      jsonError: jsonResult.error,
      rssError: rssResult.error,
    },
  };
}

async function fetchSubredditJson(subreddit) {
  const url = new URL(`https://www.reddit.com/r/${subreddit}/search.json`);
  url.searchParams.set("q", "codex");
  url.searchParams.set("restrict_sr", "1");
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "week");
  url.searchParams.set("limit", "50");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        posts: [],
        error: `${response.status} ${response.statusText}`,
      };
    }

    const body = await response.json();
    const children = Array.isArray(body?.data?.children)
      ? body.data.children
      : [];
    const posts = children
      .map((child) => normalizeJsonPost(subreddit, child?.data))
      .filter(Boolean);

    return { ok: true, status: response.status, posts };
  } catch (error) {
    return {
      ok: false,
      status: null,
      posts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchSubredditRss(subreddit) {
  const url = new URL(`https://www.reddit.com/r/${subreddit}/search.rss`);
  url.searchParams.set("q", "codex");
  url.searchParams.set("restrict_sr", "1");
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "week");
  url.searchParams.set("limit", "50");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/atom+xml, application/rss+xml, text/xml",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        posts: [],
        error: `${response.status} ${response.statusText}`,
      };
    }

    const xml = await response.text();
    const posts = parseAtomEntries(xml)
      .map((entry) => normalizeRssPost(subreddit, entry))
      .filter(Boolean);

    return { ok: true, status: response.status, posts };
  } catch (error) {
    return {
      ok: false,
      status: null,
      posts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeJsonPost(subreddit, post) {
  if (!post?.id || !post?.title || post?.stickied) {
    return null;
  }

  const text = `${post.title ?? ""}\n${post.selftext ?? ""}`;
  const classification = classifySignal(text);
  if (!classification) {
    return null;
  }

  return {
    fetchedAt: FETCHED_AT,
    source: "reddit_json",
    subreddit,
    postId: post.id,
    title: post.title,
    url: normalizeRedditUrl(post.url_overridden_by_dest ?? post.permalink),
    createdAt: new Date((post.created_utc ?? 0) * 1000).toISOString(),
    score: Number.isFinite(post.score) ? post.score : null,
    comments: Number.isFinite(post.num_comments) ? post.num_comments : null,
    matchedKeywords: classification.matchedKeywords,
    signalType: classification.signalType,
    signalScore: classification.signalScore,
  };
}

function normalizeRssPost(subreddit, entry) {
  if (!entry.id || !entry.title) {
    return null;
  }

  const text = `${entry.title}\n${entry.content ?? ""}`;
  const classification = classifySignal(text);
  if (!classification) {
    return null;
  }

  return {
    fetchedAt: FETCHED_AT,
    source: "reddit_rss",
    subreddit,
    postId: getRedditPostId(entry.id) ?? entry.id,
    title: entry.title,
    url: entry.link ?? entry.id,
    createdAt: entry.updated ?? entry.published ?? null,
    score: null,
    comments: null,
    matchedKeywords: classification.matchedKeywords,
    signalType: classification.signalType,
    signalScore: classification.signalScore,
  };
}

function classifySignal(text) {
  const lowerText = stripHtml(text).toLowerCase();
  const matchedKeywords = SEARCH_KEYWORDS.filter((keyword) =>
    lowerText.includes(keyword),
  );

  if (!matchedKeywords.includes("codex")) {
    return null;
  }

  const rule =
    SIGNAL_RULES.find((candidate) =>
      candidate.keywords.some((keyword) => matchedKeywords.includes(keyword)),
    ) ?? null;

  if (!rule) {
    return {
      matchedKeywords,
      signalType: "noise",
      signalScore: 1,
    };
  }

  return {
    matchedKeywords,
    signalType: rule.type,
    signalScore: rule.score + Math.max(0, matchedKeywords.length - 1),
  };
}

function mergeSignals(existingSignals, fetchedSignals) {
  const byKey = new Map();

  for (const signal of existingSignals) {
    byKey.set(getSignalKey(signal), signal);
  }

  for (const signal of fetchedSignals) {
    const key = getSignalKey(signal);
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, ...signal } : signal);
  }

  return [...byKey.values()].sort(
    (a, b) => getTime(b.createdAt) - getTime(a.createdAt),
  );
}

function buildSummary(signals, fetchResults) {
  const now = new Date(FETCHED_AT);
  const relatedSignals = signals.filter((signal) => signal.signalType !== "noise");
  const last6h = filterSince(relatedSignals, now, 6);
  const last24h = filterSince(relatedSignals, now, 24);
  const baselineSignals = relatedSignals.filter((signal) => {
    const ageHours = (now.getTime() - getTime(signal.createdAt)) / 36e5;
    return ageHours > 24 && ageHours <= 24 * 14;
  });
  const baselineDailyAverage = baselineSignals.length / 13;
  const last24hSignalScoreTotal = sumSignalScore(last24h);
  const baselineDailyScoreAverage = sumSignalScore(baselineSignals) / 13;

  return {
    generatedAt: FETCHED_AT,
    sources: SUBREDDITS.map((subreddit) => `r/${subreddit}`),
    fetchResults,
    windows: {
      relatedPosts6h: last6h.length,
      relatedPosts24h: last24h.length,
      signalScore24h: last24hSignalScoreTotal,
      signalTypeCounts24h: countBySignalType(last24h),
    },
    baseline: {
      lookbackDays: 14,
      excludesLastHours: 24,
      relatedPostsPerDayAverage: roundMetric(baselineDailyAverage),
      signalScorePerDayAverage: roundMetric(baselineDailyScoreAverage),
      relatedPosts24hDeltaFromAverage: roundMetric(
        last24h.length - baselineDailyAverage,
      ),
      signalScore24hDeltaFromAverage: roundMetric(
        last24hSignalScoreTotal - baselineDailyScoreAverage,
      ),
    },
    note:
      "Internal Reddit observation log only. Not shown on public pages and not used by reset probability logic.",
  };
}

function parseAtomEntries(xml) {
  return [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map((match) => {
    const entryXml = match[0];
    return {
      id: getXmlText(entryXml, "id"),
      title: getXmlText(entryXml, "title"),
      updated: getXmlText(entryXml, "updated"),
      published: getXmlText(entryXml, "published"),
      content: getXmlText(entryXml, "content"),
      link: getXmlLink(entryXml),
    };
  });
}

function getXmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1].trim()) : null;
}

function getXmlLink(xml) {
  const match = xml.match(/<link\b[^>]*href="([^"]+)"/);
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (_, entity) => XML_ENTITIES[entity] ?? `&${entity};`);
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeRedditUrl(value) {
  if (!value) {
    return null;
  }

  if (value.startsWith("/")) {
    return `https://www.reddit.com${value}`;
  }

  return value;
}

function getRedditPostId(value) {
  return value?.match(/comments\/([a-z0-9]+)/i)?.[1] ?? null;
}

async function readJsonArray(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getSignalKey(signal) {
  return signal.postId ? `${signal.subreddit}:${signal.postId}` : signal.url;
}

function filterSince(signals, now, hours) {
  const minTime = now.getTime() - hours * 60 * 60 * 1000;
  return signals.filter((signal) => getTime(signal.createdAt) >= minTime);
}

function getTime(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function sumSignalScore(signals) {
  return signals.reduce((total, signal) => total + (signal.signalScore ?? 0), 0);
}

function countBySignalType(signals) {
  return signals.reduce((counts, signal) => {
    counts[signal.signalType] = (counts[signal.signalType] ?? 0) + 1;
    return counts;
  }, {});
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
