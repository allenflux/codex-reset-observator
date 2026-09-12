import type { WindowEventLike } from "./types";
import { isExcludedResetEventKey } from "@/data/resetHistory";

const BROAD_SCOPE_PATTERN = /全|all|every|global|codex\s*\/\s*chatgpt/i;
const NARROW_SCOPE_PATTERN = /特定|対象ユーザー|不具合対象|個人|一部|限定|単一|specific|affected|individual|subset|single|limited/i;

export function isBroadResetScope(item: WindowEventLike) {
  const scope = item.scope ?? item.details?.scope ?? "";
  if (!scope.trim()) {
    return item.recordKind === "confirmed_global";
  }

  const normalizedScope = scope.trim().toLowerCase();
  return BROAD_SCOPE_PATTERN.test(normalizedScope) && !NARROW_SCOPE_PATTERN.test(normalizedScope);
}

export function isEligibleRandomResetEvent(
  item: WindowEventLike,
  completedAt: number | null,
  nowTime: number,
) {
  if (isExcludedResetEventKey(item.id)) {
    return false;
  }
  if (item.recordKind !== "confirmed_global" && item.recordKind !== "banked_distribution") {
    return false;
  }
  if (item.randomResetTargetScope === "conditional") {
    return false;
  }
  if (item.details?.cycleType !== "ランダムリセット") {
    return false;
  }
  if (!isBroadResetScope(item)) {
    return false;
  }
  return (
    Number.isFinite(completedAt) &&
    Number.isFinite(nowTime) &&
    completedAt! <= nowTime
  );
}
