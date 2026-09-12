import test from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

type MockFetchResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

// Helper to load service-worker.js with custom mocked chrome API
function setupServiceWorkerContext(
  customTabs: Array<{ id: number; url: string }> = [],
  opts: {
    failReloadTabId?: number;
    notificationError?: boolean;
    notificationPromiseError?: string;
    notificationRuntimeError?: string;
    notificationReturnUndefined?: boolean;
    notificationGetAllError?: string;
    notificationGetAllMissing?: boolean;
    notificationPermission?: "granted" | "denied";
    notificationPermissionError?: string;
    iconFetchError?: string;
    iconFetchStatus?: number;
    iconContentType?: string;
    iconEmpty?: boolean;
    observatoryDomain?: string;
    extensionVersion?: string;
    fetchError?: string;
    fetchResponse?:
      | MockFetchResponse
      | ((url: string, fetchOpts: any, callIndex: number) => MockFetchResponse);
  } = {}
) {
  const localStore: Record<string, any> = {};
  let extensionVersion = opts.extensionVersion || "1.0.1";
  const alarmsCreated: Array<{ name: string; alarmInfo: any }> = [];
  const reloadedTabIds: number[] = [];
  const updatedTabs: Array<{ tabId: number; updateProperties: any }> = [];
  const contentMessages: Array<{ tabId: number; message: any }> = [];
  const openedTabs: Array<{ url: string }> = [];
  const createdNotifications: Array<{ id: string; options: any }> = [];
  const activeNotificationIds: Record<string, boolean> = {};
  let notificationCreateCalls = 0;
  let alarmListener: ((alarm: { name: string }) => void) | null = null;
  let messageListener: Function | null = null;
  let notificationClickListener: ((notificationId: string) => void) | null = null;
  let storageLocalAccessLevel: string | null = null;

  if (opts.observatoryDomain !== undefined) {
    localStore.observatory_domain = opts.observatoryDomain;
  }

  const mockFetchCalls: Array<{ url: string; body: any }> = [];

  const mockChrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const result: Record<string, any> = {};
          keys.forEach((k) => {
            result[k] = localStore[k];
          });
          return result;
        },
        set: async (obj: Record<string, any>) => {
          Object.assign(localStore, obj);
        },
        setAccessLevel: async (options: { accessLevel: string }) => {
          storageLocalAccessLevel = options.accessLevel;
        },
      },
    },
    alarms: {
      get: (name: string, cb: Function) => {
        cb(alarmsCreated.find((a) => a.name === name) || null);
      },
      create: (name: string, alarmInfo: any) => {
        alarmsCreated.push({ name, alarmInfo });
      },
      onAlarm: {
        addListener: (fn: any) => {
          alarmListener = fn;
        },
      },
    },
    tabs: {
      query: async (queryInfo: { url: string[] }) => {
        // Simple prefix matcher simulating chrome.tabs.query with host permissions
        return customTabs.filter((tab) =>
          queryInfo.url.some((pattern) => {
            const prefix = pattern.replace("*", "");
            return tab.url.startsWith(prefix);
          })
        );
      },
      reload: async (tabId: number) => {
        if (opts.failReloadTabId === tabId) {
          throw new Error("Simulated tab reload failure");
        }
        reloadedTabIds.push(tabId);
      },
      update: async (tabId: number, updateProperties: any) => {
        const tab = customTabs.find((candidate) => candidate.id === tabId);
        if (tab) Object.assign(tab, updateProperties);
        updatedTabs.push({ tabId, updateProperties });
        return tab || { id: tabId, ...updateProperties };
      },
      create: async (tab: { url: string }) => {
        openedTabs.push(tab);
        return { id: openedTabs.length };
      },
      sendMessage: (tabId: number, message: any, callback?: Function) => {
        contentMessages.push({ tabId, message });
        callback?.({ success: true });
      },
    },
    notifications: {
      onClicked: {
        addListener: (fn: (notificationId: string) => void) => {
          notificationClickListener = fn;
        },
      },
      getPermissionLevel: async () => {
        if (opts.notificationPermissionError) {
          throw new Error(opts.notificationPermissionError);
        }
        return opts.notificationPermission || "granted";
      },
      create: async (id: string, options: any) => {
        notificationCreateCalls += 1;
        if (opts.notificationPromiseError) {
          return Promise.reject(new Error(opts.notificationPromiseError));
        }
        if (opts.notificationError) {
          throw new Error("notifications unavailable");
        }
        if (opts.notificationRuntimeError) {
          (mockChrome.runtime as any).lastError = {
            message: opts.notificationRuntimeError,
          };
          throw new Error("Promise rejected after runtime.lastError");
        }
        createdNotifications.push({ id, options });
        activeNotificationIds[id] = true;
        return opts.notificationReturnUndefined ? undefined : id;
      },
      getAll: async () => {
        if (opts.notificationGetAllError) {
          throw new Error(opts.notificationGetAllError);
        }
        if (opts.notificationGetAllMissing) {
          return {};
        }
        return { ...activeNotificationIds };
      },
      clear: async (id: string) => {
        delete activeNotificationIds[id];
        return true;
      },
    },
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: extensionVersion }),
      getURL: (fileName: string) => `chrome-extension://test/${fileName}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn: Function) => {
          messageListener = fn;
        },
      },
    },
  };

  const mockFetch = async (url: string, fetchOpts: any) => {
    if (url.startsWith("chrome-extension://")) {
      if (opts.iconFetchError) {
        throw new Error(opts.iconFetchError);
      }
      return {
        ok: (opts.iconFetchStatus || 200) >= 200 && (opts.iconFetchStatus || 200) < 300,
        status: opts.iconFetchStatus || 200,
        headers: {
          get: () => opts.iconContentType || "image/png",
        },
        arrayBuffer: async () => (opts.iconEmpty ? new ArrayBuffer(0) : new ArrayBuffer(1)),
      };
    }
    mockFetchCalls.push({ url, body: fetchOpts.body ? JSON.parse(fetchOpts.body) : null });
    if (opts.fetchError) {
      throw new Error(opts.fetchError);
    }
    const configuredResponse =
      typeof opts.fetchResponse === "function"
        ? opts.fetchResponse(url, fetchOpts, mockFetchCalls.length)
        : opts.fetchResponse;
    if (configuredResponse) {
      return {
        ok: configuredResponse.ok,
        status: configuredResponse.status,
        text: configuredResponse.text || (async () => ""),
        json: configuredResponse.json || (async () => ({})),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "OK",
      json: async () => ({ success: true }),
    };
  };

  const swPath = path.join(__dirname, "../extension/tibo-monitor/service-worker.js");
  const swCode = fs.readFileSync(swPath, "utf8");

  const sandbox = {
    chrome: mockChrome,
    fetch: mockFetch,
    console,
    Date,
    Promise,
    setTimeout,
    setInterval,
    URL,
  };

  let context: vm.Context;
  (sandbox as typeof sandbox & { importScripts: (...scriptNames: string[]) => void }).importScripts = (...scriptNames: string[]) => {
    for (const scriptName of scriptNames) {
      const sharedPath = path.join(__dirname, "../extension/tibo-monitor", scriptName);
      vm.runInContext(fs.readFileSync(sharedPath, "utf8"), context);
    }
  };

  context = vm.createContext(sandbox);
  vm.runInContext(swCode, context);

  return {
    context,
    localStore,
    getStorageLocalAccessLevel: () => storageLocalAccessLevel,
    setExtensionVersion: (version: string) => {
      extensionVersion = version;
    },
    alarmsCreated,
    reloadedTabIds,
    updatedTabs,
    contentMessages,
    openedTabs,
    createdNotifications,
    getNotificationCreateCalls: () => notificationCreateCalls,
    mockFetchCalls,
    fireAlarm: async (name: string) => {
      if (alarmListener) {
        await alarmListener({ name });
      }
    },
    sendMessage: (msg: any, sender: any = {}): Promise<any> => {
      return new Promise((resolve) => {
        if (messageListener) {
          messageListener(msg, sender, (res: any) => resolve(res));
        } else {
          resolve(null);
        }
      });
    },
    clickNotification: async (notificationId: string) => {
      if (notificationClickListener) {
        await notificationClickListener(notificationId);
      }
    },
    waitForStartup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test("service worker restricts local storage to trusted extension contexts", () => {
  const { getStorageLocalAccessLevel } = setupServiceWorkerContext();

  assert.equal(getStorageLocalAccessLevel(), "TRUSTED_CONTEXTS");
});

test("content monitor state bridge excludes webhook secrets", async () => {
  const { localStore, sendMessage } = setupServiceWorkerContext();
  localStore.tibo_leader_tab_id = "tab-1";
  localStore.webhook_secret = "must-not-cross-the-bridge";

  const response = await sendMessage({
    action: "GET_CONTENT_MONITOR_STATE",
    keys: ["tibo_leader_tab_id", "webhook_secret"],
  });

  assert.equal(response.success, true);
  assert.deepEqual(response.data, { tibo_leader_tab_id: "tab-1" });
  assert.equal(Object.hasOwn(response.data, "webhook_secret"), false);
});

test("REQUIREMENT 3: Extension setup registers a 10-minute page reload alarm", () => {
  const { alarmsCreated } = setupServiceWorkerContext();

  assert.strictEqual(alarmsCreated.length, 1, "Exactly one alarm should be created at setup");
  assert.strictEqual(alarmsCreated[0].name, "tibo_page_reload_alarm");
  assert.strictEqual(alarmsCreated[0].alarmInfo.periodInMinutes, 10, "Alarm must run every 10 minutes");
});

test("service worker migrates only legacy or missing observatory domains", async () => {
  const legacy = setupServiceWorkerContext([], {
    observatoryDomain: "https://codex-reset-observatory.vercel.app/",
  });
  legacy.localStore.webhook_secret = "unchanged-secret";
  await legacy.waitForStartup();
  assert.strictEqual(legacy.localStore.observatory_domain, "https://codex.gussuriworks.com");
  assert.strictEqual(legacy.localStore.webhook_secret, "unchanged-secret");

  const missing = setupServiceWorkerContext([]);
  await missing.waitForStartup();
  assert.strictEqual(missing.localStore.observatory_domain, "https://codex.gussuriworks.com");

  const custom = setupServiceWorkerContext([], {
    observatoryDomain: "https://staging.example.test",
  });
  await custom.waitForStartup();
  assert.strictEqual(custom.localStore.observatory_domain, "https://staging.example.test");
});

test("heartbeat and tweet webhook use the configured new observatory domain", async () => {
  const context = setupServiceWorkerContext([], {
    observatoryDomain: "https://codex.gussuriworks.com",
  });
  context.localStore.webhook_secret = "test-secret";

  const heartbeat = await context.sendMessage({
    action: "POST_HEARTBEAT",
    payload: {
      sessionId: "session_domain_migration",
      lastSuccessfulParseAt: "2026-08-04T22:00:00.000Z",
      lastSeenTweetId: "2084000000000000201",
    },
  });
  assert.equal(heartbeat.success, true);
  assert.equal(
    context.mockFetchCalls[0].url,
    "https://codex.gussuriworks.com/api/webhook/tibo/heartbeat",
  );

  const tweet = await context.sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "2084000000000000201",
      text: "I reset usage limits.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000201",
      tweetCreatedAt: "2026-08-04T22:00:00.000Z",
    },
  });
  assert.equal(tweet.success, true);
  assert.equal(
    context.mockFetchCalls[1].url,
    "https://codex.gussuriworks.com/api/webhook/tibo",
  );
});

test("REQUIREMENT 4: When no monitored tab is open, preserves last_page_reload_at and updates status to monitored_tab_missing", async () => {
  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext([]);

  const previousSuccessTime = "2026-07-31T20:00:00.000Z";
  localStore["tibo_last_page_reload_at"] = previousSuccessTime;

  await fireAlarm("tibo_page_reload_alarm");

  assert.strictEqual(reloadedTabIds.length, 0, "No tab should be reloaded when zero profile tabs exist");
  assert.strictEqual(
    localStore["tibo_last_page_reload_at"],
    previousSuccessTime,
    "last_page_reload_at MUST NOT be overwritten when tab is missing"
  );
  assert.strictEqual(localStore["tibo_last_page_reload_status"], "monitored_tab_missing");
});

test("REQUIREMENT 4: When tab reload fails with an error, preserves last_page_reload_at and updates status to error", async () => {
  const profileTab = [{ id: 501, url: "https://x.com/thsottiaux" }];
  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext(profileTab, {
    failReloadTabId: 501,
  });

  const previousSuccessTime = "2026-07-31T20:00:00.000Z";
  localStore["tibo_last_page_reload_at"] = previousSuccessTime;

  await fireAlarm("tibo_page_reload_alarm");

  assert.strictEqual(reloadedTabIds.length, 0, "Reload failed, so tabId must not be added to reloaded list");
  assert.strictEqual(
    localStore["tibo_last_page_reload_at"],
    previousSuccessTime,
    "last_page_reload_at MUST NOT be overwritten on error"
  );
  assert.strictEqual(localStore["tibo_last_page_reload_status"], "error");
  assert.strictEqual(localStore["tibo_last_page_reload_error"], "page_reload_error");
});

test("REQUIREMENT 5: Ignores tweet status detail tabs (/thsottiaux/status/...) and only reloads profile tabs (/thsottiaux or /thsottiaux/)", async () => {
  const tabs = [
    { id: 101, url: "https://x.com/thsottiaux/status/9876543210" },
    { id: 102, url: "https://twitter.com/thsottiaux/status/11223344" },
  ];

  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext(tabs);

  await fireAlarm("tibo_page_reload_alarm");

  assert.strictEqual(reloadedTabIds.length, 0, "Individual status detail tabs must NOT be reloaded");
  assert.strictEqual(localStore["tibo_last_page_reload_status"], "monitored_tab_missing");
});

test("RESTORE_MONITORED_TIMELINE returns a profile tab from a Tibo status page to the profile timeline", async () => {
  const tabs = [{ id: 601, url: "https://x.com/thsottiaux/status/9876543210" }];
  const context = setupServiceWorkerContext(tabs);

  const result = await context.sendMessage(
    { action: "RESTORE_MONITORED_TIMELINE", timeline: "profile" },
    { tab: tabs[0] },
  );

  assert.deepEqual(result, { success: true, data: { timeline: "profile" } });
  assert.deepEqual(context.updatedTabs, [
    { tabId: 601, updateProperties: { url: "https://x.com/thsottiaux" } },
  ]);
});

test("RESTORE_MONITORED_TIMELINE restores with_replies and rejects non-Tibo status pages", async () => {
  const repliesTabs = [{ id: 602, url: "https://twitter.com/thsottiaux/status/123456789" }];
  const repliesContext = setupServiceWorkerContext(repliesTabs);
  const repliesResult = await repliesContext.sendMessage(
    { action: "RESTORE_MONITORED_TIMELINE", timeline: "with_replies" },
    { tab: repliesTabs[0] },
  );

  assert.equal(repliesResult.success, true);
  assert.deepEqual(repliesContext.updatedTabs[0], {
    tabId: 602,
    updateProperties: { url: "https://x.com/thsottiaux/with_replies" },
  });

  const otherUserTabs = [{ id: 603, url: "https://x.com/other/status/123456789" }];
  const otherUserContext = setupServiceWorkerContext(otherUserTabs);
  const otherUserResult = await otherUserContext.sendMessage(
    { action: "RESTORE_MONITORED_TIMELINE", timeline: "profile" },
    { tab: otherUserTabs[0] },
  );

  assert.deepEqual(otherUserResult, {
    success: false,
    error: "invalid_timeline_restore_request",
  });
  assert.deepEqual(otherUserContext.updatedTabs, []);
});

test("the ten-minute alarm restores a remembered status tab when its canonical timeline is missing", async () => {
  const tabs = [{ id: 604, url: "https://x.com/thsottiaux/status/9876543210" }];
  const context = setupServiceWorkerContext(tabs);
  context.localStore.tibo_last_profile_reload_tab_id = 604;

  await context.fireAlarm("tibo_page_reload_alarm");

  assert.deepEqual(context.updatedTabs[0], {
    tabId: 604,
    updateProperties: { url: "https://x.com/thsottiaux" },
  });
  assert.deepEqual(context.reloadedTabIds, []);
  assert.equal(context.localStore.tibo_last_profile_reload_status, "success");
});

test("REQUIREMENT 5 & 6: Strictly matches profile tabs and reloads exactly 1 profile tab when multiple exist", async () => {
  const tabs = [
    { id: 201, url: "https://x.com/thsottiaux/status/12345" }, // Detail page (ignore)
    { id: 202, url: "https://x.com/thsottiaux" },              // Profile tab (target 1)
    { id: 203, url: "https://twitter.com/thsottiaux/" },       // Profile tab (target 2)
  ];

  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext(tabs);

  await fireAlarm("tibo_page_reload_alarm");

  assert.strictEqual(reloadedTabIds.length, 1, "Exactly 1 profile tab must be reloaded");
  assert.strictEqual(reloadedTabIds[0], 202, "First profile tab (id: 202) must be selected");
  assert.strictEqual(localStore["tibo_last_page_reload_status"], "success");
  assert.ok(localStore["tibo_last_page_reload_at"], "tibo_last_page_reload_at must be updated on success");
});

test("reloads at most one profile tab and one with-replies tab", async () => {
  const tabs = [
    { id: 301, url: "https://x.com/thsottiaux" },
    { id: 302, url: "https://x.com/thsottiaux/with_replies" },
    { id: 303, url: "https://twitter.com/thsottiaux/with_replies/" },
    { id: 304, url: "https://x.com/thsottiaux/status/123" },
  ];
  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext(tabs);

  await fireAlarm("tibo_page_reload_alarm");

  assert.deepEqual(reloadedTabIds, [301, 302]);
  assert.equal(localStore.tibo_last_profile_reload_status, "success");
  assert.equal(localStore.tibo_last_with_replies_reload_status, "success");
  assert.equal(localStore.tibo_last_page_reload_status, "success");
});

test("a missing timeline does not fail the other timeline reload", async () => {
  const tabs = [{ id: 305, url: "https://x.com/thsottiaux/with_replies" }];
  const { fireAlarm, localStore, reloadedTabIds } = setupServiceWorkerContext(tabs);

  await fireAlarm("tibo_page_reload_alarm");

  assert.deepEqual(reloadedTabIds, [305]);
  assert.equal(localStore.tibo_last_profile_reload_status, "monitored_tab_missing");
  assert.equal(localStore.tibo_last_with_replies_reload_status, "success");
  assert.equal(localStore.tibo_last_page_reload_status, "success");
});

test("REQUIREMENT 2 & 3: Heartbeat API & Service Worker include 3 page reload fields (at, status, error)", async () => {
  const { sendMessage, localStore, mockFetchCalls } = setupServiceWorkerContext();

  const sampleTime = "2026-07-31T22:00:00.000Z";
  localStore["tibo_last_page_reload_at"] = sampleTime;
  localStore["tibo_last_page_reload_status"] = "success";
  localStore["tibo_last_page_reload_error"] = null;
  localStore["webhook_secret"] = "test-secret";

  const heartbeatResponse = await sendMessage({
    action: "POST_HEARTBEAT",
    payload: {
      sessionId: "session_test_456",
      lastSuccessfulParseAt: "2026-07-31T22:05:00.000Z",
      lastSeenTweetId: "tweet_222",
      newestSeenTweetCreatedAt: "2026-07-31T22:04:00.000Z",
      lastScanError: null,
      selectorVersion: "v1.4-extension",
    },
  });

  assert.strictEqual(heartbeatResponse.success, true);
  assert.strictEqual(mockFetchCalls.length, 1);

  const sentBody = mockFetchCalls[0].body;
  assert.strictEqual(sentBody.last_page_reload_at, sampleTime);
  assert.strictEqual(sentBody.last_page_reload_status, "success");
  assert.strictEqual(sentBody.last_page_reload_error, null);
  assert.strictEqual(sentBody.newestSeenTweetCreatedAt, "2026-07-31T22:04:00.000Z");
});

test("Service Worker keeps non-2xx response details local and redacts secrets", async () => {
  const { sendMessage, localStore } = setupServiceWorkerContext([], {
    fetchResponse: {
      ok: false,
      status: 500,
      text: async () => "Authorization: Bearer secret-token api_key=private-key",
    },
  });
  localStore["webhook_secret"] = "secret-token";

  const result = await sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "123456789",
      text: "Sample",
      tweetUrl: "https://x.com/thsottiaux/status/123456789",
      tweetCreatedAt: "2026-08-02T00:00:00.000Z",
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  assert.match(result.error, /HTTP 500/);
  assert.doesNotMatch(JSON.stringify(localStore["tibo_diagnostic_logs"] || []), /secret-token|private-key/);
  assert.match(JSON.stringify(localStore["tibo_diagnostic_logs"] || []), /webhook_http_error|REDACTED/);
});

test("HTTP 400 is quarantined and does not trigger an immediate second fetch", async () => {
  const { sendMessage, localStore, mockFetchCalls } = setupServiceWorkerContext([], {
    fetchResponse: {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "Invalid text" }),
    },
  });
  localStore.webhook_secret = "test-secret";
  const payload = {
    tweetId: "2088501704849534991",
    text: "",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534991",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  const first = await sendMessage({ action: "POST_TWEET", payload });
  const second = await sendMessage({ action: "POST_TWEET", payload });

  assert.equal(first.success, false);
  assert.equal(first.quarantined, true);
  assert.equal(first.httpStatus, 400);
  assert.equal(second.quarantined, true);
  assert.equal(mockFetchCalls.length, 1);
  assert.equal(localStore.tibo_quarantined_tweet_ids[payload.tweetId].reasonCode, "payload_rejected");
  const diagnostics = JSON.stringify(localStore.tibo_diagnostic_logs || []);
  assert.match(diagnostics, /textLength.*0/);
  assert.doesNotMatch(diagnostics, /Invalid text payload/);

  const authRecovery = await sendMessage({ action: "CLEAR_AUTH_QUARANTINE" });
  assert.equal(authRecovery.data.clearedCount, 0);
  const afterAuthRecovery = await sendMessage({ action: "POST_TWEET", payload });
  assert.equal(afterAuthRecovery.quarantined, true);
  assert.equal(mockFetchCalls.length, 1);
});

test("explicit tweet retry removes only the requested ID and notifies monitored tabs", async () => {
  const targetTweetId = "2091407991736332689";
  const otherTweetId = "2091407991736332690";
  const context = setupServiceWorkerContext([
    { id: 21, url: "https://x.com/thsottiaux/with_replies" },
    { id: 22, url: `https://x.com/thsottiaux/status/${targetTweetId}` },
    { id: 99, url: "https://example.com/" },
  ]);
  context.localStore.tibo_processed_tweet_ids = [targetTweetId, otherTweetId];
  context.localStore.tibo_quarantined_tweet_ids = {
    [targetTweetId]: { reasonCode: "payload_rejected" },
    [otherTweetId]: { reasonCode: "payload_rejected" },
  };

  const result = await Promise.race([
    context.sendMessage({ action: "RETRY_TWEET", tweetId: targetTweetId }),
    new Promise((resolve) => setTimeout(() => resolve({ error: "unhandled_action" }), 50)),
  ]);

  assert.equal(result.success, true);
  assert.equal(result.tweetId, targetTweetId);
  assert.equal(result.clearedProcessed, true);
  assert.equal(result.clearedQuarantine, true);
  assert.deepEqual(context.localStore.tibo_processed_tweet_ids, [otherTweetId]);
  assert.deepEqual(context.localStore.tibo_quarantined_tweet_ids, {
    [otherTweetId]: { reasonCode: "payload_rejected" },
  });
  assert.deepEqual(context.contentMessages, [
    { tabId: 21, message: { action: "RETRY_TWEET", tweetId: targetTweetId } },
    { tabId: 22, message: { action: "RETRY_TWEET", tweetId: targetTweetId } },
  ]);
});

