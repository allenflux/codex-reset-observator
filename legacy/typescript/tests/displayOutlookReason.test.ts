import assert from "node:assert/strict";
import test from "node:test";

import { getLocalRadarData, getRadarViewModel } from "../lib/radar";
import {
  getDisplayProbabilityReason,
  getLocalSignalEvaluation,
  type ActiveOfficialNotice,
} from "../lib/radar/probability";
import { getDueRegularResetEventRows } from "../lib/radar/regularResetSchedule";
import type { RegularResetEventRow } from "../lib/radar/regularResetSchedule";
import { calculateRegimeElapsedProbability } from "../lib/radar/regimeElapsedProbability";
import type { RadarData } from "../lib/radar/types";

const NOW = new Date("2026-08-04T00:00:00.000Z");

function hazardBins(rates: number[]) {
  const boundaries = [0, 24, 48, null] as const;
  return rates.map((posteriorLambdaPerHour, index) => ({
    startHour: boundaries[index],
    endHour: boundaries[index + 1],
    posteriorLambdaPerHour,
  }));
}

function regularResetAt(completedAt: string): RegularResetEventRow {
  const endAt = new Date(new Date(completedAt).getTime() + 15 * 60 * 1000).toISOString();
  return {
    schedule_key: `test:${completedAt}`,
    window_start_at: completedAt,
    window_end_at: endAt,
    representative_at: completedAt,
    scheduled_at: completedAt,
    completed_at: completedAt,
    cycle_type: "定期リセット",
    reset_method: "強制リセット",
    scope: "任意リセット未使用アカウント",
    record_kind: "regular_completed",
    status: "completed",
  };
}

function randomResetAt(completedAt: string): NonNullable<RadarData["formal_tibo_resets"]>[number] {
  return {
    tweet_id: `test-random-${completedAt}`,
    text: "Reset completed",
    tweet_url: "https://x.com/thsottiaux/status/2000000000000000000",
    tweet_created_at: completedAt,
    signal_type: "reset_executed",
    confidence: 1,
    verification_status: "confirmed",
  };
}

function modelContext(
  regimeMultiplier: number,
  elapsedHours: number,
  source: "shadow" | "legacy-shadow-fallback" | "heuristic-fallback" = "shadow",
  mode?: "full" | "elapsed-only" | "regime-only",
  bins = hazardBins([0.0002, 0.0015, 0.0015]),
) {
  return {
    source,
    shadow: {
      hazard: {
        globalLambdaPerHour: 0.001,
        bins,
      },
      regimeElapsed: {
        elapsedHours,
        mode: mode ?? "elapsed-only",
        effectiveRegimeMultiplier: mode === "elapsed-only" ? 1 : regimeMultiplier,
        regime: { regimeMultiplier },
        bins,
      },
    },
  } as const;
}

function signal(
  teaserStrength: "strong" | "weak" | "none",
  createdAt = "2026-08-03T12:00:00.000Z",
) {
  return {
    tweet_id: `${teaserStrength}-${createdAt}`,
    signal_type: "irrelevant" as const,
    text: "Tibo signal",
    tweet_created_at: createdAt,
    teaser_strength: teaserStrength,
    verification_status: "auto_unverified" as const,
  };
}

function reasonFor({
  locale = "ja" as const,
  signals = [],
  environment = {},
  statusIncidents = {},
  notice = null,
  multiplier = 1,
  elapsedHours = 48,
  source = "shadow" as const,
  mode,
  bins,
  probability24h = 0.2,
  probability48h = 0.35,
  now = NOW,
  formalTiboResets = [],
  regularResetEvents = [],
}: {
  locale?: "ja" | "en" | "zh";
  signals?: ReturnType<typeof signal>[];
  environment?: Record<string, number>;
  statusIncidents?: Record<string, number>;
  notice?: ActiveOfficialNotice | null;
  multiplier?: number;
  elapsedHours?: number;
  source?: "shadow" | "legacy-shadow-fallback" | "heuristic-fallback";
  mode?: "full" | "elapsed-only" | "regime-only";
  bins?: ReturnType<typeof hazardBins>;
  probability24h?: number;
  probability48h?: number;
  now?: Date;
  formalTiboResets?: RadarData["formal_tibo_resets"];
  regularResetEvents?: RegularResetEventRow[];
} = {}) {
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: signals,
    formalTiboResets,
    regularResetEvents,
  });
  const baseEvaluation = getLocalSignalEvaluation(data, now);
  const evaluation = {
    ...baseEvaluation,
    environment: { ...baseEvaluation.environment, ...environment },
    statusIncidents: { ...baseEvaluation.statusIncidents, ...statusIncidents },
  };

  return getDisplayProbabilityReason(
    data,
    probability24h,
    probability48h,
    locale,
    evaluation,
    notice,
    now,
    modelContext(multiplier, elapsedHours, source, mode, bins),
  );
}

