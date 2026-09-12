import React from "react";
import { normalizeProbability } from "@/lib/radar/helpers";
import type { Locale } from "@/lib/radar/types";
import { translateUI } from "@/lib/radar/i18n";

export function ProbabilityMetrics({
  className = "mt-4 grid w-full grid-cols-2 gap-3",
  locale,
  probability24h,
  probability48h,
}: {
  className?: string;
  locale: Locale;
  probability24h: number | undefined;
  probability48h: number | undefined;
}) {
  return (
    <dl className={className}>
      <Metric
        horizon="24h"
        label={translateUI("within24h", locale)}
        locale={locale}
        probability={probability24h}
        value={formatProbabilityDisplay(probability24h, locale)}
      />
      <Metric
        horizon="48h"
        label={translateUI("within48h", locale)}
        locale={locale}
        probability={probability48h}
        value={formatProbabilityDisplay(probability48h, locale)}
      />
    </dl>
  );
}

export function formatProbabilityDisplay(
  probability: number | undefined,
  locale: Locale,
) {
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    return translateUI("unknownProbability", locale);
  }

  const bcp47 = locale === "en" ? "en-US" : locale === "zh" ? "zh-CN" : "ja-JP";
  const normalized = Math.min(1, Math.max(0, normalizeProbability(probability)));
  return new Intl.NumberFormat(bcp47, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(normalized);
}

function Metric({
  className,
  horizon,
  label,
  locale,
  probability,
  value,
}: {
  className?: string;
  horizon: "24h" | "48h";
  label: string;
  locale: Locale;
  probability: number | undefined;
  value: string;
}) {
  const tone = getProbabilityTone(probability, horizon);
  const percent = getProbabilityPercent(probability);
  const isKnown = percent !== undefined;

  return (
    <div className={`h-full rounded-lg border p-4 pl-6 lg:p-5 lg:pl-7 ${tone.card} ${className ?? ""}`}>
      <dt className={`text-sm font-medium lg:text-base ${tone.label}`}>{label}</dt>
      <dd className={`mt-2 text-3xl font-semibold lg:mt-3 lg:text-4xl ${tone.value}`}>
        {value}
      </dd>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/75 lg:mt-4">
        <div
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          {...(isKnown
            ? { "aria-valuenow": percent }
            : { "aria-valuetext": translateUI("unknownProbability", locale) })}
          className={`h-full rounded-full ${tone.bar}`}
          role="progressbar"
          style={{ width: getProbabilityBarWidth(probability) }}
        />
      </div>
    </div>
  );
}

function getProbabilityTone(
  probability: number | undefined,
  horizon: "12h" | "24h" | "48h" | "72h",
) {
  if (typeof probability !== "number" || Number.isNaN(probability)) {
    return {
      bar: "bg-slate-400",
      card: "border-slate-200 bg-slate-50",
      label: "text-slate-500",
      value: "text-slate-950",
    };
  }

  if (probability <= 0.33) {
    return {
      bar: "bg-sky-500",
      card: "border-sky-200 bg-sky-50",
      label: "text-sky-700",
      value: "text-sky-950",
    };
  }

  if (probability <= 0.66) {
    return {
      bar: "bg-orange-500",
      card: "border-orange-200 bg-orange-50",
      label: "text-orange-700",
      value: "text-orange-950",
    };
  }

  return {
    bar: "bg-rose-500",
    card: "border-rose-200 bg-rose-50",
    label: "text-rose-700",
    value: "text-rose-950",
  };
}

function getProbabilityPercent(probability: number | undefined) {
  if (typeof probability !== "number" || Number.isNaN(probability)) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round(probability * 100)));
}

function getProbabilityBarWidth(probability: number | undefined) {
  const percent = getProbabilityPercent(probability);
  return percent === undefined ? "0%" : `${percent}%`;
}
