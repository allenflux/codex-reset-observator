import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST } from "../app/api/webhook/tibo/route";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import type { RadarData } from "../lib/radar/types";

const A = "2095000000000000001";
const B = "2095000000000000002";

const ENV_KEYS = [
  "TIBO_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GEMINI_CLASSIFICATION_MODE",
  "GEMINI_API_KEY",
  "GEMINI_TRANSLATION_MODE",
  "X_API_BEARER_TOKEN",
] as const;

type StoredRow = Record<string, any>;

type WebhookState = {
  signals: Map<string, StoredRow>;
  ledgers: StoredRow[];
  estimates: StoredRow[];
  recoveries: StoredRow[];
  calls: Array<{ method: string; url: string; body: StoredRow | null }>;
  xApiChain?: string[];
  rpcError?: unknown;
  rpcResult?: unknown;
  estimateError?: unknown;
  geminiApiError?: boolean;
  geminiNameResult?: {
    nameJa: string | null;
    nameEn: string | null;
    nameZh: string | null;
    reason: string;
  };
};

function rememberEnvironment() {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
}

function restoreEnvironment(previous: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/webhook/tibo", {
    method: "POST",
    headers: {
      authorization: "Bearer test-webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tweetId: A,
      text: "We have reset usage limits for all paid users.",
      tweetUrl: `https://x.com/thsottiaux/status/${A}`,
      tweetCreatedAt: "2026-08-31T00:00:00.000Z",
      ...overrides,
    }),
  });
}

function signal(
  tweetId: string,
  overrides: StoredRow = {},
): StoredRow {
  return {
    tweet_id: tweetId,
    text: "We have reset usage limits for all paid users.",
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: "2026-08-31T00:00:00.000Z",
    detected_at: "2026-08-31T00:01:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.99,
    classification_reason: "confirmed usage reset",
    classification_source: "rule",
    verification_status: "auto_unverified",
    teaser_strength: null,
    secondary_signal: null,
    is_reply: false,
    reply_to_handles: null,
    reply_context_text: null,
    source_timeline: "profile",
    translated_text_ja: null,
    translated_text_zh: null,
    logical_post_id: tweetId,
    edit_history_tweet_ids: [tweetId],
    edit_version: 1,
    edit_metadata_source: "none",
    ...overrides,
  };
}

