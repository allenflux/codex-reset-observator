import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData } from "../lib/radar";
import {
  getActiveOfficialNotice,
  getLastGlobalResetAt,
  getLocalProbabilityCalculation,
  getMomentumBoost,
  getRecent7DayResetCount,
} from "../lib/radar/probability";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  buildTiboReadSideProjection,
  getTiboReadSideSignals,
} from "../lib/radar/tiboLogicalProjection";
import { expandTiboSignalVariants, type TiboSecondarySignal } from "../lib/radar/tiboSecondarySignal";
import type { ActiveTiboSignal, RadarData } from "../lib/radar/types";

const A = "2094251180121854309";
const B = "2094252447271366730";
const C = "2094252447271366731";
const X = "2094252447271366740";
const NOW = new Date("2026-08-31T12:00:00.000Z");

function signal(
  tweetId: string,
  signalType: ActiveTiboSignal["signal_type"] = "teaser",
  overrides: Partial<ActiveTiboSignal> = {},
): ActiveTiboSignal {
  return {
    tweet_id: tweetId,
    signal_type: signalType,
    text: `signal ${tweetId}`,
    tweet_url: `https://x.com/thsottiaux/status/${tweetId}`,
    tweet_created_at: "2026-08-31T10:00:00.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
    confidence: signalType === "teaser" ? 0.9 : 0.99,
    verification_status: "confirmed",
    classification_source: "gemini",
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
  signalType: ActiveTiboSignal["signal_type"] = "teaser",
  overrides: Partial<ActiveTiboSignal> = {},
) {
  return signal(tweetId, signalType, {
    logical_post_id: chain[0],
    edit_history_tweet_ids: [...chain],
    edit_version: chain.indexOf(tweetId) + 1,
    edit_metadata_source: "x_api",
    ...overrides,
  });
}

function data(
  rows: ActiveTiboSignal[],
  options: {
    active?: ActiveTiboSignal[];
    recent?: ActiveTiboSignal[];
    formal?: ActiveTiboSignal[];
  } = {},
): RadarData {
  return {
    active_tibo_signals: options.active ?? rows,
    recent_tibo_signals: options.recent ?? rows,
    formal_tibo_resets: (options.formal ?? []) as unknown as NonNullable<RadarData["formal_tibo_resets"]>,
  };
}

function effective(rows: ActiveTiboSignal[], scope: "active" | "recent" | "probability" = "active") {
  return getTiboReadSideSignals(data(rows), scope);
}

test("legacy unedited posts stay independent", () => {
  const result = buildTiboReadSideProjection([signal(A), signal(B)]);

  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.effectiveSignals.map((item) => item.tweet_id), [A, B]);
  assert.equal(result.effectiveSignals.length, 2);
});

test("trusted official notice to official notice produces one active latest version", () => {
  const latest = trustedRow([A, B], B, "official_notice", { text: "edited notice" });
  const active = effective([
    trustedRow([A, B], A, "official_notice"),
    latest,
  ]);

  assert.equal(active.length, 1);
  assert.equal(active[0].signal_type, "official_notice");
  assert.equal(active[0].tweet_id, B);
  assert.equal(active[0].text, "edited notice");
});

test("raw membership across active and recent scopes keeps the latest logical version", () => {
  const original = trustedRow([A, B], A, "official_notice");
  const edited = trustedRow([A, B], B, "official_notice", { text: "latest notice" });
  const radarData = data([original], {
    active: [original],
    recent: [original, edited],
  });

  const active = getTiboReadSideSignals(radarData, "active");
  const probability = getTiboReadSideSignals(radarData, "probability");

  assert.deepEqual(active.map((item) => item.tweet_id), [B]);
  assert.deepEqual(probability.map((item) => item.tweet_id), [B]);
  assert.equal(active[0].text, "latest notice");
});

