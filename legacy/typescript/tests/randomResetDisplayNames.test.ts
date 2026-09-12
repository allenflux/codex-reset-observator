import assert from "node:assert/strict";
import test from "node:test";

import { getRadarViewModel } from "../lib/radar";
import { toPublicRadarSnapshot } from "../lib/radar/publicDto";
import {
  assessRandomResetNameResult,
  buildRandomResetNamePrompt,
  parseRandomResetNameResponse,
  parseRandomResetNameV3Response,
  parseRandomResetNameV2Response,
  RANDOM_RESET_NAME_MAX_LENGTH,
  RANDOM_RESET_NAME_PROMPT_VERSION,
  RANDOM_RESET_NAME_TEMPERATURE,
  RANDOM_RESET_NAME_V2_PROMPT_VERSION,
  RANDOM_RESET_NAME_V3_SYSTEM_PROMPT,
  RANDOM_RESET_NAME_V2_SYSTEM_PROMPT,
  generateRandomResetName,
  toRandomResetNameInput,
} from "../lib/radar/randomResetNaming";
import {
  getResetDisplayNameEventKey,
  isGenericResetDisplayTitle,
  isSafeStoredAiResetName,
  resolveJapaneseResetDisplayName,
  resolveResetDisplayTitle,
} from "../lib/radar/resetDisplayNames";
import { getLocalRadarData } from "../lib/radar";
import { getCompletedResetTimestamp } from "../lib/radar/probability";
import { isEligibleRandomResetEvent } from "../lib/radar/resetEligibility";
import {
  getResetDisplayNameWritePayload,
  hashResetDisplayNameInput,
  isSafeAcceptedPrecomputedResetDisplayName,
  shouldPreserveExistingAcceptedResetDisplayName,
  shouldSkipResetDisplayNameGenerationWithoutSource,
  shouldReuseResetDisplayNameResult,
} from "../lib/radar/resetDisplayNameStore";
import {
  canApplyRandomResetDisplayNameStatus,
  isRandomResetDisplayNameApplyMode,
} from "../scripts/backfill-random-reset-display-names";
import type { ResetDisplayNameRecord, WindowEventLike } from "../lib/radar/types";

const completedAt = "2026-08-08T04:32:00.000Z";
const sourceUrl = "https://x.com/thsottiaux/status/2086188036493344823";

function resetItem(overrides: Partial<WindowEventLike> = {}): WindowEventLike {
  return {
    id: "tibo-reset-2086188036493344823",
    recordKind: "confirmed_global",
    title: "ランダムリセット",
    kind: "reset_completed",
    status: "closed",
    closed_at: completedAt,
    completed_at: completedAt,
    opened_at: completedAt,
    source_url: sourceUrl,
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "なし",
      note: "Tibo氏がCodexの利用上限リセット完了を発表しました。",
    },
    ...overrides,
  };
}

function acceptedRecord(overrides: Partial<ResetDisplayNameRecord> = {}): ResetDisplayNameRecord {
  return {
    event_key: "tibo-reset-2086188036493344823",
    source_tweet_id: "2086188036493344823",
    manual_name_ja: null,
    ai_name_ja: "週末の利用上限リセット",
    ai_confidence: 0.86,
    ai_evidence: "weekend",
    ai_reason: "入力された投稿の週末という特徴を使った。",
    ai_model: "gemini-3.5-flash-lite",
    ai_prompt_version: "random-reset-name-v1",
    ai_input_mode: "metadata+source",
    ai_status: "accepted",
    ai_flags: [],
    ai_generated_at: "2026-08-08T04:00:00.000Z",
    input_hash: "hash",
    ...overrides,
  };
}

