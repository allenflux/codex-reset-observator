/**
 * Deterministic interpretation of temporal semantics extracted from a Tibo
 * post. Gemini may identify the words and their meaning, but it never supplies
 * a trusted timestamp. All timestamps below are derived from the tweet instant
 * and an IANA timezone in this module.
 */

export const TIBO_TEMPORAL_RESOLUTION_VERSION = "tibo-temporal-v4";
export const TIBO_SOURCE_TIME_ZONE = "America/Los_Angeles";
export const TIBO_NOTICE_GRACE_MS = 3 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const TIBO_DAYPARTS = {
  day: [0, 24],
  morning: [6, 12],
  afternoon: [12, 17],
  evening: [17, 21],
  tonight: [18, 24],
} as const;

const TEMPORAL_KINDS = [
  "none",
  "absolute",
  "weekday",
  "relative_day",
  "relative_duration",
  "daypart",
  "range",
  "vague",
] as const;
const TEMPORAL_PRECISIONS = ["exact_time", "day", "daypart", "range", "unknown"] as const;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAYPART_NAMES = ["day", "morning", "afternoon", "evening", "tonight"] as const;
const RANGE_KINDS = ["this_week", "this_weekend", "next_week"] as const;

export type TemporalKind = (typeof TEMPORAL_KINDS)[number];
export type TemporalPrecision = (typeof TEMPORAL_PRECISIONS)[number];
export type TemporalWeekday = (typeof WEEKDAYS)[number];
export type TemporalDaypart = (typeof DAYPART_NAMES)[number];
export type TemporalRangeKind = (typeof RANGE_KINDS)[number];
export type TemporalResolutionStatus = "resolved" | "unresolved" | "rejected";
export type TemporalResolutionSource = "gemini" | "deterministic" | "merged";

export type TemporalDateParts = {
  year: number | null;
  month: number;
  day: number;
};

export type TemporalTimeParts = {
  hour: number;
  minute: number;
};

export type TiboTemporalSemantics = {
  temporalExpression: string | null;
  temporalKind: TemporalKind;
  temporalPrecision: TemporalPrecision;
  weekday: TemporalWeekday | null;
  relativeDayOffset: number | null;
  relativeAmount: number | null;
  relativeUnit: "minutes" | "hours" | "days" | null;
  explicitDateParts: TemporalDateParts | null;
  explicitTimeParts: TemporalTimeParts | null;
  daypart: TemporalDaypart | null;
  rangeKind: TemporalRangeKind | null;
  explicitTimezone: string | null;
  temporalConfidence: number;
  resolutionSource?: TemporalResolutionSource;
};

export type TiboTemporalResolution = {
  status: TemporalResolutionStatus;
  version: string;
  temporalExpression: string | null;
  temporalKind: TemporalKind;
  temporalPrecision: TemporalPrecision;
  timezone: string | null;
  confidence: number | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  resolutionSource: TemporalResolutionSource;
};

export type ResetExecutionWindow = {
  executionWindowStartAt?: string | null;
  executionWindowEndAt?: string | null;
};

export type TemporalExecutionWindowRelation = "before" | "overlap" | "after" | "unknown";

/**
 * Compares a resolved signal forecast window with the observed reset window.
 * Unknown or incomplete temporal data deliberately stays on the legacy path.
 */
export function getTemporalExecutionWindowRelation(
  resolution: Pick<
    TiboTemporalResolution,
    "status" | "expectedStartAt" | "expectedEndAt"
  > | null | undefined,
  executionWindow: ResetExecutionWindow | null | undefined,
): TemporalExecutionWindowRelation {
  if (!resolution || resolution.status !== "resolved" || !executionWindow) {
    return "unknown";
  }

  const expectedStart = resolution.expectedStartAt
    ? Date.parse(resolution.expectedStartAt)
    : Number.NaN;
  const expectedEnd = resolution.expectedEndAt
    ? Date.parse(resolution.expectedEndAt)
    : expectedStart;
  const executionEnd = executionWindow.executionWindowEndAt
    ? Date.parse(executionWindow.executionWindowEndAt)
    : Number.NaN;
  const executionStart = executionWindow.executionWindowStartAt
    ? Date.parse(executionWindow.executionWindowStartAt)
    : executionEnd;

  if (
    !Number.isFinite(expectedStart) ||
    !Number.isFinite(expectedEnd) ||
    expectedEnd < expectedStart ||
    !Number.isFinite(executionStart) ||
    !Number.isFinite(executionEnd) ||
    executionEnd < executionStart
  ) {
    return "unknown";
  }

  if (executionEnd < expectedStart) return "before";
  if (executionStart > expectedEnd) return "after";
  return "overlap";
}

export type EffectiveTemporalPrecisionInput = {
  status?: TemporalResolutionStatus | null;
  temporalPrecision?: TemporalPrecision | null;
  expectedStartAt?: string | null;
  expectedEndAt?: string | null;
};

export function getEffectiveTemporalPrecision(
  resolution: EffectiveTemporalPrecisionInput | null | undefined,
): TemporalPrecision | null {
  if (!resolution) return null;
  const start = resolution.expectedStartAt ? Date.parse(resolution.expectedStartAt) : Number.NaN;
  const end = resolution.expectedEndAt ? Date.parse(resolution.expectedEndAt) : Number.NaN;
  if (resolution.status === "resolved" && Number.isFinite(start) && Number.isFinite(end) && start !== end) {
    return "range";
  }
  return resolution.temporalPrecision ?? null;
}

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type ResolvedTimeZone = {
  name: string;
  offsetMinutes?: number;
};

function isEnumValue<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isValidDateParts(value: unknown): value is TemporalDateParts {
  if (!value || typeof value !== "object") return false;
  const parts = value as Partial<TemporalDateParts>;
  return (
    (parts.year === null || parts.year === undefined || isInteger(parts.year)) &&
    isInteger(parts.month) && parts.month >= 1 && parts.month <= 12 &&
    isInteger(parts.day) && parts.day >= 1 && parts.day <= 31
  );
}

function isValidTimeParts(value: unknown): value is TemporalTimeParts {
  if (!value || typeof value !== "object") return false;
  const parts = value as Partial<TemporalTimeParts>;
  return (
    isInteger(parts.hour) && parts.hour >= 0 && parts.hour <= 23 &&
    isInteger(parts.minute) && parts.minute >= 0 && parts.minute <= 59
  );
}

const DETERMINISTIC_TEMPORAL_CONFIDENCE = 0.95;
const SOURCE_CLOCK_PATTERN =
  /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
const INVALID_MERIDIEM_CLOCK_PATTERN =
  /\b(?:0|(?:1[3-9]|2[0-3])|\d{3,})\s*(?::\d{2})?\s*am\b|\b(?:0|\d{3,})\s*(?::\d{2})?\s*pm\b/i;
