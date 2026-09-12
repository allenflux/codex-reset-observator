import test from "node:test";
import assert from "node:assert/strict";
import fixtureJson from "./fixtures/tibo-scenarios.json";
import {
  buildFixedGeminiOutput,
  buildScenarioPrompt,
  runTiboScenario,
  type TiboScenario,
  type TiboScenarioFixture,
} from "./tiboScenarioSupport";
import { buildGeminiPrompt } from "../lib/radar/geminiClassification";
import { classifyTiboTweet } from "../lib/radar/classification";
import { selectTiboClassification } from "../lib/radar/tiboClassificationMode";
import { aggregateResetTeaserStatus } from "../lib/radar/teaserStrength";
import {
  combineResetHistory,
  type FormalTiboResetSignal,
} from "../lib/radar/tiboHistory";
import { getDueRegularResetEventRows } from "../lib/radar/regularResetSchedule";
import { getLocalRadarData, getRandomResetHeatmapEventTimes } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";

const fixture = fixtureJson as TiboScenarioFixture;
const scenarios = fixture.scenarios;
const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
const requiredCategories = [
  "reset_executed",
  "official_notice",
  "teaser",
  "irrelevant_reset_terms",
  "negation",
  "retraction",
  "conditional",
  "hypothetical",
  "historical",
  "mixed_timeline",
  "reply_context",
  "quote_context",
  "time_expression",
  "negated_time",
  "multiple_events",
  "noise_normalization",
];

