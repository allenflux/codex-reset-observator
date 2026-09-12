import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_WEEKLY_WINDOW_MINUTES,
  canCorroborateTiboReset,
  MAX_USAGE_COMPARISON_GAP_MS,
  RESET_AT_MEANINGFUL_FORWARD_SEC,
  REGULAR_RESET_PROXIMITY_MS,
  UNCONFIRMED_RECOVERY_ACTIVE_MS,
  evaluateCodexUsageRecovery,
  doesTiboResetMatchUsageObservation,
  getPublicRecoveryObservation,
  isCodexUsageAuthorizationValid,
  parseCodexRateLimitsResponse,
  parseCodexUsageWebhookPayload,
  type CodexRecoveryObservation,
  type CodexUsageSnapshot,
} from "../lib/codexUsageRecovery";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function snapshot(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    observedAt: "2026-08-11T00:00:00.000Z",
    limitId: "codex",
    planType: "plus",
    usedPercent: 69,
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
    ...overrides,
  };
}

function previous(overrides: Partial<CodexUsageSnapshot> = {}) {
  return snapshot({
    observedAt: "2026-08-10T23:58:00.000Z",
    usedPercent: 69,
    resetsAt: Math.floor(Date.parse("2026-08-12T00:00:00.000Z") / 1000),
    ...overrides,
  });
}

function recovery(overrides: Partial<CodexRecoveryObservation> = {}): CodexRecoveryObservation {
  return {
    id: "recovery-1",
    sourceKey: "local-codex-app-server",
    observedAt: "2026-08-11T00:00:00.000Z",
    previousUsedPercent: 69,
    currentUsedPercent: 0,
    previousResetsAt: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000),
    currentResetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
    cycleHint: "unexpected",
    confidence: "strong",
    status: "observed",
    matchedTiboTweetId: null,
    confirmedAt: null,
    ...overrides,
  };
}

function validRateLimitResponse(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: {
          usedPercent: 3,
          windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
          resetsAt: 1787012727,
        },
        secondary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: 1786500000,
        },
      },
      ...overrides,
    },
  };
}

test("selects the weekly window instead of assuming primary or secondary", () => {
  const parsed = parseCodexRateLimitsResponse(validRateLimitResponse(), NOW);
  assert.equal(parsed?.windowDurationMins, CODEX_WEEKLY_WINDOW_MINUTES);
  assert.equal(parsed?.usedPercent, 3);
  assert.equal(parsed?.resetsAt, 1787012727);
});

test("ignores ordinary credits when the reset-credit field is absent", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimits: {
        ...validRateLimitResponse().result.rateLimits,
        credits: { hasCredits: true, unlimited: false, balance: "1" },
      },
    },
  }, NOW);

  assert.equal(parsed?.bankedResetAvailableCount, null);
  assert.equal(parsed?.bankedResetDisplayCount, null);
  assert.equal(parsed?.bankedResetCountSource, "unavailable");
});

test("parses an explicit BANKED reset available count without inferring it from credits", () => {
  for (const availableCount of [0, 1, 2]) {
    const parsed = parseCodexRateLimitsResponse({
      result: {
        rateLimitResetCredits: { availableCount },
        rateLimits: {
          ...validRateLimitResponse().result.rateLimits,
          credits: { hasCredits: true, unlimited: false, balance: "1" },
        },
      },
    }, NOW);

    assert.equal(parsed?.bankedResetAvailableCount, availableCount);
    assert.equal(parsed?.bankedResetDisplayCount, availableCount);
    assert.equal(parsed?.bankedResetCountSource, "explicit");
  }
});

test("explicit BANKED reset count takes precedence over availability fallback", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimitResetCredits: { availableCount: 0 },
      rateLimits: {
        ...validRateLimitResponse().result.rateLimits,
        credits: { hasCredits: true, unlimited: false, balance: "2" },
      },
    },
  }, NOW);

  assert.equal(parsed?.bankedResetAvailableCount, 0);
  assert.equal(parsed?.bankedResetDisplayCount, 0);
  assert.equal(parsed?.bankedResetCountSource, "explicit");
});

