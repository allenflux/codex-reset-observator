import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProspectiveProbabilityForecasts,
  getActualWithinHorizon,
  PROSPECTIVE_ARCHIVED_MODEL_VERSIONS,
  PROSPECTIVE_V4_MODEL_VERSION,
  selectDailyFirstForecasts,
  type ProspectiveForecastRow,
} from "../lib/radar/prospectiveProbabilityEvaluation";

function forecastRow(
  loggedHour: string,
  generatedAt: string,
  probability24h = 0.2,
  probability48h = 0.4,
  includeCandidate = true,
): ProspectiveForecastRow {
  const forecasts: ProspectiveForecastRow["forecasts"] = {
    "hazard-odds-v2-random-only": {
      modelVersion: "hazard-odds-v2-random-only",
      generatedAt,
      probability24h,
      probability48h,
    },
  };
  if (includeCandidate) {
    forecasts[PROSPECTIVE_V4_MODEL_VERSION] = {
      modelVersion: PROSPECTIVE_V4_MODEL_VERSION,
      generatedAt,
      probability24h: Math.min(1, probability24h + 0.1),
      probability48h: Math.min(1, probability48h + 0.1),
    };
  }
  return { loggedHour, generatedAt, forecasts };
}

test("selects the first saved forecast for each JST calendar day", () => {
  const selected = selectDailyFirstForecasts([
    forecastRow("2026-08-01T00:30:00.000Z", "2026-08-01T00:30:00.000Z"),
    forecastRow("2026-08-01T01:00:00.000Z", "2026-08-01T01:00:00.000Z"),
    forecastRow("2026-08-01T15:00:00.000Z", "2026-08-01T15:00:00.000Z"),
    forecastRow("2026-08-02T00:01:00.000Z", "2026-08-02T00:01:00.000Z"),
  ]);

  assert.deepEqual(selected.map((row) => row.generatedAt), [
    "2026-08-01T00:30:00.000Z",
    "2026-08-01T15:00:00.000Z",
  ]);
});

test("filters to comparable active models before selecting a daily representative", () => {
  const earlyV2Only = forecastRow(
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    0.1,
    0.2,
    false,
  );
  const firstComparable = forecastRow(
    "2026-08-01T12:00:00.000Z",
    "2026-08-01T12:00:00.000Z",
    0.2,
    0.3,
  );
  const nextDayComparable = forecastRow(
    "2026-08-02T12:00:00.000Z",
    "2026-08-02T12:00:00.000Z",
    0.3,
    0.4,
  );
  const report = evaluateProspectiveProbabilityForecasts(
    [earlyV2Only, firstComparable, nextDayComparable],
    [],
    new Date("2026-08-04T12:00:00.000Z"),
  );

  assert.equal(report.evaluationStartAt, firstComparable.generatedAt);
  assert.equal(report.models.v2.metrics24h.periodStart, firstComparable.generatedAt);
  assert.equal(report.models.v2.metrics24h.count, 2);
  assert.equal(report.activeCandidateModel, PROSPECTIVE_V4_MODEL_VERSION);
  assert.deepEqual(report.archivedCandidateModels, PROSPECTIVE_ARCHIVED_MODEL_VERSIONS);
});

test("does not mix archived v1 rows into the active v2 evaluation", () => {
  const row = forecastRow("2026-08-01T12:00:00.000Z", "2026-08-01T12:00:00.000Z");
  row.forecasts[PROSPECTIVE_ARCHIVED_MODEL_VERSIONS[0]] = {
    modelVersion: PROSPECTIVE_ARCHIVED_MODEL_VERSIONS[0],
    generatedAt: row.generatedAt,
    probability24h: 0.9,
    probability48h: 0.95,
  };
  delete row.forecasts[PROSPECTIVE_V4_MODEL_VERSION];

  const report = evaluateProspectiveProbabilityForecasts(
    [row],
    [],
    new Date("2026-08-04T12:00:00.000Z"),
  );
  assert.equal(report.evaluationStartAt, null);
  assert.equal(report.models.v2.metrics24h.count, 0);
  assert.equal(report.models.v4.metrics24h.count, 0);
});

test("horizon labels exclude simultaneous events and include the exact endpoint", () => {
  const event = { id: "reset", resetAt: "2026-08-02T00:00:00.000Z" };
  assert.equal(getActualWithinHorizon([event], "2026-08-02T00:00:00.000Z", 24), false);
  assert.equal(getActualWithinHorizon([event], "2026-08-01T00:00:00.000Z", 24), true);
  assert.equal(getActualWithinHorizon([event], "2026-08-01T00:00:00.000Z", 23), false);
});

test("prospective evaluation resolves only completed horizons and compares the same origins", () => {
  const asOf = new Date("2026-08-02T00:00:00.000Z");
  const report = evaluateProspectiveProbabilityForecasts(
    [
      forecastRow("2026-07-31T00:00:00.000Z", "2026-07-31T00:00:00.000Z", 0.1, 0.2),
      forecastRow("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", 0.3, 0.5),
      forecastRow("2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z", 0.2, 0.4),
    ],
    [
      { id: "at-origin", resetAt: "2026-07-31T00:00:00.000Z" },
      { id: "within-24h", resetAt: "2026-08-01T00:00:00.000Z" },
      { id: "within-48h", resetAt: "2026-08-02T00:00:00.000Z" },
    ],
    asOf,
  );

  assert.equal(report.status, "insufficient_data");
  assert.equal(report.comparison.resolved24h, 2);
  assert.equal(report.comparison.resolved48h, 1);
  assert.equal(report.models.v2.metrics24h.count, 2);
  assert.equal(report.models.v4.metrics24h.count, 2);
  assert.equal(report.models.v2.metrics48h.count, 1);
  assert.equal(report.models.v4.metrics48h.count, 1);
  assert.equal(report.gate.autoPublish, false);
  assert.equal(report.gate.thresholds.targetResetCount, 5);
});

test("empty prospective history produces an insufficient-data report", () => {
  const report = evaluateProspectiveProbabilityForecasts(
    [],
    [],
    new Date("2026-08-04T00:00:00.000Z"),
  );

  assert.equal(report.status, "insufficient_data");
  assert.equal(report.models.v2.metrics24h.count, 0);
  assert.equal(report.models.v4.metrics48h.count, 0);
  assert.equal(report.comparison.targetResetCount, 0);
});
