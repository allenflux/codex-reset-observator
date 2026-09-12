import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type Diagnostics = {
  MAX_ENTRIES: number;
  MAX_TOTAL_CHARS: number;
  DEDUP_WINDOW_MS: number;
  buildScanSummary: (
    records: ReadonlyArray<{
      hasTime?: boolean;
      hasTweetText?: boolean;
      hasNonEmptyTweetText?: boolean;
      hasMatchingTiboStatus?: boolean;
      hasValidDatetime?: boolean;
      isTranslated?: boolean;
      isParseSuccess?: boolean;
    }>,
    currentUrl: string,
    selectorVersion: string,
    scanTimestamp: string,
    sourceTimeline?: "profile" | "with_replies",
  ) => Record<string, unknown>;
  getScanFailureReason: (summary: Record<string, unknown>) => string | null;
  sanitizeDiagnosticText: (value: unknown, maxChars?: number) => string;
  sanitizeSnapshotHtml: (
    html: string,
    options?: { maskPostText?: boolean; maxChars?: number },
  ) => string;
  trimDiagnosticLogs: (logs: unknown[]) => unknown[];
  appendDiagnosticLog: (
    storage: StorageLike,
    entry: Record<string, unknown>,
    now?: string,
  ) => Promise<void>;
  markSuccessfulScan: (storage: StorageLike, now?: string) => Promise<void>;
  getDiagnosticLogs: (storage: StorageLike) => Promise<unknown[]>;
  clearDiagnosticLogs: (storage: StorageLike) => Promise<void>;
  serializeDiagnosticLogs: (logs: unknown[]) => string;
  getDiagnosticFingerprint: (entry: Record<string, unknown>) => string;
};

type StorageLike = {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (value: Record<string, unknown>) => Promise<void>;
};

function loadDiagnostics(): Diagnostics {
  const code = fs.readFileSync(
    path.join(process.cwd(), "extension/tibo-monitor/diagnostics.js"),
    "utf8",
  );
  const context = vm.createContext({ console, Date, JSON, URL });
  vm.runInContext(code, context);
  return (context as typeof context & { TiboDiagnostics: Diagnostics }).TiboDiagnostics;
}

function createStorage(): StorageLike & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(value) {
      Object.assign(values, value);
    },
  };
}

function createFailureEntry(reasonCode = "article_missing") {
  return {
    reasonCode,
    currentUrl: "https://x.com/thsottiaux",
    selectorVersion: "v1.5-diagnostics",
    summary: {
      articleCount: 0,
      timeElementCount: 0,
      tweetTextCount: 0,
      matchingTiboStatusCount: 0,
      translatedTweetCount: 0,
      currentUrl: "https://x.com/thsottiaux",
      selectorVersion: "v1.5-diagnostics",
    },
  };
}

test("summarizes empty, incomplete, mismatched, translated, and successful scans", () => {
  const diagnostics = loadDiagnostics();
  const timestamp = "2026-08-02T00:00:00.000Z";

  const cases = [
    {
      records: [],
      reason: "article_missing",
      expected: { articleCount: 0, timeElementCount: 0, tweetTextCount: 0 },
    },
    {
      records: [{ hasTime: false, hasTweetText: true, hasMatchingTiboStatus: true }],
      reason: "time_element_missing",
      expected: { articleCount: 1, timeElementCount: 0, tweetTextCount: 1 },
    },
    {
      records: [{ hasTime: true, hasTweetText: false, hasMatchingTiboStatus: true }],
      reason: "tweet_text_missing",
      expected: { articleCount: 1, timeElementCount: 1, tweetTextCount: 0 },
    },
    {
      records: [{ hasTime: true, hasTweetText: true, hasMatchingTiboStatus: false }],
      reason: "tibo_status_url_missing",
      expected: { articleCount: 1, matchingTiboStatusCount: 0 },
    },
    {
      records: [
        {
          hasTime: true,
          hasTweetText: true,
          hasMatchingTiboStatus: true,
          isTranslated: true,
        },
      ],
      reason: "translated_text_detected",
      expected: { translatedTweetCount: 1 },
    },
  ] as const;

  for (const item of cases) {
    const summary = diagnostics.buildScanSummary(
      item.records,
      "https://x.com/thsottiaux",
      "v1.5-diagnostics",
      timestamp,
    );
    assert.equal(diagnostics.getScanFailureReason(summary), item.reason);
    for (const [key, value] of Object.entries(item.expected)) {
      assert.equal(summary[key], value, `${item.reason}: ${key}`);
    }
  }

  const successful = diagnostics.buildScanSummary(
    [
      {
        hasTime: true,
        hasTweetText: true,
        hasMatchingTiboStatus: true,
        isParseSuccess: true,
      },
    ],
    "https://x.com/thsottiaux",
    "v1.5-diagnostics",
    timestamp,
  );
  assert.equal(successful.parseSuccessCount, 1);
  assert.equal(diagnostics.getScanFailureReason(successful), null);
});

