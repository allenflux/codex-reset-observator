import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveComplaintPressure,
  evaluateStatusIncidents,
  formatStatusIncidentReason,
} from "../lib/radar/signalEvaluation";
import {
  getExpectationKey,
  isWithinHours,
} from "../lib/radar/helpers";
import {
  getLocalProbabilityReason,
  getLocalResetProbability,
  getLocalSignalEvaluation,
  getLocalSignalEnvironment,
} from "../lib/radar/probability";
import { LOCAL_OBSERVATION_SIGNALS } from "../data/observationSignals";
import { LOCAL_PROBABILITY_WEIGHTS } from "../data/predictionWeights";
import type { OpenAIStatusHistoryItem } from "../lib/openaiStatus";
import type { RadarData } from "../lib/radar/types";
import {
  getNewTweets,
  getNewestTweet,
  type TiboProcessedState,
  type TiboTweetItem,
} from "../scripts/tibo-monitor-helpers";

const NOW = new Date("2026-07-18T15:00:00.000Z");
const LAST_RESET = new Date("2026-07-18T12:00:00.000Z");

function incident(
  overrides: Partial<OpenAIStatusHistoryItem> = {},
): OpenAIStatusHistoryItem {
  return {
    id: "incident-1",
    title: "Codex incident",
    status: "resolved",
    impact: "minor",
    createdAt: "2026-07-18T13:00:00.000Z",
    updatedAt: "2026-07-18T14:00:00.000Z",
    resolvedAt: "2026-07-18T14:00:00.000Z",
    source: "openai_status",
    url: "https://status.openai.com/incidents/incident-1",
    ...overrides,
  };
}

function evaluate(
  incidents: Array<OpenAIStatusHistoryItem>,
  overrides: Partial<Parameters<typeof evaluateStatusIncidents>[0]> = {},
) {
  return evaluateStatusIncidents({
    incidents,
    latestResetAt: LAST_RESET,
    now: NOW,
    suppressOpenAIIncidents: false,
    affectedCodexComponents: 0,
    maxWeightedScore: 5,
    ...overrides,
  });
}

test("excludes an incident resolved before the latest reset", () => {
  const result = evaluate([
    incident({ resolvedAt: "2026-07-18T11:59:00.000Z" }),
  ]);

  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.excludedPreResetIncidentCount, 1);
  assert.equal(result.weightedStatusScore, 0);
});

test("prefers resolvedAt over a newer updatedAt", () => {
  const result = evaluate([
    incident({
      resolvedAt: "2026-07-18T11:59:00.000Z",
      updatedAt: "2026-07-18T14:30:00.000Z",
    }),
  ]);

  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.excludedPreResetIncidentCount, 1);
});

test("derives a stable very_high key without depending on the Japanese label", () => {
  assert.equal(getExpectationKey({ p24h: 0.9, p48h: 0.95 }), "very_high");
});

test("uses either displayed horizon for expectation thresholds", () => {
  assert.equal(getExpectationKey({ p24h: 0.3, p48h: 0.93 }), "very_high");
  assert.equal(getExpectationKey({ p24h: 0.3, p48h: 0.7 }), "high");
  assert.equal(getExpectationKey({ p24h: 0.3, p48h: 0.4 }), "medium");
  assert.equal(getExpectationKey({ p24h: 0.1, p48h: 0.1 }), "low");
  assert.equal(getExpectationKey({ p24h: 0.8, p48h: 0.1 }), "very_high");
  assert.equal(getExpectationKey({ p24h: 0.61, p48h: 0.1 }), "high");
});

test("starts the medium expectation at thirty percent", () => {
  assert.equal(getExpectationKey({ p24h: 0.2, p48h: 0.2 }), "low");
  assert.equal(getExpectationKey({ p24h: 0.2999, p48h: 0.2999 }), "low");
  assert.equal(getExpectationKey({ p24h: 0.3, p48h: 0.3 }), "medium");
});

test("falls back from resolvedAt to updatedAt and then createdAt", () => {
  const result = evaluate([
    incident({ id: "updated", resolvedAt: null }),
    incident({
      id: "created",
      resolvedAt: null,
      updatedAt: null,
      createdAt: "2026-07-18T13:30:00.000Z",
    }),
  ]);

  assert.equal(result.recentResolvedIncidentCount, 2);
  assert.equal(result.includedIncidentCount, 2);
});

test("includes an unresolved incident even when it started before the reset", () => {
  const result = evaluate([
    incident({
      status: "investigating",
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-18T14:00:00.000Z",
      resolvedAt: null,
    }),
  ]);

  assert.equal(result.activeStatusIncidentCount, 1);
  assert.equal(result.includedIncidentCount, 1);
  assert.equal(result.weightedStatusScore, 1);
});

