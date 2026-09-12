import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST } from "../app/api/webhook/tibo/route";
import {
  resolveTiboPostEditHistory,
  type TiboEditHistoryMetadata,
} from "../lib/radar/xPostEditHistory";
import { preserveTiboWebhookState } from "../lib/radar/tiboWebhookState";

const AUTHOR_ID = "1234567890123456789";
const ORIGINAL_ID = "2094251180121854309";
const EDITED_ID = "2094252447271366730";

function apiTweetResponse(
  tweetId: string,
  editHistoryTweetIds: string[],
  username = "thsottiaux",
) {
  return {
    data: {
      id: tweetId,
      author_id: AUTHOR_ID,
      edit_history_tweet_ids: editHistoryTweetIds,
    },
    includes: {
      users: [{ id: AUTHOR_ID, username }],
    },
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assertFallback(result: TiboEditHistoryMetadata, tweetId: string) {
  assert.deepEqual(result, {
    trusted: false,
    logicalPostId: tweetId,
    editHistoryTweetIds: [tweetId],
    editVersion: 1,
    editMetadataSource: "none",
  });
}

test("an authoritative unedited X post resolves to itself as version one", async () => {
  let requestUrl = "";
  let authorization = "";
  const result = await resolveTiboPostEditHistory(ORIGINAL_ID, {
    token: "x-api-test-token",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = String(init?.headers && new Headers(init.headers).get("authorization"));
      return response(apiTweetResponse(ORIGINAL_ID, [ORIGINAL_ID]));
    },
  });

  assert.deepEqual(result, {
    trusted: true,
    logicalPostId: ORIGINAL_ID,
    editHistoryTweetIds: [ORIGINAL_ID],
    editVersion: 1,
    editMetadataSource: "x_api",
  });
  assert.match(requestUrl, /api\.x\.com\/2\/tweets\/2094251180121854309/);
  assert.match(requestUrl, /edit_history_tweet_ids/);
  assert.equal(authorization, "Bearer x-api-test-token");
});

test("an edited X post resolves to the chain root and its one-based version", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [ORIGINAL_ID, EDITED_ID])),
  });

  assert.deepEqual(result, {
    trusted: true,
    logicalPostId: ORIGINAL_ID,
    editHistoryTweetIds: [ORIGINAL_ID, EDITED_ID],
    editVersion: 2,
    editMetadataSource: "x_api",
  });
});

test("an earlier version received after an edit keeps the same chain root and version", async () => {
  const result = await resolveTiboPostEditHistory(ORIGINAL_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(ORIGINAL_ID, [ORIGINAL_ID, EDITED_ID])),
  });

  assert.deepEqual(result, {
    trusted: true,
    logicalPostId: ORIGINAL_ID,
    editHistoryTweetIds: [ORIGINAL_ID, EDITED_ID],
    editVersion: 1,
    editMetadataSource: "x_api",
  });
});

test("missing X API configuration uses a single-post untrusted identity without a request", async () => {
  let calls = 0;
  const result = await resolveTiboPostEditHistory(ORIGINAL_ID, {
    token: null,
    fetchImpl: async () => {
      calls += 1;
      return response(apiTweetResponse(ORIGINAL_ID, [ORIGINAL_ID]));
    },
  });

  assertFallback(result, ORIGINAL_ID);
  assert.equal(calls, 0);
});

test("a chain that omits the incoming ID is rejected as untrusted", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [ORIGINAL_ID])),
  });

  assertFallback(result, EDITED_ID);
});

test("duplicate IDs in an X edit chain are rejected as untrusted", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [ORIGINAL_ID, EDITED_ID, EDITED_ID])),
  });

  assertFallback(result, EDITED_ID);
});

test("an edit chain longer than six IDs is rejected as untrusted", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [
      ORIGINAL_ID,
      EDITED_ID,
      "2094252447271366731",
      "2094252447271366732",
      "2094252447271366733",
      "2094252447271366734",
      "2094252447271366735",
    ])),
  });

  assertFallback(result, EDITED_ID);
});

test("malformed IDs in an X edit chain are rejected as untrusted", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [ORIGINAL_ID, "not-a-post-id"])),
  });

  assertFallback(result, EDITED_ID);
});

test("a chain from an author other than Tibo is rejected as untrusted", async () => {
  const result = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => response(apiTweetResponse(EDITED_ID, [ORIGINAL_ID, EDITED_ID], "someone_else")),
  });

  assertFallback(result, EDITED_ID);
});

