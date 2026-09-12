import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_BANKED_RESET_AVAILABLE_COUNT,
  MAX_USAGE_COMPARISON_GAP_MS,
  MONITOR_PROTOCOL_VERSION,
  RESET_AT_MEANINGFUL_FORWARD_SEC,
  isBankedResetAvailableCountGrant,
  parseCodexRateLimitsResponse,
  type CodexUsageSnapshot,
} from "../lib/codexUsageRecovery";

export const DEFAULT_MONITOR_POLL_INTERVAL_MS = 120_000;
export const MIN_MONITOR_POLL_INTERVAL_MS = 60_000;
export const NOTIFICATION_DEBOUNCE_MS = 2_000;
export const MONITOR_HEARTBEAT_INTERVAL_MS = 8 * 60 * 1000;
export const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
export const APP_SERVER_RPC_FAILURE_RESTART_THRESHOLD = 3;
export const MONITOR_WEBHOOK_TIMEOUT_MS = 15_000;
export const MAX_JSON_LINE_LENGTH = 1_000_000;
export const MIN_RECOVERY_CONFIRMATION_DELAY_MS = MIN_MONITOR_POLL_INTERVAL_MS;
export const RESET_AT_JITTER_TOLERANCE_SEC = 30;

const RESTART_BACKOFF_MS = [5_000, 30_000, 120_000] as const;
const DEFAULT_WEBHOOK_URL = "https://codex.gussuriworks.com/api/webhook/codex-usage";

type JsonObject = Record<string, unknown>;
type MessageHandler = (message: JsonObject) => void;
type MalformedHandler = () => void;

export function createAppServerRequest(
  method: string,
  id: string,
  params?: JsonObject,
) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

export function createJsonLineParser(
  onMessage: MessageHandler,
  onMalformed: MalformedHandler,
) {
  let buffer = "";

  return {
    push(chunk: string | Buffer) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (buffer.length > MAX_JSON_LINE_LENGTH) {
        buffer = "";
        onMalformed();
        return;
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              onMalformed();
            } else {
              onMessage(parsed as JsonObject);
            }
          } catch {
            onMalformed();
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    },
  };
}

export function createNotificationDebouncer(callback: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        callback();
      }, Math.max(0, delayMs));
    },
    cancel() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}

export function getMonitorPollIntervalMs(rawValue: string | undefined) {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_MONITOR_POLL_INTERVAL_MS;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MONITOR_POLL_INTERVAL_MS;
  }
  return Math.max(MIN_MONITOR_POLL_INTERVAL_MS, Math.floor(parsed));
}

export function getRestartBackoffMs(attempt: number) {
  const index = Number.isFinite(attempt)
    ? Math.min(Math.max(0, Math.floor(attempt)), RESTART_BACKOFF_MS.length - 1)
    : 0;
  return RESTART_BACKOFF_MS[index];
}

export function shouldRestartAppServerAfterRpcFailure(consecutiveFailures: number) {
  return Number.isInteger(consecutiveFailures) &&
    consecutiveFailures >= APP_SERVER_RPC_FAILURE_RESTART_THRESHOLD;
}

export type MonitorSnapshotPostReason =
  | "initial"
  | "recovery_candidate"
  | "banked_reset_count_change"
  | "structure_change"
  | "heartbeat";

export type PendingMonitorPostReason = Exclude<MonitorSnapshotPostReason, "heartbeat">;

export type PendingMonitorPost = {
  reason: PendingMonitorPostReason;
  snapshot: CodexUsageSnapshot;
};

export type MonitorWebhookResponse = {
  accepted: boolean;
  recovery?: string;
};

export function isMonitorResetExecutionConfirmed(
  response: unknown,
  postReason: MonitorSnapshotPostReason,
) {
  if (postReason !== "recovery_candidate" || !response || typeof response !== "object") {
    return false;
  }
  const candidate = response as { accepted?: unknown; recovery?: unknown };
  return candidate.accepted === true &&
    (candidate.recovery === "confirmed" || candidate.recovery === "teaser_corroborated");
}

export function getMonitorResetEventKey(snapshot: Pick<CodexUsageSnapshot, "resetsAt">) {
  return `usage-reset:${snapshot.resetsAt}`;
}

export type RecoveryCandidateCancellationReason =
  | "usage_reverted"
  | "reset_at_reverted"
  | "structure_change"
  | "comparison_gap"
  | "stale_observation";

