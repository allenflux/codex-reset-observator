import assert from "node:assert/strict";
import test from "node:test";
import {
  getTemporalNoticeCoverage,
  isOverdueNoticePending,
  TIBO_NOTICE_GRACE_MS,
} from "../lib/radar/tiboTemporal";
import { getRadarViewModel } from "../lib/radar";
import type { RadarData } from "../lib/radar/types";

const EXPECTED_ISO = "2026-08-13T02:01:37.000Z";
const EXPECTED_TIME = Date.parse(EXPECTED_ISO);

const exactNoticeResolution = {
  status: "resolved" as const,
  temporalPrecision: "exact_time" as const,
  confidence: 0.9,
  expectedStartAt: EXPECTED_ISO,
  expectedEndAt: EXPECTED_ISO,
};

test("A. exact_time before due has full notice coverage (1.0)", () => {
  const now = new Date(EXPECTED_TIME - 60 * 60 * 1000); // 1 hour before
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 1);
});

test("B. exact_time exactly due has full notice support (1.0)", () => {
  const now = new Date(EXPECTED_TIME);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 1);
});

test("C. exact_time 45m overdue has 0.75 grace factor", () => {
  const now = new Date(EXPECTED_TIME + 45 * 60 * 1000);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 0.75);
});

test("D. exact_time 90m overdue has 0.50 grace factor", () => {
  const now = new Date(EXPECTED_TIME + 90 * 60 * 1000);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 0.5);
});

test("E. exact_time 135m overdue has 0.25 grace factor", () => {
  const now = new Date(EXPECTED_TIME + 135 * 60 * 1000);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 0.25);
});

test("F. exact_time at grace expiry (180m) has 0.0 support", () => {
  const now = new Date(EXPECTED_TIME + TIBO_NOTICE_GRACE_MS);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 0);
});

test("G. exact_time after grace expiry (>180m) has 0.0 support", () => {
  const now = new Date(EXPECTED_TIME + TIBO_NOTICE_GRACE_MS + 60 * 1000);
  const coverage24 = getTemporalNoticeCoverage(exactNoticeResolution, now, 24);
  assert.equal(coverage24, 0);
});

const nonExactNoticeResolution = {
  status: "resolved" as const,
  temporalPrecision: "day" as const,
  confidence: 0.9,
  expectedStartAt: EXPECTED_ISO,
  expectedEndAt: new Date(EXPECTED_TIME + 60 * 60 * 1000).toISOString(),
};

test("non-exact window just before expected end retains positive coverage", () => {
  const end = Date.parse(nonExactNoticeResolution.expectedEndAt);
  const coverage24 = getTemporalNoticeCoverage(nonExactNoticeResolution, new Date(end - 1), 24);
  assert.equal(coverage24, 0.9);
});

test("non-exact day window ends immediately without the exact-time grace", () => {
  const end = Date.parse(nonExactNoticeResolution.expectedEndAt);
  assert.equal(getTemporalNoticeCoverage(nonExactNoticeResolution, new Date(end), 24), 0);
  assert.equal(getTemporalNoticeCoverage(nonExactNoticeResolution, new Date(end + 30 * 60 * 1000), 24), 0);
});

test("non-exact daypart and range windows end immediately without grace", () => {
  const end = Date.parse(nonExactNoticeResolution.expectedEndAt);
  for (const temporalPrecision of ["daypart", "range"] as const) {
    assert.equal(
      getTemporalNoticeCoverage(
        { ...nonExactNoticeResolution, temporalPrecision },
        new Date(end + 1),
        24,
      ),
      0,
    );
  }
});

test("non-exact coverage does not rise at the window end", () => {
  const end = Date.parse(nonExactNoticeResolution.expectedEndAt);
  const beforeEnd = getTemporalNoticeCoverage(nonExactNoticeResolution, new Date(end - 1), 24);
  const atEnd = getTemporalNoticeCoverage(nonExactNoticeResolution, new Date(end), 24);
  assert.ok(beforeEnd !== null && atEnd !== null && atEnd <= beforeEnd);
});

test("H. reset confirmation ends overdue pending state", () => {
  const overdueNow = new Date(EXPECTED_TIME + 23 * 60 * 1000); // 23 min overdue

  // Unconfirmed reset -> overdue pending is true
  const pendingBefore = isOverdueNoticePending(exactNoticeResolution, null, overdueNow);
  assert.equal(pendingBefore, true);

  // Confirmed reset after expectedStartAt -> overdue pending is false
  const resetAt = new Date(EXPECTED_TIME + 5 * 60 * 1000).toISOString();
  const pendingAfter = isOverdueNoticePending(exactNoticeResolution, resetAt, overdueNow);
  assert.equal(pendingAfter, false);
});

