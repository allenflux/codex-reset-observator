import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import { getCompletedResetTimestamp } from "../lib/radar/probability";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import type { WindowEventLike } from "../lib/radar/types";
import {
  RANDOM_RESET_NAME_SYSTEM_PROMPT,
  buildRandomResetNamePrompt,
  parseRandomResetNameResponse,
  toRandomResetNameInput,
  type RandomResetNameEvaluationInput,
  type RandomResetNameEvaluationResult,
  type RandomResetNameEvaluationStatus,
} from "../lib/radar/randomResetNaming";

export type RoundTwoCondition = "metadata_only" | "metadata_plus_source";

export type SourceTweetRow = {
  tweet_id: string;
  text: string | null;
  tweet_url: string | null;
  tweet_created_at: string | null;
  is_reply?: boolean | null;
};

export type PairedRandomResetNameEvent = {
  eventId: string;
  completedAt: string;
  metadata: RandomResetNameEvaluationInput;
  sourceTweet: SourceTweetRow;
};

export type RoundTwoEvaluationRow = {
  eventId: string;
  completedAt: string;
  condition: RoundTwoCondition;
  input?: RandomResetNameEvaluationInput;
  sourcePostText?: string | null;
  name: string | null;
  confidence: number | null;
  evidence: string | null;
  reason: string | null;
  evidenceGrounded?: boolean | null;
  status: RandomResetNameEvaluationStatus;
  needsHumanReview: boolean;
  flags: string[];
  attempts: number;
  retryCount?: number;
};

export type RoundTwoComparison = {
  pairedSuccessfulCount: number;
  sameNameCount: number;
  changedNameCount: number;
  metadataNullToSourceNameCount: number;
  metadataNameToSourceNullCount: number;
  bothNullCount: number;
  oneSidedFailureCount: number;
  bothFailedCount: number;
};

export type RoundTwoConditionMetrics = {
  requestCount: number;
  successCount: number;
  namedCount: number;
  nullNameCount: number;
  needsHumanReviewCount: number;
  averageConfidence: number | null;
  rateLimitedCount: number;
  otherFailureCount: number;
};

type RoundTwoAttemptResult = RandomResetNameEvaluationResult & {
  retryAfterSeconds: number | null;
};

const TIBO_STATUS_URL = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/thsottiaux\/status\/(\d+)(?:[/?#]|$)/i;
// The static event fixture records some completion times to the minute while
// Supabase keeps tweet creation seconds. This small tolerance covers that
// representation gap without allowing a later post to become source context.
const SOURCE_EVENT_TIME_TOLERANCE_MS = 5 * 60 * 1000;

function getSourceUrl(item: WindowEventLike) {
  return item.source_url?.trim() || item.source?.trim() || item.link?.trim() || null;
}

function getEventId(item: WindowEventLike, completedAt: number) {
  return item.id?.trim() || item.guid?.trim() || `completed-${new Date(completedAt).toISOString()}`;
}

export function extractDirectTiboTweetId(sourceUrl: string | null) {
  const match = sourceUrl?.trim().match(TIBO_STATUS_URL);
  return match?.[1] ?? null;
}

function getEligibleEvents(history: WindowEventLike[], asOf: Date) {
  if (!Number.isFinite(asOf.getTime())) throw new Error("asOf must be a valid date");
  return history
    .map((item) => ({ item, completedAt: getCompletedResetTimestamp(item) }))
    .filter(({ item, completedAt }) =>
      isEligibleRandomResetEvent(item, completedAt, asOf.getTime()),
    )
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0));
}

export function getUniqueDirectTiboTweetIds(
  history: WindowEventLike[],
  asOf: Date,
) {
  const allSourceIdCounts = new Map<string, number>();
  for (const item of history) {
    const sourceId = extractDirectTiboTweetId(getSourceUrl(item));
    if (sourceId) allSourceIdCounts.set(sourceId, (allSourceIdCounts.get(sourceId) ?? 0) + 1);
  }

  return getEligibleEvents(history, asOf)
    .map(({ item }) => extractDirectTiboTweetId(getSourceUrl(item)))
    .filter((tweetId): tweetId is string =>
      Boolean(tweetId && allSourceIdCounts.get(tweetId) === 1),
    )
    .filter((tweetId, index, ids) => ids.indexOf(tweetId) === index);
}