test("keeps the weekly snapshot valid and returns no BANKED count for missing or unsupported fields", () => {
  const values: unknown[] = [
    undefined,
    null,
    {},
    { availableCount: -1 },
    { availableCount: 1.5 },
    { availableCount: "1" },
    { availableCount: Number.NaN },
  ];

  for (const rateLimitResetCredits of values) {
    const rateLimits = {
      ...validRateLimitResponse().result.rateLimits,
    };
    const parsed = parseCodexRateLimitsResponse({
      result: { rateLimits, rateLimitResetCredits },
    }, NOW);

    assert.ok(parsed);
    assert.equal(parsed.bankedResetAvailableCount, null);
    assert.equal(parsed.bankedResetDisplayCount, null);
    assert.equal(parsed.bankedResetCountSource, "unavailable");
  }
});

test("normal credits never affect the BANKED reset count", () => {
  const cases = [
    { hasCredits: false, unlimited: false, balance: "2" },
    { hasCredits: true, unlimited: false, balance: "0" },
    { hasCredits: true, unlimited: true, balance: "2" },
  ] as const;

  for (const credits of cases) {
    const parsed = parseCodexRateLimitsResponse({
      result: {
        rateLimits: {
          ...validRateLimitResponse().result.rateLimits,
          credits,
        },
      },
    }, NOW);

    assert.equal(parsed?.bankedResetDisplayCount, null);
    assert.equal(parsed?.bankedResetCountSource, "unavailable");
  }
});

test("keeps the weekly usage snapshot valid when app-server has no credit object", () => {
  const parsed = parseCodexRateLimitsResponse(validRateLimitResponse(), NOW);
  assert.equal(parsed?.bankedResetDisplayCount, null);
  assert.equal(parsed?.bankedResetCountSource, "unavailable");
});

test("ignores malformed credit metadata without rejecting the weekly usage window", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimits: {
        ...validRateLimitResponse().result.rateLimits,
        credits: { hasCredits: "yes", unlimited: false, balance: "1" },
      },
    },
  }, NOW);

  assert.ok(parsed);
  assert.equal(parsed.bankedResetDisplayCount, null);
});

test("selects a weekly secondary window when primary is short", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1786500000 },
        secondary: { usedPercent: 69, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012727 },
      },
    },
  }, NOW);
  assert.equal(parsed?.usedPercent, 69);
});

test("prefers the codex limit when multiple limit buckets are present", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimitsByLimitId: {
        other: { limitId: "other", planType: "plus", primary: { usedPercent: 2, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012000 } },
        codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 3, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012727 } },
      },
    },
  }, NOW);
  assert.equal(parsed?.limitId, "codex");
  assert.equal(parsed?.usedPercent, 3);
});

test("rejects ambiguous multiple weekly windows without a codex preference", () => {
  const parsed = parseCodexRateLimitsResponse({
    result: {
      rateLimitsByLimitId: {
        one: { limitId: "one", planType: "plus", primary: { usedPercent: 2, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012000 } },
        two: { limitId: "two", planType: "plus", primary: { usedPercent: 3, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012727 } },
      },
    },
  }, NOW);
  assert.equal(parsed, null);
});

test("rejects a response with no weekly window", () => {
  assert.equal(parseCodexRateLimitsResponse({ result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1786500000 } } } }, NOW), null);
});

test("rejects a missing rate limit response", () => {
  assert.equal(parseCodexRateLimitsResponse({ result: {} }, NOW), null);
});

test("rejects a weekly used percentage below zero", () => {
  assert.equal(parseCodexRateLimitsResponse(validRateLimitResponse({ rateLimits: { ...validRateLimitResponse().result.rateLimits, primary: { usedPercent: -1, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012727 } } }), NOW), null);
});

