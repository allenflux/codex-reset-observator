import type {
  TiboFormalAdoptionClaimSource,
} from "./tiboResetEventIdentity";

export const TIBO_FORMAL_ADOPTION_RPC = "claim_tibo_formal_adoption";
export const TIBO_FORMAL_ADOPTION_COLUMNS =
  "id,logical_post_id,logical_post_tweet_ids,reset_event_key,representative_tweet_id,source_tweet_ids,claim_source,adopted_at,claimed_at,created_at,updated_at";

export type TiboFormalAdoptionRecord = {
  id: string;
  logicalPostId: string;
  logicalPostTweetIds: string[];
  resetEventKey: string;
  representativeTweetId: string;
  sourceTweetIds: string[];
  claimSource: TiboFormalAdoptionClaimSource;
  adoptedAt: string | null;
  claimedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TiboFormalAdoptionClaimInput = {
  logicalPostId: string;
  logicalPostTweetIds: readonly string[];
  resetEventKey: string;
  representativeTweetId: string;
  sourceTweetIds: readonly string[];
  claimSource: TiboFormalAdoptionClaimSource;
  identitySource: "x_api" | "none";
  adoptedAt?: string | null;
  claimedAt?: string;
};

export type TiboFormalAdoptionClaimStatus =
  | "claimed_new"
  | "existing"
  | "reconciled"
  | "conflict"
  | "error";

export type TiboFormalAdoptionConflictReason =
  | "ambiguous_existing_claims"
  | "conflicting_trusted_identity"
  | "canonical_existing_claims";

export type TiboFormalAdoptionClaimResult = {
  status: TiboFormalAdoptionClaimStatus;
  claimedNew: boolean;
  record: TiboFormalAdoptionRecord | null;
  reason?: TiboFormalAdoptionConflictReason;
  error?: unknown;
};

export type TiboFormalAdoptionRpcClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown | null }>;
};

export type TiboFormalAdoptionReadClient = {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        options: { ascending: boolean },
      ): PromiseLike<{ data: unknown[] | null; error: unknown | null }>;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function isDistinctNonEmptyStringArray(value: readonly string[], maxLength?: number) {
  return value.length > 0 &&
    (maxLength === undefined || value.length <= maxLength) &&
    value.every((item) => item.trim().length > 0) &&
    new Set(value).size === value.length;
}

function toRecord(value: unknown): TiboFormalAdoptionRecord | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const logicalPostId = stringValue(value.logical_post_id);
  const logicalPostTweetIds = stringArray(value.logical_post_tweet_ids);
  const resetEventKey = stringValue(value.reset_event_key);
  const representativeTweetId = stringValue(value.representative_tweet_id);
  const sourceTweetIds = stringArray(value.source_tweet_ids);
  const claimSource = value.claim_source;
  const claimedAt = stringValue(value.claimed_at);
  const createdAt = stringValue(value.created_at);
  const updatedAt = stringValue(value.updated_at);
  const adoptedAt = value.adopted_at === null || typeof value.adopted_at === "string"
    ? value.adopted_at
    : undefined;
  if (
    !id ||
    !logicalPostId ||
    !logicalPostTweetIds ||
    !isDistinctNonEmptyStringArray(logicalPostTweetIds, 6) ||
    !resetEventKey ||
    !representativeTweetId ||
    !sourceTweetIds ||
    !isDistinctNonEmptyStringArray(sourceTweetIds) ||
    logicalPostId !== logicalPostTweetIds[0] ||
    !logicalPostTweetIds.includes(representativeTweetId) ||
    adoptedAt === undefined ||
    (claimSource !== "new_adoption" &&
      claimSource !== "existing_estimate" &&
      claimSource !== "existing_history" &&
      claimSource !== "existing_dynamic") ||
    !claimedAt ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    logicalPostId,
    logicalPostTweetIds,
    resetEventKey,
    representativeTweetId,
    sourceTweetIds,
    claimSource,
    adoptedAt,
    claimedAt,
    createdAt,
    updatedAt,
  };
}

export async function claimTiboFormalAdoption(
  client: TiboFormalAdoptionRpcClient,
  input: TiboFormalAdoptionClaimInput,
): Promise<TiboFormalAdoptionClaimResult> {
  const response = await client.rpc(TIBO_FORMAL_ADOPTION_RPC, {
    p_logical_post_id: input.logicalPostId,
    p_logical_post_tweet_ids: [...input.logicalPostTweetIds],
    p_reset_event_key: input.resetEventKey,
    p_representative_tweet_id: input.representativeTweetId,
    p_source_tweet_ids: [...input.sourceTweetIds],
    p_claim_source: input.claimSource,
    p_identity_source: input.identitySource,
    p_adopted_at: input.adoptedAt ?? null,
    p_claimed_at: input.claimedAt ?? new Date().toISOString(),
  });
  if (response.error) {
    return { status: "error", claimedNew: false, record: null, error: response.error };
  }
  if (!isRecord(response.data)) {
    return {
      status: "error",
      claimedNew: false,
      record: null,
      error: new Error("Formal adoption RPC returned an invalid result"),
    };
  }
  const status = response.data.status;
  if (
    status !== "claimed_new" &&
    status !== "existing" &&
    status !== "reconciled" &&
    status !== "conflict"
  ) {
    return {
      status: "error",
      claimedNew: false,
      record: null,
      error: new Error("Formal adoption RPC returned an unknown status"),
    };
  }
  const record = toRecord(response.data.record);
  if (!record) {
    return {
      status: "error",
      claimedNew: false,
      record: null,
      error: new Error("Formal adoption RPC returned an invalid record"),
    };
  }
  const reason = response.data.reason;
  const conflictReason = reason === "ambiguous_existing_claims" ||
    reason === "conflicting_trusted_identity" ||
    reason === "canonical_existing_claims"
    ? reason
    : undefined;
  return {
    status,
    claimedNew: status === "claimed_new",
    record,
    ...(conflictReason === undefined ? {} : { reason: conflictReason }),
  };
}

export async function readTiboFormalAdoptions(
  client: TiboFormalAdoptionReadClient,
) {
  try {
    const result = await client
      .from("tibo_formal_adoptions")
      .select(TIBO_FORMAL_ADOPTION_COLUMNS)
      .order("created_at", { ascending: true });
    if (result.error) return { ledgers: [], error: result.error };
    if (result.data !== null && !Array.isArray(result.data)) {
      return {
        ledgers: [],
        error: new Error("Formal adoption ledger returned an invalid result"),
      };
    }

    const ledgers = (result.data ?? [])
      .map(toRecord)
      .filter((record): record is TiboFormalAdoptionRecord => Boolean(record));
    if (ledgers.length !== (result.data ?? []).length) {
      return {
        ledgers: [],
        error: new Error("Formal adoption ledger contains an invalid record"),
      };
    }
    return { ledgers, error: null };
  } catch (error) {
    return { ledgers: [], error };
  }
}