function createState(overrides: Partial<WebhookState> = {}): WebhookState {
  return {
    signals: new Map(),
    ledgers: [],
    estimates: [],
    recoveries: [],
    calls: [],
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readBody(init?: RequestInit) {
  return init?.body ? JSON.parse(String(init.body)) as StoredRow : null;
}

function hasWriteTo(state: WebhookState, path: string) {
  return state.calls.some((call) => call.method !== "GET" && call.url.includes(path));
}

function assertNoFormalEnrichmentWrites(state: WebhookState) {
  assert.equal(hasWriteTo(state, "codex_recovery_observations"), false);
  assert.equal(hasWriteTo(state, "reset_execution_estimates"), false);
  assert.equal(hasWriteTo(state, "reset_display_names"), false);
  assert.equal(hasWriteTo(state, "generativelanguage.googleapis.com"), false);
}

function getIdsFromFilter(value: string | null) {
  if (!value?.startsWith("in.(") || !value.endsWith(")")) return [];
  return value.slice(4, -1).split(",").filter(Boolean);
}

function makeLedger(args: StoredRow, id = "adoption-1") {
  const now = "2026-08-31T00:02:00.000Z";
  return {
    id,
    logical_post_id: args.p_logical_post_id,
    logical_post_tweet_ids: [...args.p_logical_post_tweet_ids],
    reset_event_key: args.p_reset_event_key,
    representative_tweet_id: args.p_representative_tweet_id,
    source_tweet_ids: [...args.p_source_tweet_ids],
    claim_source: args.p_claim_source,
    adopted_at: args.p_adopted_at ?? null,
    claimed_at: args.p_claimed_at ?? now,
    created_at: now,
    updated_at: now,
  };
}

function selfLedger(tweetId: string, id: string) {
  return makeLedger({
    p_logical_post_id: tweetId,
    p_logical_post_tweet_ids: [tweetId],
    p_reset_event_key: `tibo-reset-${tweetId}`,
    p_representative_tweet_id: tweetId,
    p_source_tweet_ids: [tweetId],
    p_claim_source: "new_adoption",
    p_adopted_at: "2026-08-31T00:02:00.000Z",
  }, id);
}

function installSupabaseAndXMock(state: WebhookState) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = readBody(init);
    state.calls.push({ method, url, body });

    if (url.startsWith("https://api.x.com/2/tweets/")) {
      if (!state.xApiChain) return jsonResponse({ error: "not configured" }, 401);
      const tweetId = url.split("/").pop()?.split("?")[0] ?? "";
      return jsonResponse({
        data: {
          id: tweetId,
          author_id: "123",
          edit_history_tweet_ids: state.xApiChain,
        },
        includes: { users: [{ id: "123", username: "thsottiaux" }] },
      });
    }

    if (url.includes("/rpc/claim_tibo_formal_adoption")) {
      if (state.rpcError) return jsonResponse(state.rpcError, 500);
      if (state.rpcResult !== undefined) return jsonResponse(state.rpcResult);
      const args = body ?? {};
      const aliases = Array.isArray(args.p_logical_post_tweet_ids)
        ? args.p_logical_post_tweet_ids as string[]
        : [];
      const existing = state.ledgers.find((ledger) =>
        ledger.reset_event_key === args.p_reset_event_key ||
        ledger.logical_post_tweet_ids.some((id: string) => aliases.includes(id)),
      );
      if (existing) {
        const incomingSources = Array.isArray(args.p_source_tweet_ids)
          ? args.p_source_tweet_ids as string[]
          : [];
        const sourceTweetIds = Array.from(new Set([
          ...(existing.source_tweet_ids ?? []),
          ...incomingSources,
        ]));
        const incomingAliases = aliases.length > existing.logical_post_tweet_ids.length
          ? aliases
          : existing.logical_post_tweet_ids;
        const changed = sourceTweetIds.length !== existing.source_tweet_ids.length ||
          incomingAliases.length !== existing.logical_post_tweet_ids.length;
        Object.assign(existing, {
          logical_post_tweet_ids: [...incomingAliases],
          source_tweet_ids: sourceTweetIds,
          updated_at: "2026-08-31T00:03:00.000Z",
        });
        return jsonResponse({
          status: changed ? "reconciled" : "existing",
          record: existing,
        });
      }
      const created = makeLedger(args, `adoption-${state.ledgers.length + 1}`);
      state.ledgers.push(created);
      return jsonResponse({
        status: args.p_claim_source === "new_adoption" ? "claimed_new" : "existing",
        record: created,
      });
    }

    const parsed = new URL(url);
    const table = parsed.pathname.split("/").pop() ?? "";

    if (table === "tibo_signals") {
      if (method === "GET") {
        const tweetFilter = parsed.searchParams.get("tweet_id");
        if (tweetFilter?.startsWith("eq.")) {
          const found = state.signals.get(tweetFilter.slice(3));
          return jsonResponse(found ?? []);
        }
        const ids = getIdsFromFilter(tweetFilter);
        const selectedRows = ids
          .map((id) => state.signals.get(id))
          .filter((row): row is StoredRow => Boolean(row));
        let rows = ids.length > 0 ? selectedRows : Array.from(state.signals.values());
        const signalFilter = parsed.searchParams.get("signal_type");
        if (signalFilter?.startsWith("eq.")) {
          rows = rows.filter((row) => row.signal_type === signalFilter.slice(3));
        }
        return jsonResponse(rows);
      }
      if (method === "PATCH") {
        const tweetFilter = parsed.searchParams.get("tweet_id");
        const tweetId = tweetFilter?.startsWith("eq.") ? tweetFilter.slice(3) : null;
        const current = tweetId ? state.signals.get(tweetId) : null;
        if (!current) return jsonResponse([]);
        Object.assign(current, body ?? {});
        return jsonResponse([{ tweet_id: tweetId }]);
      }
      if (method === "POST") {
        if (body?.tweet_id) {
          state.signals.set(body.tweet_id, {
            ...(state.signals.get(body.tweet_id) ?? {}),
            ...body,
          });
        }
        return jsonResponse([]);
      }
    }

    if (url.includes("generativelanguage.googleapis.com")) {
      if (state.geminiApiError) return jsonResponse({ error: "Gemini unavailable" }, 503);
      if (state.geminiNameResult) {
        return jsonResponse({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify(state.geminiNameResult) }],
            },
          }],
        });
      }
    }

    if (table === "tibo_formal_adoptions" && method === "GET") {
      return jsonResponse(state.ledgers);
    }

    if (table === "reset_execution_estimates") {
      if (method === "GET") {
        const eventFilter = parsed.searchParams.get("reset_event_key");
        const recoveryFilter = parsed.searchParams.get("recovery_observation_id");
        const rows = state.estimates.filter((row) =>
          (!eventFilter || row.reset_event_key === eventFilter.slice(3)) &&
          (!recoveryFilter || row.recovery_observation_id === recoveryFilter.slice(3)),
        );
        return jsonResponse(rows);
      }
      if (state.estimateError) return jsonResponse(state.estimateError, 500);
      if (method === "POST" || method === "PATCH") {
        const estimate = {
          id: "estimate-1",
          created_at: "2026-08-31T00:04:00.000Z",
          updated_at: "2026-08-31T00:04:00.000Z",
          ...(state.estimates[0] ?? {}),
          ...(body ?? {}),
        };
        state.estimates[0] = estimate;
        return jsonResponse(estimate);
      }
    }

    if (table === "codex_usage_monitor_state" && method === "GET") {
      return jsonResponse([]);
    }

    if (table === "codex_recovery_observations") {
      if (method === "GET") {
        const statusFilter = parsed.searchParams.get("status");
        const status = statusFilter?.startsWith("eq.") ? statusFilter.slice(3) : null;
        const idFilter = parsed.searchParams.get("id");
        const id = idFilter?.startsWith("eq.") ? idFilter.slice(3) : null;
        const rows = state.recoveries.filter((row) =>
          (!status || row.status === status) && (!id || row.id === id),
        );
        return jsonResponse(id ? rows[0] ?? [] : rows);
      }
      if (method === "PATCH") {
        const idFilter = parsed.searchParams.get("id");
        const id = idFilter?.startsWith("eq.") ? idFilter.slice(3) : null;
        const found = state.recoveries.find((row) => row.id === id);
        if (!found) return jsonResponse([]);
        Object.assign(found, body ?? {});
        return jsonResponse(found);
      }
    }

    return jsonResponse(method === "GET" ? [] : [], method === "POST" ? 201 : 200);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function runWebhook(
  state: WebhookState,
  overrides: Record<string, unknown> = {},
) {
  const previous = rememberEnvironment();
  process.env.TIBO_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.GEMINI_CLASSIFICATION_MODE = "off";
  process.env.GEMINI_TRANSLATION_MODE = "off";
  if (state.geminiApiError || state.geminiNameResult) process.env.GEMINI_API_KEY = "test-gemini-key";
  else delete process.env.GEMINI_API_KEY;
  if (state.xApiChain) process.env.X_API_BEARER_TOKEN = "test-x-api-token";
  else delete process.env.X_API_BEARER_TOKEN;
  const restoreFetch = installSupabaseAndXMock(state);
  try {
    return await POST(request(overrides));
  } finally {
    restoreFetch();
    restoreEnvironment(previous);
  }
}

