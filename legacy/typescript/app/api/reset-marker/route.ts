import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
  RESET_MARKER_CACHE_CONTROL,
  readLatestUsageObservationResetMarker,
} from "@/lib/resetMarkerStore";

export const dynamic = "force-dynamic";

function unavailable() {
  return NextResponse.json(
    { error: "Reset marker unavailable" },
    {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) return unavailable();

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const result = await readLatestUsageObservationResetMarker(supabase);
    if (result.error) return unavailable();

    return NextResponse.json(result.marker, {
      headers: { "Cache-Control": RESET_MARKER_CACHE_CONTROL },
    });
  } catch {
    return unavailable();
  }
}