test("rejects a weekly used percentage above one hundred", () => {
  assert.equal(parseCodexRateLimitsResponse(validRateLimitResponse({ rateLimits: { ...validRateLimitResponse().result.rateLimits, primary: { usedPercent: 101, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 1787012727 } } }), NOW), null);
});

test("rejects an invalid weekly reset timestamp", () => {
  assert.equal(parseCodexRateLimitsResponse(validRateLimitResponse({ rateLimits: { ...validRateLimitResponse().result.rateLimits, primary: { usedPercent: 3, windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES, resetsAt: 0 } } }), NOW), null);
});

test("accepts only the fixed weekly window length", () => {
  assert.equal(CODEX_WEEKLY_WINDOW_MINUTES, 10080);
});

test("validates the monitor payload and preserves only safe fields", () => {
  const parsed = parseCodexUsageWebhookPayload({
    observedAt: NOW.toISOString(),
    limitId: "codex",
    planType: "plus",
    usedPercent: 3,
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt: 1787012727,
  }, NOW);
  assert.deepEqual(parsed, {
    observedAt: NOW.toISOString(),
    limitId: "codex",
    planType: "plus",
    usedPercent: 3,
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt: 1787012727,
  });
});

test("accepts an explicit BANKED reset count change marker", () => {
  const parsed = parseCodexUsageWebhookPayload({
    ...snapshot(),
    bankedResetAvailableCount: 1,
    bankedResetCountChange: true,
  }, NOW);

  assert.equal(parsed?.bankedResetAvailableCount, 1);
  assert.equal(parsed?.bankedResetCountChange, true);
});

test("accepts protocol v2 payload with valid postReason", () => {
  for (const reason of [
    "initial",
    "recovery_candidate",
    "banked_reset_count_change",
    "structure_change",
    "heartbeat",
  ] as const) {
    const parsed = parseCodexUsageWebhookPayload({
      ...snapshot(),
      monitorProtocolVersion: 2,
      postReason: reason,
    }, NOW);
    assert.equal(parsed?.monitorProtocolVersion, 2);
    assert.equal(parsed?.postReason, reason);
  }
});

test("protocol v2 strict validation: rejects missing or invalid postReason", () => {
  // Missing postReason when monitorProtocolVersion === 2
  assert.equal(parseCodexUsageWebhookPayload({
    ...snapshot(),
    monitorProtocolVersion: 2,
  }, NOW), null);

  // Invalid postReason string
  assert.equal(parseCodexUsageWebhookPayload({
    ...snapshot(),
    monitorProtocolVersion: 2,
    postReason: "unauthorized_drop",
  }, NOW), null);

  // Invalid protocol version
  assert.equal(parseCodexUsageWebhookPayload({
    ...snapshot(),
    monitorProtocolVersion: 3,
    postReason: "recovery_candidate",
  }, NOW), null);

  assert.equal(parseCodexUsageWebhookPayload({
    ...snapshot(),
    monitorProtocolVersion: 0,
    postReason: "recovery_candidate",
  }, NOW), null);
});

test("rejects generic credits in the webhook payload", () => {
  assert.equal(parseCodexUsageWebhookPayload({
    ...snapshot(),
    bankedCredit: { available: true, unlimited: false, balance: "1" },
    bankedCreditChange: true,
  }, NOW), null);
});

test("rejects unknown webhook fields", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), email: "private@example.com" }, NOW), null);
});

test("rejects personal identifiers in the webhook payload", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), accountId: "private" }, NOW), null);
});

test("rejects a future observation beyond the five minute clock skew", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), observedAt: new Date(NOW.getTime() + 6 * 60 * 1000).toISOString() }, NOW), null);
});

test("rejects a non-Codex limit id", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), limitId: "other" }, NOW), null);
});

test("rejects a non-weekly webhook window", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), windowDurationMins: 300 }, NOW), null);
});

test("rejects an invalid plan type", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), planType: "x".repeat(65) }, NOW), null);
});

