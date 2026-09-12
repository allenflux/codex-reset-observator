import type { ResetDisplayNameRecord } from "./types";

export type ManualResetDisplayNameOverrideInput = {
  eventKey: string;
  manualNameJa: string;
  manualNameEn: string;
  manualNameZh: string;
};

export type ManualResetDisplayNameUpdatePayload = {
  manual_name_ja: string;
  manual_name_en: string;
  manual_name_zh: string;
  updated_at: string;
};

export type ManualResetDisplayNameStore = {
  findByEventKey: (eventKey: string) => Promise<ResetDisplayNameRecord | null>;
  updateManualNames: (
    eventKey: string,
    payload: ManualResetDisplayNameUpdatePayload,
  ) => Promise<void>;
};

export type ManualResetDisplayNameOverrideResult = {
  status: "dry_run" | "applied" | "not_found";
  eventKey: string;
  existing: ResetDisplayNameRecord | null;
  payload: ManualResetDisplayNameUpdatePayload | null;
};

function requireNonEmpty(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

export function validateManualResetDisplayNameInput(
  input: ManualResetDisplayNameOverrideInput,
): ManualResetDisplayNameOverrideInput {
  return {
    eventKey: requireNonEmpty(input.eventKey, "eventKey"),
    manualNameJa: requireNonEmpty(input.manualNameJa, "manualNameJa"),
    manualNameEn: requireNonEmpty(input.manualNameEn, "manualNameEn"),
    manualNameZh: requireNonEmpty(input.manualNameZh, "manualNameZh"),
  };
}

export function getManualResetDisplayNameWritePayload(
  input: ManualResetDisplayNameOverrideInput,
  updatedAt: string,
): ManualResetDisplayNameUpdatePayload {
  const normalized = validateManualResetDisplayNameInput(input);
  return {
    manual_name_ja: normalized.manualNameJa,
    manual_name_en: normalized.manualNameEn,
    manual_name_zh: normalized.manualNameZh,
    updated_at: updatedAt,
  };
}

export async function runManualResetDisplayNameOverride(args: {
  input: ManualResetDisplayNameOverrideInput;
  apply: boolean;
  updatedAt: string;
  store: ManualResetDisplayNameStore;
}): Promise<ManualResetDisplayNameOverrideResult> {
  const input = validateManualResetDisplayNameInput(args.input);
  const existing = await args.store.findByEventKey(input.eventKey);
  if (!existing) {
    return { status: "not_found", eventKey: input.eventKey, existing: null, payload: null };
  }

  const payload = getManualResetDisplayNameWritePayload(input, args.updatedAt);
  if (args.apply) {
    await args.store.updateManualNames(input.eventKey, payload);
  }

  return {
    status: args.apply ? "applied" : "dry_run",
    eventKey: input.eventKey,
    existing,
    payload,
  };
}