test("explicit tweet retry rejects malformed IDs without touching queue state", async () => {
  const context = setupServiceWorkerContext([
    { id: 21, url: "https://x.com/thsottiaux" },
  ]);
  context.localStore.tibo_processed_tweet_ids = ["2091407991736332689"];

  const result = await Promise.race([
    context.sendMessage({ action: "RETRY_TWEET", tweetId: "not-a-tweet-id" }),
    new Promise((resolve) => setTimeout(() => resolve({ error: "unhandled_action" }), 50)),
  ]);

  assert.equal(result.success, false);
  assert.equal(result.error, "invalid_tweet_id");
  assert.deepEqual(context.localStore.tibo_processed_tweet_ids, ["2091407991736332689"]);
  assert.deepEqual(context.contentMessages, []);
});

test("401 is quarantined without a retry storm and clears after saving auth settings", async () => {
  const context = setupServiceWorkerContext(
    [{ id: 21, url: "https://x.com/thsottiaux" }],
    {
      fetchResponse: {
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      },
    },
  );
  context.localStore.webhook_secret = "old-secret";
  const payload = {
    tweetId: "2088501704849534995",
    text: "A valid tweet",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534995",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  const first = await context.sendMessage({ action: "POST_TWEET", payload });
  const second = await context.sendMessage({ action: "POST_TWEET", payload });

  assert.equal(first.quarantined, true);
  assert.equal(first.quarantineReason, "auth_blocked");
  assert.equal(second.quarantined, true);
  assert.equal(context.mockFetchCalls.length, 1);
  assert.equal(
    context.localStore.tibo_quarantined_tweet_ids[payload.tweetId].reasonCode,
    "auth_blocked",
  );

  context.localStore.webhook_secret = "new-secret";
  const cleared = await context.sendMessage({ action: "CLEAR_AUTH_QUARANTINE" });
  assert.equal(cleared.success, true);
  assert.equal(cleared.data.clearedCount, 1);
  assert.deepEqual(context.localStore.tibo_quarantined_tweet_ids, {});
  assert.deepEqual(context.contentMessages, [
    { tabId: 21, message: { action: "CLEAR_AUTH_QUARANTINE" } },
  ]);

  const afterSettingsChange = await context.sendMessage({ action: "POST_TWEET", payload });
  assert.equal(afterSettingsChange.quarantined, true);
  assert.equal(context.mockFetchCalls.length, 2);
});

test("403 is cleared by a successful connection test and can be sent again", async () => {
  const context = setupServiceWorkerContext([], {
    fetchResponse: (url) => {
      if (url.endsWith("/api/webhook/tibo")) {
        return {
          ok: false,
          status: 403,
          text: async () => "Forbidden",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      };
    },
  });
  context.localStore.webhook_secret = "test-secret";
  const payload = {
    tweetId: "2088501704849534996",
    text: "A valid tweet",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534996",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  const first = await context.sendMessage({ action: "POST_TWEET", payload });
  const blocked = await context.sendMessage({ action: "POST_TWEET", payload });
  assert.equal(first.quarantineReason, "auth_blocked");
  assert.equal(blocked.quarantined, true);
  assert.equal(context.mockFetchCalls.length, 1);

  const connection = await context.sendMessage({ action: "TEST_CONNECTION" });
  assert.equal(connection.success, true);
  assert.deepEqual(context.localStore.tibo_quarantined_tweet_ids, {});

  const afterRecovery = await context.sendMessage({ action: "POST_TWEET", payload });
  assert.equal(afterRecovery.quarantineReason, "auth_blocked");
  assert.equal(context.mockFetchCalls.length, 3);
});

test("retryable webhook statuses are retried and are not quarantined", async () => {
  const { sendMessage, localStore, mockFetchCalls } = setupServiceWorkerContext([], {
    fetchResponse: {
      ok: false,
      status: 429,
      text: async () => "rate limited",
    },
  });
  localStore.webhook_secret = "test-secret";
  const payload = {
    tweetId: "2088501704849534992",
    text: "A valid tweet",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534992",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  const first = await sendMessage({ action: "POST_TWEET", payload });
  const second = await sendMessage({ action: "POST_TWEET", payload });

  assert.equal(first.success, false);
  assert.equal(first.retryable, true);
  assert.equal(second.retryable, true);
  assert.equal(mockFetchCalls.length, 2);
  assert.equal(localStore.tibo_quarantined_tweet_ids, undefined);
});

test("network webhook failures remain retryable and are not quarantined", async () => {
  const { sendMessage, localStore, mockFetchCalls } = setupServiceWorkerContext([], {
    fetchError: "network offline",
  });
  localStore.webhook_secret = "test-secret";
  const payload = {
    tweetId: "2088501704849534994",
    text: "A valid tweet",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534994",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  const first = await sendMessage({ action: "POST_TWEET", payload });
  const second = await sendMessage({ action: "POST_TWEET", payload });

  assert.equal(first.retryable, true);
  assert.equal(second.retryable, true);
  assert.equal(mockFetchCalls.length, 2);
  assert.equal(localStore.tibo_quarantined_tweet_ids, undefined);
});

test("a quarantined tweet becomes retryable after an extension version update", async () => {
  const context = setupServiceWorkerContext([], {
    extensionVersion: "1.0.1",
    fetchResponse: {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "Invalid text" }),
    },
  });
  context.localStore.webhook_secret = "test-secret";
  const payload = {
    tweetId: "2088501704849534993",
    text: "",
    tweetUrl: "https://x.com/thsottiaux/status/2088501704849534993",
    tweetCreatedAt: "2026-08-15T05:43:00.000Z",
  };

  await context.sendMessage({ action: "POST_TWEET", payload });
  await context.sendMessage({ action: "POST_TWEET", payload });
  assert.equal(context.mockFetchCalls.length, 1);

  context.setExtensionVersion("1.0.2");
  const afterUpdate = await context.sendMessage({ action: "POST_TWEET", payload });
  assert.equal(afterUpdate.quarantined, true);
  assert.equal(context.mockFetchCalls.length, 2);
});

test("Service Worker sends only safe heartbeat counters and omits snapshot data", async () => {
  const { sendMessage, localStore, mockFetchCalls } = setupServiceWorkerContext();
  localStore["webhook_secret"] = "test-secret";

  const response = await sendMessage({
    action: "POST_HEARTBEAT",
    payload: {
      sessionId: "session_safe_1",
      lastSuccessfulParseAt: "2026-08-02T00:00:00.000Z",
      lastSeenTweetId: "123456789",
      newestSeenTweetCreatedAt: "not-a-date",
      lastScanError: "raw secret error",
      selectorVersion: "v1.5-diagnostics",
      lastScanSummary: {
        articleCount: 1,
        timeElementCount: 1,
        tweetTextCount: 1,
        matchingTiboStatusCount: 1,
        translatedTweetCount: 0,
        tweetDatetimeCount: 1,
        parseSuccessCount: 0,
        currentUrl: "https://x.com/thsottiaux",
        selectorVersion: "v1.5-diagnostics",
        scanTimestamp: "2026-08-02T00:00:00.000Z",
        snapshots: ["<article>secret HTML</article>"],
      },
    },
  });

  assert.equal(response.success, true);
  const sentBody = mockFetchCalls[0].body;
  assert.equal(sentBody.lastScanError, "scan_error");
  assert.equal(sentBody.newestSeenTweetCreatedAt, null);
  assert.equal(sentBody.lastScanSummary.snapshots, undefined);
  assert.doesNotMatch(JSON.stringify(sentBody), /secret HTML|raw secret error/i);
});

test("formal adoption creates one local notification and opens its source", async () => {
  const { sendMessage, localStore, createdNotifications, clickNotification, openedTabs } =
    setupServiceWorkerContext([], {
      fetchResponse: {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          formalAdoption: {
            newlyAdopted: true,
            tweetId: "2084000000000000001",
            title: "ランダムリセット",
            confidence: 0.98,
            sourceUrl: "https://x.com/thsottiaux/status/2084000000000000001",
          },
        }),
      },
    });
  localStore.webhook_secret = "test-secret";

  const first = await sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "2084000000000000001",
      text: "I reset usage limits.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000001",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    },
  });
  assert.equal(first.success, true);
  assert.equal(createdNotifications.length, 1);
  assert.match(createdNotifications[0].options.message, /98%/);

  await clickNotification(createdNotifications[0].id);
  assert.deepEqual(openedTabs, [
    { url: "https://x.com/thsottiaux/status/2084000000000000001" },
  ]);

  // A second webhook response with the same formal tweet ID remains locally deduped.
  await sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "2084000000000000002",
      text: "I reset usage limits again.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000002",
      tweetCreatedAt: "2026-08-04T00:01:00.000Z",
    },
  });
  assert.equal(createdNotifications.length, 1);
});

