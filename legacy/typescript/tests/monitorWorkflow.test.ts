import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const healthWorkflowPath = resolve(".github/workflows/tibo-monitor-health.yml");
const healthRoutePath = resolve("app/api/monitor/health/route.ts");
const notifierWorkflowPath = resolve(
  ".github/workflows/notify-workflow-failures.yml",
);

function readWorkflow(path: string): string {
  assert.ok(existsSync(path), `Expected ${path} to exist`);
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

test("monitor health workflow checks the production endpoint every ten minutes", () => {
  const workflow = readWorkflow(healthWorkflowPath);

  assert.match(workflow, /^name: Tibo monitor health$/m);
  assert.match(workflow, /- cron: "\*\/10 \* \* \* \*"/);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(
    workflow,
    /https:\/\/codex\.gussuriworks\.com\/api\/monitor\/health/,
  );
  assert.doesNotMatch(workflow, /regular-reset-sync/);
  assert.doesNotMatch(workflow, /\/api\/regular-reset\/sync/);
  assert.equal(existsSync(resolve("app/api/regular-reset/sync/route.ts")), false);
  assert.match(workflow, /secrets\.CRON_SECRET/);
  assert.match(workflow, /^permissions:\n  contents: read\n  issues: write$/m);
  assert.match(workflow, /HTTP_STATUS.*503/);
  assert.match(workflow, /status.*healthy|status.*warning|status.*unhealthy/);
  assert.match(workflow, /<!-- tibo-monitor-health-alert -->/);
  assert.match(workflow, /\[Monitor alert\] Tibo parser health/);
  assert.match(
    workflow,
    /actions\/github-script@[0-9a-f]{40}\s+#\s+v7\.1\.0/,
  );
});

test("health API reads the existing session start and returns warning as HTTP 200", () => {
  const route = readWorkflow(healthRoutePath);

  assert.match(route, /session_started_at,last_heartbeat_at,last_successful_parse_at/);
  assert.match(route, /health\.status === "unhealthy" \? 503 : 200/);
});

test("health warnings and unhealthy states do not fail the health-check job", () => {
  const workflow = readWorkflow(healthWorkflowPath);
  const healthJob = workflow.slice(
    workflow.indexOf("  health-check:"),
  );

  assert.match(healthJob, /HTTP_STATUS.*503/);
  assert.match(healthJob, /healthy\|warning/);
  assert.match(healthJob, /unhealthy\)/);
  assert.doesNotMatch(
    healthJob,
    /if \[ "\$HTTP_STATUS" != "200" \]; then\s+exit 1/,
  );
  assert.doesNotMatch(
    healthJob,
    /if \[ "\$STATUS" = "unhealthy" \]; then\s+exit 1/,
  );
});

test("health issue handling deduplicates alerts and closes only after recovery", () => {
  const workflow = readWorkflow(healthWorkflowPath);

  assert.match(workflow, /steps\.monitor-health\.outputs\.status == 'unhealthy'/);
  assert.match(workflow, /steps\.monitor-health\.outputs\.status == 'healthy'/);
  assert.match(workflow, /state: "open"/);
  assert.match(workflow, /existingIssue/);
  assert.match(workflow, /if \(existingIssue\) \{\s+return;/);
  assert.match(workflow, /issues\.create\(/);
  assert.match(workflow, /issues\.createComment\(/);
  assert.match(workflow, /issues\.listComments/);
  assert.match(workflow, /alreadyRecovered/);
  assert.match(workflow, /state: "closed"/);
  assert.doesNotMatch(
    workflow,
    /steps\.monitor-health\.outputs\.status == 'warning'[\s\S]*issues\.create/,
  );
});

test("workflow notifier only opens one issue and closes it after recovery", () => {
  const workflow = readWorkflow(notifierWorkflowPath);

  assert.match(workflow, /^  workflow_run:\s*$/m);
  assert.match(
    workflow,
    /workflows: \["CI", "Tibo monitor health", "Log Reset Probability", "Verify Supabase Migrations", "Verify Browser E2E"\]/,
  );
  assert.match(workflow, /branches: \[main\]/);
  assert.match(
    workflow,
    /^permissions:\n  actions: read\n  contents: read\n  issues: write$/m,
  );
  assert.match(
    workflow,
    /actions\/github-script@[0-9a-f]{40}\s+#\s+v7\.1\.0/,
  );
  assert.match(workflow, /conclusion === "success"/);
  assert.match(workflow, /issues\.create\(/);
  assert.match(workflow, /issues\.createComment\(/);
  assert.match(workflow, /issues\.update\(/);
  assert.match(workflow, /state: "open"/);
  assert.match(workflow, /existingIssue/);
  assert.match(
    workflow,
    /^concurrency:\n  group: workflow-alert-\$\{\{ github\.event\.workflow_run\.name \}\}\n  cancel-in-progress: false\n  queue: max$/m,
  );
  assert.match(workflow, /github\.paginate\(\s*github\.rest\.issues\.listForRepo,/);
  assert.match(workflow, /!issue\.pull_request/);
  assert.match(workflow, /issue\.body\?\.includes\(marker\)/);
});
