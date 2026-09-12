import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRandomResetNamePrompt,
  parseRandomResetNameResponse,
  selectRandomResetNameEvaluationCases,
  toRandomResetNameInput,
} from "../scripts/evaluate-random-reset-names";
import type { WindowEventLike } from "../lib/radar/types";

function event(
  id: string,
  completedAt: string,
  options: Partial<WindowEventLike> = {},
): WindowEventLike {
  return {
    id,
    kind: "reset_completed",
    status: "closed",
    closed_at: completedAt,
    completed_at: completedAt,
    title: "人間が付けた既存表示名は入力しない",
    summary: "記録済みの利用上限リセット事実",
    source_url: "https://x.com/thsottiaux/status/123",
    recordKind: "confirmed_global",
    scope: "全有料プラン",
    details: {
      cycleType: "ランダムリセット",
      reasonType: "ご祝儀リセット",
      resetMethod: "強制リセット",
      scope: "全有料プラン",
      noticeToExecution: "0分",
      noticeType: "なし",
    },
    ...options,
  };
}

test("selects only completed broad random events and caps the evaluation set", () => {
  const history = [
    event("random", "2026-08-01T00:00:00.000Z"),
    event("regular", "2026-08-02T00:00:00.000Z", {
      recordKind: "reference",
      details: {
        cycleType: "定期リセット",
        reasonType: "定期更新",
        resetMethod: "強制リセット",
        scope: "全有料プラン",
        noticeToExecution: "0分",
        noticeType: "なし",
      },
    }),
    event("narrow", "2026-08-03T00:00:00.000Z", { scope: "限定ユーザー" }),
    event("pending", "2026-08-04T00:00:00.000Z", { status: "pending", closed_at: null, completed_at: null, opened_at: "2026-08-04T00:00:00.000Z" }),
    event("future", "2026-08-10T00:00:00.000Z"),
  ];

  const cases = selectRandomResetNameEvaluationCases(
    history,
    new Date("2026-08-09T00:00:00.000Z"),
    20,
  );

  assert.equal(cases.length, 1);
  assert.equal(cases[0].input.cycleType, "ランダムリセット");
  assert.equal(cases[0].input.completedAt, "2026-08-01T00:00:00.000Z");
});

test("does not send existing human display names or IDs to Gemini", () => {
  const item = event("human-title-event", "2026-08-01T00:00:00.000Z", {
    title: "人間の表示名そのもの",
    summary: "GPT-5.6の公開後に利用上限がリセットされたという記録",
  });
  const input = toRandomResetNameInput(item, Date.parse("2026-08-01T00:00:00.000Z"));
  const prompt = buildRandomResetNamePrompt(input);

  assert.doesNotMatch(prompt, /人間の表示名そのもの/);
  assert.doesNotMatch(prompt, /human-title-event/);
  assert.match(prompt, /GPT-5\.6/);
  assert.match(prompt, /Tibo post text in the local fixture: unavailable/);
});

test("accepts a bounded structured result and reports evidence grounding", () => {
  const input = toRandomResetNameInput(
    event("event", "2026-08-01T00:00:00.000Z", {
      summary: "GPT-5.6の公開後に利用上限がリセットされたという記録",
    }),
    Date.parse("2026-08-01T00:00:00.000Z"),
  );
  const result = parseRandomResetNameResponse(
    {
      name: "GPT-5.6公開後のリセット",
      confidence: 0.82,
      evidence: "GPT-5.6の公開後に利用上限がリセットされたという記録",
      reason: "記録要約にモデル公開との関連が明記されています。",
    },
    input,
    "test-model",
  );

  assert.equal(result.status, "success");
  assert.equal(result.name, "GPT-5.6公開後のリセット");
  assert.equal(result.evidenceGrounded, true);
  assert.deepEqual(result.flags, []);
});

test("keeps null names valid and rejects invalid confidence", () => {
  const input = toRandomResetNameInput(
    event("event", "2026-08-01T00:00:00.000Z"),
    Date.parse("2026-08-01T00:00:00.000Z"),
  );
  const empty = parseRandomResetNameResponse(
    { name: null, confidence: 0.35, evidence: null, reason: "特徴が不足しています。" },
    input,
    "test-model",
  );
  const invalid = parseRandomResetNameResponse(
    { name: "不正", confidence: 1.5, evidence: null, reason: "不正な信頼度です。" },
    input,
    "test-model",
  );

  assert.equal(empty.status, "success");
  assert.equal(empty.name, null);
  assert.equal(invalid.status, "invalid_schema");
});

test("flags a category-only name and ungrounded evidence for human review", () => {
  const input = toRandomResetNameInput(
    event("event", "2026-08-01T00:00:00.000Z"),
    Date.parse("2026-08-01T00:00:00.000Z"),
  );
  const result = parseRandomResetNameResponse(
    {
      name: "ランダムリセット",
      confidence: 0.91,
      evidence: "入力にない新しい出来事",
      reason: "分類名をそのまま使いました。",
    },
    input,
    "test-model",
  );

  assert.deepEqual(result.flags, ["classification_only_name", "ungrounded_evidence"]);
});
