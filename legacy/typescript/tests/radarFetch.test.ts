import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ACTIVE_TIBO_SIGNAL_TYPES,
  ACTIVE_TIBO_SIGNAL_SELECT_FIELDS,
  applyActiveTiboQueryFilters,
  associateTiboNotices,
  buildPublicRadarSnapshotBundle,
  getEffectiveRadarCalculationNow,
  getRadarPageCacheDimensions,
  getRandomResetHeatmapCacheDimensions,
  getPublicRadarSnapshotCacheDimensions,
  getPublicRadarSnapshotCalculationBucket,
  RADAR_PAGE_CACHE_TTL_SECONDS,
  PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS,
  PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS,
  RADAR_CORE_CACHE_TTL_SECONDS,
  readTiboHistorySignals,
  splitTiboHistorySignals,
  TIBO_HISTORY_MAX_ROWS,
  TIBO_HISTORY_SELECT_FIELDS,
} from "../lib/radarFetch";
import { getLocalRadarData } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { FormalTiboResetSignal, TiboNoticeSignal } from "../lib/radar/tiboHistory";

function resetSignal(tweetId: string, createdAt: string): FormalTiboResetSignal {
  return {
    tweet_id: tweetId,
    text: "I reset usage limits for Codex.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: createdAt,
    signal_type: "reset_executed",
    confidence: 0.99,
    verification_status: "auto_unverified",
    classification_source: "gemini",
  };
}

function noticeSignal(tweetId: string, createdAt: string): TiboNoticeSignal {
  return {
    tweet_id: tweetId,
    text: "A reset is coming soon.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: createdAt,
    signal_type: "official_notice",
    confidence: 0.99,
    verification_status: "auto_unverified",
  };
}

test("shared Radar core uses a fifteen-minute normal cache TTL", () => {
  assert.equal(RADAR_CORE_CACHE_TTL_SECONDS, 15 * 60);
});

test("page projections use a one-hour cache while API snapshots keep a ten-minute bucket and one-hour retention", () => {
  assert.equal(RADAR_PAGE_CACHE_TTL_SECONDS, 60 * 60);
  assert.equal(PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS, 10 * 60);
  assert.equal(PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS, 60 * 60);
  assert.ok(PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS > PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS);

  const source = readFileSync(resolve("lib/radarFetch.ts"), "utf8");
  const pageFetchSource = source.slice(source.indexOf("export async function fetchRadarPageData"));
  const heatmapCacheSource = source.slice(
    source.indexOf("const getCachedRandomResetHeatmapEventTimes = unstable_cache("),
    source.indexOf("const getCachedRadarPageData = unstable_cache("),
  );

  assert.match(source, /getCachedRadarPageData = unstable_cache/);
  assert.match(source, /revalidate: RADAR_PAGE_CACHE_TTL_SECONDS/);
  assert.match(source, /revalidate: PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS/);
  assert.doesNotMatch(source, /PUBLIC_RADAR_SNAPSHOT_CACHE_TTL_SECONDS/);
  assert.match(heatmapCacheSource, /revalidate: PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS/);
  assert.match(source, /tags: \["radar-data"\]/);
  assert.match(pageFetchSource, /getCachedRadarPageData/);
  assert.doesNotMatch(pageFetchSource, /fetchPublicRadarSnapshot|fetchRandomResetHeatmapEventTimes/);
});

test("page cache dimensions use a one-hour bucket and preserve home/history variants", () => {
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const beforeBoundary = start + RADAR_PAGE_CACHE_TTL_SECONDS * 1000 - 1;
  const nextBucket = start + RADAR_PAGE_CACHE_TTL_SECONDS * 1000;

  assert.deepEqual(
    getRadarPageCacheDimensions("ja", start),
    { locale: "ja", calculationBucket: Math.floor(start / (RADAR_PAGE_CACHE_TTL_SECONDS * 1000)), limitHistory: true, includeHeatmap: true },
  );
  assert.equal(
    getRadarPageCacheDimensions("ja", start).calculationBucket,
    getRadarPageCacheDimensions("ja", beforeBoundary).calculationBucket,
  );
  assert.notEqual(
    getRadarPageCacheDimensions("ja", start).calculationBucket,
    getRadarPageCacheDimensions("ja", nextBucket).calculationBucket,
  );
  assert.deepEqual(
    getRadarPageCacheDimensions("en", start, false, false),
    { locale: "en", calculationBucket: Math.floor(start / (RADAR_PAGE_CACHE_TTL_SECONDS * 1000)), limitHistory: false, includeHeatmap: false },
  );
});

