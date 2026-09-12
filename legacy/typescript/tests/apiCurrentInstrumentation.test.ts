import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const routeSource = readFileSync(resolve("app/api/current/route.ts"), "utf8");
const radarFetchSource = readFileSync(resolve("lib/radarFetch.ts"), "utf8");

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("current route measures one fetch and one response serialization without changing the public response path", () => {
  assert.match(routeSource, /const requestUrl = new URL\(request\.url\)/);
  assert.match(routeSource, /const requestStartedAt = performance\.now\(\)/);
  assert.match(routeSource, /const fetchStartedAt = performance\.now\(\)/);
  assert.match(routeSource, /const responseSerializationStartedAt = performance\.now\(\)/);
  assert.equal((routeSource.match(/NextResponse\.json\(data/g) ?? []).length, 1);
  for (const field of [
    "locale",
    "hostname",
    "hasResetMarker",
    "resetMarkerRetry",
    "calculationBucket",
    "totalMs",
    "fetchPublicRadarSnapshotMs",
    "responseSerializationMs",
  ]) {
    assert.match(routeSource, new RegExp(`${field}:|\\b${field}\\b`));
  }
  assert.doesNotMatch(routeSource, /requestId|authorization|cookie|referer/i);
});

test("radar cache callbacks log compute timing without changing cache identity or policy", () => {
  const coreBlock = sourceBetween(
    radarFetchSource,
    "const getCachedRadarCore = unstable_cache(",
    "const getCachedPublicRadarSnapshotBundle = unstable_cache(",
  );
  const snapshotBlock = sourceBetween(
    radarFetchSource,
    "const getCachedPublicRadarSnapshotBundle = unstable_cache(",
    "const getCachedRandomResetHeatmapEventTimes = unstable_cache(",
  );
  const bundleBuilderBlock = sourceBetween(
    radarFetchSource,
    "export function buildPublicRadarSnapshotBundle(",
    "const getCachedPublicRadarSnapshotBundle = unstable_cache(",
  );

  assert.match(coreBlock, /event: "radar_core_compute"/);
  assert.match(coreBlock, /durationMs/);
  assert.match(coreBlock, /dataHealth/);
  assert.match(coreBlock, /\["radar-core-cache-v6"\]/);
  assert.match(coreBlock, /revalidate: RADAR_CORE_CACHE_TTL_SECONDS/);
  assert.match(coreBlock, /tags: \["radar-data"\]/);

  assert.match(snapshotBlock, /event: "public_snapshot_bundle_compute"/);
  assert.match(snapshotBlock, /calculationBucket/);
  assert.match(snapshotBlock, /limitHistory/);
  assert.match(snapshotBlock, /durationMs/);
  assert.equal((snapshotBlock.match(/fetchSharedRadarCore\(\)/g) ?? []).length, 1);
  assert.match(snapshotBlock, /\["radar-public-snapshot-bundle-cache-v5"\]/);
  assert.match(snapshotBlock, /revalidate: PUBLIC_RADAR_SNAPSHOT_CACHE_RETENTION_SECONDS/);
  assert.doesNotMatch(snapshotBlock, /\blocale\b/);
  assert.match(snapshotBlock, /tags: \["radar-data"\]/);

  assert.equal((bundleBuilderBlock.match(/createRadarCalculationContext\(/g) ?? []).length, 1);
  assert.equal((bundleBuilderBlock.match(/toPublicRadarSnapshot\(/g) ?? []).length, 3);
});
