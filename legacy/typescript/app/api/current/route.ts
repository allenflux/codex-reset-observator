import { NextResponse } from "next/server";
import {
  API_CACHE_CONTROL,
  fetchPublicRadarSnapshot,
  getPublicRadarSnapshotCalculationBucket,
} from "@/lib/radarFetch";
import type { Locale } from "@/lib/radar/types";

export const dynamic = "force-dynamic";

function getLocale(value: string | null): Locale {
  return value === "en" || value === "zh" ? value : "ja";
}

function getResetMarkerRetry(value: string | null): number | null {
  if (value === null) return null;
  const retry = Number(value);
  return Number.isInteger(retry) && retry >= 0 ? retry : null;
}

export async function GET(request: Request) {
  const requestStartedAt = performance.now();
  const requestUrl = new URL(request.url);
  const locale = getLocale(requestUrl.searchParams.get("locale"));
  const calculationNow = new Date();
  const calculationBucket = getPublicRadarSnapshotCalculationBucket(calculationNow);
  const fetchStartedAt = performance.now();
  const data = await fetchPublicRadarSnapshot(locale, { calculationNow });
  const fetchPublicRadarSnapshotMs = performance.now() - fetchStartedAt;

  const responseSerializationStartedAt = performance.now();
  const response = NextResponse.json(data, {
    headers: {
      "Cache-Control": API_CACHE_CONTROL,
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
  const responseSerializationMs = performance.now() - responseSerializationStartedAt;

  console.info(JSON.stringify({
    locale,
    hostname: requestUrl.hostname,
    hasResetMarker: requestUrl.searchParams.has("resetMarker"),
    resetMarkerRetry: getResetMarkerRetry(requestUrl.searchParams.get("resetMarkerRetry")),
    calculationBucket,
    totalMs: performance.now() - requestStartedAt,
    fetchPublicRadarSnapshotMs,
    responseSerializationMs,
  }));

  return response;
}
