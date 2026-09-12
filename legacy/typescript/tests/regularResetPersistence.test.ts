import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REGULAR_RESET_SCHEDULE,
  createObservedRegularResetEventRow,
  getLatestRegularScheduleAnchorAt as getLatestAnchorFromEvents,
  getDueRegularResetEventRows,
  toRegularResetHistoryEvent,
} from "../lib/radar/regularResetSchedule";
import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import {
  getLastGlobalResetAt,
  getLastResetBoundaryAt,
} from "../lib/radar/probability";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";

const INITIAL_ANCHOR_AT = "2026-08-08T03:32:00.000Z";
const FORCED_RESET_AT = "2026-08-13T03:34:43.341Z";

function resetEvent(
  at: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `reset-${at}`,
    recordKind: "confirmed_global" as const,
    status: "closed",
    closed_at: at,
    completed_at: at,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ランダムリセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      ...((overrides.details as Record<string, unknown> | undefined) ?? {}),
    },
    ...overrides,
  };
}

function regularEvent(at: string, overrides: Record<string, unknown> = {}) {
  return resetEvent(at, {
    recordKind: "regular_completed",
    details: {
      cycleType: "定期リセット",
      reasonType: "定期更新",
      resetMethod: "強制リセット",
      scope: "任意リセット未使用アカウント",
      noticeToExecution: "0分（定期）",
    },
    scope: "任意リセット未使用アカウント",
    ...overrides,
  });
}

test("does not persist the next regular reset before the anchored weekly boundary", () => {
  const rows = getDueRegularResetEventRows(
    new Date("2026-08-15T03:31:59.000Z"),
    INITIAL_ANCHOR_AT,
  );

  assert.deepEqual(rows, []);
});

test("creates one completed regular event seven days after the latest anchor", () => {
  const rows = getDueRegularResetEventRows(
    new Date("2026-08-15T03:32:00.000Z"),
    INITIAL_ANCHOR_AT,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].schedule_key, "weekly-regular-reset:2026-08-15T03:32:00.000Z");
  assert.equal(rows[0].scheduled_at, "2026-08-15T03:32:00.000Z");
  assert.equal(rows[0].completed_at, "2026-08-15T03:32:00.000Z");
  assert.equal(rows[0].cycle_type, "定期リセット");
  assert.equal(rows[0].record_kind, "regular_completed");
  assert.equal(rows[0].status, "completed");
});

test("an observed regular recovery uses the monitor observation time, not the schedule time", () => {
  const row = createObservedRegularResetEventRow(
    "2026-08-20T03:34:43.341Z",
    "2026-08-20T03:40:00.000Z",
  );

  assert.equal(row.scheduled_at, "2026-08-20T03:34:43.341Z");
  assert.equal(row.completed_at, "2026-08-20T03:40:00.000Z");
  assert.notEqual(row.completed_at, row.scheduled_at);
  assert.equal(row.status, "completed");
});

test("generates each missed weekly occurrence with a stable key", () => {
  const rows = getDueRegularResetEventRows(
    new Date("2026-08-22T03:32:00.000Z"),
    INITIAL_ANCHOR_AT,
  );

  assert.deepEqual(
    rows.map((row) => row.scheduled_at),
    [
      "2026-08-15T03:32:00.000Z",
      "2026-08-22T03:32:00.000Z",
    ],
  );
  assert.deepEqual(
    rows,
    getDueRegularResetEventRows(
      new Date("2026-08-22T03:32:00.000Z"),
      INITIAL_ANCHOR_AT,
    ),
  );
  assert.equal(new Set(rows.map((row) => row.schedule_key)).size, rows.length);
});

test("a scheduled Banked Reset remains a regular event, not a random event", () => {
  const rows = getDueRegularResetEventRows(new Date("2026-08-15T03:32:00.000Z"), INITIAL_ANCHOR_AT, {
    ...DEFAULT_REGULAR_RESET_SCHEDULE,
    reset_method: "任意リセット権配布",
  });

  const history = toRegularResetHistoryEvent(rows[0]);
  assert.equal(history.recordKind, "regular_completed");
  assert.equal(history.details?.cycleType, "定期リセット");
  assert.equal(history.details?.resetMethod, "任意リセット権配布");
});

test("persisted regular reset restarts the elapsed-time boundary without becoming a random target", () => {
  const now = new Date("2026-08-15T05:00:00.000Z");
  const row = getDueRegularResetEventRows(now, INITIAL_ANCHOR_AT)[0];
  const data = getLocalRadarData({
    calculationNow: now,
    regularResetEvents: [row],
  });

  assert.equal(getLastResetBoundaryAt(data, now)?.toISOString(), "2026-08-15T03:32:00.000Z");
  assert.notEqual(getLastGlobalResetAt(data, now)?.toISOString(), "2026-08-15T03:32:00.000Z");

  const viewModel = getRadarViewModel(data, "ja", false, undefined, now);
  assert.equal(viewModel.regularResetForecast.sourceResetAt, "2026-08-15T03:32:00.000Z");
  assert.equal(viewModel.regularResetForecast.lastCompletedAt, "2026-08-15T03:32:00.000Z");
});