const SOURCE_TIMEZONE_PATTERN =
  /\b(?:UTC|GMT)(?:[+-]\d{2}:\d{2})?\b|\b(?:PST|PDT|EST|EDT|PT|ET)\b|\b[A-Za-z]+\/[A-Za-z_]+\b/gi;
const SOURCE_DAY_PATTERN =
  /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const SOURCE_SEGMENT_BREAK_PATTERN = /[.!?;,\n—–]+/g;
const RESET_CUE_PATTERN =
  /\b(?:reset|resets|resetting|quota|usage limits?|rate limits?|land(?:s|ed|ing)?|refresh(?:ed|es|ing)?|performative)\b/i;
const RESET_BUTTON_REUSE_ACTION_PATTERN =
  /\b(?:find|press|hit|use|reuse)\s+(?:it|the\s+reset\s+button)\b|\b(?:dust\s+it\s+up|bring\s+it\s+back|take\s+it\s+out)\b/i;
const RESET_BUTTON_REUSE_NEGATION_PATTERN =
  /\b(?:can(?:not|'t)|won't|will\s+not|not\s+going\s+to)\b[^.!?]{0,100}\b(?:find|press|hit|use|reuse|dust|bring|take)\b/i;
const NON_USAGE_RESET_BUTTON_CONTEXT_PATTERN =
  /\b(?:keyboard|laptop|phone|router|server|device|controller|console|game|car|factory\s+reset)\b/i;
const VAGUE_DAY_PATTERN = /\b(?:sometime|some time|soon|later|in a while)\b/i;
const RESCHEDULE_VERB_PATTERN =
  /\b(?:moved|postponed|delayed|rescheduled|pushed\s+back|put\s+off)\b/i;
const RESCHEDULE_TARGET_DAY_PATTERN =
  /\b(?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const RESCHEDULE_RESET_CONTEXT_PATTERN =
  /\b(?:reset|usage\s+limits?|rate\s+limits?|quotas?|allowances?|celebration|(?:reset\s+)?button)\b/i;

type DeterministicTemporalExtraction = {
  semantics: TiboTemporalSemantics | null;
  candidates: SourceTemporalCandidate[];
  rejected: boolean;
};

type SourceClock = {
  hour: number;
  minute: number;
  index: number;
  end: number;
};

type SourceDay = {
  value: string;
  index: number;
  end: number;
};

type SourceTimezone = {
  value: string;
  index: number;
  end: number;
};

type SourceTemporalCandidate = {
  semantics: TiboTemporalSemantics;
  clock: SourceClock | null;
  day: SourceDay | null;
  timezone: SourceTimezone | null;
};

type SourceSegment = {
  text: string;
  start: number;
  end: number;
};

function getSourceSegments(sourceText: string): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let start = 0;
  for (const boundary of Array.from(sourceText.matchAll(SOURCE_SEGMENT_BREAK_PATTERN))) {
    const boundaryIndex = boundary.index ?? start;
    const segment = sourceText.slice(start, boundaryIndex).trim();
    if (segment) {
      const segmentStart = start + sourceText.slice(start, boundaryIndex).indexOf(segment);
      segments.push({ text: segment, start: segmentStart, end: segmentStart + segment.length });
    }
    start = boundaryIndex + boundary[0].length;
  }
  const tail = sourceText.slice(start).trim();
  if (tail) {
    const tailStart = start + sourceText.slice(start).indexOf(tail);
    segments.push({ text: tail, start: tailStart, end: tailStart + tail.length });
  }
  return segments;
}

function normalizeSourceClock(match: RegExpMatchArray, offset: number): { clock: SourceClock | null; rejected: boolean } {
  const hour = Number(match[1] ?? match[4]);
  const minute = Number(match[2] ?? match[5] ?? 0);
  const meridiem = match[3]?.toLowerCase() ?? null;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return { clock: null, rejected: true };
  }

  let normalizedHour = hour;
  if (meridiem) {
    if (hour >= 13 && hour <= 23) {
      if (meridiem !== "pm") return { clock: null, rejected: true };
    } else if (hour >= 1 && hour <= 12) {
      normalizedHour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    } else {
      return { clock: null, rejected: true };
    }
  } else if (hour < 0 || hour > 23) {
    return { clock: null, rejected: true };
  }

  return {
    clock: {
      hour: normalizedHour,
      minute,
      index: offset + (match.index ?? 0),
      end: offset + (match.index ?? 0) + match[0].length,
    },
    rejected: false,
  };
}

function getSourceClockMatches(segment: SourceSegment): { clocks: SourceClock[]; rejected: boolean } {
  if (INVALID_MERIDIEM_CLOCK_PATTERN.test(segment.text)) {
    return { clocks: [], rejected: true };
  }
  const clocks: SourceClock[] = [];
  for (const match of Array.from(segment.text.matchAll(SOURCE_CLOCK_PATTERN))) {
    const normalized = normalizeSourceClock(match, segment.start);
    if (normalized.rejected || !normalized.clock) return { clocks: [], rejected: true };
    clocks.push(normalized.clock);
  }
  return { clocks, rejected: false };
}

function getSourceDayMatches(segment: SourceSegment): SourceDay[] {
  return Array.from(segment.text.matchAll(SOURCE_DAY_PATTERN)).map((match) => ({
    value: match[1].toLowerCase(),
    index: segment.start + (match.index ?? 0),
    end: segment.start + (match.index ?? 0) + match[0].length,
  }));
}

function getSourceTimezoneMatch(segment: SourceSegment, clock: SourceClock): SourceTimezone | null {
  const candidates = Array.from(segment.text.matchAll(SOURCE_TIMEZONE_PATTERN))
    .filter((match) => {
      const index = segment.start + (match.index ?? 0);
      return Math.abs(index - clock.end) <= 80;
    })
    .map((match) => ({
      value: match[0],
      index: segment.start + (match.index ?? 0),
      end: segment.start + (match.index ?? 0) + match[0].length,
    }));

  const validCandidates = candidates.filter((candidate) => getTimeZone(candidate.value) !== null);
  if (validCandidates.length !== 1) return null;
  return validCandidates[0];
}

function getSourceTemporalExpression(
  sourceText: string,
  clock: SourceClock,
  day: SourceDay | null,
  timezone: SourceTimezone | null,
  segment: SourceSegment,
) {
  let start = Math.min(clock.index, day?.index ?? clock.index, timezone?.index ?? clock.index);
  const prefix = sourceText.slice(segment.start, start).match(/\b(?:around|at|on|by)\s*$/i);
  if (prefix?.index !== undefined) start = segment.start + prefix.index;

  const end = Math.max(clock.end, day?.end ?? clock.end, timezone?.end ?? clock.end);
  return sourceText.slice(start, end).trim();
}

