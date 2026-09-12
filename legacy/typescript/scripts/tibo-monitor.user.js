// ==UserScript==
// @name         Codex Reset Observatory - Tibo Real-Time Monitor
// @namespace    https://codex.gussuriworks.com/
// @version      1.2.0
// @description  Monitors Tibo (@thsottiaux) tweets on X in real-time and posts signals to Codex Reset Observatory Webhook.
// @author       Antigravity AI / Codex Reset Observatory
// @match        https://x.com/thsottiaux*
// @match        https://x.com/notifications*
// @match        https://twitter.com/thsottiaux*
// @match        https://twitter.com/notifications*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      codex.gussuriworks.com
// @connect      codex-reset-observatory.vercel.app
// @connect      localhost
// ==UserScript==

(function () {
  'use strict';

  const SELECTOR_VERSION = "v1.2";

  // 1. GM_registerMenuCommand for safe Webhook Secret configuration
  GM_registerMenuCommand("⚙️ Set Webhook Secret", function () {
    const current = GM_getValue("webhook_secret", "");
    const input = prompt("Enter your Observatory TIBO_WEBHOOK_SECRET:", current);
    if (input !== null) {
      GM_setValue("webhook_secret", input.trim());
      alert("Webhook Secret saved successfully!");
    }
  });

  GM_registerMenuCommand("🌐 Set Observatory Domain", function () {
    const current = GM_getValue("observatory_domain", "https://codex.gussuriworks.com");
    const input = prompt("Enter your Observatory domain URL:", current);
    if (input !== null) {
      GM_setValue("observatory_domain", input.trim());
      alert("Observatory Domain saved successfully!");
    }
  });

  // Local Configuration
  const OBSERVATORY_DOMAIN = GM_getValue("observatory_domain", "https://codex.gussuriworks.com");
  const QUEUE_KEY = "tibo_processed_tweet_ids";
  const SESSION_KEY = "tibo_session_id";
  const TAB_ID = "tab_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);

  // In-flight tracking to prevent concurrent requests for the same tweetId
  const inFlightTweetIds = new Set();

  if (!GM_getValue("webhook_secret", "")) {
    console.warn("[Tibo Monitor] WARNING: 'webhook_secret' is not configured! Use Tampermonkey Menu > Set Webhook Secret.");
  }

  // Persistent Session ID across page reloads in single tab
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = "session_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  let lastSuccessfulParseAt = null;
  let lastSeenTweetId = null;
  let lastScanError = null;

  // Helper: Get recent 100 tweet IDs queue
  function getProcessedIds() {
    try {
      return JSON.parse(GM_getValue(QUEUE_KEY, "[]"));
    } catch {
      return [];
    }
  }

  // Helper: Add ID to 100-item sliding window AFTER HTTP 2xx success
  function markIdProcessed(tweetId) {
    const list = getProcessedIds();
    if (!list.includes(tweetId)) {
      list.push(tweetId);
      if (list.length > 100) {
        list.shift(); // Keep latest 100 items
      }
      GM_setValue(QUEUE_KEY, JSON.stringify(list));
    }
  }

  // 2. Leader Lock Mechanism for Heartbeat (Prevents multi-tab session resets)
  function tryAcquireLeaderLock() {
    const now = Date.now();
    const leaderTab = GM_getValue("tibo_leader_tab_id", "");
    const leaderTimestamp = GM_getValue("tibo_leader_timestamp", 0);

    // If current tab is leader, or leader expired (no heartbeat for 30s), acquire lock
    if (leaderTab === TAB_ID || !leaderTab || now - leaderTimestamp > 30 * 1000) {
      GM_setValue("tibo_leader_tab_id", TAB_ID);
      GM_setValue("tibo_leader_timestamp", now);
      return true;
    }
    return false;
  }

  function sendHeartbeat() {
    // Only the leader tab sends heartbeats
    if (!tryAcquireLeaderLock()) {
      return;
    }

    const secret = GM_getValue("webhook_secret", "");
    if (!secret) return;

    const payload = {
      sessionId,
      lastSuccessfulParseAt,
      lastSeenTweetId,
      lastScanError,
      selectorVersion: SELECTOR_VERSION,
    };

    GM_xmlhttpRequest({
      method: "POST",
      url: `${OBSERVATORY_DOMAIN}/api/webhook/tibo/heartbeat`,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
      },
      data: JSON.stringify(payload),
      onload: function (response) {
        if (response.status >= 200 && response.status < 300) {
          console.log("[Tibo Monitor] Heartbeat sent successfully by leader tab.");
        }
      },
      onerror: function (err) {
        console.error("[Tibo Monitor] Heartbeat failed:", err);
      },
    });
  }

  // Send initial heartbeat and schedule 5-min timer
  sendHeartbeat();
  setInterval(sendHeartbeat, 5 * 60 * 1000);

  // Maintain leader lock timestamp every 10s
  setInterval(() => {
    if (GM_getValue("tibo_leader_tab_id", "") === TAB_ID) {
      GM_setValue("tibo_leader_timestamp", Date.now());
    }
  }, 10 * 1000);

  // 3. Tweet DOM Inspector (Strict canonical permalink matching & inFlight guard)
  function scanTweets() {
    try {
      const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
      const processedIds = getProcessedIds();

      tweetArticles.forEach((article) => {
        const timeEl = article.querySelector("time");
        if (!timeEl) return;

        // Canonical permalink: Must be closest status link anchored to timeEl
        const linkEl = timeEl.closest('a[href*="/status/"]');
        const textEl = article.querySelector('div[data-testid="tweetText"]');

        if (!linkEl || !textEl) return;

        const datetime = timeEl.getAttribute("datetime");
        if (!datetime) return;

        const href = linkEl.getAttribute("href") || "";
        const match = href.match(/\/thsottiaux\/status\/(\d+)/i);

        // Strict URL check: Must belong to @thsottiaux
        if (!match) return;

        const tweetId = match[1];
        const tweetUrl = `https://x.com/thsottiaux/status/${tweetId}`;
        const text = textEl.innerText || "";
        const createdAt = new Date(datetime).toISOString();

        lastSuccessfulParseAt = new Date().toISOString();
        lastSeenTweetId = tweetId;
        lastScanError = null;

        // Skip if already processed in sliding window or currently in-flight
        if (processedIds.includes(tweetId) || inFlightTweetIds.has(tweetId)) return;

        console.log(`[Tibo Monitor] New Canonical Tweet Found (${tweetId}): ${text.substring(0, 50)}...`);

        // Add to inFlight Set and send Webhook
        inFlightTweetIds.add(tweetId);
        sendWebhook(tweetId, text, tweetUrl, createdAt);
      });
    } catch (err) {
      lastScanError = err.message || String(err);
      console.error("[Tibo Monitor] Scan error:", err);
    }
  }

  function sendWebhook(tweetId, text, tweetUrl, tweetCreatedAt) {
    const secret = GM_getValue("webhook_secret", "");
    if (!secret) {
      console.warn("[Tibo Monitor] Cannot send Webhook: Missing secret.");
      inFlightTweetIds.delete(tweetId);
      return;
    }

    const payload = { tweetId, text, tweetUrl, tweetCreatedAt };

    GM_xmlhttpRequest({
      method: "POST",
      url: `${OBSERVATORY_DOMAIN}/api/webhook/tibo`,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`,
      },
      data: JSON.stringify(payload),
      onload: function (response) {
        inFlightTweetIds.delete(tweetId); // Always clear inFlight flag on response
        if (response.status >= 200 && response.status < 300) {
          console.log(`[Tibo Monitor] Webhook Success for ${tweetId}. Saving to processed queue.`);
          markIdProcessed(tweetId);
        } else {
          console.warn(`[Tibo Monitor] Webhook rejected with HTTP ${response.status}. Will retry on next scan.`);
        }
      },
      onerror: function (err) {
        inFlightTweetIds.delete(tweetId); // Always clear inFlight flag on network error
        console.error("[Tibo Monitor] Webhook request error:", err);
      },
    });
  }

  // 4. Initial Scan & MutationObserver Integration
  scanTweets();

  const observer = new MutationObserver(() => {
    scanTweets();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 60-second fallback polling interval
  setInterval(scanTweets, 60 * 1000);

  console.log("[Tibo Monitor] Script initialized with Leader Lock & Canonical Permalink Matching.");
})();