test("rejects an invalid webhook reset timestamp", () => {
  assert.equal(parseCodexUsageWebhookPayload({ ...snapshot(), resetsAt: -1 }, NOW), null);
});

test("accepts the expected bearer secret", () => {
  assert.equal(isCodexUsageAuthorizationValid("Bearer secret", "secret"), true);
});

test("rejects a missing bearer secret", () => {
  assert.equal(isCodexUsageAuthorizationValid(null, "secret"), false);
});

test("rejects a wrong bearer secret", () => {
  assert.equal(isCodexUsageAuthorizationValid("Bearer wrong", "secret"), false);
});

test("initial snapshot is baseline only", () => {
  assert.deepEqual(evaluateCodexUsageRecovery(null, snapshot()), { kind: "baseline" });
});

test("a previous snapshot older than the comparison gap rebases without recovery", () => {
  const result = evaluateCodexUsageRecovery(
    previous({ observedAt: new Date(NOW.getTime() - MAX_USAGE_COMPARISON_GAP_MS - 1).toISOString() }),
    snapshot(),
  );
  assert.equal(result.kind, "rebase");
});

test("an out-of-order snapshot is ignored", () => {
  const result = evaluateCodexUsageRecovery(previous(), previous({ observedAt: "2026-08-10T23:57:00.000Z" }));
  assert.equal(result.kind, "stale");
});

test("a 69 to zero decrease with a forward reset is recovery", () => {
  const result = evaluateCodexUsageRecovery(previous(), snapshot({ usedPercent: 0 }), { activeOfficialNotice: false });
  assert.equal(result.kind, "recovery");
  assert.equal(result.cycleHint, "unexpected");
  assert.equal(result.confidence, "strong");
});

test("a 3 to zero decrease with a forward reset is recovery", () => {
  const result = evaluateCodexUsageRecovery(previous({ usedPercent: 3 }), snapshot({ usedPercent: 0 }), { activeOfficialNotice: false });
  assert.equal(result.kind, "recovery");
});

test("a forward reset with unchanged usage is not recovery", () => {
  const result = evaluateCodexUsageRecovery(previous(), snapshot({ usedPercent: 69 }), { activeOfficialNotice: false });
  assert.equal(result.kind, "no_recovery");
});

test("a usage decrease with an unchanged reset timestamp is not recovery", () => {
  const result = evaluateCodexUsageRecovery(previous(), snapshot({ usedPercent: 68, resetsAt: previous().resetsAt }), { activeOfficialNotice: false });
  assert.equal(result.kind, "no_recovery");
});

test("ignores small forward and backward reset timestamp jitter", () => {
  const resetAtValues = [2727, 2728, 2727, 2726, 2728];
  let prior = previous({ usedPercent: 4, resetsAt: resetAtValues[0] });

  for (let index = 1; index < resetAtValues.length; index += 1) {
    const resetsAt = resetAtValues[index];
    const current = snapshot({
      observedAt: new Date(NOW.getTime() + (index + 1) * 60 * 1000).toISOString(),
      usedPercent: 4,
      resetsAt,
    });
    assert.equal(evaluateCodexUsageRecovery(prior, current).kind, "no_recovery");
    prior = current;
  }
});

test("requires a meaningful reset timestamp advance", () => {
  const base = previous({ usedPercent: 4, resetsAt: 1_000_000 });
  assert.equal(evaluateCodexUsageRecovery(base, snapshot({ usedPercent: 3, resetsAt: 1_000_001 })).kind, "no_recovery");
  assert.equal(evaluateCodexUsageRecovery(base, snapshot({ usedPercent: 3, resetsAt: 1_000_002 })).kind, "no_recovery");
  assert.equal(evaluateCodexUsageRecovery(base, snapshot({ usedPercent: 3, resetsAt: 999_999 })).kind, "no_recovery");
  assert.equal(evaluateCodexUsageRecovery(base, snapshot({ usedPercent: 3, resetsAt: 1_000_000 + RESET_AT_MEANINGFUL_FORWARD_SEC - 1 })).kind, "no_recovery");
  assert.equal(evaluateCodexUsageRecovery(base, snapshot({ usedPercent: 3, resetsAt: 1_000_000 + RESET_AT_MEANINGFUL_FORWARD_SEC })).kind, "recovery");
});