test("the same tweet id across active, recent, and formal sources becomes one richer raw version", () => {
  const secondary: TiboSecondarySignal = {
    signalType: "teaser",
    teaserStrength: "strong",
    confidence: 0.9,
    evidenceQuote: "tomorrow",
    reasonJa: "future event",
  };
  const rich = trustedRow([A, B], B, "teaser", {
    text: "rich active copy",
    expected_start_at: "2026-09-01T09:00:00.000Z",
    expected_end_at: "2026-09-01T10:00:00.000Z",
    temporal_resolution_status: "resolved",
    secondary_signal: secondary,
    translated_text_ja: "豊富な予告",
    translated_text_zh: "完整预告",
  });
  const partial = trustedRow([A, B], B, "teaser", {
    text: undefined,
    tweet_url: undefined,
    expected_start_at: undefined,
    expected_end_at: undefined,
    temporal_resolution_status: undefined,
    secondary_signal: null,
    translated_text_ja: null,
    translated_text_zh: null,
  });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [rich],
    recent_tibo_signals: [partial],
    formal_tibo_resets: [partial as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });

  assert.equal(projection.logicalPosts.length, 1);
  assert.equal(projection.logicalPosts[0].rawVersions.length, 1);
  assert.equal(projection.logicalPosts[0].rawVersions[0].tweet_id, B);
  assert.equal(projection.logicalPosts[0].rawVersions[0].text, "rich active copy");
  assert.deepEqual((projection.logicalPosts[0].rawVersions[0] as ActiveTiboSignal).secondary_signal, secondary);
  assert.equal(projection.effectiveSignals[0].expected_start_at, rich.expected_start_at);
  assert.equal(projection.effectiveSignals[0].translated_text_ja, "豊富な予告");
  assert.equal(projection.effectiveSignals[0].translated_text_zh, "完整预告");
});

test("manual classification survives non-manual copies of the same tweet id", () => {
  const manual = trustedRow([A, B], B, "reset_executed", {
    text: "same raw post",
    classification_source: "manual",
    confidence: 1,
    classification_reason: "human decision",
    verification_status: "confirmed",
  });
  const automatic = trustedRow([A, B], B, "irrelevant", {
    text: "same raw post",
    classification_source: "gemini",
    confidence: 0.5,
    classification_reason: "automatic result",
    verification_status: "auto_unverified",
  });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [automatic],
    recent_tibo_signals: [manual],
    formal_tibo_resets: [automatic as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });
  const raw = projection.logicalPosts[0].rawVersions[0];

  assert.equal(projection.logicalPosts.length, 1);
  assert.equal(raw.classification_source, "manual");
  assert.equal(raw.signal_type, "reset_executed");
  assert.equal(raw.confidence, 1);
  assert.equal(raw.classification_reason, "human decision");
  assert.equal(raw.verification_status, "confirmed");
});

test("trusted x_api identity survives a legacy none copy of the same tweet id", () => {
  const trusted = trustedRow([A, B], B, "teaser", { text: "same raw post" });
  const legacy = signal(B, "teaser", {
    text: "same raw post",
    tweet_url: trusted.tweet_url,
    tweet_created_at: trusted.tweet_created_at,
    expires_at: trusted.expires_at,
  });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [legacy],
    recent_tibo_signals: [trusted],
    formal_tibo_resets: [legacy as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });
  const raw = projection.logicalPosts[0].rawVersions[0];

  assert.equal(projection.logicalPosts.length, 1);
  assert.equal(raw.edit_metadata_source, "x_api");
  assert.deepEqual(raw.edit_history_tweet_ids, [A, B]);
  assert.equal(raw.edit_version, 2);
});

test("malformed x_api identity is not repaired from a none copy", () => {
  const malformed = signal(B, "teaser", {
    text: "same raw post",
    edit_metadata_source: "x_api",
    logical_post_id: null,
    edit_history_tweet_ids: null,
    edit_version: null,
  });
  const legacy = signal(B, "teaser", { text: "same raw post" });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [malformed],
    recent_tibo_signals: [legacy],
  });

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.conflicts.length, 1);
  assert.equal(projection.conflicts[0].reason, "invalid_trusted_edit_identity");
});

test("non-manual semantic conflicts for the same tweet fail closed", () => {
  const official = trustedRow([A, B], B, "official_notice", { text: "same raw post" });
  const teaser = trustedRow([A, B], B, "teaser", { text: "same raw post" });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [official],
    recent_tibo_signals: [teaser],
  });

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.conflicts.length, 1);
  assert.equal(projection.conflicts[0].reason, "conflicting_raw_tweet_versions");
  assert.ok((projection.conflicts[0] as { fields?: string[] }).fields?.includes("signal_type"));
});

test("a raw-version conflict blocks the rest of its trusted logical chain", () => {
  const official = trustedRow([A, B], B, "official_notice", { text: "same raw post" });
  const teaser = trustedRow([A, B], B, "teaser", { text: "same raw post" });
  const laterVersion = trustedRow([A, B, C], C, "teaser");
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [official, laterVersion],
    recent_tibo_signals: [teaser],
  });

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.conflicts.length, 1);
  assert.equal(projection.conflicts[0].reason, "conflicting_raw_tweet_versions");
});

