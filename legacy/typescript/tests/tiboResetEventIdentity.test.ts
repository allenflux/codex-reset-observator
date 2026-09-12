import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseTrustedTiboEditChains,
  type TiboLogicalPost,
  type TiboLogicalPostRow,
} from "../lib/radar/tiboLogicalPost";
import {
  resolveTiboResetEventIdentity,
  type TiboFormalAdoptionLedgerLike,
} from "../lib/radar/tiboResetEventIdentity";

const A = "2094251180121854309";
const B = "2094252447271366730";
const C = "2094252447271366731";
const X = "2094252447271366740";
const NOTICE = "2094252447271366750";

function row(
  tweetId: string,
  overrides: Partial<TiboLogicalPostRow> = {},
): TiboLogicalPostRow {
  return {
    tweet_id: tweetId,
    text: `reset usage for ${tweetId}`,
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: "2026-08-31T00:00:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.98,
    classification_reason: "confirmed reset",
    classification_source: "gemini",
    verification_status: "confirmed",
    logical_post_id: tweetId,
    edit_history_tweet_ids: [tweetId],
    edit_version: 1,
    edit_metadata_source: "none",
    ...overrides,
  };
}

function trustedRow(
  chain: string[],
  tweetId: string,
  overrides: Partial<TiboLogicalPostRow> = {},
) {
  return row(tweetId, {
    logical_post_id: chain[0],
    edit_history_tweet_ids: [...chain],
    edit_version: chain.indexOf(tweetId) + 1,
    edit_metadata_source: "x_api",
    ...overrides,
  });
}

function post(rows: TiboLogicalPostRow[]) {
  const result = collapseTrustedTiboEditChains(rows);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.posts.length, 1);
  return result.posts[0];
}

function ledger(
  overrides: Partial<TiboFormalAdoptionLedgerLike> = {},
): TiboFormalAdoptionLedgerLike {
  return {
    logicalPostId: A,
    logicalPostTweetIds: [A],
    resetEventKey: `tibo-reset-${A}`,
    representativeTweetId: A,
    sourceTweetIds: [A],
    claimSource: "new_adoption",
    adoptedAt: "2026-08-31T00:00:00.000Z",
    claimedAt: "2026-08-31T00:00:00.000Z",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

test("brand-new trusted post gets a new root event key", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A], A)]), {
    sourceTweetIds: [A],
  });

  assert.equal(result.status, "new");
  assert.equal(result.resetEventKey, `tibo-reset-${A}`);
  assert.equal(result.logicalPostId, A);
  assert.deepEqual(result.logicalPostTweetIds, [A]);
  assert.deepEqual(result.sourceTweetIds, [A]);
  assert.equal(result.canCreateNewSideEffects, true);
});

test("the same logical post reuses an existing adoption ledger", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A], A)]), {
    adoptionLedgers: [ledger()],
  });

  assert.equal(result.status, "existing");
  assert.equal(result.resetEventKey, `tibo-reset-${A}`);
  assert.equal(result.canCreateNewSideEffects, false);
  assert.equal(result.matchedEvidence?.kind, "existing_ledger");
});

test("a self-identity B upgrades to trusted root A without renaming its event key", () => {
  const result = resolveTiboResetEventIdentity(
    post([trustedRow([A, B], B)]),
    {
      adoptionLedgers: [ledger({
        logicalPostId: B,
        logicalPostTweetIds: [B],
        resetEventKey: `tibo-reset-${B}`,
        representativeTweetId: B,
        sourceTweetIds: [B],
      })],
      sourceTweetIds: [A, B],
    },
  );

  assert.equal(result.status, "existing");
  assert.equal(result.logicalPostId, A);
  assert.deepEqual(result.logicalPostTweetIds, [A, B]);
  assert.equal(result.resetEventKey, `tibo-reset-${B}`);
  assert.deepEqual(result.sourceTweetIds, [A, B]);
});