test("production notification keeps dedup state when create returns no id", async () => {
  const { sendMessage, localStore, createdNotifications } = setupServiceWorkerContext([], {
    notificationReturnUndefined: true,
    fetchResponse: {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        formalAdoption: {
          newlyAdopted: true,
          tweetId: "2084000000000000004",
          title: "ランダムリセット",
          confidence: 0.98,
          sourceUrl: "https://x.com/thsottiaux/status/2084000000000000004",
        },
      }),
    },
  });
  localStore.webhook_secret = "test-secret";

  const result = await sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "2084000000000000004",
      text: "I reset usage limits.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000004",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.equal(result.success, true);
  assert.equal(createdNotifications.length, 1);
  assert.deepEqual(localStore.tibo_formal_adoption_notified_ids, [
    "2084000000000000004",
  ]);
});

test("notification API failure does not fail tweet collection", async () => {
  const { sendMessage, localStore, createdNotifications } = setupServiceWorkerContext([], {
    notificationError: true,
    fetchResponse: {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        formalAdoption: {
          newlyAdopted: true,
          tweetId: "2084000000000000003",
          title: "ランダムリセット",
          confidence: 0.98,
          sourceUrl: "https://x.com/thsottiaux/status/2084000000000000003",
        },
      }),
    },
  });
  localStore.webhook_secret = "test-secret";

  const result = await sendMessage({
    action: "POST_TWEET",
    payload: {
      tweetId: "2084000000000000003",
      text: "I reset usage limits.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000003",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    },
  });

  assert.equal(result.success, true);
  assert.equal(createdNotifications.length, 0);
  assert.deepEqual(localStore.tibo_processed_tweet_ids, ["2084000000000000003"]);
});