test("same-tweet merge is invariant to input array order", () => {
  const rich = trustedRow([A, B], B, "teaser", {
    text: "rich copy",
    translated_text_ja: "予告",
  });
  const partial = trustedRow([A, B], B, "teaser", {
    text: undefined,
    translated_text_ja: null,
  });
  const forward = buildTiboReadSideProjection([rich, partial]);
  const reverse = buildTiboReadSideProjection([partial, rich]);

  assert.deepEqual(reverse, forward);
});

test("a trusted chain extension across duplicate source rows keeps the longest identity", () => {
  const staleOriginal = trustedRow([A], A, "teaser", { text: "same raw post" });
  const extendedOriginal = trustedRow([A, B], A, "teaser", { text: "same raw post" });
  const edited = trustedRow([A, B], B, "teaser", { text: "edited raw post" });
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: [staleOriginal, edited],
    recent_tibo_signals: [extendedOriginal],
  });

  assert.equal(projection.conflicts.length, 0);
  assert.equal(projection.logicalPosts.length, 1);
  assert.deepEqual(projection.logicalPosts[0].sourceTweetIds, [A, B]);
  assert.deepEqual(
    projection.logicalPosts[0].rawVersions.map((row) => row.edit_history_tweet_ids),
    [[A, B], [A, B]],
  );
  assert.equal(projection.effectiveSignals[0].tweet_id, B);
});

test("recent edit context suppresses an older active notice across scopes", () => {
  const original = trustedRow([A, B], A, "official_notice");
  const edited = trustedRow([A, B], B, "irrelevant");
  const radarData = data([original], {
    active: [original],
    recent: [original, edited],
  });

  assert.equal(getTiboReadSideSignals(radarData, "active").length, 1);
  assert.equal(getTiboReadSideSignals(radarData, "active")[0].signal_type, "irrelevant");
  assert.equal(getActiveOfficialNotice(radarData, null, NOW), null);
  assert.equal(getLocalProbabilityCalculation(radarData, { now: NOW }).inputSnapshot.activeTeaserCount, 0);
});

test("official notice to irrelevant does not leave an active notice", () => {
  const rows = [
    trustedRow([A, B], A, "official_notice"),
    trustedRow([A, B], B, "irrelevant"),
  ];
  const active = effective(rows);

  assert.equal(active.filter((item) => item.signal_type === "official_notice").length, 0);
  assert.equal(getActiveOfficialNotice(data(rows), null, NOW), null);
});

test("teaser to teaser produces one canonical teaser and one probability input", () => {
  const rows = [trustedRow([A, B], A), trustedRow([A, B], B)];
  const probabilitySignals = effective(rows, "probability");

  assert.equal(probabilitySignals.length, 1);
  assert.equal(probabilitySignals[0].tweet_id, B);
  assert.equal(getLocalProbabilityCalculation(data(rows), { now: NOW }).inputSnapshot.activeTeaserCount, 1);
});

test("teaser to irrelevant does not leave a teaser boost", () => {
  const rows = [trustedRow([A, B], A), trustedRow([A, B], B, "irrelevant")];
  const audit = getLocalProbabilityCalculation(data(rows), { now: NOW });

  assert.equal(audit.inputSnapshot.activeTeaserCount, 0);
  assert.deepEqual(audit.breakdown.contributions.teaserOrEvent, {
    probability24h: 0,
    probability48h: 0,
  });
});

test("irrelevant to official notice uses only the latest official content", () => {
  const active = effective([
    trustedRow([A, B], A, "irrelevant"),
    trustedRow([A, B], B, "official_notice"),
  ]);

  assert.deepEqual(active.map((item) => [item.tweet_id, item.signal_type]), [[B, "official_notice"]]);
});

test("irrelevant to reset completion uses only the latest reset content", () => {
  const active = effective([
    trustedRow([A, B], A, "irrelevant"),
    trustedRow([A, B], B, "reset_executed"),
  ]);

  assert.deepEqual(active.map((item) => [item.tweet_id, item.signal_type]), [[B, "reset_executed"]]);
});

