import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("extension documentation does not claim local storage is encrypted", () => {
  const readme = readFileSync("extension/tibo-monitor/README.md", "utf8");
  const options = readFileSync("extension/tibo-monitor/options.html", "utf8");

  assert.doesNotMatch(`${readme}\n${options}`, /暗号化保管|暗号化して保管|encrypted storage/i);
  assert.match(readme, /trusted context/i);
});

test("history table grant migration revokes only public client roles", () => {
  const migration = readFileSync(
    "supabase/migrations/20260809160012_revoke_public_history_table_grants.sql",
    "utf8",
  );

  assert.match(migration, /revoke\s+all\s+privileges\s+on\s+table\s+public\.prediction_history\s+from\s+anon,\s*authenticated/i);
  assert.match(migration, /revoke\s+all\s+privileges\s+on\s+table\s+public\.regular_reset_events\s+from\s+anon,\s*authenticated/i);
  assert.doesNotMatch(migration, /revoke[\s\S]+from\s+service_role/i);
  assert.doesNotMatch(migration, /disable\s+row\s+level\s+security/i);
});

test("webhook secret remains persistent and trusted-context-only", () => {
  const optionsScript = readFileSync("extension/tibo-monitor/options.js", "utf8");
  const options = readFileSync("extension/tibo-monitor/options.js", "utf8");
  const serviceWorker = readFileSync(
    "extension/tibo-monitor/service-worker.js",
    "utf8",
  );
  const content = readFileSync("extension/tibo-monitor/content.js", "utf8");

  assert.match(options, /webhook_secret:\s*secret/);
  assert.match(serviceWorker, /chrome\.storage\.local\.get\(\[\s*"webhook_secret"/);
  assert.match(serviceWorker, /Authorization.*Bearer.*secret/);
  assert.doesNotMatch(content, /webhook_secret|TIBO_WEBHOOK_SECRET|Authorization/);
  const settingsWrite = optionsScript.indexOf("await chrome.storage.local.set");
  const quarantineClear = optionsScript.indexOf(
    "await clearAuthBlockedQuarantine()",
    settingsWrite,
  );
  assert.ok(settingsWrite >= 0);
  assert.ok(quarantineClear > settingsWrite);
});
