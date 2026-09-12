import assert from "node:assert/strict";
import test from "node:test";

import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  collapseTrustedTiboEditChains,
  getTiboLogicalIdentityAliases,
  type TiboLogicalPost,
  type TiboLogicalPostRow,
} from "../lib/radar/tiboLogicalPost";

const A = "2094251180121854309";
const B = "2094252447271366730";
const C = "2094252447271366731";
const X = "2094252447271366740";

function row(
  tweetId: string,
  overrides: Partial<TiboLogicalPostRow> = {},
): TiboLogicalPostRow {
  return {
    tweet_id: tweetId,
    text: `raw text for ${tweetId}`,
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: "2026-08-31T00:00:00.000Z",
    signal_type: "teaser",
    confidence: 0.8,
    classification_reason: "automatic classification",
    classification_source: "gemini",
    verification_status: "auto_unverified",
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
): TiboLogicalPostRow {
  const editVersion = chain.indexOf(tweetId) + 1;
  assert.ok(editVersion > 0);
  return row(tweetId, {
    logical_post_id: chain[0],
    edit_history_tweet_ids: [...chain],
    edit_version: editVersion,
    edit_metadata_source: "x_api",
    ...overrides,
  });
}

function firstPost(rows: readonly TiboLogicalPostRow[]) {
  const result = collapseTrustedTiboEditChains(rows);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.posts.length, 1);
  return result.posts[0];
}

function postSnapshot(post: TiboLogicalPost) {
  return {
    logicalPostId: post.logicalPostId,
    rawVersions: post.rawVersions.map((version) => version.tweet_id),
    effectiveContent: post.effectiveContent?.tweet_id ?? null,
    sourceTweetIds: post.sourceTweetIds,
    manualState: post.manualState,
    effectiveClassification: post.effectiveClassification.status === "resolved"
      ? {
          status: post.effectiveClassification.status,
          basis: post.effectiveClassification.basis,
          signalType: post.effectiveClassification.signalType,
          representativeTweetId: post.effectiveClassification.representativeTweetId,
        }
      : {
          status: post.effectiveClassification.status,
          reason: post.effectiveClassification.reason,
        },
    latestAuthoritativeTweetId: post.latestAuthoritativeTweetId,
    latestVersionPresent: post.latestVersionPresent,
  };
}

test("legacy none rows remain two independent logical posts", () => {
  const result = collapseTrustedTiboEditChains([row(A), row(B)]);

  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.posts.map((post) => post.logicalPostId), [A, B]);
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.posts.map((post) => post.sourceTweetIds), [[A], [B]]);
});

test("trusted [A,B] rows resolve to one logical post", () => {
  const post = firstPost([trustedRow([A, B], A), trustedRow([A, B], B)]);

  assert.equal(post.logicalPostId, A);
  assert.deepEqual(post.sourceTweetIds, [A, B]);
  assert.equal(post.effectiveContent?.tweet_id, B);
});

test("a trusted B row groups a legacy none A row when the chain names A", () => {
  const post = firstPost([row(A), trustedRow([A, B], B)]);

  assert.deepEqual(post.rawVersions.map((version) => version.tweet_id), [A, B]);
  assert.deepEqual(post.sourceTweetIds, [A, B]);
  assert.equal(post.rawVersions[0].edit_metadata_source, "none");
  assert.equal(post.rawVersions[1].edit_metadata_source, "x_api");
});

test("original then edited arrival order resolves deterministically", () => {
  const post = firstPost([trustedRow([A, B], A), trustedRow([A, B], B)]);

  assert.deepEqual(postSnapshot(post), {
    logicalPostId: A,
    rawVersions: [A, B],
    effectiveContent: B,
    sourceTweetIds: [A, B],
    manualState: { kind: "none" },
    effectiveClassification: {
      status: "resolved",
      basis: "effective_content",
      signalType: "teaser",
      representativeTweetId: B,
    },
    latestAuthoritativeTweetId: B,
    latestVersionPresent: true,
  });
});

test("edited then original arrival order has the same logical result", () => {
  const post = firstPost([trustedRow([A, B], B), trustedRow([A, B], A)]);
  const forward = firstPost([trustedRow([A, B], A), trustedRow([A, B], B)]);

  assert.deepEqual(postSnapshot(post), postSnapshot(forward));
});

test("three-version trusted chain keeps authoritative order and aliases", () => {
  const post = firstPost([
    trustedRow([A, B, C], C),
    trustedRow([A, B, C], A),
    trustedRow([A, B, C], B),
  ]);

  assert.deepEqual(post.sourceTweetIds, [A, B, C]);
  assert.deepEqual(getTiboLogicalIdentityAliases(post), [A, B, C]);
  assert.deepEqual(post.rawVersions.map((version) => version.tweet_id), [A, B, C]);
  assert.equal(post.effectiveContent?.tweet_id, C);
  assert.equal(post.latestAuthoritativeTweetId, C);
  assert.equal(post.latestVersionPresent, true);
});