test("reset completion to irrelevant does not retain the old reset as a probability source", () => {
  const rows = [
    trustedRow([A, B], A, "reset_executed"),
    trustedRow([A, B], B, "irrelevant"),
  ];
  const probabilitySignals = effective(rows, "probability");
  const audit = getLocalProbabilityCalculation(data(rows), { now: NOW });

  assert.deepEqual(probabilitySignals.map((item) => [item.tweet_id, item.signal_type]), [[B, "irrelevant"]]);
  assert.equal(audit.inputSnapshot.activeTeaserCount, 0);
});

test("manual v1 classification is combined with v2 content", () => {
  const rows = [
    trustedRow([A, B], A, "reset_executed", {
      text: "original manual classification",
      classification_source: "manual",
      confidence: 1,
      classification_reason: "human decision",
      verification_status: "confirmed",
    }),
    trustedRow([A, B], B, "teaser", { text: "latest edited content" }),
  ];
  const projection = buildTiboReadSideProjection(rows);
  const post = projection.logicalPosts[0];
  const effectiveSignal = projection.effectiveSignals[0];

  assert.equal(post.effectiveContent?.tweet_id, B);
  assert.equal(post.effectiveClassification.status, "resolved");
  if (post.effectiveClassification.status === "resolved") {
    assert.equal(post.effectiveClassification.basis, "manual");
    assert.equal(post.effectiveClassification.representativeTweetId, A);
  }
  assert.equal(effectiveSignal.tweet_id, B);
  assert.equal(effectiveSignal.text, "latest edited content");
  assert.equal(effectiveSignal.signal_type, "reset_executed");
  assert.equal(effectiveSignal.classification_source, "manual");
});

test("manual conflict suppresses the logical post and public activity", () => {
  const rows = [
    trustedRow([A, B], A, "reset_executed", { classification_source: "manual" }),
    trustedRow([A, B], B, "irrelevant", { classification_source: "manual" }),
  ];
  const projection = buildTiboReadSideProjection(rows);

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.suppressedLogicalPosts.length, 1);
  assert.equal(projection.suppressedLogicalPosts[0].effectiveClassification.status, "unresolved");
  if (projection.suppressedLogicalPosts[0].effectiveClassification.status === "unresolved") {
    assert.equal(projection.suppressedLogicalPosts[0].effectiveClassification.reason, "manual_conflict");
  }
  assert.equal(toPublicRadarSnapshot(data(rows), "en", { calculationNow: NOW }).latestTiboActivity, null);
});

test("authoritative tail missing suppresses active and public consumers", () => {
  const rows = [trustedRow([A, B], A, "official_notice")];
  const projection = buildTiboReadSideProjection(rows);

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.suppressedLogicalPosts.length, 1);
  assert.equal(projection.suppressedLogicalPosts[0].latestAuthoritativeTweetId, B);
  assert.equal(projection.suppressedLogicalPosts[0].latestVersionPresent, false);
  assert.equal(toPublicRadarSnapshot(data(rows), "ja", { calculationNow: NOW }).latestTiboActivity, null);
});

test("missing middle version is allowed when the authoritative tail exists", () => {
  const rows = [
    trustedRow([A, B, C], A),
    trustedRow([A, B, C], C, "official_notice"),
  ];
  const projection = buildTiboReadSideProjection(rows);

  assert.equal(projection.effectiveSignals.length, 1);
  assert.equal(projection.effectiveSignals[0].tweet_id, C);
  assert.equal(projection.logicalPosts[0].latestVersionPresent, true);
});

test("malformed trusted identity is suppressed rather than treated as legacy", () => {
  const projection = buildTiboReadSideProjection([signal(A, "official_notice", {
    edit_metadata_source: "x_api",
    logical_post_id: "not-numeric",
    edit_history_tweet_ids: [A],
  })]);

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.conflicts.length, 1);
  assert.equal(projection.conflicts[0].reason, "invalid_trusted_edit_identity");
});

test("conflicting trusted chains are suppressed", () => {
  const projection = buildTiboReadSideProjection([
    trustedRow([A, B], A),
    trustedRow([A, B], B),
    trustedRow([A, X], X, "official_notice"),
  ]);

  assert.equal(projection.effectiveSignals.length, 0);
  assert.equal(projection.conflicts.length, 1);
  assert.equal(projection.conflicts[0].reason, "conflicting_trusted_edit_chains");
});