export function pairRandomResetNameEvents(
  history: WindowEventLike[],
  sourceTweets: SourceTweetRow[],
  asOf: Date,
  limit = 16,
): PairedRandomResetNameEvent[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
    throw new Error("limit must be an integer from 1 to 16");
  }

  const allSourceIdCounts = new Map<string, number>();
  for (const item of history) {
    const sourceId = extractDirectTiboTweetId(getSourceUrl(item));
    if (sourceId) allSourceIdCounts.set(sourceId, (allSourceIdCounts.get(sourceId) ?? 0) + 1);
  }

  const sourceRowsById = new Map<string, SourceTweetRow>();
  const duplicateSourceRows = new Set<string>();
  for (const row of sourceTweets) {
    if (sourceRowsById.has(row.tweet_id)) duplicateSourceRows.add(row.tweet_id);
    else sourceRowsById.set(row.tweet_id, row);
  }

  const paired: PairedRandomResetNameEvent[] = [];
  for (const { item, completedAt } of getEligibleEvents(history, asOf)) {
    if (completedAt === null || !Number.isFinite(completedAt)) continue;
    const sourceId = extractDirectTiboTweetId(getSourceUrl(item));
    if (!sourceId || allSourceIdCounts.get(sourceId) !== 1 || duplicateSourceRows.has(sourceId)) continue;

    const sourceTweet = sourceRowsById.get(sourceId);
    if (!sourceTweet?.text?.trim()) continue;
    if (sourceTweet.is_reply === true) continue;
    const tweetTime = Date.parse(sourceTweet.tweet_created_at ?? "");
    if (!Number.isFinite(tweetTime) || tweetTime > completedAt + SOURCE_EVENT_TIME_TOLERANCE_MS) continue;

    const metadata = toRandomResetNameInput(item, completedAt);
    metadata.sourcePostText = null;
    paired.push({
      eventId: getEventId(item, completedAt),
      completedAt: new Date(completedAt).toISOString(),
      metadata,
      sourceTweet,
    });
    if (paired.length >= limit) break;
  }
  return paired;
}

export function buildRoundTwoPrompt(
  input: RandomResetNameEvaluationInput,
  condition: RoundTwoCondition,
  sourcePostText: string | null,
) {
  const metadataPrompt = buildRandomResetNamePrompt({
    ...input,
    sourcePostText: null,
  });
  if (condition === "metadata_only") return metadataPrompt;
  return `${metadataPrompt}\nsource_post_text:\n${JSON.stringify(sourcePostText)}`;
}

function emptyResult(
  status: RandomResetNameEvaluationStatus,
  model: string,
  latencyMs: number,
  httpStatus: number | null = null,
  retryAfterSeconds: number | null = null,
): RoundTwoAttemptResult {
  return {
    name: null,
    confidence: null,
    evidence: null,
    reason: null,
    evidenceGrounded: null,
    flags: [],
    status,
    model,
    latencyMs,
    httpStatus,
    retryAfterSeconds,
  };
}

function loadLocalEnvironment() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].trim();
    process.env[match[1]] =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
  }
}

function parseRetryAfter(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (timestamp - Date.now()) / 1000);
}

function requestGemini(
  endpoint: string,
  payload: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string; retryAfterSeconds: number | null }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      new URL(endpoint),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            retryAfterSeconds: parseRetryAfter(response.headers["retry-after"]),
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("TIMEOUT")));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

