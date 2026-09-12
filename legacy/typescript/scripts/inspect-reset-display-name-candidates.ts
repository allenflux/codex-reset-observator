import { createClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getCanonicalResetHistoryForDisplayNameReconciliation } from "../lib/radar";
import { fetchCurrentRadarData, fetchResetDisplayNameCandidateNoticeSignals } from "../lib/radarFetch";
import {
  collectPersistedAuthoritativeCandidateExecutionEvidence,
  discoverMissingResetDisplayNameCandidateSeeds,
  type ResetDisplayNameCandidateNotice,
} from "../lib/radar/resetDisplayNameReconciliation";
import {
  listResetDisplayNameCandidates,
  type ResetDisplayNameCandidateStoreClient,
} from "../lib/radar/resetDisplayNameCandidateStore";
import {
  isCandidatePromotionAuthorized,
  type ResetDisplayNameCandidateActivation,
  type ResetDisplayNameCandidateRecord,
} from "../lib/radar/resetDisplayNameCandidateTypes";
import { readResetDisplayNameCandidateActivation } from "../lib/radar/resetDisplayNameCandidateActivation";
import {
  buildTiboReadSideProjection,
} from "../lib/radar/tiboLogicalProjection";
import {
  resolveTiboResetEventIdentity,
  type TiboResetEventReference,
} from "../lib/radar/tiboResetEventIdentity";
import type { RadarData, WindowEventLike } from "../lib/radar/types";

export type ResetDisplayNameCandidateShadowReport = {
  eligibleNoticeCount: number;
  existingCandidateCount: number;
  missingSeedCount: number;
  ambiguousIdentityCount: number;
  promotionReadyCount: number;
  geminiCalls: 0;
  writes: 0;
};

export type ResetDisplayNameCandidateShadowInputs = {
  activation: ResetDisplayNameCandidateActivation;
  notices: readonly ResetDisplayNameCandidateNotice[];
  candidates: readonly ResetDisplayNameCandidateRecord[];
  data: RadarData;
  canonicalHistory?: readonly WindowEventLike[];
  now?: Date;
};

