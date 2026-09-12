import type { OpenAIStatusHistoryItem } from "@/lib/openaiStatus";
import type { Locale } from "./types";

export type StatusIncidentEvaluation = {
  observedIncidentCount: number;
  activeStatusIncidentCount: number;
  recentResolvedIncidentCount: number;
  includedIncidentCount: number;
  excludedPreResetIncidentCount: number;
  excludedStaleOrInvalidIncidentCount: number;
  suppressedIncidentCount: number;
  affectedCodexComponentCount: number;
  weightedStatusScore: number;
};

export type ComplaintPressureLevel = "low" | "medium" | "high";
export type ComplaintPressureSource =
  | "community_mentions"
  | "issue_anomalies";
export type ComplaintPressureEvaluation = {
  level: ComplaintPressureLevel;
  sources: Array<ComplaintPressureSource>;
};

type LocalStatusIncident = {
  id: string;
  impact?: string | null;
};

export function evaluateStatusIncidents(input: {
  incidents: Array<OpenAIStatusHistoryItem>;
  latestResetAt: Date | null;
  now: Date;
  suppressOpenAIIncidents: boolean;
  affectedCodexComponents: number;
  maxWeightedScore: number;
  localIncidents?: Array<LocalStatusIncident>;
}): StatusIncidentEvaluation {
  const latestResetTime = getValidTime(input.latestResetAt);
  const nowTime = getValidTime(input.now);
  const includedIncidents = new Map<string, string | null>();
  let activeStatusIncidentCount = 0;
  let recentResolvedIncidentCount = 0;
  let excludedPreResetIncidentCount = 0;
  let excludedStaleOrInvalidIncidentCount = 0;
  let suppressedIncidentCount = 0;

  for (const incident of input.incidents) {
    if (input.suppressOpenAIIncidents) {
      suppressedIncidentCount += 1;
      continue;
    }

    if (!isResolvedIncident(incident)) {
      const activeIncidentTime =
        getValidTime(incident.updatedAt) || getValidTime(incident.createdAt);
      if (activeIncidentTime && nowTime && activeIncidentTime > nowTime) {
        excludedStaleOrInvalidIncidentCount += 1;
        continue;
      }

      activeStatusIncidentCount += 1;
      includedIncidents.set(incident.id, incident.impact);
      continue;
    }

    const resolvedTime = getResolvedIncidentTime(incident);
    if (!resolvedTime) {
      excludedStaleOrInvalidIncidentCount += 1;
      continue;
    }

    if (latestResetTime && resolvedTime <= latestResetTime) {
      excludedPreResetIncidentCount += 1;
      continue;
    }

    if (!nowTime || resolvedTime > nowTime || nowTime - resolvedTime > 24 * 60 * 60 * 1000) {
      excludedStaleOrInvalidIncidentCount += 1;
      continue;
    }

    recentResolvedIncidentCount += 1;
    includedIncidents.set(incident.id, incident.impact);
  }

  for (const incident of input.localIncidents ?? []) {
    if (!includedIncidents.has(incident.id)) {
      includedIncidents.set(incident.id, incident.impact ?? "minor");
    }
  }

  const affectedCodexComponentCount = input.suppressOpenAIIncidents
    ? 0
    : Math.max(0, input.affectedCodexComponents);
  const incidentScore = Array.from(includedIncidents.values()).reduce(
    (sum, impact) => sum + getImpactWeight(impact),
    0,
  );
  const weightedStatusScore = Math.min(
    input.maxWeightedScore,
    Math.max(0, incidentScore + affectedCodexComponentCount),
  );

  return {
    observedIncidentCount: input.incidents.length,
    activeStatusIncidentCount,
    recentResolvedIncidentCount,
    includedIncidentCount: includedIncidents.size,
    excludedPreResetIncidentCount,
    excludedStaleOrInvalidIncidentCount,
    suppressedIncidentCount,
    affectedCodexComponentCount,
    weightedStatusScore,
  };
}

export function deriveComplaintPressure(input: {
  communityMentions: number;
  issueAnomalies: number;
  activeStatusIncidents?: number;
  statusIncidents?: number;
  officialIncidentHints?: number;
}): ComplaintPressureEvaluation {
  const sources: Array<ComplaintPressureSource> = [];

  if (input.communityMentions >= 10) {
    sources.push("community_mentions");
  }
  if (input.issueAnomalies >= 3) {
    sources.push("issue_anomalies");
  }

  return {
    level: sources.length > 0 ? "medium" : "low",
    sources,
  };
}

export function formatStatusIncidentReason(
  evaluation: StatusIncidentEvaluation,
  locale: Locale,
) {
  const activeCount = evaluation.activeStatusIncidentCount;
  const affectedComponentCount = evaluation.affectedCodexComponentCount;

  if (activeCount > 0) {
    if (locale === "en") {
      const componentText = affectedComponentCount > 0
        ? ` ${affectedComponentCount} Codex-related ${affectedComponentCount === 1 ? "component is" : "components are"} also affected.`
        : "";
      return `The official status page shows ${activeCount} active Codex-related ${activeCount === 1 ? "incident" : "incidents"}.${componentText}`;
    }
    if (locale === "zh") {
      const componentText = affectedComponentCount > 0
        ? `，另有 ${affectedComponentCount} 个 Codex 相关组件受到影响`
        : "";
      return `官方状态页显示 ${activeCount} 个正在发生的 Codex 相关故障${componentText}。`;
    }
    const componentText = affectedComponentCount > 0
      ? `、影響中のCodex関連コンポーネントが${affectedComponentCount}件あります`
      : "あります";
    return `公式ステータスで発生中のCodex関連障害が${activeCount}件${componentText}。`;
  }

  if (affectedComponentCount > 0) {
    if (locale === "en") {
      return `The official status page shows ${affectedComponentCount} affected Codex-related ${affectedComponentCount === 1 ? "component" : "components"}.`;
    }
    if (locale === "zh") {
      return `官方状态页显示 ${affectedComponentCount} 个 Codex 相关组件受到影响。`;
    }
    return `公式ステータスで影響中のCodex関連コンポーネントが${affectedComponentCount}件あります。`;
  }

  if (evaluation.recentResolvedIncidentCount > 0) {
    if (locale === "en") {
      return "No incidents are currently active, but a recent incident resolved after the latest reset is included with limited weight.";
    }
    if (locale === "zh") {
      return "目前没有正在发生的故障，但已有限度地计入最近一次重置后解决的近期故障。";
    }
    return "現在発生中の障害はありませんが、最新リセット後に解決された直近の障害を限定的に加味しています。";
  }

  if (locale === "en") {
    return "No active incidents are currently listed on the official status page.";
  }
  if (locale === "zh") {
    return "官方状态页目前未显示进行中的故障。";
  }
  return "公式ステータスに発生中の障害はありません。";
}

function isResolvedIncident(incident: OpenAIStatusHistoryItem) {
  return incident.status.toLowerCase() === "resolved" || Boolean(incident.resolvedAt);
}

function getResolvedIncidentTime(incident: OpenAIStatusHistoryItem) {
  return (
    getValidTime(incident.resolvedAt) ||
    getValidTime(incident.updatedAt) ||
    getValidTime(incident.createdAt)
  );
}

function getValidTime(value: Date | string | null | undefined) {
  if (!value) {
    return 0;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getImpactWeight(impact: string | null | undefined) {
  switch (impact?.toLowerCase()) {
    case "critical":
      return 3;
    case "major":
      return 2;
    default:
      return 1;
  }
}
