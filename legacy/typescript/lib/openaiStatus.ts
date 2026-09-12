import { LOCAL_OPENAI_STATUS_HISTORY } from "@/data/statusHistory";
import type {
  CodexOperationalStatus,
  DataFetchResult,
  DataSourceDetail,
} from "@/lib/radar/types";

const OPENAI_STATUS_SUMMARY_URL =
  "https://status.openai.com/api/v2/summary.json";
const OPENAI_STATUS_INCIDENTS_URL =
  "https://status.openai.com/api/v2/incidents.json";

const FETCH_TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_RECOVERY_WINDOW_MS = 12 * 60 * 60 * 1000;
const STATUS_INCIDENT_URL_BASE = "https://status.openai.com/incidents";

type StatuspageComponent = {
  id?: string;
  name?: string;
  status?: string;
  updated_at?: string;
};

type StatuspageIncident = {
  id?: string;
  name?: string;
  status?: string;
  impact?: string;
  created_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
  incident_updates?: Array<{
    body?: string;
    status?: string;
    created_at?: string;
    updated_at?: string;
  }>;
};

type StatusSummaryResponse = {
  page?: {
    updated_at?: string;
  };
  status?: {
    indicator?: string;
  };
  components?: Array<StatuspageComponent>;
};

type StatusIncidentsResponse = {
  page?: {
    updated_at?: string;
  };
  incidents?: Array<StatuspageIncident>;
};

export type OpenAIStatusSignals = {
  updatedAt: string | null;
  statusIncidents24h: number;
  activeCodexIncidents: number;
  recentCodexIncidents: number;
  affectedCodexComponents: number;
  suppressCodexIncidents: boolean;
  codexOperationalStatus: CodexOperationalStatus;
  latestCodexIncidentName: string | null;
  history: Array<OpenAIStatusHistoryItem>;
};

export type OpenAIStatusHistoryItem = {
  id: string;
  title: string;
  status: string;
  impact: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  source: "openai_status";
  url: string;
};

type FetchOptions = {
  cache?: RequestCache;
  revalidate?: number;
};