function candidateIdentityIds(candidate: ResetDisplayNameCandidateRecord) {
  return [
    candidate.officialNoticeTweetId,
    ...candidate.noticeTweetIds,
    ...candidate.sourceTweetIds,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function noticeIdentityIds(notice: ResetDisplayNameCandidateNotice) {
  return [
    notice.officialNoticeTweetId,
    ...notice.noticeTweetIds,
    ...notice.sourceTweetIds,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function candidateMatchesNotice(
  candidate: ResetDisplayNameCandidateRecord,
  notice: ResetDisplayNameCandidateNotice,
) {
  const candidateIds = new Set(candidateIdentityIds(candidate));
  if (noticeIdentityIds(notice).some((id) => candidateIds.has(id))) return true;
  return notice.logicalPostId !== null && candidate.logicalPostId === notice.logicalPostId;
}

function isAfterAdoption(
  notice: ResetDisplayNameCandidateNotice,
  activation: ResetDisplayNameCandidateActivation,
) {
  if (!activation.adoptionAt) return false;
  const tweetTime = Date.parse(notice.tweetCreatedAt);
  const adoptionTime = Date.parse(activation.adoptionAt);
  return Number.isFinite(tweetTime) && Number.isFinite(adoptionTime) && tweetTime >= adoptionTime;
}

function isEligibleNotice(
  notice: ResetDisplayNameCandidateNotice,
  activation: ResetDisplayNameCandidateActivation,
) {
  return activation.mode !== "off" &&
    Boolean(activation.adoptionAt) &&
    notice.isExecutionBearing &&
    isAfterAdoption(notice, activation);
}

function toResetEventReference(item: WindowEventLike): TiboResetEventReference | null {
  const eventKey = typeof item.id === "string" ? item.id.trim() : "";
  if (!eventKey) return null;
  return {
    eventKey,
    sourceTweetIds: item.sourceTweetIds ?? [],
    sourceUrl: item.source_url ?? null,
  };
}

function findCandidateLogicalPost(
  candidate: ResetDisplayNameCandidateRecord,
  data: RadarData,
) {
  const projection = buildTiboReadSideProjection({
    active_tibo_signals: data.active_tibo_signals,
    recent_tibo_signals: data.recent_tibo_signals,
    formal_tibo_resets: data.formal_tibo_resets,
  });
  const candidateIds = new Set(candidateIdentityIds(candidate));
  return projection.logicalPosts.find((post) =>
    (candidate.logicalPostId !== null && post.logicalPostId === candidate.logicalPostId) ||
    post.sourceTweetIds.some((tweetId) => candidateIds.has(tweetId)),
  ) ?? null;
}

function isPromotionReady(
  candidate: ResetDisplayNameCandidateRecord,
  notices: readonly ResetDisplayNameCandidateNotice[],
  data: RadarData,
  history: readonly WindowEventLike[],
  activation: ResetDisplayNameCandidateActivation,
) {
  if (candidate.lifecycleStatus !== "provisional" || candidate.aiStatus !== "accepted") return false;
  const notice = notices.find((item) => candidateMatchesNotice(candidate, item));
  if (!notice || !isEligibleNotice(notice, activation)) return false;

  const logicalPost = findCandidateLogicalPost(candidate, data);
  if (!logicalPost) return false;

  const resolution = resolveTiboResetEventIdentity(logicalPost, {
    adoptionLedgers: data.tibo_formal_adoptions ?? [],
    estimates: data.reset_execution_estimates ?? [],
    staticHistory: history
      .map(toResetEventReference)
      .filter((reference): reference is TiboResetEventReference => Boolean(reference)),
    sourceTweetIds: candidateIdentityIds(candidate),
  });
  const evidence = collectPersistedAuthoritativeCandidateExecutionEvidence(
    data.tibo_formal_adoptions ?? [],
    data.reset_execution_estimates ?? [],
  );

  return isCandidatePromotionAuthorized(
    {
      status: resolution.status,
      resetEventKey: resolution.resetEventKey,
      matchedEvidenceEventKey: resolution.matchedEvidence?.resetEventKey ?? null,
    },
    evidence,
  );
}

export function inspectResetDisplayNameCandidatesFromInputs(
  input: ResetDisplayNameCandidateShadowInputs,
): ResetDisplayNameCandidateShadowReport {
  if (input.activation.mode === "off" || !input.activation.adoptionAt) {
    return {
      eligibleNoticeCount: 0,
      existingCandidateCount: 0,
      missingSeedCount: 0,
      ambiguousIdentityCount: 0,
      promotionReadyCount: 0,
      geminiCalls: 0,
      writes: 0,
    };
  }

  const eligibleNotices = input.notices.filter((notice) =>
    isEligibleNotice(notice, input.activation),
  );
  const missingSeeds = discoverMissingResetDisplayNameCandidateSeeds(
    eligibleNotices,
    input.candidates,
    input.activation,
  );
  const ambiguousIdentityCount = eligibleNotices.filter((notice) =>
    input.candidates.filter((candidate) => candidateMatchesNotice(candidate, notice)).length > 1,
  ).length;
  const history = input.canonicalHistory ?? getCanonicalResetHistoryForDisplayNameReconciliation(input.data);
  const promotionReadyCount = input.candidates.filter((candidate) =>
    isPromotionReady(candidate, eligibleNotices, input.data, history, input.activation),
  ).length;

  return {
    eligibleNoticeCount: eligibleNotices.length,
    existingCandidateCount: input.candidates.length,
    missingSeedCount: missingSeeds.length,
    ambiguousIdentityCount,
    promotionReadyCount,
    geminiCalls: 0,
    writes: 0,
  };
}

function getReadOnlyCandidateStoreClient() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("candidate shadow inspection requires Supabase read configuration");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  }) as unknown as ResetDisplayNameCandidateStoreClient;
}

export async function inspectResetDisplayNameCandidates(): Promise<ResetDisplayNameCandidateShadowReport> {
  const activation = readResetDisplayNameCandidateActivation(process.env);
  const data = await fetchCurrentRadarData({
    bypassCache: true,
  });

  if (activation.mode === "off" || !activation.adoptionAt) {
    return inspectResetDisplayNameCandidatesFromInputs({
      activation,
      notices: [],
      candidates: [],
      data,
    });
  }

  const candidateStore = getReadOnlyCandidateStoreClient();
  const [notices, candidates] = await Promise.all([
    fetchResetDisplayNameCandidateNoticeSignals(activation),
    listResetDisplayNameCandidates(candidateStore),
  ]);
  return inspectResetDisplayNameCandidatesFromInputs({
    activation,
    notices,
    candidates,
    data,
  });
}

const invokedPath = process.argv[1];
const invokedAsScript = invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url;

if (invokedAsScript) {
  inspectResetDisplayNameCandidates()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch(() => {
      process.stderr.write("reset display name candidate shadow inspection failed\n");
      process.exitCode = 1;
    });
}