test("notification self-test is local, repeatable, and opens the history page", async () => {
  const {
    sendMessage,
    localStore,
    createdNotifications,
    clickNotification,
    openedTabs,
    mockFetchCalls,
  } = setupServiceWorkerContext();

  const first = await sendMessage({
    type: "TEST_FORMAL_ADOPTION_NOTIFICATION",
  });

  assert.equal(first.ok, true);
  assert.ok(first.notificationId);
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].options.type, "basic");
  assert.match(
    createdNotifications[0].options.iconUrl,
    /^chrome-extension:\/\/test\/icons\/icon-128\.png$/,
  );
  assert.equal(createdNotifications[0].options.title, "Codexリセット通知のテスト");
  assert.equal(
    createdNotifications[0].options.message,
    "通知機能は正常に動作しています。",
  );
  assert.equal(first.details.notificationPresence, "present");
  assert.equal(localStore.tibo_formal_adoption_notified_ids, undefined);
  assert.equal(localStore.tibo_processed_tweet_ids, undefined);
  assert.deepEqual(mockFetchCalls, []);

  await clickNotification(first.notificationId);
  assert.deepEqual(openedTabs, [
    { url: "https://codex.gussuriworks.com/history" },
  ]);

  const second = await sendMessage({
    action: "TEST_FORMAL_ADOPTION_NOTIFICATION",
  });
  assert.equal(second.ok, true);
  assert.equal(second.notificationId, first.notificationId);
  assert.equal(createdNotifications.length, 2);
});

