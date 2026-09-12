import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_RESET_HISTORY } from "../data/resetHistory";
import {
  getCompletedResetTimestamp,
} from "../lib/radar/probability";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import {
  combineResetHistory,
  isFormalTiboResetSignal,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import {
  applyAcceptedResetDisplayName,
  fetchResetDisplayNames,
  getResetDisplayNameWritePayload,
  hashResetDisplayNameInput,
  shouldPreserveExistingAcceptedResetDisplayName,
  shouldSkipResetDisplayNameGenerationWithoutSource,
  shouldReuseResetDisplayNameResult,
} from "../lib/radar/resetDisplayNameStore";
import {
  getResetDisplayNameEventKey,
  getResetDisplayNameSourceTweetId,
  isGenericResetDisplayTitle,
} from "../lib/radar/resetDisplayNames";
import {
  assessRandomResetNameResult,
  generateRandomResetName,
  RANDOM_RESET_NAME_MODEL,
  RANDOM_RESET_NAME_PROMPT_VERSION,
  toRandomResetNameInput,
  type RandomResetNameGenerationResult,
} from "../lib/radar/randomResetNaming";
import type { ResetDisplayNameRecord, WindowEventLike } from "../lib/radar/types";

const SOURCE_EVENT_TIME_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const DEFAULT_DELAY_MS = 5000;

type SourceTweetRow = {
  tweet_id: string;
  text: string | null;
  tweet_url: string | null;
  tweet_created_at: string | null;
  is_reply: boolean | null;
  signal_type: FormalTiboResetSignal["signal_type"];
  confidence: number | null;
  verification_status: FormalTiboResetSignal["verification_status"];
  classification_source: FormalTiboResetSignal["classification_source"];
  ai_reset_type_ja: string | null;
};

type BackfillRow = {
  eventKey: string;
  sourceTweetId: string | null;
  completedAt: string;
  currentTitle: string | null;
  inputMode: "metadata" | "metadata+source" | null;
  sourcePostText: string | null;
  inputHash: string | null;
  name: string | null;
  nameEn: string | null;
  nameZh: string | null;
  confidence: number | null;
  evidence: string | null;
  reason: string | null;
  status: string;
  flags: string[];
  wouldDisplay: string;
  applied: boolean;
};

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

function getArgument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isRandomResetDisplayNameApplyMode(args: string[]) {
  return args.includes("--apply");
}

export function canApplyRandomResetDisplayNameStatus(status: string) {
  return status === "accepted";
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getSourceTweetIdFromUrl(value: string | null | undefined) {
  return value?.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/thsottiaux\/status\/(\d+)/i)?.[1] ?? null;
}

function isSourceForEvent(source: SourceTweetRow, event: WindowEventLike, completedAt: number) {
  if (source.is_reply === true || !source.text?.trim()) return false;
  const sourceAt = source.tweet_created_at ? Date.parse(source.tweet_created_at) : Number.NaN;
  return Number.isFinite(sourceAt) && Math.abs(sourceAt - completedAt) <= SOURCE_EVENT_TIME_TOLERANCE_MS;
}

function fallbackDisplayName(item: WindowEventLike, record: ResetDisplayNameRecord | undefined) {
  const manual = record?.manual_name_ja?.trim();
  if (manual) return manual;
  const title = typeof item.title === "object" && item.title !== null ? item.title.ja?.trim() : item.title?.trim();
  return title && !isGenericResetDisplayTitle(title) ? title : "ランダムリセット";
}

async function fetchTiboSourceRows(
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<SourceTweetRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("tibo_signals")
    .select("tweet_id,text,tweet_url,tweet_created_at,is_reply,signal_type,confidence,verification_status,classification_source,ai_reset_type_ja")
    .limit(2000);
  if (error) throw new Error("Tibo source lookup failed");
  return (data ?? []) as SourceTweetRow[];
}

function buildCandidates(
  now: Date,
  tiboRows: SourceTweetRow[],
  storedNames: ResetDisplayNameRecord[],
  tweetIdFilter: string | null,
) {
  const formalSignals = tiboRows
    .filter((row) => row.tweet_id && row.text && row.tweet_created_at)
    .map((row) => row as unknown as FormalTiboResetSignal)
    .filter(isFormalTiboResetSignal);
  const history = combineResetHistory(LOCAL_RESET_HISTORY, formalSignals);
  const sourceByTweetId = new Map(tiboRows.map((row) => [row.tweet_id, row]));
  const namesByKey = new Map(storedNames.map((record) => [record.event_key, record]));
  const seen = new Set<string>();

  return history
    .map((item) => {
      const completedAt = getCompletedResetTimestamp(item);
      const completedTime = completedAt === null ? null : completedAt;
      const eventKey = getResetDisplayNameEventKey(item);
      if (!eventKey || completedTime === null) return null;
      if (!isEligibleRandomResetEvent(item, completedTime, now.getTime())) return null;
      if (seen.has(eventKey)) return null;
      seen.add(eventKey);

      const sourceTweetId = getResetDisplayNameSourceTweetId(item) ?? getSourceTweetIdFromUrl(item.source_url);
      if (tweetIdFilter && sourceTweetId !== tweetIdFilter) return null;
      const source = sourceTweetId ? sourceByTweetId.get(sourceTweetId) : undefined;
      const sourceText = source && isSourceForEvent(source, item, completedTime)
        ? source.text?.trim() ?? null
        : null;
      const input = toRandomResetNameInput(item, completedTime);
      input.sourcePostText = sourceText;
      const inputMode: "metadata" | "metadata+source" = sourceText ? "metadata+source" : "metadata";
      const inputHash = hashResetDisplayNameInput(input, sourceText);

      return {
        item,
        eventKey,
        sourceTweetId,
        completedAt: new Date(completedTime).toISOString(),
        currentTitle: (typeof item.title === "object" && item.title !== null ? item.title.ja?.trim() : item.title?.trim()) || null,
        sourceText,
        input,
        inputMode,
        inputHash,
        existing: namesByKey.get(eventKey),
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}

function resultRow(
  candidate: ReturnType<typeof buildCandidates>[number],
  result: RandomResetNameGenerationResult | null,
  status: string,
  applied = false,
): BackfillRow {
  const acceptedName = result ? assessRandomResetNameResult(result).displayName : null;
  const existingName = candidate.existing?.ai_status === "accepted"
    ? candidate.existing.ai_name_ja?.trim() ?? null
    : null;
  return {
    eventKey: candidate.eventKey,
    sourceTweetId: candidate.sourceTweetId,
    completedAt: candidate.completedAt,
    currentTitle: candidate.currentTitle,
    inputMode: candidate.inputMode,
    sourcePostText: candidate.sourceText,
    inputHash: candidate.inputHash,
    name: result?.name ?? existingName,
    nameEn: result?.nameEn ?? candidate.existing?.ai_name_en ?? null,
    nameZh: result?.nameZh ?? candidate.existing?.ai_name_zh ?? null,
    confidence: result?.confidence ?? candidate.existing?.ai_confidence ?? null,
    evidence: result?.evidence ?? candidate.existing?.ai_evidence ?? null,
    reason: result?.reason ?? candidate.existing?.ai_reason ?? null,
    status,
    flags: result?.flags ?? candidate.existing?.ai_flags ?? [],
    wouldDisplay: acceptedName ?? existingName ?? fallbackDisplayName(candidate.item, candidate.existing),
    applied,
  };
}

function markdownCell(value: string | null | undefined) {
  return (value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || "-";
}

function buildMarkdown(
  rows: BackfillRow[],
  meta: { mode: string; generatedAt: string; model: string; promptVersion: string; candidateCount: number },
) {
  const lines = [
    "# Random reset display-name backfill",
    "",
    `- Mode: ${meta.mode}`,
    `- Generated at: ${meta.generatedAt}`,
    `- Model: ${meta.model}`,
    `- Prompt version: ${meta.promptVersion}`,
    `- Candidate count: ${meta.candidateCount}`,
    "- This script never changes reset event titles or classification fields. Only explicitly accepted names are eligible for `--apply`.",
    "",
    "| Event key | Completed | Current title | Input | Name (JA) | Name (EN) | Name (ZH) | Confidence | Status | Flags | Would display | Applied |",
    "|---|---|---|---|---|---|---|---:|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${markdownCell(row.eventKey)} | ${markdownCell(row.completedAt)} | ${markdownCell(row.currentTitle)} | ${markdownCell(row.inputMode)} | ${markdownCell(row.name)} | ${markdownCell(row.nameEn)} | ${markdownCell(row.nameZh)} | ${row.confidence === null ? "-" : row.confidence.toFixed(3)} | ${markdownCell(row.status)} | ${markdownCell(row.flags.join(", "))} | ${markdownCell(row.wouldDisplay)} | ${row.applied ? "yes" : "no"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  loadLocalEnvironment();
  const apply = isRandomResetDisplayNameApplyMode(process.argv);
  const limit = Number(getArgument("limit", String(DEFAULT_LIMIT)));
  const delayMs = Number(getArgument("delay-ms", String(DEFAULT_DELAY_MS)));
  const tweetIdFilter = process.argv.includes("--tweet-id")
    ? getArgument("tweet-id", "")
    : null;
  const jsonPath = path.resolve(getArgument("output", "reports/random-reset-display-name-backfill.json"));
  const markdownPath = path.resolve(getArgument("markdown", "reports/random-reset-display-name-backfill.md"));

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const apiKey = process.env.GEMINI_API_KEY?.trim() || null;
  if (apply && !apiKey) throw new Error("GEMINI_API_KEY is required with --apply");

  const [sourceRows, storedNames] = await Promise.all([
    fetchTiboSourceRows(supabase),
    fetchResetDisplayNames(),
  ]);
  const now = new Date();
  const candidates = buildCandidates(now, sourceRows, storedNames, tweetIdFilter).slice(0, limit);
  const rows: BackfillRow[] = [];
  let requestCount = 0;
  let requestStarted = false;

  for (const candidate of candidates) {
    if (candidate.currentTitle && !isGenericResetDisplayTitle(candidate.currentTitle)) {
      rows.push(resultRow(candidate, null, "skipped_human_title"));
      continue;
    }
    if (candidate.existing?.manual_name_ja?.trim()) {
      rows.push(resultRow(candidate, null, "manual"));
      continue;
    }
    if (shouldPreserveExistingAcceptedResetDisplayName(candidate.existing ?? null)) {
      rows.push(resultRow(candidate, null, "preserved_legacy_accepted"));
      continue;
    }
    if (shouldSkipResetDisplayNameGenerationWithoutSource(candidate.sourceText)) {
      rows.push(resultRow(candidate, null, "source_unavailable"));
      continue;
    }
    if (shouldReuseResetDisplayNameResult(candidate.existing ?? null, candidate.inputHash, RANDOM_RESET_NAME_MODEL)) {
      rows.push(resultRow(candidate, null, `reused_${candidate.existing?.ai_status ?? "stored"}`));
      continue;
    }
    if (!apiKey) {
      rows.push(resultRow(candidate, null, "api_error"));
      continue;
    }

    if (requestStarted && delayMs > 0) await sleep(delayMs);
    requestStarted = true;
    requestCount += 1;
    const result = await generateRandomResetName(candidate.input, {
      apiKey,
      model: RANDOM_RESET_NAME_MODEL,
      timeoutMs: 10_000,
    });
    const acceptance = assessRandomResetNameResult(result);
    let applied = false;
    if (apply && canApplyRandomResetDisplayNameStatus(acceptance.status)) {
      const payload = getResetDisplayNameWritePayload({
        eventKey: candidate.eventKey,
        sourceTweetId: candidate.sourceTweetId,
        inputMode: candidate.inputMode,
        inputHash: candidate.inputHash,
        result,
        existing: candidate.existing ?? null,
        generatedAt: new Date().toISOString(),
      });
      applied = await applyAcceptedResetDisplayName(payload);
    }
    rows.push(resultRow(candidate, result, acceptance.status, applied));
    console.log(`${candidate.eventKey}: ${acceptance.status} ${result.name ?? "null"}`);
  }

  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    mode: apply ? "apply" : "dry-run",
    model: RANDOM_RESET_NAME_MODEL,
    promptVersion: RANDOM_RESET_NAME_PROMPT_VERSION,
    candidateCount: candidates.length,
    requestCount,
    acceptedCount: rows.filter((row) => row.status === "accepted" || row.status === "reused_accepted").length,
    newlyAcceptedCount: rows.filter((row) => row.status === "accepted").length,
    reusedAcceptedCount: rows.filter((row) => row.status === "reused_accepted").length,
    nullCount: rows.filter((row) => row.status === "null").length,
    reviewCount: rows.filter((row) => row.status === "review_required").length,
    failureCount: rows.filter((row) => ["api_error", "rate_limited", "invalid_response"].includes(row.status)).length,
    appliedCount: rows.filter((row) => row.applied).length,
    rows,
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, buildMarkdown(rows, {
    mode: payload.mode,
    generatedAt,
    model: RANDOM_RESET_NAME_MODEL,
    promptVersion: RANDOM_RESET_NAME_PROMPT_VERSION,
    candidateCount: candidates.length,
  }), "utf8");

  console.log(`Mode: ${payload.mode}`);
  console.log(`Candidates: ${payload.candidateCount}; Gemini requests: ${payload.requestCount}`);
  console.log(`Accepted: ${payload.acceptedCount} (${payload.newlyAcceptedCount} new, ${payload.reusedAcceptedCount} reused); null: ${payload.nullCount}; review: ${payload.reviewCount}; failures: ${payload.failureCount}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Random reset display-name backfill failed");
    process.exitCode = 1;
  });
}
