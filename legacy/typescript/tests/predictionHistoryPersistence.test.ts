import assert from "node:assert/strict";
import test from "node:test";

import { savePredictionHistoryOnce } from "../lib/predictionHistoryPersistence";

type FakeResult = { data: unknown; error: unknown };

function createFakeClient(insertResult: FakeResult, existingResult: FakeResult) {
  const calls: Array<{ method: string; options?: unknown }> = [];
  const client = {
    calls,
    from(table: string) {
      assert.equal(table, "prediction_history");
      return {
        insert(_row: unknown, options: unknown) {
          calls.push({ method: "insert", options });
          return {
            select(_fields: string) {
              return Promise.resolve(insertResult);
            },
          };
        },
        select(_fields: string) {
          return {
            eq(_column: string, _value: string) {
              return {
                maybeSingle() {
                  calls.push({ method: "select-existing" });
                  return Promise.resolve(existingResult);
                },
              };
            },
          };
        },
      };
    },
  };
  return client;
}

const row = {
  logged_hour: "2026-08-20T11:00:00.000Z",
  probability_24h: 0.2,
  probability_48h: 0.4,
};

test("prediction history inserts an empty logged hour without using upsert", async () => {
  const client = createFakeClient({
    data: [{ logged_hour: row.logged_hour, recorded_at: "2026-08-20T11:00:02.000Z" }],
    error: null,
  }, { data: null, error: null });

  const result = await savePredictionHistoryOnce(client, row);

  assert.deepEqual(result, {
    action: "inserted",
    loggedHour: row.logged_hour,
    recordedAt: "2026-08-20T11:00:02.000Z",
  });
  assert.deepEqual(client.calls, [
    { method: "insert", options: { onConflict: "logged_hour", ignoreDuplicates: true } },
  ]);
});

test("a duplicate logged hour returns the original row without updating it", async () => {
  const client = createFakeClient(
    { data: [], error: null },
    { data: { logged_hour: row.logged_hour, recorded_at: "2026-08-20T11:00:02.000Z" }, error: null },
  );

  const result = await savePredictionHistoryOnce(client, {
    ...row,
    probability_24h: 0.99,
    probability_48h: 0.99,
  });

  assert.deepEqual(result, {
    action: "already_logged",
    loggedHour: row.logged_hour,
    recordedAt: "2026-08-20T11:00:02.000Z",
  });
  assert.equal(client.calls[0].method, "insert");
  assert.equal(client.calls[1].method, "select-existing");
});

test("a duplicate-key race is converted to already_logged without a second write", async () => {
  const client = createFakeClient(
    { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
    { data: { logged_hour: row.logged_hour, recorded_at: "2026-08-20T11:00:02.000Z" }, error: null },
  );

  const result = await savePredictionHistoryOnce(client, row);

  assert.equal(result.action, "already_logged");
  assert.equal(result.recordedAt, "2026-08-20T11:00:02.000Z");
  assert.deepEqual(client.calls.map((call) => call.method), ["insert", "select-existing"]);
});
