import { createClient } from "@supabase/supabase-js";
import {
  clearTiboSecondaryManualOverride,
  getEffectiveTiboSecondarySignal,
  setTiboSecondaryManualOverride,
  type TiboSecondarySignal,
} from "../lib/radar/tiboSecondarySignal";

type Mode = "set" | "clear";

function getArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function getMode(): Mode {
  const mode = getArgument("--mode");
  if (mode === "set" || mode === "clear") return mode;
  throw new Error("--mode must be set or clear.");
}

function getSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const tweetId = getArgument("--tweet-id");
  const expectedText = getArgument("--expected-text");
  const mode = getMode();
  if (!tweetId || !/^\d+$/.test(tweetId)) throw new Error("A numeric --tweet-id is required.");
  if (!expectedText?.trim()) throw new Error("An exact --expected-text guard is required.");

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tibo_signals")
    .select("tweet_id,text,signal_type,secondary_signal")
    .eq("tweet_id", tweetId)
    .maybeSingle();
  if (error) throw new Error("Target lookup failed.");
  if (!data) throw new Error("Target tweet row was not found.");
  if (data.tweet_id !== tweetId || data.text !== expectedText) {
    throw new Error("Target tweet id/text guard did not match exactly.");
  }
  if (data.signal_type !== "reset_executed") {
    throw new Error("Target primary signal is not reset_executed; refusing the correction.");
  }

  const existing = (data.secondary_signal ?? null) as TiboSecondarySignal | null;
  if (!existing) throw new Error("Target has no secondary AI signal to preserve.");

  const next = mode === "set"
    ? setTiboSecondaryManualOverride(existing, {
        signalType: "teaser",
        teaserStrength: getArgument("--teaser-strength") as "strong" | "weak",
        reasonJa: getArgument("--reason-ja") ?? "",
        reviewedAt: getArgument("--reviewed-at") ?? new Date().toISOString(),
      })
    : clearTiboSecondaryManualOverride(existing);

  const effective = getEffectiveTiboSecondarySignal(next);
  const summary = {
    mode,
    tweetId,
    primarySignalType: data.signal_type,
    aiSecondarySignalType: existing.signalType,
    aiSecondaryTeaserStrength: existing.teaserStrength,
    effectiveSecondarySignalType: effective?.signalType ?? null,
    effectiveSecondaryTeaserStrength: effective?.teaserStrength ?? null,
    apply: hasFlag("--apply"),
  };

  if (!hasFlag("--apply")) {
    console.log(JSON.stringify(summary));
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from("tibo_signals")
    .update({ secondary_signal: next })
    .eq("tweet_id", tweetId)
    .eq("text", expectedText)
    .select("tweet_id,secondary_signal")
    .maybeSingle();
  if (updateError || !updated) throw new Error("Guarded secondary override update failed.");
  console.log(JSON.stringify({ ...summary, persisted: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Secondary override failed.");
  process.exitCode = 1;
});
