import type {
  TiboEditHistoryMetadata,
  TiboEditMetadataSource,
} from "./xPostEditHistory";

export const MAX_TIBO_EDIT_HISTORY_LENGTH = 6;
const MAX_TIBO_EDIT_RECONCILIATION_ATTEMPTS = 2;
export const TIBO_EDIT_IDENTITY_COLUMNS =
  "logical_post_id,edit_history_tweet_ids,edit_version,edit_metadata_source";

export type TiboEditIdentityFields = {
  logical_post_id?: string | null;
  edit_history_tweet_ids?: string[] | null;
  edit_version?: number | null;
  edit_metadata_source?: TiboEditMetadataSource | null;
};

export type TiboEditIdentityRecord = TiboEditIdentityFields & {
  tweet_id?: string | null;
};

export type TiboEditIdentityUpdate = {
  logical_post_id: string;
  edit_history_tweet_ids: string[];
  edit_version: number;
  edit_metadata_source: TiboEditMetadataSource;
};

export type TiboEditIdentityMergeResult = {
  status: "trusted" | "preserved" | "fallback" | "conflict";
  identity: TiboEditIdentityFields;
};

export type TiboEditChainReconciliationStatus =
  | "reconciled"
  | "unchanged"
  | "skipped"
  | "conflict"
  | "error";

export type TiboEditChainReconciliationResult = {
  status: TiboEditChainReconciliationStatus;
  identity: TiboEditIdentityUpdate;
  updatedTweetIds: string[];
  error?: unknown;
};

type TiboEditIdentitySelectBuilder = {
  in(
    column: string,
    values: string[],
  ): Promise<{ data: unknown[] | null; error: unknown | null }>;
};

type TiboEditIdentityUpdateBuilder = {
  eq(
    column: string,
    value: string,
  ): TiboEditIdentityUpdateBuilder;
  select(
    columns: string,
  ): Promise<{ data: unknown[] | null; error: unknown | null }>;
};

export type TiboEditIdentityStore = {
  from(table: string): {
    select(columns: string): TiboEditIdentitySelectBuilder;
    update(values: TiboEditIdentityUpdate): TiboEditIdentityUpdateBuilder;
  };
};