function getSourceDayOnlyExpression(sourceText: string, day: SourceDay, segment: SourceSegment) {
  const start = Math.max(segment.start, day.index - 24);
  return sourceText.slice(start, day.end).trim();
}

function buildSourceClockCandidate(
  sourceText: string,
  segment: SourceSegment,
  clock: SourceClock,
  days: SourceDay[],
): SourceTemporalCandidate | null {
  if (!RESET_CUE_PATTERN.test(segment.text) || days.length > 1) return null;
  const day = days[0] ?? null;
  const timezone = getSourceTimezoneMatch(segment, clock);
  if (day) {
    const betweenClockAndDay = day.index > clock.end
      ? sourceText.slice(clock.end, day.index).trim()
      : "";
    if (
      betweenClockAndDay &&
      !getTimeZone(betweenClockAndDay) &&
      !/^(?:at|on|around|by)$/i.test(betweenClockAndDay)
    ) {
      return null;
    }
  }

  const clockPrefix = sourceText
    .slice(segment.start, clock.index)
    .match(/\b(?:around|at|on|by)\s*$/i);
  if (!day && !timezone && !clockPrefix) return null;

  const weekday = day && WEEKDAYS.includes(day.value as TemporalWeekday)
    ? day.value as TemporalWeekday
    : null;
  const relativeDayOffset = day?.value === "today" ? 0 : day?.value === "tomorrow" ? 1 : null;
  const temporalKind: TemporalKind = relativeDayOffset !== null
    ? "relative_day"
    : weekday
      ? "weekday"
      : "absolute";

  return {
    clock,
    day,
    timezone,
    semantics: {
      temporalExpression: getSourceTemporalExpression(sourceText, clock, day, timezone, segment),
      temporalKind,
      temporalPrecision: "exact_time",
      weekday,
      relativeDayOffset,
      relativeAmount: null,
      relativeUnit: null,
      explicitDateParts: null,
      explicitTimeParts: { hour: clock.hour, minute: clock.minute },
      daypart: null,
      rangeKind: null,
      explicitTimezone: timezone?.value ?? null,
      temporalConfidence: DETERMINISTIC_TEMPORAL_CONFIDENCE,
      resolutionSource: "deterministic",
    },
  };
}

function buildSourceDayCandidate(
  sourceText: string,
  segment: SourceSegment,
  day: SourceDay,
): SourceTemporalCandidate | null {
  if (!RESET_CUE_PATTERN.test(segment.text) || VAGUE_DAY_PATTERN.test(segment.text)) return null;
  const weekday = WEEKDAYS.includes(day.value as TemporalWeekday)
    ? day.value as TemporalWeekday
    : null;
  const relativeDayOffset = day.value === "today" ? 0 : day.value === "tomorrow" ? 1 : null;
  if (relativeDayOffset === null && !weekday) return null;

  return {
    clock: null,
    day,
    timezone: null,
    semantics: {
      temporalExpression: getSourceDayOnlyExpression(sourceText, day, segment),
      temporalKind: relativeDayOffset !== null ? "relative_day" : "weekday",
      temporalPrecision: "day",
      weekday,
      relativeDayOffset,
      relativeAmount: null,
      relativeUnit: null,
      explicitDateParts: null,
      explicitTimeParts: null,
      daypart: null,
      rangeKind: null,
      explicitTimezone: null,
      temporalConfidence: DETERMINISTIC_TEMPORAL_CONFIDENCE,
      resolutionSource: "deterministic",
    },
  };
}

/**
 * A reschedule sentence can contain both the original day and the new day.
 * Prefer the destination day instead of treating both tokens as ambiguous.
 * This stays limited to reset/celebration context so ordinary postponed work
 * does not acquire a reset schedule.
 */
function buildRescheduledDayCandidate(
  sourceText: string,
  segment: SourceSegment,
): SourceTemporalCandidate | null {
  if (!RESCHEDULE_RESET_CONTEXT_PATTERN.test(segment.text)) return null;
  const movement = RESCHEDULE_VERB_PATTERN.exec(segment.text);
  if (!movement || movement.index === undefined) return null;

  const tail = segment.text.slice(movement.index + movement[0].length);
  const targetMatch = Array.from(tail.matchAll(RESCHEDULE_TARGET_DAY_PATTERN))[0];
  if (!targetMatch || targetMatch.index === undefined) return null;

  const targetValue = targetMatch[0].toLowerCase();
  const targetIndex = segment.start + movement.index + movement[0].length + targetMatch.index;
  const targetDay: SourceDay = {
    value: targetValue,
    index: targetIndex,
    end: targetIndex + targetMatch[0].length,
  };
  const weekday = WEEKDAYS.includes(targetValue as TemporalWeekday)
    ? targetValue as TemporalWeekday
    : null;
  const relativeDayOffset = targetValue === "tomorrow" ? 1 : null;
  if (relativeDayOffset === null && !weekday) return null;

  return {
    clock: null,
    day: targetDay,
    timezone: null,
    semantics: {
      temporalExpression: sourceText.slice(segment.start, targetDay.end).trim(),
      temporalKind: relativeDayOffset !== null ? "relative_day" : "weekday",
      temporalPrecision: "day",
      weekday,
      relativeDayOffset,
      relativeAmount: null,
      relativeUnit: null,
      explicitDateParts: null,
      explicitTimeParts: null,
      daypart: null,
      rangeKind: null,
      explicitTimezone: null,
      temporalConfidence: DETERMINISTIC_TEMPORAL_CONFIDENCE,
      resolutionSource: "deterministic",
    },
  };
}

