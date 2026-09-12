import type { Locale } from "@/lib/radar/types";
import { translateUI } from "@/lib/radar/i18n";

export type ManualOutlookStyle = "alert" | "warning" | "info";

export type LocalizedText = {
  ja: string;
  en: string;
  zh: string;
};

export type ManualOutlookBadge = Partial<LocalizedText> | string;
export type ManualOutlookMessage = Partial<LocalizedText> | string;

export type ManualOutlookConfig = {
  /**
   * 手動上書きが有効になる終了日時（ISO 8601 文字列、例: "2026-09-10T12:00:00+09:00"）。
   * この日時を過ぎると、自動的に通常の予測文章・通常デザインに戻ります。
   * null または undefined の場合は手動上書きは無効（通常表示）です。
   */
  expiresAt: string | null;
  /**
   * 表示開始日時（オプショナル。未指定の場合は即時有効）。
   */
  startsAt?: string | null;
  /**
   * バッジの表示文字（オプショナル）。
   * 未指定の場合はスタイルのデフォルト（alertなら「速報」、warningなら「注意」など）が表示されます。
   */
  badge?: ManualOutlookBadge;
  /**
   * スタイル種別（デフォルト: "alert" = 赤枠・薄赤背景・赤バッジ）。
   */
  style?: ManualOutlookStyle;
  /**
   * 手動で表示する文章（多言語オブジェクト、または共通文字列）。
   */
  message: ManualOutlookMessage;
  /**
   * 手動文章の下に、通常のシステム見込み文章も併記するかどうか（デフォルト: false）。
   */
  showSystemReasonBelow?: boolean;
};

export type ActiveManualOutlook = {
  isActive: true;
  message: string;
  badge: string;
  style: ManualOutlookStyle;
  showSystemReasonBelow: boolean;
  expiresAt: string;
};

/**
 * 手動見込みの上書き設定。
 * 数時間だけ手動メッセージを表示したい場合にここに設定します。
 * 有効期限（expiresAt）を過ぎると、自動的に通常の予測文章・通常デザインに戻ります。
 *
 * 通常時（手動表示を行わない時）は `CURRENT_MANUAL_OUTLOOK = null` または `expiresAt: null` に設定します。
 *
 * 【設定例】
 * export const CURRENT_MANUAL_OUTLOOK: ManualOutlookConfig | null = {
 *   expiresAt: "2026-09-10T12:00:00+09:00",
 *   style: "alert",
 *   badge: { ja: "速報", en: "Flash", zh: "快讯" }, // 省略可（省略時はスタイルに応じたデフォルト）
 *   message: {
 *     ja: "現在リセット状況を確認中のため、通常の見込み表示を一時更新しています。",
 *     en: "Currently verifying reset status; temporarily updating the outlook display.",
 *     zh: "目前正在确认重置状态，暂时更新预测展示。",
 *   },
 *   showSystemReasonBelow: false,
 * };
 */
export const CURRENT_MANUAL_OUTLOOK: ManualOutlookConfig | null = null;

let runtimeManualOutlookOverride: ManualOutlookConfig | null | undefined = undefined;

/**
 * テストまたは動的な設定注入用
 */
export function setManualOutlookOverrideForTesting(
  config: ManualOutlookConfig | null | undefined,
): void {
  runtimeManualOutlookOverride = config;
}

export function getCurrentManualOutlookConfig(): ManualOutlookConfig | null {
  if (runtimeManualOutlookOverride !== undefined) {
    return runtimeManualOutlookOverride;
  }
  return CURRENT_MANUAL_OUTLOOK;
}

function resolveLocalizedText(
  value: Partial<LocalizedText> | string | undefined,
  locale: Locale,
  fallback = "",
): string {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  return value[locale] || value.ja || value.en || value.zh || fallback;
}

export function resolveManualOutlook(
  now: Date | string | number | null | undefined,
  locale: Locale,
  config: ManualOutlookConfig | null = getCurrentManualOutlookConfig(),
): ActiveManualOutlook | null {
  if (!config || !config.expiresAt) {
    return null;
  }

  const currentMs =
    now == null
      ? Date.now()
      : typeof now === "number"
        ? now
        : typeof now === "string"
          ? Date.parse(now)
          : now.getTime();

  if (!Number.isFinite(currentMs)) {
    return null;
  }

  const expireMs = Date.parse(config.expiresAt);
  if (!Number.isFinite(expireMs) || currentMs >= expireMs) {
    return null;
  }

  if (config.startsAt) {
    const startMs = Date.parse(config.startsAt);
    if (Number.isFinite(startMs) && currentMs < startMs) {
      return null;
    }
  }

  const style: ManualOutlookStyle = config.style ?? "alert";

  let defaultBadgeKey:
    | "manualOutlookFlashBadge"
    | "manualOutlookNoticeBadge"
    | "manualOutlookInfoBadge" = "manualOutlookFlashBadge";
  if (style === "warning") {
    defaultBadgeKey = "manualOutlookNoticeBadge";
  } else if (style === "info") {
    defaultBadgeKey = "manualOutlookInfoBadge";
  }

  const defaultBadge = translateUI(defaultBadgeKey, locale);
  const badge = resolveLocalizedText(config.badge, locale, defaultBadge);
  const message = resolveLocalizedText(config.message, locale, "");

  if (!message.trim()) {
    return null;
  }

  return {
    isActive: true,
    message,
    badge,
    style,
    showSystemReasonBelow: Boolean(config.showSystemReasonBelow),
    expiresAt: config.expiresAt,
  };
}
