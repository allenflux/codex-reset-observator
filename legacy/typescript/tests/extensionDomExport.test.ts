import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type FakeElement = {
  value: string;
  checked: boolean;
  disabled: boolean;
  innerText: string;
  className: string;
  style: Record<string, string>;
  addEventListener: (event: string, handler: () => void) => void;
  click: () => void;
};

function createElement(): FakeElement {
  const handlers = new Map<string, () => void>();
  return {
    value: "",
    checked: false,
    disabled: false,
    innerText: "",
    className: "",
    style: {},
    addEventListener(event, handler) {
      handlers.set(event, handler);
    },
    click() {
      handlers.get("click")?.();
    },
  };
}

function loadScanUtilities() {
  const source = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/scan-utils.js"),
    "utf8",
  );
  const context = vm.createContext({
    Blob,
    Date,
    URL,
    console,
    setTimeout,
  });
  vm.runInContext(source, context);
  return {
    source,
    scan: (context as typeof context & { TiboMonitorScan: Record<string, any> })
      .TiboMonitorScan,
  };
}

test("raw DOM capture downloads the live document with doctype and no masking", () => {
  const { scan } = loadScanUtilities();
  let capturedBlob: { parts: string[]; type: string } = { parts: [], type: "" };
  let revokedUrl: string | null = null;
  let revokeLater: () => void = () => {};
  let clicked = false;
  const link = {
    href: "",
    download: "",
    style: {},
    click() {
      clicked = true;
    },
    remove() {},
  };
  const parent = { appendChild() {} };
  const documentRef = {
    doctype: { name: "html", publicId: "", systemId: "" },
    documentElement: {
      outerHTML:
        '<html><body><article data-testid="tweet"><div data-testid="tweetText">Maybe</div><div aria-label="reply">raw</div></article></body></html>',
    },
    body: parent,
    createElement() {
      return link;
    },
  };
  class TestBlob {
    parts: string[];
    type: string;

    constructor(parts: string[], options: { type: string }) {
      this.parts = parts;
      this.type = options.type;
      capturedBlob = this;
    }
  }
  const urlApi = {
    createObjectURL() {
      return "blob:tibo-dom";
    },
    revokeObjectURL(value: string) {
      revokedUrl = value;
    },
  };

  const result = scan.captureRawDomToDownload(
    documentRef,
    urlApi,
    TestBlob,
    "2026-08-17T08:15:30.123Z",
    (callback: () => void) => {
      revokeLater = callback;
      return 1;
    },
  );

  const html = capturedBlob?.parts.join("") || "";
  assert.equal(result.characterCount, html.length);
  assert.equal(capturedBlob?.type, "text/html;charset=utf-8");
  assert.match(html, /^<!DOCTYPE html>\n<html>/);
  assert.match(html, /data-testid="tweetText">Maybe/);
  assert.match(html, /aria-label="reply"/);
  assert.equal(clicked, true);
  assert.equal(link.href, "blob:tibo-dom");
  assert.match(
    link.download,
    /^tibo-with-replies-dom-2026-08-17T08-15-30-123Z\.html$/,
  );
  assert.doesNotMatch(html, /POST_TEXT_MASKED|DISPLAY_NAME_MASKED|REDACTED/);
  assert.equal(revokedUrl, null);
  revokeLater();
  assert.equal(revokedUrl, "blob:tibo-dom");
});

test("raw DOM capture does not perform network, reload, navigation, or extension messaging", () => {
  const { source, scan } = loadScanUtilities();
  const captureSource = scan.captureRawDomToDownload.toString();

  assert.doesNotMatch(captureSource, /fetch|reload|location|sendMessage/i);
  assert.doesNotMatch(captureSource, /chrome\.|storage|POST_TWEET|webhook|supabase/i);
  assert.match(source, /documentElement\.outerHTML/);
});

test("reply-page target matching accepts only the exact Tibo with-replies path", () => {
  const { scan } = loadScanUtilities();

  assert.equal(
    scan.getTimelineSource("https://x.com/thsottiaux/with_replies/?tab=latest"),
    "with_replies",
  );
  assert.equal(
    scan.getTimelineSource("https://twitter.com/thsottiaux/with_replies?lang=en"),
    "with_replies",
  );
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux"), "profile");
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/status/123"), null);
  assert.equal(scan.getTimelineSource("https://x.com/notifications"), null);
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/with_replies/archive"), null);
});

