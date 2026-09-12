import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

type ParsedTweet = {
  tweetId: string;
  createdAt: string;
  timestamp: number;
};

function normalizeContentScriptSource(source: string) {
  return source.replace(/\r\n?/g, "\n");
}

function readContentScriptSource() {
  return normalizeContentScriptSource(
    readFileSync("extension/tibo-monitor/content.js", "utf8"),
  );
}

function getNewestSelector() {
  const context: Record<string, unknown> = {};
  createContext(context);
  runInContext(
    readFileSync("extension/tibo-monitor/scan-utils.js", "utf8"),
    context,
  );
  return (context.TiboMonitorScan as { selectNewestParsedTweet: (current: ParsedTweet | null, candidate: Partial<ParsedTweet>) => ParsedTweet }).selectNewestParsedTweet;
}

function getScanUtilities() {
  const context: Record<string, unknown> = { URL };
  createContext(context);
  runInContext(
    readFileSync("extension/tibo-monitor/scan-utils.js", "utf8"),
    context,
  );
  return context.TiboMonitorScan as {
    getTimelineSource: (url: string) => string | null;
    isTiboStatusUrl: (url: string) => boolean;
    shouldRestoreMonitoredTimeline: (url: string, timeline: string | null) => boolean;
    createTimelineRestoreGate: (debounceMs?: number, now?: () => number) => {
      tryStart: () => boolean;
      finish: () => void;
      reset: () => void;
    };
    getTweetTextState: (article: unknown) => {
      text: string;
      needsExpansion: boolean;
      expandControl: unknown;
    };
  };
}

function makeTweetTextArticle(options: {
  text: string;
  expandLabel?: string | null;
  expandInsideText?: boolean;
  nestedExpandLabel?: string | null;
}) {
  let article: Record<string, unknown>;
  const textElement: Record<string, unknown> = {
    innerText: options.text,
    closest: () => article,
  };
  const nestedArticle: Record<string, unknown> = {};
  const expandControl: Record<string, unknown> = {
    innerText: options.expandLabel ?? "",
    getAttribute: (name: string) => name === "role" ? "button" : null,
    closest: (selector: string) => selector === '[data-testid="tweetText"]'
      ? (options.expandInsideText === false ? null : textElement)
      : article,
  };
  const nestedExpandControl: Record<string, unknown> = {
    innerText: options.nestedExpandLabel ?? "",
    getAttribute: (name: string) => name === "role" ? "button" : null,
    closest: () => nestedArticle,
  };

  article = {
    querySelectorAll: (selector: string) => {
      if (selector === '[data-testid="tweetText"]') return [textElement];
      if (selector.includes('[role="button"]') || selector === "button") {
        return [
          ...(options.expandLabel ? [expandControl] : []),
          ...(options.nestedExpandLabel ? [nestedExpandControl] : []),
        ];
      }
      return [];
    },
  };

  return { article, expandControl };
}

test("normalizes CRLF and lone CR before source inspection", () => {
  assert.equal(
    normalizeContentScriptSource("first\r\nsecond\rthird\nfourth"),
    "first\nsecond\nthird\nfourth",
  );
});

function newestInOrder(
  selector: ReturnType<typeof getNewestSelector>,
  tweets: Array<Partial<ParsedTweet>>,
) {
  return tweets.reduce<ParsedTweet | null>(
    (current, tweet) => selector(current, tweet),
    null,
  );
}

test("selects the same newest tweet regardless of DOM order", () => {
  const selectNewest = getNewestSelector();
  const tweets = [
    { tweetId: "old", createdAt: "2026-08-05T00:01:00.000Z" },
    { tweetId: "newest", createdAt: "2026-08-05T00:05:00.000Z" },
    { tweetId: "middle", createdAt: "2026-08-05T00:03:00.000Z" },
  ];

  assert.equal(newestInOrder(selectNewest, tweets)?.tweetId, "newest");
  assert.equal(newestInOrder(selectNewest, [...tweets].reverse())?.tweetId, "newest");
});

test("a newer parsed tweet is not rolled back by an older article at the end", () => {
  const selectNewest = getNewestSelector();
  const result = newestInOrder(selectNewest, [
    { tweetId: "newest", createdAt: "2026-08-05T00:05:00.000Z" },
    { tweetId: "old", createdAt: "2026-08-05T00:01:00.000Z" },
  ]);

  assert.equal(result?.tweetId, "newest");
  assert.equal(result?.createdAt, "2026-08-05T00:05:00.000Z");
});

