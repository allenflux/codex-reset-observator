import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST } from "../app/api/webhook/tibo/route";
import { TARGET_TIBO_TWEET_CREATED_AT, TARGET_TIBO_TWEET_ID, TARGET_TIBO_TWEET_TEXT, TARGET_TIBO_TWEET_URL } from "./fixtures/tiboLongFormReset";

const ENV_KEYS = [
  "TIBO_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_CLASSIFICATION_MODE",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_TRANSLATION_MODE",
  "RESET_DISPLAY_NAME_CANDIDATE_MODE",
  "RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT",
] as const;

function restoreEnvironment(previous: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function buildRequest(overrides: Record<string, unknown> = {}) {
  const body = {
    tweetId: "2084000000000000200",
    text: "I reset usage limits for Codex.",
    tweetUrl: "https://x.com/thsottiaux/status/2084000000000000200",
    tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
  return new NextRequest("http://localhost/api/webhook/tibo", {
    method: "POST",
    headers: {
      authorization: "Bearer test-webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function installGeminiClassificationMock(result: Record<string, unknown>) {
  const originalHttpsRequest = https.request;
  https.request = ((...args: any[]) => {
    const callback = args[2] as (response: EventEmitter & { statusCode?: number }) => void;
    const request = new EventEmitter() as EventEmitter & {
      write: (body: string) => boolean;
      end: () => void;
    };
    request.write = () => true;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", JSON.stringify({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify(result) }],
            },
          }],
        }));
        response.emit("end");
      });
    };
    return request;
  }) as typeof https.request;

  return () => {
    https.request = originalHttpsRequest;
  };
}

function installGeminiHttpErrorMock(statusCode = 503) {
  const originalHttpsRequest = https.request;
  https.request = ((...args: any[]) => {
    const callback = args[2] as (response: EventEmitter & { statusCode?: number }) => void;
    const request = new EventEmitter() as EventEmitter & {
      write: (body: string) => boolean;
      end: () => void;
    };
    request.write = () => true;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      response.statusCode = statusCode;
      callback(response);
      queueMicrotask(() => response.emit("end"));
    };
    return request;
  }) as typeof https.request;

  return () => {
    https.request = originalHttpsRequest;
  };
}