test("two previously claimed self identities stay ambiguous after a trusted chain appears", () => {
  const aLedger = ledger();
  const bLedger = ledger({
    logicalPostId: B,
    logicalPostTweetIds: [B],
    resetEventKey: `tibo-reset-${B}`,
    representativeTweetId: B,
    sourceTweetIds: [B],
  });
  const result = resolveTiboResetEventIdentity(
    post([trustedRow([A, B], B)]),
    {
      adoptionLedgers: [aLedger, bLedger],
      sourceTweetIds: [A, B],
    },
  );

  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "ambiguous_existing_claims");
  assert.equal(result.resetEventKey, null);
  assert.equal(result.canCreateNewSideEffects, false);
  assert.equal(aLedger.resetEventKey, `tibo-reset-${A}`);
  assert.equal(bLedger.resetEventKey, `tibo-reset-${B}`);
});

test("unique existing estimate evidence selects one existing key from dual self claims", () => {
  const result = resolveTiboResetEventIdentity(
    post([trustedRow([A, B], B)]),
    {
      adoptionLedgers: [
        ledger(),
        ledger({
          logicalPostId: B,
          logicalPostTweetIds: [B],
          resetEventKey: `tibo-reset-${B}`,
          representativeTweetId: B,
          sourceTweetIds: [B],
        }),
      ],
      estimates: [{
        resetEventKey: `tibo-reset-${A}`,
        tiboSourceTweetIds: [A],
      }],
      sourceTweetIds: [A, B],
    },
  );

  assert.equal(result.status, "existing");
  assert.equal(result.resetEventKey, `tibo-reset-${A}`);
  assert.equal(result.canCreateNewSideEffects, false);
});

test("canonical evidence selecting a non-root dual claim fails closed", () => {
  const result = resolveTiboResetEventIdentity(
    post([trustedRow([A, B], B)]),
    {
      adoptionLedgers: [
        ledger(),
        ledger({
          logicalPostId: B,
          logicalPostTweetIds: [B],
          resetEventKey: `tibo-reset-${B}`,
          representativeTweetId: B,
          sourceTweetIds: [B],
        }),
      ],
      estimates: [{
        resetEventKey: `tibo-reset-${B}`,
        tiboSourceTweetIds: [B],
      }],
      sourceTweetIds: [A, B],
    },
  );

  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "canonical_existing_claims");
  assert.equal(result.resetEventKey, null);
  assert.equal(result.canCreateNewSideEffects, false);
});

test("trusted chain extensions retain the existing event key", () => {
  const first = resolveTiboResetEventIdentity(post([trustedRow([A], A)]), {
    sourceTweetIds: [A],
  });
  const second = resolveTiboResetEventIdentity(post([
    trustedRow([A, B], A),
    trustedRow([A, B], B),
  ]), {
    adoptionLedgers: [ledger()],
    sourceTweetIds: [A, B],
  });
  const third = resolveTiboResetEventIdentity(post([
    trustedRow([A, B, C], C),
  ]), {
    adoptionLedgers: [ledger({
      logicalPostTweetIds: [A, B],
      sourceTweetIds: [A, B],
    })],
    sourceTweetIds: [A, B, C],
  });

  assert.equal(first.resetEventKey, `tibo-reset-${A}`);
  assert.equal(second.resetEventKey, `tibo-reset-${A}`);
  assert.equal(third.resetEventKey, `tibo-reset-${A}`);
  assert.deepEqual(third.logicalPostTweetIds, [A, B, C]);
});

test("conflicting trusted aliases fail closed", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A, B], B)]), {
    adoptionLedgers: [ledger({
      logicalPostId: A,
      logicalPostTweetIds: [A, X],
      resetEventKey: `tibo-reset-${A}`,
      sourceTweetIds: [A, X],
    })],
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.resetEventKey, null);
  assert.equal(result.canCreateNewSideEffects, false);
});

