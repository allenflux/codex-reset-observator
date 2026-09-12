type SupabaseSchemaError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

export function isMissingTiboOptionalColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as SupabaseSchemaError;
  const code = typeof value.code === "string" ? value.code : "";
  const message = [value.message, value.details]
    .filter((item): item is string => typeof item === "string")
    .join(" ");

  return (
    /(secondary_signal|teaser_strength|translated_text_(ja|zh)|ai_teaser_strength(?:_confidence|_evidence_quote|_reason_ja)?|ai_temporal_|temporal_(expression|kind|precision|timezone|confidence|resolution_source)|expected_(start|end)_at|temporal_resolution_|quote_(context_text|tweet_url|author_handle)|logical_post_id|edit_history_tweet_ids|edit_version|edit_metadata_source)/i.test(message) &&
    (code === "PGRST204" ||
      code === "42703" ||
      /column|schema cache|does not exist/i.test(message))
  );
}
