import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetDisplayNameSourceContext,
  type ResetDisplayNameSourceRow,
} from "../lib/radar/resetDisplayNameSourceContext";

const contextPost: ResetDisplayNameSourceRow = {
  tweet_id: "2095000000000000001",
  text: "GPT Astra is launching today.",
  tweet_created_at: "2026-08-31T00:00:00.000Z",
  is_reply: false,
  verification_status: "auto_unverified",
};

const resetPost: ResetDisplayNameSourceRow = {
  tweet_id: "2095000000000000002",
  text: "Reset is live.",
  tweet_created_at: "2026-08-31T00:02:00.000Z",
  is_reply: false,
  verification_status: "auto_unverified",
};

test("display-name context includes only canonical Tibo provenance in deterministic order", () => {
  const unrelatedPost: ResetDisplayNameSourceRow = {
    tweet_id: "2095000000000000003",
    text: "GPT Nova is launching today.",
    tweet_created_at: "2026-08-31T00:01:00.000Z",
    is_reply: false,
    verification_status: "auto_unverified",
  };

  const context = buildResetDisplayNameSourceContext({
    effectiveFormalCandidate: resetPost,
    sourceTweetIds: [resetPost.tweet_id, contextPost.tweet_id],
    sourceRows: [resetPost, unrelatedPost, contextPost],
  });

  assert.equal(
    context,
    [
      `[Tibo post 1 | tweet_id=${contextPost.tweet_id}]`,
      contextPost.text,
      `[End Tibo post 1]`,
      "",
      `[Tibo post 2 | tweet_id=${resetPost.tweet_id}]`,
      resetPost.text,
      `[End Tibo post 2]`,
    ].join("\n"),
  );
  assert.equal(context?.includes(unrelatedPost.text), false);
});

test("display-name context excludes replies and rejected source rows", () => {
  const reply: ResetDisplayNameSourceRow = {
    ...contextPost,
    tweet_id: "2095000000000000004",
    text: "A reply that is not event evidence.",
    is_reply: true,
  };
  const rejected: ResetDisplayNameSourceRow = {
    ...contextPost,
    tweet_id: "2095000000000000005",
    text: "A rejected post.",
    verification_status: "rejected",
  };

  const context = buildResetDisplayNameSourceContext({
    effectiveFormalCandidate: resetPost,
    sourceTweetIds: [resetPost.tweet_id, reply.tweet_id, rejected.tweet_id],
    sourceRows: [reply, rejected],
  });

  assert.equal(context, [
    `[Tibo post 1 | tweet_id=${resetPost.tweet_id}]`,
    resetPost.text,
    `[End Tibo post 1]`,
  ].join("\n"));
});
