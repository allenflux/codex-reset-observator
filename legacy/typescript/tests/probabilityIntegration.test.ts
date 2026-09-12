import test from "node:test";
import assert from "node:assert";
import { LOCAL_OBSERVATION_SIGNALS } from "../data/observationSignals";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import {
  getActiveOfficialNotice,
  getLocalProbabilityCalculation,
  getLocalResetProbability,
  getDaysSinceLastGlobalReset,
  getOngoingBankedNotice,
} from "../lib/radar/probability";

test("reset_executed resets days since last reset to 0 and updates effectiveLatestResetAt", () => {
  const now = new Date("2026-07-18T15:00:00.000Z");
  const recentExecutionTime = now.toISOString();
  const mockRadarData = getLocalRadarData({
    formalTiboResets: [
      {
        tweet_id: "1111",
        text: "All Codex limits have been reset.",
        tweet_url: "https://x.com/thsottiaux/status/1111",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: recentExecutionTime,
        verification_status: "confirmed",
      },
    ],
    calculationNow: now,
  });

  const days = getDaysSinceLastGlobalReset(mockRadarData as any, now);
  assert.strictEqual(days, 0, "Days since last reset should be 0 when a recent reset_executed exists");
});

test("old teaser before reset_executed is not counted into probability boost", () => {
  const now = Date.now();
  const oldTeaserTime = new Date(now - 2 * 3600 * 1000).toISOString(); // 2 hours ago
  const resetExecutedTime = new Date(now - 1 * 3600 * 1000).toISOString(); // 1 hour ago

  const mockRadarData = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "teaser_1",
        signal_type: "teaser",
        confidence: 0.85,
        tweet_created_at: oldTeaserTime,
        expires_at: new Date(now + 22 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "reset_1",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: resetExecutedTime,
        expires_at: new Date(now + 23 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
    ],
  });

  const p24 = getLocalResetProbability(mockRadarData as any, "24h");
  // Old teaser before reset_executed must NOT trigger 90% notice mode or boost
  assert.ok(p24 < 0.90, "Old teaser before reset_executed must not boost or trigger notice mode");
});

test("new official_notice after reset_executed triggers Notice Mode (90%/96%)", () => {
  const now = Date.now();
  const resetExecutedTime = new Date(now - 2 * 3600 * 1000).toISOString(); // 2 hours ago
  const newNoticeTime = new Date(now - 1 * 3600 * 1000).toISOString(); // 1 hour ago (AFTER reset)

  const mockRadarData = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "reset_1",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: resetExecutedTime,
        expires_at: new Date(now + 22 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "notice_1",
        signal_type: "official_notice",
        confidence: 0.96,
        tweet_created_at: newNoticeTime,
        expires_at: new Date(now + 23 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
    ],
  });

  const p24 = getLocalResetProbability(mockRadarData as any, "24h");
  const p48 = getLocalResetProbability(mockRadarData as any, "48h");

  assert.strictEqual(p24, 0.90, "New notice after execution must trigger 24h 90% Notice Mode");
  assert.strictEqual(p48, 0.96, "New notice after execution must trigger 48h 96% Notice Mode");
});

test("a BANKED official notice keeps the existing 90%/96% override and dedicated action", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const data = getLocalRadarData({
    activeTiboSignals: [{
      tweet_id: "banked-probability-test",
      text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
      signal_type: "official_notice",
      confidence: 0.99,
      tweet_created_at: "2026-08-21T11:00:00.000Z",
      expires_at: "2026-08-22T12:00:00.000Z",
      verification_status: "auto_unverified",
      expected_start_at: "2026-08-21T12:00:00.000Z",
      expected_end_at: "2026-08-22T07:00:00.000Z",
      ai_temporal_precision: "daypart",
      temporal_resolution_status: "resolved",
    }],
    calculationNow: now,
  });

  const notice = getActiveOfficialNotice(data, null, now);
  assert.equal(notice?.isBankedDistribution, true);
  assert.equal(getLocalResetProbability(data, "24h", undefined, notice, now), 0.9);
  assert.equal(getLocalResetProbability(data, "48h", undefined, notice, now), 0.96);
  const viewModel = getRadarViewModel(data, "ja", false, undefined, now);
  assert.equal(viewModel.activeWindow.noticeKind, "banked");
  assert.match(viewModel.action, /無理に使い切る必要はありません/);
});