export async function fetchOpenAIStatusSignals(
  options: FetchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DataFetchResult<OpenAIStatusSignals>> {
  const [summaryResult, incidentsResult] = await Promise.allSettled([
    fetchStatusJson<StatusSummaryResponse>(
      OPENAI_STATUS_SUMMARY_URL,
      options,
      fetchImpl,
      isStatusSummaryResponse,
    ),
    fetchStatusJson<StatusIncidentsResponse>(
      OPENAI_STATUS_INCIDENTS_URL,
      options,
      fetchImpl,
      isStatusIncidentsResponse,
    ),
  ]);

  const summary = summaryResult.status === "fulfilled" ? summaryResult.value : {
    data: null,
    failure: "request_failed" as const,
  };
  const incidents = incidentsResult.status === "fulfilled" ? incidentsResult.value : {
    data: null,
    failure: "request_failed" as const,
  };

  if (!summary.data && !incidents.data) {
    return {
      data: getStoredStatusSignals(),
      health: {
        state: "degraded",
        detail: getStatusFailureDetail(summary.failure, incidents.failure),
      },
    };
  }

  const codexComponents =
    summary.data?.components?.filter((component) => isCodexText(component.name)) ??
    [];
  const hasCodexComponentData = codexComponents.length > 0;
  const affectedCodexComponents = codexComponents.filter(
    (component) =>
      component.status && component.status !== "operational",
  ).length;
  // Codex コンポーネント（Codex Web / Codex API 等）がすべて operational の場合は
  // インシデント文言による誤検知を防ぐためインシデント警告を抑制する
  const allCodexComponentsOperational =
    hasCodexComponentData && affectedCodexComponents === 0;

  const codexIncidents =
    incidents.data?.incidents?.filter((incident) => isCodexIncident(incident)) ?? [];
  const activeCodexIncidents = codexIncidents.filter(
    (incident) => !isResolvedIncident(incident),
  );
  const recentCodexIncidents = codexIncidents.filter((incident) =>
    isRecentIncident(incident),
  );
  const codexOperationalStatus = getCodexOperationalStatus({
    codexComponents,
    codexIncidents,
    incidentsAvailable: Boolean(incidents.data),
    summaryAvailable: Boolean(summary.data),
  });
  const incidentIds = new Set<string>();

  for (const incident of [...activeCodexIncidents, ...recentCodexIncidents]) {
    incidentIds.add(incident.id ?? incident.name ?? "");
  }

  incidentIds.delete("");

  const latestCodexIncident = [...codexIncidents].sort(
    (a, b) => getIncidentTime(b) - getIncidentTime(a),
  )[0];
  const history = mergeStatusHistory(
    codexIncidents.map(normalizeStatusIncident),
  );
  const updatedAt = getLatestIsoDate([
    summary.data?.page?.updated_at,
    incidents.data?.page?.updated_at,
    latestCodexIncident?.updated_at,
    latestCodexIncident?.resolved_at,
    latestCodexIncident?.created_at,
  ]);

  return {
    data: {
      updatedAt,
      // コンポーネントが全部正常なら incidents は 0 扱い（誤検知防止）
      statusIncidents24h: allCodexComponentsOperational
        ? 0
        : incidentIds.size + affectedCodexComponents,
      activeCodexIncidents: allCodexComponentsOperational
        ? 0
        : activeCodexIncidents.length,
      recentCodexIncidents: recentCodexIncidents.length,
      affectedCodexComponents,
      suppressCodexIncidents: allCodexComponentsOperational,
      codexOperationalStatus,
      latestCodexIncidentName: latestCodexIncident?.name ?? null,
      history,
    },
    health:
      summary.data && incidents.data
        ? { state: "ok" }
        : { state: "degraded", detail: "partial_response" },
  };
}

function getStoredStatusSignals(): OpenAIStatusSignals {
  const latestStoredIncident = LOCAL_OPENAI_STATUS_HISTORY[0];

  return {
    updatedAt:
      getLatestIsoDate(
        LOCAL_OPENAI_STATUS_HISTORY.flatMap((item) => [
          item.updatedAt,
          item.resolvedAt,
          item.createdAt,
        ]),
      ) ?? null,
    statusIncidents24h: 0,
    activeCodexIncidents: 0,
    recentCodexIncidents: 0,
    affectedCodexComponents: 0,
    suppressCodexIncidents: false,
    codexOperationalStatus: "unknown",
    latestCodexIncidentName: latestStoredIncident?.title ?? null,
    history: LOCAL_OPENAI_STATUS_HISTORY,
  };
}

type StatusFetchResult<T> = {
  data: T | null;
  failure?: Extract<DataSourceDetail, "request_failed" | "invalid_response">;
};

async function fetchStatusJson<T>(
  url: string,
  options: FetchOptions,
  fetchImpl: typeof fetch,
  isValidResponse: (value: unknown) => value is T,
): Promise<StatusFetchResult<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
        },
        cache: options.cache,
        next:
          typeof options.revalidate === "number"
            ? { revalidate: options.revalidate }
            : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      console.error(`OpenAI Status request failed for ${url}`, error);
      return { data: null, failure: "request_failed" };
    }

    if (!response.ok) {
      console.error(
        `OpenAI Status request returned ${response.status} for ${url}`,
      );
      return { data: null, failure: "request_failed" };
    }

    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      console.error(`OpenAI Status returned non-JSON content for ${url}`);
      return { data: null, failure: "invalid_response" };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      console.error(`OpenAI Status returned malformed JSON for ${url}`, error);
      return { data: null, failure: "invalid_response" };
    }

    if (!isValidResponse(data)) {
      console.error(`OpenAI Status returned malformed data for ${url}`);
      return { data: null, failure: "invalid_response" };
    }

    return { data };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getStatusFailureDetail(
  ...failures: Array<StatusFetchResult<unknown>["failure"]>
): Extract<DataSourceDetail, "request_failed" | "invalid_response"> {
  return failures.includes("invalid_response")
    ? "invalid_response"
    : "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStatusSummaryResponse(value: unknown): value is StatusSummaryResponse {
  return (
    isRecord(value) &&
    isRecord(value.page) &&
    (value.status === undefined || isRecord(value.status)) &&
    Array.isArray(value.components) &&
    value.components.every(isRecord)
  );
}

function isStatusIncidentsResponse(value: unknown): value is StatusIncidentsResponse {
  return (
    isRecord(value) &&
    isRecord(value.page) &&
    Array.isArray(value.incidents) &&
    value.incidents.every(isStatusIncident)
  );
}

