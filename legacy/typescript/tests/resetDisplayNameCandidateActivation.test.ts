import assert from "node:assert/strict";
import test from "node:test";
import {
  isResetDisplayNameCandidateOperationEnabled,
  isResetDisplayNameCandidateNoticeAfterAdoption,
  readResetDisplayNameCandidateActivation,
} from "../lib/radar/resetDisplayNameCandidateActivation";

test("missing activation configuration fails closed to off", () => {
  assert.deepEqual(readResetDisplayNameCandidateActivation({}), { mode: "off", adoptionAt: null });
});

test("invalid mode or cutoff fails closed to off", () => {
  assert.deepEqual(
    readResetDisplayNameCandidateActivation({
      RESET_DISPLAY_NAME_CANDIDATE_MODE: "unsafe",
      RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT: "2026-09-08T00:00:00.000Z",
    }),
    { mode: "off", adoptionAt: null },
  );
  assert.deepEqual(
    readResetDisplayNameCandidateActivation({
      RESET_DISPLAY_NAME_CANDIDATE_MODE: "seed",
      RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT: "not-a-date",
    }),
    { mode: "off", adoptionAt: null },
  );
});

test("parseable non-ISO and impossible ISO-like cutoffs fail closed", () => {
  for (const adoptionAt of ["09/08/2026", "2026-02-30T00:00:00.000Z", "2026-09-08 00:00:00Z"]) {
    assert.deepEqual(
      readResetDisplayNameCandidateActivation({
        RESET_DISPLAY_NAME_CANDIDATE_MODE: "seed",
        RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT: adoptionAt,
      }),
      { mode: "off", adoptionAt: null },
    );
  }
});

test("seed activation requires a valid adoption cutoff", () => {
  assert.deepEqual(
    readResetDisplayNameCandidateActivation({
      RESET_DISPLAY_NAME_CANDIDATE_MODE: "seed",
      RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT: "2026-09-08T00:00:00.000Z",
    }),
    { mode: "seed", adoptionAt: "2026-09-08T00:00:00.000Z" },
  );
});

test("full activation requires a valid adoption cutoff", () => {
  assert.deepEqual(
    readResetDisplayNameCandidateActivation({
      RESET_DISPLAY_NAME_CANDIDATE_MODE: "full",
      RESET_DISPLAY_NAME_CANDIDATE_ADOPTION_AT: "2026-09-08T00:00:00.000Z",
    }),
    { mode: "full", adoptionAt: "2026-09-08T00:00:00.000Z" },
  );
});

test("seed enables only seed operations while full enables generation and promotion", () => {
  const seed = { mode: "seed" as const, adoptionAt: "2026-09-08T00:00:00.000Z" };
  const full = { mode: "full" as const, adoptionAt: "2026-09-08T00:00:00.000Z" };
  assert.equal(isResetDisplayNameCandidateOperationEnabled(seed, "seed"), true);
  assert.equal(isResetDisplayNameCandidateOperationEnabled(seed, "generate"), false);
  assert.equal(isResetDisplayNameCandidateOperationEnabled(seed, "promote"), false);
  assert.equal(isResetDisplayNameCandidateOperationEnabled(full, "seed"), true);
  assert.equal(isResetDisplayNameCandidateOperationEnabled(full, "generate"), true);
  assert.equal(isResetDisplayNameCandidateOperationEnabled(full, "promote"), true);
});

test("notice cutoff is inclusive and uses tweet_created_at", () => {
  const adoptionAt = "2026-09-08T00:00:00.000Z";
  assert.equal(isResetDisplayNameCandidateNoticeAfterAdoption(adoptionAt, adoptionAt), true);
  assert.equal(
    isResetDisplayNameCandidateNoticeAfterAdoption("2026-09-07T23:59:59.999Z", adoptionAt),
    false,
  );
  assert.equal(
    isResetDisplayNameCandidateNoticeAfterAdoption("2026-09-08T00:00:00.001Z", adoptionAt),
    true,
  );
});

test("invalid notice timestamps are never eligible", () => {
  assert.equal(
    isResetDisplayNameCandidateNoticeAfterAdoption("not-a-date", "2026-09-08T00:00:00.000Z"),
    false,
  );
  assert.equal(
    isResetDisplayNameCandidateNoticeAfterAdoption("2026-09-08T00:00:00.000Z", "not-a-date"),
    false,
  );
});