function recovery(id: string): StoredRow {
  return {
    id,
    source_key: "local-codex-app-server",
    observed_at: "2026-08-31T00:01:30.000Z",
    previous_observed_at: "2026-08-31T00:00:30.000Z",
    previous_used_percent: 100,
    current_used_percent: 0,
    previous_resets_at: 1788000000,
    current_resets_at: 1788604800,
    cycle_hint: "unexpected",
    confidence: "strong",
    status: "observed",
    matched_tibo_tweet_id: null,
    confirmed_at: null,
    created_at: "2026-08-31T00:01:30.000Z",
    updated_at: "2026-08-31T00:01:30.000Z",
  };
}

test("brand-new Tibo completion saves the raw row before claiming its canonical event", async () => {
  const state = createState();
  const response = await runWebhook(state, { tweetId: A, tweetUrl: `https://x.com/thsottiaux/status/${A}` });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.formalAdoption.newlyAdopted, true);
  assert.equal(state.signals.get(A)?.tweet_id, A);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.ledgers[0].reset_event_key, `tibo-reset-${A}`);
  const rawSaveIndex = state.calls.findIndex((call) => call.method === "POST" && call.url.includes("/tibo_signals"));
  const claimIndex = state.calls.findIndex((call) => call.url.includes("/rpc/claim_tibo_formal_adoption"));
  assert.ok(rawSaveIndex >= 0 && claimIndex > rawSaveIndex);
});

