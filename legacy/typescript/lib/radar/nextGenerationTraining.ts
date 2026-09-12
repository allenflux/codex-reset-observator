import {
  LOCAL_RESET_HISTORY,
} from "@/data/resetHistory";
import {
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_B_MODEL_VERSION,
  NEXT_GENERATION_C_FREEZE_AT,
  NEXT_GENERATION_C_MODEL_VERSION,
  NEXT_GENERATION_C_V2_FREEZE_AT,
  NEXT_GENERATION_C_V2_MODEL_VERSION,
  NEXT_GENERATION_FREEZE_AT,
} from "@/data/shadowProbabilityConfig";
import { getActualWithinHorizon } from "./prequentialCalibration";
import type { ShadowResetEvent } from "./shadowProbability";
import {
  getRecoveryResetEvents,
} from "./recoveryBoundary";
import type { RadarData, WindowEventLike } from "./types";
import type { NextGenerationCalibrationRow } from "./nextGenerationProbability";
import type {
  NextGenerationComponentForecast,
  NextGenerationEnsembleTrainingRow,
} from "./nextGenerationEnsemble";
import type { ContextualBurstCalibrationRow } from "./contextualBurstProbability";

const HOUR_MS = 60 * 60 * 1000;

const TRAINING_PROJECTION_ROOT = "debug_info->experimentalProbabilityForecasts";
const B_TRAINING_PROJECTION_FIELDS = [
  "modelVersion",
  "generatedAt",
  "rawProbability24h",
  "rawProbability48h",
  "probability24h",
  "probability48h",
] as const;
const A_TRAINING_PROJECTION_FIELDS = [
  "modelVersion",
  "generatedAt",
  "probability24h",
  "probability48h",
] as const;
const C_TRAINING_PROJECTION_FIELDS = [
  "modelVersion",
  "generatedAt",
  "rawProbability24h",
  "rawProbability48h",
] as const;

function trainingProjectionField(
  alias: string,
  modelVersion: string,
  field: string,
) {
  return `${alias}:${TRAINING_PROJECTION_ROOT}->${modelVersion}->${field}`;
}

function trainingProjectionAlias(prefix: string, field: string) {
  const snakeCaseField = field
    .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .replace(/\d+/g, (digits) => `_${digits}`);
  return `${prefix}_${snakeCaseField}`;
}

function buildTrainingProjectionSelectFields() {
  const fields = ["logged_hour"];
  for (const field of B_TRAINING_PROJECTION_FIELDS) {
    fields.push(
      trainingProjectionField(
        trainingProjectionAlias("b", field),
        NEXT_GENERATION_B_MODEL_VERSION,
        field,
      ),
    );
  }
  for (let index = 0; index < NEXT_GENERATION_A_COMPONENT_VERSIONS.length; index += 1) {
    const modelVersion = NEXT_GENERATION_A_COMPONENT_VERSIONS[index];
    // B is already projected above with both its raw and ensemble fields.
    if (modelVersion === NEXT_GENERATION_B_MODEL_VERSION) continue;
    for (const field of A_TRAINING_PROJECTION_FIELDS) {
      fields.push(
        trainingProjectionField(
          trainingProjectionAlias(`a_${index}`, field),
          modelVersion,
          field,
        ),
      );
    }
  }
  for (const field of C_TRAINING_PROJECTION_FIELDS) {
    fields.push(
      trainingProjectionField(
        trainingProjectionAlias("c", field),
        NEXT_GENERATION_C_MODEL_VERSION,
        field,
      ),
    );
  }
  for (const field of C_TRAINING_PROJECTION_FIELDS) {
    fields.push(
      trainingProjectionField(
        trainingProjectionAlias("c_v2", field),
        NEXT_GENERATION_C_V2_MODEL_VERSION,
        field,
      ),
    );
  }
  return fields.join(",");
}

export const NEXT_GENERATION_TRAINING_SELECT_FIELDS = buildTrainingProjectionSelectFields();

function getLoggedHourQueryStart() {
  const freezeTime = timestamp(NEXT_GENERATION_FREEZE_AT)!;
  return new Date(Math.floor(freezeTime / HOUR_MS) * HOUR_MS).toISOString();
}

export type NextGenerationTrainingHistoryRow = {
  logged_hour?: string | null;
  debug_info?: unknown;
};

export type NextGenerationTrainingProjectionRow = {
  logged_hour?: string | null;
  [field: string]: unknown;
};

export type NextGenerationTrainingSkipReasons = {
  pre_freeze: number;
  missing_b_forecast: number;
  invalid_b_forecast: number;
  incomplete_a_components: number;
  invalid_generated_at: number;
};

export type NextGenerationTrainingRows = {
  bRows: Array<NextGenerationCalibrationRow>;
  aRows: Array<NextGenerationEnsembleTrainingRow>;
  cRows: Array<ContextualBurstCalibrationRow>;
  cV2Rows: Array<ContextualBurstCalibrationRow>;
  totalRows: number;
  skipReasons: NextGenerationTrainingSkipReasons;
  backfill: false;
};