function installSupabaseWebhookMock(requestBodies: unknown[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const url = _input instanceof Request ? _input.url : String(_input);
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    const method = init?.method ?? "GET";
    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      const input = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const now = new Date().toISOString();
      return new Response(JSON.stringify({
        status: "claimed_new",
        record: {
          id: "00000000-0000-0000-0000-000000000001",
          logical_post_id: input.p_logical_post_id,
          logical_post_tweet_ids: input.p_logical_post_tweet_ids,
          reset_event_key: input.p_reset_event_key,
          representative_tweet_id: input.p_representative_tweet_id,
          source_tweet_ids: input.p_source_tweet_ids,
          claim_source: input.p_claim_source,
          adopted_at: input.p_adopted_at,
          claimed_at: input.p_claimed_at ?? now,
          created_at: now,
          updated_at: now,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function candidateSeedRecord(tweetId: string) {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    candidate_id: "00000000-0000-0000-0000-000000000010",
    notice_dedupe_key: `official-notice:${tweetId}`,
    official_notice_tweet_id: tweetId,
    logical_post_id: null,
    notice_tweet_ids: [tweetId],
    source_tweet_ids: [tweetId],
    source_snapshot_hash: null,
    input_hash: null,
    next_retry_at: null,
    ai_name_ja: null,
    ai_name_en: null,
    ai_name_zh: null,
    ai_confidence: null,
    ai_evidence: null,
    ai_reason: null,
    ai_flags: [],
    ai_model: null,
    ai_prompt_version: null,
    ai_input_mode: null,
    ai_status: "unprocessed",
    lifecycle_status: "provisional",
    generation_attempts: 0,
    last_generated_at: null,
    promoted_event_key: null,
    promoted_at: null,
    created_at: now,
    updated_at: now,
  };
}

function installCandidateSeedWebhookMock(
  requestBodies: unknown[],
  options: { seedError?: boolean } = {},
) {
  const originalFetch = globalThis.fetch;
  let seedWrites = 0;
  let geminiCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    if (url.includes("generativelanguage.googleapis.com")) geminiCalls += 1;
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (url.includes("/rpc/upsert_reset_display_name_candidate_seed")) {
      seedWrites += 1;
      if (options.seedError) {
        return new Response(JSON.stringify({ code: "PGRST_TEST", message: "seed unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as { p_seed?: { official_notice_tweet_id?: string } } : {};
      const tweetId = body.p_seed?.official_notice_tweet_id ?? "2084000000000000200";
      return new Response(JSON.stringify(candidateSeedRecord(tweetId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    get seedWrites() { return seedWrites; },
    get geminiCalls() { return geminiCalls; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("official notice webhook writes an identity-only candidate seed without AI work", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  process.env.RESET_DISPLAY_NAME_CANDIDATE_MODE = "seed";
  process.env.RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT = "2026-08-01T00:00:00.000Z";
  const mock = installCandidateSeedWebhookMock(requestBodies);

  try {
    const response = await POST(buildRequest({
      tweetId: "2084000000000000200",
      text: "We will reset usage limits tomorrow.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000200",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    }));

    assert.equal(response.status, 200);
    assert.equal(mock.seedWrites, 1);
    assert.equal(mock.geminiCalls, 0);
    const seedBody = requestBodies.find((body): body is { p_seed: Record<string, unknown> } =>
      typeof body === "object" && body !== null && "p_seed" in body,
    );
    assert.ok(seedBody);
    assert.deepEqual(Object.keys(seedBody.p_seed).sort(), [
      "logical_post_id",
      "notice_tweet_ids",
      "official_notice_tweet_id",
      "source_tweet_ids",
    ]);
    assert.equal("expected_end_at" in seedBody.p_seed, false);
    assert.equal("scope" in seedBody.p_seed, false);
  } finally {
    mock.restore();
    restoreEnvironment(previous);
  }
});

test("candidate seed failure does not fail official notice handling", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  process.env.RESET_DISPLAY_NAME_CANDIDATE_MODE = "full";
  process.env.RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT = "2026-08-01T00:00:00.000Z";
  const mock = installCandidateSeedWebhookMock(requestBodies, { seedError: true });

  try {
    const response = await POST(buildRequest({
      tweetId: "2084000000000000201",
      text: "We will reset usage limits tomorrow.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000201",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    }));

    assert.equal(response.status, 200);
    assert.equal(mock.seedWrites, 1);
    assert.equal(requestBodies.some((body: any) => body.tweet_id === "2084000000000000201"), true);
  } finally {
    mock.restore();
    restoreEnvironment(previous);
  }
});

test("candidate mode off and persisted tweet cutoff are fail-closed", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  try {
    process.env.RESET_DISPLAY_NAME_CANDIDATE_MODE = "off";
    process.env.RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT = "2026-08-01T00:00:00.000Z";
    const offMock = installCandidateSeedWebhookMock([]);
    const offResponse = await POST(buildRequest({
      text: "We will reset usage limits tomorrow.",
    }));
    assert.equal(offResponse.status, 200);
    assert.equal(offMock.seedWrites, 0);
    offMock.restore();

    process.env.RESET_DISPLAY_NAME_CANDIDATE_MODE = "seed";
    process.env.RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT = "2026-09-01T00:00:00.000Z";
    const cutoffMock = installCandidateSeedWebhookMock([]);
    const cutoffResponse = await POST(buildRequest({
      tweetId: "2084000000000000202",
      text: "We will reset usage limits tomorrow.",
      tweetUrl: "https://x.com/thsottiaux/status/2084000000000000202",
      tweetCreatedAt: "2026-08-04T00:00:00.000Z",
    }));
    assert.equal(cutoffResponse.status, 200);
    assert.equal(cutoffMock.seedWrites, 0);
    cutoffMock.restore();
  } finally {
    restoreEnvironment(previous);
  }
});

test("Tibo state SELECT failure fails closed before upsert or formal adoption", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const fetchMethods: string[] = [];
  const infoMessages: unknown[][] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  globalThis.fetch = async (input, init) => {
    fetchMethods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
    return new Response(JSON.stringify({ code: "PGRST_TEST", message: "lookup failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  console.info = (...args: unknown[]) => {
    infoMessages.push(args);
  };

  try {
    const response = await POST(buildRequest());
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Tibo state lookup unavailable" });
    assert.deepEqual(fetchMethods, ["GET"]);
    assert.equal(infoMessages.length, 0);
    assert.equal(JSON.stringify(body).includes("test-service-role-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    restoreEnvironment(previous);
  }
});

test("empty and whitespace-only source text are rejected before any database call", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    for (const text of ["", "   \n\t"]) {
      const response = await POST(buildRequest({ text }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid text" });
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("long-form current reset announcement is accepted by the webhook", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  globalThis.fetch = async (_input, init) => {
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    const method = init?.method ?? "GET";
    return new Response(JSON.stringify({ data: method === "GET" ? null : [], error: null }), {
      status: method === "GET" ? 200 : 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(buildRequest({
      tweetId: TARGET_TIBO_TWEET_ID,
      text: TARGET_TIBO_TWEET_TEXT,
      tweetUrl: TARGET_TIBO_TWEET_URL,
      tweetCreatedAt: TARGET_TIBO_TWEET_CREATED_AT,
    }));

    assert.notEqual(response.status, 400);
    assert.equal(response.status, 200);
    assert.equal(requestBodies.some((body: any) => body.tweet_id === TARGET_TIBO_TWEET_ID), true);
    const persistedBody = requestBodies.find(
      (body): body is { tweet_id: string; signal_type: string } =>
        typeof body === "object" &&
        body !== null &&
        "tweet_id" in body &&
        "signal_type" in body &&
        body.tweet_id === TARGET_TIBO_TWEET_ID,
    );
    assert.equal(persistedBody?.signal_type, "reset_executed");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("context-only item receipt does not persist Gemini teaser as an effective teaser", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  globalThis.fetch = async (_input, init) => {
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(JSON.stringify({ data: null, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const originalHttpsRequest = https.request;
  https.request = ((...args: any[]) => {
    const callback = args[2] as (response: EventEmitter & { statusCode?: number }) => void;
    const request = new EventEmitter() as EventEmitter & {
      write: (body: string) => boolean;
      end: () => void;
    };
    request.write = () => true;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  signalType: "teaser",
                  confidence: 0.91,
                  temporalDirection: "unclear",
                  evidenceQuote: "me receiving this very important item",
                  reasonJa: "意味深な受領投稿です。",
                  resetTypeJa: null,
                  noticeToExecution: null,
                  teaserStrength: "strong",
                  teaserStrengthConfidence: 0.9,
                  teaserStrengthEvidenceQuote: "very important item",
                  teaserStrengthReasonJa: "強い匂わせです。",
                }),
              }],
            },
          }],
        }));
        response.emit("end");
      });
    };
    return request;
  }) as typeof https.request;

  try {
    const response = await POST(buildRequest({
      tweetId: "2089999999999999999",
      text: "me receiving this very important item",
      tweetUrl: "https://x.com/thsottiaux/status/2089999999999999999",
      tweetCreatedAt: "2026-08-19T05:03:00.000Z",
      isReply: true,
      replyToHandles: ["@someone"],
      replyContextText: "haven't used it yet, but I'll take a look. Codex for scale.",
      sourceTimeline: "with_replies",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "irrelevant");
    assert.equal(upsertBody.teaser_strength, "none");
    assert.equal(upsertBody.ai_signal_type, "teaser");
    assert.equal(upsertBody.ai_teaser_strength, "strong");
    assert.match(String(upsertBody.classification_reason), /context|文脈|物品/);
    const responseBody = await response.json();
    assert.equal(responseBody.signalType, "irrelevant");
    assert.equal(responseBody.teaserStrength, "none");
  } finally {
    https.request = originalHttpsRequest;
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("physical-item showcase is persisted as irrelevant while raw Gemini teaser is retained", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "teaser",
    confidence: 0.95,
    temporalDirection: "unclear",
    evidenceQuote: "Codex for scale",
    reasonJa: "物品の展示です。",
    teaserStrength: "strong",
    teaserStrengthConfidence: 0.95,
    teaserStrengthEvidenceQuote: "Codex for scale",
    teaserStrengthReasonJa: "強い匂わせです。",
  });

  try {
    const response = await POST(buildRequest({
      tweetId: "2090116476414136830",
      text: "It has not been used yet, but would you look at that. Codex for scale.",
      tweetUrl: "https://x.com/thsottiaux/status/2090116476414136830",
      tweetCreatedAt: "2026-08-19T17:52:30.000Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "irrelevant");
    assert.equal(upsertBody.teaser_strength, "none");
    assert.equal(upsertBody.ai_signal_type, "teaser");
    assert.equal(upsertBody.ai_teaser_strength, "strong");
    assert.equal(upsertBody.expected_start_at, null);
    assert.equal(upsertBody.expected_end_at, null);
    assert.equal(upsertBody.temporal_resolution_status, null);
    const responseBody = await response.json();
    assert.equal(responseBody.signalType, "irrelevant");
    assert.equal(responseBody.teaserStrength, "none");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("ambiguous future surprise keeps teaser classification and persists its hinted day window", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "official_notice",
    confidence: 0.97,
    temporalDirection: "future",
    evidenceQuote: "Little surprise for you tomorrow",
    reasonJa: "明日の予告です。",
    teaserStrength: "strong",
    teaserStrengthConfidence: 0.95,
    teaserStrengthEvidenceQuote: "surprise",
    teaserStrengthReasonJa: "強い匂わせです。",
    temporalExpression: "tomorrow",
    temporalKind: "relative_day",
    temporalPrecision: "day",
    relativeDayOffset: 1,
    temporalConfidence: 0.95,
  });

  try {
    const response = await POST(buildRequest({
      tweetId: "2087423996115681767",
      text: "I previously promised a reset for every 1M in additional active users for Codex, until 10M. We blew past that and have been silent since 10M. Little surprise for you tomorrow.",
      tweetUrl: "https://x.com/thsottiaux/status/2087423996115681767",
      tweetCreatedAt: "2026-08-19T00:00:00.000Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "teaser");
    assert.equal(upsertBody.teaser_strength, "strong");
    assert.equal(upsertBody.ai_signal_type, "official_notice");
    assert.equal(upsertBody.ai_teaser_strength, "strong");
    assert.equal(upsertBody.ai_temporal_expression, "tomorrow");
    assert.equal(upsertBody.temporal_expression, "tomorrow");
    assert.equal(upsertBody.temporal_kind, "relative_day");
    assert.equal(upsertBody.temporal_precision, "day");
    assert.equal(upsertBody.temporal_timezone, "America/Los_Angeles");
    assert.equal(upsertBody.expected_start_at, "2026-08-19T07:00:00.000Z");
    assert.equal(upsertBody.expected_end_at, "2026-08-20T07:00:00.000Z");
    assert.equal(upsertBody.temporal_resolution_status, "resolved");
    const responseBody = await response.json();
    assert.equal(responseBody.signalType, "teaser");
    assert.equal(responseBody.teaserStrength, "strong");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("an upcoming Codex update remains irrelevant without a context-safety promotion", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  const text = "Tomorrow we will bring back the 5h limit for Plus accounts across ChatGPT Work and Codex.";
  const tweetId = "2093000000000000001";

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "irrelevant",
    confidence: 0.97,
    temporalDirection: "future",
    evidenceQuote: "Tomorrow we will bring back the 5h limit",
    reasonJa: "Codexの更新予告ですが、reset自体は明示されていません。",
    teaserStrength: "none",
    teaserStrengthConfidence: 0.97,
    teaserStrengthEvidenceQuote: null,
    teaserStrengthReasonJa: "resetの匂わせではありません。",
  });

  try {
    const response = await POST(buildRequest({
      tweetId,
      text,
      tweetUrl: `https://x.com/thsottiaux/status/${tweetId}`,
      tweetCreatedAt: "2026-08-27T00:00:00.000Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies.find((body) =>
      typeof body === "object" && body !== null && (body as Record<string, unknown>).tweet_id === tweetId,
    ) as Record<string, unknown> | undefined;
    assert.ok(upsertBody);
    assert.equal(upsertBody.signal_type, "irrelevant");
    assert.equal(upsertBody.teaser_strength, null);
    assert.equal(upsertBody.ai_signal_type, "irrelevant");
    assert.equal(upsertBody.ai_teaser_strength, "none");
    assert.equal(upsertBody.expected_start_at, null);
    assert.equal(upsertBody.expected_end_at, null);

    const responseBody = await response.json();
    assert.equal(responseBody.signalType, "irrelevant");
    assert.equal(responseBody.teaserStrength, "none");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("composite completion is saved as reset_executed with independent weak teaser metadata", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  const text = "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.";
  const tweetId = "2092000000000000001";

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "official_notice",
    confidence: 0.98,
    temporalDirection: "completed_now",
    evidenceQuote: "Reset has been propagated to accounts",
    reasonJa: "完了報告と別の将来示唆を含む複合投稿です。",
    teaserStrength: "weak",
    teaserStrengthConfidence: 0.9,
    teaserStrengthEvidenceQuote: "More to come tomorrow",
    futureSignal: {
      signalType: "teaser",
      teaserStrength: "weak",
      confidence: 0.9,
      evidenceQuote: "More to come tomorrow",
      reasonJa: "完了後の追加予告ですが、次回resetの具体性は弱いです。",
      temporalDirection: "future",
    },
  });

  try {
    const response = await POST(buildRequest({
      tweetId,
      text,
      tweetUrl: `https://x.com/thsottiaux/status/${tweetId}`,
      tweetCreatedAt: "2026-08-24T00:07:43.201Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies.find((body) =>
      typeof body === "object" && body !== null && (body as Record<string, unknown>).tweet_id === tweetId,
    ) as Record<string, unknown> | undefined;
    assert.ok(upsertBody);
    assert.equal(upsertBody.signal_type, "reset_executed");
    assert.equal(upsertBody.rule_signal_type, "reset_executed");
    assert.equal(upsertBody.teaser_strength, null);
    assert.equal(upsertBody.ai_teaser_strength, "weak");
    const secondarySignal = upsertBody.secondary_signal as Record<string, unknown>;
    assert.equal(secondarySignal.signalType, "teaser");
    assert.equal(secondarySignal.teaserStrength, "weak");
    assert.equal(secondarySignal.evidenceQuote, "More to come tomorrow");
    assert.equal(upsertBody.ai_temporal_direction, "completed_now");
    assert.equal(upsertBody.ai_evidence_quote, "Reset has been propagated to accounts");
    assert.equal(upsertBody.expected_start_at, null);
    assert.equal(upsertBody.temporal_resolution_status, null);

    const responseBody = await response.json();
    assert.equal(responseBody.signalType, "reset_executed");
    assert.equal(responseBody.teaserStrength, "weak");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("explicit secondary none is stored as raw AI provenance for later manual review", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  const tweetId = "2091688655828246890";
  const text = "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.";

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "reset_executed",
    confidence: 1,
    temporalDirection: "completed_now",
    evidenceQuote: "Reset has been propagated to accounts",
    reasonJa: "完了済みのresetです。",
    teaserStrength: "none",
    teaserStrengthConfidence: 1,
    teaserStrengthEvidenceQuote: null,
    futureSignal: {
      signalType: "none",
      teaserStrength: null,
      confidence: 1,
      evidenceQuote: null,
      reasonJa: "翌日の追加更新であり、次回resetの予告ではありません。",
      temporalDirection: "future",
    },
  });

  try {
    const response = await POST(buildRequest({
      tweetId,
      text,
      tweetUrl: `https://x.com/thsottiaux/status/${tweetId}`,
      tweetCreatedAt: "2026-08-23T23:37:43.201Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies.find((body) =>
      typeof body === "object" && body !== null && (body as Record<string, unknown>).tweet_id === tweetId,
    ) as Record<string, unknown> | undefined;
    assert.ok(upsertBody);
    assert.deepEqual(upsertBody.secondary_signal, {
      signalType: "none",
      teaserStrength: null,
      confidence: 1,
      evidenceQuote: null,
      reasonJa: "翌日の追加更新であり、次回resetの予告ではありません。",
      expiresAt: "2026-08-24T23:37:43.201Z",
      temporal: null,
    });
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("webhook reclassification updates secondary AI fields but preserves a manual weak override", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];
  const tweetId = "2091688655828246890";
  const text = "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage for things mentioned yesterday as issues we found. You should feel a positive difference. More to come tomorrow and will keep communicating.";
  const existingSecondary = {
    signalType: "none",
    teaserStrength: null,
    confidence: 1,
    evidenceQuote: null,
    reasonJa: "AIは一般的な追加更新と判定しました。",
    manualOverride: {
      source: "manual",
      signalType: "teaser",
      teaserStrength: "weak",
      reasonJa: "手動確認: 完了済みreset後の次回resetを弱く示唆するsecondary teaserとして補正。",
      reviewedAt: "2026-08-24T10:00:00.000Z",
    },
  };

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreGemini = installGeminiClassificationMock({
    signalType: "reset_executed",
    confidence: 0.98,
    temporalDirection: "completed_now",
    evidenceQuote: "Reset has been propagated to accounts",
    reasonJa: "完了済みのresetです。",
    teaserStrength: "none",
    teaserStrengthConfidence: 1,
    teaserStrengthEvidenceQuote: null,
    futureSignal: {
      signalType: "teaser",
      teaserStrength: "strong",
      confidence: 0.95,
      evidenceQuote: "More to come tomorrow",
      reasonJa: "次の展開を強く示唆しています。",
      temporalDirection: "future",
    },
  });
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (method === "GET" && url.includes("/tibo_signals")) {
      const signal = {
        tweet_id: tweetId,
        text,
        tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
        tweet_created_at: "2026-08-23T23:37:43.201Z",
        detected_at: "2026-08-24T00:00:00.000Z",
        expires_at: "2026-08-25T00:00:00.000Z",
        signal_type: "reset_executed",
        confidence: 0.98,
        classification_reason: "完了済みのresetです。",
        verification_status: "auto_unverified",
        classification_source: "gemini",
        teaser_strength: null,
        secondary_signal: existingSecondary,
        is_reply: false,
        reply_to_handles: null,
        reply_context_text: null,
        source_timeline: "profile",
        translated_text_ja: null,
        translated_text_zh: null,
        ai_teaser_strength: "none",
        ai_teaser_strength_confidence: 1,
        ai_teaser_strength_evidence_quote: null,
        ai_teaser_strength_reason_ja: "AIは追加更新と判定しました。",
        logical_post_id: tweetId,
        edit_history_tweet_ids: [tweetId],
        edit_version: 1,
        edit_metadata_source: "none",
      };
      return new Response(JSON.stringify(url.includes("tweet_id=in.") ? [signal] : signal), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      const input = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const now = new Date().toISOString();
      return new Response(JSON.stringify({
        status: "claimed_new",
        record: {
          id: "00000000-0000-0000-0000-000000000001",
          logical_post_id: input.p_logical_post_id,
          logical_post_tweet_ids: input.p_logical_post_tweet_ids,
          reset_event_key: input.p_reset_event_key,
          representative_tweet_id: input.p_representative_tweet_id,
          source_tweet_ids: input.p_source_tweet_ids,
          claim_source: input.p_claim_source,
          adopted_at: input.p_adopted_at,
          claimed_at: input.p_claimed_at ?? now,
          created_at: now,
          updated_at: now,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST") {
      return new Response(JSON.stringify([]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(buildRequest({
      tweetId,
      text,
      tweetUrl: `https://x.com/thsottiaux/status/${tweetId}`,
      tweetCreatedAt: "2026-08-23T23:37:43.201Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies.find((body) =>
      typeof body === "object" && body !== null && (body as Record<string, unknown>).tweet_id === tweetId,
    ) as Record<string, unknown> | undefined;
    assert.ok(upsertBody);
    const secondarySignal = upsertBody.secondary_signal as Record<string, any>;
    assert.equal(secondarySignal.signalType, "teaser");
    assert.equal(secondarySignal.teaserStrength, "strong");
    assert.equal(secondarySignal.manualOverride.teaserStrength, "weak");
    assert.equal(secondarySignal.manualOverride.source, "manual");
  } finally {
    restoreGemini();
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("source clock fallback resolves an official 14pm PST tomorrow notice when Gemini omits temporal fields", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiClassificationMock({
    signalType: "official_notice",
    confidence: 0.98,
    temporalDirection: "future",
    evidenceQuote: "Reset will land around 14pm PST tomorrow.",
    reasonJa: "明日の予告です。",
    noticeToExecution: "tomorrow around 14pm PST",
  });

  try {
    const response = await POST(buildRequest({
      tweetId: "2091412393368945027",
      text: "Reset will land around 14pm PST tomorrow.",
      tweetUrl: "https://x.com/thsottiaux/status/2091412393368945027",
      tweetCreatedAt: "2026-08-23T06:29:05.000Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "official_notice");
    assert.equal(upsertBody.ai_temporal_kind, null);
    assert.equal(upsertBody.ai_temporal_precision, null);
    assert.equal(upsertBody.ai_temporal_timezone, null);
    assert.equal(upsertBody.temporal_kind, "relative_day");
    assert.equal(upsertBody.temporal_precision, "exact_time");
    assert.equal(upsertBody.temporal_timezone, "PST");
    assert.equal(upsertBody.temporal_resolution_source, "deterministic");
    assert.equal(upsertBody.expected_start_at, "2026-08-23T22:00:00.000Z");
    assert.equal(upsertBody.expected_end_at, "2026-08-23T22:00:00.000Z");
    assert.equal(upsertBody.temporal_resolution_status, "resolved");
    assert.equal(upsertBody.temporal_resolution_version, "tibo-temporal-v4");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("official notice source fallback is used when Gemini is unavailable", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const requestBodies: unknown[] = [];
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "primary";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "off";

  const restoreFetch = installSupabaseWebhookMock(requestBodies);
  const restoreGemini = installGeminiHttpErrorMock(503);

  try {
    const response = await POST(buildRequest({
      tweetId: "2091412393368945028",
      text: "Reset scheduled tomorrow at 2pm PST.",
      tweetUrl: "https://x.com/thsottiaux/status/2091412393368945028",
      tweetCreatedAt: "2026-08-23T06:29:05.000Z",
    }));

    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.ai_classification_status, "api_error");
    assert.equal(upsertBody.ai_temporal_expression, null);
    assert.equal(upsertBody.temporal_kind, "relative_day");
    assert.equal(upsertBody.temporal_precision, "exact_time");
    assert.equal(upsertBody.temporal_timezone, "PST");
    assert.equal(upsertBody.temporal_resolution_source, "deterministic");
    assert.equal(upsertBody.expected_start_at, "2026-08-23T22:00:00.000Z");
    assert.equal(upsertBody.temporal_resolution_status, "resolved");
  } finally {
    restoreGemini();
    restoreFetch();
    restoreEnvironment(previous);
  }
});

test("new reply metadata is validated and persisted while old payload fields remain compatible", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const fetchMethods: string[] = [];
  const requestBodies: unknown[] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  globalThis.fetch = async (input, init) => {
    fetchMethods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (fetchMethods.length === 1) {
      return new Response(JSON.stringify({ data: null, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(
      buildRequest({
        isReply: true,
        replyToHandles: ["alice"],
        replyContextText: "A reset is coming soon.",
        sourceTimeline: "with_replies",
        isQuote: true,
        quoteContextText: "So what about our reset?",
        quoteTweetUrl: "https://x.com/blueemi99/status/9876543210",
        quoteAuthorHandle: "@blueemi99",
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(fetchMethods, ["GET", "POST"]);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.is_reply, true);
    assert.deepEqual(upsertBody.reply_to_handles, ["@alice"]);
    assert.equal(upsertBody.reply_context_text, "A reset is coming soon.");
    assert.equal(upsertBody.source_timeline, "with_replies");
    assert.equal(upsertBody.is_quote, true);
    assert.equal(upsertBody.quote_context_text, "So what about our reset?");
    assert.equal(upsertBody.quote_tweet_url, "https://x.com/blueemi99/status/9876543210");
    assert.equal(upsertBody.quote_author_handle, "@blueemi99");
    assert.equal(upsertBody.ai_teaser_strength, null);
    assert.equal(upsertBody.ai_teaser_strength_confidence, null);
    assert.equal(upsertBody.teaser_strength, null);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("webhook reprocessing preserves a manual final teaser state", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];
  let fetchCalls = 0;

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        tweet_id: "2089063967301730789",
        text: "Maybe",
        tweet_url: "https://x.com/thsottiaux/status/2089063967301730789",
        tweet_created_at: "2026-08-16T18:57:17.000Z",
        detected_at: "2026-08-16T19:06:58.000Z",
        expires_at: "2026-08-17T18:57:17.000Z",
        signal_type: "teaser",
        confidence: 0.95,
        classification_reason: "手動修正: 親投稿への条件付き返信としてweak teaserと確認。",
        verification_status: "confirmed",
        classification_source: "manual",
        teaser_strength: "weak",
        is_reply: true,
        reply_to_handles: ["@Ananth7e"],
        reply_context_text: "are we going to get a reset when codex crosses 20M users?",
        source_timeline: "with_replies",
        translated_text_ja: null,
        translated_text_zh: null,
        ai_signal_type: "irrelevant",
        ai_confidence: 0.95,
        ai_reason_ja: "文脈のない短い返信として判定しました。",
        ai_teaser_strength: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (fetchCalls === 2) {
      return new Response(JSON.stringify({ data: null, error: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(buildRequest({
      tweetId: "2089063967301730789",
      text: "Maybe",
      tweetUrl: "https://x.com/thsottiaux/status/2089063967301730789",
      tweetCreatedAt: "2026-08-16T18:57:17.000Z",
    }));
    assert.equal(response.status, 200);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "teaser");
    assert.equal(upsertBody.confidence, 0.95);
    assert.equal(upsertBody.classification_source, "manual");
    assert.equal(upsertBody.teaser_strength, "weak");
    assert.equal(upsertBody.is_reply, true);
    assert.deepEqual(upsertBody.reply_to_handles, ["@Ananth7e"]);
    assert.equal(upsertBody.reply_context_text, "are we going to get a reset when codex crosses 20M users?");
    assert.equal(upsertBody.expires_at, "2026-08-17T18:57:17.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("fresh Usage Monitor coverage defers an uncorroborated Tibo reset", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const requestBodies: unknown[] = [];
  const fetchMethods: string[] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  const receivedAt = Date.now();
  globalThis.fetch = async (input, init) => {
    fetchMethods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (fetchMethods.length === 1) {
      return new Response(JSON.stringify({ data: null, error: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (fetchMethods.length === 2) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: new Date(receivedAt - 30_000).toISOString(),
        received_at: new Date(receivedAt - 29_000).toISOString(),
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 32,
        window_duration_mins: 10080,
        resets_at: 1787198370,
        coverage_started_at: new Date(receivedAt - 10 * 60_000).toISOString(),
        updated_at: new Date(receivedAt - 29_000).toISOString(),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (fetchMethods.length === 3) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [], error: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(buildRequest({
      tweetCreatedAt: new Date(receivedAt - 60_000).toISOString(),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(fetchMethods, ["GET", "GET", "GET", "POST"]);
    const upsertBody = requestBodies[0] as Record<string, unknown>;
    assert.equal(upsertBody.signal_type, "irrelevant");
    assert.equal(upsertBody.rule_signal_type, "reset_executed");
    assert.equal(upsertBody.classification_reason, "Usage Monitorがfreshですが、quota recoveryが未確認のため正式resetとして保留しています。");
    const responseBody = await response.json();
    assert.equal(responseBody.formalAdoption.newlyAdopted, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});

test("automatically stores Gemini Japanese and Chinese translations without changing the webhook response", async () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  const originalFetch = globalThis.fetch;
  const fetchMethods: string[] = [];
  const requestBodies: unknown[] = [];

  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  process.env.GEMINI_TRANSLATION_MODE = "on";
  globalThis.fetch = async (input, init) => {
    fetchMethods.push(init?.method ?? (input instanceof Request ? input.method : "GET"));
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      ja: "Codexの利用上限をリセットしました。",
                      zh: "我已重置 Codex 的使用上限。",
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      const input = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const now = new Date().toISOString();
      return new Response(JSON.stringify({
        status: "claimed_new",
        record: {
          id: "00000000-0000-0000-0000-000000000001",
          logical_post_id: input.p_logical_post_id,
          logical_post_tweet_ids: input.p_logical_post_tweet_ids,
          reset_event_key: input.p_reset_event_key,
          representative_tweet_id: input.p_representative_tweet_id,
          source_tweet_ids: input.p_source_tweet_ids,
          claim_source: input.p_claim_source,
          adopted_at: input.p_adopted_at,
          claimed_at: input.p_claimed_at ?? now,
          created_at: now,
          updated_at: now,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await POST(
      buildRequest({
        text: "I reset usage limits for Codex.\nEnjoy!",
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(fetchMethods, [
      "GET", "POST", "GET", "POST", "GET", "GET", "GET", "GET",
      "POST", "GET", "GET", "GET", "GET", "POST", "POST",
    ]);
    const upsertBody = requestBodies[1] as Record<string, unknown>;
    assert.equal(upsertBody.translated_text_ja, "Codexの利用上限をリセットしました。");
    assert.equal(upsertBody.translated_text_zh, "我已重置 Codex 的使用上限。");
    const responseBody = await response.json();
    assert.equal(responseBody.success, true);
    assert.equal(responseBody.teaserStrength, null);
    assert.equal("translated_text_ja" in responseBody, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});