test("an explicitly registered persistent BANKED policy stays active after delivery", () => {
  const now = new Date("2026-09-04T04:00:00.000Z");
  const astraNotice = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    signal_type: "official_notice" as const,
    confidence: 0.98,
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-06T00:00:00.000Z",
    verification_status: "auto_unverified" as const,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:30:00.000Z",
    temporal_resolution_status: "resolved" as const,
    ai_temporal_precision: "exact_time" as const,
    ai_temporal_timezone: "UTC",
  };
  const execution = {
    tweet_id: "astra-distribution-execution",
    text: "A reset was observed.",
    tweet_url: "https://x.com/thsottiaux/status/astra-distribution-execution",
    signal_type: "reset_executed" as const,
    confidence: 0.98,
    tweet_created_at: "2026-09-04T03:34:46.386Z",
    verification_status: "confirmed" as const,
  };
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [astraNotice],
    formalTiboResets: [execution],
  });
  const baselineData = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: [execution],
  });

  const activeNotice = getActiveOfficialNotice(data, null, now);
  assert.equal(activeNotice?.id, astraNotice.tweet_id);
  assert.equal(activeNotice?.consumption, "persistent");
  assert.equal(activeNotice?.expectedAt, null);
  assert.equal(activeNotice?.expectedEndAt, null);
  assert.equal(activeNotice?.temporalPrecision, "unknown");
  const ongoingNotice = getOngoingBankedNotice(data, now);
  assert.equal(ongoingNotice?.id, astraNotice.tweet_id);
  assert.equal(ongoingNotice?.expectedAt, null);
  assert.equal(ongoingNotice?.expectedEndAt, null);
  assert.equal(ongoingNotice?.temporalPrecision, "unknown");

  const calculation = getLocalProbabilityCalculation(data, { now });
  const baselineCalculation = getLocalProbabilityCalculation(baselineData, { now });
  assert.equal(calculation.breakdown.officialNoticeOverride.active, true);
  assert.equal(calculation.probability24h, 0.9);
  assert.equal(calculation.probability48h, 0.96);
  assert.notEqual(calculation.probability24h, baselineCalculation.probability24h);
  assert.notEqual(calculation.probability48h, baselineCalculation.probability48h);

  const viewModel = getRadarViewModel(data, "ja", false, undefined, now);
  assert.equal(viewModel.activeWindow.active, true);
  assert.equal(viewModel.activeWindow.kind, "official");
  assert.equal(viewModel.activeWindow.noticeKind, "banked");
  assert.equal(viewModel.activeWindow.expectedAt, null);
  assert.match(viewModel.activeWindow.summary, /BANKEDリセット.*配布が予告されています/);
});

test("a recurring BANKED policy remains visible after its first delivery window expires", () => {
  const now = new Date("2026-09-04T06:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    recentTiboSignals: [{
      tweet_id: "2095651088502591861",
      text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan, starting today.",
      tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
      signal_type: "official_notice",
      confidence: 0.98,
      tweet_created_at: "2026-09-03T23:12:09.000Z",
      expires_at: "2026-09-04T05:12:09.000Z",
      verification_status: "auto_unverified",
    }],
  });

  assert.equal(getOngoingBankedNotice(data, now)?.id, "2095651088502591861");
  const activeNotice = getActiveOfficialNotice(data, null, now);
  assert.equal(activeNotice?.id, "2095651088502591861");
  assert.equal(activeNotice?.expectedAt, null);
  assert.equal(activeNotice?.expectedEndAt, null);
  assert.equal(activeNotice?.temporalPrecision, "unknown");
});