test("a less than one point usage change is not recovery", () => {
  const result = evaluateCodexUsageRecovery(previous({ usedPercent: 69.5 }), snapshot({ usedPercent: 68.6 }), { activeOfficialNotice: false });
  assert.equal(result.kind, "no_recovery");
});

test("a near-regular recovery two minutes after schedule is regular medium", () => {
  const result = evaluateCodexUsageRecovery(previous({ observedAt: "2026-08-10T23:58:00.000Z", resetsAt: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000) }), snapshot({ observedAt: "2026-08-11T00:02:00.000Z", usedPercent: 0 }), { activeOfficialNotice: false });
  if (result.kind !== "recovery") throw new Error(`expected recovery, got ${result.kind}`);
  assert.equal(result.cycleHint, "regular");
  assert.equal(result.confidence, "medium");
  assert.equal(result.nearRegularSchedule, true);
});

test("a regular-proximate recovery with notice is unknown strong", () => {
  const result = evaluateCodexUsageRecovery(previous({ resetsAt: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000) }), snapshot({ usedPercent: 0 }), { activeOfficialNotice: true });
  if (result.kind !== "recovery") throw new Error(`expected recovery, got ${result.kind}`);
  assert.equal(result.cycleHint, "unknown");
  assert.equal(result.confidence, "strong");
});

test("only a clearly unexpected recovery can corroborate a Tibo reset", () => {
  const regular = evaluateCodexUsageRecovery(
    previous({ resetsAt: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000) }),
    snapshot({ usedPercent: 0 }),
    { activeOfficialNotice: false },
  );
  const regularWithNotice = evaluateCodexUsageRecovery(
    previous({ resetsAt: Math.floor(Date.parse("2026-08-11T00:00:00.000Z") / 1000) }),
    snapshot({ usedPercent: 0 }),
    { activeOfficialNotice: true },
  );
  const unexpected = evaluateCodexUsageRecovery(
    previous({ resetsAt: Math.floor(Date.parse("2026-08-12T00:00:00.000Z") / 1000) }),
    snapshot({ usedPercent: 0 }),
    { activeOfficialNotice: true },
  );

  assert.equal(canCorroborateTiboReset(regular), false);
  assert.equal(canCorroborateTiboReset(regularWithNotice), false);
  assert.equal(canCorroborateTiboReset(unexpected), true);
});

test("an unexpected recovery with notice is unexpected strong", () => {
  const result = evaluateCodexUsageRecovery(previous({ resetsAt: Math.floor(Date.parse("2026-08-12T00:00:00.000Z") / 1000) }), snapshot({ usedPercent: 0 }), { activeOfficialNotice: true });
  if (result.kind !== "recovery") throw new Error(`expected recovery, got ${result.kind}`);
  assert.equal(result.cycleHint, "unexpected");
  assert.equal(result.confidence, "strong");
});

test("an unexpected recovery without notice is unexpected strong", () => {
  const result = evaluateCodexUsageRecovery(previous({ resetsAt: Math.floor(Date.parse("2026-08-12T00:00:00.000Z") / 1000) }), snapshot({ usedPercent: 0 }), { activeOfficialNotice: false });
  if (result.kind !== "recovery") throw new Error(`expected recovery, got ${result.kind}`);
  assert.equal(result.cycleHint, "unexpected");
  assert.equal(result.confidence, "strong");
});

