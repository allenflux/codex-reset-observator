import { createClient } from "@supabase/supabase-js";
import { classifyWithGemini } from "../lib/radar/geminiClassification";

/**
 * Backfill script for Gemini AI Shadow Classification on existing tibo_signals rows
 * Rate Limit Compliance: RPD 500, RPM 15 (Sequential execution with 5s delay)
 *
 * Usage:
 *   npx tsx scripts/backfill-tibo-ai-classification.ts [options]
 *
 * Options:
 *   --limit N       Process up to N unclassified rows (default: 100)
 *   --dry-run       Perform classification without writing to Supabase
 *   --tweet-id ID   Process only a specific tweet_id
 */

async function runBackfill() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");

  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 100;

  const tweetIdIndex = args.indexOf("--tweet-id");
  const specificTweetId = tweetIdIndex !== -1 ? args[tweetIdIndex + 1] : null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error("Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
    process.exit(1);
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY must be set to run the backfill script.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  console.log(`[AI Backfill] Initializing... (limit=${limit}, dryRun=${isDryRun}, model=${model}, delay=5000ms)`);

  // Fetch target rows
  let query = supabase
    .from("tibo_signals")
    .select("*")
    .order("tweet_created_at", { ascending: false });

  if (specificTweetId) {
    query = query.eq("tweet_id", specificTweetId);
  } else {
    // Only rows where AI classification hasn't succeeded yet
    query = query.or("ai_classification_status.is.null,ai_classification_status.eq.skipped,ai_classification_status.eq.model_not_configured");
  }

  if (limit > 0) {
    query = query.limit(limit);
  }

  const { data: rows, error } = await query;

  if (error || !rows) {
    console.error("[AI Backfill] Failed to fetch rows from Supabase:", error);
    process.exit(1);
  }

  console.log(`[AI Backfill] Found ${rows.length} rows to process.`);

  let processedCount = 0;
  let successCount = 0;

  for (const row of rows) {
    console.log(`\n--------------------------------------------------`);
    console.log(`Processing Tweet ID: ${row.tweet_id} (${row.tweet_created_at})`);
    console.log(`Text: "${row.text.substring(0, 80)}..."`);
    console.log(`Current Rule Signal: ${row.signal_type} (conf: ${row.confidence})`);

    // Skip translated texts if indicated by text artifacts
    if (row.text.includes("Translated from English") || row.text.includes("Google による翻訳")) {
      console.log(`[AI Backfill] Skipping translated text for tweet ${row.tweet_id}`);
      continue;
    }

    // Single Gemini API call per row (no model auto-fallback)
    const aiResult = await classifyWithGemini(
      { text: row.text, tweetCreatedAt: row.tweet_created_at },
      { apiKey, model, mode: "shadow" }
    );

    console.log(`AI Result Status: ${aiResult.status}`);
    if (aiResult.status === "success") {
      console.log(`AI Signal Type: ${aiResult.signalType} (conf: ${aiResult.confidence})`);
      console.log(`AI Temporal Direction: ${aiResult.temporalDirection}`);
      console.log(`AI Reason: ${aiResult.reasonJa}`);
    }

    // Stop safely on rate limit (429) without losing already saved rows
    if (aiResult.status === "rate_limited") {
      console.warn(`[AI Backfill] Hit Rate Limit (429)! Stopping safely. Successfully processed ${successCount} rows before limit.`);
      break;
    }

    if (!isDryRun && aiResult.status !== "skipped") {
      // Save results to Supabase immediately (CRITICAL: signal_type & confidence remain untouched)
      const updatePayload = {
        ai_signal_type: aiResult.signalType,
        ai_confidence: aiResult.confidence,
        ai_temporal_direction: aiResult.temporalDirection,
        ai_evidence_quote: aiResult.evidenceQuote,
        ai_reason_ja: aiResult.reasonJa,
        ai_reset_type_ja: aiResult.resetTypeJa,
        ai_notice_to_execution: aiResult.noticeToExecution,
        ai_teaser_strength: aiResult.teaserStrength,
        ai_teaser_strength_confidence: aiResult.teaserStrengthConfidence,
        ai_teaser_strength_evidence_quote: aiResult.teaserStrengthEvidenceQuote,
        ai_teaser_strength_reason_ja: aiResult.teaserStrengthReasonJa,
        ai_model: aiResult.model,
        ai_classification_status: aiResult.status,
        ai_classified_at: aiResult.classifiedAt,
        classification_source: aiResult.status === "success" ? "shadow" : "rule",
      };

      const { error: updateErr } = await supabase
        .from("tibo_signals")
        .update(updatePayload)
        .eq("tweet_id", row.tweet_id);

      if (updateErr) {
        console.error(`[AI Backfill] Failed to update tweet ${row.tweet_id}:`, updateErr);
      } else {
        console.log(`[AI Backfill] Successfully saved row ${row.tweet_id} to Supabase.`);
        successCount++;
      }
    }

    processedCount++;
    // Mandatory 5-second delay between sequential requests (RPM 15 compliance: max 12 requests/min)
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.log(`\n==================================================`);
  console.log(`[AI Backfill] Completed. Processed: ${processedCount}, Saved: ${successCount}`);
}

runBackfill().catch((err) => {
  console.error("[AI Backfill] Fatal error:", err);
  process.exit(1);
});