test("existing estimate is reused by recovery observation before alias matching", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A, B], B)]), {
    recoveryObservationId: "observation-1",
    estimates: [
      {
        resetEventKey: "usage-reset-existing",
        recoveryObservationId: "observation-1",
        tiboSourceTweetIds: [X],
      },
    ],
  });

  assert.equal(result.status, "existing");
  assert.equal(result.resetEventKey, "usage-reset-existing");
  assert.equal(result.matchedEvidence?.kind, "existing_estimate");
});

test("estimate, static history, and dynamic history can reuse a chain alias", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A, B], B)]), {
    estimates: [{
      resetEventKey: "estimate-key",
      tiboSourceTweetIds: [B],
    }],
    staticHistory: [{
      eventKey: "static-key",
      sourceTweetIds: [B],
    }],
    dynamicEvents: [{
      eventKey: "dynamic-key",
      sourceUrl: `https://x.com/thsottiaux/status/${B}`,
    }],
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.resetEventKey, null);
});

test("a single unambiguous history reference is reused", () => {
  const result = resolveTiboResetEventIdentity(post([trustedRow([A, B], B)]), {
    staticHistory: [{
      eventKey: "static-key",
      sourceTweetIds: [B],
    }],
  });

  assert.equal(result.status, "existing");
  assert.equal(result.resetEventKey, "static-key");
  assert.equal(result.matchedEvidence?.kind, "existing_history");
});

test("related notices stay in event provenance and out of logical aliases", () => {
  const result = resolveTiboResetEventIdentity(post([
    trustedRow([A, B], B),
  ]), {
    sourceTweetIds: [A, B, NOTICE],
  });

  assert.deepEqual(result.logicalPostTweetIds, [A, B]);
  assert.deepEqual(result.sourceTweetIds, [A, B, NOTICE]);
});

test("legacy none rows remain independently claimable", () => {
  const a = resolveTiboResetEventIdentity(post([row(A)]), { sourceTweetIds: [A] });
  const b = resolveTiboResetEventIdentity(post([row(B)]), { sourceTweetIds: [B] });

  assert.equal(a.status, "new");
  assert.equal(b.status, "new");
  assert.equal(a.resetEventKey, `tibo-reset-${A}`);
  assert.equal(b.resetEventKey, `tibo-reset-${B}`);
});

test("unrelated posts remain separate even when their timestamps are close", () => {
  const first = resolveTiboResetEventIdentity(post([row(A)]), { sourceTweetIds: [A] });
  const second = resolveTiboResetEventIdentity(post([row(X)]), { sourceTweetIds: [X] });

  assert.notEqual(first.resetEventKey, second.resetEventKey);
  assert.equal(first.status, "new");
  assert.equal(second.status, "new");
});

test("missing authoritative tail blocks new side effects", () => {
  const logicalPost = post([trustedRow([A, B], A)]);
  const result = resolveTiboResetEventIdentity(logicalPost, { sourceTweetIds: [A, B] });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "missing_authoritative_tail");
  assert.equal(result.resetEventKey, null);
  assert.equal(result.canCreateNewSideEffects, false);
});

test("manual conflict blocks new side effects without manufacturing an event key", () => {
  const result = resolveTiboResetEventIdentity(post([
    trustedRow([A, B], A, {
      classification_source: "manual",
      signal_type: "reset_executed",
    }),
    trustedRow([A, B], B, {
      classification_source: "manual",
      signal_type: "irrelevant",
    }),
  ]), { sourceTweetIds: [A, B] });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "manual_conflict");
  assert.equal(result.resetEventKey, null);
  assert.equal(result.canCreateNewSideEffects, false);
});

test("resolver does not mutate logical post source arrays", () => {
  const sourceTweetIds = [A, B, NOTICE];
  const before = sourceTweetIds.slice();
  const result = resolveTiboResetEventIdentity(post([trustedRow([A, B], B)]), {
    sourceTweetIds,
  });

  assert.deepEqual(sourceTweetIds, before);
  assert.notEqual(result.sourceTweetIds, sourceTweetIds);
});
