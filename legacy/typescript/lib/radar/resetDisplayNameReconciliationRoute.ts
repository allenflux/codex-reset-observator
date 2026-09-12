import { revalidateTag } from "next/cache";

import { isBearerAuthorizationValid } from "../security/bearerAuth";
import {
  reconcileResetDisplayNames,
  type ResetDisplayNameReconciliationOptions,
  type ResetDisplayNameReconciliationResult,
} from "./resetDisplayNameReconciliation";
import { readResetDisplayNameCandidateActivation } from "./resetDisplayNameCandidateActivation";

const MAX_GEMINI_REQUESTS = 3;
export const RESET_DISPLAY_NAME_RECONCILER_ADOPTION_AT = "2026-09-04T09:30:00.000Z";

type InvalidateRadarData = () => void | Promise<void>;

export type ResetDisplayNameReconcileRunner = (
  options: ResetDisplayNameReconciliationOptions,
) => Promise<ResetDisplayNameReconciliationResult>;

export function getResetDisplayNameReconciliationOptions(
  invalidateRadarData: InvalidateRadarData = () => revalidateTag("radar-data"),
): ResetDisplayNameReconciliationOptions {
  return {
    dryRun: false,
    maxGeminiRequests: MAX_GEMINI_REQUESTS,
    adoptionAt: new Date(RESET_DISPLAY_NAME_RECONCILER_ADOPTION_AT),
    candidateActivation: readResetDisplayNameCandidateActivation(process.env),
    invalidateRadarData,
  };
}

export function toSafeResetDisplayNameReconciliationResponse(
  result: ResetDisplayNameReconciliationResult,
) {
  const statusSummary: Record<string, number> = {};
  for (const outcome of result.outcomes) {
    statusSummary[outcome.status] = (statusSummary[outcome.status] ?? 0) + 1;
  }

  return {
    status: "completed",
    scanned: result.scanned,
    candidates: result.candidates,
    attempted: result.attempted,
    geminiRequests: result.geminiRequests,
    writes: result.writes,
    invalidated: result.invalidated,
    statusSummary: Object.fromEntries(
      Object.entries(statusSummary).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function response(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Type": "application/json",
    },
  });
}

export function createReconcileResetDisplayNamesHandler(
  runner: ResetDisplayNameReconcileRunner = reconcileResetDisplayNames,
  invalidateRadarData: InvalidateRadarData = () => revalidateTag("radar-data"),
) {
  return async function post(request: Request) {
    const expectedSecret = process.env.CRON_SECRET?.trim();
    if (!expectedSecret) {
      return response({ error: "configuration_unavailable" }, 503);
    }

    if (!isBearerAuthorizationValid(request.headers.get("authorization"), expectedSecret)) {
      return response({ error: "Unauthorized" }, 401);
    }

    try {
      const result = await runner(
        getResetDisplayNameReconciliationOptions(invalidateRadarData),
      );
      return response(toSafeResetDisplayNameReconciliationResponse(result), 200);
    } catch {
      return response({ status: "error", error: "reconciliation_failed" }, 500);
    }
  };
}