test("includes a recent incident resolved after the latest reset", () => {
  const result = evaluate([incident()]);

  assert.equal(result.activeStatusIncidentCount, 0);
  assert.equal(result.recentResolvedIncidentCount, 1);
  assert.equal(result.includedIncidentCount, 1);
});

test("excludes resolved incidents older than 24 hours", () => {
  const result = evaluate(
    [incident({ resolvedAt: "2026-07-17T14:59:59.000Z" })],
    { latestResetAt: new Date("2026-07-17T12:00:00.000Z") },
  );

  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.excludedStaleOrInvalidIncidentCount, 1);
});

test("uses impact weights and caps the weighted score", () => {
  const result = evaluate([
    incident({ id: "minor", impact: "minor" }),
    incident({ id: "major", impact: "major" }),
    incident({ id: "critical", impact: "critical" }),
  ]);

  assert.equal(result.includedIncidentCount, 3);
  assert.equal(result.weightedStatusScore, 5);
});

test("suppresses all OpenAI incidents when Codex components are operational", () => {
  const result = evaluate(
    [incident({ status: "investigating", resolvedAt: null })],
    { suppressOpenAIIncidents: true },
  );

  assert.equal(result.activeStatusIncidentCount, 0);
  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.suppressedIncidentCount, 1);
  assert.equal(result.weightedStatusScore, 0);
});

test("does not promote complaint pressure from Status or incident hints", () => {
  const result = deriveComplaintPressure({
    activeStatusIncidents: 2,
    statusIncidents: 3,
    officialIncidentHints: 1,
    communityMentions: 0,
    issueAnomalies: 0,
  });

  assert.equal(result.level, "low");
  assert.deepEqual(result.sources, []);
});

test("promotes complaint pressure from independent community signals", () => {
  const community = deriveComplaintPressure({
    communityMentions: 10,
    issueAnomalies: 0,
  });
  const anomalies = deriveComplaintPressure({
    communityMentions: 0,
    issueAnomalies: 3,
  });

  assert.equal(community.level, "medium");
  assert.deepEqual(community.sources, ["community_mentions"]);
  assert.equal(anomalies.level, "medium");
  assert.deepEqual(anomalies.sources, ["issue_anomalies"]);
});

test("does not treat future, invalid, or missing resolved timestamps as recent", () => {
  const result = evaluate([
    incident({ id: "future", resolvedAt: "2026-07-18T16:00:00.000Z" }),
    incident({ id: "invalid", resolvedAt: "not-a-date", updatedAt: null, createdAt: null }),
    incident({ id: "missing", resolvedAt: null, updatedAt: null, createdAt: null }),
  ]);

  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.excludedStaleOrInvalidIncidentCount, 3);
});

test("does not include an active incident whose latest timestamp is in the future", () => {
  const result = evaluate([
    incident({
      status: "investigating",
      resolvedAt: null,
      createdAt: "2026-07-18T15:30:00.000Z",
      updatedAt: "2026-07-18T16:00:00.000Z",
    }),
  ]);

  assert.equal(result.activeStatusIncidentCount, 0);
  assert.equal(result.includedIncidentCount, 0);
  assert.equal(result.excludedStaleOrInvalidIncidentCount, 1);
});

test("isWithinHours excludes future and invalid timestamps", () => {
  assert.equal(isWithinHours("2026-07-18T14:00:00.000Z", 24, NOW), true);
  assert.equal(isWithinHours("2026-07-18T16:00:00.000Z", 24, NOW), false);
  assert.equal(isWithinHours("not-a-date", 24, NOW), false);
});

test("formats reason text from the incidents actually included", () => {
  const active = evaluate([
    incident({ status: "investigating", resolvedAt: null }),
  ]);
  const resolved = evaluate([incident()]);
  const none = evaluate([]);

  assert.match(formatStatusIncidentReason(active, "ja"), /発生中.*1件/);
  assert.match(formatStatusIncidentReason(resolved, "en"), /recent incident resolved after the latest reset/i);
  assert.match(formatStatusIncidentReason(none, "zh"), /目前未显示进行中的故障/);
});

test("describes affected components without counting them as incidents", () => {
  const componentsOnly = evaluate([], { affectedCodexComponents: 2 });

  assert.match(
    formatStatusIncidentReason(componentsOnly, "ja"),
    /Codex関連コンポーネント.*2件/,
  );
  assert.doesNotMatch(
    formatStatusIncidentReason(componentsOnly, "ja"),
    /関連障害が2件/,
  );
});

