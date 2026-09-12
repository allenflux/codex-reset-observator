import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST } from "../app/api/webhook/codex-usage/route";
import { shouldCreateNoticeBackedEstimate } from "../lib/codexUsageRecovery";
import { NOTICE_LOOKBACK_MS } from "../lib/radar/tiboHistory";

const ENV_KEYS = [
  "CODEX_USAGE_MONITOR_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const ATOMIC_RPC_PATH = "/rpc/apply_codex_usage_webhook_write";

type MockRequest = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
};

function getAtomicPlan(body: Record<string, unknown> | null) {
  const plan = body?.p_plan;
  return plan && typeof plan === "object" ? plan as Record<string, unknown> : null;
}

function respondToAtomicRpc(body: Record<string, unknown> | null, observationId = "route-observation-id") {
  const plan = getAtomicPlan(body);
  return new Response(JSON.stringify({
    status: "applied",
    retry_required: false,
    observation_id: plan?.observation ? observationId : null,
  }), { status: 200 });
}

function getAtomicPlanFromRequests(requests: ReadonlyArray<MockRequest>) {
  const rpcRequest = requests.find((request) =>
    request.method === "POST" && request.url.includes(ATOMIC_RPC_PATH),
  );
  assert.ok(rpcRequest, "The webhook should use the atomic write RPC");
  const plan = getAtomicPlan(rpcRequest!.body);
  assert.ok(plan, "The atomic RPC should receive a write plan");
  return plan!;
}

function getAtomicPlanPart(requests: ReadonlyArray<MockRequest>, key: string) {
  const value = getAtomicPlanFromRequests(requests)[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function withEnvironment(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function buildRequest(overrides: Record<string, unknown> = {}, authorization = "Bearer monitor-secret") {
  return new NextRequest("http://localhost/api/webhook/codex-usage", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      observedAt: "2026-08-11T00:02:00.000Z",
      limitId: "codex",
      planType: "plus",
      usedPercent: 0,
      windowDurationMins: 10080,
      resetsAt: 1787012727,
      ...overrides,
    }),
  });
}

function assertUsageWebhookQueryBounds(
  requests: ReadonlyArray<{ url: string; method: string }>,
  observedAt: string,
) {
  const tiboRequest = requests.find((request) =>
    request.method === "GET" && request.url.includes("tibo_signals"),
  );
  assert.ok(tiboRequest, "The webhook should query Tibo signals");
  const tiboUrl = new URL(tiboRequest!.url);
  const observedIso = new Date(observedAt).toISOString();
  const lookbackIso = new Date(Date.parse(observedAt) - NOTICE_LOOKBACK_MS).toISOString();
  const orFilters = tiboUrl.searchParams.getAll("or");
  assert.equal(tiboUrl.searchParams.get("tweet_created_at"), `lte.${observedIso}`);
  assert.equal(tiboUrl.searchParams.get("order"), "tweet_created_at.desc,tweet_id.desc");
  assert.equal(tiboUrl.searchParams.get("limit"), "1000");
  assert.ok(orFilters.some((value) =>
    value.includes(`tweet_created_at.gte.${lookbackIso}`) &&
    value.includes(`expires_at.gt.${observedIso}`),
  ), `Expected a bounded Tibo lookback/active-window filter: ${orFilters.join(" | ")}`);

  const regularRequest = requests.find((request) =>
    request.method === "GET" && request.url.includes("regular_reset_events"),
  );
  assert.ok(regularRequest, "The webhook should query regular reset events");
  const regularUrl = new URL(regularRequest!.url);
  assert.equal(regularUrl.searchParams.get("cycle_type"), "eq.定期リセット");
  assert.equal(regularUrl.searchParams.get("record_kind"), "eq.regular_completed");
  assert.equal(regularUrl.searchParams.get("status"), "in.(completed,corrected)");
  assert.equal(regularUrl.searchParams.get("completed_at"), `lte.${observedIso}`);
  assert.equal(regularUrl.searchParams.get("order"), "completed_at.desc");
  assert.equal(regularUrl.searchParams.get("limit"), "1");
}