const officialNotice: ActiveOfficialNotice = {
  origin: "local",
  id: "display-outlook-notice",
  title: "Reset notice",
  summary: "A reset notice",
  observedAt: NOW.toISOString(),
  expectedAt: null,
  expectedEndAt: null,
  expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  source: null,
  sourceLabel: "test",
};

test("prioritizes official notice, strong teaser, incident, weak teaser, and anomaly", () => {
  assert.equal(
    reasonFor({ notice: officialNotice, signals: [signal("strong")] }),
    "公式のリセット予告が確認されています。予告内容を踏まえ、リセットの見込みが高まっています。",
  );
  assert.equal(reasonFor({ signals: [signal("strong")] }), "リセットを示唆する投稿が確認されています。通常時よりリセットの見込みが高まっています。");
  assert.equal(reasonFor({ statusIncidents: { activeStatusIncidentCount: 1 } }), "Codex関連の障害が確認されています。復旧対応などに伴うリセットの可能性も含めて注視しています。");
  assert.equal(reasonFor({ signals: [signal("weak")] }), "弱いリセット匂わせ投稿があります。");
  assert.equal(reasonFor({ environment: { issue_or_limit_anomalies_24h: 1 } }), "利用上限まわりの異常が確認されており、リセットの可能性がやや高まっています。");
});

test("uses a short official-notice outlook in English and Chinese", () => {
  assert.equal(
    reasonFor({ locale: "en", notice: officialNotice }),
    "An official reset notice has been confirmed. Considering the notice, the outlook for a reset is higher.",
  );
  assert.equal(
    reasonFor({ locale: "zh", notice: officialNotice }),
    "已确认有官方重置预告。结合预告内容，重置的可能性有所上升。",
  );
});

test("uses clear English and Chinese wording for teaser strength", () => {
  assert.equal(
    reasonFor({ locale: "en", signals: [signal("strong")] }),
    "A post suggesting a reset has been confirmed. The outlook is higher than usual.",
  );
  assert.equal(
    reasonFor({ locale: "en", signals: [signal("weak")] }),
    "A weak reset hint is present.",
  );
  assert.equal(
    reasonFor({ locale: "zh", signals: [signal("strong")] }),
    "已确认有暗示重置的帖子，重置的可能性高于平时。",
  );
  assert.equal(
    reasonFor({ locale: "zh", signals: [signal("weak")] }),
    "目前有一条较弱的重置暗示。",
  );
});

test("matches the existing expectation level in normal explanations", () => {
  assert.match(
    reasonFor({ probability24h: 0.1, probability48h: 0.1 }) ?? "",
    /見込みは低めです。$/,
  );
  assert.match(
    reasonFor({ probability24h: 0.3, probability48h: 0.4, elapsedHours: 20 }) ?? "",
    /見込みは中程度です。$/,
  );
  assert.match(
    reasonFor({ probability24h: 0.3, probability48h: 0.7, elapsedHours: 48 }) ?? "",
    /見込みは高めです。$/,
  );
  assert.match(
    reasonFor({ probability24h: 0.3, probability48h: 0.93, elapsedHours: 96 }) ?? "",
    /見込みは非常に高いです。$/,
  );
});

test("does not use indirect or technical elapsed-time wording", () => {
  const reason = reasonFor({ multiplier: 0.8, elapsedHours: 12 });

  assert.doesNotMatch(reason ?? "", /時間が浅い|低発生帯|経過時間による抑制/);
});

test("elapsed-only publication uses the normal outlook wording despite raw regime diagnostics", () => {
  const regularResetEvents = [regularResetAt("2026-08-03T04:00:00.000Z")];
  assert.match(
    reasonFor({ multiplier: 1.5, elapsedHours: 48, mode: "elapsed-only", regularResetEvents }) ?? "",
    /前回のランダムリセットから2日20時間が経過し、.*中程度です。$/,
  );
  assert.match(
    reasonFor({ locale: "en", multiplier: 1.5, elapsedHours: 48, mode: "elapsed-only", regularResetEvents }) ?? "",
    /It has been 2 days and 20 hours since the last random reset.*moderate\.$/,
  );
  assert.match(
    reasonFor({ locale: "zh", multiplier: 1.5, elapsedHours: 48, mode: "elapsed-only", regularResetEvents }) ?? "",
    /距离上次随机重置已过去2天20小时.*中等水平。$/,
  );
});