function buildResetButtonReuseDayCandidate(sourceText: string): SourceTemporalCandidate | null {
  const resetButton = /\breset\s+button\b/i.exec(sourceText);
  if (!resetButton || NON_USAGE_RESET_BUTTON_CONTEXT_PATTERN.test(sourceText)) return null;

  const tailStart = (resetButton.index ?? 0) + resetButton[0].length;
  const tail = sourceText.slice(tailStart, tailStart + 320);
  if (!RESET_BUTTON_REUSE_ACTION_PATTERN.test(tail) || RESET_BUTTON_REUSE_NEGATION_PATTERN.test(tail)) return null;

  const dayMatches = Array.from(tail.matchAll(SOURCE_DAY_PATTERN));
  if (dayMatches.length !== 1) return null;
  const dayMatch = dayMatches[0];
  const value = dayMatch[1].toLowerCase();
  const weekday = WEEKDAYS.includes(value as TemporalWeekday) ? value as TemporalWeekday : null;
  const relativeDayOffset = value === "today" ? 0 : value === "tomorrow" ? 1 : null;
  if (relativeDayOffset === null && !weekday) return null;

  const index = tailStart + (dayMatch.index ?? 0);
  const day: SourceDay = { value, index, end: index + dayMatch[0].length };
  return {
    clock: null,
    day,
    timezone: null,
    semantics: {
      temporalExpression: sourceText.slice(day.index, day.end),
      temporalKind: relativeDayOffset !== null ? "relative_day" : "weekday",
      temporalPrecision: "day",
      weekday,
      relativeDayOffset,
      relativeAmount: null,
      relativeUnit: null,
      explicitDateParts: null,
      explicitTimeParts: null,
      daypart: null,
      rangeKind: null,
      explicitTimezone: null,
      temporalConfidence: DETERMINISTIC_TEMPORAL_CONFIDENCE,
      resolutionSource: "deterministic",
    },
  };
}

function parseDeterministicTemporalSemantics(sourceText: string): DeterministicTemporalExtraction {
  const candidates: SourceTemporalCandidate[] = [];
  let rejected = false;
  for (const segment of getSourceSegments(sourceText)) {
    const rescheduled = buildRescheduledDayCandidate(sourceText, segment);
    if (rescheduled) {
      candidates.push(rescheduled);
      continue;
    }

    const clockResult = getSourceClockMatches(segment);
    if (clockResult.rejected) {
      rejected = true;
      continue;
    }
    const days = getSourceDayMatches(segment);
    for (const clock of clockResult.clocks) {
      const candidate = buildSourceClockCandidate(sourceText, segment, clock, days);
      if (candidate) candidates.push(candidate);
    }
    if (clockResult.clocks.length === 0) {
      for (const day of days) {
        const candidate = buildSourceDayCandidate(sourceText, segment, day);
        if (candidate) candidates.push(candidate);
      }
    }
  }

  if (candidates.length === 0 && !rejected) {
    const resetButtonReuse = buildResetButtonReuseDayCandidate(sourceText);
    if (resetButtonReuse) candidates.push(resetButtonReuse);
  }

  return {
    semantics: candidates.length === 1 ? candidates[0].semantics : null,
    candidates,
    rejected,
  };
}