export type NextGenerationTrainingState = NextGenerationTrainingRows & {
  status: "ok" | "error";
  reason: string | null;
};

export type NextGenerationTrainingQueryOptions = {
  asOf: Date;
  randomEvents: Array<ShadowResetEvent>;
};

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseDebugInfo(value: unknown) {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function isStoredAt(value: unknown, generatedAt: string) {
  return typeof value === "string"
    && timestamp(value) === timestamp(generatedAt);
}

function createSkipReasons(): NextGenerationTrainingSkipReasons {
  return {
    pre_freeze: 0,
    missing_b_forecast: 0,
    invalid_b_forecast: 0,
    incomplete_a_components: 0,
    invalid_generated_at: 0,
  };
}

function getActualLabel(
  randomEvents: Array<ShadowResetEvent>,
  generatedAt: string,
  asOfTime: number,
  horizonHours: 24 | 48,
) {
  const generatedTime = timestamp(generatedAt);
  if (generatedTime === null || generatedTime + horizonHours * HOUR_MS > asOfTime) {
    return undefined;
  }
  return getActualWithinHorizon(randomEvents, generatedAt, horizonHours);
}

function maybePushContextualBurstRow(
  forecasts: Record<string, unknown> | null,
  options: NextGenerationTrainingQueryOptions,
  asOfTime: number,
  output: Array<ContextualBurstCalibrationRow>,
  modelVersion: string,
  freezeAt: string,
) {
  const cForecast = asRecord(forecasts?.[modelVersion]);
  if (!cForecast || cForecast.modelVersion !== modelVersion) return;
  const generatedAt = typeof cForecast.generatedAt === "string" ? cForecast.generatedAt : null;
  const generatedTime = timestamp(generatedAt);
  if (
    generatedAt === null
    || generatedTime === null
    || generatedTime < timestamp(freezeAt)!
    || generatedTime >= asOfTime
    || !isProbability(cForecast.rawProbability24h)
    || !isProbability(cForecast.rawProbability48h)
  ) return;

  output.push({
    generatedAt,
    modelVersion,
    rawProbability24h: cForecast.rawProbability24h,
    rawProbability48h: cForecast.rawProbability48h,
    actual24h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 24),
    actual48h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 48),
  });
}

export function parseNextGenerationTrainingRows(
  rows: Array<NextGenerationTrainingHistoryRow>,
  options: NextGenerationTrainingQueryOptions,
): NextGenerationTrainingRows {
  const asOfTime = options.asOf.getTime();
  const freezeTime = timestamp(NEXT_GENERATION_FREEZE_AT)!;
  const bRows: Array<NextGenerationCalibrationRow> = [];
  const aRows: Array<NextGenerationEnsembleTrainingRow> = [];
  const cRows: Array<ContextualBurstCalibrationRow> = [];
  const cV2Rows: Array<ContextualBurstCalibrationRow> = [];
  const skipReasons = createSkipReasons();

  for (const row of rows) {
    const debugInfo = parseDebugInfo(row.debug_info);
    const forecasts = asRecord(debugInfo?.experimentalProbabilityForecasts);

    // C has its own freeze/version contract and must not depend on B/A presence.
    if (Number.isFinite(asOfTime)) {
      maybePushContextualBurstRow(
        forecasts,
        options,
        asOfTime,
        cRows,
        NEXT_GENERATION_C_MODEL_VERSION,
        NEXT_GENERATION_C_FREEZE_AT,
      );
      maybePushContextualBurstRow(
        forecasts,
        options,
        asOfTime,
        cV2Rows,
        NEXT_GENERATION_C_V2_MODEL_VERSION,
        NEXT_GENERATION_C_V2_FREEZE_AT,
      );
    }

    const bForecast = asRecord(forecasts?.[NEXT_GENERATION_B_MODEL_VERSION]);
    const generatedAt = typeof bForecast?.generatedAt === "string"
      ? bForecast.generatedAt
      : null;
    const generatedTime = timestamp(generatedAt);

    if (generatedAt === null || generatedTime === null || !Number.isFinite(asOfTime)) {
      skipReasons.invalid_generated_at += 1;
      continue;
    }
    if (generatedTime < freezeTime) {
      skipReasons.pre_freeze += 1;
      continue;
    }
    if (generatedTime >= asOfTime) continue;
    if (!bForecast) {
      skipReasons.missing_b_forecast += 1;
      continue;
    }
    if (
      bForecast.modelVersion !== NEXT_GENERATION_B_MODEL_VERSION
      || !isProbability(bForecast.rawProbability24h)
      || !isProbability(bForecast.rawProbability48h)
    ) {
      skipReasons.invalid_b_forecast += 1;
      continue;
    }

    bRows.push({
      generatedAt,
      modelVersion: NEXT_GENERATION_B_MODEL_VERSION,
      rawProbability24h: bForecast.rawProbability24h,
      rawProbability48h: bForecast.rawProbability48h,
      actual24h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 24),
      actual48h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 48),
    });

    const components: Record<string, NextGenerationComponentForecast> = {};
    let complete = true;
    for (const modelVersion of NEXT_GENERATION_A_COMPONENT_VERSIONS) {
      const component = asRecord(forecasts?.[modelVersion]);
      if (
        !component
        || component.modelVersion !== modelVersion
        || !isStoredAt(component.generatedAt, generatedAt)
        || !isProbability(component.probability24h)
        || !isProbability(component.probability48h)
      ) {
        complete = false;
        break;
      }
      components[modelVersion] = {
        modelVersion,
        probability24h: component.probability24h,
        probability48h: component.probability48h,
      };
    }
    if (!complete) {
      skipReasons.incomplete_a_components += 1;
      continue;
    }
    aRows.push({
      generatedAt,
      components,
      actual24h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 24),
      actual48h: getActualLabel(options.randomEvents, generatedAt, asOfTime, 48),
    });
  }

  return {
    bRows,
    aRows,
    cRows,
    cV2Rows,
    totalRows: rows.length,
    skipReasons,
    backfill: false,
  };
}

