import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_OPENAI_STATUS_HISTORY } from "../data/statusHistory";
import { fetchOpenAIStatusSignals } from "../lib/openaiStatus";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("retains stored history when both status requests fail", async () => {
  const result = await fetchOpenAIStatusSignals({}, async () => {
    throw new Error("raw network failure details");
  });

  assert.deepStrictEqual(result.data.history, LOCAL_OPENAI_STATUS_HISTORY);
  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "request_failed",
  });
  assert.equal(result.data.codexOperationalStatus, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /raw network failure details/);
});

function statusFixtureFetch(
  incident: Record<string, unknown> | null,
  components: Array<Record<string, unknown>> = [
    { name: "Codex Web", status: "operational" },
    { name: "Codex API", status: "operational" },
  ],
) {
  return async (url: string | URL | Request) => {
    if (String(url).includes("summary.json")) {
      return jsonResponse({
        page: { updated_at: new Date().toISOString() },
        components,
      });
    }

    return jsonResponse({
      page: { updated_at: new Date().toISOString() },
      incidents: incident ? [incident] : [],
    });
  };
}

function relativeIso(hoursAgo: number) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function codexIncident(overrides: Record<string, unknown> = {}) {
  return {
    id: "codex-status-fixture",
    name: "Investigating an unexpected service issue",
    status: "monitoring",
    impact: "minor",
    created_at: relativeIso(2),
    updated_at: relativeIso(1),
    resolved_at: null,
    incident_updates: [
      {
        body: "Some Codex users may be experiencing unexpected usage limit resets.",
        status: "monitoring",
        created_at: relativeIso(1),
        updated_at: relativeIso(1),
      },
    ],
    ...overrides,
  };
}

test("keeps an explicit unresolved Codex incident active for display when components are operational", async () => {
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch(codexIncident()),
  );

  assert.ok(
    result.data.history.some((item) => item.id === "codex-status-fixture"),
  );
  assert.equal(result.data.suppressCodexIncidents, true);
  assert.equal(result.data.activeCodexIncidents, 0);
  assert.equal(result.data.codexOperationalStatus, "active");
});

test("treats a non-operational Codex component as an active display condition", async () => {
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch(null, [{ name: "Codex Web", status: "degraded" }]),
  );

  assert.equal(result.data.codexOperationalStatus, "active");
});

test("marks a Codex incident resolved within twelve hours as recovered", async () => {
  const resolvedAt = relativeIso(6);
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch(
      codexIncident({
        status: "resolved",
        updated_at: resolvedAt,
        resolved_at: resolvedAt,
      }),
    ),
  );

  assert.equal(result.data.codexOperationalStatus, "recovered");
});

test("does not keep an older resolved Codex mention active or recovered", async () => {
  const resolvedAt = relativeIso(13);
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch(
      codexIncident({
        status: "resolved",
        updated_at: resolvedAt,
        resolved_at: resolvedAt,
      }),
    ),
  );

  assert.equal(result.data.codexOperationalStatus, "none");
});

test("does not classify a ChatGPT-only incident as a Codex display incident", async () => {
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch({
      id: "chatgpt-status-fixture",
      name: "ChatGPT conversation errors",
      status: "monitoring",
      impact: "minor",
      created_at: relativeIso(1),
      updated_at: relativeIso(1),
      resolved_at: null,
      incident_updates: [
        { body: "Some ChatGPT users may be affected.", status: "monitoring" },
      ],
    }),
  );

  assert.equal(result.data.codexOperationalStatus, "none");
  assert.equal(
    result.data.history.some((item) => item.id === "chatgpt-status-fixture"),
    false,
  );
});

test("excludes a FedRAMP-only Codex incident from the general display status", async () => {
  const result = await fetchOpenAIStatusSignals(
    {},
    statusFixtureFetch({
      id: "fedramp-status-fixture",
      name: "FedRAMP workspace issue",
      status: "monitoring",
      impact: "minor",
      created_at: relativeIso(1),
      updated_at: relativeIso(1),
      resolved_at: null,
      incident_updates: [
        {
          body: "Some Codex users in FedRAMP workspaces may be affected.",
          status: "monitoring",
        },
      ],
    }),
  );

  assert.equal(result.data.codexOperationalStatus, "none");
  assert.equal(
    result.data.history.some((item) => item.id === "fedramp-status-fixture"),
    false,
  );
});

test("classifies two non-JSON status responses as invalid", async () => {
  const result = await fetchOpenAIStatusSignals({}, async () =>
    new Response("not json", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  );

  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "invalid_response",
  });
});

test("classifies malformed JSON status responses as invalid", async () => {
  const result = await fetchOpenAIStatusSignals({}, async () =>
    new Response("{ malformed", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "invalid_response",
  });
});

test("classifies valid JSON objects with missing status payload fields as invalid", async () => {
  const result = await fetchOpenAIStatusSignals({}, async () =>
    jsonResponse({}),
  );

  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "invalid_response",
  });
});

test("classifies non-record status entries as invalid", async () => {
  const result = await fetchOpenAIStatusSignals({}, async (url) => {
    if (String(url).includes("summary.json")) {
      return jsonResponse({
        page: { updated_at: "2026-08-01T00:00:00.000Z" },
        components: [null],
      });
    }

    return jsonResponse({
      page: { updated_at: "2026-08-01T00:00:00.000Z" },
      incidents: [
        {
          name: "Codex incident",
          incident_updates: [null],
        },
      ],
    });
  });

  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "invalid_response",
  });
});

test("marks one usable status response as partial", async () => {
  let request = 0;
  const result = await fetchOpenAIStatusSignals({}, async () => {
    request += 1;
    if (request === 1) {
      return jsonResponse({
        page: { updated_at: "2026-08-01T00:00:00.000Z" },
        components: [{ name: "Codex", status: "operational" }],
      });
    }

    throw new Error("network failure");
  });

  assert.deepStrictEqual(result.health, {
    state: "degraded",
    detail: "partial_response",
  });
  assert.equal(result.data.suppressCodexIncidents, true);
});

test("marks two usable status responses as ok", async () => {
  let request = 0;
  const result = await fetchOpenAIStatusSignals({}, async () => {
    request += 1;
    return request === 1
      ? jsonResponse({
          page: { updated_at: "2026-08-01T00:00:00.000Z" },
          components: [{ name: "Codex", status: "operational" }],
        })
      : jsonResponse({
          page: { updated_at: "2026-08-01T00:00:00.000Z" },
          incidents: [],
        });
  });

  assert.deepStrictEqual(result.health, { state: "ok" });
  assert.deepStrictEqual(result.data.history, LOCAL_OPENAI_STATUS_HISTORY);
});