test("HTTP, JSON, and timeout failures fail closed for identity resolution", async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await resolveTiboPostEditHistory(EDITED_ID, {
      token: "x-api-test-token",
      fetchImpl: async () => response({ error: "unavailable" }, status),
    });
    assertFallback(result, EDITED_ID);
  }

  const invalidJson = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });
  assertFallback(invalidJson, EDITED_ID);

  const timeout = await resolveTiboPostEditHistory(EDITED_ID, {
    token: "x-api-test-token",
    timeoutMs: 5,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assertFallback(timeout, EDITED_ID);
});

type StoredRow = Record<string, unknown>;

const ROUTE_ENV_KEYS = [
  "TIBO_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_CLASSIFICATION_MODE",
  "GEMINI_TRANSLATION_MODE",
  "X_API_BEARER_TOKEN",
] as const;

function saveEnvironment() {
  return Object.fromEntries(
    ROUTE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string | undefined>>;
}

function restoreEnvironment(previous: Partial<Record<(typeof ROUTE_ENV_KEYS)[number], string | undefined>>) {
  for (const key of ROUTE_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function buildRequest(tweetId: string, text: string) {
  return new NextRequest("http://localhost/api/webhook/tibo", {
    method: "POST",
    headers: {
      authorization: "Bearer test-webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tweetId,
      text,
      tweetUrl: `https://x.com/thsottiaux/status/${tweetId}`,
      tweetCreatedAt: "2026-08-30T00:00:00.000Z",
    }),
  });
}

function installRouteFetchMock() {
  const originalFetch = globalThis.fetch;
  const rows = new Map<string, StoredRow>();
  const xChains = new Map<string, string[]>([
    [ORIGINAL_ID, [ORIGINAL_ID]],
    [EDITED_ID, [ORIGINAL_ID, EDITED_ID]],
  ]);

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (url.startsWith("https://api.x.com/2/tweets/")) {
      const tweetId = url.match(/\/tweets\/(\d+)/)?.[1] ?? "";
      return response(apiTweetResponse(tweetId, xChains.get(tweetId) ?? [tweetId]));
    }

    if (url.includes("/tibo_signals") && method === "GET") {
      const tweetId = decodeURIComponent(url.match(/tweet_id=eq\.([^&]+)/)?.[1] ?? "");
      return response(tweetId ? rows.get(tweetId) ?? null : []);
    }

    if (url.includes("/tibo_signals") && method !== "GET") {
      const parsed = JSON.parse(String(init?.body));
      const nextRows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of nextRows) {
        if (typeof row?.tweet_id === "string") rows.set(row.tweet_id, row);
      }
      return response({ data: nextRows, error: null }, 201);
    }

    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const aliases = Array.isArray(args.p_logical_post_tweet_ids)
        ? args.p_logical_post_tweet_ids.filter((value): value is string => typeof value === "string")
        : [EDITED_ID];
      const now = new Date().toISOString();
      return response({
        status: "claimed_new",
        record: {
          id: "00000000-0000-4000-8000-000000000001",
          logical_post_id: String(args.p_logical_post_id ?? EDITED_ID),
          logical_post_tweet_ids: aliases,
          reset_event_key: String(args.p_reset_event_key ?? `tibo-reset-${EDITED_ID}`),
          representative_tweet_id: String(args.p_representative_tweet_id ?? EDITED_ID),
          source_tweet_ids: Array.isArray(args.p_source_tweet_ids)
            ? args.p_source_tweet_ids
            : [EDITED_ID],
          claim_source: "new_adoption",
          adopted_at: now,
          claimed_at: now,
          created_at: now,
          updated_at: now,
        },
      });
    }

    if (method === "GET") return response([]);
    return response({ data: null, error: null });
  };

  return { rows, restore: () => { globalThis.fetch = originalFetch; } };
}

test("the webhook keeps original and edited versions as separate raw rows", async () => {
  const previous = saveEnvironment();
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  process.env.X_API_BEARER_TOKEN = "x-api-test-token";
  const mock = installRouteFetchMock();

  try {
    const originalResponse = await POST(buildRequest(ORIGINAL_ID, "I reset usage limits for Codex."));
    const editedResponse = await POST(buildRequest(EDITED_ID, "I reset usage limits for Codex. See you soon."));

    assert.equal(originalResponse.status, 200);
    assert.equal(editedResponse.status, 200);
    assert.equal(mock.rows.size, 2);
    assert.equal(mock.rows.get(ORIGINAL_ID)?.tweet_id, ORIGINAL_ID);
    assert.equal(mock.rows.get(EDITED_ID)?.tweet_id, EDITED_ID);
    assert.equal(mock.rows.get(ORIGINAL_ID)?.logical_post_id, ORIGINAL_ID);
    assert.equal(mock.rows.get(EDITED_ID)?.logical_post_id, ORIGINAL_ID);
    assert.deepEqual(mock.rows.get(EDITED_ID)?.edit_history_tweet_ids, [ORIGINAL_ID, EDITED_ID]);
    assert.equal(mock.rows.get(EDITED_ID)?.edit_version, 2);
    assert.equal(mock.rows.get(EDITED_ID)?.edit_metadata_source, "x_api");
  } finally {
    mock.restore();
    restoreEnvironment(previous);
  }
});