test("missing monitor secret returns 503 without contacting storage", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: undefined,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 500 });
  };

  try {
    const response = await POST(buildRequest());
    assert.equal(response.status, 503);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("wrong monitor secret returns 401", async () => {
  const restore = withEnvironment({ CODEX_USAGE_MONITOR_SECRET: "monitor-secret" });
  try {
    const response = await POST(buildRequest({}, "Bearer wrong-secret"));
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test("unknown and personal payload fields are rejected before storage", async () => {
  const restore = withEnvironment({ CODEX_USAGE_MONITOR_SECRET: "monitor-secret" });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 500 });
  };

  try {
    for (const field of ["email", "accountId", "token", "cookie", "unexpectedField"]) {
      const response = await POST(buildRequest({ [field]: "private" }));
      assert.equal(response.status, 400);
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("generic credits cannot create a BANKED distribution event", async () => {
  const restore = withEnvironment({ CODEX_USAGE_MONITOR_SECRET: "monitor-secret" });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 500 });
  };

  try {
    const response = await POST(buildRequest({
      bankedCredit: { available: true, unlimited: false, balance: "1" },
      bankedCreditChange: true,
    }));
    assert.equal(response.status, 400);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("the first valid snapshot is stored as a baseline only", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  const bodies: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    methods.push(method);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(bodies.at(-1) as Record<string, unknown> | null);
    }
    if (methods.length === 1) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "baseline" });
    assert.deepEqual(methods, ["GET", "POST"]);
    const plan = getAtomicPlan(bodies[0] as Record<string, unknown>);
    assert.ok(plan);
    assert.deepEqual(plan?.state, {
      source_key: "local-codex-app-server",
      observed_at: "2026-08-11T00:02:00.000Z",
      received_at: plan?.state && typeof plan.state === "object" ? (plan.state as Record<string, unknown>).received_at : undefined,
      limit_id: "codex",
      plan_type: "plus",
      used_percent: 0,
      window_duration_mins: 10080,
      resets_at: 1787012727,
      coverage_started_at: "2026-08-11T00:02:00.000Z",
      banked_reset_available_count: null,
      last_banked_grant_at: null,
      updated_at: plan?.state && typeof plan.state === "object" ? (plan.state as Record<string, unknown>).updated_at : undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("the Astra paid-plan BANKED notice plus a matching local credit grant creates one banked estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T03:00:00.000Z",
        received_at: "2026-09-04T03:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: 1_787_012_727,
        coverage_started_at: "2026-09-04T02:00:00.000Z",
        banked_reset_available_count: 1,
        updated_at: "2026-08-11T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([{
        tweet_id: "2095651088502591861",
        text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today. Team is moving mountains to give access as fast as we can.\n\nFirst one will land in ~ 3 hours. There is still time to create your account if you don't have one.",
        tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
        tweet_created_at: "2026-09-03T23:12:09.000Z",
        expires_at: "2026-09-05T00:00:00.000Z",
        signal_type: "official_notice",
        confidence: 0.98,
        verification_status: "auto_unverified",
        is_reply: false,
        ai_temporal_precision: "daypart",
        expected_start_at: "2026-09-04T02:12:09.000Z",
        expected_end_at: "2026-09-04T02:12:09.000Z",
        temporal_resolution_status: "resolved",
        ai_temporal_timezone: "America/Los_Angeles",
        ai_temporal_confidence: 0.98,
      }]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-04T03:34:46.386Z",
      bankedResetAvailableCount: 2,
      bankedResetCountChange: true,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const estimateWrite = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(estimateWrite?.reset_event_key, "banked-reset-2095651088502591861");
    assert.equal(estimateWrite?.display_execution_at, "2026-09-04T03:34:46.386Z");
    assert.equal(estimateWrite?.tibo_announced_at, "2026-09-03T23:12:09.000Z");
    assert.equal(estimateWrite?.official_notice_tweet_id, "2095651088502591861");
    assert.deepEqual(estimateWrite?.tibo_source_tweet_ids, ["2095651088502591861"]);
    const atomicPlan = getAtomicPlanFromRequests(requests);
    assert.equal(atomicPlan.observation, undefined);
    assert.equal(atomicPlan.regular_reset_event, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a terminated Astra notice remains BANKED evidence but cannot back an ordinary recovery", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const astraSignal = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-06T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.98,
    verification_status: "auto_unverified",
    is_reply: false,
  };
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "terminated-astra-observation");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T22:40:00.000Z",
        received_at: "2026-09-04T22:40:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 80,
        window_duration_mins: 10080,
        resets_at: previousResetsAt,
        coverage_started_at: "2026-09-04T22:00:00.000Z",
        banked_reset_available_count: 1,
        last_banked_grant_at: "2026-09-04T03:34:46.386Z",
        updated_at: "2026-09-04T22:40:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const formalResetQuery = query.searchParams.getAll("or")
        .some((value) => value.includes("signal_type.eq.reset_executed"));
      return new Response(JSON.stringify(formalResetQuery ? [] : [astraSignal]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-04T22:45:00.000Z",
      usedPercent: 0,
      resetsAt: currentResetsAt,
      bankedResetAvailableCount: 2,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const bankedEstimate = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(bankedEstimate?.official_notice_tweet_id, "2095651088502591861");
    const recoveryEstimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.equal(recoveryEstimate?.reset_event_key, "usage-reset-pending");
    assert.equal(recoveryEstimate?.official_notice_tweet_id, null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("BANKED count growth and an unexpected recovery use separate notice contexts", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const astraSignal = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-04T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.98,
    verification_status: "auto_unverified",
    is_reply: false,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:30:00.000Z",
    temporal_resolution_status: "resolved",
  };
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "simultaneous-banked-recovery");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T03:55:00.000Z",
        received_at: "2026-09-04T03:55:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 80,
        window_duration_mins: 10080,
        resets_at: previousResetsAt,
        coverage_started_at: "2026-09-04T02:00:00.000Z",
        banked_reset_available_count: 2,
        last_banked_grant_at: "2026-09-04T03:00:00.000Z",
        updated_at: "2026-09-04T03:55:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const formalResetQuery = query.searchParams.getAll("or")
        .some((value) => value.includes("signal_type.eq.reset_executed"));
      return new Response(JSON.stringify(formalResetQuery ? [] : [astraSignal]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-04T04:00:00.000Z",
      usedPercent: 0,
      resetsAt: currentResetsAt,
      bankedResetAvailableCount: 3,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });

    const bankedEstimate = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(bankedEstimate?.reset_event_key, "banked-reset-2095651088502591861-observation-20260904T040000000Z");
    assert.equal(bankedEstimate?.official_notice_tweet_id, "2095651088502591861");

    const recoveryEstimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.equal(recoveryEstimate?.reset_event_key, "usage-reset-pending");
    assert.equal(recoveryEstimate?.official_notice_tweet_id, null);
    assert.deepEqual(recoveryEstimate?.tibo_source_tweet_ids, []);
    assert.equal(getAtomicPlanFromRequests(requests).regular_reset_event, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a simultaneous unexpected recovery uses a matching one-shot notice instead of the persistent BANKED notice", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const astraSignal = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-04T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.98,
    verification_status: "auto_unverified",
    is_reply: false,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:30:00.000Z",
    temporal_resolution_status: "resolved",
  };
  const recoveryNotice = {
    tweet_id: "recovery-one-shot-notice",
    text: "We are resetting usage for everyone now.",
    tweet_url: "https://x.com/thsottiaux/status/recovery-one-shot-notice",
    tweet_created_at: "2026-09-04T03:58:00.000Z",
    expires_at: "2026-09-04T05:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.99,
    verification_status: "auto_unverified",
    is_reply: false,
    expected_start_at: "2026-09-04T03:55:00.000Z",
    expected_end_at: "2026-09-04T04:05:00.000Z",
    temporal_resolution_status: "resolved",
  };
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "simultaneous-one-shot-recovery");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T03:55:00.000Z",
        received_at: "2026-09-04T03:55:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 80,
        window_duration_mins: 10080,
        resets_at: previousResetsAt,
        coverage_started_at: "2026-09-04T02:00:00.000Z",
        banked_reset_available_count: 2,
        last_banked_grant_at: "2026-09-04T03:00:00.000Z",
        updated_at: "2026-09-04T03:55:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const formalResetQuery = query.searchParams.getAll("or")
        .some((value) => value.includes("signal_type.eq.reset_executed"));
      return new Response(JSON.stringify(formalResetQuery ? [] : [astraSignal, recoveryNotice]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-04T04:00:00.000Z",
      usedPercent: 0,
      resetsAt: currentResetsAt,
      bankedResetAvailableCount: 3,
    }));

    assert.equal(response.status, 200);
    const plan = getAtomicPlanFromRequests(requests);
    const bankedEstimate = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(bankedEstimate?.official_notice_tweet_id, "2095651088502591861");

    const recoveryEstimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.equal(recoveryEstimate?.reset_event_key, "tibo-reset-recovery-one-shot-notice");
    assert.equal(recoveryEstimate?.official_notice_tweet_id, "recovery-one-shot-notice");
    assert.deepEqual(recoveryEstimate?.tibo_source_tweet_ids, ["recovery-one-shot-notice"]);
    assert.equal(plan.regular_reset_event, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a simultaneous BANKED grant and near-regular recovery keep the recovery regular", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const astraSignal = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-04T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.98,
    verification_status: "auto_unverified",
    is_reply: false,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:30:00.000Z",
    temporal_resolution_status: "resolved",
  };
  const previousResetsAt = Math.floor(Date.parse("2026-09-04T03:59:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-11T03:59:00.000Z") / 1000);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "simultaneous-regular-recovery");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T03:55:00.000Z",
        received_at: "2026-09-04T03:55:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 80,
        window_duration_mins: 10080,
        resets_at: previousResetsAt,
        coverage_started_at: "2026-09-04T02:00:00.000Z",
        banked_reset_available_count: 2,
        last_banked_grant_at: "2026-09-04T03:00:00.000Z",
        updated_at: "2026-09-04T03:55:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const formalResetQuery = query.searchParams.getAll("or")
        .some((value) => value.includes("signal_type.eq.reset_executed"));
      return new Response(JSON.stringify(formalResetQuery ? [] : [astraSignal]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-04T04:00:00.000Z",
      usedPercent: 0,
      resetsAt: currentResetsAt,
      bankedResetAvailableCount: 3,
    }));

    assert.equal(response.status, 200);
    const plan = getAtomicPlanFromRequests(requests);
    const bankedEstimate = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(bankedEstimate?.official_notice_tweet_id, "2095651088502591861");

    const regularCompletion = getAtomicPlanPart(requests, "regular_reset_event");
    assert.equal(regularCompletion?.scheduled_at, "2026-09-04T03:59:00.000Z");
    assert.equal(regularCompletion?.completed_at, "2026-09-04T04:00:00.000Z");
    assert.equal(plan.execution_estimate, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a later persistent BANKED observation gets a distinct event key without source-overlap reuse", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const firstObservedAt = "2026-09-04T03:34:46.386Z";
  const observedAt = "2026-09-04T04:34:46.386Z";
  const firstEventKey = "banked-reset-2095651088502591861";
  let latestEstimate: Record<string, unknown> = {
    reset_event_key: firstEventKey,
    display_execution_at: firstObservedAt,
    created_at: firstObservedAt,
    official_notice_tweet_id: "2095651088502591861",
  };

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-04T03:00:00.000Z",
        received_at: "2026-09-04T03:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: 1_787_012_727,
        coverage_started_at: "2026-09-04T02:00:00.000Z",
        banked_reset_available_count: 1,
        last_banked_grant_at: firstObservedAt,
        updated_at: "2026-09-04T03:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([{
        tweet_id: "2095651088502591861",
        text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
        tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
        tweet_created_at: "2026-09-03T23:12:09.000Z",
        expires_at: "2026-09-04T04:00:00.000Z",
        signal_type: "official_notice",
        confidence: 0.98,
        verification_status: "auto_unverified",
        is_reply: false,
        expected_start_at: "2026-09-04T02:12:09.000Z",
        expected_end_at: "2026-09-04T02:30:00.000Z",
        temporal_resolution_status: "resolved",
      }]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: latestEstimate, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt,
      bankedResetAvailableCount: 2,
      bankedResetCountChange: true,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const estimateWrite = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(
      estimateWrite?.reset_event_key,
      "banked-reset-2095651088502591861-observation-20260904T043446386Z",
    );
    assert.deepEqual(estimateWrite?.tibo_source_tweet_ids, []);
    assert.equal(estimateWrite?.official_notice_tweet_id, "2095651088502591861");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("bounded notice lookup keeps the latest signal available beyond 1000 old rows", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const observedAt = "2026-08-11T00:02:00.000Z";
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const latestNotice = {
    tweet_id: "latest-banked-notice-after-old-rows",
    text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
    tweet_url: "https://x.com/thsottiaux/status/latest-banked-notice-after-old-rows",
    tweet_created_at: "2026-08-10T23:00:00.000Z",
    expires_at: "2026-08-12T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.99,
    verification_status: "auto_unverified",
    is_reply: false,
    ai_temporal_precision: "daypart",
    expected_start_at: "2026-08-11T00:00:00.000Z",
    expected_end_at: "2026-08-11T23:59:59.000Z",
    temporal_resolution_status: "resolved",
    ai_temporal_timezone: "America/Los_Angeles",
    ai_temporal_confidence: 0.98,
  };
  const oldSignals = Array.from({ length: 1001 }, (_, index) => ({
    tweet_id: `old-tibo-signal-${index}`,
    text: "An unrelated historical post.",
    tweet_url: `https://x.com/thsottiaux/status/old-tibo-signal-${index}`,
    tweet_created_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-02T00:00:00.000Z",
    signal_type: "irrelevant",
    confidence: 0.1,
    verification_status: "auto_unverified",
    is_reply: false,
  }));

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-10T23:00:00.000Z",
        received_at: "2026-08-10T23:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: 1_787_012_727,
        coverage_started_at: "2026-08-10T22:00:00.000Z",
        banked_reset_available_count: 0,
        updated_at: "2026-08-10T23:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const observedIso = new Date(observedAt).toISOString();
      const lookbackIso = new Date(Date.parse(observedAt) - NOTICE_LOOKBACK_MS).toISOString();
      const orFilters = query.searchParams.getAll("or");
      const bounded =
        query.searchParams.get("tweet_created_at") === `lte.${observedIso}` &&
        query.searchParams.get("order") === "tweet_created_at.desc,tweet_id.desc" &&
        query.searchParams.get("limit") === "1000" &&
        orFilters.some((value) =>
          value.includes(`tweet_created_at.gte.${lookbackIso}`) &&
          value.includes(`expires_at.gt.${observedIso}`),
        );
      return new Response(JSON.stringify(bounded ? [latestNotice, ...oldSignals] : oldSignals), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt,
      bankedResetAvailableCount: 1,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    assertUsageWebhookQueryBounds(requests, observedAt);
    const estimateWrite = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(estimateWrite?.reset_event_key, "banked-reset-latest-banked-notice-after-old-rows");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("registered persistent notice lookup restores an expired Astra notice without widening one-shot lookup", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const observedAt = "2026-09-04T00:00:00.000Z";
  const astraNotice = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    tweet_created_at: "2026-09-01T23:12:09.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
    signal_type: "official_notice",
    confidence: 0.98,
    verification_status: "auto_unverified",
    is_reply: false,
    ai_temporal_precision: "daypart",
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:12:09.000Z",
    temporal_resolution_status: "resolved",
    ai_temporal_timezone: "America/Los_Angeles",
    ai_temporal_confidence: 0.98,
  };
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-03T23:59:00.000Z",
        received_at: "2026-09-03T23:59:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: 1_787_012_727,
        coverage_started_at: "2026-09-03T22:00:00.000Z",
        banked_reset_available_count: 1,
        updated_at: "2026-09-03T23:59:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const persistentLookup = query.searchParams.get("tweet_id") === "in.(2095651088502591861)";
      return new Response(JSON.stringify(persistentLookup ? [astraNotice] : []), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt,
      usedPercent: 20,
      bankedResetAvailableCount: 2,
      bankedResetCountChange: true,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const tiboRequests = requests.filter((request) => request.method === "GET" && request.url.includes("tibo_signals"));
    assert.equal(tiboRequests.length, 2);
    const boundedRequest = tiboRequests.find((request) => !new URL(request.url).searchParams.has("tweet_id"));
    assert.ok(boundedRequest);
    const persistentRequest = tiboRequests.find((request) => new URL(request.url).searchParams.get("tweet_id") === "in.(2095651088502591861)");
    assert.ok(persistentRequest);
    const estimateWrite = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(estimateWrite?.reset_event_key, "banked-reset-2095651088502591861");
    assert.equal(estimateWrite?.official_notice_tweet_id, "2095651088502591861");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a BANKED credit keeps the first notice and uses the most specific notice as representative", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-21T23:30:00.000Z",
        received_at: "2026-08-21T23:30:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: 1_787_200_000,
        coverage_started_at: "2026-08-21T22:00:00.000Z",
        updated_at: "2026-08-21T23:30:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([
        {
          tweet_id: "banked-old-route-test",
          text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
          tweet_url: "https://x.com/thsottiaux/status/banked-old-route-test",
          tweet_created_at: "2026-08-21T12:00:00.000Z",
          expires_at: "2026-08-22T08:00:00.000Z",
          signal_type: "official_notice",
          confidence: 0.99,
          verification_status: "auto_unverified",
          is_reply: false,
          ai_temporal_precision: "daypart",
          expected_start_at: "2026-08-21T12:00:00.000Z",
          expected_end_at: "2026-08-22T07:00:00.000Z",
          temporal_resolution_status: "resolved",
          ai_temporal_timezone: "America/Los_Angeles",
          ai_temporal_confidence: 0.98,
        },
        {
          tweet_id: "banked-new-route-test",
          text: "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.",
          tweet_url: "https://x.com/thsottiaux/status/banked-new-route-test",
          tweet_created_at: "2026-08-21T23:40:34.000Z",
          expires_at: "2026-08-22T06:00:00.000Z",
          signal_type: "official_notice",
          confidence: 0.99,
          verification_status: "auto_unverified",
          is_reply: false,
          ai_temporal_precision: "exact_time",
          expected_start_at: "2026-08-21T23:40:34.000Z",
          expected_end_at: "2026-08-22T04:00:00.000Z",
          temporal_resolution_status: "resolved",
          ai_temporal_timezone: "PST",
          ai_temporal_confidence: 0.95,
        },
        {
          tweet_id: "unrelated-later-route-test",
          text: "A reset is planned for later.",
          tweet_url: "https://x.com/thsottiaux/status/unrelated-later-route-test",
          tweet_created_at: "2026-08-21T23:45:00.000Z",
          expires_at: "2026-08-22T10:00:00.000Z",
          signal_type: "official_notice",
          confidence: 0.99,
          verification_status: "auto_unverified",
          is_reply: false,
        },
      ]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-21T23:50:00.000Z",
      usedPercent: 20,
      resetsAt: 1_787_200_000,
      bankedResetAvailableCount: 1,
      bankedResetCountChange: true,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const estimateWrite = getAtomicPlanPart(requests, "banked_distribution_estimate");
    assert.equal(estimateWrite?.reset_event_key, "banked-reset-banked-old-route-test");
    assert.equal(estimateWrite?.tibo_announced_at, "2026-08-21T12:00:00.000Z");
    assert.equal(estimateWrite?.tibo_primary_tweet_id, "banked-new-route-test");
    assert.deepEqual(estimateWrite?.tibo_source_tweet_ids, [
      "banked-old-route-test",
      "banked-new-route-test",
    ]);
    assert.equal(estimateWrite?.official_notice_tweet_id, "banked-new-route-test");
    assert.equal(estimateWrite?.official_notice_at, "2026-08-21T23:40:34.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("an unapplied coverage migration falls back without failing the first snapshot", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      if (url.includes("coverage_started_at")) {
        return new Response(JSON.stringify({
          code: "PGRST204",
          message: "Could not find the 'coverage_started_at' column of 'codex_usage_monitor_state'",
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_usage_monitor_state")) {
      if (body && "coverage_started_at" in body) {
        return new Response(JSON.stringify({
          code: "PGRST204",
          message: "Could not find the 'coverage_started_at' column of 'codex_usage_monitor_state'",
        }), { status: 400 });
      }
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method === "PATCH" && url.includes("codex_usage_monitor_state")) {
      assert.equal(body && "coverage_started_at" in body, false);
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "baseline" });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "GET", "POST"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("notice-backed estimate is not created for a strong unknown recovery", () => {
  assert.equal(
    shouldCreateNoticeBackedEstimate(
      { id: "notice-1" },
      { confidence: "strong", cycleHint: "unknown" },
      { id: "recovery-1" },
    ),
    false,
  );
});

test("notice-backed estimate is created for a strong unexpected recovery", () => {
  assert.equal(
    shouldCreateNoticeBackedEstimate(
      { id: "notice-1" },
      { confidence: "strong", cycleHint: "unexpected" },
      { id: "recovery-1" },
    ),
    true,
  );
});

test("regular recovery records the observation and canonical event without matching or promoting a nearby Tibo reset", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const observedAt = "2026-08-11T00:02:00.000Z";
  const latestRegularEvent = {
    schedule_key: "weekly-regular-reset:2026-08-10T12:00:00.000Z",
    window_start_at: "2026-08-10T11:58:00.000Z",
    window_end_at: "2026-08-10T12:13:00.000Z",
    representative_at: "2026-08-10T12:00:00.000Z",
    scheduled_at: "2026-08-10T12:00:00.000Z",
    completed_at: "2026-08-10T12:02:00.000Z",
    cycle_type: "定期リセット",
    reset_method: "強制リセット",
    scope: "任意リセット未使用アカウント",
    record_kind: "regular_completed",
    status: "completed",
  };
  const oldRegularEvents = Array.from({ length: 1001 }, (_, index) => ({
    ...latestRegularEvent,
    schedule_key: `old-regular-reset-${index}`,
    completed_at: "2020-01-01T00:00:00.000Z",
  }));
  let regularRowsReturned: "latest" | "old" | null = null;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-10T23:58:00.000Z",
        received_at: "2026-08-10T23:58:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 69,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-10T23:00:00.000Z",
        updated_at: "2026-08-11T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      const query = new URL(url);
      const bounded =
        query.searchParams.get("completed_at") === `lte.${new Date(observedAt).toISOString()}` &&
        query.searchParams.get("order") === "completed_at.desc" &&
        query.searchParams.get("limit") === "1";
      regularRowsReturned = bounded ? "latest" : "old";
      return new Response(JSON.stringify(bounded ? [latestRegularEvent] : oldRegularEvents), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method === "POST" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method === "POST" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt,
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 200);
    assert.equal(regularRowsReturned, "latest");
    const tiboRequests = requests.filter((request) => request.url.includes("tibo_signals") && request.method === "GET");
    assert.equal(tiboRequests.filter((request) => !new URL(request.url).searchParams.has("tweet_id")).length, 1, JSON.stringify(requests));
    assert.equal(tiboRequests.filter((request) => new URL(request.url).searchParams.has("tweet_id")).length, 1, JSON.stringify(requests));
    assert.equal(getAtomicPlanFromRequests(requests).promotion, undefined);
    const observation = getAtomicPlanPart(requests, "observation");
    assert.equal(observation?.matched_tibo_tweet_id, null);
    assert.equal(observation?.status, "observed");
    assert.equal(observation?.cycle_hint, "regular");
    assert.equal(observation?.confidence, "medium");
    const regularCompletion = getAtomicPlanPart(requests, "regular_reset_event");
    assert.equal(regularCompletion?.scheduled_at, "2026-08-11T00:00:00.000Z");
    assert.equal(regularCompletion?.completed_at, "2026-08-11T00:02:00.000Z");
    assert.notEqual(regularCompletion?.scheduled_at, regularCompletion?.completed_at);
    assert.equal(getAtomicPlanFromRequests(requests).promotion, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("regular recovery with an official notice records regular history without promoting a global reset", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-10T23:58:00.000Z",
        received_at: "2026-08-10T23:58:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 69,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-10T23:00:00.000Z",
        updated_at: "2026-08-11T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([{
        tweet_id: "official-notice-personal-test",
        text: "A reset is planned",
        tweet_url: "https://x.com/thsottiaux/status/official-notice-personal-test",
        tweet_created_at: "2026-08-10T00:00:00.000Z",
        expires_at: "2026-08-12T00:00:00.000Z",
        signal_type: "official_notice",
        confidence: 0.99,
        verification_status: "auto_unverified",
        is_reply: false,
      }]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method === "POST" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method === "POST" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-11T00:02:00.000Z",
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "observed_unconfirmed" });
    assertUsageWebhookQueryBounds(requests, "2026-08-11T00:02:00.000Z");
    const observation = getAtomicPlanPart(requests, "observation");
    assert.equal(observation?.cycle_hint, "unknown");
    assert.equal(observation?.confidence, "strong");
    assert.equal(observation?.status, "observed");
    const regularCompletion = getAtomicPlanPart(requests, "regular_reset_event");
    assert.equal(regularCompletion?.scheduled_at, "2026-08-11T00:00:00.000Z");
    assert.equal(regularCompletion?.completed_at, "2026-08-11T00:02:00.000Z");
    assert.notEqual(regularCompletion?.scheduled_at, regularCompletion?.completed_at);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("teaser plus strong unexpected recovery persists an immediate history estimate without a completion post", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const observedAt = "2026-08-25T00:04:00.000Z";
  const latestTeaser = {
    tweet_id: "teaser-route-test",
    text: "The five hour limits are back.",
    tweet_url: "https://x.com/thsottiaux/status/teaser-route-test",
    tweet_created_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T03:00:00.000Z",
    signal_type: "teaser",
    confidence: 0.9,
    verification_status: "auto_unverified",
    is_reply: false,
  };
  const oldSignals = Array.from({ length: 1001 }, (_, index) => ({
    ...latestTeaser,
    tweet_id: `old-teaser-signal-${index}`,
    text: "An unrelated historical post.",
    tweet_url: `https://x.com/thsottiaux/status/old-teaser-signal-${index}`,
    tweet_created_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-02T00:00:00.000Z",
    signal_type: "irrelevant",
    confidence: 0.1,
  }));
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "recovery-teaser-route-test");
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:00:00.000Z",
        received_at: "2026-08-25T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 100,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      const query = new URL(url);
      const observedIso = new Date(observedAt).toISOString();
      const lookbackIso = new Date(Date.parse(observedAt) - NOTICE_LOOKBACK_MS).toISOString();
      const bounded =
        query.searchParams.get("tweet_created_at") === `lte.${observedIso}` &&
        query.searchParams.get("order") === "tweet_created_at.desc,tweet_id.desc" &&
        query.searchParams.get("limit") === "1000" &&
        query.searchParams.getAll("or").some((value) =>
          value.includes(`tweet_created_at.gte.${lookbackIso}`) &&
          value.includes(`expires_at.gt.${observedIso}`),
        );
      return new Response(JSON.stringify(bounded ? [latestTeaser, ...oldSignals] : oldSignals), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({
        id: "recovery-teaser-route-test",
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:04:00.000Z",
        previous_observed_at: "2026-08-25T00:00:00.000Z",
        previous_used_percent: 100,
        current_used_percent: 0,
        previous_resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        current_resets_at: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
        cycle_hint: "unexpected",
        confidence: "strong",
        status: "observed",
        matched_tibo_tweet_id: null,
        confirmed_at: null,
        created_at: "2026-08-25T00:04:00.000Z",
        updated_at: "2026-08-25T00:04:00.000Z",
      }), { status: 201 });
    }
    if (method === "POST" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt,
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "teaser_corroborated" });
    assertUsageWebhookQueryBounds(requests, observedAt);
    const observation = getAtomicPlanPart(requests, "observation");
    assert.equal(observation?.status, "observed");
    assert.equal(observation?.matched_tibo_tweet_id, null);
    assert.equal(observation?.confidence, "strong");
    const estimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.equal(estimate?.reset_event_key, "tibo-reset-teaser-route-test");
    assert.equal(estimate?.tibo_primary_tweet_id, "teaser-route-test");
    assert.equal(estimate?.official_notice_tweet_id, null);
    assert.equal(estimate?.display_execution_at, "2026-08-25T00:04:00.000Z");
    const atomicPlan = getAtomicPlanFromRequests(requests);
    assert.equal(atomicPlan.regular_reset_event, undefined);
    assert.equal(atomicPlan.promotion, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("a future-dated teaser is not used to corroborate an earlier monitor recovery", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "recovery-future-teaser-route-test");
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:00:00.000Z",
        received_at: "2026-08-25T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 100,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([{
        tweet_id: "future-teaser-route-test",
        text: "A reset may land tomorrow.",
        tweet_url: "https://x.com/thsottiaux/status/future-teaser-route-test",
        tweet_created_at: "2026-08-25T00:00:00.000Z",
        expires_at: "2026-08-27T00:00:00.000Z",
        signal_type: "teaser",
        confidence: 0.9,
        verification_status: "auto_unverified",
        is_reply: false,
        ai_temporal_direction: "future",
        ai_temporal_kind: "relative_day",
        temporal_precision: "day",
        expected_start_at: "2026-08-26T07:00:00.000Z",
        expected_end_at: "2026-08-27T07:00:00.000Z",
        temporal_resolution_status: "resolved",
      }]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({
        id: "recovery-future-teaser-route-test",
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:04:00.000Z",
        previous_observed_at: "2026-08-25T00:00:00.000Z",
        previous_used_percent: 100,
        current_used_percent: 0,
        previous_resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        current_resets_at: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
        cycle_hint: "unexpected",
        confidence: "strong",
        status: "observed",
        matched_tibo_tweet_id: null,
        confirmed_at: null,
        created_at: "2026-08-25T00:04:00.000Z",
        updated_at: "2026-08-25T00:04:00.000Z",
      }), { status: 201 });
    }
    if (method === "POST" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-25T00:04:00.000Z",
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "confirmed" });
    assertUsageWebhookQueryBounds(requests, "2026-08-25T00:04:00.000Z");
    const estimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.equal(estimate?.reset_event_key, "usage-reset-pending");
    assert.equal(estimate?.is_monitor_observed, true);
    assert.equal(estimate?.tibo_primary_tweet_id, null);
    assert.deepEqual(estimate?.tibo_source_tweet_ids, []);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("non-regular recovery beyond five minutes does not write regular history", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "recovery-non-regular-route-test");
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-11T00:03:01.000Z",
        received_at: "2026-08-11T00:03:02.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 69,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-10T23:00:00.000Z",
        updated_at: "2026-08-11T00:03:02.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-11T00:05:01.000Z",
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 200);
    const observation = getAtomicPlanPart(requests, "observation");
    assert.equal(observation?.cycle_hint, "unexpected");
    const atomicPlan = getAtomicPlanFromRequests(requests);
    assert.equal(atomicPlan.regular_reset_event, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("personal banked reset consumption records observation and updates state but suppresses public random reset estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "observation-personal-123");
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-11T00:00:00.000Z",
        received_at: "2026-08-11T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 80,
        window_duration_mins: 10080,
        resets_at: 1787000000,
        coverage_started_at: "2026-08-10T00:00:00.000Z",
        banked_reset_available_count: 1,
        last_banked_grant_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-11T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({
        data: {
          id: "observation-personal-123",
          source_key: "local-codex-app-server",
          observed_at: "2026-08-11T00:02:00.000Z",
          previous_observed_at: "2026-08-11T00:00:00.000Z",
          previous_used_percent: 80,
          current_used_percent: 0,
          previous_resets_at: 1787000000,
          current_resets_at: 1787604800,
          cycle_hint: "unexpected",
          confidence: "strong",
          status: "observed",
          matched_tibo_tweet_id: null,
          confirmed_at: null,
          created_at: "2026-08-11T00:02:01.000Z",
          updated_at: "2026-08-11T00:02:01.000Z",
        },
        error: null,
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-11T00:02:00.000Z",
      usedPercent: 0,
      resetsAt: 1787604800,
      bankedResetAvailableCount: 0,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "personal_reset" });

    // 1. Observation is recorded as a rejected public/global recovery candidate
    const observationWrite = getAtomicPlanPart(requests, "observation");
    assert.ok(observationWrite, "Observation should be written for audit");
    assert.equal(observationWrite?.cycle_hint, "unexpected");
    assert.equal(observationWrite?.confidence, "strong");
    assert.equal(observationWrite?.status, "rejected");
    assert.equal(observationWrite?.matched_tibo_tweet_id, null);

    // 2. State is updated to reflect banked count 0 and carry forward grant timestamp
    const stateWrite = getAtomicPlanPart(requests, "state");
    assert.ok(stateWrite, "State should be updated");
    assert.equal(stateWrite?.banked_reset_available_count, 0);
    assert.equal(stateWrite?.last_banked_grant_at, "2026-08-01T00:00:00.000Z");

    // 3. CRITICAL: NO public reset execution estimate is created!
    assert.equal(getAtomicPlanFromRequests(requests).execution_estimate, undefined,
      "No public random reset estimate must be written for personal reset");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

async function assertEstimateWriteFailureDoesNotAdvanceState(mode: "standalone" | "teaser") {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  let stateWriteCount = 0;
  let estimateWriteCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      const plan = getAtomicPlan(body);
      if (plan?.execution_estimate) {
        estimateWriteCount += 1;
        return new Response(JSON.stringify({ message: "estimate write failed" }), { status: 500 });
      }
      return respondToAtomicRpc(body, "recovery-estimate-write-error");
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:00:00.000Z",
        received_at: "2026-08-25T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 100,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify(mode === "teaser"
        ? [{
            tweet_id: "teaser-estimate-write-error",
            text: "The five hour limits are back.",
            tweet_url: "https://x.com/thsottiaux/status/teaser-estimate-write-error",
            tweet_created_at: "2026-08-25T00:00:00.000Z",
            expires_at: "2026-08-26T00:00:00.000Z",
            signal_type: "teaser",
            confidence: 0.9,
            verification_status: "auto_unverified",
            is_reply: false,
          }]
        : []), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("codex_recovery_observations")) {
      return new Response(JSON.stringify({
        id: "recovery-estimate-write-error",
        source_key: "local-codex-app-server",
        observed_at: "2026-08-25T00:04:00.000Z",
        previous_observed_at: "2026-08-25T00:00:00.000Z",
        previous_used_percent: 100,
        current_used_percent: 0,
        previous_resets_at: Math.floor(Date.parse("2026-08-27T00:00:00.000Z") / 1000),
        current_resets_at: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
        cycle_hint: "unexpected",
        confidence: "strong",
        status: "observed",
        matched_tibo_tweet_id: null,
        confirmed_at: null,
        created_at: "2026-08-25T00:04:00.000Z",
        updated_at: "2026-08-25T00:04:00.000Z",
      }), { status: 201 });
    }
    if (method !== "GET" && url.includes("reset_execution_estimates")) {
      estimateWriteCount += 1;
      return new Response(JSON.stringify({ message: "estimate write failed" }), { status: 500 });
    }
    if (method !== "GET" && url.includes("codex_usage_monitor_state")) {
      stateWriteCount += 1;
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-08-25T00:04:00.000Z",
      usedPercent: 0,
      resetsAt: Math.floor(Date.parse("2026-08-28T00:00:00.000Z") / 1000),
    }));

    assert.equal(response.status, 503);
    assert.equal(estimateWriteCount, 1);
    assert.equal(stateWriteCount, 0);
    const body = await response.json() as Record<string, unknown>;
    assert.notEqual(body.recovery, "confirmed");
    assert.notEqual(body.recovery, "teaser_corroborated");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
}