test("manual notice termination is time-aware and can be opted into only for BANKED execution evidence", () => {
  const beforeTermination = new Date("2026-09-04T22:30:28.999Z");
  const terminationAt = new Date("2026-09-04T22:30:29.000Z");
  const astraNotice = {
    tweet_id: "2095651088502591861",
    text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan.",
    tweet_url: "https://x.com/thsottiaux/status/2095651088502591861",
    signal_type: "official_notice" as const,
    confidence: 0.98,
    tweet_created_at: "2026-09-03T23:12:09.000Z",
    expires_at: "2026-09-06T00:00:00.000Z",
    verification_status: "auto_unverified" as const,
    is_reply: false,
    expected_start_at: "2026-09-04T02:12:09.000Z",
    expected_end_at: "2026-09-04T02:30:00.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const data = getLocalRadarData({ activeTiboSignals: [astraNotice] });

  assert.equal(getActiveOfficialNotice(data, null, beforeTermination)?.id, astraNotice.tweet_id);
  assert.equal(getActiveOfficialNotice(data, null, terminationAt), null);
  assert.equal(getOngoingBankedNotice(data, terminationAt), null);
  assert.equal(
    getActiveOfficialNotice(data, null, terminationAt, undefined, null, false, true)?.id,
    astraNotice.tweet_id,
  );

  const calculation = getLocalProbabilityCalculation(data, { now: terminationAt });
  assert.equal(calculation.breakdown.officialNoticeOverride.active, false);
  assert.notEqual(getRadarViewModel(data, "ja", false, undefined, terminationAt).activeWindow.kind, "official");
});

test("manual termination also suppresses the registered one-shot notice after its rollout evidence", () => {
  const beforeTermination = new Date("2026-09-04T22:30:28.999Z");
  const terminationAt = new Date("2026-09-04T22:30:29.000Z");
  const notice = {
    tweet_id: "2095979536043401428",
    text: "We will reset usage for all paid ChatGPT users tomorrow.",
    tweet_url: "https://x.com/thsottiaux/status/2095979536043401428",
    signal_type: "official_notice" as const,
    confidence: 0.99,
    tweet_created_at: "2026-09-04T20:57:00.000Z",
    expires_at: "2026-09-05T06:00:00.000Z",
    verification_status: "auto_unverified" as const,
    is_reply: false,
    expected_start_at: "2026-09-05T02:00:00.000Z",
    expected_end_at: "2026-09-05T03:00:00.000Z",
    temporal_resolution_status: "resolved" as const,
  };
  const data = getLocalRadarData({ activeTiboSignals: [notice] });

  assert.equal(getActiveOfficialNotice(data, null, beforeTermination)?.id, notice.tweet_id);
  assert.equal(getActiveOfficialNotice(data, null, terminationAt), null);
});

test("an unrelated official notice is unaffected by the Astra termination registry", () => {
  const now = new Date("2026-09-04T22:30:29.000Z");
  const notice = {
    tweet_id: "unrelated-official-notice-after-astra",
    text: "We will reset usage for everyone during the next maintenance window.",
    tweet_url: "https://x.com/thsottiaux/status/unrelated-official-notice-after-astra",
    signal_type: "official_notice" as const,
    confidence: 0.99,
    tweet_created_at: "2026-09-04T22:00:00.000Z",
    expires_at: "2026-09-05T06:00:00.000Z",
    verification_status: "auto_unverified" as const,
    is_reply: false,
  };
  const data = getLocalRadarData({ activeTiboSignals: [notice] });

  assert.equal(getActiveOfficialNotice(data, null, now)?.id, notice.tweet_id);
});

test("the completed Astra rollout teaser is excluded from probability inputs after termination", () => {
  const terminationAt = new Date("2026-09-04T22:30:29.000Z");
  const data = getLocalRadarData({
    activeTiboSignals: [{
      tweet_id: "2095597168816226335",
      text: "We are starting to release GPT-6 Astra.",
      tweet_url: "https://x.com/thsottiaux/status/2095597168816226335",
      tweet_created_at: "2026-09-03T19:37:54.000Z",
      signal_type: "teaser",
      teaser_strength: "weak",
      confidence: 0.9,
      verification_status: "auto_unverified",
    }],
  });

  const calculation = getLocalProbabilityCalculation(data, { now: terminationAt });

  assert.equal(calculation.inputSnapshot.activeTeaserCount, 0);
  assert.deepEqual(calculation.breakdown.contributions.teaserOrEvent, {
    probability24h: 0,
    probability48h: 0,
  });
});

test("an expired confirmed weak teaser is excluded from probability inputs", () => {
  const beforeExpiry = new Date("2026-09-04T15:46:10.999Z");
  const expiry = new Date("2026-09-04T15:46:11.000Z");
  const data = getLocalRadarData({
    activeTiboSignals: [{
      tweet_id: "2095538856296898868",
      text: "Something was felt across the internet today",
      tweet_url: "https://x.com/thsottiaux/status/2095538856296898868",
      tweet_created_at: "2026-09-03T15:46:11.000Z",
      signal_type: "teaser",
      teaser_strength: "weak",
      confidence: 0.9,
      verification_status: "confirmed",
    }],
  });

  assert.equal(getLocalProbabilityCalculation(data, { now: beforeExpiry }).inputSnapshot.activeTeaserCount, 1);
  const afterExpiry = getLocalProbabilityCalculation(data, { now: expiry });
  assert.equal(afterExpiry.inputSnapshot.activeTeaserCount, 0);
  assert.deepEqual(afterExpiry.breakdown.contributions.teaserOrEvent, {
    probability24h: 0,
    probability48h: 0,
  });
});

test("a conditional but non-recurring BANKED notice keeps the existing one-shot path", () => {
  const now = new Date("2026-09-04T04:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [{
      tweet_id: "conditional-one-shot-banked",
      text: "We will give a banked reset to everyone who does not have access to Astra.",
      tweet_url: "https://x.com/thsottiaux/status/conditional-one-shot-banked",
      signal_type: "official_notice",
      confidence: 0.98,
      tweet_created_at: "2026-09-04T03:00:00.000Z",
      expires_at: "2026-09-05T00:00:00.000Z",
      verification_status: "auto_unverified",
    }],
  });

  assert.equal(getOngoingBankedNotice(data, now), null);
  assert.equal(getActiveOfficialNotice(data, null, now)?.id, "conditional-one-shot-banked");
  const calculation = getLocalProbabilityCalculation(data, { now });
  assert.equal(calculation.breakdown.officialNoticeOverride.active, true);

  const afterExpiry = getActiveOfficialNotice(data, null, new Date("2026-09-06T00:00:00.000Z"));
  assert.equal(afterExpiry, null);
});