test("same self identity retries as existing without another new adoption", async () => {
  const state = createState();
  const first = await runWebhook(state, { tweetId: A, tweetUrl: `https://x.com/thsottiaux/status/${A}` });
  const second = await runWebhook(state, { tweetId: A, tweetUrl: `https://x.com/thsottiaux/status/${A}` });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).formalAdoption.newlyAdopted, true);
  assert.equal((await second.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 1);
});

test("trusted edit chain claims the authoritative root while retaining every alias", async () => {
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([[A, signal(A, { signal_type: "irrelevant" })]]),
  });
  const response = await runWebhook(state, {
    tweetId: B,
    text: "We have reset usage limits for all paid users. More details soon.",
    tweetUrl: `https://x.com/thsottiaux/status/${B}`,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.formalAdoption.newlyAdopted, true);
  assert.equal(state.ledgers[0].logical_post_id, A);
  assert.deepEqual(state.ledgers[0].logical_post_tweet_ids, [A, B]);
  const claim = state.calls.find((call) => call.url.includes("/rpc/claim_tibo_formal_adoption"));
  assert.deepEqual(claim?.body?.p_logical_post_tweet_ids, [A, B]);
  assert.equal(state.signals.get(A)?.edit_metadata_source, "x_api");
  assert.equal(state.signals.get(B)?.edit_metadata_source, "x_api");
});

test("a non-formal edit preserves an existing formal event without a new adoption", async () => {
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([[A, signal(A)]]),
  });
  const response = await runWebhook(state, {
    tweetId: B,
    text: "No reset discussion.",
    tweetUrl: `https://x.com/thsottiaux/status/${B}`,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.ledgers[0].reset_event_key, `tibo-reset-${A}`);
  assert.deepEqual(state.ledgers[0].logical_post_tweet_ids, [A, B]);
  assert.equal(state.estimates.length, 0);
  assert.equal(state.signals.get(A)?.signal_type, "reset_executed");
  assert.equal(state.signals.get(B)?.signal_type, "irrelevant");
});

test("a conflicting trusted chain saves the raw post but cannot fall back to a formal self claim", async () => {
  const conflictingMember = "2095000000000000003";
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([[A, signal(A, {
      logical_post_id: A,
      edit_history_tweet_ids: [A, conflictingMember],
      edit_version: 1,
      edit_metadata_source: "x_api",
    })]]),
  });

  const response = await runWebhook(state, {
    tweetId: B,
    tweetUrl: `https://x.com/thsottiaux/status/${B}`,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.formalAdoption.newlyAdopted, false);
  assert.equal(state.signals.get(B)?.tweet_id, B);
  assert.equal(state.signals.get(B)?.edit_metadata_source, "none");
  assert.equal(state.ledgers.length, 0);
  assert.equal(state.calls.some((call) => call.url.includes("/rpc/claim_tibo_formal_adoption")), false);
  assertNoFormalEnrichmentWrites(state);
});