test("a standalone unexpected recovery does not advance state when its estimate write fails", async () => {
  await assertEstimateWriteFailureDoesNotAdvanceState("standalone");
});

test("a teaser-correlated recovery does not advance state when its estimate write fails", async () => {
  await assertEstimateWriteFailureDoesNotAdvanceState("teaser");
});

test("server-side BANKED count increases restore distribution without a client change marker", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  let serverCount = 0;
  let estimateWriteCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      const plan = getAtomicPlan(body);
      const state = plan?.state;
      if (state && typeof state === "object" && typeof (state as Record<string, unknown>).banked_reset_available_count === "number") {
        serverCount = (state as Record<string, unknown>).banked_reset_available_count as number;
      }
      if (plan?.banked_distribution_estimate) estimateWriteCount += 1;
      return respondToAtomicRpc(body);
    }

    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-08-11T00:00:00.000Z",
        received_at: "2026-08-11T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 20,
        window_duration_mins: 10080,
        resets_at: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
        coverage_started_at: "2026-08-10T23:00:00.000Z",
        banked_reset_available_count: serverCount,
        last_banked_grant_at: null,
        updated_at: "2026-08-11T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([{
        tweet_id: "server-banked-increase-notice",
        text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
        tweet_url: "https://x.com/thsottiaux/status/server-banked-increase-notice",
        tweet_created_at: "2026-08-10T23:00:00.000Z",
        expires_at: "2026-08-12T00:00:00.000Z",
        signal_type: "official_notice",
        confidence: 0.99,
        verification_status: "auto_unverified",
        is_reply: false,
        expected_start_at: "2026-08-11T00:00:00.000Z",
        expected_end_at: "2026-08-11T23:59:59.000Z",
        temporal_resolution_status: "resolved",
      }]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    if (method === "POST" && url.includes("reset_execution_estimates")) {
      estimateWriteCount += 1;
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    if (method !== "GET" && url.includes("codex_usage_monitor_state")) {
      if (typeof body?.banked_reset_available_count === "number") {
        serverCount = body.banked_reset_available_count;
      }
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
  };

  try {
    for (const [observedAt, currentCount] of [
      ["2026-08-11T00:02:00.000Z", 1],
      ["2026-08-11T00:04:00.000Z", 2],
    ] as const) {
      const response = await POST(buildRequest({
        observedAt,
        bankedResetAvailableCount: currentCount,
        usedPercent: 20,
        resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    }

    assert.equal(serverCount, 2);
    assert.equal(estimateWriteCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("an unknown server BANKED count does not create a distribution from a positive snapshot", async () => {
  for (const previousCount of [null, undefined]) {
    const restore = withEnvironment({
      CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
    });
    const originalFetch = globalThis.fetch;
    let estimateWriteCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;

      if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
        assert.equal(getAtomicPlan(body)?.banked_distribution_estimate, undefined);
        return respondToAtomicRpc(body);
      }

      if (method === "GET" && url.includes("codex_usage_monitor_state")) {
        return new Response(JSON.stringify({
          source_key: "local-codex-app-server",
          observed_at: "2026-08-11T00:00:00.000Z",
          received_at: "2026-08-11T00:00:01.000Z",
          limit_id: "codex",
          plan_type: "plus",
          used_percent: 20,
          window_duration_mins: 10080,
          resets_at: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
          coverage_started_at: "2026-08-10T23:00:00.000Z",
          ...(previousCount === undefined ? {} : { banked_reset_available_count: previousCount }),
          updated_at: "2026-08-11T00:00:01.000Z",
        }), { status: 200 });
      }
      if (method === "GET" && url.includes("tibo_signals")) {
        return new Response(JSON.stringify([{
          tweet_id: "unknown-banked-count-notice",
          text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
          tweet_url: "https://x.com/thsottiaux/status/unknown-banked-count-notice",
          tweet_created_at: "2026-08-10T23:00:00.000Z",
          expires_at: "2026-08-12T00:00:00.000Z",
          signal_type: "official_notice",
          confidence: 0.99,
          verification_status: "auto_unverified",
          is_reply: false,
        }]), { status: 200 });
      }
      if (method === "GET" && url.includes("regular_reset_events")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "GET" && url.includes("reset_execution_estimates")) {
        return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
      }
      if (method !== "GET" && url.includes("reset_execution_estimates")) {
        estimateWriteCount += 1;
      }
      return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
    };

    try {
      const response = await POST(buildRequest({
        observedAt: "2026-08-11T00:02:00.000Z",
        bankedResetAvailableCount: 1,
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: true, recovery: "no_recovery" });
      assert.equal(estimateWriteCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  }
});

test("bypass reproduction: without protocol v2 postReason, restarted monitor initial snapshot (40/B) with DB previous (60/A) falsely creates recovery estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "bypass-observation-id");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify({
        source_key: "local-codex-app-server",
        observed_at: "2026-09-10T00:00:00.000Z",
        received_at: "2026-09-10T00:00:01.000Z",
        limit_id: "codex",
        plan_type: "plus",
        used_percent: 60,
        window_duration_mins: 10080,
        resets_at: previousResetsAt,
        coverage_started_at: "2026-09-09T22:00:00.000Z",
        banked_reset_available_count: 1,
        last_banked_grant_at: null,
        updated_at: "2026-09-10T00:00:01.000Z",
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  try {
    // Legacy monitor behavior on restart: sends initial snapshot (40/B) without postReason or version
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 40,
      resetsAt: currentResetsAt,
    }));
    assert.equal(response.status, 200);
    const plan = getAtomicPlanFromRequests(requests);
    // Demonstrates legacy vulnerability: without postReason, unconfirmed initial snapshot is promoted to random reset
    assert.ok(plan.execution_estimate, "Bypass confirmed: server falsely creates reset estimate for unconfirmed snapshot");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

function createMockSupabaseFetch(options?: {
  previousState?: Record<string, unknown>;
  tiboSignals?: unknown[];
  regularEvents?: unknown[];
}) {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const defaultState = {
    source_key: "local-codex-app-server",
    observed_at: "2026-09-10T00:00:00.000Z",
    received_at: "2026-09-10T00:00:01.000Z",
    limit_id: "codex",
    plan_type: "plus",
    used_percent: 60,
    window_duration_mins: 10080,
    resets_at: previousResetsAt,
    coverage_started_at: "2026-09-09T22:00:00.000Z",
    banked_reset_available_count: 1,
    last_banked_grant_at: null,
    updated_at: "2026-09-10T00:00:01.000Z",
  };

  const fetchHandler = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, method, body });

    if (method === "POST" && url.includes(ATOMIC_RPC_PATH)) {
      return respondToAtomicRpc(body, "mock-observation-id");
    }
    if (method === "GET" && url.includes("codex_usage_monitor_state")) {
      return new Response(JSON.stringify(options?.previousState ?? defaultState), { status: 200 });
    }
    if (method === "GET" && url.includes("tibo_signals")) {
      return new Response(JSON.stringify(options?.tiboSignals ?? []), { status: 200 });
    }
    if (method === "GET" && url.includes("regular_reset_events")) {
      return new Response(JSON.stringify(options?.regularEvents ?? []), { status: 200 });
    }
    if (method === "GET" && url.includes("reset_execution_estimates")) {
      return new Response(JSON.stringify({ data: null, error: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: null, error: null }), { status: 201 });
  };

  return { requests, fetchHandler };
}

test("protocol v2 strict validation: rejects missing postReason with status 400", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 40,
      resetsAt: 1787617527,
      monitorProtocolVersion: 2,
    }));
    assert.equal(response.status, 400);
  } finally {
    restore();
  }
});