test("display-name safety accepts only grounded, sufficiently confident names", () => {
  const item = resetItem({ summary: "weekend reset" });
  const input = toRandomResetNameInput(item, Date.parse(completedAt));
  input.sourcePostText = "A weekend reset is live.";

  const accepted = parseRandomResetNameResponse(
    {
      name: "週末の利用上限リセット",
      confidence: 0.86,
      evidence: "weekend",
      reason: "入力にある特徴だけを使った。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(assessRandomResetNameResult(accepted).status, "accepted");

  const lowConfidence = parseRandomResetNameResponse(
    {
      name: "週末の利用上限リセット",
      confidence: 0.69,
      evidence: "weekend",
      reason: "入力にある特徴だけを使った。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(assessRandomResetNameResult(lowConfidence).status, "review_required");

  const hallucinated = parseRandomResetNameResponse(
    {
      name: "GPT-5公開記念リセット",
      confidence: 0.95,
      evidence: "weekend",
      reason: "モデル名を補った。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(assessRandomResetNameResult(hallucinated).status, "review_required");
});

test("production v3 naming uses the descriptive prompt and accepts grounded localized names", () => {
  const item = resetItem();
  const input = toRandomResetNameInput(item, Date.parse(completedAt));
  input.sourcePostText = "To celebrate 100,000 Luna threads this weekend, I reset Codex limits.";

  assert.equal(RANDOM_RESET_NAME_PROMPT_VERSION, "random-reset-name-v3");
  assert.equal(RANDOM_RESET_NAME_TEMPERATURE, 0.2);
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /distinctive product names, model names, concrete numbers/);
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /grounded metaphor, joke, phrase, mood, or motif/i);
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /nameJa/);
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /nameEn/);
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /nameZh/);

  const result = parseRandomResetNameV3Response(
    {
      nameJa: "Luna 10万スレッド週末解放記念リセット",
      nameEn: "Luna 100k Thread Weekend Reset",
      nameZh: "Luna 10万线程周末重置",
      reason: "原文にあるLunaスレッド数と週末の解放内容を要約した。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(result.status, "success");
  assert.equal(result.promptVersion, RANDOM_RESET_NAME_PROMPT_VERSION);
  assert.equal(result.confidence, null);
  assert.equal(result.evidence, null);
  assert.equal(assessRandomResetNameResult(result).status, "accepted");
});

test("production v3 naming rejects unsupported or generic generated names", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "Good feedback today, and I reset the limits.";

  const unsupported = parseRandomResetNameV3Response(
    {
      nameJa: "GPT-5.6公開記念リセット",
      nameEn: "GPT-5.6 Launch Reset",
      nameZh: "GPT-5.6发布重置",
      reason: "モデル名を要約した。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(unsupported.status, "success");
  assert.equal(assessRandomResetNameResult(unsupported).status, "review_required");

  const generic = parseRandomResetNameV3Response(
    {
      nameJa: "ランダムリセット",
      nameEn: "Random reset",
      nameZh: "随机重置",
      reason: "具体的な特徴がない。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(assessRandomResetNameResult(generic).status, "review_required");

  const malformed = parseRandomResetNameV3Response(
    {
      nameJa: "週末イベント",
      nameEn: "Weekend event",
      nameZh: "周末活动",
      reason: "語尾が要件を満たさない。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(malformed.status, "invalid_schema");
  assert.equal(RANDOM_RESET_NAME_MAX_LENGTH, 40);
});

test("production Gemini requests use the v3 prompt, temperature, and parser", async () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "To celebrate 100,000 Luna threads this weekend, I reset Codex limits.";
  const originalFetch = globalThis.fetch;
  type GeminiRequest = {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    generationConfig?: { temperature?: number };
  };
  let requestJson: string | null = null;
  globalThis.fetch = async (_input, init) => {
    requestJson = String(init?.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        nameJa: "Luna 10万スレッド週末解放記念リセット",
        nameEn: "Luna 100k Thread Weekend Reset",
        nameZh: "Luna 10万线程周末重置",
        reason: "原文の具体的なスレッド数と週末の解放を要約した。",
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await generateRandomResetName(input, {
      apiKey: "test-key",
      timeoutMs: 1_000,
    });
    assert.equal(result.promptVersion, RANDOM_RESET_NAME_PROMPT_VERSION);
    assert.equal(assessRandomResetNameResult(result).status, "accepted");
    const capturedRequest = JSON.parse(requestJson ?? "{}") as GeminiRequest;
    assert.equal(capturedRequest.generationConfig?.temperature, RANDOM_RESET_NAME_TEMPERATURE);
    assert.equal(capturedRequest.contents?.[0]?.parts?.[0]?.text, RANDOM_RESET_NAME_V3_SYSTEM_PROMPT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production naming failures remain best-effort webhook-safe results", async () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "A reset is available for the weekend.";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429, headers: { "retry-after": "5" } });
  try {
    const result = await generateRandomResetName(input, { apiKey: "test-key", timeoutMs: 1_000 });
    assert.equal(result.status, "rate_limited");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("null, API error, and rate-limited results remain safe fallbacks", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  const empty = parseRandomResetNameResponse(
    { name: null, confidence: 0.2, evidence: null, reason: "特徴が不足している。" },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(assessRandomResetNameResult(empty).status, "null");
  assert.equal(assessRandomResetNameResult({ ...empty, status: "api_error" }).status, "api_error");
  assert.equal(assessRandomResetNameResult({ ...empty, status: "rate_limited" }).status, "rate_limited");
  assert.equal(resolveJapaneseResetDisplayName(resetItem(), null), "ランダムリセット");
});

test("production prompt uses recorded facts without passing an existing human title", () => {
  const input = toRandomResetNameInput(
    resetItem({ title: "1000万人到達記念リセット", summary: "weekend reset" }),
    Date.parse(completedAt),
  );
  input.sourcePostText = "A weekend reset is live.";
  const prompt = buildRandomResetNamePrompt(input);
  assert.equal(prompt.includes("1000万人到達記念リセット"), false);
  assert.equal(prompt.includes("A weekend reset is live."), true);
  assert.equal(prompt.includes("existing title"), false);
});

test("Japanese display priority preserves human titles and accepts only safe AI names", () => {
  const item = resetItem();
  const record = acceptedRecord();
  assert.equal(isGenericResetDisplayTitle("ご祝儀リセット"), true);
  assert.equal(resolveJapaneseResetDisplayName(item, record), "週末の利用上限リセット");
  assert.equal(
    resolveJapaneseResetDisplayName(
      { ...item, title: "1000万人到達記念リセット" },
      record,
    ),
    "1000万人到達記念リセット",
  );
  assert.equal(
    resolveJapaneseResetDisplayName(item, { ...record, manual_name_ja: "手動確認名" }),
    "手動確認名",
  );
  assert.equal(resolveResetDisplayTitle(item, record, "en"), "ランダムリセット");
  assert.equal(resolveResetDisplayTitle(item, record, "zh"), "ランダムリセット");

  const v2Record = acceptedRecord({
    ai_prompt_version: RANDOM_RESET_NAME_V2_PROMPT_VERSION,
    ai_confidence: null,
    ai_evidence: null,
  });
  assert.equal(isSafeStoredAiResetName(v2Record), true);
  assert.equal(resolveJapaneseResetDisplayName(item, v2Record), "週末の利用上限リセット");
});

test("only completed broad random resets are naming candidates", () => {
  const now = Date.parse("2026-08-09T00:00:00.000Z");
  const regular = resetItem({
    id: "regular-reset",
    recordKind: "regular_completed",
    details: { ...resetItem().details!, cycleType: "定期リセット", reasonType: "定期更新" },
  });
  const narrow = resetItem({ scope: "限定ユーザー" });
  const pending = resetItem({ status: "pending", closed_at: null, completed_at: null });
  assert.equal(isEligibleRandomResetEvent(resetItem(), getCompletedResetTimestamp(resetItem()), now), true);
  assert.equal(isEligibleRandomResetEvent(regular, getCompletedResetTimestamp(regular), now), false);
  assert.equal(isEligibleRandomResetEvent(narrow, getCompletedResetTimestamp(narrow), now), false);
  assert.equal(isEligibleRandomResetEvent(pending, getCompletedResetTimestamp(pending), now), false);
});

test("metadata-only and exact source inputs are distinguishable without title leakage", () => {
  const item = resetItem({ title: "具体的な人間タイトル" });
  const input = toRandomResetNameInput(item, Date.parse(completedAt));
  assert.equal(input.sourcePostText, null);
  assert.equal(buildRandomResetNamePrompt(input).includes("具体的な人間タイトル"), false);
  input.sourcePostText = "Exact source text";
  assert.equal(buildRandomResetNamePrompt(input).includes("Exact source text"), true);
});

test("display-name event keys are stable and source-linked", () => {
  assert.equal(getResetDisplayNameEventKey(resetItem()), "tibo-reset-2086188036493344823");
  assert.equal(
    getResetDisplayNameEventKey({ title: "ランダムリセット", source_url: sourceUrl }),
    "tibo-reset-2086188036493344823",
  );
});

test("input hashes and stored result reuse are idempotent", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  const hash = hashResetDisplayNameInput(input, null);
  const same = hashResetDisplayNameInput(input, null);
  assert.equal(hash, same);
  const record = acceptedRecord({
    input_hash: hash,
    ai_prompt_version: RANDOM_RESET_NAME_PROMPT_VERSION,
    ai_confidence: null,
    ai_evidence: null,
  });
  assert.equal(shouldReuseResetDisplayNameResult(record, hash, "gemini-3.5-flash-lite"), true);
  assert.equal(shouldReuseResetDisplayNameResult(record, "different", "gemini-3.5-flash-lite"), false);
  assert.equal(shouldReuseResetDisplayNameResult({ ...record, ai_status: "api_error" }, hash, "gemini-3.5-flash-lite"), false);
});

test("existing accepted v1 names are preserved and source-less events skip Gemini", () => {
  assert.equal(shouldPreserveExistingAcceptedResetDisplayName(acceptedRecord()), true);
  assert.equal(
    shouldPreserveExistingAcceptedResetDisplayName(
      acceptedRecord({ ai_prompt_version: RANDOM_RESET_NAME_PROMPT_VERSION, ai_confidence: null, ai_evidence: null }),
    ),
    false,
  );
  assert.equal(shouldSkipResetDisplayNameGenerationWithoutSource(null), true);
  assert.equal(shouldSkipResetDisplayNameGenerationWithoutSource("  "), true);
  assert.equal(shouldSkipResetDisplayNameGenerationWithoutSource("Original Tibo post"), false);
});

test("safe accepted notice-precomputed names require explicit provenance", () => {
  const precomputed = acceptedRecord({
    ai_name_en: "Astra Celebration Reset",
    ai_name_zh: "Astra纪念重置",
    ai_prompt_version: RANDOM_RESET_NAME_PROMPT_VERSION,
    ai_input_mode: "notice-precompute-v1",
    ai_confidence: null,
    ai_evidence: null,
  });
  assert.equal(isSafeAcceptedPrecomputedResetDisplayName(precomputed), true);
  assert.equal(
    isSafeAcceptedPrecomputedResetDisplayName({ ...precomputed, ai_input_mode: "metadata+source" }),
    false,
  );
  assert.equal(
    isSafeAcceptedPrecomputedResetDisplayName({ ...precomputed, ai_flags: ["unsupported_official_claim"] }),
    false,
  );
});

test("accepted-only backfill writes are explicit and retryable failures stay retryable", () => {
  assert.equal(isRandomResetDisplayNameApplyMode(["node", "script"]), false);
  assert.equal(isRandomResetDisplayNameApplyMode(["node", "script", "--apply"]), true);
  assert.equal(canApplyRandomResetDisplayNameStatus("accepted"), true);
  assert.equal(canApplyRandomResetDisplayNameStatus("null"), false);
  assert.equal(canApplyRandomResetDisplayNameStatus("review_required"), false);
  assert.equal(canApplyRandomResetDisplayNameStatus("api_error"), false);
});

test("accepted write payload keeps manual and audit fields separate", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  const result = parseRandomResetNameResponse(
    { name: "週末の利用上限リセット", confidence: 0.9, evidence: "weekend", reason: "記録済み。" },
    { ...input, recordedSummary: "weekend" },
    "gemini-3.5-flash-lite",
  );
  const payload = getResetDisplayNameWritePayload({
    eventKey: "event-key",
    sourceTweetId: "2086188036493344823",
    inputMode: "metadata+source",
    inputHash: "hash",
    result,
    existing: acceptedRecord({ manual_name_ja: "手動名" }),
    generatedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(payload.event_key, "event-key");
  assert.equal(payload.manual_name_ja, "手動名");
  assert.equal(payload.ai_name_ja, "週末の利用上限リセット");
  assert.equal("title" in payload, false);
});

test("AI display names affect titles without changing public audit fields or probabilities", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");
  const withName = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: [{
      tweet_id: "2086188036493344823",
      text: "A weekend reset is live.",
      tweet_url: sourceUrl,
      tweet_created_at: completedAt,
      detected_at: completedAt,
      signal_type: "reset_executed",
      confidence: 0.98,
      verification_status: "confirmed",
      classification_source: "gemini",
    }],
    resetDisplayNames: [acceptedRecord()],
  });
  const withoutName = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: withName.formal_tibo_resets,
  });
  const ja = getRadarViewModel(withName, "ja", true, undefined, now);
  const en = getRadarViewModel(withName, "en", true, undefined, now);
  const baseline = getRadarViewModel(withoutName, "ja", true, undefined, now);
  const jaItem = ja.recentHistory.find((item) => item.key === "tibo-reset-2086188036493344823");
  const enItem = en.recentHistory.find((item) => item.key === "tibo-reset-2086188036493344823");
  assert.equal(jaItem?.title, "週末の利用上限リセット");
  assert.equal(enItem?.title, "Random reset");
  assert.equal(ja.probability24h, baseline.probability24h);
  assert.equal(ja.probability48h, baseline.probability48h);

  const publicSnapshot = toPublicRadarSnapshot(withName, "ja", { calculationNow: now });
  const serialized = JSON.stringify(publicSnapshot);
  assert.equal(publicSnapshot.schemaVersion, "public-v1");
  assert.equal(serialized.includes("ai_reason"), false);
  assert.equal(serialized.includes("reset_display_names"), false);
  assert.equal(serialized.includes("random-reset-name-v1"), false);
});

test("manual Japanese display names use localized fallbacks on history pages", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const manualName = "Codex利用制限改善対応リセット";
  const data = getLocalRadarData({
    calculationNow: now,
    formalTiboResets: [{
      tweet_id: "2086188036493344823",
      text: "A weekend reset is live.",
      tweet_url: sourceUrl,
      tweet_created_at: completedAt,
      detected_at: completedAt,
      signal_type: "reset_executed",
      confidence: 0.98,
      verification_status: "confirmed",
      classification_source: "gemini",
    }],
    resetDisplayNames: [{
      ...acceptedRecord(),
      manual_name_ja: manualName,
    }],
  });

  assert.equal(
    getRadarViewModel(data, "ja", true, undefined, now).recentHistory.find(
      (item) => item.key === "tibo-reset-2086188036493344823",
    )?.title,
    manualName,
  );
  assert.equal(
    getRadarViewModel(data, "en", true, undefined, now).recentHistory.find(
      (item) => item.key === "tibo-reset-2086188036493344823",
    )?.title,
    "Codex Usage Limit Improvement Reset",
  );
  assert.equal(
    getRadarViewModel(data, "zh", true, undefined, now).recentHistory.find(
      (item) => item.key === "tibo-reset-2086188036493344823",
    )?.title,
    "Codex 使用限制改进重置",
  );
});

test("legacy v2 names remain accepted and preserved during the v3 rollout", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "A weekend reset is live.";
  const result = parseRandomResetNameV2Response(
    { name: "週末の利用上限リセット", reason: "原文の週末という特徴を使った。" },
    input,
    "gemini-3.5-flash-lite",
  );

  assert.equal(result.promptVersion, RANDOM_RESET_NAME_V2_PROMPT_VERSION);
  assert.equal(assessRandomResetNameResult(result).status, "accepted");
  assert.equal(RANDOM_RESET_NAME_V2_SYSTEM_PROMPT.includes("Always end with 「リセット」"), true);
  assert.equal(
    shouldPreserveExistingAcceptedResetDisplayName(
      acceptedRecord({ ai_prompt_version: RANDOM_RESET_NAME_V2_PROMPT_VERSION }),
    ),
    true,
  );
  assert.equal(
    isSafeStoredAiResetName(
      acceptedRecord({ ai_prompt_version: RANDOM_RESET_NAME_V2_PROMPT_VERSION }),
    ),
    true,
  );
});

test("production v3 naming accepts one grounded name per locale", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "Never slept better and feeling reseted. Brand new me and brand new usage for all ChatGPT Work and Codex users. Regaining my youth one button press at a time.";

  const result = parseRandomResetNameV3Response(
    {
      nameJa: "快眠若返り記念リセット",
      nameEn: "Better Sleep, New Me Reset",
      nameZh: "睡得更好、焕然一新重置",
      reason: "原文の快眠と若返りの表現を、3言語で同じ出来事として要約した。",
    },
    input,
    "gemini-3.5-flash-lite",
  );

  assert.equal(result.status, "success");
  assert.equal(result.name, "快眠若返り記念リセット");
  assert.equal(result.nameEn, "Better Sleep, New Me Reset");
  assert.equal(result.nameZh, "睡得更好、焕然一新重置");
  assert.equal(result.promptVersion, RANDOM_RESET_NAME_PROMPT_VERSION);
  assert.equal(assessRandomResetNameResult(result).status, "accepted");
  const payload = getResetDisplayNameWritePayload({
    eventKey: "tibo-reset-2086188036493344823",
    sourceTweetId: "2086188036493344823",
    inputMode: "metadata+source",
    inputHash: "localized-hash",
    result,
    existing: null,
    generatedAt: "2026-08-28T00:00:00.000Z",
  });
  assert.equal(payload.ai_name_en, "Better Sleep, New Me Reset");
  assert.equal(payload.ai_name_zh, "睡得更好、焕然一新重置");
  assert.match(RANDOM_RESET_NAME_V3_SYSTEM_PROMPT, /grounded metaphor, joke, phrase, mood, or motif/i);
});

test("production v3 naming rejects partial or generic localized output", () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "A weekend reset is live.";

  const partial = parseRandomResetNameV3Response(
    {
      nameJa: "週末のリセット",
      nameEn: null,
      nameZh: "周末重置",
      reason: "英語名がありません。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(partial.status, "invalid_schema");

  const generic = parseRandomResetNameV3Response(
    {
      nameJa: "ランダムリセット",
      nameEn: "Random reset",
      nameZh: "随机重置",
      reason: "具体的な特徴がない。",
    },
    input,
    "gemini-3.5-flash-lite",
  );
  assert.equal(generic.status, "success");
  assert.equal(assessRandomResetNameResult(generic).status, "review_required");
});

test("production v3 Gemini request returns all locales with one API call", async () => {
  const input = toRandomResetNameInput(resetItem(), Date.parse(completedAt));
  input.sourcePostText = "Never slept better and feeling reseted. Brand new me and brand new usage for all ChatGPT Work and Codex users. Regaining my youth one button press at a time.";
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let requestJson: string | null = null;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    requestJson = String(init?.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        nameJa: "快眠若返り記念リセット",
        nameEn: "Better Sleep, New Me Reset",
        nameZh: "睡得更好、焕然一新重置",
        reason: "原文の印象的な表現を要約した。",
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await generateRandomResetName(input, {
      apiKey: "test-key",
      timeoutMs: 1_000,
    });
    assert.equal(requestCount, 1);
    assert.equal(result.nameEn, "Better Sleep, New Me Reset");
    assert.equal(result.nameZh, "睡得更好、焕然一新重置");
    assert.equal(assessRandomResetNameResult(result).status, "accepted");
    const capturedRequest = JSON.parse(requestJson ?? "{}") as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    assert.equal(capturedRequest.contents?.[0]?.parts?.[0]?.text, RANDOM_RESET_NAME_V3_SYSTEM_PROMPT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("localized AI display names are selected without changing the public DTO", () => {
  const item = resetItem();
  const record = acceptedRecord({
    ai_prompt_version: RANDOM_RESET_NAME_PROMPT_VERSION,
    ai_name_ja: "快眠若返り記念リセット",
    ai_name_en: "Better Sleep, New Me Reset",
    ai_name_zh: "睡得更好、焕然一新重置",
    ai_confidence: null,
    ai_evidence: null,
  });

  assert.equal(resolveResetDisplayTitle(item, record, "ja"), "快眠若返り記念リセット");
  assert.equal(resolveResetDisplayTitle(item, record, "en"), "Better Sleep, New Me Reset");
  assert.equal(resolveResetDisplayTitle(item, record, "zh"), "睡得更好、焕然一新重置");
  assert.equal(
    resolveResetDisplayTitle({ ...item, title: "人手確認済みのリセット" }, record, "en"),
    "人手確認済みのリセット",
  );

  const formalSignal = {
    tweet_id: "2086188036493344823",
    text: "Never slept better and feeling reseted.",
    tweet_url: sourceUrl,
    tweet_created_at: completedAt,
    detected_at: completedAt,
    signal_type: "reset_executed" as const,
    confidence: 0.98,
    verification_status: "confirmed" as const,
    classification_source: "gemini",
  };
  const localizedData = getLocalRadarData({
    formalTiboResets: [formalSignal],
    resetDisplayNames: [record],
  });
  const localizedEnItem = getRadarViewModel(
    localizedData,
    "en",
    true,
    undefined,
    new Date("2026-08-09T00:00:00.000Z"),
  ).recentHistory.find((historyItem) => historyItem.key === "tibo-reset-2086188036493344823");
  const localizedZhItem = getRadarViewModel(
    localizedData,
    "zh",
    true,
    undefined,
    new Date("2026-08-09T00:00:00.000Z"),
  ).recentHistory.find((historyItem) => historyItem.key === "tibo-reset-2086188036493344823");
  assert.equal(localizedEnItem?.title, "Better Sleep, New Me Reset");
  assert.equal(localizedZhItem?.title, "睡得更好、焕然一新重置");

  const snapshot = toPublicRadarSnapshot(
    localizedData,
    "ja",
    { calculationNow: new Date("2026-08-09T00:00:00.000Z") },
  );
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("ai_name_en"), false);
  assert.equal(serialized.includes("ai_name_zh"), false);
});

test("incomplete localized generic titles still use safe localized AI names", () => {
  const item = resetItem({ title: { ja: "ランダムリセット" } });
  const record = acceptedRecord({
    ai_name_en: "Weekend Reset",
    ai_name_zh: "周末重置",
  });

  assert.equal(resolveResetDisplayTitle(item, record, "en"), "Weekend Reset");
  assert.equal(resolveResetDisplayTitle(item, record, "zh"), "周末重置");
});