test("unrelated posts inside five minutes remain two logical posts", () => {
  const projection = buildTiboReadSideProjection([
    signal(A, "teaser", { tweet_created_at: "2026-08-31T10:00:00.000Z" }),
    signal(X, "teaser", { tweet_created_at: "2026-08-31T10:04:59.000Z" }),
  ]);

  assert.equal(projection.logicalPosts.length, 2);
  assert.deepEqual(projection.effectiveSignals.map((item) => item.tweet_id), [A, X]);
});

test("secondary signal is expanded once from the latest content version", () => {
  const secondary: TiboSecondarySignal = {
    signalType: "teaser",
    teaserStrength: "strong",
    confidence: 0.9,
    evidenceQuote: "tomorrow",
    reasonJa: "future event",
  };
  const rows = [
    trustedRow([A, B], A, "reset_executed", {
      secondary_signal: {
        signalType: "teaser",
        teaserStrength: "strong",
        confidence: 0.9,
        evidenceQuote: "old",
        reasonJa: "old future event",
      },
    }),
    trustedRow([A, B], B, "reset_executed", { secondary_signal: secondary }),
  ];
  const expanded = expandTiboSignalVariants(effective(rows, "probability"));

  assert.deepEqual(expanded.map((item) => item.tweet_id), [B, `${B}#secondary`]);
  assert.equal(expanded.filter((item) => item.tweet_id?.endsWith("#secondary")).length, 1);
});

test("reply metadata is preserved and active official notice ignores replies", () => {
  const reply = signal(A, "official_notice", { is_reply: true });
  const projected = effective([reply]);

  assert.equal(projected[0].is_reply, true);
  assert.equal(getActiveOfficialNotice(data([reply]), null, NOW), null);
});

test("rejected metadata is preserved and excluded from public activity", () => {
  const rejected = signal(A, "official_notice", { verification_status: "rejected" });
  const projected = effective([rejected]);

  assert.equal(projected[0].verification_status, "rejected");
  assert.equal(toPublicRadarSnapshot(data([rejected]), "en", { calculationNow: NOW }).latestTiboActivity, null);
});

test("regular reset inputs remain outside the Tibo projection", () => {
  const regularReset = {
    id: "regular-2026-08-31",
    opened_at: "2026-08-31T09:00:00.000Z",
    completed_at: "2026-08-31T09:05:00.000Z",
    status: "completed",
    details: { cycleType: "定期リセット" },
  };
  const radarData: RadarData = {
    regular_reset_events: [regularReset as unknown as NonNullable<RadarData["regular_reset_events"]>[number]],
  };

  assert.deepEqual(getTiboReadSideSignals(radarData), []);
  assert.deepEqual(radarData.regular_reset_events, [regularReset]);
});

test("monitor-backed reset inputs remain outside the Tibo projection", () => {
  const radarData: RadarData = {
    codex_recovery_observations: [{
      id: "monitor-1",
      observedAt: "2026-08-31T10:00:00.000Z",
      previousObservedAt: "2026-08-31T09:55:00.000Z",
      previousUsedPercent: 99,
      currentUsedPercent: 1,
      previousResetsAt: null,
      currentResetsAt: "2026-08-31T10:00:00.000Z",
      cycleHint: "random",
      confidence: "high",
      status: "reset_confirmed",
      matchedTiboTweetId: null,
    } as never],
  };

  assert.deepEqual(getTiboReadSideSignals(radarData), []);
  assert.equal(radarData.codex_recovery_observations?.length, 1);
});

test("banked distribution source remains raw data and does not become a reset signal", () => {
  const banked = signal(A, "irrelevant", {
    text: "The banked reset credit was distributed to everyone.",
  });
  const projected = effective([banked]);

  assert.equal(projected.length, 1);
  assert.equal(projected[0].signal_type, "irrelevant");
  assert.match(projected[0].text ?? "", /banked reset credit/);
});

