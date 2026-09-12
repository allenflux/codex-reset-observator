import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(".github/workflows/ci.yml");
const packageJsonPath = resolve("package.json");

test("CI workflow enforces the ordered quality gate contract", () => {
  assert.ok(existsSync(workflowPath), `Expected ${workflowPath} to exist`);

  const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    packageManager?: string;
  };
  const packageManagerPin = packageJson.packageManager;

  assert.equal(
    packageManagerPin,
    "pnpm@11.18.0",
    "package.json must keep the pinned pnpm version",
  );

  assert.match(workflow, /^on:\n  push:\n  pull_request:\n/m);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /^          node-version: 22\.13\.0\s*$/m);

  const compatibleCorepackStep = [
    "      - name: Install compatible Corepack",
    "        run: npm install --global corepack@0.35.0",
  ].join("\n");

  assert.ok(
    workflow.includes(compatibleCorepackStep),
    "CI must install the Corepack release compatible with the pinned pnpm version",
  );
  assert.ok(
    workflow.indexOf(compatibleCorepackStep) < workflow.indexOf("          corepack enable"),
    "CI must install compatible Corepack before enabling it",
  );

  assert.ok(
    workflow.includes(
      [
        "      - name: Enable pinned pnpm",
        "        run: |",
        "          corepack enable",
        `          corepack prepare ${packageManagerPin} --activate`,
      ].join("\n"),
    ),
    "CI must enable Corepack and activate the package.json pnpm pin",
  );

  const commands = [
    "corepack pnpm install --frozen-lockfile",
    "corepack pnpm lint",
    "corepack pnpm typecheck",
    "corepack pnpm test",
    "corepack pnpm build",
    "corepack pnpm audit --prod --audit-level high",
  ];

  const runCommands = workflow.split("\n").flatMap((line) => {
    const match = line.match(/^      - run: ([^\s].*?)\s*$/);
    return match === null ? [] : [match[1]];
  });

  assert.deepStrictEqual(runCommands, commands);
});

test("all external workflow actions are pinned to full commit SHAs", () => {
  const workflowFiles = [
    ".github/workflows/ci.yml",
    ".github/workflows/log-probability.yml",
    ".github/workflows/notify-workflow-failures.yml",
    ".github/workflows/tibo-monitor-health.yml",
    ".github/workflows/verify-browser-e2e.yml",
  ];
  const externalUses = workflowFiles.flatMap((file) =>
    readFileSync(resolve(file), "utf8")
      .split("\n")
      .filter((line) => /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@/.test(line)),
  );

  assert.ok(externalUses.length > 0);
  for (const line of externalUses) {
    assert.match(
      line,
      /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#\s+v\d+\.\d+\.\d+)?\s*$/i,
      `External action is not pinned: ${line}`,
    );
  }
});

test("browser E2E workflow builds the local app and runs Chromium only", () => {
  const workflowPath = resolve(".github/workflows/verify-browser-e2e.yml");
  const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

  assert.match(workflow, /^name: Verify Browser E2E$/m);
  assert.match(workflow, /^  push:\n    branches: \[main\]$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /node-version: 22\.13\.0/);
  assert.match(workflow, /corepack pnpm install --frozen-lockfile/);
  assert.match(workflow, /corepack pnpm build/);
  assert.match(workflow, /corepack pnpm exec playwright install --with-deps chromium/);
  assert.match(workflow, /corepack pnpm exec playwright test/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /playwright install --with-deps\s*$/m);
});

test("probability logging keeps a six-hour research cadence", () => {
  const workflow = readFileSync(resolve(".github/workflows/log-probability.yml"), "utf8")
    .replace(/\r\n/g, "\n");

  assert.match(workflow, /cron:\s*'34 \*\/6 \* \* \*'/);

  const requestBlock = workflow.slice(
    workflow.indexOf("HTTP_STATUS=$(curl"),
    workflow.indexOf('echo "HTTP Status Code'),
  );
  assert.match(requestBlock, /-X POST/);
  assert.match(requestBlock, /-H "Authorization: Bearer \$\{\{ secrets\.CRON_SECRET \}\}"/);
  assert.match(requestBlock, /"\$APP_URL\/api\/log-probability"/);
});
