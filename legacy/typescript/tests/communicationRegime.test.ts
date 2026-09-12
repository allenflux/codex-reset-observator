import test from "node:test";
import assert from "node:assert/strict";

import type { WindowEventLike } from "../lib/radar/types";
import {
  buildRollingCommunicationRegime,
  classifyCommunicationEvent,
  normalizeLegacyCommunicationType,
  projectSignalsToOrigin,
  seededPermutation,
  selectEligibleCommunicationEvents,
  type CommunicationEventInput,
  type CommunicationSignalInput,
} from "../lib/radar/communicationRegime";

const previousResetAt = "2026-08-01T00:00:00.000Z";
const completedAt = "2026-08-02T00:00:00.000Z";

function event(overrides: Partial<CommunicationEventInput> = {}): CommunicationEventInput {
  return {
    eventId: "event-1",
    completedAt,
    legacyNoticeType: "なし",
    legacyOpenedAt: null,
    legacyWindowMinutes: 0,
    ...overrides,
  };
}

function signal(overrides: Partial<CommunicationSignalInput> = {}): CommunicationSignalInput {
  return {
    tweetId: "tweet-1",
    signalType: "teaser",
    tweetCreatedAt: "2026-08-01T12:00:00.000Z",
    availableAt: "2026-08-01T12:01:00.000Z",
    confidence: 0.9,
    verificationStatus: "confirmed",
    isReply: false,
    ...overrides,
  };
}

test("formal notice has priority over teaser and uses observed provenance", () => {
  const result = classifyCommunicationEvent(
    event({ legacyNoticeType: "公式予告あり" }),
    [
      signal({ tweetId: "teaser-1" }),
      signal({
        tweetId: "notice-1",
        signalType: "official_notice",
        confidence: 0.99,
        tweetCreatedAt: "2026-08-01T18:00:00.000Z",
        availableAt: "2026-08-01T18:01:00.000Z",
      }),
    ],
    { previousRandomResetAt: previousResetAt, coverage: "confirmed" },
  );

  assert.equal(result.primaryType, "formal_notice");
  assert.equal(result.provenance, "observed_signal");
  assert.equal(result.classificationUsable, true);
  assert.deepEqual(result.observedSignalIds, ["notice-1", "teaser-1"]);
  assert.equal(result.legacyAgreement, true);
});

test("post-reset reset_executed signals do not become pre-reset communication", () => {
  const result = classifyCommunicationEvent(
    event(),
    [signal({ signalType: "reset_executed", tweetCreatedAt: completedAt })],
    { previousRandomResetAt: previousResetAt, coverage: "confirmed" },
  );

  assert.equal(result.primaryType, "silent");
  assert.equal(result.provenance, "observed_signal");
  assert.deepEqual(result.observedSignalIds, []);
});

test("insufficient observed coverage falls back to the legacy history label", () => {
  const result = classifyCommunicationEvent(
    event({
      legacyNoticeType: "匂わせ投稿あり",
      legacyOpenedAt: "2026-08-01T12:00:00.000Z",
      legacyWindowMinutes: 720,
    }),
    [],
    { previousRandomResetAt: previousResetAt, coverage: "insufficient" },
  );

  assert.equal(result.primaryType, "teaser");
  assert.equal(result.provenance, "legacy_history");
  assert.equal(result.legacySignalAt, "2026-08-01T12:00:00.000Z");
  assert.equal(result.signalToExecutionHours, 12);
  assert.equal(result.classificationUsable, true);
});

test("unknown coverage without an observed or legacy label is not counted as silent evidence", () => {
  const result = classifyCommunicationEvent(
    event({ legacyNoticeType: null }),
    [],
    { previousRandomResetAt: previousResetAt, coverage: "unknown" },
  );

  assert.equal(result.primaryType, "silent");
  assert.equal(result.provenance, "legacy_history");
  assert.equal(result.classificationUsable, false);
});

test("observed signal remains primary and audits disagreement with legacy history", () => {
  const result = classifyCommunicationEvent(
    event({ legacyNoticeType: "匂わせ投稿あり" }),
    [signal({ signalType: "official_notice", confidence: 0.99 })],
    { previousRandomResetAt: previousResetAt, coverage: "confirmed" },
  );

  assert.equal(result.primaryType, "formal_notice");
  assert.equal(result.provenance, "observed_signal");
  assert.equal(result.observedType, "formal_notice");
  assert.equal(result.legacyType, "teaser");
  assert.equal(result.legacyAgreement, false);
});

test("rejected, reply, and future signals are excluded from point-in-time classification", () => {
  const result = classifyCommunicationEvent(
    event(),
    [
      signal({ tweetId: "rejected", verificationStatus: "rejected" }),
      signal({ tweetId: "reply", isReply: true }),
      signal({
        tweetId: "future",
        tweetCreatedAt: completedAt,
        availableAt: "2026-08-02T00:01:00.000Z",
      }),
    ],
    { previousRandomResetAt: previousResetAt, coverage: "confirmed" },
  );

  assert.equal(result.primaryType, "silent");
  assert.deepEqual(result.observedSignalIds, []);
});

test("legacy label normalization is explicit", () => {
  assert.equal(normalizeLegacyCommunicationType("公式予告あり"), "formal_notice");
  assert.equal(normalizeLegacyCommunicationType("告知投稿あり"), "formal_notice");
  assert.equal(normalizeLegacyCommunicationType("匂わせ投稿あり"), "teaser");
  assert.equal(normalizeLegacyCommunicationType("なし"), "silent");
  assert.equal(normalizeLegacyCommunicationType("unknown"), null);
});

test("point-in-time projection only returns signals available at the origin", () => {
  const signals = [
    signal({ tweetId: "before", availableAt: "2026-08-01T23:59:59.000Z" }),
    signal({ tweetId: "after", availableAt: "2026-08-02T00:00:01.000Z" }),
  ];

  assert.deepEqual(
    projectSignalsToOrigin(signals, "2026-08-02T00:00:00.000Z").map((item) => item.tweetId),
    ["before"],
  );
});

test("rolling regime never includes the current event", () => {
  const events = [
    { primaryType: "formal_notice" as const },
    { primaryType: "teaser" as const },
    { primaryType: "silent" as const },
  ];

  assert.deepEqual(
    buildRollingCommunicationRegime(events, 2, { window: 3, method: "majority" }),
    { formalNoticeShare: 0.5, teaserShare: 0.5, silentShare: 0, sampleSize: 2, dominantType: "formal_notice" },
  );
});

test("seeded permutation is reproducible", () => {
  const values = ["formal_notice", "teaser", "silent", "silent"];
  assert.deepEqual(seededPermutation(values, 42), seededPermutation(values, 42));
  assert.notDeepEqual(seededPermutation(values, 42), values);
});

test("eligibility reuses the existing random reset predicate", () => {
  const eligible: WindowEventLike = {
    id: "eligible",
    recordKind: "confirmed_global",
    completed_at: completedAt,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
    },
  };
  const regular: WindowEventLike = {
    ...eligible,
    id: "regular",
    recordKind: "regular_completed",
    details: { ...eligible.details!, cycleType: "定期リセット" },
  };

  assert.deepEqual(
    selectEligibleCommunicationEvents([eligible, regular], new Date("2026-08-03T00:00:00.000Z").getTime())
      .map((item) => item.id),
    ["eligible"],
  );
});