test("public DTO keeps public-v1 and excludes logical identity metadata in all locales", () => {
  const radarData = getLocalRadarData({
    activeTiboSignals: [trustedRow([A, B], A), trustedRow([A, B], B)],
    recentTiboSignals: [trustedRow([A, B], A), trustedRow([A, B], B)],
    tiboFormalAdoptions: [{
      id: "ledger-id-only",
      logicalPostId: "ledger-logical-id-only",
      logicalPostTweetIds: [A, B],
      resetEventKey: "ledger-event-key-only",
      representativeTweetId: A,
      sourceTweetIds: [A, B, "ledger-source-id-only"],
      claimSource: "new_adoption",
      adoptedAt: "2026-08-31T00:00:00.000Z",
      claimedAt: "2026-08-31T00:00:01.000Z",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:01.000Z",
    }],
  });

  for (const locale of ["ja", "en", "zh"] as const) {
    const snapshot = toPublicRadarSnapshot(radarData, locale, { calculationNow: NOW });
    const serialized = JSON.stringify(snapshot);
    assert.equal(snapshot.schemaVersion, "public-v1");
    assert.equal(serialized.includes("logical_post_id"), false);
    assert.equal(serialized.includes("edit_history_tweet_ids"), false);
    assert.equal(serialized.includes("edit_version"), false);
    assert.equal(serialized.includes("edit_metadata_source"), false);
    assert.equal(serialized.includes("ledger-id-only"), false);
    assert.equal(serialized.includes("ledger-logical-id-only"), false);
    assert.equal(serialized.includes("ledger-event-key-only"), false);
    assert.equal(serialized.includes("ledger-source-id-only"), false);
  }
});

test("raw input rows are not mutated by read-side projection", () => {
  const rows = [trustedRow([A, B], A), trustedRow([A, B], B)];
  const before = JSON.stringify(rows);
  const beforeHistory = [...(rows[0].edit_history_tweet_ids ?? [])];

  buildTiboReadSideProjection(rows);

  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(rows[0].edit_history_tweet_ids, beforeHistory);
});

test("latest effective tweet id stays the real content version rather than the logical root", () => {
  const projection = buildTiboReadSideProjection([
    trustedRow([A, B], A),
    trustedRow([A, B], B, "official_notice"),
  ]);

  assert.equal(projection.effectiveSignals[0].tweet_id, B);
  assert.notEqual(projection.effectiveSignals[0].tweet_id, projection.logicalPosts[0].logicalPostId);
});

test("the incident logical post is not exposed as an effective signal or active notice", () => {
  const rows = [
    trustedRow([A, B], A, "reset_executed", { classification_source: "manual" }),
    trustedRow([A, B], B, "irrelevant", { classification_source: "manual" }),
  ];
  const radarData = getLocalRadarData({ activeTiboSignals: rows, recentTiboSignals: rows });

  assert.equal(getTiboReadSideSignals(radarData).length, 0);
  assert.equal(getActiveOfficialNotice(radarData, null, NOW), null);
  assert.equal(getLocalProbabilityCalculation(radarData, { now: NOW }).inputSnapshot.activeTeaserCount, 0);
});

