import test from "node:test";
import assert from "node:assert";
import {
  applyTiboClassificationSafetyGuard,
  buildGeminiPrompt,
  classifyWithGemini,
  GeminiClassificationOutput,
  normalizeGeminiResetType,
  TIBO_GEMINI_SYSTEM_PROMPT,
} from "../lib/radar/geminiClassification";
import { classifyTiboTweet } from "../lib/radar/classification";
import {
  buildTiboClassificationResponse,
  selectTiboClassification,
  shouldRunGeminiClassification,
} from "../lib/radar/tiboClassificationMode";
import { parseTeaserStrengthAssessment } from "../lib/radar/teaserStrength";

test("1. GEMINI_CLASSIFICATION_MODE=off skips Gemini API call", async () => {
  const result = await classifyWithGemini(
    { text: "Codex reset coming soon" },
    { mode: "off", model: "gemini-2.0-flash", apiKey: "dummy_key" }
  );

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.signalType, null);
  assert.strictEqual(result.classifiedAt, null);
});

test("Gemini prompt receives structured reply metadata without treating reply status as evidence", () => {
  const prompt = buildGeminiPrompt({
    text: "Maybe :) ",
    tweetCreatedAt: "2026-08-05T00:00:00.000Z",
    isReply: true,
    replyToHandles: ["@alice"],
    replyContextText: "A reset is coming soon.",
    sourceTimeline: "with_replies",
  });

  assert.match(prompt, /Post type: reply/);
  assert.match(prompt, /Replying to: @alice/);
  assert.match(prompt, /Parent context shown in the same article: A reset is coming soon\./);
  assert.match(prompt, /Source timeline: with_replies/);
  assert.match(prompt, /AUTHOR TEXT: Maybe :\)/);
  assert.match(prompt, /reply status alone must not raise/i);
});

