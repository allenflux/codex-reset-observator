import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function read(filePath: string) {
  return readFileSync(resolve(filePath), "utf8");
}

function readPageCacheSource() {
  const source = read("lib/radarFetch.ts");
  const start = source.indexOf("const getCachedRadarPageData = unstable_cache(");
  const end = source.indexOf("function isOlderThanCacheTtl", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  return source.slice(start, end);
}

test("radar page cache compute logs every phase without duplicating the work", () => {
  const source = readPageCacheSource();

  assert.match(source, /event: "radar_page_compute"/);
  for (const field of [
    "locale",
    "calculationBucket",
    "limitHistory",
    "includeHeatmap",
    "fetchSharedRadarCoreMs",
    "createRadarCalculationContextMs",
    "toPublicRadarSnapshotMs",
    "heatmapMs",
    "totalMs",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }

  assert.equal((source.match(/fetchSharedRadarCore\(\)/g) ?? []).length, 1);
  assert.equal((source.match(/createRadarCalculationContext\(/g) ?? []).length, 1);
  assert.equal((source.match(/toPublicRadarSnapshot\(/g) ?? []).length, 1);
  assert.equal((source.match(/getRandomResetHeatmapEventTimes\(/g) ?? []).length, 1);
  assert.match(source, /revalidate: RADAR_PAGE_CACHE_TTL_SECONDS/);
  assert.match(source, /tags: \["radar-data"\]/);
});

test("all six page functions log only their page-data fetch timing", () => {
  const pages = [
    { path: "app/(ja)/page.tsx", route: "/", locale: "ja", pageType: "home" },
    { path: "app/(en)/en/page.tsx", route: "/en", locale: "en", pageType: "home" },
    { path: "app/(zh)/zh/page.tsx", route: "/zh", locale: "zh", pageType: "home" },
    { path: "app/(ja)/history/page.tsx", route: "/history", locale: "ja", pageType: "history" },
    { path: "app/(en)/en/history/page.tsx", route: "/en/history", locale: "en", pageType: "history" },
    { path: "app/(zh)/zh/history/page.tsx", route: "/zh/history", locale: "zh", pageType: "history" },
  ];

  for (const page of pages) {
    const source = read(page.path);
    assert.equal((source.match(/fetchRadarPageData\(/g) ?? []).length, 1, page.path);
    assert.match(source, /event: "radar_page_route_fetch"/);
    assert.match(source, new RegExp(`route: "${page.route.replaceAll("/", "\\/")}"`));
    assert.match(source, new RegExp(`locale: "${page.locale}"`));
    assert.match(source, new RegExp(`pageType: "${page.pageType}"`));
    assert.match(source, /durationMs/);
  }
});
