import { getCompletedResetTimestamp } from "./probability";
import { isGenericResetDisplayTitle } from "./resetDisplayNames";
import type { HistoryRecordKind, WindowEventLike } from "./types";

const AUTO_NAMEABLE_RECORD_KINDS = new Set<HistoryRecordKind>([
  "confirmed_global",
  "banked_distribution",
]);

/** Returns only the identity already assigned by canonical history. */
export function getCanonicalResetDisplayNameEventKey(item: WindowEventLike) {
  return item.id?.trim() || item.guid?.trim() || null;
}

/**
 * Naming eligibility is deliberately separate from probability eligibility.
 * A canonical conditional BANKED event can be named even when it is excluded
 * from the broad random-reset probability target.
 */
export function isAutoNameableCanonicalEvent(
  item: WindowEventLike,
  now: Date = new Date(),
) {
  if (!AUTO_NAMEABLE_RECORD_KINDS.has(item.recordKind as HistoryRecordKind)) {
    return false;
  }
  if (item.details?.cycleType !== "ランダムリセット") return false;
  if ((item as WindowEventLike & { is_reply?: boolean }).is_reply === true) return false;
  if (item.status?.trim().toLowerCase() === "rejected") return false;

  const completedAt = getCompletedResetTimestamp(item);
  const nowTime = now.getTime();
  if (
    completedAt === null ||
    !Number.isFinite(completedAt) ||
    !Number.isFinite(nowTime) ||
    completedAt > nowTime
  ) {
    return false;
  }

  return isGenericResetDisplayTitle(item.title);
}