test("Scenario Lab fixture has enough balanced, auditable categories", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.ok(scenarios.length >= 100);
  const categories = new Map<string, number>();
  const ids = new Set<string>();

  for (const scenario of scenarios) {
    assert.ok(scenario.id);
    assert.equal(ids.has(scenario.id), false, `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.description);
    assert.ok(scenario.tweetText);
    assert.ok(Number.isFinite(Date.parse(scenario.tweetCreatedAt)), scenario.id);
    assert.match(scenario.tweetUrl, /^https:\/\/x\.com\/[^/]+\/status\/\d+$/);
    assert.ok(scenario.expected.signalType);
    categories.set(scenario.category, (categories.get(scenario.category) ?? 0) + 1);
  }

  assert.ok(categories.size >= 12);
  for (const category of requiredCategories) {
    assert.ok((categories.get(category) ?? 0) >= 5, `${category} needs at least five cases`);
  }
});

for (const scenario of scenarios) {
  test(`fixture is executable without network or DB: ${scenario.id}`, () => {
    const run = runTiboScenario(scenario);
    assert.equal(run.scenario.id, scenario.id);
    assert.ok(run.publicSnapshot.schemaVersion === "public-v1");
    assert.ok(Number.isFinite(run.publicSnapshot.viewModel.probability24h ?? 0));
    assert.ok(Number.isFinite(run.publicSnapshot.viewModel.probability48h ?? 0));
  });
}

test("fixed Gemini pipeline covers every representative scenario and keeps the fixture gold", () => {
  const pipelineScenarios = scenarios.filter((scenario) => scenario.pipeline);
  assert.ok(pipelineScenarios.length >= 20);

  for (const scenario of pipelineScenarios) {
    const run = runTiboScenario(scenario);
    assert.equal(run.selected.signalType, scenario.expected.signalType, scenario.id);
    if (scenario.expected.teaserStrength) {
      assert.equal(run.teaserStatus, scenario.expected.teaserStrength, scenario.id);
    }
    if (scenario.expected.temporalResolutionStatus) {
      assert.equal(run.temporalResolution?.status, scenario.expected.temporalResolutionStatus, scenario.id);
    }
    if (scenario.expected.temporalPrecision) {
      assert.equal(run.temporalResolution?.temporalPrecision, scenario.expected.temporalPrecision, scenario.id);
    }
    if (scenario.expected.shouldCreateActiveNotice !== undefined) {
      assert.equal(run.publicSnapshot.viewModel.activeWindow.active, scenario.expected.shouldCreateActiveNotice, scenario.id);
    }
    if (scenario.expected.shouldCreateTeaser !== undefined) {
      assert.equal(run.teaserStatus === "strong" || run.teaserStatus === "weak", scenario.expected.shouldCreateTeaser, scenario.id);
    }
    if (scenario.expected.shouldCreateResetHistoryEvent !== undefined) {
      assert.equal(run.formalAccepted, scenario.expected.shouldCreateResetHistoryEvent, scenario.id);
    }
  }
});

test("official notice becomes active without creating an executed history event", () => {
  const run = runTiboScenario(scenarioById.get("notice-01")!);
  assert.equal(run.temporalResolution?.status, "resolved");
  assert.equal(run.publicSnapshot.viewModel.activeWindow.active, true);
  assert.equal(run.formalAccepted, false);
  assert.equal(run.historyEvent, null);
});

test("teaser strength reaches the public UI state but not reset history", () => {
  const strong = runTiboScenario(scenarioById.get("teaser-01")!);
  const weak = runTiboScenario(scenarioById.get("teaser-02")!);
  assert.equal(strong.teaserStatus, "strong");
  assert.equal(weak.teaserStatus, "weak");
  assert.equal(strong.historyEvent, null);
  assert.equal(weak.historyEvent, null);
});

test("reset execution reaches formal history only when the safety gate passes", () => {
  const run = runTiboScenario(scenarioById.get("exec-01")!);
  assert.equal(run.formalAccepted, true);
  assert.equal(run.historyEvent?.recordKind, "confirmed_global");
  assert.ok(run.publicSnapshot.viewModel.recentHistory.some((item) => item.source?.includes(run.activeSignal.tweet_id)));
});

test("composite reset fixture keeps completed primary state and independent weak teaser metadata", () => {
  const run = runTiboScenario(scenarioById.get("composite-reset-01")!);

  assert.equal(run.selected.signalType, "reset_executed");
  assert.equal(run.geminiResult?.temporalDirection, "completed_now");
  assert.equal(run.geminiResult?.evidenceQuote, "Reset has been propagated to accounts");
  assert.equal(run.geminiResult?.teaserStrength, "weak");
  assert.equal(run.activeSignal.teaser_strength, "weak");
  assert.equal(run.formalAccepted, true);
  assert.equal(run.historyEvent?.recordKind, "confirmed_global");
});

test("irrelevant, historical, and negated posts do not create current reset state", () => {
  for (const id of ["irrelevant-01", "historical-01", "negative-01", "negtime-01"]) {
    const run = runTiboScenario(scenarioById.get(id)!);
    assert.equal(run.formalAccepted, false, id);
    assert.equal(run.historyEvent, null, id);
    assert.equal(run.publicSnapshot.viewModel.activeWindow.active, false, id);
    assert.equal(run.teaserStatus, "unknown", id);
  }
});

test("reply and quote context remain separate from author text", () => {
  const reply = scenarioById.get("reply-01")!;
  const quote = scenarioById.get("quote-01")!;
  const replyPrompt = buildScenarioPrompt(reply);
  const quotePrompt = buildScenarioPrompt(quote);

  assert.match(replyPrompt, /AUTHOR TEXT: No\./);
  assert.ok(quotePrompt.indexOf("AUTHOR TEXT:") < quotePrompt.indexOf("QUOTED CONTEXT"));
  assert.match(quotePrompt, /not Tibo's own text/);
  assert.equal(runTiboScenario(reply).formalAccepted, false);
  assert.equal(runTiboScenario(quote).formalAccepted, false);
});

test("historical conditional Maybe reply is a weak teaser without formal adoption or probability impact", () => {
  const scenario: TiboScenario = {
    id: "historical-maybe-20m-repair",
    category: "reply_context",
    description: "Conditional 20M-user reset question answered by Tibo",
    tweetText: "Maybe",
    tweetCreatedAt: "2026-08-16T18:57:17.000Z",
    tweetUrl: "https://x.com/thsottiaux/status/2089063967301730789",
    isReply: true,
    replyToHandles: ["@Ananth7e"],
    replyContextText: "are we going to get a reset when codex crosses 20M users?",
    sourceTimeline: "with_replies",
    expected: {
      signalType: "teaser",
      temporalDirection: "future",
      teaserStrength: "weak",
      shouldCreateActiveNotice: false,
      shouldCreateTeaser: true,
      shouldCreateResetHistoryEvent: false,
      shouldAffectProbability: false,
    },
    pipeline: true,
    mockGeminiOutput: {
      signalType: "teaser",
      confidence: 0.95,
      temporalDirection: "future",
      teaserStrength: "weak",
      teaserStrengthConfidence: 0.8,
      teaserStrengthEvidenceQuote: "Maybe",
    },
  };
  const run = runTiboScenario(scenario);
  const baseline = toPublicRadarSnapshot(
    getLocalRadarData({ calculationNow: run.now }),
    "ja",
    { calculationNow: run.now, limitHistory: false },
  );

  assert.equal(run.selected.signalType, "teaser");
  assert.equal(run.teaserStatus, "weak");
  assert.equal(run.activeSignal.is_reply, true);
  assert.equal(run.formalAccepted, false);
  assert.equal(run.historyEvent, null);
  assert.equal(run.publicSnapshot.viewModel.activeWindow.active, false);
  assert.equal(run.publicSnapshot.viewModel.probability24h, baseline.viewModel.probability24h);
  assert.equal(run.publicSnapshot.viewModel.probability48h, baseline.viewModel.probability48h);

  const prompt = buildScenarioPrompt(scenario);
  assert.match(prompt, /Replying to: @Ananth7e/);
  assert.match(prompt, /Parent context shown in the same article: are we going to get a reset when codex crosses 20M users\?/);
});

test("derivative Maybe reply remains non-independent and short replies stay irrelevant", () => {
  const derivative: TiboScenario = {
    id: "historical-maybe-echo-repair",
    category: "reply_context",
    description: "Derivative echo of the earlier Maybe reply",
    tweetText: "Maybe",
    tweetCreatedAt: "2026-08-16T19:54:10.000Z",
    tweetUrl: "https://x.com/thsottiaux/status/2089078284487139347",
    isReply: true,
    replyContextText: '"maybe" from tibo is basically a confirmed reset',
    sourceTimeline: "with_replies",
    expected: {
      signalType: "irrelevant",
      temporalDirection: "unclear",
      teaserStrength: "none",
      shouldCreateTeaser: false,
      shouldCreateResetHistoryEvent: false,
      shouldAffectProbability: false,
    },
    pipeline: true,
    mockGeminiOutput: {
      signalType: "irrelevant",
      confidence: 0.95,
      temporalDirection: "unclear",
      teaserStrength: "none",
    },
  };
  const run = runTiboScenario(derivative);
  assert.equal(run.selected.signalType, "irrelevant");
  assert.equal(run.teaserStatus, "none");
  assert.equal(run.formalAccepted, false);
  assert.equal(run.historyEvent, null);
  assert.equal(run.publicSnapshot.viewModel.activeWindow.active, false);

  const shortReplies = ["Yes", "No way", "Indeed", "Welcome", "Legend", "Always improving"];
  for (let index = 0; index < shortReplies.length; index += 1) {
    const text = shortReplies[index];
    const result = classifyTiboTweet(
      text,
      `https://x.com/thsottiaux/status/${920000000000000000 + index}`,
      { isReply: true },
    );
    assert.equal(result.signalType, "irrelevant", text);
  }
});