test("effective content is the highest existing authoritative version", () => {
  const post = firstPost([
    trustedRow([A, B, C], A),
    trustedRow([A, B, C], C),
  ]);

  assert.equal(post.effectiveContent?.tweet_id, C);
  assert.deepEqual(post.rawVersions.map((version) => version.tweet_id), [A, C]);
  assert.deepEqual(post.sourceTweetIds, [A, B, C]);
});

test("missing authoritative tail is explicit and does not make the prior row latest", () => {
  const post = firstPost([trustedRow([A, B], A)]);

  assert.equal(post.effectiveContent?.tweet_id, A);
  assert.equal(post.latestAuthoritativeTweetId, B);
  assert.equal(post.latestVersionPresent, false);
  assert.deepEqual(post.sourceTweetIds, [A, B]);
});

test("a missing middle version is allowed when the authoritative tail exists", () => {
  const post = firstPost([
    trustedRow([A, B, C], A),
    trustedRow([A, B, C], C),
  ]);

  assert.equal(post.effectiveContent?.tweet_id, C);
  assert.equal(post.latestAuthoritativeTweetId, C);
  assert.equal(post.latestVersionPresent, true);
  assert.deepEqual(post.sourceTweetIds, [A, B, C]);
});

test("sourceTweetIds include the complete authoritative chain even when raw rows are missing", () => {
  const post = firstPost([trustedRow([A, B, C], A), trustedRow([A, B, C], C)]);

  assert.deepEqual(post.sourceTweetIds, [A, B, C]);
});

test("without manual rows the effective classification comes from latest content", () => {
  const post = firstPost([
    trustedRow([A, B], A, { signal_type: "teaser" }),
    trustedRow([A, B], B, { signal_type: "reset_executed" }),
  ]);

  assert.equal(post.effectiveClassification.status, "resolved");
  if (post.effectiveClassification.status === "resolved") {
    assert.equal(post.effectiveClassification.basis, "effective_content");
    assert.equal(post.effectiveClassification.signalType, "reset_executed");
    assert.equal(post.effectiveClassification.representativeTweetId, B);
  }
});

test("manual v1 controls classification while v2 supplies effective content", () => {
  const post = firstPost([
    trustedRow([A, B], A, {
      signal_type: "reset_executed",
      classification_source: "manual",
    }),
    trustedRow([A, B], B, {
      text: "edited content",
      signal_type: "teaser",
      classification_source: "gemini",
    }),
  ]);

  assert.equal(post.effectiveContent?.tweet_id, B);
  assert.deepEqual(post.manualState, {
    kind: "consistent",
    signalType: "reset_executed",
    representativeTweetId: A,
    tweetIds: [A],
  });
  assert.equal(post.effectiveClassification.status, "resolved");
  if (post.effectiveClassification.status === "resolved") {
    assert.equal(post.effectiveClassification.basis, "manual");
    assert.equal(post.effectiveClassification.signalType, "reset_executed");
    assert.equal(post.effectiveClassification.representativeTweetId, A);
  }
});

test("the highest-version manual row represents a consistent manual state", () => {
  const post = firstPost([
    trustedRow([A, B], A, {
      signal_type: "teaser",
      classification_source: "manual",
      confidence: 0.42,
      classification_reason: "manual version one",
      verification_status: "auto_unverified",
    }),
    trustedRow([A, B], B, {
      signal_type: "teaser",
      classification_source: "manual",
      confidence: 0.91,
      classification_reason: "manual version two",
      verification_status: "confirmed",
    }),
  ]);

  assert.deepEqual(post.manualState, {
    kind: "consistent",
    signalType: "teaser",
    representativeTweetId: B,
    tweetIds: [A, B],
  });
  assert.equal(post.effectiveClassification.status, "resolved");
  if (post.effectiveClassification.status === "resolved") {
    assert.equal(post.effectiveClassification.basis, "manual");
    assert.equal(post.effectiveClassification.representativeTweetId, B);
    assert.equal(post.effectiveClassification.confidence, 0.91);
    assert.equal(post.effectiveClassification.classificationReason, "manual version two");
    assert.equal(post.effectiveClassification.classificationSource, "manual");
    assert.equal(post.effectiveClassification.verificationStatus, "confirmed");
  }
});

