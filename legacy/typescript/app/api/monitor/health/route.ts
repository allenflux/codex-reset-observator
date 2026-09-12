import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import {
  evaluateTiboHeartbeat,
  type TiboHeartbeatSnapshot,
} from "@/lib/radar/monitorHealth";
import { isBearerAuthorizationValid } from "@/lib/security/bearerAuth";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
};

function unavailable(detail: "configuration_unavailable" | "database_unavailable") {
  return NextResponse.json(
    { status: "unhealthy", detail },
    { status: 503, headers: noStoreHeaders },
  );
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return unavailable("configuration_unavailable");
  }

  if (!isBearerAuthorizationValid(request.headers.get("authorization"), cronSecret)) {
    return NextResponse.json(
      { status: "unhealthy", detail: "unauthorized" },
      { status: 401, headers: noStoreHeaders },
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return unavailable("configuration_unavailable");
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from("tibo_heartbeat")
      .select(
        "session_started_at,last_heartbeat_at,last_successful_parse_at,last_scan_error,last_page_reload_status,last_page_reload_error",
      )
      .eq("id", "main")
      .maybeSingle();

    if (error) {
      return unavailable("database_unavailable");
    }

    const health = evaluateTiboHeartbeat(
      data as TiboHeartbeatSnapshot | null,
      new Date(),
    );

    return NextResponse.json(health, {
      status: health.status === "unhealthy" ? 503 : 200,
      headers: noStoreHeaders,
    });
  } catch {
    return unavailable("database_unavailable");
  }
}
