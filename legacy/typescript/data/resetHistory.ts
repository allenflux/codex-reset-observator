import type { WindowEventLike } from "../lib/radar/types";

export const LOCAL_MODEL_UPDATED_AT = "2026-08-01T12:32:00+09:00";
export const HISTORY_LIMIT = 5;
export const MANUAL_LAST_REGULAR_RESET_AT = null;
export const MANUAL_NEXT_REGULAR_RESET_AT = null;
export const MANUAL_NEXT_REGULAR_RESET_TIME_CONFIRMED = false;
export const MANUAL_SCHEDULE_ANCHOR_AT = null;

/**
 * 誤検知や不具合等により無効化・除外されたリセットイベントキー（除外リスト）
 */
export const MANUAL_EXCLUDED_RESET_EVENT_KEYS: ReadonlyArray<string> = [
  "usage-reset-512a8b31-e43e-4f91-b5e6-7023b87e80ec",
];

/**
 * 誤検知や不具合等により無効化・除外されたリカバリー観測ID（除外リスト）
 */
export const MANUAL_EXCLUDED_RECOVERY_OBSERVATION_IDS: ReadonlyArray<string> = [
  "512a8b31-e43e-4f91-b5e6-7023b87e80ec",
];

export function isExcludedResetEventKey(eventKey: string | null | undefined): boolean {
  if (!eventKey) return false;
  return MANUAL_EXCLUDED_RESET_EVENT_KEYS.includes(eventKey);
}

export function isExcludedRecoveryObservationId(id: string | null | undefined): boolean {
  if (!id) return false;
  return MANUAL_EXCLUDED_RECOVERY_OBSERVATION_IDS.includes(id);
}

/**
 * 単一の信頼できる情報源 (Single Source of Truth)
 * 全30件のリセットイベント履歴（全体強制リセット・定期リセット・任意リセット配布含む）
 * details.cycleType distinguishes regular and random resets, while recordKind
 * remains an independent record classification and resetMethod describes how
 * the reset was delivered.
 */