export type PendingRecoveryCandidate = {
  preRecoveryBaseline: CodexUsageSnapshot;
  firstEvidenceSnapshot: CodexUsageSnapshot;
  candidateStartedAtMs: number;
  lastObservation: CodexUsageSnapshot;
  observationCount: number;
};

export type MonitorSnapshotState = {
  baselineSnapshot?: CodexUsageSnapshot | null;
  previousLocalSnapshot: CodexUsageSnapshot | null;
  lastSuccessfulPostAt: number | null;
  lastKnownBankedResetAvailableCount?: number | null;
  pendingRecoveryCandidate?: PendingRecoveryCandidate | null;
  pendingPosts?: PendingMonitorPost[];
};

export type MonitorRefreshTrigger = "poll" | "notification" | "initial";

export type MonitorRecoveryCandidateStatus =
  | "none"
  | "started"
  | "confirmed"
  | "pending_unconfirmed"
  | "pending_burst"
  | "cancelled";

export type MonitorRecoveryEvaluation = {
  status: MonitorRecoveryCandidateStatus;
  cancellationReason?: RecoveryCandidateCancellationReason;
  postReason: MonitorSnapshotPostReason | null;
  postSnapshot: CodexUsageSnapshot;
  nextPendingRecoveryCandidate: PendingRecoveryCandidate | null;
  nextBaselineSnapshot: CodexUsageSnapshot;
};

export type MonitorBankedResetCountSource =
  | "explicit"
  | "last_known"
  | "unavailable";

export type MonitorBankedResetDisplayState = {
  bankedResetDisplayCount: number | null;
  bankedResetCountSource: MonitorBankedResetCountSource;
};

function isValidBankedResetCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_BANKED_RESET_AVAILABLE_COUNT;
}

function getLastKnownBankedResetAvailableCount(state: MonitorSnapshotState) {
  if (state.lastKnownBankedResetAvailableCount !== undefined) {
    return isValidBankedResetCount(state.lastKnownBankedResetAvailableCount)
      ? state.lastKnownBankedResetAvailableCount
      : null;
  }

  const previousCount = state.previousLocalSnapshot?.bankedResetAvailableCount;
  return isValidBankedResetCount(previousCount) ? previousCount : null;
}

export function getMonitorBankedResetDisplayState(
  snapshot: Pick<CodexUsageSnapshot, "bankedResetAvailableCount">,
  lastKnownBankedResetAvailableCount: number | null | undefined,
): MonitorBankedResetDisplayState {
  if (isValidBankedResetCount(snapshot.bankedResetAvailableCount)) {
    return {
      bankedResetDisplayCount: snapshot.bankedResetAvailableCount,
      bankedResetCountSource: "explicit",
    };
  }

  if (isValidBankedResetCount(lastKnownBankedResetAvailableCount)) {
    return {
      bankedResetDisplayCount: lastKnownBankedResetAvailableCount,
      bankedResetCountSource: "last_known",
    };
  }

  return {
    bankedResetDisplayCount: null,
    bankedResetCountSource: "unavailable",
  };
}

export function getPendingMonitorPosts(state: MonitorSnapshotState) {
  return [...(state.pendingPosts ?? [])];
}

export function enqueueMonitorSnapshotPost(
  state: MonitorSnapshotState,
  reason: PendingMonitorPostReason,
  snapshot: CodexUsageSnapshot,
): MonitorSnapshotState {
  const pendingPosts = getPendingMonitorPosts(state);
  if (pendingPosts.some((pending) => pending.reason === "initial" && reason === "initial") ||
    pendingPosts.some((pending) =>
      pending.reason === reason && pending.snapshot.observedAt === snapshot.observedAt
    )) {
    return { ...state, pendingPosts };
  }
  return {
    ...state,
    pendingPosts: [...pendingPosts, { reason, snapshot }],
  };
}

export function markMonitorSnapshotPostSucceeded(
  state: MonitorSnapshotState,
  completedAtMs = Date.now(),
): MonitorSnapshotState {
  const pendingPosts = getPendingMonitorPosts(state);
  return {
    ...state,
    pendingPosts: pendingPosts.slice(1),
    lastSuccessfulPostAt: Number.isFinite(completedAtMs)
      ? completedAtMs
      : state.lastSuccessfulPostAt,
  };
}