function hasClockExpression(value: string) {
  return /\b(?:at\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?\b|\b(?:noon|midnight)\b/i.test(value);
}

function isDeadlineTimeExpression(value: string) {
  return /\bby\s+(?:(?:at\s+)?(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?|noon|midnight)\b/i.test(value);
}

function isValidRelativeDuration(
  expression: string,
  amount: number,
  unit: "minutes" | "hours" | "days",
): boolean {
  if (!expression || typeof expression !== "string") return false;
  const lower = expression.toLowerCase();

  // 1. Verify Unit presence in source expression
  const hasUnit =
    unit === "hours"
      ? /\b(?:hour|hours|hr|hrs)\b/i.test(lower)
      : unit === "minutes"
        ? /\b(?:minute|minutes|min)\b/i.test(lower)
        : /\b(?:day|days)\b/i.test(lower);

  if (!hasUnit) return false;

  // 2. Reject vague / non-quantified expressions
  if (/\b(?:soon|later|in a while|coming hours|sometime)\b/i.test(lower)) {
    return false;
  }

  // 3. Check for numeric digits in source expression
  const digitMatch = lower.match(/\b(\d+(?:\.\d+)?)\b/);
  if (digitMatch) {
    const numericVal = parseFloat(digitMatch[1]);
    return Math.abs(numericVal - amount) < 0.01;
  }

  // 4. Check for natural language 1-unit duration (amount = 1)
  if (amount === 1) {
    if (/\b(?:an|a|one|next|first)\b/i.test(lower)) {
      return true;
    }
  }

  // 5. Check for word-number representations
  const wordNumbers: Record<number, RegExp> = {
    1: /\b(?:one)\b/i,
    2: /\b(?:two)\b/i,
    3: /\b(?:three)\b/i,
    4: /\b(?:four)\b/i,
    5: /\b(?:five)\b/i,
    6: /\b(?:six)\b/i,
    7: /\b(?:seven)\b/i,
    8: /\b(?:eight)\b/i,
    9: /\b(?:nine)\b/i,
    10: /\b(?:ten)\b/i,
    12: /\b(?:twelve)\b/i,
    24: /\b(?:twenty[- ]four)\b/i,
    48: /\b(?:forty[- ]eight)\b/i,
  };

  const wordPattern = wordNumbers[amount];
  if (wordPattern && wordPattern.test(lower)) {
    return true;
  }

  return false;
}

function hasTemporalText(value: string, text: string) {
  return Boolean(value) && text.includes(value);
}

/** Validate and sanitize only semantic fields returned by Gemini. */
export function parseGeminiTemporalSemantics(value: unknown, sourceText: string): TiboTemporalSemantics | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Record<string, unknown>;
  const expression = typeof parsed.temporalExpression === "string"
    ? parsed.temporalExpression.trim()
    : null;
  const kind = parsed.temporalKind;
  const precision = parsed.temporalPrecision;
  const confidence = parsed.temporalConfidence;
  if (
    !isEnumValue(kind, TEMPORAL_KINDS) ||
    !isEnumValue(precision, TEMPORAL_PRECISIONS) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
  ) {
    return null;
  }

  if (expression && (expression.length > 300 || !hasTemporalText(expression, sourceText))) {
    return null;
  }

  const weekday = parsed.weekday === null || parsed.weekday === undefined
    ? null
    : isEnumValue(parsed.weekday, WEEKDAYS) ? parsed.weekday : null;
  const daypart = parsed.daypart === null || parsed.daypart === undefined
    ? null
    : isEnumValue(parsed.daypart, DAYPART_NAMES) ? parsed.daypart : null;
  const rangeKind = parsed.rangeKind === null || parsed.rangeKind === undefined
    ? null
    : isEnumValue(parsed.rangeKind, RANGE_KINDS) ? parsed.rangeKind : null;
  const explicitTimezone = parsed.explicitTimezone === null || parsed.explicitTimezone === undefined
    ? null
    : typeof parsed.explicitTimezone === "string" && parsed.explicitTimezone.trim()
      ? parsed.explicitTimezone.trim()
      : null;
  if (explicitTimezone && !sourceText.toLowerCase().includes(explicitTimezone.toLowerCase())) {
    return null;
  }

  const explicitDateParts = parsed.explicitDateParts === null || parsed.explicitDateParts === undefined
    ? null
    : isValidDateParts(parsed.explicitDateParts) ? parsed.explicitDateParts : null;
  if (parsed.explicitDateParts !== null && parsed.explicitDateParts !== undefined && !explicitDateParts) {
    return null;
  }

  const explicitTimeParts = parsed.explicitTimeParts === null || parsed.explicitTimeParts === undefined
    ? null
    : isValidTimeParts(parsed.explicitTimeParts) ? parsed.explicitTimeParts : null;
  if (
    parsed.explicitTimeParts !== null &&
    parsed.explicitTimeParts !== undefined &&
    (!explicitTimeParts || !hasClockExpression(expression ?? ""))
  ) {
    return null;
  }

  const relativeDayOffset = parsed.relativeDayOffset === null || parsed.relativeDayOffset === undefined
    ? null
    : isInteger(parsed.relativeDayOffset) ? parsed.relativeDayOffset : null;
  if (parsed.relativeDayOffset !== null && parsed.relativeDayOffset !== undefined && relativeDayOffset === null) {
    return null;
  }
  const relativeAmount = parsed.relativeAmount === null || parsed.relativeAmount === undefined
    ? null
    : typeof parsed.relativeAmount === "number" && Number.isFinite(parsed.relativeAmount) && parsed.relativeAmount > 0
      ? parsed.relativeAmount
      : null;
  const relativeUnit = parsed.relativeUnit === null || parsed.relativeUnit === undefined
    ? null
    : isEnumValue(parsed.relativeUnit, ["minutes", "hours", "days"] as const)
      ? parsed.relativeUnit
      : null;
  if (
    parsed.relativeAmount !== null &&
    parsed.relativeAmount !== undefined &&
    (relativeAmount === null ||
      !relativeUnit ||
      !isValidRelativeDuration(expression ?? "", relativeAmount, relativeUnit))
  ) {
    return null;
  }

  return {
    temporalExpression: expression,
    temporalKind: kind,
    temporalPrecision: precision,
    weekday,
    relativeDayOffset,
    relativeAmount,
    relativeUnit,
    explicitDateParts,
    explicitTimeParts,
    daypart,
    rangeKind,
    explicitTimezone,
    temporalConfidence: confidence,
    resolutionSource: "gemini",
  };
}

/**
 * Gemini may omit the structured clock fields even when the source contains a
 * single explicit schedule. In that case, use only source tokens that can be
 * resolved deterministically; never invent a day, clock, or timezone.
 */
export function parseTiboTemporalSemantics(value: unknown, sourceText: string): TiboTemporalSemantics | null {
  const sourceExtraction = parseDeterministicTemporalSemantics(sourceText);
  if (sourceExtraction.rejected) return null;

  const geminiSemantics = parseGeminiTemporalSemantics(value, sourceText);
  const candidates = sourceExtraction.candidates;
  const untrustedGeminiClock = Boolean(
    value &&
      typeof value === "object" &&
      ((value as Record<string, unknown>).explicitTimeParts !== null &&
        (value as Record<string, unknown>).explicitTimeParts !== undefined ||
        (typeof (value as Record<string, unknown>).temporalExpression === "string" &&
          hasClockExpression((value as Record<string, unknown>).temporalExpression as string))),
  );
  if (!geminiSemantics) {
    return untrustedGeminiClock && !candidates.some((candidate) => Boolean(candidate.clock))
      ? null
      : sourceExtraction.semantics;
  }
  if (candidates.length === 0) return geminiSemantics;
  if (
    candidates.length === 1 &&
    (geminiSemantics.temporalKind === "none" || geminiSemantics.temporalKind === "vague")
  ) {
    return candidates[0].semantics;
  }

  const matchesGeminiDay = (candidate: SourceTemporalCandidate) => {
    if (
      geminiSemantics.relativeDayOffset !== null &&
      geminiSemantics.relativeDayOffset !== candidate.semantics.relativeDayOffset
    ) {
      return false;
    }
    if (geminiSemantics.weekday && geminiSemantics.weekday !== candidate.semantics.weekday) {
      return false;
    }
    if (geminiSemantics.explicitDateParts) return false;
    return true;
  };
  const matchesGeminiCandidate = (candidate: SourceTemporalCandidate) => {
    if (geminiSemantics.explicitTimeParts) {
      if (!candidate.clock ||
        candidate.clock.hour !== geminiSemantics.explicitTimeParts.hour ||
        candidate.clock.minute !== geminiSemantics.explicitTimeParts.minute) {
        return false;
      }
    }
    if (geminiSemantics.explicitTimezone) {
      if (!candidate.timezone || candidate.timezone.value.toLowerCase() !== geminiSemantics.explicitTimezone.toLowerCase()) {
        return false;
      }
    }
    return matchesGeminiDay(candidate);
  };

  if (geminiSemantics.explicitTimeParts) {
    const matches = candidates.filter(matchesGeminiCandidate);
    if (matches.length === 1) {
      const candidate = matches[0];
      const needsSourceTimezone = !geminiSemantics.explicitTimezone && Boolean(candidate.semantics.explicitTimezone);
      return {
        ...geminiSemantics,
        explicitTimezone: needsSourceTimezone
          ? candidate.semantics.explicitTimezone
          : geminiSemantics.explicitTimezone,
        resolutionSource: needsSourceTimezone ? "merged" : "gemini",
      };
    }
    if (!candidates.some((candidate) => Boolean(candidate.clock))) return null;
    return sourceExtraction.semantics;
  }

  const dayMatches = candidates.filter(matchesGeminiDay);
  if (dayMatches.length !== 1) return sourceExtraction.semantics;
  const candidate = dayMatches[0];
  if (!candidate.clock) {
    return {
      ...geminiSemantics,
      temporalExpression: candidate.semantics.temporalExpression,
      resolutionSource: "merged",
    };
  }

  return {
    ...geminiSemantics,
    temporalExpression: candidate.semantics.temporalExpression,
    temporalKind: candidate.semantics.temporalKind,
    temporalPrecision: candidate.semantics.temporalPrecision,
    weekday: candidate.semantics.weekday,
    relativeDayOffset: candidate.semantics.relativeDayOffset,
    explicitDateParts: candidate.semantics.explicitDateParts,
    explicitTimeParts: candidate.semantics.explicitTimeParts,
    daypart: candidate.semantics.daypart,
    rangeKind: candidate.semantics.rangeKind,
    explicitTimezone: candidate.semantics.explicitTimezone,
    temporalConfidence: Math.min(
      geminiSemantics.temporalConfidence,
      candidate.semantics.temporalConfidence,
    ),
    resolutionSource: "merged",
  };
}

function getDateTimeParts(instant: Date, timeZone: string): LocalDateTime | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "iso8601",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function getWeekdayIndex(instant: Date, timeZone: string) {
  try {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    }).format(instant).toLowerCase();
    const index = WEEKDAYS.indexOf(weekday as TemporalWeekday);
    return index === -1 ? null : index;
  } catch {
    return null;
  }
}

