import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { SITE_URL, siteUrl } from "../lib/siteMetadata";
import robots from "../app/robots";

const legacyHost = "codex-reset-observatory.vercel.app";

// TODO(test-cleanup): Remove this compatibility suite when the legacy Vercel host
// is no longer supported by the redirect and extension migration paths.
const newHost = "codex.gussuriworks.com";
const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  redirects: Array<{
    source: string;
    destination: string;
    permanent?: boolean;
    has?: Array<{ type: string; value?: string }>;
  }>;
};

function legacyRedirect() {
  const redirect = vercelConfig.redirects.find((candidate) =>
    candidate.has?.some((condition) => condition.type === "host" && condition.value === legacyHost),
  );
  assert.ok(redirect, "legacy host redirect must be configured");
  return redirect;
}

test("legacy non-API requests use a Vercel host redirect without middleware", () => {
  const redirect = legacyRedirect();

  assert.equal(existsSync("middleware.ts"), false);
  assert.equal(redirect.source, "/:path((?!api(?:/|$)).*)");
  assert.equal(redirect.destination, `https://${newHost}/:path*`);
  assert.equal(redirect.permanent, true);
  assert.deepEqual(redirect.has, [{ type: "host", value: legacyHost }]);
});

test("the legacy redirect source excludes the API path and preserves deep paths", () => {
  legacyRedirect();
  const sourceMatcher = /^\/((?!api(?:\/|$)).*)$/;

  for (const path of ["/", "/en", "/en/history", "/en/history?foo=bar"]) {
    assert.equal(sourceMatcher.test(path.split("?")[0]), true, path);
  }

  for (const path of ["/api", "/api/current", "/api/webhook/tibo", "/apiary"]) {
    assert.equal(sourceMatcher.test(path), path === "/apiary", path);
  }
});

test("only the exact legacy host activates the redirect", () => {
  const redirect = legacyRedirect();
  const hostCondition = redirect.has?.find((condition) => condition.type === "host");

  assert.equal(hostCondition?.value, legacyHost);
  assert.notEqual(hostCondition?.value, newHost);
  assert.notEqual(hostCondition?.value, "preview-codex-reset-observatory.vercel.app");
  assert.notEqual(hostCondition?.value, "localhost:3000");
});

test("published site URLs and robots sitemap use the new domain", () => {
  assert.equal(SITE_URL, `https://${newHost}`);
  assert.equal(siteUrl("/en"), `https://${newHost}/en`);
  assert.equal(robots().sitemap, `https://${newHost}/sitemap.xml`);

  const sitemap = readFileSync("public/sitemap.xml", "utf8");
  assert.doesNotMatch(sitemap, new RegExp(legacyHost.replaceAll(".", "\\.")));
  assert.match(sitemap, new RegExp(`https://${newHost.replaceAll(".", "\\.")}/`));
});

test("extension keeps legacy access while defaulting all current links to the new domain", () => {
  const manifest = JSON.parse(readFileSync("extension/tibo-monitor/manifest.json", "utf8")) as {
    host_permissions: string[];
  };
  const serviceWorker = readFileSync("extension/tibo-monitor/service-worker.js", "utf8");
  const userScript = readFileSync("scripts/tibo-monitor.user.js", "utf8");
  const options = readFileSync("extension/tibo-monitor/options.html", "utf8");

  assert.ok(manifest.host_permissions.includes(`https://${newHost}/*`));
  assert.ok(manifest.host_permissions.includes(`https://${legacyHost}/*`));
  assert.match(serviceWorker, new RegExp(`DEFAULT_OBSERVATORY_DOMAIN = "https://${newHost}"`));
  assert.match(serviceWorker, new RegExp(`LEGACY_OBSERVATORY_DOMAIN = "https://${legacyHost}"`));
  assert.match(serviceWorker, /const TEST_HISTORY_URL = `\$\{DEFAULT_OBSERVATORY_DOMAIN\}\$\{HISTORY_PATH\}`;/);
  assert.match(userScript, new RegExp(`GM_getValue\\("observatory_domain", "https://${newHost}"\\)`));
  assert.match(userScript, new RegExp(`@connect      ${newHost}`));
  assert.match(userScript, new RegExp(`@connect      ${legacyHost}`));
  assert.match(options, new RegExp(`value="https://${newHost}"`));
});