test("suppressing an edited public signal does not erase the existing formal reset boundary", () => {
  const completedAt = "2026-08-31T11:00:00.000Z";
  const formalReset = signal(A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: completedAt,
    expires_at: undefined,
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const original = trustedRow([A, B], A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: completedAt,
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const edited = trustedRow([A, B], B, "irrelevant", {
    text: "No reset discussion.",
  });
  const baseline = getLocalRadarData({
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });
  const withEditedSignal = getLocalRadarData({
    activeTiboSignals: [original, edited],
    recentTiboSignals: [original, edited],
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });

  const baselineLastReset = getLastGlobalResetAt(baseline, NOW);
  const editedAudit = getLocalProbabilityCalculation(withEditedSignal, { now: NOW });
  assert.ok(baselineLastReset);
  assert.equal(editedAudit.inputSnapshot.lastCompletedResetAt, baselineLastReset.toISOString());
  assert.equal(getRecent7DayResetCount(withEditedSignal, NOW), getRecent7DayResetCount(baseline, NOW));
  assert.equal(getMomentumBoost("48h", withEditedSignal, NOW), getMomentumBoost("48h", baseline, NOW));
  assert.equal(getActiveOfficialNotice(withEditedSignal, null, NOW), null);
  assert.equal(
    toPublicRadarSnapshot(withEditedSignal, "en", { calculationNow: NOW }).latestTiboActivity?.sourceUrl,
    edited.tweet_url,
  );
});

test("adding edited versions of one logical reset leaves probability invariants unchanged", () => {
  const original = trustedRow([A, B, C], A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: "2026-08-31T11:00:00.000Z",
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const edited = trustedRow([A, B, C], B, "irrelevant", {
    text: "No reset discussion in the edited version.",
    tweet_created_at: "2026-08-31T11:01:00.000Z",
  });
  const editedAgain = trustedRow([A, B, C], C, "irrelevant", {
    text: "Still no reset discussion in the latest version.",
    tweet_created_at: "2026-08-31T11:02:00.000Z",
  });
  const buildData = (rows: ActiveTiboSignal[]) => getLocalRadarData({
    activeTiboSignals: rows,
    recentTiboSignals: rows,
  });
  const oneVersion = buildData([original]);
  const twoVersions = buildData([original, edited]);
  const threeVersions = buildData([original, edited, editedAgain]);

  const invariantSnapshot = (radarData: RadarData) => {
    const audit = getLocalProbabilityCalculation(radarData, { now: NOW });
    return {
      lastGlobalResetAt: getLastGlobalResetAt(radarData, NOW)?.toISOString() ?? null,
      recent7DayResetCount: getRecent7DayResetCount(radarData, NOW),
      momentum: {
        probability24h: getMomentumBoost("24h", radarData, NOW),
        probability48h: getMomentumBoost("48h", radarData, NOW),
      },
      elapsedSinceReset: audit.breakdown.contributions.elapsedSinceReset,
      historicalIntervalPressure: audit.breakdown.contributions.historicalIntervalPressure,
      probability24h: audit.probability24h,
      probability48h: audit.probability48h,
    };
  };

  const expected = invariantSnapshot(oneVersion);
  assert.deepEqual(invariantSnapshot(twoVersions), expected);
  assert.deepEqual(invariantSnapshot(threeVersions), expected);
});

test("the raw formal execution cutoff still suppresses a pre-reset teaser after edit suppression", () => {
  const completedAt = "2026-08-31T11:00:00.000Z";
  const formalReset = signal(A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: completedAt,
    expires_at: undefined,
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const original = trustedRow([A, B], A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: completedAt,
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const edited = trustedRow([A, B], B, "irrelevant", {
    text: "No reset discussion.",
    tweet_created_at: "2026-08-31T11:05:00.000Z",
  });
  const preResetTeaser = signal(X, "teaser", {
    tweet_created_at: "2026-08-31T10:00:00.000Z",
  });
  const withoutTeaser = getLocalRadarData({
    activeTiboSignals: [original, edited],
    recentTiboSignals: [original, edited],
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });
  const withTeaser = getLocalRadarData({
    activeTiboSignals: [original, edited, preResetTeaser],
    recentTiboSignals: [original, edited, preResetTeaser],
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });

  const withoutTeaserAudit = getLocalProbabilityCalculation(withoutTeaser, { now: NOW });
  const withTeaserAudit = getLocalProbabilityCalculation(withTeaser, { now: NOW });
  assert.equal(withTeaserAudit.inputSnapshot.activeTeaserCount, withoutTeaserAudit.inputSnapshot.activeTeaserCount);
  assert.equal(withTeaserAudit.inputSnapshot.activeTeaserCount, 0);
});

test("a manual conflict suppresses new boosts without erasing the formal reset boundary", () => {
  const completedAt = "2026-08-31T11:00:00.000Z";
  const formalReset = signal(A, "reset_executed", {
    text: "We reset usage for everyone.",
    tweet_created_at: completedAt,
    expires_at: undefined,
    confidence: 0.99,
    verification_status: "confirmed",
  });
  const manualOriginal = trustedRow([A, B], A, "reset_executed", {
    text: "We reset usage for everyone.",
    classification_source: "manual",
    confidence: 1,
    verification_status: "confirmed",
  });
  const manualEdited = trustedRow([A, B], B, "irrelevant", {
    text: "No reset discussion.",
    classification_source: "manual",
    confidence: 1,
    verification_status: "confirmed",
  });
  const baseline = getLocalRadarData({
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });
  const withConflict = getLocalRadarData({
    activeTiboSignals: [manualOriginal, manualEdited],
    recentTiboSignals: [manualOriginal, manualEdited],
    formalTiboResets: [formalReset as unknown as NonNullable<RadarData["formal_tibo_resets"]>[number]],
  });

  assert.equal(getTiboReadSideSignals(withConflict, "probability").length, 0);
  assert.equal(
    getLocalProbabilityCalculation(withConflict, { now: NOW }).inputSnapshot.lastCompletedResetAt,
    getLastGlobalResetAt(baseline, NOW)?.toISOString(),
  );
  assert.equal(getRecent7DayResetCount(withConflict, NOW), getRecent7DayResetCount(baseline, NOW));
  assert.equal(getMomentumBoost("24h", withConflict, NOW), getMomentumBoost("24h", baseline, NOW));
});