test("manual conflict in an edited chain skips adoption and preserves both raw classifications", async () => {
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([
      [A, signal(A, { classification_source: "manual", verification_status: "confirmed" })],
      [B, signal(B, {
        signal_type: "irrelevant",
        classification_source: "manual",
        classification_reason: "manual irrelevant",
        verification_status: "confirmed",
      })],
    ]),
  });
  const response = await runWebhook(state, {
    tweetId: B,
    tweetUrl: `https://x.com/thsottiaux/status/${B}`,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.calls.some((call) => call.url.includes("/rpc/claim_tibo_formal_adoption")), false);
  assert.equal(state.signals.get(A)?.signal_type, "reset_executed");
  assert.equal(state.signals.get(A)?.classification_source, "manual");
  assert.equal(state.signals.get(B)?.signal_type, "irrelevant");
  assert.equal(state.signals.get(B)?.classification_source, "manual");
  assertNoFormalEnrichmentWrites(state);
});

test("missing authoritative edit tail saves the raw version but creates no formal claim", async () => {
  const state = createState({ xApiChain: [A, B] });
  const response = await runWebhook(state, {
    tweetId: A,
    tweetUrl: `https://x.com/thsottiaux/status/${A}`,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.signals.get(A)?.tweet_id, A);
  assert.equal(state.ledgers.length, 0);
  assertNoFormalEnrichmentWrites(state);
});

test("ambiguous existing ledger claims skip every formal enrichment side effect", async () => {
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([[A, signal(A, { signal_type: "irrelevant" })]]),
    ledgers: [selfLedger(A, "ledger-A"), selfLedger(B, "ledger-B")],
  });

  const response = await runWebhook(state, { tweetId: B });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 2);
  assertNoFormalEnrichmentWrites(state);
});

test("non-root canonical evidence fails closed without changing existing claims", async () => {
  const state = createState({
    xApiChain: [A, B],
    signals: new Map([[A, signal(A, { signal_type: "irrelevant" })]]),
    ledgers: [selfLedger(A, "ledger-A"), selfLedger(B, "ledger-B")],
    estimates: [{
      id: "estimate-B",
      reset_event_key: `tibo-reset-${B}`,
      display_execution_at: "2026-08-31T00:10:00.000Z",
      tibo_source_tweet_ids: [B],
    }],
  });

  const response = await runWebhook(state, { tweetId: B });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.deepEqual(state.ledgers.map((ledger) => ledger.reset_event_key), [
    `tibo-reset-${A}`,
    `tibo-reset-${B}`,
  ]);
  assertNoFormalEnrichmentWrites(state);
});

test("a ledger RPC conflict is not followed by recovery, estimate, or naming work", async () => {
  const state = createState({
    rpcResult: {
      status: "conflict",
      reason: "ambiguous_existing_claims",
      record: selfLedger(A, "ledger-conflict"),
    },
  });

  const response = await runWebhook(state, { tweetId: A });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 0);
  assert.equal(
    state.calls.filter((call) => call.url.includes("/rpc/claim_tibo_formal_adoption")).length,
    1,
  );
  assertNoFormalEnrichmentWrites(state);
});

test("existing estimate lazy bootstrap is not a new adoption and stores no adoption time", async () => {
  const existingEventKey = "usage-reset-existing-estimate";
  const state = createState({
    estimates: [{
      id: "estimate-existing",
      reset_event_key: existingEventKey,
      display_execution_at: "2026-08-31T00:10:00.000Z",
      execution_time_source: "usage_observation",
      execution_time_confidence: "high",
      execution_time_precision: "approximate",
      execution_window_start_at: "2026-08-31T00:09:00.000Z",
      execution_window_end_at: "2026-08-31T00:10:00.000Z",
      recovery_observation_id: null,
      recovery_previous_observed_at: null,
      recovery_observed_at: null,
      tibo_announced_at: "2026-08-31T00:00:00.000Z",
      tibo_primary_tweet_id: A,
      tibo_source_tweet_ids: [A],
      official_notice_tweet_id: null,
      official_notice_at: null,
      estimator_version: "usage-execution-v1",
      manual_override_at: null,
      manual_override_by: null,
      manual_override_reason: null,
      manual_execution_at: null,
      manual_execution_precision: null,
      created_at: "2026-08-31T00:10:00.000Z",
      updated_at: "2026-08-31T00:10:00.000Z",
    }],
  });

  const response = await runWebhook(state, { tweetId: A });
  const claim = state.calls.find((call) => call.url.includes("/rpc/claim_tibo_formal_adoption"));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(claim?.body?.p_claim_source, "existing_estimate");
  assert.equal(claim?.body?.p_adopted_at, null);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.ledgers[0].adopted_at, null);
  assert.equal(state.estimates.length, 1);
  assertNoFormalEnrichmentWrites(state);
});

