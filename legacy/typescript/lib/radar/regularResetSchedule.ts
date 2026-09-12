import { isBroadResetScope } from "./resetEligibility";
import type { WindowEventLike } from "./types";

export type RegularResetScheduleDefinition = {
  schedule_id: string;
  cycle_days: number;
  cycle_type: "定期リセット";
  reset_method: string;
  scope: string;
  window_start_offset_minutes: number;
  window_end_offset_minutes: number;
};

/**
 * The weekly schedule describes the recurring shape only. Its anchor must be
 * supplied by the latest qualifying recovery event at runtime.
 */
export const DEFAULT_REGULAR_RESET_SCHEDULE: RegularResetScheduleDefinition = {
  schedule_id: "weekly-regular-reset",
  cycle_days: 7,
  cycle_type: "定期リセット",
  reset_method: "強制リセット",
  scope: "任意リセット未使用アカウント",
  window_start_offset_minutes: -2,
  window_end_offset_minutes: 13,
};

export type RegularResetEventStatus = "completed" | "corrected" | "voided";

export type RegularResetEventRow = {
  schedule_key: string;
  window_start_at: string;
  window_end_at: string;
  representative_at: string;
  scheduled_at: string;
  completed_at: string;
  cycle_type: "定期リセット";
  reset_method: string;
  scope: string;
  record_kind: "regular_completed";
  status: RegularResetEventStatus;
  correction_reason?: string | null;
  corrected_at?: string | null;
};

const MAX_SCHEDULED_OCCURRENCES = 520;

function parseFiniteDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function isPendingEvent(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  return (
    item.kind === "window_opened" ||
    status === "open" ||
    status === "active" ||
    status === "pending" ||
    status === "scheduled" ||
    status === "announced"
  );
}

function getCanonicalCompletedAt(item: WindowEventLike) {
  if (isPendingEvent(item)) return null;
  return parseFiniteDate(item.closed_at ?? item.completed_at ?? null);
}

function isQualifyingScheduleAnchor(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  if (status === "rejected" || status === "voided") return false;

  const cycleType = item.details?.cycleType;
  if (item.recordKind === "regular_completed") {
    // This record kind is reserved for a canonical scheduled regular wave.
    // Its delivery method may be Banked Reset, but the record itself proves
    // that the weekly boundary was completed; a banked_distribution record
    // only proves that reset credit was distributed.
    return true;
  }

  // Older local records did not use regular_completed yet. Preserve those
  // records only when their regular cycle and broad scope are explicit. A
  // legacy banked_distribution is deliberately excluded: it may be only a
  // manual reset-credit distribution, not an actual weekly boundary.
  if (
    cycleType === "定期リセット" &&
    (item.recordKind === "confirmed_global" || item.recordKind === "reference") &&
    isBroadResetScope(item)
  ) {
    return true;
  }

  if (
    item.recordKind !== "confirmed_global" &&
    item.recordKind !== "banked_distribution"
  ) {
    return false;
  }

  return (
    cycleType === "ランダムリセット" &&
    item.details?.resetMethod === "強制リセット" &&
    isBroadResetScope(item)
  );
}

/**
 * Finds the latest known completed regular or broad forced-reset boundary.
 * The caller supplies already-normalized history so this helper remains pure
 * and cannot accidentally read future or raw notice timestamps.
 */
export function getLatestRegularScheduleAnchorAt(
  events: readonly WindowEventLike[],
  now: Date = new Date(),
): string | null {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return null;

  let latestTime = 0;
  let latestAt: string | null = null;

  for (const event of events) {
    if (!isQualifyingScheduleAnchor(event)) continue;

    const completedAt = getCanonicalCompletedAt(event);
    if (!completedAt || completedAt.getTime() > nowTime) continue;

    if (completedAt.getTime() > latestTime) {
      latestTime = completedAt.getTime();
      latestAt = event.closed_at ?? event.completed_at ?? null;
    }
  }

  return latestAt;
}