test("different manual signal types become an unresolved conflict", () => {
  const post = firstPost([
    trustedRow([A, B], A, {
      signal_type: "reset_executed",
      classification_source: "manual",
    }),
    trustedRow([A, B], B, {
      signal_type: "irrelevant",
      classification_source: "manual",
    }),
  ]);

  assert.deepEqual(post.manualState, {
    kind: "conflict",
    signalTypes: ["reset_executed", "irrelevant"],
    tweetIds: [A, B],
  });
  assert.deepEqual(post.effectiveClassification, {
    status: "unresolved",
    reason: "manual_conflict",
    signalType: null,
    confidence: null,
    classificationReason: null,
    classificationSource: null,
    verificationStatus: null,
    representativeTweetId: null,
    row: null,
  });
});

test("the production A/B incident resolves as one post with manual conflict", () => {
  const post = firstPost([
    trustedRow([A, B], A, {
      signal_type: "reset_executed",
      classification_source: "manual",
    }),
    trustedRow([A, B], B, {
      signal_type: "irrelevant",
      classification_source: "manual",
    }),
  ]);

  assert.equal(post.logicalPostId, A);
  assert.equal(post.effectiveContent?.tweet_id, B);
  assert.deepEqual(post.sourceTweetIds, [A, B]);
  assert.equal(post.manualState.kind, "conflict");
  assert.equal(post.effectiveClassification.status, "unresolved");
});

test("conflicting trusted chains fail closed instead of being merged", () => {
  const result = collapseTrustedTiboEditChains([
    trustedRow([A, B], A),
    trustedRow([A, B], B),
    trustedRow([A, X], X),
  ]);

  assert.equal(result.posts.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, "conflicting_trusted_edit_chains");
  assert.deepEqual(result.conflicts[0].chains, [[A, B], [A, X]]);
  assert.deepEqual(result.conflicts[0].tweetIds, [A, B, X]);
});

test("malformed x_api metadata is a conflict and produces no logical post", () => {
  const result = collapseTrustedTiboEditChains([row(A, {
    logical_post_id: "not-a-post-id",
    edit_history_tweet_ids: [A],
    edit_version: 1,
    edit_metadata_source: "x_api",
  })]);

  assert.equal(result.posts.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, "invalid_trusted_edit_identity");
  assert.deepEqual(result.conflicts[0].tweetIds, [A]);
});

test("x_api edit version inconsistency is a conflict", () => {
  const result = collapseTrustedTiboEditChains([trustedRow([A, B], B, {
    edit_version: 1,
  })]);

  assert.equal(result.posts.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, "invalid_trusted_edit_identity");
});

test("the same malformed metadata with none remains a legacy independent post", () => {
  const result = collapseTrustedTiboEditChains([row(A, {
    logical_post_id: "not-a-post-id",
    edit_history_tweet_ids: [],
    edit_version: 0,
    edit_metadata_source: "none",
  })]);

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].logicalPostId, A);
  assert.deepEqual(result.posts[0].sourceTweetIds, [A]);
});

test("unrelated posts within the five-minute dedupe window remain independent", () => {
  const result = collapseTrustedTiboEditChains([
    row(A, { tweet_created_at: "2026-08-31T00:00:00.000Z" }),
    row(X, { tweet_created_at: "2026-08-31T00:04:59.000Z" }),
  ]);

  assert.equal(result.conflicts.length, 0);
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.posts.map((post) => post.logicalPostId), [A, X]);
});

test("raw input rows and identity arrays are not mutated", () => {
  const rows = [
    row(A),
    trustedRow([A, B, C], C),
  ];
  const before = JSON.stringify(rows);
  const originalHistory = rows[1].edit_history_tweet_ids
    ? [...rows[1].edit_history_tweet_ids]
    : null;

  collapseTrustedTiboEditChains(rows);

  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(rows[1].edit_history_tweet_ids, originalHistory);
});

test("public-v1 remains unchanged and excludes logical identity metadata", () => {
  const snapshot = toPublicRadarSnapshot({
    active_tibo_signals: [{
      tweet_id: B,
      signal_type: "teaser",
      text: "A reset is coming.",
      tweet_url: `https://x.com/thsottiaux/status/${B}`,
      tweet_created_at: "2026-08-31T00:00:00.000Z",
      confidence: 0.9,
      verification_status: "auto_unverified",
      logical_post_id: A,
      edit_history_tweet_ids: [A, B],
      edit_version: 2,
      edit_metadata_source: "x_api",
    }],
  }, "en", { calculationNow: new Date("2026-08-31T01:00:00.000Z") });

  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.schemaVersion, "public-v1");
  assert.equal(serialized.includes("logical_post_id"), false);
  assert.equal(serialized.includes("edit_history_tweet_ids"), false);
  assert.equal(serialized.includes("edit_version"), false);
  assert.equal(serialized.includes("edit_metadata_source"), false);
});