test("I. UI overdue pending presentation for JA, EN, ZH", () => {
  const overdueNow = new Date(EXPECTED_TIME + 23 * 60 * 1000);
  const mockRadarData: RadarData = {
    active_tibo_signals: [
      {
        tweet_id: "2087706104814023111",
        text: "Landing in the next hour or so",
        tweet_created_at: "2026-08-13T01:01:37.000Z",
        signal_type: "official_notice",
        confidence: 0.95,
        ai_signal_type: "official_notice",
        ai_confidence: 0.95,
        ai_temporal_direction: "future",
        ai_notice_to_execution: "in the next hour or so",
        ai_temporal_expression: "in the next hour or so",
        ai_temporal_kind: "relative_duration",
        ai_temporal_precision: "exact_time",
        ai_temporal_timezone: "America/Los_Angeles",
        ai_temporal_confidence: 0.9,
        expected_start_at: EXPECTED_ISO,
        expected_end_at: EXPECTED_ISO,
        temporal_resolution_status: "resolved",
        temporal_resolution_version: "tibo-temporal-v1",
        expires_at: "2026-08-13T04:01:37.000Z",
      } as any,
    ],
  };

  const jaVm = getRadarViewModel(mockRadarData, "ja", false, undefined, overdueNow);
  assert.equal(jaVm.activeWindow.isOverduePending, true);
  assert.equal(jaVm.activeWindow.overdueText, "予定時刻を過ぎています。リセットを確認中です。");

  const enVm = getRadarViewModel(mockRadarData, "en", false, undefined, overdueNow);
  assert.equal(enVm.activeWindow.isOverduePending, true);
  assert.equal(enVm.activeWindow.overdueText, "The expected time has passed. Waiting for reset confirmation.");

  const zhVm = getRadarViewModel(mockRadarData, "zh", false, undefined, overdueNow);
  assert.equal(zhVm.activeWindow.isOverduePending, true);
  assert.equal(zhVm.activeWindow.overdueText, "预计时间已过，正在等待重置确认。");

  // Before expectedAt -> non-overdue
  const beforeNow = new Date(EXPECTED_TIME - 10 * 60 * 1000);
  const beforeVm = getRadarViewModel(mockRadarData, "ja", false, undefined, beforeNow);
  assert.equal(beforeVm.activeWindow.isOverduePending, false);
  assert.equal(beforeVm.activeWindow.overdueText, null);

  // After grace expiry -> notice expired / non-overdue
  const afterGraceNow = new Date(EXPECTED_TIME + TIBO_NOTICE_GRACE_MS + 1000);
  const afterGraceVm = getRadarViewModel(mockRadarData, "ja", false, undefined, afterGraceNow);
  assert.equal(afterGraceVm.activeWindow.isOverduePending, false);
  assert.equal(afterGraceVm.activeWindow.overdueText, null);
});

test("Real August 13 sample overdue behavior", () => {
  const tweetCreatedAt = "2026-08-13T01:01:37.000Z";
  const expectedAt = "2026-08-13T02:01:37.000Z"; // 11:01 JST
  const overdueNow = new Date("2026-08-13T02:24:44.000Z"); // 11:24 JST (~23 min overdue)

  const mockRadarData: RadarData = {
    active_tibo_signals: [
      {
        tweet_id: "2087706104814023111",
        text: "Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
        tweet_created_at: tweetCreatedAt,
        signal_type: "official_notice",
        confidence: 0.95,
        ai_signal_type: "official_notice",
        ai_confidence: 0.95,
        ai_temporal_direction: "future",
        ai_notice_to_execution: "in the next hour or so",
        ai_temporal_expression: "in the next hour or so",
        ai_temporal_kind: "relative_duration",
        ai_temporal_precision: "exact_time",
        ai_temporal_timezone: "America/Los_Angeles",
        ai_temporal_confidence: 0.9,
        expected_start_at: expectedAt,
        expected_end_at: expectedAt,
        temporal_resolution_status: "resolved",
        temporal_resolution_version: "tibo-temporal-v1",
        expires_at: "2026-08-13T04:01:37.000Z",
      } as any,
    ],
  };

  const vmOverdue = getRadarViewModel(mockRadarData, "ja", false, undefined, overdueNow);
  const vmBefore = getRadarViewModel(mockRadarData, "ja", false, undefined, new Date("2026-08-13T01:30:00.000Z"));
  const vmWithoutNotice = getRadarViewModel({ active_tibo_signals: [] }, "ja", false, undefined, overdueNow);

  // 1. Notice is active
  assert.equal(vmOverdue.activeWindow.active, true);
  assert.equal(vmOverdue.activeWindow.isOverduePending, true);

  const prob24hOverdue = vmOverdue.probability24h ?? 0;
  const prob24hWithout = vmWithoutNotice.probability24h ?? 0;
  const prob24hBefore = vmBefore.probability24h ?? 0;
  const prob48hOverdue = vmOverdue.probability48h ?? 0;
  const prob48hWithout = vmWithoutNotice.probability48h ?? 0;

  // 2. Overdue probability degrades gracefully, strictly bounded between baseline and full notice
  assert.ok(
    prob24hOverdue > prob24hWithout,
    `Overdue 24h prob (${prob24hOverdue}) should be greater than baseline (${prob24hWithout})`,
  );
  assert.ok(
    prob24hOverdue <= prob24hBefore,
    `Overdue 24h prob (${prob24hOverdue}) should be less than or equal to pre-deadline prob (${prob24hBefore})`,
  );

  assert.ok(
    prob48hOverdue > prob48hWithout,
    `Overdue 48h prob (${prob48hOverdue}) should be greater than baseline (${prob48hWithout})`,
  );
});