test("notification self-test accepts an empty create return value", async () => {
  const { sendMessage, localStore, createdNotifications } = setupServiceWorkerContext([], {
    notificationReturnUndefined: true,
  });

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });

  assert.equal(result.ok, true);
  assert.equal(result.requestedNotificationId, "tibo-monitor-notification-test");
  assert.equal(result.returnedNotificationId, null);
  assert.equal(result.actualNotificationId, "tibo-monitor-notification-test");
  assert.equal(
    result.warning,
    "notifications.create returned no id; requested id was used",
  );
  assert.equal(result.getAllContainsRequestedId, true);
  assert.equal(createdNotifications.length, 1);
  assert.equal(localStore.tibo_diagnostic_logs.at(-1).event, "notification_test_succeeded");
  assert.equal(
    localStore.tibo_diagnostic_logs.at(-1).warning,
    "notifications.create returned no id; requested id was used",
  );
});

test("getAll verification is diagnostic-only after a successful create", async () => {
  const missing = await (async () => {
    const context = setupServiceWorkerContext([], { notificationGetAllMissing: true });
    return context.sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });
  })();
  assert.equal(missing.ok, true);
  assert.equal(missing.getAllContainsRequestedId, false);
  assert.match(missing.warning, /getAll did not contain/);

  const rejected = await (async () => {
    const context = setupServiceWorkerContext([], {
      notificationGetAllError: "getAll unavailable",
    });
    return context.sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });
  })();
  assert.equal(rejected.ok, true);
  assert.equal(rejected.getAllContainsRequestedId, null);
  assert.match(rejected.warning, /getAll verification failed/);
});