test("metamorphic formatting variants keep the same fixed semantic result", () => {
  const base = scenarioById.get("time-01")!;
  const variants = [
    "reset in an hour.",
    "RESET IN AN HOUR.",
    "Reset in an hour :) ",
    "Reset\nin an hour.",
  ];
  const expected = buildFixedGeminiOutput(base).signalType;
  for (const text of variants) {
    const variant: TiboScenario = {
      ...base,
      id: `${base.id}-metamorphic-${text.length}`,
      tweetText: text,
      pipeline: true,
      mockGeminiOutput: {
        ...base.mockGeminiOutput,
        temporalExpression: text.toLowerCase().replace(/^reset\s+/i, "").replace(/[.]$/, ""),
      },
    };
    const run = runTiboScenario(variant);
    assert.equal(run.selected.signalType, expected);
  }
});

test("semantic sensitivity distinguishes a negated time expression", () => {
  const positive = classifyTiboTweet("Reset in the next hour.", "https://x.com/thsottiaux/status/1");
  const negative = classifyTiboTweet("Not in the next hour.", "https://x.com/thsottiaux/status/2");
  assert.notEqual(positive.signalType, negative.signalType);
});

test("duplicate executed posts are reduced to one history event", () => {
  const signal = runTiboScenario(scenarioById.get("exec-01")!).formalSignal;
  const history = combineResetHistory([], [signal, signal]);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].sourceTweetIds, [signal.tweet_id]);
});