test("trusted independent posts inside five minutes receive separate ledger claims", async () => {
  const state = createState({ xApiChain: [A] });
  const first = await runWebhook(state, { tweetId: A });
  state.xApiChain = [B];
  const second = await runWebhook(state, { tweetId: B });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).formalAdoption.newlyAdopted, true);
  assert.equal((await second.json()).formalAdoption.newlyAdopted, true);
  assert.deepEqual(state.ledgers.map((ledger) => ledger.reset_event_key), [
    `tibo-reset-${A}`,
    `tibo-reset-${B}`,
  ]);
});

test("ledger RPC failure leaves the raw signal durable and returns a retryable error", async () => {
  const state = createState({ rpcError: { code: "PGRST_LEDGER", message: "ledger unavailable" } });
  const response = await runWebhook(state, { tweetId: A, tweetUrl: `https://x.com/thsottiaux/status/${A}` });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Formal adoption flow unavailable" });
  assert.equal(state.signals.get(A)?.tweet_id, A);
  assert.equal(state.ledgers.length, 0);
  assert.equal(state.calls.some((call) => call.method !== "GET" && call.url.includes("reset_execution_estimates")), false);
  assertNoFormalEnrichmentWrites(state);
});

test("ledger RPC failure preserves an existing manual classification and trusted identity metadata", async () => {
  const state = createState({
    xApiChain: [A],
    rpcError: { code: "PGRST_LEDGER", message: "ledger unavailable" },
    signals: new Map([[A, signal(A, {
      signal_type: "reset_executed",
      classification_source: "manual",
      classification_reason: "human confirmation",
      verification_status: "confirmed",
    })]]),
  });

  const response = await runWebhook(state, { tweetId: A });

  assert.equal(response.status, 503);
  assert.equal(state.signals.get(A)?.signal_type, "reset_executed");
  assert.equal(state.signals.get(A)?.classification_source, "manual");
  assert.equal(state.signals.get(A)?.classification_reason, "human confirmation");
  assert.equal(state.signals.get(A)?.verification_status, "confirmed");
  assert.equal(state.signals.get(A)?.edit_metadata_source, "x_api");
});

test("a post-claim enrichment failure is retried against the existing ledger", async () => {
  const recoveryId = "recovery-1";
  const state = createState({
    recoveries: [recovery(recoveryId)],
    estimateError: { code: "PGRST_ESTIMATE", message: "estimate unavailable" },
  });

  const first = await runWebhook(state, {
    tweetId: A,
    tweetUrl: `https://x.com/thsottiaux/status/${A}`,
  });

  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: "Formal adoption enrichment unavailable" });
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.ledgers[0].reset_event_key, `tibo-reset-${A}`);
  assert.equal(state.estimates.length, 0);
  assert.equal(state.recoveries[0].status, "confirmed");
  assert.equal(state.recoveries[0].matched_tibo_tweet_id, A);

  state.estimateError = undefined;
  const second = await runWebhook(state, {
    tweetId: A,
    tweetUrl: `https://x.com/thsottiaux/status/${A}`,
  });
  const secondBody = await second.json();

  assert.equal(second.status, 200);
  assert.equal(secondBody.formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.estimates.length, 1);
  assert.equal(state.estimates[0].reset_event_key, `tibo-reset-${A}`);
  assert.equal(state.recoveries[0].matched_tibo_tweet_id, A);
  assert.equal(
    state.calls.filter((call) => call.url.includes("/rpc/claim_tibo_formal_adoption")).length,
    2,
  );
  assert.equal(
    state.calls.filter((call) => call.method === "PATCH" && call.url.includes("codex_recovery_observations")).length,
    1,
  );
  assert.equal(
    state.calls.filter((call) => (call.method === "POST" || call.method === "PATCH") && call.url.includes("reset_execution_estimates")).length,
    2,
  );
});

