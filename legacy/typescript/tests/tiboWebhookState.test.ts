import assert from "node:assert/strict";
import test from "node:test";

import { isNewFormalAdoption } from "../lib/radar/formalAdoption";
import type { FormalTiboResetSignal } from "../lib/radar/tiboHistory";
import { preserveTiboWebhookState } from "../lib/radar/tiboWebhookState";

const receivedAt = "2026-08-05T00:00:00.000Z";

function payload() {
  return {
    tweet_id: "2084000000000000200",
    detected_at: receivedAt,
    verification_status: "auto_unverified" as const,
  };
}

function formalCandidate(verificationStatus: "auto_unverified" | "confirmed" | "rejected"): FormalTiboResetSignal {
  return {
    tweet_id: "2084000000000000200",
    text: "I reset usage limits for Codex.",
    tweet_url: "https://x.com/thsottiaux/status/2084000000000000200",
    tweet_created_at: "2026-08-04T00:00:00.000Z",
    signal_type: "reset_executed",
    confidence: 0.98,
    verification_status: verificationStatus,
    classification_source: "gemini",
  };
}

test("new webhook rows receive auto_unverified and the current detection time", () => {
  assert.deepEqual(preserveTiboWebhookState(payload(), null, receivedAt), payload());
});

test("resending an auto_unverified row preserves its first detection time", () => {
  const result = preserveTiboWebhookState(payload(), {
    detected_at: "2026-08-04T12:00:00.000Z",
    verification_status: "auto_unverified",
  }, receivedAt);

  assert.equal(result.verification_status, "auto_unverified");
  assert.equal(result.detected_at, "2026-08-04T12:00:00.000Z");
});

test("resending a confirmed row never demotes it to auto_unverified", () => {
  const result = preserveTiboWebhookState(payload(), {
    detected_at: "2026-08-04T12:00:00.000Z",
    verification_status: "confirmed",
  }, receivedAt);

  assert.equal(result.verification_status, "confirmed");
  assert.equal(result.detected_at, "2026-08-04T12:00:00.000Z");
});

test("resending a rejected row never promotes it or changes its detection time", () => {
  const result = preserveTiboWebhookState(payload(), {
    detected_at: "2026-08-04T12:00:00.000Z",
    verification_status: "rejected",
  }, receivedAt);

  assert.equal(result.verification_status, "rejected");
  assert.equal(result.detected_at, "2026-08-04T12:00:00.000Z");
});

test("a null detection time is initialized on the next delivery", () => {
  const result = preserveTiboWebhookState(payload(), {
    detected_at: null,
    verification_status: "auto_unverified",
  }, receivedAt);

  assert.equal(result.verification_status, "auto_unverified");
  assert.equal(result.detected_at, receivedAt);
});

test("manual final classification and reply context survive webhook reprocessing", () => {
  const result = preserveTiboWebhookState({
    ...payload(),
    signal_type: "irrelevant",
    confidence: 0.95,
    classification_reason: "Gemini saw no parent context.",
    classification_source: "gemini",
    teaser_strength: null,
    is_reply: false,
    reply_to_handles: [],
    reply_context_text: null,
    source_timeline: "with_replies",
  }, {
    detected_at: "2026-08-16T19:06:58.000Z",
    verification_status: "confirmed",
    signal_type: "teaser",
    confidence: 0.95,
    classification_reason: "手動修正: 親投稿への条件付き返信としてweak teaserと確認。",
    classification_source: "manual",
    teaser_strength: "weak",
    is_reply: true,
    reply_to_handles: ["@Ananth7e"],
    reply_context_text: "are we going to get a reset when codex crosses 20M users?",
    source_timeline: "with_replies",
  }, receivedAt);

  assert.equal(result.signal_type, "teaser");
  assert.equal(result.confidence, 0.95);
  assert.equal(result.classification_source, "manual");
  assert.equal(result.teaser_strength, "weak");
  assert.equal(result.is_reply, true);
  assert.deepEqual(result.reply_to_handles, ["@Ananth7e"]);
  assert.equal(result.reply_context_text, "are we going to get a reset when codex crosses 20M users?");
  assert.equal(result.verification_status, "confirmed");
});

test("preserved confirmed and rejected states cannot trigger formal adoption again", () => {
  const confirmedPayload = preserveTiboWebhookState(payload(), {
    verification_status: "confirmed",
    detected_at: "2026-08-04T12:00:00.000Z",
  }, receivedAt);
  const rejectedPayload = preserveTiboWebhookState(payload(), {
    verification_status: "rejected",
    detected_at: "2026-08-04T12:00:00.000Z",
  }, receivedAt);

  assert.equal(
    isNewFormalAdoption(formalCandidate(confirmedPayload.verification_status), formalCandidate("confirmed")),
    false,
  );
  assert.equal(
    isNewFormalAdoption(formalCandidate(rejectedPayload.verification_status), formalCandidate("rejected")),
    false,
  );
  assert.equal(
    isNewFormalAdoption(
      formalCandidate("confirmed"),
      { ...formalCandidate("confirmed"), classification_source: "manual" },
    ),
    false,
  );
});