async function generateRoundTwoName(
  input: RandomResetNameEvaluationInput,
  condition: RoundTwoCondition,
  sourcePostText: string | null,
  model: string,
  apiKey: string,
  timeoutMs: number,
): Promise<RoundTwoAttemptResult> {
  const startedAt = performance.now();
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = JSON.stringify({
    contents: [{
      role: "user",
      parts: [
        { text: RANDOM_RESET_NAME_SYSTEM_PROMPT },
        { text: buildRoundTwoPrompt(input, condition, sourcePostText) },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0,
    },
  });

  try {
    const response = await requestGemini(endpoint, payload, timeoutMs);
    const latencyMs = Math.round(performance.now() - startedAt);
    if (response.statusCode === 429) {
      return emptyResult("rate_limited", model, latencyMs, 429, response.retryAfterSeconds);
    }
    if (response.statusCode !== 200) {
      return emptyResult("api_error", model, latencyMs, response.statusCode);
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(response.body);
    } catch {
      return emptyResult("invalid_json", model, latencyMs, 200);
    }
    const textContent = (
      envelope as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      }
    )?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof textContent !== "string") {
      return emptyResult("invalid_json", model, latencyMs, 200);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textContent);
    } catch {
      return emptyResult("invalid_json", model, latencyMs, 200);
    }
    return {
      ...parseRandomResetNameResponse(
        parsed,
        { ...input, sourcePostText: condition === "metadata_plus_source" ? sourcePostText : null },
        model,
        latencyMs,
      ),
      retryAfterSeconds: null,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    return emptyResult(
      error instanceof Error && error.message === "TIMEOUT" ? "timeout" : "api_error",
      model,
      latencyMs,
    );
  }
}

