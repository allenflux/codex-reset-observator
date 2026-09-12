import React from "react";
import type { Locale, RadarViewModel } from "@/lib/radar/types";
import { translateUI, translateDynamic } from "@/lib/radar/i18n";

type ResetHistoryItem = RadarViewModel["recentHistory"][number];

type ResetHistoryDetailsProps = {
  item: ResetHistoryItem;
  locale: Locale;
  compact?: boolean;
  hideReasonOnMobile?: boolean;
  hideNoticeType?: boolean;
  hideNoticeToExecutionOnMobile?: boolean;
  hideNoteOnMobile?: boolean;
};

function isMeaningfulValue(value: string | null | undefined) {
  if (!value || !value.trim()) return false;
  return !new Set(["不明", "unknown", "未知", "なし", "none", "null"]).has(value.trim().toLowerCase());
}

const ALL_PAID_PLAN_SCOPES = new Set(["全有料プラン", "All paid plans", "所有付费套餐"]);

function isAllPaidPlanScope(value: string | null | undefined) {
  return Boolean(value && ALL_PAID_PLAN_SCOPES.has(value.trim()));
}

export function ResetHistoryDetails({
  item,
  locale,
  compact = false,
  hideReasonOnMobile = false,
  hideNoticeType = false,
  hideNoticeToExecutionOnMobile = false,
  hideNoteOnMobile = false,
}: ResetHistoryDetailsProps) {
  const details = item.details ?? {
    cycleType: item.resetType,
    reasonType: item.resetTypes?.find((type) => type !== item.resetType) ?? item.resetType,
    resetMethod: item.windowLength,
    scope: item.scope,
    noticeToExecution: "",
    note: item.summary,
  };

  const rawScope = details.scope?.trim() || item.scope?.trim() || "";
  const isAllPaid = isAllPaidPlanScope(rawScope);
  const shouldShowScope = Boolean(rawScope && !isAllPaid && isMeaningfulValue(rawScope));

  const recordKind = item.recordKind ?? "confirmed_global";
  const candidateRows: Array<{ id: string; label: string; value: string }> = [
    {
      id: "cycleType",
      label: translateUI("historyCycleType", locale),
      value: details.cycleType,
    },
    ...(details.reasonType && isMeaningfulValue(details.reasonType)
      ? [{ id: "reasonType", label: translateUI("historyReasonType", locale), value: details.reasonType }]
      : []),
    {
      id: "resetMethod",
      label: translateUI("historyResetMethod", locale),
      value: details.resetMethod,
    },
    ...(shouldShowScope
      ? [{
          id: "scope",
          label: translateUI("historyScope", locale),
          value: rawScope,
        }]
      : []),
    ...(details.noticeType
      ? [{ id: "noticeType", label: translateUI("historyNoticeType", locale), value: details.noticeType }]
      : []),
    {
      id: "noticeToExecution",
      label: translateUI("historyNoticeToExecution", locale),
      value: details.noticeToExecution,
    },
  ];

  const rows = candidateRows.filter((row) => {
    if (!isMeaningfulValue(row.value)) return false;
    if (row.id === "noticeType" && hideNoticeType) return false;
    if (
      recordKind === "banked_distribution" &&
      row.id === "resetMethod" &&
      (row.value === "強制リセット" || row.value === "リセット実施")
    ) {
      return false;
    }
    return true;
  });

  return (
    <div className={compact ? "mt-2 space-y-2" : "mt-3 space-y-3"}>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(({ id, label, value }) => (
          <div
            className={`grid grid-cols-[7.5rem_1fr] gap-2 ${
              (hideReasonOnMobile && id === "reasonType") ||
              (hideNoticeToExecutionOnMobile && id === "noticeToExecution")
                ? "hidden sm:grid"
                : ""
            }`}
            key={id}
          >
            <dt className="text-slate-500">{label}</dt>
            <dd className="font-medium text-slate-800">{translateDynamic(value, locale)}</dd>
          </div>
        ))}
      </dl>
      {isMeaningfulValue(details.note) ? (
        <div
          className={`rounded border border-slate-100/70 bg-slate-50 p-2.5 text-sm leading-6 text-slate-600 ${
            hideNoteOnMobile ? "hidden sm:block" : ""
          }`}
        >
          <p className="font-medium text-slate-500">
            {translateUI("historyNote", locale)}
          </p>
          <p className="mt-1">{translateDynamic(details.note ?? "", locale)}</p>
        </div>
      ) : null}
    </div>
  );
}