test("X API identity failure does not block normal webhook classification", async () => {
  const previous = saveEnvironment();
  const originalFetch = globalThis.fetch;
  let upsertBody: StoredRow | null = null;
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  process.env.X_API_BEARER_TOKEN = "x-api-test-token";
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.startsWith("https://api.x.com/2/tweets/")) return response({}, 429);
    if (url.includes("/tibo_signals") && method === "GET") {
      const tweetId = decodeURIComponent(url.match(/tweet_id=eq\.([^&]+)/)?.[1] ?? "");
      return response(tweetId ? null : []);
    }
    if (url.includes("/tibo_signals") && method !== "GET") {
      upsertBody = JSON.parse(String(init?.body)) as StoredRow;
      return response({ data: [], error: null }, 201);
    }
    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const aliases = Array.isArray(args.p_logical_post_tweet_ids)
        ? args.p_logical_post_tweet_ids.filter((value): value is string => typeof value === "string")
        : [EDITED_ID];
      const now = new Date().toISOString();
      return response({
        status: "claimed_new",
        record: {
          id: "00000000-0000-4000-8000-000000000002",
          logical_post_id: String(args.p_logical_post_id ?? EDITED_ID),
          logical_post_tweet_ids: aliases,
          reset_event_key: String(args.p_reset_event_key ?? `tibo-reset-${EDITED_ID}`),
          representative_tweet_id: String(args.p_representative_tweet_id ?? EDITED_ID),
          source_tweet_ids: Array.isArray(args.p_source_tweet_ids)
            ? args.p_source_tweet_ids
            : [EDITED_ID],
          claim_source: "new_adoption",
          adopted_at: now,
          claimed_at: now,
          created_at: now,
          updated_at: now,
        },
      });
    }
    if (method === "GET") return response([]);
    return response({ data: null, error: null });
  };

  try {
    const result = await POST(buildRequest(EDITED_ID, "I reset usage limits for Codex."));
    assert.equal(result.status, 200);
    assert.ok(upsertBody);
    const persistedBody = upsertBody as StoredRow;
    assert.equal(persistedBody.logical_post_id, EDITED_ID);
    assert.deepEqual(persistedBody.edit_history_tweet_ids, [EDITED_ID]);
    assert.equal(persistedBody.edit_version, 1);
    assert.equal(persistedBody.edit_metadata_source, "none");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("identity metadata does not overwrite an existing manual classification", () => {
  const result = preserveTiboWebhookState({
    detected_at: "2026-08-30T00:00:00.000Z",
    verification_status: "auto_unverified" as const,
    signal_type: "reset_executed",
    confidence: 0.99,
    classification_reason: "automatic reclassification",
    classification_source: "rule",
    logical_post_id: ORIGINAL_ID,
    edit_history_tweet_ids: [ORIGINAL_ID, EDITED_ID],
    edit_version: 2,
    edit_metadata_source: "x_api",
  }, {
    detected_at: "2026-08-29T20:45:00.000Z",
    verification_status: "confirmed",
    signal_type: "teaser",
    confidence: 0.95,
    classification_reason: "manual correction",
    classification_source: "manual",
    teaser_strength: "strong",
  }, "2026-08-30T00:01:00.000Z");

  assert.equal(result.signal_type, "teaser");
  assert.equal(result.classification_reason, "manual correction");
  assert.equal(result.classification_source, "manual");
  assert.equal(result.logical_post_id, ORIGINAL_ID);
  assert.deepEqual(result.edit_history_tweet_ids, [ORIGINAL_ID, EDITED_ID]);
  assert.equal(result.edit_version, 2);
  assert.equal(result.edit_metadata_source, "x_api");
});

test("the resolver module has no public environment-token name", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(process.cwd(), "lib", "radar", "xPostEditHistory.ts"),
    "utf8",
  ) as string;

  assert.match(source, /X_API_BEARER_TOKEN/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_X_API_BEARER_TOKEN/);
});