function getTimeZone(value: string | null): ResolvedTimeZone | null {
  if (!value) return { name: TIBO_SOURCE_TIME_ZONE };
  const normalized = value.trim();
  const aliases: Record<string, string> = {
    PT: "America/Los_Angeles",
    "PACIFIC TIME": "America/Los_Angeles",
    ET: "America/New_York",
    "EASTERN TIME": "America/New_York",
    UTC: "UTC",
    GMT: "UTC",
  };
  const alias = aliases[normalized.toUpperCase()];
  if (alias) return { name: alias };
  const fixedOffset = normalized.match(/^(PDT|PST|EDT|EST)$/i);
  if (fixedOffset) {
    const offsets: Record<string, number> = { PDT: -420, PST: -480, EDT: -240, EST: -300 };
    return { name: normalized.toUpperCase(), offsetMinutes: offsets[normalized.toUpperCase()] };
  }
  const explicitOffset = normalized.match(/^UTC([+-])(\d{2}):(\d{2})$/i);
  if (explicitOffset) {
    const minutes = Number(explicitOffset[2]) * 60 + Number(explicitOffset[3]);
    return { name: normalized.toUpperCase(), offsetMinutes: explicitOffset[1] === "+" ? minutes : -minutes };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
    return { name: normalized };
  } catch {
    return null;
  }
}

function sameLocalDateTime(left: LocalDateTime | null, right: LocalDateTime) {
  return Boolean(
    left &&
      left.year === right.year &&
      left.month === right.month &&
      left.day === right.day &&
      left.hour === right.hour &&
      left.minute === right.minute,
  );
}

/** Return one instant only; DST gaps and overlaps are intentionally unresolved. */
function localDateTimeToInstant(local: LocalDateTime, timeZone: ResolvedTimeZone) {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  if (timeZone.offsetMinutes !== undefined) {
    return new Date(naive - timeZone.offsetMinutes * MINUTE_MS);
  }

  const candidates: number[] = [];
  for (let offset = -36 * HOUR_MS; offset <= 36 * HOUR_MS; offset += MINUTE_MS) {
    const candidate = naive + offset;
    if (sameLocalDateTime(getDateTimeParts(new Date(candidate), timeZone.name), local)) {
      candidates.push(candidate);
      if (candidates.length > 1) return null;
    }
  }
  return candidates.length === 1 ? new Date(candidates[0]) : null;
}

function addLocalDays(local: LocalDateTime, days: number): LocalDateTime {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
  };
}

function atLocalTime(local: LocalDateTime, hour: number, minute = 0): LocalDateTime {
  return { ...local, hour, minute };
}

function resolveWeekdayDate(
  createdLocal: LocalDateTime,
  createdWeekday: number,
  targetWeekday: TemporalWeekday,
  expression: string,
  explicitTimeParts: TemporalTimeParts | null,
) {
  const target = WEEKDAYS.indexOf(targetWeekday);
  const lower = expression.toLowerCase();
  if (lower.includes("next ")) {
    const currentWeekMonday = addLocalDays(createdLocal, -createdWeekday);
    return addLocalDays(currentWeekMonday, 7 + target);
  }
  if (lower.includes("this ")) {
    const currentWeekMonday = addLocalDays(createdLocal, -createdWeekday);
    const result = addLocalDays(currentWeekMonday, target);
    return result;
  }
  const delta = (target - createdWeekday + 7) % 7;
  if (delta === 0) {
    if (!explicitTimeParts) return null;
    const createdMinutes = createdLocal.hour * 60 + createdLocal.minute;
    const targetMinutes = explicitTimeParts.hour * 60 + explicitTimeParts.minute;
    return targetMinutes > createdMinutes
      ? createdLocal
      : addLocalDays(createdLocal, 7);
  }
  return addLocalDays(createdLocal, delta);
}

function resolveDay(
  semantics: TiboTemporalSemantics,
  createdLocal: LocalDateTime,
  createdWeekday: number,
) {
  const expression = semantics.temporalExpression ?? "";
  const lower = expression.toLowerCase();
  if (lower.includes("tomorrow")) return addLocalDays(createdLocal, 1);
  if (lower.includes("today")) return createdLocal;
  if (semantics.daypart === "day") return createdLocal;
  if (semantics.weekday) {
    return resolveWeekdayDate(
      createdLocal,
      createdWeekday,
      semantics.weekday,
      expression,
      semantics.explicitTimeParts,
    );
  }
  if (semantics.relativeDayOffset !== null) return addLocalDays(createdLocal, semantics.relativeDayOffset);
  return null;
}

function startOfIsoWeek(local: LocalDateTime) {
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return addLocalDays(local, -mondayOffset);
}

function buildWindow(
  start: LocalDateTime,
  end: LocalDateTime,
  timeZone: ResolvedTimeZone,
) {
  const expectedStart = localDateTimeToInstant(start, timeZone);
  const expectedEnd = localDateTimeToInstant(end, timeZone);
  if (!expectedStart || !expectedEnd || expectedEnd.getTime() <= expectedStart.getTime()) return null;
  return { expectedStart, expectedEnd };
}

function rejected(semantics: TiboTemporalSemantics): TiboTemporalResolution {
  return {
    status: "rejected",
    version: TIBO_TEMPORAL_RESOLUTION_VERSION,
    temporalExpression: semantics.temporalExpression,
    temporalKind: semantics.temporalKind,
    temporalPrecision: semantics.temporalPrecision,
    timezone: null,
    confidence: semantics.temporalConfidence,
    expectedStartAt: null,
    expectedEndAt: null,
    resolutionSource: semantics.resolutionSource ?? "gemini",
  };
}

export function unresolvedTemporal(
  semantics: Partial<TiboTemporalSemantics> | null = null,
): TiboTemporalResolution {
  return {
    status: "unresolved",
    version: TIBO_TEMPORAL_RESOLUTION_VERSION,
    temporalExpression: typeof semantics?.temporalExpression === "string" ? semantics.temporalExpression : null,
    temporalKind: isEnumValue(semantics?.temporalKind, TEMPORAL_KINDS) ? semantics.temporalKind : "none",
    temporalPrecision: isEnumValue(semantics?.temporalPrecision, TEMPORAL_PRECISIONS) ? semantics.temporalPrecision : "unknown",
    timezone: null,
    confidence: typeof semantics?.temporalConfidence === "number" ? semantics.temporalConfidence : null,
    expectedStartAt: null,
    expectedEndAt: null,
    resolutionSource: semantics?.resolutionSource ?? "gemini",
  };
}