test("uses the same expectation conclusion in English and Chinese", () => {
  const regularResetEvents = [regularResetAt("2026-08-02T00:00:00.000Z")];
  assert.equal(
    reasonFor({ locale: "en", probability24h: 0.3, probability48h: 0.4, regularResetEvents }),
    "It has been 2 days and 20 hours since the last random reset, and the next 24–48 hours approach periods when resets have historically been more likely, so the current outlook is moderate.",
  );
  assert.equal(
    reasonFor({ locale: "zh", probability24h: 0.3, probability48h: 0.4, regularResetEvents }),
    "距离上次随机重置已过去2天20小时，未来24至48小时将逐渐接近过去较容易发生重置的时段，因此目前的可能性处于中等水平。",
  );
});

test("does not use regime diagnostics when the published model falls back", () => {
  assert.equal(
    reasonFor({ source: "legacy-shadow-fallback", multiplier: 1.5, elapsedHours: 96 }),
    "前回のランダムリセットから2日20時間が経過しており、現在の予測ではリセットの見込みは中程度です。",
  );
  assert.equal(
    reasonFor({ locale: "en", source: "legacy-shadow-fallback", multiplier: 1.5, elapsedHours: 96 }),
    "It has been 2 days and 20 hours since the last random reset, and the current forecast puts the outlook for a reset at moderate.",
  );
  assert.equal(
    reasonFor({ locale: "zh", source: "legacy-shadow-fallback", multiplier: 1.5, elapsedHours: 96 }),
    "距离上次随机重置已过去2天20小时，根据当前预测，重置的可能性处于中等水平。",
  );
});

test("returns an unavailable explanation when radar data is missing", () => {
  assert.equal(
    getDisplayProbabilityReason(null, undefined, undefined, "ja", undefined, null, NOW),
    "現在の見込みを確認できません。",
  );
});

test("a completed regular boundary consumes an earlier teaser without becoming a random event", () => {
  const regularAt = "2026-08-08T03:32:00.000Z";
  const regularReset = getDueRegularResetEventRows(
    new Date(regularAt),
    "2026-08-01T03:32:00.000Z",
  )[0];
  const now = new Date("2026-08-08T04:00:00.000Z");

  assert.equal(
    reasonFor({
      now,
      regularResetEvents: [regularReset],
      signals: [signal("strong", "2026-08-08T02:00:00.000Z")],
      multiplier: 0.8,
      elapsedHours: 0.5,
      probability24h: 0.1,
      probability48h: 0.1,
    }),
    "前回のランダムリセットから7日が経過しており、現在の予測ではリセットの見込みは低めです。",
  );
});

test("uses minute precision immediately after a random reset despite a regular boundary", () => {
  const randomResetEvents = [randomResetAt("2026-08-03T23:30:00.000Z")];
  const regularResetEvents = [regularResetAt("2026-08-03T23:30:00.000Z")];
  assert.match(
    reasonFor({
      now: NOW,
      formalTiboResets: randomResetEvents,
      regularResetEvents,
      probability24h: 0.1,
      probability48h: 0.1,
    }) ?? "",
    /前回のランダムリセットから30分しか経過しておらず/,
  );
  assert.match(
    reasonFor({
      now: new Date("2026-08-03T23:59:30.000Z"),
      formalTiboResets: [randomResetAt("2026-08-03T23:59:00.000Z")],
      regularResetEvents: [regularResetAt("2026-08-03T23:59:00.000Z")],
      probability24h: 0.1,
      probability48h: 0.1,
    }) ?? "",
    /前回のランダムリセットからまだ1分も経過しておらず/,
  );
  assert.match(
    reasonFor({
      locale: "en",
      now: new Date("2026-08-03T23:59:30.000Z"),
      formalTiboResets: [randomResetAt("2026-08-03T23:59:00.000Z")],
      regularResetEvents: [regularResetAt("2026-08-03T23:59:00.000Z")],
      probability24h: 0.1,
      probability48h: 0.1,
    }) ?? "",
    /Less than a minute has passed since the last random reset/,
  );
  const oneMinuteReason = reasonFor({
    locale: "en",
    now: new Date("2026-08-03T23:31:00.000Z"),
    formalTiboResets: randomResetEvents,
    regularResetEvents: [regularResetAt("2026-08-03T23:30:00.000Z")],
    probability24h: 0.1,
    probability48h: 0.1,
  }) ?? "";
  assert.match(oneMinuteReason, /It has only been 1 minute since the last random reset/);
  assert.doesNotMatch(oneMinuteReason, /1 minute have passed/);

  const thirtyMinuteReason = reasonFor({
    locale: "en",
    now: new Date("2026-08-04T00:00:00.000Z"),
    formalTiboResets: randomResetEvents,
    regularResetEvents: [regularResetAt("2026-08-03T23:30:00.000Z")],
    probability24h: 0.1,
    probability48h: 0.1,
  }) ?? "";
  assert.match(thirtyMinuteReason, /It has only been 30 minutes since the last random reset/);

  const oneHourReason = reasonFor({
    locale: "en",
    now: new Date("2026-08-04T00:30:00.000Z"),
    formalTiboResets: randomResetEvents,
    regularResetEvents: [regularResetAt("2026-08-03T23:30:00.000Z")],
    probability24h: 0.1,
    probability48h: 0.1,
  }) ?? "";
  assert.match(oneHourReason, /It has only been 1 hour since the last random reset/);
  assert.doesNotMatch(oneHourReason, /1 hour have passed/);
});