function getProjectedForecast(
  row: NextGenerationTrainingProjectionRow,
  prefix: string,
  fields: readonly string[],
) {
  const forecast: Record<string, unknown> = {};
  let hasProjectedValue = false;
  for (const field of fields) {
    const value = row[trainingProjectionAlias(prefix, field)];
    if (value !== undefined) hasProjectedValue = true;
    forecast[field] = value;
  }
  return hasProjectedValue ? forecast : null;
}

function toTrainingHistoryRow(
  row: NextGenerationTrainingProjectionRow,
): NextGenerationTrainingHistoryRow {
  const forecasts: Record<string, unknown> = {};
  const bForecast = getProjectedForecast(row, "b", B_TRAINING_PROJECTION_FIELDS);
  if (bForecast) forecasts[NEXT_GENERATION_B_MODEL_VERSION] = bForecast;

  for (
    let index = 0;
    index < NEXT_GENERATION_A_COMPONENT_VERSIONS.length;
    index += 1
  ) {
    const modelVersion = NEXT_GENERATION_A_COMPONENT_VERSIONS[index];
    // The B projection above contains the B component fields as well.
    if (modelVersion === NEXT_GENERATION_B_MODEL_VERSION) continue;
    const component = getProjectedForecast(row, `a_${index}`, A_TRAINING_PROJECTION_FIELDS);
    if (component) forecasts[modelVersion] = component;
  }

  const cForecast = getProjectedForecast(row, "c", C_TRAINING_PROJECTION_FIELDS);
  if (cForecast) forecasts[NEXT_GENERATION_C_MODEL_VERSION] = cForecast;
  const cV2Forecast = getProjectedForecast(row, "c_v2", C_TRAINING_PROJECTION_FIELDS);
  if (cV2Forecast) forecasts[NEXT_GENERATION_C_V2_MODEL_VERSION] = cV2Forecast;

  return {
    logged_hour: row.logged_hour,
    debug_info: { experimentalProbabilityForecasts: forecasts },
  };
}

export function parseNextGenerationTrainingProjectionRows(
  rows: Array<NextGenerationTrainingProjectionRow>,
  options: NextGenerationTrainingQueryOptions,
): NextGenerationTrainingRows {
  return parseNextGenerationTrainingRows(rows.map(toTrainingHistoryRow), options);
}

export function getNextGenerationRandomTargetEvents(
  data: RadarData | null,
  asOf: Date,
  staticHistory: Array<WindowEventLike> = LOCAL_RESET_HISTORY,
): Array<ShadowResetEvent> {
  return getRecoveryResetEvents(data, asOf, staticHistory)
    .filter((boundary) => boundary.isRandom)
    .map((boundary) => ({ id: boundary.id, resetAt: boundary.resetAt }));
}

export async function loadNextGenerationTrainingState(
  client: any,
  options: NextGenerationTrainingQueryOptions,
): Promise<NextGenerationTrainingState> {
  const empty: NextGenerationTrainingRows = {
    bRows: [],
    aRows: [],
    cRows: [],
    cV2Rows: [],
    totalRows: 0,
    skipReasons: createSkipReasons(),
    backfill: false,
  };
  const asOfTime = options.asOf.getTime();
  if (!Number.isFinite(asOfTime)) {
    return { ...empty, status: "error", reason: "invalid asOf" };
  }

  try {
    const result = await client
      .from("prediction_history")
      .select(NEXT_GENERATION_TRAINING_SELECT_FIELDS)
      .gte("logged_hour", getLoggedHourQueryStart())
      .lt("logged_hour", options.asOf.toISOString())
      .order("logged_hour", { ascending: true })
      .limit(10_000);
    if (result?.error) {
      return { ...empty, status: "error", reason: "prediction_history query failed" };
    }
    const parsed = parseNextGenerationTrainingProjectionRows(
      (result?.data ?? []) as Array<NextGenerationTrainingProjectionRow>,
      options,
    );
    return { ...parsed, status: "ok", reason: null };
  } catch {
    return { ...empty, status: "error", reason: "prediction_history query failed" };
  }
}