test("does not promote the generated environment pressure from Status alone", () => {
  const environment = getLocalSignalEnvironment({
    updatedAt: NOW.toISOString(),
    statusIncidents24h: 1,
    activeCodexIncidents: 1,
    recentCodexIncidents: 1,
    affectedCodexComponents: 1,
    latestCodexIncidentName: "Codex incident",
    suppressCodexIncidents: false,
    codexOperationalStatus: "active",
    history: [],
  });

  assert.equal(environment.complaint_pressure, "low");
  assert.deepEqual(environment.complaint_pressure_sources, []);
});

test("applies operational suppression consistently to probability", () => {
  const activeIncident = incident({
    status: "investigating",
    resolvedAt: null,
    createdAt: "2026-07-18T13:00:00.000Z",
  });
  const environment = {
    ...getLocalSignalEnvironment(),
    openai_status_incidents_suppressed: true,
    openai_status_active_codex_incidents: 0,
    openai_status_affected_codex_components: 0,
  };
  const withIncident: RadarData = {
    openai_status_history: [activeIncident],
    codex_environment: environment,
  };
  const withoutIncident: RadarData = {
    openai_status_history: [],
    codex_environment: environment,
  };

  assert.equal(
    getLocalResetProbability(withIncident, "24h", undefined, undefined, NOW),
    getLocalResetProbability(withoutIncident, "24h", undefined, undefined, NOW),
  );
});

test("keeps display-only Codex operational status out of probability inputs", () => {
  const baseEnvironment = getLocalSignalEnvironment();
  const activeDisplayData: RadarData = {
    codex_environment: {
      ...baseEnvironment,
      codex_operational_status: "active",
    },
  };
  const noIncidentDisplayData: RadarData = {
    codex_environment: {
      ...baseEnvironment,
      codex_operational_status: "none",
    },
  };

  assert.equal(
    getLocalResetProbability(activeDisplayData, "24h", undefined, undefined, NOW),
    getLocalResetProbability(noIncidentDisplayData, "24h", undefined, undefined, NOW),
  );
});

test("keeps the included Status explanation when an incident hint is present", () => {
  const activeIncident = incident({ status: "investigating", resolvedAt: null });
  const data: RadarData = {
    openai_status_history: [activeIncident],
    codex_environment: {
      ...getLocalSignalEnvironment(),
      official_incident_hints_24h: 1,
      openai_status_active_codex_incidents: 1,
      openai_status_incidents_suppressed: false,
    },
  };
  const signalEvaluation = getLocalSignalEvaluation(data, NOW);
  const reason =
    getLocalProbabilityReason(data, 0.2, 0.3, "ja", signalEvaluation) ?? "";

  assert.match(reason, /発生中のCodex関連障害が1件/);
});

test("limits the local public reasoning summary to the displayed horizons", () => {
  const reason = getLocalProbabilityReason(
    { openai_status_history: [], codex_environment: getLocalSignalEnvironment() },
    0.24,
    0.48,
    "ja",
    undefined,
    null,
    false,
    NOW,
    0.12,
    0.72,
  ) ?? "";

  assert.match(reason, /24時間以内/);
  assert.match(reason, /48時間以内/);
  assert.doesNotMatch(reason, /12時間以内|72時間以内/);
});

test("keeps first-day cooldown in history pressure without a second negative signal", () => {
  const firstDayPressure = LOCAL_PROBABILITY_WEIGHTS.historyPressure[0];
  const activeNegativeBoosts = LOCAL_OBSERVATION_SIGNALS.filter(
    (signal) =>
      signal.status === "active" &&
      ((signal.boostValue24h ?? 0) < 0 || (signal.boostValue48h ?? 0) < 0),
  );

  assert.deepEqual(
    {
      within24h: firstDayPressure.within24h,
      within48h: firstDayPressure.within48h,
    },
    {
      within24h: -0.08,
      within48h: -0.14,
    },
  );
  assert.equal(activeNegativeBoosts.length, 0);
});

test("builds automated teaser signals with the shared tuned weights", async () => {
  let helpers: typeof import("../scripts/tibo-monitor-helpers");
  try {
    helpers = await import("../scripts/tibo-monitor-helpers");
  } catch {
    assert.fail("Tibo monitor helpers are required");
  }

  const signal = helpers.buildAutomatedTiboSignal(
    {
      id: "1234567890",
      createdAt: "2026-07-29T00:00:00.000Z",
      text: "See you tomorrow for more Codex fun",
      url: "https://x.com/thsottiaux/status/1234567890",
    },
    {
      category: "TEASER_HINT",
      confidence: 0.9,
      reason_ja: "翌日の追加発表を示唆",
    },
    new Date("2026-07-29T01:00:00.000Z"),
  );

  assert.equal(signal.type, "probability_boost");
  assert.equal(signal.boostValue24h, 0.2);
  assert.equal(signal.boostValue48h, 0.3);
  assert.equal(signal.boostDecayHours, 48);
  assert.equal(signal.expiresAt, "2026-07-31T01:00:00.000Z");
});