test("notification self-test reports notification API failure without network activity", async () => {
  const { sendMessage, localStore, createdNotifications, mockFetchCalls } =
    setupServiceWorkerContext([], { notificationError: true });

  const result = await sendMessage({
    action: "TEST_FORMAL_ADOPTION_NOTIFICATION",
    type: "TEST_FORMAL_ADOPTION_NOTIFICATION",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "notifications unavailable");
  assert.equal(createdNotifications.length, 0);
  assert.equal(localStore.tibo_formal_adoption_notified_ids, undefined);
  assert.deepEqual(mockFetchCalls, []);
});

test("notification self-test does not call create when permission is denied", async () => {
  const { sendMessage, getNotificationCreateCalls, localStore } =
    setupServiceWorkerContext([], {
      notificationPermission: "denied",
    });

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Chrome extension notification permission is denied.");
  assert.equal(result.details.permissionLevel, "denied");
  assert.equal(getNotificationCreateCalls(), 0);
  assert.equal(localStore.tibo_formal_adoption_notified_ids, undefined);
});

test("notification self-test preserves a Promise rejection from Chrome", async () => {
  const { sendMessage, getNotificationCreateCalls } = setupServiceWorkerContext([], {
    notificationPromiseError: "Unable to download all specified images.",
  });

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Unable to download all specified images.");
  assert.equal(result.details.errorMessage, "Unable to download all specified images.");
  assert.equal(getNotificationCreateCalls(), 1);
});

test("notification self-test preserves runtime.lastError", async () => {
  const { sendMessage, getNotificationCreateCalls } = setupServiceWorkerContext([], {
    notificationRuntimeError: "The notifications permission is denied.",
  });

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "The notifications permission is denied.");
  assert.equal(getNotificationCreateCalls(), 1);
});