test("display-name API failure remains best-effort after durable enrichment", async () => {
  const state = createState({
    geminiApiError: true,
    recoveries: [recovery("recovery-display-name")],
  });

  const response = await runWebhook(state, { tweetId: A });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, true);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.estimates.length, 1);
  assert.equal(
    state.calls.filter((call) => call.url.includes("generativelanguage.googleapis.com")).length,
    1,
  );
});

test("related notice provenance is reconciled without a second new adoption", async () => {
  const noticeId = "2094999999999999999";
  const state = createState({
    signals: new Map([
      [noticeId, signal(noticeId, {
        text: "We will reset usage limits for all paid users tomorrow.",
        tweet_created_at: "2026-08-30T23:00:00.000Z",
        signal_type: "official_notice",
        confidence: 0.99,
        classification_source: "gemini",
      })],
    ]),
    recoveries: [recovery("recovery-notice")],
  });

  const response = await runWebhook(state, {
    tweetId: A,
    tweetUrl: `https://x.com/thsottiaux/status/${A}`,
  });
  const body = await response.json();
  const claimCalls = state.calls.filter((call) => call.url.includes("/rpc/claim_tibo_formal_adoption"));

  assert.equal(response.status, 200);
  assert.equal(body.formalAdoption.newlyAdopted, true);
  assert.equal(state.ledgers.length, 1);
  assert.equal(claimCalls.length, 2);
  assert.deepEqual(claimCalls[0].body?.p_source_tweet_ids, [A]);
  assert.deepEqual(claimCalls[1].body?.p_source_tweet_ids, [A, noticeId]);
  assert.deepEqual(state.ledgers[0].source_tweet_ids, [A, noticeId]);
  assert.deepEqual(state.estimates[0]?.tibo_source_tweet_ids, [A, noticeId]);
});