test("does not treat an empty tweetText element as a successful parse", () => {
  const diagnostics = loadDiagnostics();
  const summary = diagnostics.buildScanSummary(
    [
      {
        hasTime: true,
        hasTweetText: true,
        hasNonEmptyTweetText: false,
        hasMatchingTiboStatus: true,
        hasValidDatetime: true,
      },
    ],
    "https://x.com/thsottiaux",
    "v1.8-thread-replies",
    "2026-08-17T00:00:00.000Z",
  );

  assert.equal(summary.tweetTextCount, 1);
  assert.equal(summary.nonEmptyTweetTextCount, 0);
  assert.equal(summary.parseSuccessCount, 0);
  assert.equal(diagnostics.getScanFailureReason(summary), "tweet_text_empty");
});

test("diagnostic summaries distinguish profile and with-replies timelines", () => {
  const diagnostics = loadDiagnostics();
  const profile = diagnostics.buildScanSummary(
    [],
    "https://x.com/thsottiaux",
    "v1.5-diagnostics",
    "2026-08-02T00:00:00.000Z",
    "profile",
  );
  const replies = diagnostics.buildScanSummary(
    [],
    "https://x.com/thsottiaux/with_replies",
    "v1.5-diagnostics",
    "2026-08-02T00:00:00.000Z",
    "with_replies",
  );

  assert.equal(profile.sourceTimeline, "profile");
  assert.equal(replies.sourceTimeline, "with_replies");
  assert.notEqual(
    diagnostics.getDiagnosticFingerprint({ summary: profile, reasonCode: "article_missing" }),
    diagnostics.getDiagnosticFingerprint({ summary: replies, reasonCode: "article_missing" }),
  );
});

test("sanitizes DOM snapshots, URLs, secrets, and applies the character limit", () => {
  const diagnostics = loadDiagnostics();
  const html = [
    '<article data-testid="tweet">',
    '<script>Authorization: Bearer should-not-remain</script>',
    '<style>.secret { display: none }</style>',
    '<svg><text>svg</text></svg>',
    '<img src="data:image/png;base64,secret">',
    '<iframe src="https://example.test/frame"></iframe>',
    '<div data-testid="User-Name">Tibo</div>',
    '<div data-testid="tweetText">Private post body</div>',
    '<input value="private-input">',
    '<a href="blob:https://x.com/private">link</a>',
    '</article>',
  ].join("");

  const sanitized = diagnostics.sanitizeSnapshotHtml(html, {
    maskPostText: true,
    maxChars: 500,
  });

  assert.ok(sanitized.length <= 500);
  assert.doesNotMatch(sanitized, /<script|<style|<svg|<img|<iframe/i);
  assert.doesNotMatch(sanitized, /should-not-remain|base64,secret|private-input/i);
  assert.doesNotMatch(sanitized, /Private post body|>Tibo</i);
  assert.match(sanitized, /POST_TEXT_MASKED|DISPLAY_NAME_MASKED/);
  assert.match(
    diagnostics.sanitizeDiagnosticText(
      "Authorization: Bearer secret-token api_key=private-key",
    ),
    /\[REDACTED\]/,
  );
});

