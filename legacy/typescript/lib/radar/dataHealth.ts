import type {
  DataSourceHealth,
  RadarDataHealth,
} from "./types";

export const OK_DATA_SOURCE: DataSourceHealth = { state: "ok" };

export function getRequiredConfigurationHealth(
  values: Array<string | undefined>,
): DataSourceHealth {
  return values.every(Boolean)
    ? OK_DATA_SOURCE
    : { state: "misconfigured", detail: "missing_configuration" };
}

export function getDatabaseReadHealth(
  configuration: DataSourceHealth,
  result: { hasData: boolean; hasError: boolean },
): DataSourceHealth {
  if (configuration.state !== "ok") {
    return configuration;
  }

  if (result.hasError) {
    return { state: "degraded", detail: "database_error" };
  }

  if (!result.hasData) {
    return { state: "degraded", detail: "invalid_response" };
  }

  return OK_DATA_SOURCE;
}

export function combineDataSourceHealth(
  ...sources: Array<DataSourceHealth>
): DataSourceHealth {
  return (
    sources.find((source) => source.state === "misconfigured") ??
    sources.find((source) => source.state === "degraded") ??
    OK_DATA_SOURCE
  );
}

export function createRadarDataHealth(
  checkedAt: string,
  supabaseSignals: DataSourceHealth,
  openAIStatus: DataSourceHealth,
): RadarDataHealth {
  return {
    overall:
      supabaseSignals.state === "ok" && openAIStatus.state === "ok"
        ? "ok"
        : "degraded",
    checkedAt,
    sources: {
      supabaseSignals,
      openAIStatus,
    },
  };
}