test("recurring wording alone does not make an unregistered notice persistent", () => {
  const data = getLocalRadarData({
    activeTiboSignals: [{
      tweet_id: "recurring-but-unregistered",
      text: "We will give one banked reset for every day you don't have access to Astra on your paid ChatGPT plan.",
      tweet_url: "https://x.com/thsottiaux/status/recurring-but-unregistered",
      signal_type: "official_notice",
      confidence: 0.98,
      tweet_created_at: "2026-09-03T23:12:09.000Z",
      expires_at: "2026-09-04T05:12:09.000Z",
      verification_status: "auto_unverified",
    }],
  });

  assert.equal(getActiveOfficialNotice(data, null, new Date("2026-09-04T06:00:00.000Z")), null);
});

test("a concrete BANKED deadline is an active range and supersedes its older broad notice", () => {
  const now = new Date("2026-08-22T07:00:00.000Z");
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [
      {
        tweet_id: "banked-old-during-day",
        signal_type: "official_notice",
        text: "During the day we will credit all Codex and ChatGPT Work users with a BANKED reset.",
        tweet_url: "https://x.com/thsottiaux/status/banked-old-during-day",
        tweet_created_at: "2026-08-21T12:00:00.000Z",
        expires_at: "2026-08-23T00:00:00.000Z",
        confidence: 0.99,
        verification_status: "auto_unverified",
        expected_start_at: "2026-08-21T12:00:00.000Z",
        expected_end_at: "2026-08-22T07:00:00.000Z",
        temporal_resolution_status: "resolved",
        ai_temporal_precision: "daypart",
        ai_temporal_timezone: "America/Los_Angeles",
      },
      {
        tweet_id: "banked-new-deadline",
        signal_type: "official_notice",
        text: "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.",
        tweet_url: "https://x.com/thsottiaux/status/banked-new-deadline",
        tweet_created_at: "2026-08-21T23:40:34.000Z",
        expires_at: "2026-08-22T06:00:00.000Z",
        confidence: 0.99,
        verification_status: "auto_unverified",
        expected_start_at: "2026-08-21T23:40:34.000Z",
        expected_end_at: "2026-08-22T04:00:00.000Z",
        temporal_resolution_status: "resolved",
        ai_temporal_precision: "exact_time",
        ai_temporal_timezone: "PST",
      },
    ],
  });

  const active = getActiveOfficialNotice(data, null, now);
  assert.equal(active, null, "the expired concrete notice must prevent the old notice from resurfacing");

  const beforeExpiry = getActiveOfficialNotice(
    data,
    null,
    new Date("2026-08-22T05:00:00.000Z"),
  );
  assert.equal(beforeExpiry?.id, "banked-new-deadline");
  assert.equal(beforeExpiry?.isBankedDistribution, true);
  assert.equal(beforeExpiry?.temporalPrecision, "range");
});

test("getLocalResetProbabilityReason formats English summary without un-translated Japanese text for Tibo Teaser", () => {
  const teaserSignal = LOCAL_OBSERVATION_SIGNALS.find(
    (signal) => signal.id === "official-tibo-signs-resets-teaser-2026-07-31",
  );
  assert.ok(teaserSignal, "The Tibo teaser fixture must exist");

  const previousStatus = teaserSignal.status;
  const previousResolvedAt = teaserSignal.resolvedAt;
  const previousExpiresAt = teaserSignal.expiresAt;
  teaserSignal.status = "active";
  delete teaserSignal.resolvedAt;
  teaserSignal.expiresAt = "2099-01-01T00:00:00.000Z";

  try {
    const viewModel = getRadarViewModel(
      getLocalRadarData({
        activeTiboSignals: [
          {
            tweet_id: "tibo-teaser-fixture",
            signal_type: "teaser",
            confidence: 0.85,
            tweet_created_at: "2026-07-31T13:50:00.000Z",
            expires_at: "2099-01-01T00:00:00.000Z",
            verification_status: "auto_unverified",
          },
        ],
      }),
      "en",
    );
    const englishReason = viewModel.reasoningSummary;

    assert.ok(englishReason);
    assert.ok(englishReason.includes("Tibo's teaser post stating 'There will be signs... Resets'"), `Expected English translation, but got: "${englishReason}"`);
    assert.strictEqual(englishReason.includes("匂わせ投稿"), false, "English summary MUST NOT contain Japanese text '匂わせ投稿'");
  } finally {
    teaserSignal.status = previousStatus;
    if (previousResolvedAt === undefined) delete teaserSignal.resolvedAt;
    else teaserSignal.resolvedAt = previousResolvedAt;
    if (previousExpiresAt === undefined) delete teaserSignal.expiresAt;
    else teaserSignal.expiresAt = previousExpiresAt;
  }
});