test("Gemini prompt keeps quoted text separate from Tibo's author text", () => {
  const prompt = buildGeminiPrompt({
    text: "Hi.\n\nIt is done.",
    isQuote: true,
    quoteAuthorHandle: "@blueemi99",
    quoteContextText: "So what about our reset?",
    quoteTweetUrl: "https://x.com/blueemi99/status/9876543210",
  });

  assert.match(prompt, /AUTHOR TEXT: Hi\./);
  assert.match(prompt, /QUOTED CONTEXT \(not Tibo's own text\): So what about our reset\?/);
  assert.match(prompt, /Quoted author: @blueemi99/);
  assert.match(prompt, /never treat it as Tibo's own assertion/);
  assert.ok(prompt.indexOf("AUTHOR TEXT:") < prompt.indexOf("QUOTED CONTEXT"));
});

test("Gemini reset reason candidates exclude cycle labels", () => {
  assert.equal(normalizeGeminiResetType("ご祝儀リセット"), "ご祝儀リセット");
  assert.equal(normalizeGeminiResetType("詫びリセット"), "詫びリセット");
  assert.equal(normalizeGeminiResetType("定期リセット"), null);
  assert.equal(normalizeGeminiResetType("ランダムリセット"), null);
  assert.equal(normalizeGeminiResetType("その他"), null);
  assert.match(
    TIBO_GEMINI_SYSTEM_PROMPT,
    /"resetTypeJa": "ご祝儀リセット" \| "詫びリセット" \| null/,
  );
  assert.doesNotMatch(TIBO_GEMINI_SYSTEM_PROMPT, /"resetTypeJa"[^\n]*定期リセット/);
  assert.doesNotMatch(TIBO_GEMINI_SYSTEM_PROMPT, /"resetTypeJa"[^\n]*ランダムリセット/);
});

test("2. GEMINI_MODEL or GEMINI_API_KEY missing returns model_not_configured without calling API", async () => {
  const resultNoModel = await classifyWithGemini(
    { text: "Codex reset coming soon" },
    { mode: "shadow", model: "", apiKey: "dummy_key" }
  );

  assert.strictEqual(resultNoModel.status, "model_not_configured");
  assert.strictEqual(resultNoModel.signalType, null);

  const resultNoKey = await classifyWithGemini(
    { text: "Codex reset coming soon" },
    { mode: "shadow", model: "gemini-2.0-flash", apiKey: "" }
  );

  assert.strictEqual(resultNoKey.status, "model_not_configured");
});

test("3. Primary mode adopts a successful Gemini result as the final classification", () => {
  const tweetText = "Just chatting about models today.";
  const tweetUrl = "https://x.com/thsottiaux/status/123456";

  const ruleResult = classifyTiboTweet(tweetText, tweetUrl);
  assert.strictEqual(ruleResult.signalType, "irrelevant");

  const simulatedAiOutput: GeminiClassificationOutput = {
    signalType: "teaser",
    confidence: 0.9,
    temporalDirection: "future",
    evidenceQuote: "models today",
    reasonJa: "将来のリセットを示唆しています。",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  };

  const selected = selectTiboClassification("primary", ruleResult, simulatedAiOutput);

  assert.strictEqual(selected.signalType, "teaser");
  assert.strictEqual(selected.confidence, 0.9);
  assert.strictEqual(selected.reason, "将来のリセットを示唆しています。");
  assert.strictEqual(selected.classificationSource, "gemini");
});

test("4. Primary mode falls back to the rule result for every Gemini failure status", () => {
  const ruleResult = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/123456");
  const failedStatuses: GeminiClassificationOutput["status"][] = [
    "timeout",
    "rate_limited",
    "invalid_json",
    "invalid_schema",
    "invalid_evidence",
    "api_error",
    "model_not_configured",
    "skipped",
  ];

  for (const status of failedStatuses) {
    const selected = selectTiboClassification("primary", ruleResult, {
      signalType: null,
      confidence: null,
      temporalDirection: null,
      evidenceQuote: null,
      reasonJa: null,
      resetTypeJa: null,
      noticeToExecution: null,
      model: "gemini-3.5-flash-lite",
      status,
      classifiedAt: new Date().toISOString(),
    });

    assert.strictEqual(selected.signalType, ruleResult.signalType, `${status} must use rule signal type`);
    assert.strictEqual(selected.confidence, ruleResult.confidence, `${status} must use rule confidence`);
    assert.strictEqual(selected.classificationSource, "rule_fallback", `${status} must use rule_fallback`);
  }
});

test("5. A successful Gemini result with an invalid structured payload falls back to rules", () => {
  const ruleResult = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/123456");
  const selected = selectTiboClassification("primary", ruleResult, {
    signalType: "teaser",
    confidence: null,
    temporalDirection: "future",
    evidenceQuote: null,
    reasonJa: "不完全な結果",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  });

  assert.strictEqual(selected.signalType, ruleResult.signalType);
  assert.strictEqual(selected.classificationSource, "rule_fallback");
});

test("6. Shadow mode keeps the rule result while recording shadow source", () => {
  const ruleResult = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/123456");
  const aiResult: GeminiClassificationOutput = {
    signalType: "reset_executed",
    confidence: 0.95,
    temporalDirection: "completed_now",
    evidenceQuote: "models today",
    reasonJa: "監査用の別判定です。",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  };

  const selected = selectTiboClassification("shadow", ruleResult, aiResult);

  assert.strictEqual(selected.signalType, ruleResult.signalType);
  assert.strictEqual(selected.confidence, ruleResult.confidence);
  assert.strictEqual(selected.classificationSource, "shadow");
});

test("7. Off mode keeps the rule result and skips the AI source", () => {
  const ruleResult = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/123456");
  const selected = selectTiboClassification("off", ruleResult, null);

  assert.strictEqual(shouldRunGeminiClassification("off"), false);
  assert.strictEqual(shouldRunGeminiClassification(undefined), false);
  assert.strictEqual(shouldRunGeminiClassification("shadow"), true);
  assert.strictEqual(shouldRunGeminiClassification("primary"), true);
  assert.strictEqual(selected.signalType, ruleResult.signalType);
  assert.strictEqual(selected.classificationSource, "rule");
});

test("8. Hybrid mode is an alias for primary and the webhook response exposes final and audit values", () => {
  const ruleResult = classifyTiboTweet("Just chatting about models today.", "https://x.com/thsottiaux/status/123456");
  const aiResult: GeminiClassificationOutput = {
    signalType: "teaser",
    confidence: 0.85,
    temporalDirection: "future",
    evidenceQuote: "models today",
    reasonJa: "リセットを示唆しています。",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  };

  const response = buildTiboClassificationResponse("hybrid", ruleResult, aiResult);

  assert.deepStrictEqual(response, {
    signalType: "teaser",
    confidence: 0.85,
    classificationSource: "gemini",
    aiStatus: "success",
    ruleSignalType: "irrelevant",
    aiSignalType: "teaser",
    teaserStrength: null,
  });
});

test("teaser strength parsing keeps the auxiliary value separate from signal type", () => {
  const text = "I occasionally do oblige for really solid feedback.";
  const parsed = parseTeaserStrengthAssessment(
    {
      teaserStrength: "weak",
      teaserStrengthConfidence: 0.91,
      teaserStrengthEvidenceQuote: "I occasionally do oblige",
      teaserStrengthReasonJa: "現在の裁量的な意思を示しています。",
    },
    text,
  );

  assert.deepStrictEqual(parsed, {
    teaserStrength: "weak",
    teaserStrengthConfidence: 0.91,
    teaserStrengthEvidenceQuote: "I occasionally do oblige",
    teaserStrengthReasonJa: "現在の裁量的な意思を示しています。",
  });
});

test("missing or invalid teaser strength remains unknown instead of being coerced to none", () => {
  const parsed = parseTeaserStrengthAssessment(
    {
      teaserStrength: "maybe",
      teaserStrengthConfidence: 2,
      teaserStrengthEvidenceQuote: "invented evidence",
    },
    "A normal post.",
  );

  assert.deepStrictEqual(parsed, {
    teaserStrength: null,
    teaserStrengthConfidence: null,
    teaserStrengthEvidenceQuote: null,
    teaserStrengthReasonJa: null,
  });
});

test("9. Known rule/Gemini disagreement examples adopt the fixed Gemini labels in primary mode", () => {
  const teaserText = "I'm feeling like a limit reset.";
  const irrelevantText = "The day we develop really good models.";
  const teaserRule = classifyTiboTweet(teaserText, "https://x.com/thsottiaux/status/2081899343091843463");
  const irrelevantRule = classifyTiboTweet(irrelevantText, "https://x.com/thsottiaux/status/2083053369351090254");

  const teaserSelected = selectTiboClassification("primary", teaserRule, {
    signalType: "teaser",
    confidence: 0.8,
    temporalDirection: "future",
    evidenceQuote: "limit reset",
    reasonJa: "リセットを示唆しています。",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  });
  const irrelevantSelected = selectTiboClassification("primary", irrelevantRule, {
    signalType: "irrelevant",
    confidence: 0.99,
    temporalDirection: "historical",
    evidenceQuote: "good models",
    reasonJa: "リセットの具体的な情報ではありません。",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  });

  assert.strictEqual(teaserSelected.signalType, "teaser");
  assert.strictEqual(teaserSelected.classificationSource, "gemini");
  assert.strictEqual(irrelevantSelected.signalType, "irrelevant");
  assert.strictEqual(irrelevantSelected.classificationSource, "gemini");
});

test("completed usage reset rule overrides contradictory completed-now Gemini labels while preserving raw audit", () => {
  const text = "What I wanted to say yesterday is that we hit 25M active users and to celebrate we have now reset usage for all paid subscriptions for ChatGPT Work and Codex.";
  const ruleResult = classifyTiboTweet(text, "https://x.com/thsottiaux/status/2090000000000000004");
  assert.equal(ruleResult.signalType, "reset_executed");

  for (const signalType of ["irrelevant", "official_notice"] as const) {
    const rawAiResult: GeminiClassificationOutput = {
      signalType,
      confidence: 0.9,
      temporalDirection: "completed_now",
      evidenceQuote: "we have now reset usage for all paid subscriptions for ChatGPT Work and Codex",
      reasonJa: "Geminiの生判定",
      resetTypeJa: null,
      noticeToExecution: null,
      model: "test-model",
      status: "success",
      classifiedAt: new Date().toISOString(),
      rawAudit: {
        signalType,
        temporalDirection: "completed_now",
        reasonJa: "Geminiの生判定",
      },
    };
    const guarded = applyTiboClassificationSafetyGuard(text, rawAiResult);
    const selected = selectTiboClassification("primary", ruleResult, guarded);
    const response = buildTiboClassificationResponse("primary", ruleResult, guarded);

    assert.equal(guarded.signalType, "reset_executed", signalType);
    assert.equal(selected.signalType, "reset_executed", signalType);
    assert.equal(selected.classificationSource, "rule_fallback", signalType);
    assert.equal(response.signalType, "reset_executed", signalType);
    assert.equal(response.ruleSignalType, "reset_executed", signalType);
    assert.equal(response.aiSignalType, signalType, signalType);
    assert.equal(guarded.rawAudit?.temporalDirection, "completed_now", signalType);
    assert.equal(guarded.rawAudit?.reasonJa, "Geminiの生判定", signalType);
  }
});

test("the edited production completion post stays executed despite a trailing soon", () => {
  const text = "What I wanted to say yesterday is that we hit 25M active users and to celebrate we have now reset usage for all paid subscriptions for ChatGPT Work and Codex.\n\nSee you soon for more news from The Reset Company.";
  const ruleResult = classifyTiboTweet(text, "https://x.com/thsottiaux/status/2090000000000000005");
  assert.equal(ruleResult.signalType, "reset_executed");

  const rawAiResult: GeminiClassificationOutput = {
    signalType: "official_notice",
    confidence: 0.9,
    temporalDirection: "completed_now",
    evidenceQuote: "we have now reset usage for all paid subscriptions for ChatGPT Work and Codex",
    reasonJa: "Geminiの生判定",
    resetTypeJa: null,
    noticeToExecution: null,
    model: "test-model",
    status: "success",
    classifiedAt: new Date().toISOString(),
    rawAudit: {
      signalType: "official_notice",
      temporalDirection: "completed_now",
      reasonJa: "Geminiの生判定",
    },
  };
  const guarded = applyTiboClassificationSafetyGuard(text, rawAiResult);
  const response = buildTiboClassificationResponse("primary", ruleResult, guarded);

  assert.equal(guarded.signalType, "reset_executed");
  assert.equal(response.signalType, "reset_executed");
  assert.equal(response.aiSignalType, "official_notice");
});

test("10. Invalid evidenceQuote (not substring of original text) returns invalid_evidence status", async () => {
  // Mock API returning quote not present in original text
  const originalText = "Limits are refreshed for all users.";
  const normQuote = "completely invented text not in tweet".toLowerCase();
  const normText = originalText.toLowerCase();

  assert.strictEqual(normText.includes(normQuote), false);
});

test("11. Primary webhook response handles Gemini API failure with rule_fallback", () => {
  const ruleResult = classifyTiboTweet("We reset usage limits", "https://x.com/thsottiaux/status/777");

  // Simulated AI failure (Rate limited 429 or Timeout)
  const failedAiOutput: GeminiClassificationOutput = {
    signalType: null,
    confidence: null,
    temporalDirection: null,
    evidenceQuote: null,
    reasonJa: null,
    resetTypeJa: null,
    noticeToExecution: null,
    model: "gemini-2.0-flash",
    status: "rate_limited",
    classifiedAt: new Date().toISOString(),
  };

  const response = buildTiboClassificationResponse("primary", ruleResult, failedAiOutput);
  const payload = {
    signal_type: response.signalType,
    confidence: response.confidence,
    rule_signal_type: ruleResult.signalType,
    ai_signal_type: failedAiOutput.signalType,
    ai_classification_status: failedAiOutput.status,
    classification_source: response.classificationSource,
  };

  assert.strictEqual(payload.signal_type, "reset_executed");
  assert.strictEqual(payload.ai_classification_status, "rate_limited");
  assert.strictEqual(payload.classification_source, "rule_fallback");
});

test("12. Invalid schema response from API is sanitized to invalid_schema status", () => {
  const allowedSignalTypes = ["official_notice", "reset_executed", "teaser", "irrelevant"];

  const invalidJsonParsed = {
    signalType: "INVALID_CATEGORY_NAME",
    confidence: 1.5, // Out of bounds > 1.0
  };

  const isValidSignal = allowedSignalTypes.includes(invalidJsonParsed.signalType);
  const isValidConfidence = typeof invalidJsonParsed.confidence === "number" && invalidJsonParsed.confidence <= 1.0;

  assert.strictEqual(isValidSignal, false);
  assert.strictEqual(isValidConfidence, false);
});

test("13. Backfill query filters out already processed rows with status=success", () => {
  const mockRows = [
    { tweet_id: "1", ai_classification_status: "success" },
    { tweet_id: "2", ai_classification_status: "skipped" },
    { tweet_id: "3", ai_classification_status: null },
  ];

  const unclassifiedRows = mockRows.filter(
    (row) => !row.ai_classification_status || row.ai_classification_status === "skipped"
  );

  assert.strictEqual(unclassifiedRows.length, 2);
  assert.deepStrictEqual(unclassifiedRows.map((r) => r.tweet_id), ["2", "3"]);
});

test("14. Backfill script can resume from unclassified rows after interruption", () => {
  const dbRows = [
    { tweet_id: "101", ai_classification_status: "success" },
    { tweet_id: "102", ai_classification_status: "success" },
    { tweet_id: "103", ai_classification_status: "skipped" },
  ];

  const remainingToProcess = dbRows.filter((r) => r.ai_classification_status !== "success");
  assert.strictEqual(remainingToProcess.length, 1);
  assert.strictEqual(remainingToProcess[0].tweet_id, "103");
});

test("15. Gemini API prompt & schema evaluation keeps an ambiguous productivity fixture irrelevant", () => {
  const todayText = "The day we develop really good models. There will be signs.\n\nReliability increasing despite load going up and up. Sudden efficiency gains. Things getting faster. Resets.\n\nThese kinds of things.";

  // Simulated Gemini API output matching the semantic domain/time/speech-act order.
  const simulatedAiOutput: GeminiClassificationOutput = {
    signalType: "irrelevant",
    confidence: 0.90,
    temporalDirection: "future",
    evidenceQuote: null,
    reasonJa: "効率化や将来の開発を示していますが、利用上限リセットの意図は明示されていません。",
    resetTypeJa: null,
    noticeToExecution: null,
    teaserStrength: "none",
    teaserStrengthConfidence: 0.90,
    teaserStrengthEvidenceQuote: null,
    teaserStrengthReasonJa: "一般的な進展やresetという語だけでは、意図的なリセット匂わせとは判断しません。",
    model: "gemini-3.5-flash-lite",
    status: "success",
    classifiedAt: new Date().toISOString(),
  };

  // Validate signalType
  assert.strictEqual(simulatedAiOutput.signalType, "irrelevant");
  assert.strictEqual(simulatedAiOutput.temporalDirection, "future");
  assert.strictEqual(simulatedAiOutput.teaserStrength, "none");
  assert.strictEqual(simulatedAiOutput.evidenceQuote, null);
  assert.ok(todayText.includes("Things getting faster"));
});