export function resolveTiboTemporalSchedule(
  semantics: TiboTemporalSemantics | null,
  tweetCreatedAt: string,
  sourceTimeZone = TIBO_SOURCE_TIME_ZONE,
): TiboTemporalResolution {
  if (!semantics || semantics.temporalKind === "none" || semantics.temporalKind === "vague") {
    return unresolvedTemporal(semantics);
  }
  if (semantics.temporalConfidence < 0.85 || !semantics.temporalExpression) {
    return unresolvedTemporal(semantics);
  }

  const created = new Date(tweetCreatedAt);
  if (!Number.isFinite(created.getTime())) return rejected(semantics);
  const timeZone = getTimeZone(semantics.explicitTimezone ?? sourceTimeZone);
  if (!timeZone) return unresolvedTemporal(semantics);
  const createdLocal = timeZone.offsetMinutes === undefined
    ? getDateTimeParts(created, timeZone.name)
    : getDateTimeParts(
        new Date(created.getTime() + timeZone.offsetMinutes * MINUTE_MS),
        "UTC",
      );
  const createdWeekday = getWeekdayIndex(created, timeZone.offsetMinutes === undefined ? timeZone.name : "UTC");
  if (!createdLocal || createdWeekday === null) return rejected(semantics);

  let expectedStart: Date | null = null;
  let expectedEnd: Date | null = null;
  let precision = semantics.temporalPrecision;
  let unresolvedInterpretation = false;

  if (semantics.temporalKind === "relative_duration" && semantics.relativeAmount && semantics.relativeUnit) {
    if (semantics.relativeUnit === "days") {
      const localDay = addLocalDays(createdLocal, Math.round(semantics.relativeAmount));
      const window = buildWindow(atLocalTime(localDay, 0), atLocalTime(addLocalDays(localDay, 1), 0), timeZone);
      expectedStart = window?.expectedStart ?? null;
      expectedEnd = window?.expectedEnd ?? null;
      precision = "day";
    } else {
      const duration = semantics.relativeAmount * (semantics.relativeUnit === "hours" ? HOUR_MS : MINUTE_MS);
      expectedStart = new Date(created.getTime() + duration);
      expectedEnd = expectedStart;
      precision = "exact_time";
    }
  } else if (semantics.temporalKind === "absolute" && semantics.explicitDateParts) {
    const year = semantics.explicitDateParts.year ?? createdLocal.year;
    let date = { ...createdLocal, year, month: semantics.explicitDateParts.month, day: semantics.explicitDateParts.day };
    if (date.year === createdLocal.year && Date.UTC(date.year, date.month - 1, date.day) < Date.UTC(createdLocal.year, createdLocal.month - 1, createdLocal.day)) {
      date = { ...date, year: date.year + 1 };
    }
    if (semantics.explicitTimeParts) {
      const candidate = localDateTimeToInstant({ ...date, ...semantics.explicitTimeParts }, timeZone);
      if (isDeadlineTimeExpression(semantics.temporalExpression ?? "")) {
        if (!candidate || candidate.getTime() <= created.getTime()) {
          unresolvedInterpretation = true;
        } else {
          expectedStart = created;
          expectedEnd = candidate;
          precision = "range";
        }
      } else {
        expectedStart = candidate;
        expectedEnd = expectedStart;
        precision = "exact_time";
      }
    } else {
      const window = buildWindow(atLocalTime(date, 0), atLocalTime(addLocalDays(date, 1), 0), timeZone);
      expectedStart = window?.expectedStart ?? null;
      expectedEnd = window?.expectedEnd ?? null;
      precision = "day";
    }
  } else if (
    semantics.temporalKind === "absolute" &&
    !semantics.explicitDateParts &&
    semantics.explicitTimeParts
  ) {
    const candidate = localDateTimeToInstant(
      { ...createdLocal, ...semantics.explicitTimeParts },
      timeZone,
    );
    if (!candidate || candidate.getTime() <= created.getTime()) {
      unresolvedInterpretation = true;
    } else if (isDeadlineTimeExpression(semantics.temporalExpression ?? "")) {
      expectedStart = created;
      expectedEnd = candidate;
      precision = "range";
    } else {
      expectedStart = candidate;
      expectedEnd = candidate;
      precision = "exact_time";
    }
  } else if (semantics.temporalKind === "range" && semantics.rangeKind) {
    const weekStart = startOfIsoWeek(createdLocal);
    const start = semantics.rangeKind === "this_weekend"
      ? addLocalDays(weekStart, 5)
      : semantics.rangeKind === "next_week"
        ? addLocalDays(weekStart, 7)
        : weekStart;
    const end = semantics.rangeKind === "this_weekend"
      ? addLocalDays(weekStart, 7)
      : addLocalDays(start, 7);
    const window = buildWindow(atLocalTime(start, 0), atLocalTime(end, 0), timeZone);
    expectedStart = window?.expectedStart ?? null;
    expectedEnd = window?.expectedEnd ?? null;
    precision = "range";
  } else {
    const day = resolveDay(semantics, createdLocal, createdWeekday);
    if (day && semantics.temporalKind === "daypart" && semantics.daypart) {
      const [startHour, endHour] = TIBO_DAYPARTS[semantics.daypart];
      if (semantics.daypart === "day") {
        // "During the day" starts when the post is made, then ends at the
        // next midnight in Tibo's source-local calendar. The start remains
        // the original instant so seconds are not silently discarded.
        expectedStart = created;
        expectedEnd = localDateTimeToInstant(
          atLocalTime(addLocalDays(day, 1), 0),
          timeZone,
        );
      } else {
        const endDay = endHour === 24 ? addLocalDays(day, 1) : day;
        const window = buildWindow(atLocalTime(day, startHour), atLocalTime(endDay, endHour === 24 ? 0 : endHour), timeZone);
        expectedStart = window?.expectedStart ?? null;
        expectedEnd = window?.expectedEnd ?? null;
      }
      precision = "daypart";
    } else if (day && semantics.temporalKind === "weekday") {
      if (semantics.explicitTimeParts) {
        expectedStart = localDateTimeToInstant({ ...day, ...semantics.explicitTimeParts }, timeZone);
        expectedEnd = expectedStart;
        precision = "exact_time";
      } else {
        const window = buildWindow(atLocalTime(day, 0), atLocalTime(addLocalDays(day, 1), 0), timeZone);
        expectedStart = window?.expectedStart ?? null;
        expectedEnd = window?.expectedEnd ?? null;
        precision = "day";
      }
    } else if (day && semantics.temporalKind === "relative_day") {
      if (semantics.explicitTimeParts) {
        expectedStart = localDateTimeToInstant({ ...day, ...semantics.explicitTimeParts }, timeZone);
        expectedEnd = expectedStart;
        precision = "exact_time";
      } else {
        const window = buildWindow(atLocalTime(day, 0), atLocalTime(addLocalDays(day, 1), 0), timeZone);
        expectedStart = window?.expectedStart ?? null;
        expectedEnd = window?.expectedEnd ?? null;
        precision = "day";
      }
    } else {
      unresolvedInterpretation = true;
    }
  }

  if (!expectedStart || !expectedEnd) {
    return unresolvedInterpretation ? unresolvedTemporal(semantics) : rejected(semantics);
  }
  return {
    status: "resolved",
    version: TIBO_TEMPORAL_RESOLUTION_VERSION,
    temporalExpression: semantics.temporalExpression,
    temporalKind: semantics.temporalKind,
    temporalPrecision: precision,
    timezone: timeZone.name,
    confidence: semantics.temporalConfidence,
    expectedStartAt: expectedStart.toISOString(),
    expectedEndAt: expectedEnd.toISOString(),
    resolutionSource: semantics.resolutionSource ?? "gemini",
  };
}