export const LOCAL_RESET_HISTORY: Array<WindowEventLike> = [
  {
    "id": "local-codex-rolling-notice-reset-2026-09-08",
    "recordKind": "confirmed_global",
    "title": {
      "ja": "Tiboの君を絶対に諦めないリセット",
      "en": "Tibo's Never Gonna Give You Up Reset",
      "zh": "Tibo 绝不放弃你重置"
    },
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-09-07T19:24:57.000Z",
    "closed_at": "2026-09-08T01:30:00.000Z",
    "completed_at": "2026-09-08T01:30:00.000Z",
    "window_minutes": 365,
    "scope": "全有料プラン",
    "summary": {
      "ja": "Tibo氏による『Never Gonna Give You Up』（君を絶対に諦めない）予告に基づき、CodexおよびChatGPT Workの利用上限が順次リセットされました。",
      "en": "Following the 'Never Gonna Give You Up' teaser notice, usage limits for Codex and ChatGPT Work were rolled out sequentially.",
      "zh": "根据“绝不放弃你”（Never Gonna Give You Up）预告，Codex 和 ChatGPT Work 的使用额度已陆续完成重置。"
    },
    "source_url": "https://x.com/thsottiaux/status/2097043464538264003",
    "sourceTweetIds": [
      "2097043464538264003"
    ],
    "officialNoticeTweetId": "2097043464538264003",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "6時間5分",
      "noticeType": "公式予告あり",
      "note": {
        "ja": "リセットは全アカウントで同時ではなく順次実施され、実施時刻にはアカウントごとの差がありました。",
        "en": "The reset was carried out sequentially rather than simultaneously for all accounts, so the execution time varied by account.",
        "zh": "重置并非所有账号同时进行，而是按顺序执行，各账号的执行时间有所不同。"
      }
    }
  },
  {
    "id": "local-codex-regular-reset-2026-08-08",
    "recordKind": "reference",
    "title": "定期リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-08-08T12:32:00+09:00",
    "closed_at": "2026-08-08T12:32:00+09:00",
    "completed_at": "2026-08-08T12:32:00+09:00",
    "window_minutes": 0,
    "window_human": "定期実施",
    "scope": "任意リセット未使用アカウント",
    "summary": "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。",
    "source_url": null,
    "details": {
      "cycleType": "定期リセット",
      "reasonType": "定期更新",
      "resetMethod": "強制リセット",
      "scope": "任意リセット未使用アカウント",
      "noticeToExecution": "0分（定期）",
      "noticeType": "なし",
      "note": "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。"
    }
  },
  {
    "id": "local-luna-100k-threads-efficiency-reset-2026-08-01",
    "recordKind": "confirmed_global",
    "title": "Luna 10万スレッド到達・効率改善記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-31T04:53:19.170Z",
    "closed_at": "2026-08-01T12:32:00+09:00",
    "completed_at": "2026-08-01T12:32:00+09:00",
    "window_minutes": 1359,
    "scope": "全有料プラン",
    "summary": "Tibo氏より今週の利用効率改善を記念し、週末に10万件のLunaスレッドを実行できるようCodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。",
    "source_url": "https://x.com/thsottiaux/status/2083053369351090254",
    "sourceTweetIds": [
      "2083053369351090254",
      "2083395449814229287"
    ],
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "22時間39分",
      "noticeType": "匂わせ投稿あり",
      "note": "Tibo氏より今週の利用効率改善を記念し、週末に10万件のLunaスレッドを実行できるようCodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。"
    }
  },
  {
    "id": "local-codex-gpt56-sol-efficiency-reset-2026-07-29",
    "recordKind": "confirmed_global",
    "title": "GPT-5.6 Sol利用効率改善リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-28T14:00:00+09:00",
    "closed_at": "2026-07-29T13:09:00+09:00",
    "completed_at": "2026-07-29T13:09:00+09:00",
    "window_minutes": 1389,
    "scope": "全有料プラン",
    "summary": "Tibo氏よりGPT-5.6 Solモデルの消費効率改善（利用持続力約18%向上）の発表とともに、全ChatGPT WorkおよびCodexユーザーの利用上限が即時強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "23時間9分",
      "noticeType": "匂わせ投稿あり",
      "note": "Tibo氏よりGPT-5.6 Solモデルの消費効率改善（利用持続力約18%向上）の発表とともに、全ChatGPT WorkおよびCodexユーザーの利用上限が即時強制リセットされました。"
    }
  },
  {
    "id": "local-codex-chatgpt-work-adoption-reset-2026-07-28",
    "recordKind": "confirmed_global",
    "title": "ChatGPT Work急速採用記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-28T09:27:00+09:00",
    "closed_at": "2026-07-28T12:09:00+09:00",
    "completed_at": "2026-07-28T12:09:00+09:00",
    "window_minutes": 162,
    "scope": "全有料プラン",
    "summary": "ChatGPT Workの急速な普及とチームの努力を祝し、CodexとChatGPT Work全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "2時間42分",
      "noticeType": "匂わせ投稿あり",
      "note": "ChatGPT Workの急速な普及とチームの努力を祝し、CodexとChatGPT Work全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-outage-compensation-reset-2026-07-26",
    "recordKind": "confirmed_global",
    "title": "大規模障害に伴う詫びリセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-26T04:17:00+09:00",
    "closed_at": "2026-07-26T04:17:00+09:00",
    "completed_at": "2026-07-26T04:17:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "世界規模で発生したシステム障害の復旧に伴い、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "世界規模で発生したシステム障害の復旧に伴い、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-10m-users-reset-2026-07-22",
    "recordKind": "confirmed_global",
    "title": "1000万人アクティブユーザー記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-22T02:05:00+09:00",
    "closed_at": "2026-07-22T02:05:00+09:00",
    "completed_at": "2026-07-22T02:05:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "アクティブユーザー数1000万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "アクティブユーザー数1000万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-gpt-5-6-sol-release-reset-4-2026-07-18",
    "recordKind": "confirmed_global",
    "title": "GPT-5.6 Solリリース記念リセット（4回目）",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-18T12:31:00+09:00",
    "closed_at": "2026-07-18T12:31:00+09:00",
    "completed_at": "2026-07-18T12:31:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "GPT-5.6 Solの追加調査・改善に伴い、ChatGPT WorkとCodex全体の利用上限が4回目に強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "GPT-5.6 Solの追加調査・改善に伴い、ChatGPT WorkとCodex全体の利用上限が4回目に強制リセットされました。"
    }
  },
  {
    "id": "local-codex-9m-users-reset-2026-07-16",
    "recordKind": "confirmed_global",
    "title": "900万人アクティブユーザー記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-15T15:00:00+09:00",
    "closed_at": "2026-07-16T13:15:00+09:00",
    "completed_at": "2026-07-16T13:15:00+09:00",
    "window_minutes": 1335,
    "scope": "全有料プラン",
    "summary": "アクティブユーザー数900万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "22時間15分",
      "noticeType": "匂わせ投稿あり",
      "note": "アクティブユーザー数900万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-8m-users-reset-2026-07-15",
    "recordKind": "confirmed_global",
    "title": "800万人アクティブユーザー記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-14T14:52:00+09:00",
    "closed_at": "2026-07-15T05:45:00+09:00",
    "completed_at": "2026-07-15T05:45:00+09:00",
    "window_minutes": 893,
    "scope": "全有料プラン",
    "summary": "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "14時間53分",
      "noticeType": "匂わせ投稿あり",
      "note": "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "personal-tibo-7m-users-banked-reset-2026-07-14",
    "recordKind": "banked_distribution",
    "title": "700万人アクティブユーザー記念任意リセット配布",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-14T03:40:00+09:00",
    "closed_at": "2026-07-14T03:40:00+09:00",
    "completed_at": "2026-07-14T03:40:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "アクティブユーザー数700万人到達を記念し、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "任意リセット権配布",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "アクティブユーザー数700万人到達を記念し、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。"
    }
  },
  {
    "id": "personal-tibo-500k-compensation-reset-2026-07-13",
    "recordKind": "banked_distribution",
    "title": "Web/モバイル機能不具合補償任意リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-13T07:00:00+09:00",
    "closed_at": "2026-07-13T07:00:00+09:00",
    "completed_at": "2026-07-13T07:00:00+09:00",
    "window_minutes": 0,
    "scope": "不具合対象ユーザー（約50万人）",
    "summary": "Web/モバイルからの任意リセット機能リリース時に、ボタンを押しても適用されなかった一部ユーザー（約50万人）に対して任意リセット（マニュアルリセット）1回分が補償配布されました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "任意リセット権配布",
      "scope": "不具合対象ユーザー（約50万人）",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "Web/モバイルからの任意リセット機能リリース時に、ボタンを押しても適用されなかった一部ユーザー（約50万人）に対して任意リセット（マニュアルリセット）1回分が補償配布されました。"
    }
  },
  {
    "id": "local-codex-6m-users-reset-2026-07-13",
    "recordKind": "confirmed_global",
    "title": "600万人アクティブユーザー記念リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-13T03:30:00+09:00",
    "closed_at": "2026-07-13T03:30:00+09:00",
    "completed_at": "2026-07-13T03:30:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "アクティブユーザー数600万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "アクティブユーザー数600万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-gpt-5-6-sol-release-reset-3-2026-07-11",
    "recordKind": "confirmed_global",
    "title": "GPT-5.6 Solリリース記念リセット（3回目）",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-10T14:30:00+09:00",
    "closed_at": "2026-07-11T15:00:00+09:00",
    "completed_at": "2026-07-11T15:00:00+09:00",
    "window_minutes": 1470,
    "scope": "全有料プラン",
    "summary": "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が3回目に強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "24時間30分",
      "noticeType": "告知投稿あり",
      "note": "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が3回目に強制リセットされました。"
    }
  },
  {
    "id": "local-codex-gpt-5-6-sol-release-reset-2-2026-07-11",
    "recordKind": "confirmed_global",
    "title": "GPT-5.6 Solリリース記念リセット（2回目）",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-10T14:30:00+09:00",
    "closed_at": "2026-07-11T03:26:00+09:00",
    "completed_at": "2026-07-11T03:26:00+09:00",
    "window_minutes": 776,
    "scope": "全有料プラン",
    "summary": "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が2回目に強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "12時間56分",
      "noticeType": "告知投稿あり",
      "note": "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が2回目に強制リセットされました。"
    }
  },
  {
    "id": "local-codex-gpt-5-6-release-reset-2026-07-10",
    "recordKind": "confirmed_global",
    "title": "GPT-5.6リリース記念リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-07-10T06:00:00+09:00",
    "closed_at": "2026-07-10T07:00:00+09:00",
    "completed_at": "2026-07-10T07:00:00+09:00",
    "window_minutes": 60,
    "scope": "全有料プラン",
    "summary": "GPT-5.6のリリース記念として、全有料プランのCodex利用上限が強制的にリセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "1時間",
      "noticeType": "告知投稿あり",
      "note": "GPT-5.6のリリース記念として、全有料プランのCodex利用上限が強制的にリセットされました。"
    }
  },
  {
    "id": "local-codex-regular-reset-2026-07-07",
    "recordKind": "reference",
    "title": "定期リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-07-07T09:30:00+09:00",
    "closed_at": "2026-07-07T09:30:00+09:00",
    "completed_at": "2026-07-07T09:30:00+09:00",
    "window_minutes": 0,
    "window_human": "定期実施",
    "scope": "任意リセットを使っていないアカウント",
    "summary": "通常の1週間サイクルのタイミングで、有料プランのCodex利用上限リセットが実施されました。ただし、任意リセットを使用したアカウントは対象外となります。",
    "source_url": null,
    "details": {
      "cycleType": "定期リセット",
      "reasonType": "定期更新",
      "resetMethod": "強制リセット",
      "scope": "任意リセットを使っていないアカウント",
      "noticeToExecution": "0分（定期）",
      "noticeType": "なし",
      "note": "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。"
    }
  },
  {
    "id": "personal-codex-reset-button-aie-2026-07-02",
    "recordKind": "banked_distribution",
    "title": "Codex reset button 配布 (AIE World's Fair 記念)",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-07-02T04:50:00+09:00",
    "closed_at": "2026-07-02T05:50:00+09:00",
    "completed_at": "2026-07-02T05:50:00+09:00",
    "window_minutes": 60,
    "scope": "全有料プラン",
    "summary": "AI Engineer World's Fair のデモにおいて Codex reset button が押され、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。",
    "source_url": "https://x.com/dkundel",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "任意リセット権配布",
      "scope": "全有料プラン",
      "noticeToExecution": "1時間",
      "noticeType": "告知投稿あり",
      "note": "AI Engineer World's Fair のデモにおいて Codex reset button が押され、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。"
    }
  },
  {
    "id": "local-codex-forced-reset-2026-06-30",
    "recordKind": "confirmed_global",
    "title": "臨時リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-06-30T08:50:00+09:00",
    "closed_at": "2026-06-30T09:30:00+09:00",
    "completed_at": "2026-06-30T09:30:00+09:00",
    "window_minutes": 40,
    "scope": "全有料プラン",
    "summary": "Tibo氏が1時間以内の再フルリセットを告知し、利用制限の過剰消費問題への補償対応として全有料プランのCodex利用制限が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "40分",
      "noticeType": "告知投稿あり",
      "note": "Tibo氏が1時間以内の再フルリセットを告知し、利用制限の過剰消費問題への補償対応として全有料プランのCodex利用制限が強制リセットされました。"
    }
  },
  {
    "id": "local-codex-forced-comp-reset-2026-06-29",
    "recordKind": "confirmed_global",
    "title": "過剰消費バグ調査・強制補償リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-06-29T09:00:00+09:00",
    "closed_at": "2026-06-29T09:00:00+09:00",
    "completed_at": "2026-06-29T09:00:00+09:00",
    "window_minutes": 0,
    "window_human": "強制実施 (即時)",
    "scope": "全有料プラン",
    "summary": "一部のユーザーでCodexの使用制限が過剰に消費される不具合が発生したため、その調査に伴い全ユーザーの利用制限が強制的にリセット（クリア）されました。",
    "source_url": "https://x.com/thsottiaux/status/2067711440019483321",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "一部のユーザーでCodexの使用制限が過剰に消費される不具合が発生したため、その調査に伴い全ユーザーの利用制限が強制的にリセット（クリア）されました。"
    }
  },
  {
    "id": "personal-compensation-reset-credit-2026-06-27",
    "recordKind": "banked_distribution",
    "title": "能力退化・過剰消費補償任意リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-06-27T11:00:00+09:00",
    "closed_at": "2026-06-27T12:00:00+09:00",
    "completed_at": "2026-06-27T12:00:00+09:00",
    "window_minutes": 60,
    "scope": "全有料プラン",
    "summary": "モデルの能力退化および過剰な利用制限消費不具合に対する補償として、全有料プランに任意リセット（マニュアルリセット）1回分が配布されました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "任意リセット権配布",
      "scope": "全有料プラン",
      "noticeToExecution": "1時間",
      "noticeType": "告知投稿あり",
      "note": "モデルの能力退化および過剰な利用制限消費不具合に対する補償として、全有料プランに任意リセット（マニュアルリセット）1回分が配布されました。"
    }
  },
  {
    "id": "local-codex-regular-reset-2026-06-25",
    "recordKind": "reference",
    "title": "定期リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-06-25T07:01:00+09:00",
    "closed_at": "2026-06-25T07:01:00+09:00",
    "completed_at": "2026-06-25T07:01:00+09:00",
    "window_minutes": 0,
    "window_human": "定期実施",
    "scope": "全有料プラン",
    "summary": "2026/06/25 07:01 JST に、通常の1週間サイクルとして全有料プランのCodex利用上限リセットが実施されました。",
    "source_url": null,
    "details": {
      "cycleType": "定期リセット",
      "reasonType": "定期更新",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分（定期）",
      "noticeType": "なし",
      "note": "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。"
    }
  },
  {
    "id": "local-codex-rate-limit-reset-notice-2026-06-17",
    "recordKind": "reference",
    "title": "定期リセット",
    "kind": "window_closed",
    "status": "closed",
    "opened_at": "2026-06-18T07:00:00+09:00",
    "closed_at": "2026-06-18T07:00:00+09:00",
    "completed_at": "2026-06-18T07:00:00+09:00",
    "window_minutes": 0,
    "window_human": "定期実施",
    "scope": "全有料プラン",
    "summary": "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。あわせて、Codexの信頼性に影響する不具合への補償として任意リセット1回分も配布されました。",
    "source_url": "https://x.com/thsottiaux/status/2066956441173323943",
    "details": {
      "cycleType": "定期リセット",
      "reasonType": "定期更新",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分（定期）",
      "noticeType": "なし",
      "note": "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。"
    }
  },
  {
    "id": "personal-compensation-reset-credit-2026-06-18",
    "recordKind": "banked_distribution",
    "title": "Codex信頼性障害補償任意リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-06-18T07:00:00+09:00",
    "closed_at": "2026-06-18T07:00:00+09:00",
    "completed_at": "2026-06-18T07:00:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "Codexの信頼性に影響する不具合の補償として、全アカウントに対して任意リセット（マニュアルリセット）1回分が配布されました。",
    "source_url": "https://x.com/thsottiaux/status/2066956441173323943",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "任意リセット権配布",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "Codexの信頼性に影響する不具合の補償として、全アカウントに対して任意リセット（マニュアルリセット）1回分が配布されました。"
    }
  },
  {
    "id": "personal-reset-credit-2026-06-11",
    "recordKind": "banked_distribution",
    "title": "任意リセット配布",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-06-12T09:11:00+09:00",
    "closed_at": "2026-06-12T09:11:00+09:00",
    "completed_at": "2026-06-12T09:11:00+09:00",
    "window_minutes": 0,
    "scope": "全有料プラン",
    "summary": "個人の利用制限の更新として、任意リセットが配布されました。",
    "source_url": "https://x.com/thsottiaux",
    "details": {
      "cycleType": "定期リセット",
      "reasonType": "定期更新",
      "resetMethod": "任意リセット権配布",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "定期的な強制リセットではなく、任意リセット権が1回分配布されました。使用後の利用枠や次回日時はユーザーごとに異なる場合があります。"
    }
  },
  {
    "id": "local-codex-reliability-compensation-2026-06-04",
    "recordKind": "confirmed_global",
    "title": "Codex信頼性障害補償リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-06-04T09:25:58+09:00",
    "closed_at": "2026-06-04T09:25:58+09:00",
    "completed_at": "2026-06-04T09:25:58+09:00",
    "window_minutes": 0,
    "window_human": "即時",
    "scope": "全有料プラン",
    "summary": "過去24時間以内に発生したCodexの信頼性に影響する3件の障害への補償として、全有料プランの利用制限がリセットされました。",
    "source_url": "https://x.com/thsottiaux/status/2062329981548802523",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "告知投稿あり",
      "note": "過去24時間以内に発生したCodexの信頼性に影響する3件の障害への補償として、全有料プランの利用制限がリセットされました。"
    }
  },
  {
    "id": "local-5m-users-celebration-2026-05-31",
    "recordKind": "confirmed_global",
    "title": "500万人アクティブユーザー記念リセット",
    "kind": "window_closed",
    "opened_at": "2026-05-31T14:59:10+09:00",
    "closed_at": "2026-06-01T00:25:06+09:00",
    "completed_at": "2026-06-01T00:25:06+09:00",
    "window_minutes": 565,
    "window_human": "9時間25分",
    "scope": "全有料プラン",
    "summary": "Codexアクティブユーザー数500万人達成を記念し、全有料ChatGPT/Codexユーザーの利用回数が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux/status/2061106703446450392",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "9時間25分",
      "noticeType": "告知投稿あり",
      "note": "Codexアクティブユーザー数500万人達成を記念し、全有料ChatGPT/Codexユーザーの利用回数が強制リセットされました。"
    }
  },
  {
    "id": "local-long-session-compression-compensation-2026-05-24",
    "recordKind": "confirmed_global",
    "title": "長セッション圧縮過剰消費補償リセット",
    "kind": "reset_completed",
    "status": "closed",
    "opened_at": "2026-05-24T05:14:00+09:00",
    "closed_at": "2026-05-24T05:14:00+09:00",
    "completed_at": "2026-05-24T05:14:00+09:00",
    "window_minutes": 0,
    "window_human": "即時",
    "scope": "全有料プラン",
    "summary": "Codex長セッション圧縮のキャッシュヒット率低下による過剰消費バグが修正され、全有料ユーザーのリセットが実施されました。",
    "source_url": "https://x.com/thsottiaux/status/2058280452851638313",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "0分",
      "noticeType": "なし",
      "note": "Codex長セッション圧縮のキャッシュヒット率低下による過剰消費バグが修正され、全有料ユーザーのリセットが実施されました。"
    }
  },
  {
    "id": "local-sam-like-promise-reset-2026-05-20",
    "recordKind": "confirmed_global",
    "title": "Samいいね約束リセット",
    "kind": "window_closed",
    "opened_at": "2026-05-20T03:31:00+09:00",
    "closed_at": "2026-05-20T03:39:18+09:00",
    "completed_at": "2026-05-20T03:39:18+09:00",
    "window_minutes": 8,
    "window_human": "8分",
    "scope": "全有料プラン",
    "summary": "Sam Altman氏のツイート1いいね達成に伴い、Tibo氏によって即座にCodex利用上限がリセットされました。",
    "source_url": "https://x.com/bossnayamoss/status/2056806923391877438",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "ご祝儀リセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "8分",
      "noticeType": "告知投稿あり",
      "note": "Sam Altman氏のツイート1いいね達成に伴い、Tibo氏によって即座にCodex利用上限がリセットされました。"
    }
  },
  {
    "id": "local-gpt-55-degradation-compensation-2026-05-17",
    "recordKind": "confirmed_global",
    "title": "GPT-5.5能力退化補償リセット",
    "kind": "window_closed",
    "opened_at": "2026-05-16T09:31:00+09:00",
    "closed_at": "2026-05-17T02:51:00+09:00",
    "completed_at": "2026-05-17T02:51:00+09:00",
    "window_minutes": 1040,
    "window_human": "17時間20分",
    "scope": "全有料プラン",
    "summary": "GPT-5.5モデルの能力一時退化不具合が解消されたことに伴い、全有料プランの利用回数が強制リセットされました。",
    "source_url": "https://x.com/thsottiaux/status/2055707616605835333",
    "details": {
      "cycleType": "ランダムリセット",
      "reasonType": "詫びリセット",
      "resetMethod": "強制リセット",
      "scope": "全有料プラン",
      "noticeToExecution": "17時間20分",
      "noticeType": "告知投稿あり",
      "note": "GPT-5.5モデルの能力一時退化不具合が解消されたことに伴い、全有料プランの利用回数が強制リセットされました。"
    }
  }
];

/**
 * 後方互換用の参照（空配列または非互換対策）
 */
export const LOCAL_PERSONAL_RESET_HISTORY: Array<any> = [];