test("uses the displayed elapsed duration for high and compound-duration explanations", () => {
  assert.match(
    reasonFor({
      probability24h: 0.3,
      probability48h: 0.7,
      regularResetEvents: [regularResetAt("2026-08-02T00:00:00.000Z")],
    }) ?? "",
    /前回のランダムリセットから2日20時間が経過し、.*見込みは高めです。$/,
  );
  assert.match(
    reasonFor({
      probability24h: 0.3,
      probability48h: 0.4,
      regularResetEvents: [regularResetAt("2026-08-02T21:00:00.000Z")],
    }) ?? "",
    /前回のランダムリセットから2日20時間/,
  );
});

test("does not expose raw regime wording in the normal explanation", () => {
  const reason = reasonFor({ multiplier: 1.8, probability24h: 0.3, probability48h: 0.7 });
  assert.doesNotMatch(reason ?? "", /最近はリセットが多い|regime|倍率|低発生帯|時間が浅い/);
});

test("regular recovery boundaries do not increase the random event count", () => {
  const regularAt = "2026-08-08T03:32:00.000Z";
  const regularReset = getDueRegularResetEventRows(
    new Date(regularAt),
    "2026-08-01T03:32:00.000Z",
  )[0];
  const now = new Date("2026-08-08T04:00:00.000Z");
  const withoutRegular = calculateRegimeElapsedProbability(
    getLocalRadarData({ calculationNow: now }),
    { now },
  );
  const withRegular = calculateRegimeElapsedProbability(
    getLocalRadarData({ calculationNow: now, regularResetEvents: [regularReset] }),
    { now },
  );

  assert.equal(
    withRegular.regimeElapsed.randomBoundaryCount,
    withoutRegular.regimeElapsed.randomBoundaryCount,
  );
  assert.ok(
    withRegular.regimeElapsed.regularBoundaryCount >=
      withoutRegular.regimeElapsed.regularBoundaryCount,
  );
});

test("display reasoning does not change public probabilities", () => {
  const data = getLocalRadarData({ calculationNow: NOW });
  const before = getRadarViewModel(data, "ja", false, undefined, NOW);

  getDisplayProbabilityReason(
    data,
    before.probability24h,
    before.probability48h,
    "ja",
    getLocalSignalEvaluation(data, NOW),
    null,
    NOW,
    modelContext(0.8, 12),
  );

  const after = getRadarViewModel(data, "ja", false, undefined, NOW);

  assert.deepEqual(
    {
      probability12h: after.probability12h,
      probability24h: after.probability24h,
      probability48h: after.probability48h,
      probability72h: after.probability72h,
    },
    {
      probability12h: before.probability12h,
      probability24h: before.probability24h,
      probability48h: before.probability48h,
      probability72h: before.probability72h,
    },
  );
});