test("old reset_executed does not cancel newer official_notice", () => {
  const now = Date.now();
  const oldExecutionTime = new Date(now - 5 * 3600 * 1000).toISOString(); // 5 hours ago
  const newNoticeTime = new Date(now - 1 * 3600 * 1000).toISOString(); // 1 hour ago

  const mockRadarData = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "old_reset",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: oldExecutionTime,
        expires_at: new Date(now + 19 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "new_notice",
        signal_type: "official_notice",
        confidence: 0.96,
        tweet_created_at: newNoticeTime,
        expires_at: new Date(now + 23 * 3600 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
    ],
  });

  const p24 = getLocalResetProbability(mockRadarData as any, "24h");
  assert.strictEqual(p24, 0.90, "Old execution must not cancel newer notice");
});

test("dynamic official notice drives probability, card, reason, and action together", () => {
  const now = Date.now();
  const resetCreatedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const noticeCreatedAt = new Date(now - 60 * 60 * 1000).toISOString();
  const noticeUrl = "https://x.com/tibo_maker/status/dynamic-notice";
  const data = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "dynamic-reset",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: resetCreatedAt,
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "dynamic-notice",
        signal_type: "official_notice",
        text: "A reset notice from Tibo",
        tweet_url: noticeUrl,
        confidence: 0.96,
        tweet_created_at: noticeCreatedAt,
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
    ],
  });

  const viewModel = getRadarViewModel(data, "en");

  assert.strictEqual(viewModel.probability24h, 0.9);
  assert.strictEqual(viewModel.probability48h, 0.96);
  assert.strictEqual(viewModel.activeWindow.active, true);
  assert.strictEqual(viewModel.activeWindow.kind, "official");
  assert.strictEqual(viewModel.activeWindow.source, noticeUrl);
  assert.strictEqual(viewModel.activeWindow.openedAt, noticeCreatedAt);
  assert.strictEqual(viewModel.activeWindow.expectedAt, null);
  assert.match(viewModel.reasoningSummary ?? "", /official reset notice/i);
  assert.match(viewModel.action, /official reset notice/i);
});

for (const { name, signal } of [
  {
    name: "expired notice",
    signal: {
      tweet_id: "expired-notice",
      signal_type: "official_notice" as const,
      confidence: 0.95,
      tweet_created_at: "2026-08-01T11:00:00.000Z",
      expires_at: "2026-08-01T11:30:00.000Z",
      verification_status: "auto_unverified" as const,
    },
  },
  {
    name: "rejected notice",
    signal: {
      tweet_id: "rejected-notice",
      signal_type: "official_notice" as const,
      confidence: 0.95,
      tweet_created_at: "2026-08-01T11:00:00.000Z",
      expires_at: "2026-08-01T13:00:00.000Z",
      verification_status: "rejected" as const,
    },
  },
]) {
  test(`${name} is not selected as an active official notice`, () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const data = getLocalRadarData({ activeTiboSignals: [signal] });

    assert.strictEqual(getActiveOfficialNotice(data, null, now), null);
  });
}

test("notice older than latest accepted reset is not selected as an active official notice", () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const data = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "older-notice",
        signal_type: "official_notice",
        confidence: 0.95,
        tweet_created_at: "2026-08-01T10:00:00.000Z",
        expires_at: "2026-08-01T13:00:00.000Z",
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "newer-reset",
        signal_type: "reset_executed",
        confidence: 0.95,
        tweet_created_at: "2026-08-01T11:00:00.000Z",
        expires_at: "2026-08-01T13:00:00.000Z",
        verification_status: "auto_unverified",
      },
    ],
  });

  assert.strictEqual(getActiveOfficialNotice(data, null, now), null);
});