test("public snapshot bundle cache keys use ten-minute bucket and history limit", () => {
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const beforeBoundary = start + PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS * 1000 - 1;
  const nextBucket = start + PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS * 1000;

  assert.equal(
    getPublicRadarSnapshotCalculationBucket(start),
    getPublicRadarSnapshotCalculationBucket(beforeBoundary),
  );
  assert.notEqual(
    getPublicRadarSnapshotCalculationBucket(start),
    getPublicRadarSnapshotCalculationBucket(nextBucket),
  );
  assert.deepEqual(getPublicRadarSnapshotCacheDimensions(start), {
    calculationBucket: getPublicRadarSnapshotCalculationBucket(start),
    limitHistory: true,
  });
  assert.deepEqual(getPublicRadarSnapshotCacheDimensions(start, false), {
    calculationBucket: getPublicRadarSnapshotCalculationBucket(start),
    limitHistory: false,
  });
});

test("one public snapshot bundle matches the previous locale-by-locale DTOs", () => {
  const calculationNow = new Date("2026-09-09T01:23:45.000Z");
  const generatedAt = "2026-09-09T01:20:00.000Z";
  const data = getLocalRadarData({ checkedAt: generatedAt, calculationNow });
  const core = { data, generatedAt, stale: false };
  const calculationBucket = getPublicRadarSnapshotCalculationBucket(calculationNow);

  for (const limitHistory of [true, false]) {
    const bundle = buildPublicRadarSnapshotBundle(core, calculationBucket, limitHistory);
    const effectiveCalculationNow = getEffectiveRadarCalculationNow(calculationBucket, generatedAt);

    assert.deepEqual(Object.keys(bundle), ["ja", "en", "zh"]);
    for (const locale of ["ja", "en", "zh"] as const) {
      const expected = toPublicRadarSnapshot(data, locale, {
        stale: false,
        generatedAt,
        limitHistory,
        calculationNow: effectiveCalculationNow,
      });
      assert.equal(JSON.stringify(bundle[locale]), JSON.stringify(expected));
    }
  }
});

test("homepage snapshot and heatmap share the calculation bucket contract", () => {
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const sameBucket = start + 5 * 60 * 1000;
  const nextBucket = start + PUBLIC_RADAR_SNAPSHOT_BUCKET_SECONDS * 1000;

  assert.deepEqual(
    getRandomResetHeatmapCacheDimensions(start),
    getRandomResetHeatmapCacheDimensions(sameBucket),
  );
  assert.notDeepEqual(
    getRandomResetHeatmapCacheDimensions(start),
    getRandomResetHeatmapCacheDimensions(nextBucket),
  );
  assert.equal(
    getPublicRadarSnapshotCacheDimensions(start).calculationBucket,
    getRandomResetHeatmapCacheDimensions(start).calculationBucket,
  );
  for (const locale of ["en", "zh"] as const) {
    assert.equal(
      getPublicRadarSnapshotCacheDimensions(start).calculationBucket,
      getRandomResetHeatmapCacheDimensions(start).calculationBucket,
    );
  }
});

