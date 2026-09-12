export type PredictionHistorySaveResult = {
  action: "inserted" | "already_logged";
  loggedHour: string;
  recordedAt: string | null;
};

function isDuplicatePredictionHistoryError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = [value.message, value.details]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return code === "23505" || /duplicate key|unique constraint/i.test(message);
}

async function readExistingPredictionHistory(client: any, loggedHour: string): Promise<PredictionHistorySaveResult> {
  const { data, error } = await client
    .from("prediction_history")
    .select("logged_hour,recorded_at")
    .eq("logged_hour", loggedHour)
    .maybeSingle();
  if (error || !data || typeof data.logged_hour !== "string") {
    throw error ?? new Error("Existing prediction history row was not found after a conflict.");
  }
  return {
    action: "already_logged",
    loggedHour: data.logged_hour,
    recordedAt: typeof data.recorded_at === "string" ? data.recorded_at : null,
  };
}

export async function savePredictionHistoryOnce(
  client: any,
  row: Record<string, unknown>,
): Promise<PredictionHistorySaveResult> {
  const loggedHour = typeof row.logged_hour === "string" ? row.logged_hour : null;
  if (!loggedHour) throw new TypeError("prediction history row requires logged_hour");

  let result: { data: Array<{ logged_hour?: unknown; recorded_at?: unknown }> | null; error: unknown };
  try {
    result = await client
      .from("prediction_history")
      .insert(row, { onConflict: "logged_hour", ignoreDuplicates: true })
      .select("logged_hour,recorded_at");
  } catch (error) {
    if (!isDuplicatePredictionHistoryError(error)) throw error;
    return readExistingPredictionHistory(client, loggedHour);
  }

  if (result.error) {
    if (!isDuplicatePredictionHistoryError(result.error)) throw result.error;
    return readExistingPredictionHistory(client, loggedHour);
  }

  const inserted = Array.isArray(result.data) ? result.data[0] : null;
  if (inserted && typeof inserted.logged_hour === "string") {
    return {
      action: "inserted",
      loggedHour: inserted.logged_hour,
      recordedAt: typeof inserted.recorded_at === "string" ? inserted.recorded_at : null,
    };
  }

  return readExistingPredictionHistory(client, loggedHour);
}
