import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type ExtensionRuntime = {
  isExtensionContextInvalidated: (error: unknown) => boolean;
  runSafely: (
    task: () => Promise<unknown> | unknown,
    onError?: (error: unknown) => void,
  ) => Promise<unknown>;
};

function loadRuntime(): ExtensionRuntime {
  const code = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/runtime.js"),
    "utf8",
  );
  const context = vm.createContext({ console, Promise });
  vm.runInContext(code, context);
  return (context as typeof context & { TiboExtensionRuntime: ExtensionRuntime })
    .TiboExtensionRuntime;
}

test("recognizes Chrome extension context invalidation without matching ordinary errors", () => {
  const runtime = loadRuntime();

  assert.equal(
    runtime.isExtensionContextInvalidated(new Error("Extension context invalidated.")),
    true,
  );
  assert.equal(
    runtime.isExtensionContextInvalidated(
      new TypeError("Cannot read properties of undefined (reading 'sendMessage')"),
    ),
    true,
  );
  assert.equal(
    runtime.isExtensionContextInvalidated(
      new Error("chrome.runtime.sendMessage is unavailable"),
    ),
    true,
  );
  assert.equal(
    runtime.isExtensionContextInvalidated(new Error("Network request failed")),
    false,
  );
  assert.equal(runtime.isExtensionContextInvalidated(null), false);
});

test("runSafely resolves invalidated tasks and reports the error once", async () => {
  const runtime = loadRuntime();
  const errors: unknown[] = [];

  await assert.doesNotReject(() =>
    runtime.runSafely(
      async () => {
        throw new Error("Extension context invalidated.");
      },
      (error) => errors.push(error),
    ),
  );

  assert.equal(errors.length, 1);
  assert.equal(runtime.isExtensionContextInvalidated(errors[0]), true);
});

test("runSafely still reports ordinary task failures", async () => {
  const runtime = loadRuntime();
  const errors: unknown[] = [];

  await assert.doesNotReject(() =>
    runtime.runSafely(
      async () => {
        throw new Error("ordinary failure");
      },
      (error) => errors.push(error),
    ),
  );

  assert.equal(errors.length, 1);
  assert.equal(runtime.isExtensionContextInvalidated(errors[0]), false);
});