function isNumericPostId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isValidEditHistoryTweetIds(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_TIBO_EDIT_HISTORY_LENGTH &&
    value.every(isNumericPostId) &&
    new Set(value).size === value.length;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isPrefix(left: readonly string[], right: readonly string[]) {
  return left.length <= right.length && left.every((id, index) => id === right[index]);
}

function areCompatibleChains(
  left: TiboEditIdentityUpdate,
  right: TiboEditIdentityUpdate,
) {
  return left.logical_post_id === right.logical_post_id &&
    (isPrefix(left.edit_history_tweet_ids, right.edit_history_tweet_ids) ||
      isPrefix(right.edit_history_tweet_ids, left.edit_history_tweet_ids));
}

function identityForMember(
  chain: Pick<TiboEditIdentityUpdate, "logical_post_id" | "edit_history_tweet_ids" | "edit_metadata_source">,
  tweetId: string,
): TiboEditIdentityUpdate | null {
  const editVersion = chain.edit_history_tweet_ids.indexOf(tweetId) + 1;
  if (editVersion < 1) return null;
  return {
    logical_post_id: chain.logical_post_id,
    edit_history_tweet_ids: [...chain.edit_history_tweet_ids],
    edit_version: editVersion,
    edit_metadata_source: chain.edit_metadata_source,
  };
}

function getIdentityFields(record: TiboEditIdentityRecord | null | undefined): TiboEditIdentityFields {
  return {
    logical_post_id: record?.logical_post_id,
    edit_history_tweet_ids: record?.edit_history_tweet_ids,
    edit_version: record?.edit_version,
    edit_metadata_source: record?.edit_metadata_source,
  };
}

export function createUntrustedTiboEditIdentity(tweetId: string): TiboEditIdentityUpdate {
  return {
    logical_post_id: tweetId,
    edit_history_tweet_ids: [tweetId],
    edit_version: 1,
    edit_metadata_source: "none",
  };
}

export function toTiboEditIdentityFields(
  metadata: Pick<
    TiboEditHistoryMetadata,
    "logicalPostId" | "editHistoryTweetIds" | "editVersion" | "editMetadataSource"
  >,
): TiboEditIdentityUpdate {
  return {
    logical_post_id: metadata.logicalPostId,
    edit_history_tweet_ids: [...metadata.editHistoryTweetIds],
    edit_version: metadata.editVersion,
    edit_metadata_source: metadata.editMetadataSource,
  };
}

/**
 * Validates database identity metadata without inferring an edit relationship.
 * The optional tweet id check makes a row's version position explicit.
 */
export function getTrustedTiboEditIdentity(
  record: TiboEditIdentityRecord | null | undefined,
  tweetId = record?.tweet_id ?? null,
): TiboEditIdentityUpdate | null {
  if (record?.edit_metadata_source !== "x_api") return null;
  if (!isNumericPostId(record.logical_post_id)) return null;
  if (!isValidEditHistoryTweetIds(record.edit_history_tweet_ids)) return null;
  if (record.edit_history_tweet_ids[0] !== record.logical_post_id) return null;
  const editVersion = record.edit_version;
  if (typeof editVersion !== "number" ||
      !Number.isInteger(editVersion) ||
      editVersion < 1 ||
      editVersion > record.edit_history_tweet_ids.length) {
    return null;
  }
  if (tweetId && record.edit_history_tweet_ids[editVersion - 1] !== tweetId) {
    return null;
  }

  return {
    logical_post_id: record.logical_post_id,
    edit_history_tweet_ids: [...record.edit_history_tweet_ids],
    edit_version: editVersion,
    edit_metadata_source: "x_api",
  };
}

export function isTrustedTiboEditIdentity(
  record: TiboEditIdentityRecord | null | undefined,
  tweetId?: string | null,
) {
  return Boolean(getTrustedTiboEditIdentity(record, tweetId ?? undefined));
}

function getIncomingTrustedIdentity(
  identity: TiboEditIdentityFields,
  incomingTweetId: string,
) {
  return getTrustedTiboEditIdentity({
    ...identity,
    tweet_id: incomingTweetId,
  }, incomingTweetId);
}

export function mergeTiboEditIdentity(
  existing: TiboEditIdentityRecord | null | undefined,
  incoming: TiboEditIdentityFields,
  incomingTweetId: string,
): TiboEditIdentityMergeResult {
  const fallback = createUntrustedTiboEditIdentity(incomingTweetId);
  const existingTrusted = getTrustedTiboEditIdentity(existing);
  const incomingTrusted = getIncomingTrustedIdentity(incoming, incomingTweetId);

  if (existing?.edit_metadata_source === "x_api" && !existingTrusted) {
    return {
      status: "conflict",
      // Keep malformed external metadata untouched. The caller must not
      // replace it with an inferred or untrusted identity on a conflict.
      identity: getIdentityFields(existing),
    };
  }

  if (incoming.edit_metadata_source === "x_api" && !incomingTrusted) {
    return {
      status: "conflict",
      identity: existingTrusted ?? fallback,
    };
  }

  if (existingTrusted && incomingTrusted) {
    if (!areCompatibleChains(existingTrusted, incomingTrusted)) {
      return { status: "conflict", identity: existingTrusted };
    }

    const chain = existingTrusted.edit_history_tweet_ids.length >= incomingTrusted.edit_history_tweet_ids.length
      ? existingTrusted
      : incomingTrusted;
    const merged = identityForMember(chain, incomingTweetId) ?? incomingTrusted;
    return {
      status: sameIds(existingTrusted.edit_history_tweet_ids, incomingTrusted.edit_history_tweet_ids)
        ? "preserved"
        : "trusted",
      identity: merged,
    };
  }

  if (existingTrusted) {
    return { status: "preserved", identity: existingTrusted };
  }

  if (incomingTrusted) {
    return { status: "trusted", identity: incomingTrusted };
  }

  return { status: "fallback", identity: fallback };
}

function sameIdentity(
  existing: TiboEditIdentityUpdate | null,
  incoming: TiboEditIdentityUpdate,
) {
  return Boolean(existing) &&
    existing!.logical_post_id === incoming.logical_post_id &&
    sameIds(existing!.edit_history_tweet_ids, incoming.edit_history_tweet_ids) &&
    existing!.edit_version === incoming.edit_version &&
    existing!.edit_metadata_source === incoming.edit_metadata_source;
}

function reconciliationResult(
  status: TiboEditChainReconciliationStatus,
  identity: TiboEditIdentityUpdate,
  updatedTweetIds: string[] = [],
  error?: unknown,
): TiboEditChainReconciliationResult {
  return { status, identity, updatedTweetIds, ...(error === undefined ? {} : { error }) };
}

type StoredTiboEditChainRow = TiboEditIdentityRecord & { tweet_id: string };

type LoadedTiboEditChainState = {
  rows: StoredTiboEditChainRow[];
  targetChain: TiboEditIdentityUpdate;
  targetForIncoming: TiboEditIdentityUpdate;
};

type TiboEditChainLoadResult =
  | { status: "ready"; state: LoadedTiboEditChainState }
  | { status: "conflict" }
  | { status: "error"; error: unknown };

function toPostgrestTextArrayLiteral(ids: readonly string[]) {
  // IDs are validated as numeric before this value reaches the query string.
  return `{${ids.join(",")}}`;
}

async function loadTiboEditChainState(
  store: TiboEditIdentityStore,
  incomingTrusted: TiboEditIdentityUpdate,
  incomingTweetId: string,
): Promise<TiboEditChainLoadResult> {
  let result: { data: unknown[] | null; error: unknown | null };
  try {
    result = await store
      .from("tibo_signals")
      .select(`tweet_id,${TIBO_EDIT_IDENTITY_COLUMNS}`)
      .in("tweet_id", incomingTrusted.edit_history_tweet_ids);
  } catch (error) {
    return { status: "error", error };
  }
  if (result.error) return { status: "error", error: result.error };
  if (result.data !== null && !Array.isArray(result.data)) {
    return {
      status: "error",
      error: new Error("Unexpected edit-chain lookup shape"),
    };
  }

  const rows = (result.data ?? []).filter((row): row is StoredTiboEditChainRow =>
    typeof row === "object" &&
    row !== null &&
    typeof (row as { tweet_id?: unknown }).tweet_id === "string" &&
    incomingTrusted.edit_history_tweet_ids.includes((row as { tweet_id: string }).tweet_id),
  );

  let targetChain = incomingTrusted;
  const trustedRows: Array<{
    row: StoredTiboEditChainRow;
    identity: TiboEditIdentityUpdate;
  }> = [];
  for (const row of rows) {
    if (row.edit_metadata_source !== "x_api") continue;
    const existingTrusted = getTrustedTiboEditIdentity(row, row.tweet_id);
    if (!existingTrusted || !areCompatibleChains(existingTrusted, incomingTrusted)) {
      return { status: "conflict" };
    }
    trustedRows.push({ row, identity: existingTrusted });
    if (existingTrusted.edit_history_tweet_ids.length > targetChain.edit_history_tweet_ids.length) {
      targetChain = existingTrusted;
    }
  }

  for (const trustedRow of trustedRows) {
    if (!areCompatibleChains(trustedRow.identity, targetChain)) {
      return { status: "conflict" };
    }
  }

  const targetForIncoming = identityForMember(targetChain, incomingTweetId);
  if (!targetForIncoming) return { status: "conflict" };

  return {
    status: "ready",
    state: {
      rows,
      targetChain,
      targetForIncoming,
    },
  };
}

function getChainUpdates(
  state: LoadedTiboEditChainState,
): Array<{ row: StoredTiboEditChainRow; identity: TiboEditIdentityUpdate }> | null {
  const updates: Array<{ row: StoredTiboEditChainRow; identity: TiboEditIdentityUpdate }> = [];
  for (const row of state.rows) {
    const identity = identityForMember(state.targetChain, row.tweet_id);
    if (!identity) return null;
    const existingTrusted = getTrustedTiboEditIdentity(row, row.tweet_id);
    if (!sameIdentity(existingTrusted, identity)) updates.push({ row, identity });
  }
  return updates;
}

type TiboEditIdentityUpdateAttempt =
  | { status: "updated" }
  | { status: "stale" }
  | { status: "conflict" }
  | { status: "error"; error: unknown };

async function updateTiboEditIdentityWithCas(
  store: TiboEditIdentityStore,
  row: StoredTiboEditChainRow,
  identity: TiboEditIdentityUpdate,
): Promise<TiboEditIdentityUpdateAttempt> {
  let query = store
    .from("tibo_signals")
    .update(identity)
    .eq("tweet_id", row.tweet_id);

  if (row.edit_metadata_source === "none") {
    query = query.eq("edit_metadata_source", "none");
  } else {
    const existingTrusted = getTrustedTiboEditIdentity(row, row.tweet_id);
    if (!existingTrusted) return { status: "conflict" };
    query = query
      .eq("logical_post_id", existingTrusted.logical_post_id)
      .eq(
        "edit_history_tweet_ids",
        toPostgrestTextArrayLiteral(existingTrusted.edit_history_tweet_ids),
      )
      .eq("edit_version", String(existingTrusted.edit_version))
      .eq("edit_metadata_source", "x_api");
  }

  try {
    const result = await query.select("tweet_id");
    if (result.error) return { status: "error", error: result.error };
    if (!Array.isArray(result.data)) {
      return {
        status: "error",
        error: new Error("Unexpected edit-chain update shape"),
      };
    }
    return result.data.length === 0 ? { status: "stale" } : { status: "updated" };
  } catch (error) {
    return { status: "error", error };
  }
}

/**
 * Reconciles only the four edit-identity columns for already stored chain
 * members. No missing member is inserted and no classification column is
 * included in the update payload.
 */
export async function reconcileTiboEditChainMetadata(
  store: TiboEditIdentityStore,
  incomingTweetId: string,
  incomingIdentity: TiboEditIdentityFields,
): Promise<TiboEditChainReconciliationResult> {
  const incomingTrusted = getIncomingTrustedIdentity(incomingIdentity, incomingTweetId);
  if (!incomingTrusted) {
    return reconciliationResult("skipped", createUntrustedTiboEditIdentity(incomingTweetId));
  }

  let loaded = await loadTiboEditChainState(store, incomingTrusted, incomingTweetId);
  if (loaded.status === "error") {
    return reconciliationResult("error", incomingTrusted, [], loaded.error);
  }
  if (loaded.status === "conflict") {
    return reconciliationResult("conflict", incomingTrusted);
  }

  const updatedTweetIds = new Set<string>();
  for (
    let attempt = 0;
    attempt < MAX_TIBO_EDIT_RECONCILIATION_ATTEMPTS;
    attempt += 1
  ) {
    const updates = getChainUpdates(loaded.state);
    if (!updates) {
      return reconciliationResult(
        "conflict",
        loaded.state.targetForIncoming,
        Array.from(updatedTweetIds),
      );
    }

    let stale = false;
    for (const update of updates) {
      const attemptResult = await updateTiboEditIdentityWithCas(
        store,
        update.row,
        update.identity,
      );
      if (attemptResult.status === "error") {
        return reconciliationResult(
          "error",
          loaded.state.targetForIncoming,
          Array.from(updatedTweetIds),
          attemptResult.error,
        );
      }
      if (attemptResult.status === "conflict") {
        return reconciliationResult(
          "conflict",
          loaded.state.targetForIncoming,
          Array.from(updatedTweetIds),
        );
      }
      if (attemptResult.status === "stale") {
        const refreshed = await loadTiboEditChainState(store, incomingTrusted, incomingTweetId);
        if (refreshed.status === "error") {
          return reconciliationResult(
            "error",
            loaded.state.targetForIncoming,
            Array.from(updatedTweetIds),
            refreshed.error,
          );
        }
        if (refreshed.status === "conflict") {
          return reconciliationResult(
            "conflict",
            loaded.state.targetForIncoming,
            Array.from(updatedTweetIds),
          );
        }
        loaded = refreshed;
        stale = true;
        break;
      }
      updatedTweetIds.add(update.row.tweet_id);
    }

    if (!stale) {
      return reconciliationResult(
        updatedTweetIds.size > 0 ? "reconciled" : "unchanged",
        loaded.state.targetForIncoming,
        Array.from(updatedTweetIds),
      );
    }
  }

  return reconciliationResult(
    "error",
    loaded.state.targetForIncoming,
    Array.from(updatedTweetIds),
    new Error("Edit-chain identity changed concurrently"),
  );
}
