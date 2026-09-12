import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

type FakeElement = {
  value: string;
  checked: boolean;
  disabled: boolean;
  innerText: string;
  className: string;
  addEventListener: (event: string, handler: () => void) => void;
  click: () => void;
};

function createFakeElement(): FakeElement {
  const handlers = new Map<string, () => void>();
  return {
    value: "",
    checked: false,
    disabled: false,
    innerText: "",
    className: "",
    addEventListener(event, handler) {
      handlers.set(event, handler);
    },
    click() {
      handlers.get("click")?.();
    },
  };
}

test("options page exposes a safe notification test and reports its result", async () => {
  const extensionRoot = path.join(__dirname, "../extension/tibo-monitor");
  const html = fs.readFileSync(path.join(extensionRoot, "options.html"), "utf8");
  const source = fs.readFileSync(path.join(extensionRoot, "options.js"), "utf8");
  const serviceWorker = fs.readFileSync(
    path.join(extensionRoot, "service-worker.js"),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"),
  );
  const iconPath = path.join(extensionRoot, "icons/icon-128.png");
  const icon = fs.readFileSync(iconPath);

  assert.match(html, /id="notificationTestBtn"/);
  assert.match(html, /本番データを変更せず、Chrome通知だけを確認します。/);
  assert.match(source, /TEST_FORMAL_ADOPTION_NOTIFICATION/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.match(serviceWorker, /icons\/icon-128\.png/);
  assert.equal(manifest.icons["128"], "icons/icon-128.png");
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);

  const ids = [
    "webhookSecret",
    "observatoryDomain",
    "saveBtn",
    "testBtn",
    "notificationTestBtn",
    "saveRepliesDomBtn",
    "retryTweetId",
    "retryTweetBtn",
    "statusMessage",
    "diagnosticsEnabled",
    "diagnosticsMaskText",
    "diagnosticCount",
    "refreshDiagnosticsBtn",
    "exportDiagnosticsBtn",
    "clearDiagnosticsBtn",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, createFakeElement()]));
  let sentMessage: unknown = null;

  const diagnostics = {
    ENABLED_KEY: "diagnostics_enabled",
    MASK_TEXT_KEY: "diagnostics_mask_text",
    getDiagnosticLogs: async () => [],
    serializeDiagnosticLogs: () => "[]",
    clearDiagnosticLogs: async () => {},
  };
  const fakeDocument = {
    addEventListener: (_event: string, handler: () => void) => {
      void handler();
    },
    getElementById: (id: string) => elements[id as keyof typeof elements],
  };
  const fakeChrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage: (
        message: unknown,
        callback: (response: {
          ok: boolean;
          requestedNotificationId: string;
          returnedNotificationId: string | null;
          actualNotificationId: string;
          warning: string;
        }) => void,
      ) => {
        sentMessage = message;
        callback({
          ok: true,
          requestedNotificationId: "tibo-monitor-notification-test",
          returnedNotificationId: null,
          actualNotificationId: "tibo-monitor-notification-test",
          warning: "notifications.create returned no id; requested id was used",
        });
      },
    },
  };

  vm.runInNewContext(source, {
    chrome: fakeChrome,
    document: fakeDocument,
    TiboDiagnostics: diagnostics,
    console,
    setTimeout,
    window: { confirm: () => false },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  elements.notificationTestBtn.click();

  assert.deepEqual(sentMessage, {
    action: "TEST_FORMAL_ADOPTION_NOTIFICATION",
    type: "TEST_FORMAL_ADOPTION_NOTIFICATION",
  });
  assert.equal(
    elements.statusMessage.innerText,
    "通知を送信しました。Windowsの通知欄を確認してください。",
  );
});

test("options page exposes an explicit single-tweet retry action", () => {
  const extensionRoot = path.join(__dirname, "../extension/tibo-monitor");
  const html = fs.readFileSync(path.join(extensionRoot, "options.html"), "utf8");
  const source = fs.readFileSync(path.join(extensionRoot, "options.js"), "utf8");

  assert.match(html, /id="retryTweetId"/);
  assert.match(html, /id="retryTweetBtn"/);
  assert.match(html, /処理済みのTweet IDを1件だけ解除/);
  assert.match(source, /RETRY_TWEET/);
  assert.match(source, /retryTweetIdInput\.value\.trim\(\)/);
});