test("Monitor-first formal adoption names one canonical event from its Tibo provenance", async () => {
  const contextId = A;
  const formalId = B;
  const unrelatedId = "2095000000000000003";
  const recoveryId = "recovery-monitor-e2e";
  const recoveryObservedAt = "2026-08-31T00:01:30.000Z";
  const state = createState({
    signals: new Map([
      [contextId, signal(contextId, {
        text: "GPT Astra is launching today.",
        tweet_created_at: "2026-08-30T23:58:00.000Z",
        signal_type: "official_notice",
        classification_source: "gemini",
      })],
      [unrelatedId, signal(unrelatedId, {
        text: "GPT Nova is launching today.",
        tweet_created_at: "2026-08-30T23:59:00.000Z",
        signal_type: "irrelevant",
      })],
    ]),
    recoveries: [recovery(recoveryId)],
    estimates: [{
      id: "estimate-monitor-e2e",
      reset_event_key: "usage-reset-monitor-e2e",
      display_execution_at: recoveryObservedAt,
      execution_time_source: "usage_observation",
      execution_time_confidence: "high",
      execution_time_precision: "approximate",
      execution_window_start_at: "2026-08-31T00:00:30.000Z",
      execution_window_end_at: recoveryObservedAt,
      recovery_observation_id: recoveryId,
      recovery_previous_observed_at: "2026-08-31T00:00:30.000Z",
      recovery_observed_at: recoveryObservedAt,
      tibo_announced_at: "2026-08-30T23:58:00.000Z",
      tibo_primary_tweet_id: formalId,
      tibo_source_tweet_ids: [contextId],
      official_notice_tweet_id: contextId,
      official_notice_at: "2026-08-30T23:58:00.000Z",
      estimator_version: "usage-execution-v1",
      manual_override_at: null,
      manual_override_by: null,
      manual_override_reason: null,
      manual_execution_at: null,
      manual_execution_precision: null,
      created_at: recoveryObservedAt,
      updated_at: recoveryObservedAt,
    }],
    geminiNameResult: {
      nameJa: "GPT Astraリリース記念リセット",
      nameEn: "GPT Astra Release Reset",
      nameZh: "GPT Astra 发布纪念重置",
      reason: "GPT Astraのリリースという投稿内の特徴を使った。",
    },
  });

  const response = await runWebhook(state, {
    tweetId: formalId,
    text: "We have reset usage limits for all paid users. Reset is live.",
    tweetUrl: `https://x.com/thsottiaux/status/${formalId}`,
    tweetCreatedAt: "2026-08-31T00:00:00.000Z",
  });
  const displayNameWrite = state.calls.find((call) =>
    call.method === "POST" && call.url.includes("reset_display_names"),
  )?.body;

  assert.equal(response.status, 200);
  assert.equal((await response.json()).formalAdoption.newlyAdopted, false);
  assert.equal(state.ledgers.length, 1);
  assert.equal(state.ledgers[0]?.reset_event_key, "usage-reset-monitor-e2e");
  assert.equal(state.ledgers[0]?.claim_source, "existing_estimate");
  assert.ok(state.ledgers[0]?.source_tweet_ids.includes(contextId));
  assert.ok(state.ledgers[0]?.source_tweet_ids.includes(formalId));
  assert.equal(state.estimates[0]?.display_execution_at, recoveryObservedAt);
  assert.equal(state.estimates[0]?.tibo_primary_tweet_id, formalId);
  assert.deepEqual(
    state.estimates[0]?.tibo_source_tweet_ids.sort(),
    [contextId, formalId].sort(),
  );
  assert.equal(displayNameWrite?.event_key, "usage-reset-monitor-e2e");
  assert.equal(displayNameWrite?.ai_name_ja, "GPT Astraリリース記念リセット");
  assert.equal(displayNameWrite?.ai_name_en, "GPT Astra Release Reset");
  assert.equal(displayNameWrite?.ai_name_zh, "GPT Astra 发布纪念重置");

  const namingRequest = state.calls.find((call) =>
    call.url.includes("generativelanguage.googleapis.com"),
  );
  const namingPayload = JSON.stringify(namingRequest?.body);
  assert.match(namingPayload, /GPT Astra is launching today\./);
  assert.match(namingPayload, /Reset is live\./);
  assert.equal(namingPayload.includes("GPT Nova is launching today."), false);

  const publicData = {
    reset_execution_estimates: [{
      resetEventKey: "usage-reset-monitor-e2e",
      displayExecutionAt: recoveryObservedAt,
      executionTimeSource: "usage_observation",
      executionTimeConfidence: "high",
      executionTimePrecision: "approximate",
      executionWindowStartAt: "2026-08-31T00:00:30.000Z",
      executionWindowEndAt: recoveryObservedAt,
      recoveryObservationId: recoveryId,
      recoveryPreviousObservedAt: "2026-08-31T00:00:30.000Z",
      recoveryObservedAt,
      tiboAnnouncedAt: "2026-08-30T23:58:00.000Z",
      tiboPrimaryTweetId: formalId,
      tiboSourceTweetIds: [contextId, formalId],
      officialNoticeTweetId: contextId,
      officialNoticeAt: "2026-08-30T23:58:00.000Z",
      estimatorVersion: "usage-execution-v1",
    }],
    reset_display_names: displayNameWrite ? [displayNameWrite] : [],
  } as unknown as RadarData;
  const expectedTitles = {
    ja: "GPT Astraリリース記念リセット",
    en: "GPT Astra Release Reset",
    zh: "GPT Astra 发布纪念重置",
  } as const;
  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(publicData, locale, {
      calculationNow: new Date("2026-09-01T00:00:00.000Z"),
      limitHistory: false,
    });
    const event = snapshot.viewModel.recentHistory.find((item) =>
      item.key === "usage-reset-monitor-e2e",
    );
    assert.equal(event?.title, expectedTitles[locale]);
    assert.equal(event?.resetAt, recoveryObservedAt);
  }
});
