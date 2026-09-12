import { LOCAL_RESET_HISTORY } from "@/data/resetHistory";
import type { RadarData, WindowEventLike } from "./types";
import {
  combineResetHistory,
  getNoticeBackedHistoryInputs,
  getCanonicalResetHistoryForStaticHistory,
  type CanonicalResetHistoryContext,
} from "./tiboHistory";
import { isEligibleRandomResetEvent } from "./resetEligibility";
import type { ResetExecutionWindow } from "./tiboTemporal";

const RECOVERY_BOUNDARY_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

const NARROW_SCOPE_PATTERN =
  /特定|対象ユーザー|不具合対象|個人|一部|限定|単一|specific|affected|individual|subset|single|limited/i;

export type RecoveryResetBoundary = {
  id: string;
  resetAt: string;
  isRandom: boolean;
  isRegular: boolean;
  sourceIds: string[];
};

export type RecoveryBoundaryAudit = {
  id: string;
  resetAt: string | null;
  included: boolean;
  randomEligible: boolean;
  regularEligible: boolean;
  reason:
    | "random_boundary"
    | "regular_boundary"
    | "random_and_regular_boundary"
    | "rejected"
    | "voided"
    | "future"
    | "invalid_timestamp"
    | "pending"
    | "narrow_scope"
    | "not_recovery_event";
};

function getTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getCompletedTimestamp(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  if (
    item.kind === "window_opened" ||
    status === "open" ||
    status === "active" ||
    status === "pending" ||
    status === "scheduled" ||
    status === "announced"
  ) {
    return null;
  }

  return getTimestamp(item.closed_at ?? item.completed_at);
}

function getScope(item: WindowEventLike) {
  return (item.scope ?? item.details?.scope ?? "").trim();
}

function isNarrowScope(item: WindowEventLike) {
  const scope = getScope(item);
  if (!scope) {
    return item.recordKind !== "confirmed_global";
  }
  return NARROW_SCOPE_PATTERN.test(scope);
}

function isRejectedOrVoided(item: WindowEventLike) {
  const status = item.status?.toLowerCase();
  return status === "rejected" || status === "voided";
}

export function isEligibleRecoveryResetEvent(
  item: WindowEventLike,
  completedAt: number | null,
  nowTime: number,
) {
  if (isRejectedOrVoided(item) || isNarrowScope(item)) return false;
  if (!Number.isFinite(completedAt) || !Number.isFinite(nowTime) || completedAt! > nowTime) {
    return false;
  }

  const cycleType = item.details?.cycleType;
  return cycleType === "定期リセット" || isEligibleRandomResetEvent(item, completedAt, nowTime);
}

function isEligibleRegularRecoveryResetEvent(
  item: WindowEventLike,
  completedAt: number | null,
  nowTime: number,
) {
  return Boolean(
    item.details?.cycleType === "定期リセット" &&
      !isRejectedOrVoided(item) &&
      !isNarrowScope(item) &&
      Number.isFinite(completedAt) &&
      Number.isFinite(nowTime) &&
      completedAt! <= nowTime,
  );
}

function getCombinedHistory(
  data: RadarData | null,
  staticHistory: Array<WindowEventLike>,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  if (canonicalHistoryContext) {
    const canonicalHistory = getCanonicalResetHistoryForStaticHistory(
      canonicalHistoryContext,
      staticHistory,
    );
    if (canonicalHistory) return canonicalHistory;
  }

  const {
    noticeSignals,
    bankedSignals,
    recoveryObservations,
    estimates,
    identityContext,
  } = getNoticeBackedHistoryInputs(data);

  return combineResetHistory(
    staticHistory,
    data?.formal_tibo_resets ?? [],
    data?.rejected_tibo_resets ?? [],
    data?.regular_reset_events ?? [],
    noticeSignals,
    recoveryObservations,
    estimates,
    bankedSignals,
    identityContext,
  );
}

function getAuditReason(
  item: WindowEventLike,
  completedAt: number | null,
  nowTime: number,
  randomEligible: boolean,
  regularEligible: boolean,
): RecoveryBoundaryAudit["reason"] {
  if (item.status?.toLowerCase() === "rejected") return "rejected";
  if (item.status?.toLowerCase() === "voided") return "voided";
  if (item.kind === "window_opened" || !item.closed_at && !item.completed_at) return "pending";
  if (completedAt === null) return "invalid_timestamp";
  if (completedAt > nowTime) return "future";
  if (isNarrowScope(item)) return "narrow_scope";
  if (randomEligible && regularEligible) return "random_and_regular_boundary";
  if (randomEligible) return "random_boundary";
  if (regularEligible) return "regular_boundary";
  return "not_recovery_event";
}