test("cached projections use refreshed core time within the bucket without changing the cache key", () => {
  const bucketStart = Date.parse("2026-09-01T00:00:00.000Z");
  const bucket = getPublicRadarSnapshotCalculationBucket(bucketStart);

  assert.equal(
    getEffectiveRadarCalculationNow(bucket, "2026-09-01T00:05:00.000Z").toISOString(),
    "2026-09-01T00:05:00.000Z",
  );
  assert.equal(
    getEffectiveRadarCalculationNow(bucket, "2026-08-31T23:59:59.000Z").toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(
    getEffectiveRadarCalculationNow(bucket, "invalid").toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(
    getPublicRadarSnapshotCacheDimensions(bucketStart).calculationBucket,
    getPublicRadarSnapshotCacheDimensions(bucketStart + 9 * 60 * 1000).calculationBucket,
  );
});

test("active Tibo filters are applied before ordering and limit", () => {
  const calls: string[] = [];
  const builder = {
    not: () => {
      calls.push("not:expires_at.is.null");
      return builder;
    },
    gt: () => {
      calls.push("gt:expires_at");
      return builder;
    },
    or: () => {
      calls.push(calls.some((call) => call === "or:verification_status") ? "or:is_reply" : "or:verification_status");
      return builder;
    },
    in: (_column: string, values: string[]) => {
      calls.push(`in:signal_type:${values.join(",")}`);
      return builder;
    },
    order: (_column: string, _options: { ascending: boolean }) => {
      calls.push("order");
      return builder;
    },
    limit: async (_count: number) => {
      calls.push("limit");
      return { data: [], error: null };
    },
  };

  applyActiveTiboQueryFilters(builder, "2026-08-04T00:00:00.000Z");
  builder.order("tweet_created_at", { ascending: false });
  void builder.limit(20);

  assert.deepEqual(calls, [
    "not:expires_at.is.null",
    "gt:expires_at",
    "or:verification_status",
    "or:is_reply",
    `in:signal_type:${ACTIVE_TIBO_SIGNAL_TYPES.join(",")}`,
    "order",
    "limit",
  ]);
});

test("one reply-inclusive history result derives the formal view without changing the recent view", () => {
  const rows: FormalTiboResetSignal[] = [
    { ...resetSignal("reply", "2026-08-03T10:00:00.000Z"), is_reply: true },
    { ...resetSignal("post", "2026-08-02T10:00:00.000Z"), is_reply: false },
    { ...resetSignal("legacy", "2026-08-01T10:00:00.000Z"), is_reply: null },
  ];

  const split = splitTiboHistorySignals(rows);

  assert.strictEqual(split.withReplies, rows);
  assert.deepEqual(split.withoutReplies, [rows[1], rows[2]]);
  assert.deepEqual(split.withReplies, rows);
});

test("history read uses one unified query below the truncation boundary", async () => {
  const rows: FormalTiboResetSignal[] = [
    { ...resetSignal("reply", "2026-08-03T10:00:00.000Z"), is_reply: true },
    { ...resetSignal("post", "2026-08-02T10:00:00.000Z"), is_reply: false },
    { ...resetSignal("legacy", "2026-08-01T10:00:00.000Z"), is_reply: null },
  ];
  const calls: Array<{ fields: string; includeReplies: boolean }> = [];

  const result = await readTiboHistorySignals(
    async (fields, includeReplies) => {
      calls.push({ fields, includeReplies });
      return { data: rows, error: null };
    },
    { state: "ok" },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { fields: TIBO_HISTORY_SELECT_FIELDS, includeReplies: true });
  assert.deepEqual(result.withReplies.data, rows);
  assert.deepEqual(result.withoutReplies.data, [rows[1], rows[2]]);
  assert.equal(result.withReplies.health.state, "ok");
  assert.equal(result.withoutReplies.health.state, "ok");
});

test("exactly the history row limit triggers a filtered formal-history fallback", async () => {
  const unifiedRows = Array.from({ length: TIBO_HISTORY_MAX_ROWS }, (_, index) => ({
    ...resetSignal(`unified-${index}`, `2026-08-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`),
    is_reply: index % 2 === 0,
  }));
  const formalRows = [resetSignal("older-formal", "2020-01-01T00:00:00.000Z")];
  const calls: Array<{ fields: string; includeReplies: boolean }> = [];

  const result = await readTiboHistorySignals(
    async (fields, includeReplies) => {
      calls.push({ fields, includeReplies });
      return { data: includeReplies ? unifiedRows : formalRows, error: null };
    },
    { state: "ok" },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].includeReplies, true);
  assert.equal(calls[1].includeReplies, false);
  assert.deepEqual(result.withReplies.data, unifiedRows);
  assert.deepEqual(result.withoutReplies.data, formalRows);
  assert.equal(result.withoutReplies.health.state, "ok");
});

test("a reply-heavy newest history page does not hide older formal rows", async () => {
  const unifiedRows = Array.from({ length: TIBO_HISTORY_MAX_ROWS }, (_, index) => ({
    ...resetSignal(`recent-${index}`, `2026-08-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`),
    is_reply: index < 900,
  }));
  const formalRows = [
    resetSignal("older-formal", "2020-01-01T00:00:00.000Z"),
    resetSignal("formal-2", "2020-01-02T00:00:00.000Z"),
  ];

  const result = await readTiboHistorySignals(
    async (_fields, includeReplies) => ({
      data: includeReplies ? unifiedRows : formalRows,
      error: null,
    }),
    { state: "ok" },
  );

  assert.deepEqual(result.withReplies.data, unifiedRows);
  assert.deepEqual(result.withoutReplies.data, formalRows);
  assert.equal(result.withoutReplies.data[0].tweet_id, "older-formal");
});

test("history schema fallback preserves data health and local reply derivation", async () => {
  const rows: FormalTiboResetSignal[] = [
    { ...resetSignal("reply", "2026-08-03T10:00:00.000Z"), is_reply: true },
    { ...resetSignal("post", "2026-08-02T10:00:00.000Z"), is_reply: false },
  ];
  let calls = 0;

  const result = await readTiboHistorySignals(
    async (_fields, includeReplies) => {
      calls += 1;
      if (calls === 1) {
        return {
          data: null,
          error: { code: "PGRST204", message: "column logical_post_id does not exist" },
        };
      }
      return { data: includeReplies ? rows : [], error: null };
    },
    { state: "ok" },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result.withReplies.data, rows);
  assert.deepEqual(result.withoutReplies.data, [rows[1]]);
  assert.equal(result.withReplies.health.state, "ok");
  assert.equal(result.withoutReplies.health.state, "ok");
});

test("Tibo radar queries use explicit field lists instead of wildcard reads", () => {
  assert.notEqual(ACTIVE_TIBO_SIGNAL_SELECT_FIELDS, "*");
  assert.notEqual(TIBO_HISTORY_SELECT_FIELDS, "*");
  assert.ok(ACTIVE_TIBO_SIGNAL_SELECT_FIELDS.split(",").length > 1);
  assert.ok(TIBO_HISTORY_SELECT_FIELDS.split(",").length > 1);
  assert.doesNotMatch(ACTIVE_TIBO_SIGNAL_SELECT_FIELDS, /(^|,)id(,|$)/);
  assert.match(ACTIVE_TIBO_SIGNAL_SELECT_FIELDS, /(^|,)tweet_id(,|$)/);
  assert.match(TIBO_HISTORY_SELECT_FIELDS, /(^|,)is_reply(,|$)/);
});

test("Tibo history uses one reply-inclusive cache entry and derives the formal view locally", () => {
  const source = readFileSync(resolve("lib/radarFetch.ts"), "utf8");
  assert.match(source, /\["tibo-history-signals-cache-v3"\]/);
  assert.match(source, /TIBO_HISTORY_SELECT_FIELDS/);
  assert.match(source, /TIBO_HISTORY_FALLBACK_SELECT_FIELDS/);
  assert.match(source, /ACTIVE_TIBO_SIGNAL_FALLBACK_SELECT_FIELDS/);
  assert.match(source, /isMissingTiboOptionalColumnError\(result\.error\)/);
  assert.match(source, /TIBO_HISTORY_MAX_ROWS/);
  assert.doesNotMatch(source, /getCachedTiboRecentSignals/);

  const bundleSource = source.slice(
    source.indexOf("async function getTiboSignalBundle"),
    source.indexOf("export async function fetchFormalTiboResetSignals"),
  );
  assert.equal((bundleSource.match(/fetchRawTiboHistorySignals\(\)/g) ?? []).length, 1);
  assert.match(bundleSource, /historyResult\.withReplies\.data/);
  assert.match(bundleSource, /historyResult\.withoutReplies\.data/);
  assert.doesNotMatch(bundleSource, /fetchRawTiboHistorySignals\(false\)|fetchRawTiboHistorySignals\(true\)/);
});

test("Tibo reset notice association scans resets chronologically and preserves display order", () => {
  const resets = [
    resetSignal("reset-2", "2026-08-02T10:00:00.000Z"),
    resetSignal("reset-1", "2026-08-01T10:00:00.000Z"),
  ];
  const notices = [
    noticeSignal("notice-2", "2026-08-02T08:00:00.000Z"),
    noticeSignal("notice-1", "2026-08-01T08:00:00.000Z"),
  ];

  const associated = associateTiboNotices(resets, notices);

  assert.deepEqual(associated.map((signal) => signal.tweet_id), ["reset-2", "reset-1"]);
  assert.equal(associated[0].related_notice?.tweet_id, "notice-2");
  assert.equal(associated[1].related_notice?.tweet_id, "notice-1");
});