export function getTemporalNoticeExpiry(resolution: TiboTemporalResolution, fallbackCreatedAt: string) {
  if (resolution.status !== "resolved") {
    const created = new Date(fallbackCreatedAt);
    return Number.isFinite(created.getTime())
      ? new Date(created.getTime() + 24 * HOUR_MS).toISOString()
      : null;
  }
  const end = resolution.expectedEndAt
    ? new Date(resolution.expectedEndAt)
    : resolution.expectedStartAt
      ? new Date(resolution.expectedStartAt)
      : null;
  return end && Number.isFinite(end.getTime())
    ? new Date(end.getTime() + TIBO_NOTICE_GRACE_MS).toISOString()
    : null;
}

export function getTemporalNoticeCoverage(
  resolution: Pick<TiboTemporalResolution, "status" | "temporalPrecision" | "confidence" | "expectedStartAt" | "expectedEndAt"> | null | undefined,
  now: Date,
  horizonHours: number,
) {
  if (!resolution || resolution.status !== "resolved" || !Number.isFinite(horizonHours) || horizonHours <= 0) return null;
  const nowTime = now.getTime();
  const start = resolution.expectedStartAt ? Date.parse(resolution.expectedStartAt) : Number.NaN;
  const end = resolution.expectedEndAt ? Date.parse(resolution.expectedEndAt) : start;
  if (!Number.isFinite(nowTime) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (resolution.temporalPrecision === "exact_time") {
    const distance = start - nowTime;
    if (distance >= 0) {
      return distance <= horizonHours * HOUR_MS ? 1 : 0;
    }
    const overdueMs = nowTime - start;
    if (overdueMs <= TIBO_NOTICE_GRACE_MS) {
      return Math.max(0, Math.min(1, 1 - overdueMs / TIBO_NOTICE_GRACE_MS));
    }
    return 0;
  }
  const remainingStart = Math.max(nowTime, start);
  const remainingDuration = end - remainingStart;
  if (remainingDuration <= 0) return 0;
  const intersection = Math.max(0, Math.min(nowTime + horizonHours * HOUR_MS, end) - remainingStart);
  const confidence = typeof resolution.confidence === "number" && Number.isFinite(resolution.confidence)
    ? Math.min(1, Math.max(0, resolution.confidence))
    : 0;
  return Math.min(1, Math.max(0, (intersection / remainingDuration) * confidence));
}

/**
 * Timing weight for teaser signals. A resolved teaser follows the hinted
 * window instead of aging out from the post timestamp. After the window ends,
 * the effect fades through the existing three-hour grace period.
 */
export function getTemporalTeaserCoverage(
  resolution: Pick<TiboTemporalResolution, "status" | "temporalPrecision" | "confidence" | "expectedStartAt" | "expectedEndAt"> | null | undefined,
  now: Date,
  horizonHours: number,
) {
  const coverage = getTemporalNoticeCoverage(resolution, now, horizonHours);
  if (coverage === null || !resolution?.expectedStartAt) return null;

  const nowTime = now.getTime();
  const start = Date.parse(resolution.expectedStartAt);
  const end = resolution.expectedEndAt ? Date.parse(resolution.expectedEndAt) : start;
  if (!Number.isFinite(nowTime) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  if (nowTime <= end) return coverage;

  const overdueMs = nowTime - end;
  if (overdueMs >= TIBO_NOTICE_GRACE_MS) return 0;

  const confidence = typeof resolution.confidence === "number" && Number.isFinite(resolution.confidence)
    ? Math.min(1, Math.max(0, resolution.confidence))
    : 0;
  return confidence * Math.max(0, 1 - overdueMs / TIBO_NOTICE_GRACE_MS);
}

export function isOverdueNoticePending(
  resolution: Pick<TiboTemporalResolution, "status" | "temporalPrecision" | "expectedStartAt" | "expectedEndAt"> | null | undefined,
  latestResetAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!resolution || resolution.status !== "resolved" || resolution.temporalPrecision !== "exact_time") {
    return false;
  }
  if (!resolution.expectedStartAt) return false;
  const start = Date.parse(resolution.expectedStartAt);
  if (!Number.isFinite(start)) return false;
  const nowTime = now.getTime();
  if (nowTime <= start || nowTime > start + TIBO_NOTICE_GRACE_MS) {
    return false;
  }
  return !isTemporalNoticeConsumedAtReset(resolution, latestResetAt);
}

export function isTemporalNoticeConsumedAtReset(
  resolution: Pick<TiboTemporalResolution, "status" | "temporalPrecision" | "expectedStartAt" | "expectedEndAt"> | null | undefined,
  resetAt: string | Date | null | undefined,
) {
  if (!resetAt) return false;
  const resetTime = resetAt instanceof Date ? resetAt.getTime() : Date.parse(resetAt);
  if (!Number.isFinite(resetTime)) return false;
  if (
    !resolution ||
    resolution.status !== "resolved" ||
    !resolution.expectedStartAt ||
    !Number.isFinite(Date.parse(resolution.expectedStartAt))
  ) {
    return true;
  }

  const expectedStart = Date.parse(resolution.expectedStartAt);
  const expectedEnd = resolution.expectedEndAt ? Date.parse(resolution.expectedEndAt) : expectedStart;
  if (!Number.isFinite(expectedEnd)) return false;
  if (resolution.temporalPrecision === "exact_time") {
    return Math.abs(resetTime - expectedStart) <= TIBO_NOTICE_GRACE_MS;
  }
  if (resetTime < expectedStart - TIBO_NOTICE_GRACE_MS) return false;
  return resetTime <= expectedEnd;
}