function loadOptionsPage(
  tabs: Array<{ id: number; url: string; active?: boolean }>,
  options: { sendMessageError?: string } = {},
) {
  const html = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/options.html"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/options.js"),
    "utf8",
  );
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
  const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));
  let domReadyHandler: (() => void) | null = null;
  const sentMessages: Array<{ tabId: number; message: unknown }> = [];
  let queriedWith: unknown = null;
  let lastError: { message: string } | undefined;

  const fakeDocument = {
    addEventListener(_event: string, handler: () => void) {
      domReadyHandler = handler;
    },
    getElementById(id: string) {
      return elements[id as keyof typeof elements];
    },
  };
  const fakeChrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      query: async (queryInfo: unknown) => {
        queriedWith = queryInfo;
        return tabs;
      },
      sendMessage: (
        tabId: number,
        message: unknown,
        callback: (response: unknown) => void,
      ) => {
        sentMessages.push({ tabId, message });
        if (options.sendMessageError) {
          lastError = { message: options.sendMessageError };
          callback(undefined);
          lastError = undefined;
          return;
        }
        callback({
          success: true,
          data: {
            filename: "tibo-with-replies-dom-2026-08-17T08-15-30-123Z.html",
            characterCount: 1234,
          },
        });
      },
    },
    runtime: {
      get lastError() {
        return lastError;
      },
      sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
        callback({ success: true });
      },
    },
  };
  const context = vm.createContext({
    Blob,
    Date,
    URL,
    console,
    document: fakeDocument,
    chrome: fakeChrome,
    setTimeout,
    window: { confirm: () => false },
    TiboDiagnostics: {
      ENABLED_KEY: "diagnostics_enabled",
      MASK_TEXT_KEY: "diagnostics_mask_text",
      getDiagnosticLogs: async () => [],
      serializeDiagnosticLogs: () => "[]",
      clearDiagnosticLogs: async () => {},
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(process.cwd(), "extension/tibo-monitor/scan-utils.js"),
      "utf8",
    ),
    context,
  );
  vm.runInContext(source, context);

  return {
    html,
    elements,
    sentMessages,
    get queriedWith() {
      return queriedWith;
    },
    setLastError(value: { message: string } | undefined) {
      lastError = value;
    },
    async ready() {
      domReadyHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test("options page selects the active exact reply tab and sends only the capture message", async () => {
  const page = loadOptionsPage([
    { id: 10, url: "https://x.com/thsottiaux", active: true },
    { id: 11, url: "https://x.com/thsottiaux/status/123", active: true },
    { id: 12, url: "https://twitter.com/thsottiaux/with_replies/?tab=latest", active: true },
    { id: 13, url: "https://x.com/thsottiaux/with_replies", active: false },
    { id: 14, url: "https://x.com/notifications", active: false },
  ]);
  await page.ready();

  assert.match(page.html, /id="saveRepliesDomBtn"/);
  assert.match(page.html, /返信ページHTMLを保存/);
  page.elements.saveRepliesDomBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(page.queriedWith)), {
    url: [
      "https://x.com/thsottiaux/with_replies*",
      "https://twitter.com/thsottiaux/with_replies*",
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(page.sentMessages)), [
    {
      tabId: 12,
      message: { action: "CAPTURE_WITH_REPLIES_DOM" },
    },
  ]);
  assert.match(page.elements.statusMessage.innerText, /返信ページのDOM保存を開始しました/);
  assert.match(page.elements.statusMessage.innerText, /1,234文字/);
  assert.equal(page.elements.saveRepliesDomBtn.disabled, false);
});

test("options page explains when no exact reply tab is open", async () => {
  const page = loadOptionsPage([
    { id: 20, url: "https://x.com/thsottiaux", active: true },
    { id: 21, url: "https://x.com/thsottiaux/status/123", active: false },
    { id: 22, url: "https://x.com/notifications", active: false },
  ]);
  await page.ready();

  page.elements.saveRepliesDomBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(page.sentMessages, []);
  assert.equal(
    page.elements.statusMessage.innerText,
    "Tibo の返信ページを開いてから再実行してください。",
  );
  assert.equal(page.elements.saveRepliesDomBtn.disabled, false);
});

test("options page reports a stale content script without exposing runtime details", async () => {
  const page = loadOptionsPage([
    { id: 30, url: "https://x.com/thsottiaux/with_replies", active: true },
  ], { sendMessageError: "Could not establish connection. Receiving end does not exist." });
  await page.ready();

  page.elements.saveRepliesDomBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    page.elements.statusMessage.innerText,
    "拡張機能更新後は Tibo の返信ページを一度再読み込みしてください。",
  );
  assert.doesNotMatch(page.html, /outerHTML/);
});

test("manifest keeps the existing permission boundary for local DOM export", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "extension/tibo-monitor/manifest.json"),
      "utf8",
    ),
  );
  assert.ok(manifest.permissions.includes("tabs"));
  assert.doesNotMatch(JSON.stringify(manifest.permissions), /downloads|scripting/);
});

test("DOM export stays outside the scan, webhook, storage, and service-worker paths", () => {
  const content = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/content.js"),
    "utf8",
  );
  const options = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/options.js"),
    "utf8",
  );
  const serviceWorker = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/service-worker.js"),
    "utf8",
  );

  assert.match(content, /CAPTURE_WITH_REPLIES_DOM/);
  assert.match(content, /captureRawDomToDownload/);
  assert.match(content, /POST_TWEET/);
  assert.match(options, /chrome\.tabs\.sendMessage/);
  assert.doesNotMatch(options, /outerHTML|CAPTURE_WITH_REPLIES_DOM[\s\S]*POST_TWEET/);
  assert.doesNotMatch(serviceWorker, /CAPTURE_WITH_REPLIES_DOM/);
});