test("notification self-test reports icon load failures before create", async () => {
  const { sendMessage, getNotificationCreateCalls, localStore } =
    setupServiceWorkerContext([], {
      iconFetchStatus: 404,
    });

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Notification icon could not be loaded: HTTP 404");
  assert.equal(result.details.iconLoadStatus, "http_error");
  assert.equal(getNotificationCreateCalls(), 0);
  assert.equal(localStore.tibo_diagnostic_logs.at(-1).event, "notification_test_failed");
  assert.equal(
    localStore.tibo_diagnostic_logs.at(-1).error,
    "Notification icon could not be loaded: HTTP 404",
  );
});

test("notification self-test records concrete local diagnostic details", async () => {
  const { sendMessage, localStore } = setupServiceWorkerContext();

  const result = await sendMessage({ action: "TEST_FORMAL_ADOPTION_NOTIFICATION" });
  assert.equal(result.ok, true);

  const logs = localStore.tibo_diagnostic_logs || [];
  assert.equal(logs.at(-1).event, "notification_test_succeeded");
  assert.equal(logs.at(-1).permissionLevel, "granted");
  assert.equal(logs.at(-1).iconLoadStatus, "ok");
  assert.match(logs.at(-1).iconUrl, /^chrome-extension:\/\//);
  assert.equal(logs.at(-1).notificationId, result.notificationId);
});