function createRegularResetEventRow(
  definition: RegularResetScheduleDefinition,
  representativeAt: Date,
  completedAt: string,
): RegularResetEventRow {
  const scheduledAt = representativeAt.toISOString();

  return {
    schedule_key: `${definition.schedule_id}:${scheduledAt}`,
    window_start_at: addMinutes(
      representativeAt,
      definition.window_start_offset_minutes,
    ).toISOString(),
    window_end_at: addMinutes(
      representativeAt,
      definition.window_end_offset_minutes,
    ).toISOString(),
    representative_at: scheduledAt,
    scheduled_at: scheduledAt,
    completed_at: completedAt,
    cycle_type: definition.cycle_type,
    reset_method: definition.reset_method,
    scope: definition.scope,
    record_kind: "regular_completed",
    status: "completed",
  };
}

function createScheduledRow(
  definition: RegularResetScheduleDefinition,
  anchorAt: Date,
  occurrenceIndex: number,
): RegularResetEventRow {
  const representativeAt = addDays(
    anchorAt,
    occurrenceIndex * definition.cycle_days,
  );
  return createRegularResetEventRow(definition, representativeAt, representativeAt.toISOString());
}

/**
 * Creates a canonical regular event only after the Usage Monitor has observed
 * the recovery. scheduled_at remains the expected boundary; completed_at is
 * the measured quota recovery time.
 */
export function createObservedRegularResetEventRow(
  scheduledAt: string,
  completedAt: string,
  definition: RegularResetScheduleDefinition = DEFAULT_REGULAR_RESET_SCHEDULE,
): RegularResetEventRow {
  const representativeAt = parseFiniteDate(scheduledAt);
  const completedDate = parseFiniteDate(completedAt);
  if (!representativeAt || !completedDate) {
    throw new Error("Invalid regular reset observation timestamp");
  }
  return createRegularResetEventRow(definition, representativeAt, completedDate.toISOString());
}

/**
 * Returns only weekly occurrences after the supplied anchor whose
 * representative time has arrived. Callers may use these deterministic rows
 * as a read-side completion projection; persisted history still comes from an
 * observed row when Usage Monitor confirms the recovery.
 */
export function getDueRegularResetEventRows(
  now: Date,
  latestAnchorAt: string | null | undefined,
  definition: RegularResetScheduleDefinition = DEFAULT_REGULAR_RESET_SCHEDULE,
): RegularResetEventRow[] {
  const nowMs = now.getTime();
  const anchor = parseFiniteDate(latestAnchorAt);

  if (
    !Number.isFinite(nowMs) ||
    !anchor ||
    definition.cycle_days <= 0 ||
    !Number.isFinite(definition.window_start_offset_minutes) ||
    !Number.isFinite(definition.window_end_offset_minutes)
  ) {
    return [];
  }

  const rows: RegularResetEventRow[] = [];
  let occurrenceIndex = 1;

  while (rows.length < MAX_SCHEDULED_OCCURRENCES) {
    const row = createScheduledRow(definition, anchor, occurrenceIndex);
    if (new Date(row.representative_at).getTime() > nowMs) {
      break;
    }

    rows.push(row);
    occurrenceIndex += 1;
  }

  return rows;
}

export function toRegularResetHistoryEvent(
  row: RegularResetEventRow,
): WindowEventLike {
  const windowStart = parseFiniteDate(row.window_start_at);
  const windowEnd = parseFiniteDate(row.window_end_at);
  const windowMinutes =
    windowStart && windowEnd
      ? Math.max(0, Math.round((windowEnd.getTime() - windowStart.getTime()) / 60000))
      : 0;
  const isVoided = row.status === "voided";
  const summary = "定期リセットが予定時刻に実施されました。";

  return {
    id: `regular-reset-${row.schedule_key.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    recordKind: "regular_completed",
    title: "定期リセット",
    kind: "reset_completed",
    status: isVoided ? "voided" : "closed",
    opened_at: row.window_start_at,
    closed_at: row.completed_at,
    completed_at: row.completed_at,
    window_minutes: windowMinutes,
    window_human: "定期実施",
    scope: row.scope,
    summary,
    source_url: null,
    details: {
      cycleType: row.cycle_type,
      reasonType: "定期更新",
      resetMethod: row.reset_method,
      scope: row.scope,
      noticeToExecution: "0分（定期）",
      noticeType: "なし",
      note: summary,
    },
  };
}