test("keeps diagnostic logs in a bounded ring buffer and supports export/delete", async () => {
  const diagnostics = loadDiagnostics();
  const storage = createStorage();

  for (let index = 0; index < diagnostics.MAX_ENTRIES + 3; index += 1) {
    await diagnostics.appendDiagnosticLog(storage, {
      reasonCode: "article_missing",
      sequence: index,
      summary: {
        articleCount: index,
        currentUrl: "https://x.com/thsottiaux",
        selectorVersion: "v1.5-diagnostics",
      },
      savedAt: `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }

  const logs = await diagnostics.getDiagnosticLogs(storage);
  assert.equal(logs.length, diagnostics.MAX_ENTRIES);
  assert.equal((logs[0] as { sequence: number }).sequence, 3);
  assert.ok(diagnostics.serializeDiagnosticLogs(logs).startsWith("["));

  await diagnostics.appendDiagnosticLog(storage, {
    reasonCode: "webhook_http_error",
    responseBody: "Authorization: Bearer secret-token",
  });
  const latest = await diagnostics.getDiagnosticLogs(storage);
  assert.doesNotMatch(JSON.stringify(latest), /secret-token/);

  await diagnostics.clearDiagnosticLogs(storage);
  assert.equal((await diagnostics.getDiagnosticLogs(storage)).length, 0);
});

test("evicts oversized diagnostic entries as well as entries over the count limit", () => {
  const diagnostics = loadDiagnostics();
  const hugeEntry = { sequence: 1, message: "x".repeat(diagnostics.MAX_TOTAL_CHARS) };
  const trimmed = diagnostics.trimDiagnosticLogs([hugeEntry, { sequence: 2 }]);
  assert.ok(trimmed.length <= 1);
  assert.equal((trimmed[0] as { sequence: number }).sequence, 2);
});

test("coalesces ten identical failures into one log and counts every occurrence", async () => {
  const diagnostics = loadDiagnostics();
  const storage = createStorage();

  for (let index = 0; index < 10; index += 1) {
    await diagnostics.appendDiagnosticLog(
      storage,
      createFailureEntry(),
      `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    );
  }

  const logs = (await diagnostics.getDiagnosticLogs(storage)) as Array<{
    occurrenceCount: number;
    savedAt: string;
    lastOccurredAt: string;
  }>;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].occurrenceCount, 10);
  assert.equal(logs[0].savedAt, "2026-08-02T00:00:00.000Z");
  assert.equal(logs[0].lastOccurredAt, "2026-08-02T00:00:09.000Z");
});

test("saves a new log when the deduplication window reaches thirty seconds", async () => {
  const diagnostics = loadDiagnostics();
  const storage = createStorage();

  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry(),
    "2026-08-02T00:00:00.000Z",
  );
  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry(),
    "2026-08-02T00:00:30.000Z",
  );

  const logs = await diagnostics.getDiagnosticLogs(storage);
  assert.equal(logs.length, 2);
});

test("saves a new failure after a successful parse resets deduplication", async () => {
  const diagnostics = loadDiagnostics();
  const storage = createStorage();

  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry(),
    "2026-08-02T00:00:00.000Z",
  );
  await diagnostics.markSuccessfulScan(storage, "2026-08-02T00:00:01.000Z");
  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry(),
    "2026-08-02T00:00:02.000Z",
  );

  const logs = await diagnostics.getDiagnosticLogs(storage);
  assert.equal(logs.length, 2);
});

test("saves a separate log when the failure reason changes", async () => {
  const diagnostics = loadDiagnostics();
  const storage = createStorage();

  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry("article_missing"),
    "2026-08-02T00:00:00.000Z",
  );
  await diagnostics.appendDiagnosticLog(
    storage,
    createFailureEntry("time_element_missing"),
    "2026-08-02T00:00:01.000Z",
  );

  const logs = await diagnostics.getDiagnosticLogs(storage);
  assert.equal(logs.length, 2);
});