export function evaluateMonitorRecoveryCandidate(
  snapshot: CodexUsageSnapshot,
  state: MonitorSnapshotState,
  nowMs = Date.now(),
  trigger: MonitorRefreshTrigger = "poll",
): MonitorRecoveryEvaluation {
  if (state.lastSuccessfulPostAt === null) {
    return {
      status: "none",
      postReason: "initial",
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  if (isBankedResetAvailableCountGrant(
    getLastKnownBankedResetAvailableCount(state),
    snapshot.bankedResetAvailableCount,
  )) {
    return {
      status: "none",
      postReason: "banked_reset_count_change",
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  if (state.pendingRecoveryCandidate) {
    const candidate = state.pendingRecoveryCandidate;
    const baseline = candidate.preRecoveryBaseline;
    const firstEvidence = candidate.firstEvidenceSnapshot;

    // 1. Structure change
    if (
      snapshot.limitId !== baseline.limitId ||
      snapshot.planType !== baseline.planType ||
      snapshot.windowDurationMins !== baseline.windowDurationMins
    ) {
      return {
        status: "cancelled",
        cancellationReason: "structure_change",
        postReason: "structure_change",
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: null,
        nextBaselineSnapshot: snapshot,
      };
    }

    // 2. Stale observation
    const lastObservedTime = Date.parse(candidate.lastObservation.observedAt);
    const currentObservedTime = Date.parse(snapshot.observedAt);
    if (
      Number.isFinite(lastObservedTime) &&
      Number.isFinite(currentObservedTime) &&
      currentObservedTime < lastObservedTime
    ) {
      return {
        status: "cancelled",
        cancellationReason: "stale_observation",
        postReason: null,
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: null,
        nextBaselineSnapshot: candidate.lastObservation,
      };
    }

    // 3. Comparison gap (> 10m)
    if (
      (Number.isFinite(lastObservedTime) &&
        Number.isFinite(currentObservedTime) &&
        currentObservedTime - lastObservedTime > MAX_USAGE_COMPARISON_GAP_MS) ||
      (Number.isFinite(candidate.candidateStartedAtMs) &&
        Number.isFinite(nowMs) &&
        nowMs - candidate.candidateStartedAtMs > MAX_USAGE_COMPARISON_GAP_MS)
    ) {
      return {
        status: "cancelled",
        cancellationReason: "comparison_gap",
        postReason: null,
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: null,
        nextBaselineSnapshot: snapshot,
      };
    }

    // 4. Usage reverted (comparing current snapshot against frozen pre-recovery baseline)
    const usageDecreaseFromBaseline = baseline.usedPercent - snapshot.usedPercent;
    if (usageDecreaseFromBaseline < 1) {
      return {
        status: "cancelled",
        cancellationReason: "usage_reverted",
        postReason: null,
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: null,
        nextBaselineSnapshot: snapshot,
      };
    }

    // 5. resetsAt reverted or jitter deviation
    const resetsAtAdvanceFromBaseline = snapshot.resetsAt - baseline.resetsAt;
    const resetsAtDiffFromFirstEvidence = Math.abs(snapshot.resetsAt - firstEvidence.resetsAt);
    if (
      resetsAtAdvanceFromBaseline < RESET_AT_MEANINGFUL_FORWARD_SEC - RESET_AT_JITTER_TOLERANCE_SEC ||
      resetsAtDiffFromFirstEvidence > RESET_AT_JITTER_TOLERANCE_SEC
    ) {
      return {
        status: "cancelled",
        cancellationReason: "reset_at_reverted",
        postReason: null,
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: null,
        nextBaselineSnapshot: snapshot,
      };
    }

    // Check confirmation requirements:
    // 1. Must be a scheduled poll (notifications can start, update, or cancel candidates, but cannot confirm)
    // 2. Must have elapsed at least MIN_RECOVERY_CONFIRMATION_DELAY_MS (>= 60s)
    const elapsedMs = Number.isFinite(nowMs) && Number.isFinite(candidate.candidateStartedAtMs)
      ? nowMs - candidate.candidateStartedAtMs
      : 0;

    if (trigger !== "poll" || elapsedMs < MIN_RECOVERY_CONFIRMATION_DELAY_MS) {
      return {
        status: "pending_unconfirmed",
        postReason: null,
        postSnapshot: snapshot,
        nextPendingRecoveryCandidate: {
          ...candidate,
          lastObservation: snapshot,
          observationCount: candidate.observationCount + 1,
        },
        nextBaselineSnapshot: baseline,
      };
    }

    // Confirmed genuine recovery across independent observations!
    return {
      status: "confirmed",
      postReason: "recovery_candidate",
      postSnapshot: firstEvidence,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  const baseline = state.baselineSnapshot ?? state.previousLocalSnapshot;
  if (!baseline) {
    return {
      status: "none",
      postReason: null,
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  // Structure change
  if (
    snapshot.limitId !== baseline.limitId ||
    snapshot.planType !== baseline.planType ||
    snapshot.windowDurationMins !== baseline.windowDurationMins
  ) {
    return {
      status: "none",
      postReason: "structure_change",
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  // Stale observation
  const baselineObservedTime = Date.parse(baseline.observedAt);
  const currentObservedTime = Date.parse(snapshot.observedAt);
  if (
    Number.isFinite(baselineObservedTime) &&
    Number.isFinite(currentObservedTime) &&
    currentObservedTime < baselineObservedTime
  ) {
    return {
      status: "none",
      postReason: null,
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: baseline,
    };
  }

  // Comparison gap (> 10m) -> rebase
  if (
    Number.isFinite(baselineObservedTime) &&
    Number.isFinite(currentObservedTime) &&
    currentObservedTime - baselineObservedTime > MAX_USAGE_COMPARISON_GAP_MS
  ) {
    return {
      status: "none",
      postReason: null,
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  // Check recovery criteria against baseline
  const usageDecrease = baseline.usedPercent - snapshot.usedPercent;
  const resetsAtAdvance = snapshot.resetsAt - baseline.resetsAt;
  if (usageDecrease >= 1 && resetsAtAdvance >= RESET_AT_MEANINGFUL_FORWARD_SEC) {
    return {
      status: "started",
      postReason: null,
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: {
        preRecoveryBaseline: baseline,
        firstEvidenceSnapshot: snapshot,
        candidateStartedAtMs: nowMs,
        lastObservation: snapshot,
        observationCount: 1,
      },
      nextBaselineSnapshot: baseline,
    };
  }

  // Heartbeat check
  if (
    Number.isFinite(nowMs) &&
    Number.isFinite(state.lastSuccessfulPostAt) &&
    nowMs - state.lastSuccessfulPostAt >= MONITOR_HEARTBEAT_INTERVAL_MS
  ) {
    return {
      status: "none",
      postReason: "heartbeat",
      postSnapshot: snapshot,
      nextPendingRecoveryCandidate: null,
      nextBaselineSnapshot: snapshot,
    };
  }

  return {
    status: "none",
    postReason: null,
    postSnapshot: snapshot,
    nextPendingRecoveryCandidate: null,
    nextBaselineSnapshot: snapshot,
  };
}

export function getMonitorSnapshotPostReason(
  snapshot: CodexUsageSnapshot,
  state: MonitorSnapshotState,
  nowMs = Date.now(),
  trigger: MonitorRefreshTrigger = "poll",
): MonitorSnapshotPostReason | null {
  return evaluateMonitorRecoveryCandidate(snapshot, state, nowMs, trigger).postReason;
}

export function getMonitorPostSnapshot(
  snapshot: CodexUsageSnapshot,
  state: MonitorSnapshotState,
  postReason?: MonitorSnapshotPostReason | null,
  nowMs = Date.now(),
  trigger: MonitorRefreshTrigger = "poll",
): CodexUsageSnapshot {
  if (postReason === "recovery_candidate" && state.pendingRecoveryCandidate) {
    return state.pendingRecoveryCandidate.firstEvidenceSnapshot;
  }
  return evaluateMonitorRecoveryCandidate(snapshot, state, nowMs, trigger).postSnapshot;
}

export function updateMonitorSnapshotState(
  state: MonitorSnapshotState,
  snapshot: CodexUsageSnapshot,
  postSucceeded: boolean,
  postCompletedAtMs = Date.now(),
  options: {
    nowMs?: number;
    logger?: MonitorLogger;
    trigger?: MonitorRefreshTrigger;
  } = {},
): MonitorSnapshotState {
  const evaluationTime = options.nowMs ?? postCompletedAtMs ?? Date.now();
  const evaluation = evaluateMonitorRecoveryCandidate(
    snapshot,
    state,
    evaluationTime,
    options.trigger ?? "poll",
  );

  if (options.logger) {
    if (evaluation.status === "started") {
      options.logger("recovery_candidate_started", {
        observedAt: snapshot.observedAt,
        usedPercent: snapshot.usedPercent,
        resetsAt: snapshot.resetsAt,
        planType: snapshot.planType,
        windowDurationMins: snapshot.windowDurationMins,
        ...getMonitorBankedResetDisplayState(snapshot, state.lastKnownBankedResetAvailableCount),
      });
    } else if (evaluation.status === "confirmed") {
      const candidate = state.pendingRecoveryCandidate;
      options.logger("recovery_candidate_confirmed", {
        observedAt: snapshot.observedAt,
        usedPercent: snapshot.usedPercent,
        resetsAt: snapshot.resetsAt,
        firstObservedAt: candidate?.firstEvidenceSnapshot.observedAt ?? snapshot.observedAt,
        delayMs: Math.max(0, evaluationTime - (candidate?.candidateStartedAtMs ?? 0)),
      });
    } else if (evaluation.status === "cancelled") {
      options.logger("recovery_candidate_cancelled", {
        reason: evaluation.cancellationReason ?? "cancelled",
        observedAt: snapshot.observedAt,
        usedPercent: snapshot.usedPercent,
        resetsAt: snapshot.resetsAt,
      });
    }
  }

  return {
    baselineSnapshot: evaluation.nextBaselineSnapshot,
    previousLocalSnapshot: snapshot,
    lastKnownBankedResetAvailableCount: isValidBankedResetCount(snapshot.bankedResetAvailableCount)
      ? snapshot.bankedResetAvailableCount
      : getLastKnownBankedResetAvailableCount(state),
    lastSuccessfulPostAt: postSucceeded && Number.isFinite(postCompletedAtMs)
      ? postCompletedAtMs
      : state.lastSuccessfulPostAt,
    pendingRecoveryCandidate: evaluation.nextPendingRecoveryCandidate,
    pendingPosts: getPendingMonitorPosts(state),
  };
}

export function toSafeMonitorPayload(
  snapshot: CodexUsageSnapshot,
  postReason?: MonitorSnapshotPostReason,
) {
  return {
    ...(postReason
      ? {
          monitorProtocolVersion: MONITOR_PROTOCOL_VERSION,
          postReason,
        }
      : {}),
    observedAt: snapshot.observedAt,
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    usedPercent: snapshot.usedPercent,
    windowDurationMins: snapshot.windowDurationMins,
    resetsAt: snapshot.resetsAt,
    ...(typeof snapshot.bankedResetAvailableCount === "number"
      ? {
          bankedResetAvailableCount: snapshot.bankedResetAvailableCount,
          ...(postReason === "banked_reset_count_change" ? { bankedResetCountChange: true } : {}),
        }
      : {}),
  };
}

export function getSafeMonitorErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^[a-z0-9_]{1,80}$/.test(message)) return message;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 80) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length <= 80) return name;
  }
  return "unknown";
}

function getCodexCliPath(env: NodeJS.ProcessEnv) {
  if (env.CODEX_CLI_PATH?.trim()) return env.CODEX_CLI_PATH;
  if (!env.LOCALAPPDATA) return "codex";

  const binDirectory = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const bundledPath = path.join(binDirectory, "codex.exe");
  const candidates = [bundledPath];
  try {
    for (const entry of fs.readdirSync(binDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sideBySidePath = path.join(binDirectory, entry.name, "codex.exe");
      if (fs.existsSync(sideBySidePath)) candidates.push(sideBySidePath);
    }
  } catch {
    return bundledPath;
  }

  const existingCandidates = candidates.flatMap((candidate) => {
    try {
      const stats = fs.statSync(candidate);
      return stats.isFile() ? [{ candidate, modifiedAt: stats.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  if (existingCandidates.length === 0) return bundledPath;

  // Codex desktop keeps side-by-side CLI versions under this directory. Pick
  // the newest local executable while retaining CODEX_CLI_PATH as the escape hatch.
  return existingCandidates.reduce((latest, current) =>
    current.modifiedAt > latest.modifiedAt ? current : latest,
  ).candidate;
}

function validateWebhookUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_webhook_url");
  }
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("webhook_requires_https");
  }
  return url.toString();
}

export type CodexUsageMonitorConfig = {
  secret: string;
  webhookUrl: string;
  codexCliPath: string;
  pollIntervalMs: number;
};

export function getMonitorConfig(env: NodeJS.ProcessEnv = process.env): CodexUsageMonitorConfig {
  const secret = env.CODEX_USAGE_MONITOR_SECRET?.trim();
  if (!secret) throw new Error("monitor_secret_missing");

  return {
    secret,
    webhookUrl: validateWebhookUrl(env.CODEX_USAGE_WEBHOOK_URL?.trim() || DEFAULT_WEBHOOK_URL),
    codexCliPath: getCodexCliPath(env),
    pollIntervalMs: getMonitorPollIntervalMs(env.CODEX_USAGE_POLL_INTERVAL_MS),
  };
}

export type MonitorLogger = (event: string, details?: Record<string, unknown>) => void;

export type MonitorEventWriter = (line: string) => void;

export function createJsonMonitorLogger(
  writeLine: MonitorEventWriter = (line) => process.stdout.write(`${line}\n`),
): MonitorLogger {
  return (event, details = {}) => {
    const safeDetails: Record<string, unknown> = {};
    const allowedKeys = event === "snapshot_observed"
      ? ["observedAt", "usedPercent", "resetsAt", "planType", "windowDurationMins", "bankedResetDisplayCount", "bankedResetCountSource"]
      : event === "snapshot_sent"
        ? ["reason", "observedAt", "usedPercent", "resetsAt", "planType", "windowDurationMins", "bankedResetCountChange", "bankedResetDisplayCount", "bankedResetCountSource"]
        : event === "reset_confirmed"
          ? ["resetEventKey", "observedAt", "resetsAt"]
      : event === "recovery_candidate_started"
        ? ["observedAt", "usedPercent", "resetsAt", "planType", "windowDurationMins", "bankedResetDisplayCount", "bankedResetCountSource"]
      : event === "recovery_candidate_confirmed"
        ? ["observedAt", "usedPercent", "resetsAt", "firstObservedAt", "delayMs"]
      : event === "recovery_candidate_cancelled"
        ? ["reason", "observedAt", "usedPercent", "resetsAt"]
      : event === "snapshot_failed"
        ? ["reason"]
        : event === "session_restart"
          ? ["reason", "backoffMs"]
          : event === "error"
            ? ["reason"]
            : event === "snapshot_rejected"
              ? ["reason"]
              : [];

    for (const key of allowedKeys) {
      const value = details[key];
      if (key === "bankedResetDisplayCount" &&
        (typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > MAX_BANKED_RESET_AVAILABLE_COUNT)) {
        continue;
      }
      if (typeof value === "string" || typeof value === "number") {
        safeDetails[key] = value;
      }
    }

    writeLine(JSON.stringify({
      event,
      at: new Date().toISOString(),
      ...safeDetails,
    }));
  };
}

function defaultLogger(event: string, details: Record<string, unknown> = {}) {
  console.info(`[Codex usage monitor] ${event}`, details);
}

function waitFor(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function postUsageSnapshot(
  config: CodexUsageMonitorConfig,
  snapshot: CodexUsageSnapshot,
  postReason?: MonitorSnapshotPostReason,
): Promise<MonitorWebhookResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MONITOR_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toSafeMonitorPayload(snapshot, postReason)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`webhook_http_${response.status}`);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A successful webhook without a JSON status remains a successful post,
      // but it cannot confirm a reset notification.
    }
    if (!body || typeof body !== "object") return { accepted: false };
    const candidate = body as { accepted?: unknown; recovery?: unknown };
    return {
      accepted: candidate.accepted === true,
      ...(typeof candidate.recovery === "string" ? { recovery: candidate.recovery } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

type PendingRequest = {
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

async function runAppServerSession(
  config: CodexUsageMonitorConfig,
  logger: MonitorLogger,
  signal: AbortSignal,
) {
  if (signal.aborted) return;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(config.codexCliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new Error("app_server_spawn_failed");
  }

  logger("app_server_started");

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let nextRequestId = 1;
    let refreshInFlight = false;
    let consecutiveRpcFailures = 0;
    const emittedResetConfirmationKeys = new Set<string>();
    let monitorSnapshotState: MonitorSnapshotState = {
      previousLocalSnapshot: null,
      lastSuccessfulPostAt: null,
      pendingPosts: [],
    };
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const pending = new Map<string, PendingRequest>();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      notificationDebouncer.cancel();
      pending.forEach((request) => {
        clearTimeout(request.timeout);
        request.reject(error ?? new Error("app_server_stopped"));
      });
      pending.clear();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };

    const abort = () => {
      try { child.kill(); } catch { /* process is already gone */ }
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });

    const sendNotification = (method: string, params: JsonObject = {}) => {
      if (settled || !child.stdin.writable) return;
      const message = {
        jsonrpc: "2.0",
        method,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const sendRequest = (method: string, params?: JsonObject) => new Promise<JsonObject>((resolveRequest, rejectRequest) => {
      const id = String(nextRequestId++);
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error("app_server_request_timeout"));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      try {
        child.stdin.write(`${JSON.stringify(createAppServerRequest(method, id, params))}\n`);
      } catch {
        clearTimeout(timeout);
        pending.delete(id);
        rejectRequest(new Error("app_server_write_failed"));
      }
    });

    const logSnapshotSent = (
      reason: MonitorSnapshotPostReason,
      snapshot: CodexUsageSnapshot,
    ) => {
      const displayState = getMonitorBankedResetDisplayState(
        snapshot,
        monitorSnapshotState.lastKnownBankedResetAvailableCount,
      );
      logger("snapshot_sent", {
        reason,
        observedAt: snapshot.observedAt,
        usedPercent: snapshot.usedPercent,
        resetsAt: snapshot.resetsAt,
        planType: snapshot.planType,
        windowDurationMins: snapshot.windowDurationMins,
        bankedResetCountChange: reason === "banked_reset_count_change",
        ...displayState,
      });
    };

    const postSnapshotSafely = async (
      snapshot: CodexUsageSnapshot,
      reason: MonitorSnapshotPostReason,
    ): Promise<MonitorWebhookResponse | null> => {
      try {
        return await postUsageSnapshot(config, snapshot, reason);
      } catch (error) {
        logger("snapshot_failed", { reason: getSafeMonitorErrorCode(error) });
        return null;
      }
    };

    const emitResetConfirmationIfNeeded = (
      snapshot: CodexUsageSnapshot,
      reason: MonitorSnapshotPostReason,
      response: MonitorWebhookResponse | null,
    ) => {
      if (!response || !isMonitorResetExecutionConfirmed(response, reason)) return;
      const resetEventKey = getMonitorResetEventKey(snapshot);
      if (emittedResetConfirmationKeys.has(resetEventKey)) return;
      emittedResetConfirmationKeys.add(resetEventKey);
      logger("reset_confirmed", {
        resetEventKey,
        observedAt: snapshot.observedAt,
        resetsAt: snapshot.resetsAt,
      });
    };

    const refresh = async (retryPending = true, trigger: MonitorRefreshTrigger = "poll") => {
      if (settled || !initialized || refreshInFlight) return;
      refreshInFlight = true;
      let rpcFailed = false;
      try {
        let response: JsonObject;
        try {
          response = await sendRequest("account/rateLimits/read");
        } catch (error) {
          rpcFailed = true;
          throw error;
        }
        consecutiveRpcFailures = 0;
        const snapshot = parseCodexRateLimitsResponse(response, new Date());
        if (!snapshot) {
          logger("snapshot_rejected", { reason: "invalid_weekly_window" });
          return;
        }

        logger("snapshot_observed", {
          observedAt: snapshot.observedAt,
          usedPercent: snapshot.usedPercent,
          resetsAt: snapshot.resetsAt,
          planType: snapshot.planType,
          windowDurationMins: snapshot.windowDurationMins,
          ...getMonitorBankedResetDisplayState(
            snapshot,
            monitorSnapshotState.lastKnownBankedResetAvailableCount,
          ),
        });

        const previousLocalSnapshot = monitorSnapshotState.previousLocalSnapshot;
        const pendingBefore = getPendingMonitorPosts(monitorSnapshotState);
        let pendingRetryFailed = false;
        const pendingToRetry = retryPending ? pendingBefore[0] : undefined;
        if (pendingToRetry) {
          const webhookResponse = await postSnapshotSafely(pendingToRetry.snapshot, pendingToRetry.reason);
          if (webhookResponse) {
            monitorSnapshotState = markMonitorSnapshotPostSucceeded(monitorSnapshotState);
            logSnapshotSent(pendingToRetry.reason, pendingToRetry.snapshot);
            emitResetConfirmationIfNeeded(pendingToRetry.snapshot, pendingToRetry.reason, webhookResponse);
          } else {
            pendingRetryFailed = true;
          }
        }

        const nowMs = Date.now();
        const postReason = getMonitorSnapshotPostReason(
          snapshot,
          monitorSnapshotState,
          nowMs,
          trigger,
        );
        const postSnapshot = getMonitorPostSnapshot(
          snapshot,
          monitorSnapshotState,
          postReason,
          nowMs,
          trigger,
        );
        monitorSnapshotState = updateMonitorSnapshotState(
          monitorSnapshotState,
          snapshot,
          false,
          nowMs,
          { nowMs, logger, trigger },
        );

        if (pendingRetryFailed) {
          if (postReason && postReason !== "heartbeat") {
            monitorSnapshotState = enqueueMonitorSnapshotPost(
              monitorSnapshotState,
              postReason,
              postSnapshot,
            );
          }
          return;
        }
        if (!postReason) return;

        if (postReason === "heartbeat") {
          if (getPendingMonitorPosts(monitorSnapshotState).length > 0) return;
          const webhookResponse = await postSnapshotSafely(postSnapshot, postReason);
          if (webhookResponse) {
            monitorSnapshotState = markMonitorSnapshotPostSucceeded(monitorSnapshotState, Date.now());
            logSnapshotSent(postReason, postSnapshot);
            emitResetConfirmationIfNeeded(postSnapshot, postReason, webhookResponse);
          }
          return;
        }

        monitorSnapshotState = enqueueMonitorSnapshotPost(
          monitorSnapshotState,
          postReason,
          postSnapshot,
        );
        const pendingPosts = getPendingMonitorPosts(monitorSnapshotState);
        if (pendingPosts.length !== 1 || !pendingPosts[0]) return;

        const pendingPost = pendingPosts[0];
        const webhookResponse = await postSnapshotSafely(pendingPost.snapshot, pendingPost.reason);
        if (webhookResponse) {
          monitorSnapshotState = markMonitorSnapshotPostSucceeded(monitorSnapshotState, Date.now());
          logSnapshotSent(pendingPost.reason, pendingPost.snapshot);
          emitResetConfirmationIfNeeded(pendingPost.snapshot, pendingPost.reason, webhookResponse);
        }
      } catch (error) {
        logger("snapshot_failed", { reason: getSafeMonitorErrorCode(error) });
        if (rpcFailed) {
          consecutiveRpcFailures += 1;
          if (!signal.aborted && shouldRestartAppServerAfterRpcFailure(consecutiveRpcFailures)) {
            finish(new Error("app_server_rpc_unhealthy"));
          }
        }
      } finally {
        refreshInFlight = false;
      }
    };

    const notificationDebouncer = createNotificationDebouncer(() => {
      void refresh(false, "notification");
    }, NOTIFICATION_DEBOUNCE_MS);

    const parser = createJsonLineParser(
      (message) => {
        const messageId = message.id;
        if (typeof messageId === "string" || typeof messageId === "number") {
          const id = String(messageId);
          const request = pending.get(id);
          if (request) {
            pending.delete(id);
            clearTimeout(request.timeout);
            if (message.error && typeof message.error === "object") {
              request.reject(new Error("app_server_rpc_error"));
            } else {
              request.resolve(message);
            }
            return;
          }
        }

        if (message.method === "account/rateLimits/updated") {
          notificationDebouncer.schedule();
        }
      },
      () => {
        logger("malformed_json", { action: "restart" });
        try { child.kill(); } catch { /* process is already gone */ }
      },
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // Never forward app-server stderr: it may contain private diagnostics.
    });
    child.once("error", (error: NodeJS.ErrnoException) => finish(
      new Error(error.code === "ENOENT" ? "codex_cli_not_found" : "app_server_process_error"),
    ));
    child.once("close", () => {
      if (signal.aborted) finish();
      else finish(new Error("app_server_exited"));
    });

    const initialize = async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: {
            name: "codex-reset-observatory-usage-monitor",
            title: "Codex Reset Observatory usage monitor",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: false },
        });
        if (settled) return;
        sendNotification("initialized");
        initialized = true;
        await refresh(true, "initial");
        if (settled) return;
        pollTimer = setInterval(() => { void refresh(true, "poll"); }, config.pollIntervalMs);
      } catch (error) {
        const reason = getSafeMonitorErrorCode(error);
        finish(new Error(reason === "unknown" ? "app_server_initialize_failed" : reason));
      }
    };

    void initialize();
  });
}

export async function runCodexUsageMonitor(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal; logger?: MonitorLogger } = {},
) {
  const config = getMonitorConfig(env);
  const signal = options.signal ?? new AbortController().signal;
  const logger = options.logger ?? defaultLogger;
  let restartAttempt = 0;

  while (!signal.aborted) {
    try {
      await runAppServerSession(config, logger, signal);
      restartAttempt = 0;
    } catch (error) {
      logger("session_restart", {
        reason: getSafeMonitorErrorCode(error),
        backoffMs: getRestartBackoffMs(restartAttempt),
      });
      await waitFor(getRestartBackoffMs(restartAttempt), signal);
      restartAttempt = Math.min(restartAttempt + 1, RESTART_BACKOFF_MS.length - 1);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runCodexUsageMonitor(process.env, { signal: controller.signal }).catch((error) => {
    console.error("[Codex usage monitor] stopped", { reason: getSafeMonitorErrorCode(error) });
    process.exitCode = 1;
  });
}
