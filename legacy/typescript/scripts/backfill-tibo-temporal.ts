import { createClient } from "@supabase/supabase-js";
import { classifyWithGemini } from "../lib/radar/geminiClassification";
import {
  getTemporalNoticeExpiry,
  parseTiboTemporalSemantics,
  resolveTiboTemporalSchedule,
  TIBO_SOURCE_TIME_ZONE,
  TIBO_TEMPORAL_RESOLUTION_VERSION,
} from "../lib/radar/tiboTemporal";

const DEFAULT_LIMIT = 1000;

function getArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const limit = Number(getArgument("--limit") ?? DEFAULT_LIMIT);
  const tweetId = getArgument("--tweet-id");
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;

  if (!supabaseUrl || !serviceRoleKey || !apiKey || !model) {
    throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, and GEMINI_MODEL are required.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  let query = supabase
    .from("tibo_signals")
    .select("tweet_id,text,tweet_created_at,signal_type,ai_temporal_expression,ai_temporal_kind,ai_temporal_precision,ai_temporal_timezone,ai_temporal_confidence,temporal_expression,temporal_kind,temporal_precision,temporal_timezone,temporal_confidence,temporal_resolution_source,expected_start_at,expected_end_at,temporal_resolution_status,temporal_resolution_version,expires_at")
    .eq("signal_type", "official_notice")
    .order("tweet_created_at", { ascending: true });
  if (tweetId) query = query.eq("tweet_id", tweetId);
  if (!force) {
    query = query.or(
      `temporal_resolution_version.is.null,temporal_resolution_version.neq.${TIBO_TEMPORAL_RESOLUTION_VERSION}`,
    );
  }
  if (Number.isFinite(limit) && limit > 0) query = query.limit(limit);

  const { data: rows, error } = await query;
  if (error) throw new Error("Failed to read official notice rows.");

  console.log(`[Tibo temporal backfill] candidates=${rows?.length ?? 0} dryRun=${dryRun} model=${model}`);
  let success = 0;
  let unresolved = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const result = await classifyWithGemini(
      {
        text: row.text,
        tweetCreatedAt: row.tweet_created_at,
        sourceTimeZone: TIBO_SOURCE_TIME_ZONE,
      },
      { apiKey, model, mode: "shadow" },
    );
    if (result.status !== "success") {
      failed += 1;
      console.warn(`[Tibo temporal backfill] ${row.tweet_id}: classification unavailable (${result.status})`);
      continue;
    }

    const semantics = result.signalType === "official_notice" && result.temporalDirection === "future"
      ? parseTiboTemporalSemantics(result, row.text)
      : null;
    const resolution = resolveTiboTemporalSchedule(
      semantics,
      row.tweet_created_at,
      TIBO_SOURCE_TIME_ZONE,
    );
    const updatePayload: Record<string, unknown> = {
      ai_temporal_expression: result.temporalExpression,
      ai_temporal_kind: result.temporalKind,
      ai_temporal_precision: result.temporalPrecision,
      ai_temporal_timezone: result.explicitTimezone,
      ai_temporal_confidence: result.temporalConfidence,
      temporal_expression: resolution.temporalExpression,
      temporal_kind: resolution.temporalKind,
      temporal_precision: resolution.temporalPrecision,
      temporal_timezone: resolution.timezone,
      temporal_confidence: resolution.confidence,
      temporal_resolution_source: resolution.resolutionSource,
      expected_start_at: resolution.expectedStartAt,
      expected_end_at: resolution.expectedEndAt,
      temporal_resolution_status: resolution.status,
      temporal_resolution_version: resolution.version,
    };
    if (resolution.status === "resolved") {
      updatePayload.expires_at = getTemporalNoticeExpiry(resolution, row.tweet_created_at);
    }

    console.log(`[Tibo temporal backfill] ${row.tweet_id}: ${resolution.status} ${resolution.expectedStartAt ?? ""} ${resolution.expectedEndAt ?? ""}`);
    if (!dryRun) {
      const { error: updateError } = await supabase
        .from("tibo_signals")
        .update(updatePayload)
        .eq("tweet_id", row.tweet_id)
        .eq("signal_type", "official_notice");
      if (updateError) {
        failed += 1;
        console.warn(`[Tibo temporal backfill] ${row.tweet_id}: update failed`);
        continue;
      }
    }
    success += 1;
    if (resolution.status !== "resolved") unresolved += 1;
  }

  console.log(`[Tibo temporal backfill] completed success=${success} unresolved=${unresolved} failed=${failed}`);
}

run().catch(() => {
  console.error("[Tibo temporal backfill] failed");
  process.exitCode = 1;
});