function isStatusIncident(value: unknown): value is StatuspageIncident {
  return (
    isRecord(value) &&
    (value.incident_updates === undefined ||
      (Array.isArray(value.incident_updates) &&
        value.incident_updates.every(isRecord)))
  );
}

function isCodexIncident(incident: StatuspageIncident) {
  const text = [
    incident.name,
    incident.impact,
    incident.status,
    ...(incident.incident_updates ?? []).flatMap((update) => [
      update.body,
      update.status,
    ]),
  ]
    .filter(Boolean)
    .join(" ");

  if (!isCodexText(text)) return false;

  // FedRAMP ワークスペース限定の障害は一般ユーザー向け Codex に影響しないため除外する
  const isFedRAMPOnly = /\bFedRAMP\b/i.test(text) && (
    /\bin FedRAMP workspaces?\b/i.test(text) ||
    /\bFedRAMP (environment|workspace|tenant)/i.test(text)
  );
  if (isFedRAMPOnly) return false;

  return true;
}

function getCodexOperationalStatus({
  codexComponents,
  codexIncidents,
  incidentsAvailable,
  summaryAvailable,
  now = new Date(),
}: {
  codexComponents: Array<StatuspageComponent>;
  codexIncidents: Array<StatuspageIncident>;
  incidentsAvailable: boolean;
  summaryAvailable: boolean;
  now?: Date;
}): CodexOperationalStatus {
  const hasAffectedComponent = codexComponents.some(
    (component) => component.status && component.status !== "operational",
  );
  if (hasAffectedComponent) {
    return "active";
  }

  if (codexIncidents.some((incident) => !isResolvedIncident(incident))) {
    return "active";
  }

  const hasRecentResolution = codexIncidents.some((incident) => {
    const resolvedAt = getDateTime(incident.resolved_at);
    if (resolvedAt === 0) return false;

    const elapsed = now.getTime() - resolvedAt;
    return elapsed >= 0 && elapsed < CODEX_RECOVERY_WINDOW_MS;
  });
  if (hasRecentResolution) {
    return "recovered";
  }

  return incidentsAvailable && summaryAvailable ? "none" : "unknown";
}

function normalizeStatusIncident(
  incident: StatuspageIncident,
): OpenAIStatusHistoryItem {
  const id = incident.id ?? `openai-status-${incident.name ?? "unknown"}`;

  return {
    id,
    title: incident.name ?? "OpenAI Status incident",
    status: incident.status ?? "unknown",
    impact: incident.impact ?? null,
    createdAt: incident.created_at ?? null,
    updatedAt: incident.updated_at ?? null,
    resolvedAt: incident.resolved_at ?? null,
    source: "openai_status",
    url: `${STATUS_INCIDENT_URL_BASE}/${id}`,
  };
}

function mergeStatusHistory(
  fetchedHistory: Array<OpenAIStatusHistoryItem>,
) {
  const items = [...fetchedHistory, ...LOCAL_OPENAI_STATUS_HISTORY];
  const seen = new Set<string>();

  return items
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }

      seen.add(item.id);
      return true;
    })
    .sort((a, b) => getDateTime(b.createdAt) - getDateTime(a.createdAt));
}

function isCodexText(value: string | null | undefined) {
  return Boolean(value && /\bcodex\b/i.test(value));
}

function isResolvedIncident(incident: StatuspageIncident) {
  return Boolean(incident.resolved_at) || incident.status === "resolved";
}

function isRecentIncident(incident: StatuspageIncident) {
  const elapsed = Date.now() - getIncidentTime(incident);
  return elapsed >= 0 && elapsed <= DAY_MS;
}

function getIncidentTime(incident: StatuspageIncident) {
  return Math.max(
    getDateTime(incident.updated_at),
    getDateTime(incident.resolved_at),
    getDateTime(incident.created_at),
  );
}

function getLatestIsoDate(values: Array<string | null | undefined>) {
  const latest = values
    .map((value) => (value ? new Date(value) : null))
    .filter(
      (value): value is Date =>
        Boolean(value && !Number.isNaN(value.getTime())),
    )
    .sort((a, b) => b.getTime() - a.getTime())
    .at(0);

  return latest?.toISOString() ?? null;
}

function getDateTime(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
