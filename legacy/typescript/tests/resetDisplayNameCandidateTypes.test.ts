import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionResetDisplayNameCandidateLifecycle,
  getResetDisplayNameCandidateDedupeKey,
  isCandidatePromotionAuthorized,
  isExecutionBearingResetDisplayNameNotice,
} from "../lib/radar/resetDisplayNameCandidateTypes";

test("trusted logical post identity wins over the notice tweet fallback", () => {
  assert.equal(
    getResetDisplayNameCandidateDedupeKey({
      officialNoticeTweetId: "tweet-1",
      logicalPostId: "logical-1",
    }),
    "logical-post:logical-1",
  );
});

test("blank official notice identity is rejected", () => {
  assert.equal(
    getResetDisplayNameCandidateDedupeKey({ officialNoticeTweetId: "  ", logicalPostId: null }),
    null,
  );
});

test("candidate identity falls back to the official notice tweet", () => {
  assert.equal(
    getResetDisplayNameCandidateDedupeKey({ officialNoticeTweetId: "tweet-1", logicalPostId: "  " }),
    "official-notice:tweet-1",
  );
});

test("promotion is terminal and cannot transition to superseded", () => {
  assert.equal(
    canTransitionResetDisplayNameCandidateLifecycle("promoted", "superseded"),
    false,
  );
});

test("provisional candidates can transition to each terminal lifecycle", () => {
  assert.equal(canTransitionResetDisplayNameCandidateLifecycle("provisional", "provisional"), true);
  assert.equal(canTransitionResetDisplayNameCandidateLifecycle("provisional", "promoted"), true);
  assert.equal(canTransitionResetDisplayNameCandidateLifecycle("provisional", "superseded"), true);
  assert.equal(canTransitionResetDisplayNameCandidateLifecycle("provisional", "expired"), true);
});

test("a resolver-created key without persisted execution evidence is not promotable", () => {
  assert.equal(
    isCandidatePromotionAuthorized(
      { status: "new", resetEventKey: "tibo-reset-new", matchedEvidenceEventKey: null },
      [],
    ),
    false,
  );
});

test("promotion requires matching persisted authoritative execution evidence", () => {
  const resolution = {
    status: "existing" as const,
    resetEventKey: "tibo-reset-existing",
    matchedEvidenceEventKey: "tibo-reset-existing",
  };
  assert.equal(isCandidatePromotionAuthorized(resolution, []), false);
  assert.equal(
    isCandidatePromotionAuthorized(resolution, [
      { resetEventKey: "tibo-reset-other", kind: "formal_adoption" },
    ]),
    false,
  );
  assert.equal(
    isCandidatePromotionAuthorized(resolution, [
      { resetEventKey: "tibo-reset-existing", kind: "formal_adoption" },
    ]),
    true,
  );
});

test("the shared notice predicate excludes presentation-only ongoing BANKED policy", () => {
  assert.equal(
    isExecutionBearingResetDisplayNameNotice({
      signalType: "official_notice",
      verificationStatus: "confirmed",
      isReply: false,
      isHistoricalOnly: false,
      isPresentationOnlyOngoingBanked: true,
      hasFutureBankedDistributionIntent: false,
    }),
    false,
  );
});

test("the shared notice predicate accepts a final official notice", () => {
  assert.equal(
    isExecutionBearingResetDisplayNameNotice({
      signalType: "official_notice",
      verificationStatus: "confirmed",
      isReply: false,
      isHistoricalOnly: false,
      isPresentationOnlyOngoingBanked: false,
      hasFutureBankedDistributionIntent: false,
    }),
    true,
  );
});