test("processed or in-flight parsed tweets remain eligible for newest-post diagnostics", () => {
  const selectNewest = getNewestSelector();
  const result = newestInOrder(selectNewest, [
    { tweetId: "processed-newest", createdAt: "2026-08-05T00:05:00.000Z" },
    { tweetId: "in-flight", createdAt: "2026-08-05T00:04:00.000Z" },
  ]);

  assert.equal(result?.tweetId, "processed-newest");
});

test("invalid datetime candidates are ignored by the selector", () => {
  const selectNewest = getNewestSelector();
  const result = newestInOrder(selectNewest, [
    { tweetId: "invalid", createdAt: "not-a-date" },
    { tweetId: "valid", createdAt: "2026-08-05T00:02:00.000Z" },
  ]);

  assert.equal(result?.tweetId, "valid");
});

test("timeline ownership recognizes canonical pages but never status pages", () => {
  const scan = getScanUtilities();

  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux"), "profile");
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/with_replies"), "with_replies");
  assert.equal(scan.getTimelineSource("https://x.com/thsottiaux/status/123"), null);
  assert.equal(scan.isTiboStatusUrl("https://twitter.com/thsottiaux/status/123"), true);
  assert.equal(scan.isTiboStatusUrl("https://x.com/other/status/123"), false);
});

test("only the owned Tibo status page requests timeline restoration", () => {
  const scan = getScanUtilities();
  const statusUrl = "https://x.com/thsottiaux/status/123";

  assert.equal(scan.shouldRestoreMonitoredTimeline(statusUrl, "profile"), true);
  assert.equal(scan.shouldRestoreMonitoredTimeline(statusUrl, "with_replies"), true);
  assert.equal(scan.shouldRestoreMonitoredTimeline("https://x.com/other/status/123", "profile"), false);
  assert.equal(scan.shouldRestoreMonitoredTimeline("https://x.com/home", "profile"), false);
  assert.equal(scan.shouldRestoreMonitoredTimeline("https://x.com/search?q=reset", "profile"), false);
  assert.equal(scan.shouldRestoreMonitoredTimeline("https://x.com/notifications", "profile"), false);
});

test("timeline restore gate suppresses in-flight and rapid duplicate requests", () => {
  const scan = getScanUtilities();
  let now = 1000;
  const gate = scan.createTimelineRestoreGate(3000, () => now);

  assert.equal(gate.tryStart(), true);
  assert.equal(gate.tryStart(), false);
  gate.finish();
  now += 1000;
  assert.equal(gate.tryStart(), false);
  now += 2000;
  assert.equal(gate.tryStart(), true);
  gate.reset();
  assert.equal(gate.tryStart(), true);
});

test("detects an owned localized Show more control before sending tweet text", () => {
  const scan = getScanUtilities();
  const { article, expandControl } = makeTweetTextArticle({
    text: "The visible prefix ends before the reset announcement",
    expandLabel: "Show more",
  });

  const state = scan.getTweetTextState(article);

  assert.equal(state.text, "The visible prefix ends before the reset announcement");
  assert.equal(state.needsExpansion, true);
  assert.equal(state.expandControl, expandControl);
});

test("ignores a Show more control belonging to a nested article", () => {
  const scan = getScanUtilities();
  const { article } = makeTweetTextArticle({
    text: "A complete Tibo post",
    nestedExpandLabel: "Show more",
  });

  const state = scan.getTweetTextState(article);

  assert.equal(state.text, "A complete Tibo post");
  assert.equal(state.needsExpansion, false);
  assert.equal(state.expandControl, null);
});

test("ignores an ambiguous localized More control outside the tweet text", () => {
  const scan = getScanUtilities();
  const { article } = makeTweetTextArticle({
    text: "A complete Tibo post",
    expandLabel: "もっと見る",
    expandInsideText: false,
  });

  const state = scan.getTweetTextState(article);

  assert.equal(state.text, "A complete Tibo post");
  assert.equal(state.needsExpansion, false);
  assert.equal(state.expandControl, null);
});

test("content.js selects after a valid parse and before deduplication", () => {
  const source = readContentScriptSource();
  const selectionIndex = source.indexOf("TiboMonitorScan.selectNewestParsedTweet");
  const processedCheckIndex = source.indexOf("processedTweetIds.has(tweetId)");

  assert.ok(selectionIndex >= 0);
  assert.ok(processedCheckIndex > selectionIndex);
  assert.ok(selectionIndex > source.indexOf("if (translated)"));
  assert.match(source, /newestSeenTweetCreatedAt/);
});