test("a regular boundary does not consume earlier teaser strength and allows a later teaser", () => {
  const now = new Date("2026-08-15T05:00:00.000Z");
  const row = getDueRegularResetEventRows(now, INITIAL_ANCHOR_AT)[0];
  const baseSignal = {
    tweet_id: "regular-boundary-teaser",
    signal_type: "irrelevant" as const,
    text: "A possible reset",
    tweet_url: "https://x.com/thsottiaux/status/regular-boundary-teaser",
    tweet_created_at: "2026-08-15T03:20:00.000Z",
    verification_status: "auto_unverified" as const,
    teaser_strength: "strong" as const,
    status: "active",
    expectation: "",
    action: "",
  };

  const beforeBoundary = getLocalRadarData({
    calculationNow: now,
    regularResetEvents: [row],
    recentTiboSignals: [baseSignal],
  });
  const beforeSnapshot = toPublicRadarSnapshot(beforeBoundary, "ja", { calculationNow: now });
  assert.equal(beforeSnapshot.resetTeaserStatus, "strong");
  assert.equal(beforeSnapshot.latestTiboActivity?.text, "A possible reset");

  const afterBoundary = getLocalRadarData({
    calculationNow: now,
    regularResetEvents: [row],
    recentTiboSignals: [{ ...baseSignal, tweet_created_at: "2026-08-15T04:00:00.000Z" }],
  });
  assert.equal(
    toPublicRadarSnapshot(afterBoundary, "ja", { calculationNow: now }).resetTeaserStatus,
    "strong",
  );
});

test("uses the latest broad forced reset as the new schedule anchor", () => {
  assert.equal(
    getLatestAnchorFromEvents([
      regularEvent(INITIAL_ANCHOR_AT),
      resetEvent(FORCED_RESET_AT),
    ], new Date("2026-08-20T00:00:00.000Z")),
    FORCED_RESET_AT,
  );

  assert.deepEqual(
    getDueRegularResetEventRows(
      new Date("2026-08-20T03:34:43.340Z"),
      FORCED_RESET_AT,
    ),
    [],
  );
  assert.deepEqual(
    getDueRegularResetEventRows(
      new Date("2026-08-20T03:34:43.341Z"),
      FORCED_RESET_AT,
    ).map((row) => row.scheduled_at),
    ["2026-08-20T03:34:43.341Z"],
  );
});

test("a later forced reset re-anchors the following regular occurrence", () => {
  const laterForcedAt = "2026-08-18T10:00:00.000Z";
  assert.deepEqual(
    getDueRegularResetEventRows(
      new Date("2026-08-25T10:00:00.000Z"),
      laterForcedAt,
    ).map((row) => row.scheduled_at),
    ["2026-08-25T10:00:00.000Z"],
  );
});

test("excludes banked, narrow, voided, and future reset candidates", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  assert.equal(
    getLatestAnchorFromEvents([
      resetEvent("2026-08-10T00:00:00.000Z", {
        recordKind: "banked_distribution",
        details: { resetMethod: "任意リセット権配布" },
      }),
    ], now),
    null,
  );
  assert.equal(
    getLatestAnchorFromEvents([
      resetEvent("2026-08-11T00:00:00.000Z", { scope: "一部ユーザー" }),
    ], now),
    null,
  );
  assert.equal(
    getLatestAnchorFromEvents([
      resetEvent("2026-08-12T00:00:00.000Z", { status: "voided" }),
    ], now),
    null,
  );
  assert.equal(
    getLatestAnchorFromEvents([
      resetEvent("2026-08-21T00:00:00.000Z"),
    ], now),
    null,
  );
});

test("does not use a legacy regular banked distribution as a schedule anchor", () => {
  const legacyBankedDistribution = resetEvent("2026-06-12T00:11:00.000Z", {
    recordKind: "banked_distribution",
    scope: "全有料プラン",
    details: {
      cycleType: "定期リセット",
      resetMethod: "任意リセット権配布",
      scope: "全有料プラン",
    },
  });

  assert.equal(
    getLatestAnchorFromEvents(
      [legacyBankedDistribution],
      new Date("2026-06-13T00:00:00.000Z"),
    ),
    null,
  );
});

test("canonical regular_completed rows remain valid anchors, including a Banked Reset delivery", () => {
  assert.equal(
    getLatestAnchorFromEvents([
      regularEvent(INITIAL_ANCHOR_AT, {
        details: { resetMethod: "任意リセット権配布" },
      }),
    ], new Date("2026-08-15T00:00:00.000Z")),
    INITIAL_ANCHOR_AT,
  );
});

test("uses the canonical completed timestamp rather than an older completion hint", () => {
  const canonicalAt = "2026-08-13T03:34:43.341Z";
  assert.equal(
    getLatestAnchorFromEvents([
      resetEvent(canonicalAt, { completed_at: "2026-08-13T03:00:00.000Z" }),
    ], new Date("2026-08-14T00:00:00.000Z")),
    canonicalAt,
  );
});

test("does not regenerate the old fixed 2026-08-22 occurrence after a 2026-08-13 anchor", () => {
  assert.deepEqual(
    getDueRegularResetEventRows(
      new Date("2026-08-22T03:32:00.000Z"),
      FORCED_RESET_AT,
    ).map((row) => row.scheduled_at),
    ["2026-08-20T03:34:43.341Z"],
  );
});