test("regular proximity uses an inclusive five-minute boundary", () => {
  const resetAt = Date.parse("2026-08-11T13:00:00.000Z");
  const cases = [
    { label: "minus five minutes", offsetMs: -5 * 60 * 1000, expected: true },
    { label: "plus five minutes", offsetMs: 5 * 60 * 1000, expected: true },
    { label: "minus five minutes and one second", offsetMs: -(5 * 60 * 1000 + 1_000), expected: false },
    { label: "plus five minutes and one second", offsetMs: 5 * 60 * 1000 + 1_000, expected: false },
  ];

  for (const { label, offsetMs, expected } of cases) {
    const currentTime = resetAt + offsetMs;
    const result = evaluateCodexUsageRecovery(
      previous({
        observedAt: new Date(currentTime - 2 * 60 * 1000).toISOString(),
        resetsAt: Math.floor(resetAt / 1000),
      }),
      snapshot({
        observedAt: new Date(currentTime).toISOString(),
        usedPercent: 0,
        resetsAt: Math.floor((resetAt + 60 * 60 * 1000) / 1000),
      }),
      { activeOfficialNotice: false },
    );
    if (result.kind !== "recovery") throw new Error(`${label}: expected recovery, got ${result.kind}`);
    assert.equal(result.nearRegularSchedule, expected, label);
  }
});

test("the first observation never produces a recovery event", () => {
  assert.equal(evaluateCodexUsageRecovery(null, snapshot({ usedPercent: 0 })).kind, "baseline");
});

test("a strong unexpected observation becomes public provisional state", () => {
  const publicObservation = getPublicRecoveryObservation(recovery(), NOW);
  assert.deepEqual(publicObservation, {
    status: "observed_unconfirmed",
    observedAt: "2026-08-11T00:00:00.000Z",
    confidence: "strong",
    cycleHint: "unexpected",
  });
});

test("a strong unknown observation is withheld from public provisional state", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ cycleHint: "unknown" }), NOW), null);
});

test("only the explicitly consumed recovery observation is hidden after confirmation", () => {
  assert.equal(getPublicRecoveryObservation(recovery(), NOW, new Set(["recovery-1"])), null);
  assert.notEqual(getPublicRecoveryObservation(recovery(), NOW, new Set(["other-recovery"])), null);
});

test("a medium observation does not become public provisional state", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ confidence: "medium" }), NOW), null);
});

test("a regular observation does not become public provisional state", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ cycleHint: "regular" }), NOW), null);
});

test("a confirmed observation does not remain provisional", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ status: "confirmed" }), NOW), null);
});

test("a rejected observation does not remain provisional", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ status: "rejected" }), NOW), null);
});

test("a provisional observation expires after ninety minutes", () => {
  const observedAt = new Date(NOW.getTime() - UNCONFIRMED_RECOVERY_ACTIVE_MS - 1).toISOString();
  assert.equal(getPublicRecoveryObservation(recovery({ observedAt }), NOW), null);
});

test("a future observation is not public", () => {
  assert.equal(getPublicRecoveryObservation(recovery({ observedAt: new Date(NOW.getTime() + 1).toISOString() }), NOW), null);
});

test("a Tibo reset inside the ninety minute window matches usage recovery", () => {
  assert.equal(doesTiboResetMatchUsageObservation(recovery(), "2026-08-11T00:30:00.000Z"), true);
});

test("a Tibo reset outside the match window does not match usage recovery", () => {
  assert.equal(doesTiboResetMatchUsageObservation(recovery(), "2026-08-11T02:00:01.000Z"), false);
});

test("public recovery output never includes raw usage percentages", () => {
  const serialized = JSON.stringify(getPublicRecoveryObservation(recovery(), NOW));
  assert.doesNotMatch(serialized, /usedPercent|resetsAt|planType/);
});

test("comparison gap constant is ten minutes", () => {
  assert.equal(MAX_USAGE_COMPARISON_GAP_MS, 10 * 60 * 1000);
});

test("regular proximity constant is five minutes", () => {
  assert.equal(REGULAR_RESET_PROXIMITY_MS, 5 * 60 * 1000);
});