export function getRecoveryBoundaryAudit(
  data: RadarData | null,
  now: Date,
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): RecoveryBoundaryAudit[] {
  const nowTime = now.getTime();
  return getCombinedHistory(data, staticHistory, canonicalHistoryContext).map((item, index) => {
    const completedAt = getCompletedTimestamp(item);
    const randomEligible = isEligibleRandomResetEvent(item, completedAt, nowTime) && !isRejectedOrVoided(item);
    const regularEligible = isEligibleRegularRecoveryResetEvent(item, completedAt, nowTime);
    const included = randomEligible || regularEligible;
    return {
      id: item.id ?? `history-${index}`,
      resetAt: completedAt === null ? null : new Date(completedAt).toISOString(),
      included,
      randomEligible,
      regularEligible,
      reason: getAuditReason(item, completedAt, nowTime, randomEligible, regularEligible),
    };
  });
}

export function getRecoveryResetEvents(
  data: RadarData | null,
  now: Date,
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): RecoveryResetBoundary[] {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return [];

  const candidates = getCombinedHistory(data, staticHistory, canonicalHistoryContext)
    .flatMap((item, index) => {
      const completedAt = getCompletedTimestamp(item);
      const randomEligible = isEligibleRandomResetEvent(item, completedAt, nowTime) && !isRejectedOrVoided(item);
      const regularEligible = isEligibleRegularRecoveryResetEvent(item, completedAt, nowTime);
      if (!randomEligible && !regularEligible || completedAt === null) return [];
      return [{
        id: item.id ?? `history-${index}`,
        time: completedAt,
        isRandom: randomEligible,
        isRegular: regularEligible,
      }];
    })
    .sort((left, right) => left.time - right.time);

  const boundaries: RecoveryResetBoundary[] = [];
  for (const candidate of candidates) {
    const previous = boundaries.at(-1);
    const crossTypeBoundary = previous &&
      ((previous.isRegular && !previous.isRandom && candidate.isRandom && !candidate.isRegular) ||
        (previous.isRandom && !previous.isRegular && candidate.isRegular && !candidate.isRandom));
    const sameBoundary = previous &&
      !crossTypeBoundary &&
      candidate.time - new Date(previous.resetAt).getTime() <= RECOVERY_BOUNDARY_DEDUPE_WINDOW_MS;
    if (sameBoundary) {
      previous.isRandom ||= candidate.isRandom;
      previous.isRegular ||= candidate.isRegular;
      previous.sourceIds.push(candidate.id);
      continue;
    }

    boundaries.push({
      id: candidate.id,
      resetAt: new Date(candidate.time).toISOString(),
      isRandom: candidate.isRandom,
      isRegular: candidate.isRegular,
      sourceIds: [candidate.id],
    });
  }

  return boundaries;
}

export function getLastRecoveryResetAt(
  data: RadarData | null,
  now: Date = new Date(),
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  return getRecoveryResetEvents(data, now, staticHistory, canonicalHistoryContext).at(-1)?.resetAt ?? null;
}

export function getLastRandomRecoveryResetAt(
  data: RadarData | null,
  now: Date = new Date(),
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
) {
  return getRecoveryResetEvents(data, now, staticHistory, canonicalHistoryContext)
    .filter((boundary) => boundary.isRandom)
    .at(-1)?.resetAt ?? null;
}

export function getLastRandomRecoveryResetWindow(
  data: RadarData | null,
  now: Date = new Date(),
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
  canonicalHistoryContext?: CanonicalResetHistoryContext,
): ResetExecutionWindow | null {
  const boundary = getRecoveryResetEvents(data, now, staticHistory, canonicalHistoryContext)
    .filter((candidate) => candidate.isRandom)
    .at(-1);
  if (!boundary) return null;

  const boundaryTime = getTimestamp(boundary.resetAt);
  if (boundaryTime === null) return null;

  const estimate = (data?.reset_execution_estimates ?? []).find((candidate) => {
    const displayTime = getTimestamp(candidate.displayExecutionAt);
    const windowStartTime = getTimestamp(candidate.executionWindowStartAt ?? null);
    const windowEndTime = getTimestamp(candidate.executionWindowEndAt ?? null);
    return displayTime === boundaryTime &&
      windowStartTime !== null &&
      windowEndTime !== null &&
      windowStartTime < windowEndTime &&
      windowEndTime === displayTime;
  });

  return {
    executionWindowStartAt: estimate?.executionWindowStartAt ?? null,
    executionWindowEndAt: boundary.resetAt,
  };
}
