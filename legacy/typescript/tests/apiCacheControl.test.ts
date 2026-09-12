import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("current API keeps the 600s CDN cache policy wired to the route", () => {
  const radarFetchSource = readFileSync(resolve("lib/radarFetch.ts"), "utf8");
  const routeSource = readFileSync(resolve("app/api/current/route.ts"), "utf8");

  assert.equal(
    radarFetchSource.includes(
      '"public, max-age=0, s-maxage=600, stale-while-revalidate=300"',
    ),
    true,
  );
  assert.match(routeSource, /"Cache-Control": API_CACHE_CONTROL/);
});