test("an official notice alone never creates an executed history event", () => {
  const notice = runTiboScenario(scenarioById.get("notice-01")!);
  const history = combineResetHistory([], [], [], [], [notice.formalSignal]);
  assert.equal(history.length, 0);
});

test("future notice is never accepted as reset execution", () => {
  const notice = runTiboScenario(scenarioById.get("notice-03")!);
  assert.equal(notice.formalAccepted, false);
  assert.equal(notice.historyEvent, null);
});

test("expired official notice leaves the public active window", () => {
  const scenario = scenarioById.get("notice-01")!;
  const expiredNow = new Date("2026-08-15T00:00:00.000Z");
  const run = runTiboScenario(scenario, expiredNow);
  assert.equal(run.publicSnapshot.viewModel.activeWindow.active, false);
});

test("rejected signals stay out of the public teaser state", () => {
  const scenario = scenarioById.get("teaser-01")!;
  const run = runTiboScenario({
    ...scenario,
    id: "rejected-teaser-invariant",
    expected: { ...scenario.expected, shouldBeRejected: true },
  });
  assert.equal(run.teaserStatus, "none");
  assert.equal(run.formalAccepted, false);
});

test("regular reset rows do not enter random-reset heatmap events", () => {
  const now = new Date("2026-08-14T00:00:00.000Z");
  const regularRows = getDueRegularResetEventRows(
    now,
    "2026-08-01T03:32:00.000Z",
  );
  const withoutRegular = getLocalRadarData({ calculationNow: now });
  const withRegular = getLocalRadarData({ calculationNow: now, regularResetEvents: regularRows });
  assert.deepEqual(
    getRandomResetHeatmapEventTimes(withRegular, now),
    getRandomResetHeatmapEventTimes(withoutRegular, now),
  );
});

test("a later formal reset consumes earlier teaser state", () => {
  const now = new Date("2026-08-14T20:00:00.000Z");
  const strong = {
    tweet_created_at: "2026-08-14T10:00:00.000Z",
    teaser_strength: "strong" as const,
    signal_type: "teaser",
    verification_status: "auto_unverified",
  };
  const current = {
    tweet_created_at: "2026-08-14T12:00:00.000Z",
    teaser_strength: "none" as const,
    signal_type: "teaser",
    verification_status: "auto_unverified",
  };
  assert.equal(
    aggregateResetTeaserStatus([strong, current], "2026-08-14T11:00:00.000Z", now),
    "none",
  );
});

test("all Gemini failure statuses use a rule fallback without success confidence", () => {
  const rule = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/3");
  const statuses = ["timeout", "rate_limited", "invalid_json", "invalid_schema", "invalid_evidence", "api_error"] as const;
  for (const status of statuses) {
    const selected = selectTiboClassification("primary", rule, {
      ...buildFixedGeminiOutput({
        id: `failure-${status}`,
        category: "invariant",
        description: "failure",
        tweetText: "Just chatting about models today.",
        tweetCreatedAt: "2026-08-14T00:00:00.000Z",
        tweetUrl: "https://x.com/thsottiaux/status/4",
        expected: { signalType: "irrelevant" },
      }),
      signalType: null,
      confidence: null,
      reasonJa: null,
      status,
    });
    assert.equal(selected.classificationSource, "rule_fallback", status);
    assert.equal(selected.confidence, rule.confidence, status);
  }
});

test("scenario prompts preserve quote and reply safety wording", () => {
  const prompt = buildGeminiPrompt({
    text: "Done.",
    isReply: true,
    replyContextText: "Reset us please!",
    isQuote: true,
    quoteContextText: "We need a reset.",
  });
  assert.match(prompt, /AUTHOR TEXT: Done\./);
  assert.match(prompt, /QUOTED CONTEXT \(not Tibo's own text\)/);
  assert.match(prompt, /Reply status alone must not raise teaser or official_notice/);
});

test("fixture includes regression groups for the known temporal and context failures", () => {
  const groups = new Set(scenarios.map((scenario) => scenario.regressionGroup).filter(Boolean));
  for (const group of ["next-hour-or-so", "natural-language-number", "formal-reset", "teaser-strength"]) {
    assert.ok(groups.has(group), group);
  }
});