test("current outlook includes a localized resolved teaser window in all supported locales", () => {
  const now = new Date("2026-08-27T07:21:00.000Z");
  const timedSignal = {
    tweet_id: "timed-outlook-teaser",
    signal_type: "teaser" as const,
    text: "Intrigued to see if I can find the reset button tomorrow.",
    tweet_created_at: "2026-08-27T06:31:31.000Z",
    teaser_strength: "strong" as const,
    confidence: 0.85,
    verification_status: "confirmed" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "day" as const,
    temporal_confidence: 0.95,
    expected_start_at: "2026-08-27T07:00:00.000Z",
    expected_end_at: "2026-08-28T07:00:00.000Z",
  };
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [timedSignal],
    recentTiboSignals: [timedSignal],
  });
  const evaluation = getLocalSignalEvaluation(data, now);

  const ja = getDisplayProbabilityReason(data, 0.54, 0.79, "ja", evaluation, null, now);
  const en = getDisplayProbabilityReason(data, 0.54, 0.79, "en", evaluation, null, now);
  const zh = getDisplayProbabilityReason(data, 0.54, 0.79, "zh", evaluation, null, now);

  assert.match(ja ?? "", /Tiboがリセットを強く示唆/);
  assert.match(ja ?? "", /示唆された時間帯/);
  assert.match(ja ?? "", /2026\/08\/27/);
  assert.match(en ?? "", /Tibo is strongly hinting at a reset/);
  assert.match(en ?? "", /hinted window/);
  assert.match(en ?? "", /08\/27\/2026/);
  assert.match(zh ?? "", /Tibo 正在强烈暗示/);
  assert.match(zh ?? "", /时间窗口/);
  assert.match(zh ?? "", /2026\/08\/27/);
});


test("current outlook explains the gradual fade during a timed teaser grace period in all locales", () => {
  const now = new Date("2026-08-28T08:30:00.000Z");
  const timedSignal = {
    tweet_id: "timed-grace-outlook",
    signal_type: "teaser" as const,
    text: "Reset button tomorrow.",
    tweet_created_at: "2026-08-27T06:31:31.000Z",
    teaser_strength: "strong" as const,
    confidence: 0.85,
    verification_status: "confirmed" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "day" as const,
    temporal_confidence: 0.95,
    expected_start_at: "2026-08-27T07:00:00.000Z",
    expected_end_at: "2026-08-28T07:00:00.000Z",
    expires_at: "2026-08-28T10:00:00.000Z",
  };
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [timedSignal],
    recentTiboSignals: [timedSignal],
  });
  const evaluation = getLocalSignalEvaluation(data, now);

  const ja = getDisplayProbabilityReason(data, 0.50, 0.75, "ja", evaluation, null, now);
  const en = getDisplayProbabilityReason(data, 0.50, 0.75, "en", evaluation, null, now);
  const zh = getDisplayProbabilityReason(data, 0.50, 0.75, "zh", evaluation, null, now);

  assert.match(ja ?? "", /まだ通常より高め/);
  assert.match(en ?? "", /still higher than usual/);
  assert.match(zh ?? "", /仍高于平时/);
});


test("strong timed teaser outlook says strength is included in all supported locales", () => {
  const now = new Date("2026-08-27T08:30:00.000Z");
  const timedSignal = {
    tweet_id: "strong-timed-outlook",
    signal_type: "teaser" as const,
    text: "Reset button tomorrow.",
    tweet_created_at: "2026-08-27T06:31:31.000Z",
    teaser_strength: "strong" as const,
    confidence: 0.85,
    verification_status: "confirmed" as const,
    is_reply: false,
    temporal_resolution_status: "resolved" as const,
    temporal_precision: "day" as const,
    temporal_confidence: 0.95,
    expected_start_at: "2026-08-27T07:00:00.000Z",
    expected_end_at: "2026-08-28T07:00:00.000Z",
  };
  const data = getLocalRadarData({
    calculationNow: now,
    activeTiboSignals: [timedSignal],
    recentTiboSignals: [timedSignal],
  });
  const evaluation = getLocalSignalEvaluation(data, now);

  const ja = getDisplayProbabilityReason(data, 0.65, 0.85, "ja", evaluation, null, now);
  const en = getDisplayProbabilityReason(data, 0.65, 0.85, "en", evaluation, null, now);
  const zh = getDisplayProbabilityReason(data, 0.65, 0.85, "zh", evaluation, null, now);

  assert.match(ja ?? "", /Tiboがリセットを強く示唆/);
  assert.match(ja ?? "", /通常よりリセットの可能性が高まっています/);
  assert.match(en ?? "", /Tibo is strongly hinting at a reset/);
  assert.match(en ?? "", /chance of a reset is higher than usual/);
  assert.match(zh ?? "", /Tibo 正在强烈暗示/);
  assert.match(zh ?? "", /重置的可能性高于平时/);
});