test("feature release adjustment changes only an active Tibo teaser", async () => {
  let helpers: typeof import("../scripts/tibo-monitor-helpers");
  try {
    helpers = await import("../scripts/tibo-monitor-helpers");
  } catch {
    assert.fail("Tibo monitor helpers are required");
  }

  const source = `export const SIGNALS = [
  {
    id: "official-tibo-auto-hint-2026-07-29-7890",
    type: "probability_boost",
    status: "active",
    boostValue24h: 0.2,
    boostValue48h: 0.3,
  },
  {
    id: "boost-community-event",
    type: "probability_boost",
    status: "active",
    boostValue24h: 0.2,
    boostValue48h: 0.3,
  },
  {
    id: "official-tibo-old-hint",
    type: "probability_boost",
    status: "resolved",
    boostValue24h: 0.2,
    boostValue48h: 0.3,
  },
];`;

  const updated = helpers.adjustActiveTiboTeaserBoosts(source);

  assert.match(
    updated,
    /official-tibo-auto-hint[\s\S]*?boostValue24h: 0\.2,[\s\S]*?boostValue48h: 0\.3/,
  );
  assert.match(
    updated,
    /boost-community-event[\s\S]*?boostValue24h: 0\.2,[\s\S]*?boostValue48h: 0\.3/,
  );
  assert.match(
    updated,
    /official-tibo-old-hint[\s\S]*?status: "resolved"[\s\S]*?boostValue24h: 0\.2,[\s\S]*?boostValue48h: 0\.3/,
  );
});

test("finds newer tweets after a processed id even when the feed is unsorted", () => {
  const baseline: TiboTweetItem = {
    id: "baseline",
    createdAt: "2026-07-28T00:00:00.000Z",
    text: "baseline",
    url: "https://x.com/thsottiaux/status/baseline",
  };
  const newest: TiboTweetItem = {
    id: "newest",
    createdAt: "2026-07-29T03:00:00.000Z",
    text: "newest",
    url: "https://x.com/thsottiaux/status/newest",
  };
  const middle: TiboTweetItem = {
    id: "middle",
    createdAt: "2026-07-29T01:00:00.000Z",
    text: "middle",
    url: "https://x.com/thsottiaux/status/middle",
  };
  const state: TiboProcessedState = {
    lastProcessedTweetId: baseline.id,
    processedTweetIds: [baseline.id],
  };

  assert.deepEqual(
    getNewTweets(
      [baseline, newest, middle],
      state,
      new Date("2026-07-29T04:00:00.000Z"),
    ).map((tweet) => tweet.id),
    [middle.id, newest.id],
  );
});

test("selects the newest tweet by timestamp for an initial baseline", () => {
  const tweets: TiboTweetItem[] = [
    {
      id: "older",
      createdAt: "2026-07-29T01:00:00.000Z",
      text: "older",
      url: "https://x.com/thsottiaux/status/older",
    },
    {
      id: "newer",
      createdAt: "2026-07-29T03:00:00.000Z",
      text: "newer",
      url: "https://x.com/thsottiaux/status/newer",
    },
  ];

  assert.equal(getNewestTweet(tweets)?.id, "newer");
});

test("ignores stale tweets mixed into a fresh timeline response", () => {
  const state: TiboProcessedState = {
    lastProcessedTweetId: "baseline",
    processedTweetIds: ["baseline"],
  };
  const stale: TiboTweetItem = {
    id: "stale",
    createdAt: "2025-11-19T00:00:00.000Z",
    text: "old timeline item",
    url: "https://x.com/thsottiaux/status/stale",
  };
  const recent: TiboTweetItem = {
    id: "recent",
    createdAt: "2026-07-29T03:00:00.000Z",
    text: "recent timeline item",
    url: "https://x.com/thsottiaux/status/recent",
  };

  assert.deepEqual(
    getNewTweets(
      [
        { ...stale, id: "baseline", createdAt: "2025-09-15T17:31:16.000Z" },
        stale,
        recent,
      ],
      state,
      new Date("2026-07-29T04:00:00.000Z"),
    ).map((tweet) => tweet.id),
    [recent.id],
  );
});