test("content.js resolves reply metadata before deduplication and skips pending thread captures", () => {
  const source = readContentScriptSource();
  const metadataIndex = source.indexOf("TiboMonitorScan.extractReplyMetadata(article");
  const processedCheckIndex = source.indexOf("processedTweetIds.has(tweetId)");
  const inFlightIndex = source.indexOf("inFlightTweetIds.add(tweetId)");

  assert.ok(metadataIndex >= 0);
  assert.ok(processedCheckIndex > metadataIndex);
  assert.ok(inFlightIndex > metadataIndex);
  assert.match(source, /replyMetadata\?\.needsRetry === true/);
  assert.match(source, /sourceTimeline/);
});

test("content.js reads non-empty tweet text before marking a parse successful", () => {
  const source = readContentScriptSource();
  const textReadIndex = source.indexOf("const hasNonEmptyTweetText");
  const emptyGuardIndex = source.indexOf("if (!hasNonEmptyTweetText) continue;");
  const parseSuccessIndex = source.indexOf("record.isParseSuccess = true");
  const sendIndex = source.indexOf('sendWebhook(\n          tweetId');

  assert.ok(textReadIndex >= 0);
  assert.ok(emptyGuardIndex > textReadIndex);
  assert.ok(parseSuccessIndex > emptyGuardIndex);
  assert.ok(sendIndex > parseSuccessIndex);
  assert.match(source, /textLength=\$\{text\.length\}/);
});

test("content.js expands and rescans incomplete tweet text before parse success or webhook send", () => {
  const source = readContentScriptSource();
  const stateIndex = source.indexOf("TiboMonitorScan.getTweetTextState(article)");
  const expansionGuardIndex = source.indexOf("if (tweetTextState.needsExpansion)");
  const parseSuccessIndex = source.indexOf("record.isParseSuccess = true");
  const sendIndex = source.indexOf('sendWebhook(\n          tweetId');

  assert.ok(stateIndex >= 0);
  assert.ok(expansionGuardIndex > stateIndex);
  assert.ok(parseSuccessIndex > expansionGuardIndex);
  assert.ok(sendIndex > parseSuccessIndex);
  assert.match(source, /textExpansionRequestedTweetIds/);
  assert.match(source, /expandControl\.click\(\)/);
  assert.match(source, /expanded tweet rescan/);
});

test("content.js quarantines terminal webhook failures and cools down retryable failures", () => {
  const source = readContentScriptSource();

  assert.match(source, /quarantinedTweetIds/);
  assert.match(source, /authBlockedTweetIds/);
  assert.match(source, /response\?\.quarantined/);
  assert.match(source, /CLEAR_AUTH_QUARANTINE/);
  assert.match(source, /quarantineReason === "auth_blocked"/);
  assert.match(source, /response\?\.retryable/);
  assert.match(source, /RETRY_COOLDOWN_MS/);
});

test("content.js supports an explicit single-tweet retry without broad queue clearing", () => {
  const source = readContentScriptSource();

  assert.match(source, /request\?\.action === "RETRY_TWEET"/);
  assert.match(source, /processedTweetIds\.delete\(tweetId\)/);
  assert.match(source, /textExpansionRequestedTweetIds\.delete\(tweetId\)/);
  assert.match(source, /runExtensionTask\(scanTweets, "explicit tweet retry"\)/);
  assert.doesNotMatch(source, /processedTweetIds\.clear\(\)/);
});

test("content.js does not create timers after the extension context is invalidated", () => {
  const source = readContentScriptSource();

  const schedulerIndex = source.indexOf("function scheduleExtensionInterval");
  const invalidationGuardIndex = source.indexOf(
    "if (extensionContextInvalidated) return null;",
    schedulerIndex,
  );

  assert.ok(schedulerIndex >= 0);
  assert.ok(invalidationGuardIndex > schedulerIndex);
});

test("content.js does not access storage.local directly after trusted-context hardening", () => {
  const source = readContentScriptSource();

  assert.doesNotMatch(source, /chrome\.storage\.local/);
  assert.match(source, /GET_CONTENT_MONITOR_STATE/);
  assert.match(source, /SAVE_CONTENT_SCAN_DIAGNOSTIC/);
});