function normalizeCorpus(input: RandomResetNameEvaluationInput, sourcePostText: string | null) {
  return [
    input.completedAt,
    input.currentClassification,
    input.status,
    input.cycleType,
    input.reasonType,
    input.resetMethod,
    input.scope,
    input.noticeType,
    input.noticeToExecution,
    input.recordedSummary,
    input.sourceUrl,
    sourcePostText,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}

function addUnsupportedClaimFlags(
  input: RandomResetNameEvaluationInput,
  sourcePostText: string | null,
  result: RoundTwoAttemptResult,
) {
  if (result.status !== "success") return result;
  const flags = [...result.flags];
  const corpus = normalizeCorpus(input, sourcePostText);
  const name = result.name ?? "";
  const namedTokens = name.match(/\b(?:gpt(?:[- ]?[0-9]+(?:\.[0-9]+)?)?|chatgpt|codex|luna|openai|gemini|claude|sora)\b/gi) ?? [];
  if (namedTokens.some((token) => !corpus.includes(token.toLocaleLowerCase()))) {
    flags.push("unprovided_named_token");
  }
  const numberTokens = name.match(/\d+(?:[.,]\d+)?(?:\s*(?:万人|万|件|回|名|人|%))?/g) ?? [];
  if (numberTokens.some((token) => !corpus.includes(token.replace(/\s+/g, "").toLocaleLowerCase()))) {
    flags.push("unprovided_number");
  }
  if (name.includes("公式") && !corpus.includes("official")) {
    flags.push("unsupported_official_claim");
  }
  return { ...result, flags: Array.from(new Set(flags)) };
}

function toEvaluationRow(
  paired: PairedRandomResetNameEvent,
  condition: RoundTwoCondition,
  result: RoundTwoAttemptResult,
  attempts: number,
  retryCount: number,
): RoundTwoEvaluationRow {
  const sourcePostText = condition === "metadata_plus_source" ? paired.sourceTweet.text : null;
  const audited = addUnsupportedClaimFlags(paired.metadata, sourcePostText, result);
  return {
    eventId: paired.eventId,
    completedAt: paired.completedAt,
    condition,
    input: paired.metadata,
    sourcePostText,
    name: audited.name,
    confidence: audited.confidence,
    evidence: audited.evidence,
    reason: audited.reason,
    evidenceGrounded: audited.evidenceGrounded,
    status: audited.status,
    needsHumanReview: audited.flags.length > 0,
    flags: audited.flags,
    attempts,
    retryCount,
  };
}

async function evaluateWithRetry(
  paired: PairedRandomResetNameEvent,
  condition: RoundTwoCondition,
  model: string,
  apiKey: string,
  options: { timeoutMs: number; maxRetries: number; retryBaseMs: number },
) {
  const sourcePostText = condition === "metadata_plus_source" ? paired.sourceTweet.text : null;
  let attempts = 0;
  let retryCount = 0;
  let lastResult: RoundTwoAttemptResult | null = null;

  while (true) {
    attempts += 1;
    lastResult = await generateRoundTwoName(
      paired.metadata,
      condition,
      sourcePostText,
      model,
      apiKey,
      options.timeoutMs,
    );
    if (lastResult.status !== "rate_limited" || retryCount >= options.maxRetries) break;
    retryCount += 1;
    const fallbackDelayMs = Math.min(options.retryBaseMs * 2 ** (retryCount - 1), 120_000);
    const retryDelayMs = lastResult.retryAfterSeconds === null
      ? fallbackDelayMs
      : Math.max(0, Math.round(lastResult.retryAfterSeconds * 1000));
    console.log(
      `retry event=${paired.eventId} condition=${condition} retry=${retryCount}/${options.maxRetries} delayMs=${retryDelayMs}`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }

  return toEvaluationRow(paired, condition, lastResult!, attempts, retryCount);
}

export function compareRoundTwoRows(rows: RoundTwoEvaluationRow[]): RoundTwoComparison {
  const byEvent = new Map<string, Partial<Record<RoundTwoCondition, RoundTwoEvaluationRow>>>();
  for (const row of rows) {
    const group = byEvent.get(row.eventId) ?? {};
    group[row.condition] = row;
    byEvent.set(row.eventId, group);
  }

  const comparison: RoundTwoComparison = {
    pairedSuccessfulCount: 0,
    sameNameCount: 0,
    changedNameCount: 0,
    metadataNullToSourceNameCount: 0,
    metadataNameToSourceNullCount: 0,
    bothNullCount: 0,
    oneSidedFailureCount: 0,
    bothFailedCount: 0,
  };

  for (const group of Array.from(byEvent.values())) {
    const metadata = group.metadata_only;
    const source = group.metadata_plus_source;
    if (!metadata || !source) {
      comparison.oneSidedFailureCount += 1;
      continue;
    }
    const metadataSuccess = metadata?.status === "success";
    const sourceSuccess = source?.status === "success";
    if (metadataSuccess && sourceSuccess) {
      comparison.pairedSuccessfulCount += 1;
      if (metadata.name === source.name) comparison.sameNameCount += 1;
      else comparison.changedNameCount += 1;
      if (metadata.name === null && source.name !== null) comparison.metadataNullToSourceNameCount += 1;
      if (metadata.name !== null && source.name === null) comparison.metadataNameToSourceNullCount += 1;
      if (metadata.name === null && source.name === null) comparison.bothNullCount += 1;
    } else if (metadataSuccess !== sourceSuccess) {
      comparison.oneSidedFailureCount += 1;
    } else {
      comparison.bothFailedCount += 1;
    }
  }
  return comparison;
}

export function computeRoundTwoConditionMetrics(
  rows: RoundTwoEvaluationRow[],
  condition: RoundTwoCondition,
): RoundTwoConditionMetrics {
  const selected = rows.filter((row) => row.condition === condition);
  const successes = selected.filter((row) => row.status === "success");
  const confidences = successes
    .map((row) => row.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    requestCount: selected.length,
    successCount: successes.length,
    namedCount: successes.filter((row) => row.name !== null).length,
    nullNameCount: successes.filter((row) => row.name === null).length,
    needsHumanReviewCount: selected.filter((row) => row.needsHumanReview).length,
    averageConfidence: confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null,
    rateLimitedCount: selected.filter((row) => row.status === "rate_limited").length,
    otherFailureCount: selected.filter((row) => row.status !== "success" && row.status !== "rate_limited").length,
  };
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchSourceTweets(tweetIds: string[]): Promise<SourceTweetRow[]> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the read-only query");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("tibo_signals")
    .select("tweet_id,text,tweet_url,tweet_created_at,is_reply")
    .in("tweet_id", tweetIds);
  if (error) throw new Error(`Read-only source tweet query failed (${error.code ?? "unknown"})`);
  return (data ?? []) as SourceTweetRow[];
}

function getArgument(name: string, fallback: string) {
  const index = process.argv.findIndex(
    (value) => value === `--${name}` || value.startsWith(`--${name}=`),
  );
  if (index < 0) return fallback;
  const token = process.argv[index];
  if (token.includes("=")) return token.slice(name.length + 3);
  return process.argv[index + 1] ?? fallback;
}

function markdownCell(value: string | number | null | undefined) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function compactText(value: string | null | undefined, length = 120) {
  return value ? value.replace(/\s+/g, " ").trim().slice(0, length) : "(unavailable)";
}

function formatMetric(value: number | null) {
  return value === null ? "n/a" : value.toFixed(3);
}

export function buildRoundTwoReport(
  pairs: PairedRandomResetNameEvent[],
  rows: RoundTwoEvaluationRow[],
  metadata: {
    model: string;
    asOf: string;
    startedAt: string;
    eligibleCandidateCount: number;
    directTiboCandidateCount: number;
    requestDelayMs: number;
    maxRetries: number;
  },
) {
  const metricsA = computeRoundTwoConditionMetrics(rows, "metadata_only");
  const metricsB = computeRoundTwoConditionMetrics(rows, "metadata_plus_source");
  const comparison = compareRoundTwoRows(rows);
  const byEventCondition = new Map<string, Partial<Record<RoundTwoCondition, RoundTwoEvaluationRow>>>();
  for (const row of rows) {
    const group = byEventCondition.get(row.eventId) ?? {};
    group[row.condition] = row;
    byEventCondition.set(row.eventId, group);
  }

  const lines = [
    "# Random reset display-name evaluation: round 2",
    "",
    "This is a paired, evaluation-only experiment. Condition A uses the Round 1 metadata-only prompt. Condition B appends only the matched raw Tibo post as `source_post_text`. The two requests are independent and use the same model, system prompt, structured response shape, and temperature as Round 1.",
    "",
    "No generated name was written to Supabase, the production UI, the public API, event history, or existing classification fields. The Supabase query was read-only.",
    "",
    `- Evaluation started: ${metadata.startedAt}`,
    `- Local data as of: ${metadata.asOf}`,
    `- Gemini model: ${metadata.model}`,
    `- Eligible random event candidates: ${metadata.eligibleCandidateCount}`,
    `- Direct Tibo URL candidates: ${metadata.directTiboCandidateCount}`,
    `- Paired events with a reliable source row: ${pairs.length}`,
    `- Maximum paired events: 16`,
    `- Request delay: ${metadata.requestDelayMs} ms; maximum rate-limit retries: ${metadata.maxRetries}`,
    "",
    "## Conditions and input boundary",
    "",
    "A: recorded metadata only. B: the same metadata followed by the exact raw text from the matched Tibo row. Existing display names, event IDs, later interpretations, translations, and web context are not sent to Gemini. Ambiguous duplicate source IDs, non-Tibo URLs, replies, missing text, invalid timestamps, and source posts more than five minutes after completion are excluded from the paired sample. The five-minute bound only absorbs the static fixture's minute-level completion timestamp precision.",
    "",
    "## Condition metrics",
    "",
    "| condition | requests | success | name | null | review | avg confidence | 429 | other failure |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| A metadata only | ${metricsA.requestCount} | ${metricsA.successCount} | ${metricsA.namedCount} | ${metricsA.nullNameCount} | ${metricsA.needsHumanReviewCount} | ${formatMetric(metricsA.averageConfidence)} | ${metricsA.rateLimitedCount} | ${metricsA.otherFailureCount} |`,
    `| B metadata + source | ${metricsB.requestCount} | ${metricsB.successCount} | ${metricsB.namedCount} | ${metricsB.nullNameCount} | ${metricsB.needsHumanReviewCount} | ${formatMetric(metricsB.averageConfidence)} | ${metricsB.rateLimitedCount} | ${metricsB.otherFailureCount} |`,
    "",
    "## Paired comparison",
    "",
    `- Successful paired outputs: ${comparison.pairedSuccessfulCount}`,
    `- Same name: ${comparison.sameNameCount}`,
    `- Changed name: ${comparison.changedNameCount}`,
    `- A null -> B name: ${comparison.metadataNullToSourceNameCount}`,
    `- A name -> B null: ${comparison.metadataNameToSourceNullCount}`,
    `- Both null: ${comparison.bothNullCount}`,
    `- One-sided failure: ${comparison.oneSidedFailureCount}`,
    `- Both failed: ${comparison.bothFailedCount}`,
    "",
    "## Side-by-side results",
    "",
    "Human scoring is intentionally blank for manual review: identifiability, brevity, evidence fidelity, and abstention ability use 0/1/2.",
    "",
    "| event | completed at | event facts | A name | A conf | A evidence | B name | B conf | B evidence | A review (I/B/E/A) | B review (I/B/E/A) |",
    "|---|---|---|---|---:|---|---|---:|---|---|---|",
  ];

  for (const pair of pairs) {
    const group = byEventCondition.get(pair.eventId) ?? {};
    const a = group.metadata_only;
    const b = group.metadata_plus_source;
    lines.push(
      `| ${markdownCell(pair.eventId)} | ${markdownCell(pair.completedAt)} | ${markdownCell(`${pair.metadata.reasonType} / ${pair.metadata.resetMethod} / ${pair.metadata.scope}`)} | ${markdownCell(a?.status === "success" ? a.name ?? "null" : "(failure)")} | ${a?.confidence === null || a?.confidence === undefined ? "" : a.confidence.toFixed(2)} | ${markdownCell(a?.evidence)} | ${markdownCell(b?.status === "success" ? b.name ?? "null" : "(failure)")} | ${b?.confidence === null || b?.confidence === undefined ? "" : b.confidence.toFixed(2)} | ${markdownCell(b?.evidence)} |  |  |`,
    );
  }

  lines.push("", "## Per-event details", "");
  for (const pair of pairs) {
    const group = byEventCondition.get(pair.eventId) ?? {};
    lines.push(
      `### ${pair.eventId} (${pair.completedAt})`,
      "",
      `- Source URL: ${pair.sourceTweet.tweet_url ?? pair.metadata.sourceUrl ?? "unavailable"}`,
      `- Source tweet created at: ${pair.sourceTweet.tweet_created_at ?? "unavailable"}`,
      `- Raw Tibo post text used only in B: ${pair.sourceTweet.text ?? "unavailable"}`,
      `- Recorded facts: ${compactText(pair.metadata.recordedSummary, 500)}`,
      "",
    );
    for (const condition of ["metadata_only", "metadata_plus_source"] as const) {
      const row = group[condition];
      lines.push(
        `#### ${condition}`,
        "",
        `- Status: ${row?.status ?? "not requested"}`,
        `- Attempts: ${row?.attempts ?? "n/a"}; retries: ${row?.retryCount ?? "n/a"}`,
        `- Name: ${row?.name ?? "null"}`,
        `- Confidence: ${row?.confidence === null || row?.confidence === undefined ? "null" : row.confidence.toFixed(3)}`,
        `- Evidence: ${row?.evidence ?? "null"}`,
        `- Evidence grounded in supplied fields: ${row?.evidenceGrounded === null || row?.evidenceGrounded === undefined ? "n/a" : row.evidenceGrounded ? "yes" : "no"}`,
        `- Reason: ${row?.reason ?? "null"}`,
        `- Review flags: ${row?.flags?.length ? row.flags.join(", ") : "none"}`,
        "",
      );
    }
  }

  lines.push(
    "## Review observations",
    "",
    "The script does not automatically conclude that condition B is better. Human review should focus on whether the raw post improves identifiability without adding unsupported facts, whether null is used appropriately, and whether evidence remains a literal supplied substring.",
    "",
    "Rows with `needsHumanReview=true` or a non-success status require manual inspection. Suspicious output flags include ungrounded evidence, classification-only names, unprovided model/count terms, and unsupported official claims.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  loadLocalEnvironment();
  const model = process.env.GEMINI_MODEL?.trim();
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!model) throw new Error("GEMINI_MODEL is not configured; no API call was made");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured; no API call was made");

  const limit = Number(getArgument("limit", "16"));
  const requestDelayMs = Number(getArgument("request-delay-ms", "5000"));
  const retryBaseMs = Number(getArgument("retry-base-ms", "30000"));
  const maxRetries = Number(getArgument("max-retries", "3"));
  const timeoutMs = Number(getArgument("timeout-ms", "10000"));
  const outputPath = path.resolve(
    getArgument("output", "reports/random-reset-name-evaluation-round2.md"),
  );
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("--limit must be an integer from 1 to 16");
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 0) throw new Error("--request-delay-ms must be non-negative");
  if (!Number.isInteger(retryBaseMs) || retryBaseMs < 1) throw new Error("--retry-base-ms must be positive");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new Error("--max-retries must be from 0 to 3");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms must be at least 1000");

  const asOf = new Date();
  const eligibleCandidateCount = getEligibleEvents(LOCAL_RESET_HISTORY, asOf).length;
  const directTweetIds = getUniqueDirectTiboTweetIds(LOCAL_RESET_HISTORY, asOf);
  console.log(`eligible random event candidates=${eligibleCandidateCount}`);
  console.log(`unique direct Tibo tweet candidates=${directTweetIds.length}`);
  if (directTweetIds.length === 0) throw new Error("No uniquely mapped direct Tibo tweet candidates were found");
  const sourceTweets = await fetchSourceTweets(directTweetIds);
  console.log(`read-only source tweet rows=${sourceTweets.length}`);
  for (const sourceTweet of sourceTweets) {
    console.log(
      `source tweet id=${sourceTweet.tweet_id} textLength=${sourceTweet.text?.length ?? 0} createdAt=${sourceTweet.tweet_created_at ?? "null"} isReply=${sourceTweet.is_reply === true}`,
    );
  }
  const pairs = pairRandomResetNameEvents(LOCAL_RESET_HISTORY, sourceTweets, asOf, limit);
  if (pairs.length === 0) throw new Error("No paired events with valid source text were found");

  const startedAt = new Date().toISOString();
  const rows: RoundTwoEvaluationRow[] = [];
  let requestStarted = false;
  for (const pair of pairs) {
    for (const condition of ["metadata_only", "metadata_plus_source"] as const) {
      if (requestStarted) await sleep(requestDelayMs);
      requestStarted = true;
      const row = await evaluateWithRetry(pair, condition, model, apiKey, {
        timeoutMs,
        maxRetries,
        retryBaseMs,
      });
      rows.push(row);
      console.log(
        `event=${pair.eventId} condition=${condition} status=${row.status} name=${row.name ?? "null"} attempts=${row.attempts}`,
      );
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    buildRoundTwoReport(pairs, rows, {
      model,
      asOf: asOf.toISOString(),
      startedAt,
      eligibleCandidateCount,
      directTiboCandidateCount: directTweetIds.length,
      requestDelayMs,
      maxRetries,
    }),
    "utf8",
  );
  console.log(`Wrote ${outputPath}`);
  console.log(`Model: ${model}`);
  console.log(`Paired events: ${pairs.length}; requests: ${rows.length}`);
  console.log("No production database or event record was modified.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Round two evaluation failed");
    process.exitCode = 1;
  });
}