test("protocol v2 strict validation: rejects invalid postReason with status 400", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 40,
      resetsAt: 1787617527,
      monitorProtocolVersion: 2,
      postReason: "unauthorized_drop",
    }));
    assert.equal(response.status, 400);
  } finally {
    restore();
  }
});

test("protocol v2 strict validation: rejects invalid monitorProtocolVersion with status 400", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  try {
    for (const invalidVersion of [0, 3, -1, 99]) {
      const response = await POST(buildRequest({
        observedAt: "2026-09-10T00:02:00.000Z",
        usedPercent: 40,
        resetsAt: 1787617527,
        monitorProtocolVersion: invalidVersion,
        postReason: "recovery_candidate",
      }));
      assert.equal(response.status, 400);
    }
  } finally {
    restore();
  }
});

test("Test A: protocol v2 confirmed recovery (recovery_candidate) creates execution estimate and updates state", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 5,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "recovery_candidate",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "confirmed" });
    const executionEstimate = getAtomicPlanPart(requests, "execution_estimate");
    const observation = getAtomicPlanPart(requests, "observation");
    const state = getAtomicPlanPart(requests, "state");
    assert.ok(executionEstimate, "Confirmed recovery candidate must create an execution estimate");
    assert.equal(executionEstimate?.display_execution_at, "2026-09-10T00:02:00.000Z");
    assert.equal(executionEstimate?.is_monitor_observed, true);
    assert.equal(observation?.cycle_hint, "unexpected");
    assert.equal(state?.used_percent, 5);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test B: protocol v2 restart bypass regression (initial) updates baseline without creating execution estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 40,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "initial",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "initial" });
    const plan = getAtomicPlanFromRequests(requests);
    const state = getAtomicPlanPart(requests, "state");
    assert.equal(plan.execution_estimate, undefined, "Initial snapshot must NOT create execution estimate (bypass prevented)");
    assert.equal(plan.observation, undefined, "Initial snapshot must NOT create recovery observation row");
    assert.equal(state?.used_percent, 40, "Initial snapshot must update baseline in monitor state");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test C: protocol v2 heartbeat bypass regression (heartbeat) updates state without creating execution estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 40,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "heartbeat",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "heartbeat" });
    const plan = getAtomicPlanFromRequests(requests);
    const state = getAtomicPlanPart(requests, "state");
    assert.equal(plan.execution_estimate, undefined, "Heartbeat snapshot must NOT create execution estimate (bypass prevented)");
    assert.equal(state?.used_percent, 40, "Heartbeat snapshot must update monitor state");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test E: protocol v2 BANKED count change (banked_reset_count_change) creates banked distribution estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch({
    previousState: {
      source_key: "local-codex-app-server",
      observed_at: "2026-09-10T00:00:00.000Z",
      received_at: "2026-09-10T00:00:01.000Z",
      limit_id: "codex",
      plan_type: "plus",
      used_percent: 60,
      window_duration_mins: 10080,
      resets_at: previousResetsAt,
      coverage_started_at: "2026-09-09T22:00:00.000Z",
      banked_reset_available_count: 0,
      last_banked_grant_at: null,
      updated_at: "2026-09-10T00:00:01.000Z",
    },
    tiboSignals: [{
      tweet_id: "tibo-banked-v2-notice",
      text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
      tweet_url: "https://x.com/thsottiaux/status/tibo-banked-v2-notice",
      tweet_created_at: "2026-09-09T23:00:00.000Z",
      expires_at: "2026-09-11T00:00:00.000Z",
      signal_type: "official_notice",
      confidence: 0.99,
      verification_status: "auto_unverified",
      is_reply: false,
      expected_start_at: "2026-09-10T00:00:00.000Z",
      expected_end_at: "2026-09-10T23:59:59.000Z",
      temporal_resolution_status: "resolved",
    }],
  });
  globalThis.fetch = fetchHandler;

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 60,
      resetsAt: previousResetsAt,
      bankedResetAvailableCount: 1,
      bankedResetCountChange: true,
      monitorProtocolVersion: 2,
      postReason: "banked_reset_count_change",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "banked_distribution_observed" });
    const plan = getAtomicPlanFromRequests(requests);
    const bankedEstimate = getAtomicPlanPart(requests, "banked_distribution_estimate");
    const state = getAtomicPlanPart(requests, "state");
    assert.ok(bankedEstimate, "Banked count change must create banked distribution estimate");
    assert.equal(plan.execution_estimate, undefined, "Banked count change must not create weekly recovery estimate");
    assert.equal(state?.banked_reset_available_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test F: protocol v2 structure change (structure_change) updates state without creating recovery estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      planType: "pro",
      usedPercent: 40,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "structure_change",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "structure_change" });
    const plan = getAtomicPlanFromRequests(requests);
    const state = getAtomicPlanPart(requests, "state");
    assert.equal(plan.execution_estimate, undefined, "Structure change must not create execution estimate");
    assert.equal(state?.plan_type, "pro");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test G: protocol v2 stale snapshot with recovery_candidate returns ignored_stale", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    // DB has observed_at: "2026-09-10T00:00:00.000Z"
    // Stale snapshot has earlier observedAt: "2026-09-09T23:59:00.000Z"
    const response = await POST(buildRequest({
      observedAt: "2026-09-09T23:59:00.000Z",
      usedPercent: 5,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "recovery_candidate",
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "ignored_stale" });
    assert.equal(requests.some((r) => r.method === "POST" && r.url.includes(ATOMIC_RPC_PATH)), false);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test H: protocol v2 firstEvidence chronology is preserved in reset execution estimate", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    // Candidate started at t=0s ("2026-09-10T00:00:30.000Z" with 5% usage).
    // Confirmed at t=120s by local monitor.
    // Local monitor posts the firstEvidence snapshot:
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:00:30.000Z",
      usedPercent: 5,
      resetsAt: currentResetsAt,
      monitorProtocolVersion: 2,
      postReason: "recovery_candidate",
    }));
    assert.equal(response.status, 200);
    const executionEstimate = getAtomicPlanPart(requests, "execution_estimate");
    assert.ok(executionEstimate);
    // Display execution time strictly preserves the initial detection moment (t=0s), not confirmation time
    assert.equal(executionEstimate?.display_execution_at, "2026-09-10T00:00:30.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Test I: legacy protocol v1 compatibility allows fallback evaluation without version or postReason", async () => {
  const restore = withEnvironment({
    CODEX_USAGE_MONITOR_SECRET: "monitor-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
  });
  const originalFetch = globalThis.fetch;
  const previousResetsAt = Math.floor(Date.parse("2026-09-11T03:55:00.000Z") / 1000);
  const currentResetsAt = Math.floor(Date.parse("2026-09-18T03:55:00.000Z") / 1000);
  const { requests, fetchHandler } = createMockSupabaseFetch();
  globalThis.fetch = fetchHandler;

  try {
    // Legacy client payload: no monitorProtocolVersion, no postReason
    // Arithmetic drop: 60% -> 5%, resetsAt +7d
    const response = await POST(buildRequest({
      observedAt: "2026-09-10T00:02:00.000Z",
      usedPercent: 5,
      resetsAt: currentResetsAt,
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, recovery: "confirmed" });
    const plan = getAtomicPlanFromRequests(requests);
    assert.ok(plan.execution_estimate, "Legacy client arithmetic recovery accepted for zero-downtime deploy");

    // Legacy client payload with no recovery: 60% -> 60%, resetsAt unchanged
    requests.length = 0;
    const noRecoveryResponse = await POST(buildRequest({
      observedAt: "2026-09-10T00:04:00.000Z",
      usedPercent: 60,
      resetsAt: previousResetsAt,
    }));
    assert.equal(noRecoveryResponse.status, 200);
    assert.deepEqual(await noRecoveryResponse.json(), { accepted: true, recovery: "no_recovery" });
    const noRecoveryPlan = getAtomicPlanFromRequests(requests);
    assert.equal(noRecoveryPlan.execution_estimate, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
