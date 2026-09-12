import fs from "node:fs";
import path from "node:path";
import { reconcileResetDisplayNames } from "../lib/radar/resetDisplayNameReconciliation";

function loadLocalEnvironment() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].trim();
    process.env[match[1]] =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
  }
}

function getArgument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function isResetDisplayNameReconcileApplyMode(args: string[]) {
  return args.includes("--apply");
}

async function main() {
  loadLocalEnvironment();
  if (!process.env.SUPABASE_URL?.trim() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const apply = isResetDisplayNameReconcileApplyMode(process.argv);
  const maxGeminiRequests = Number(getArgument("max-gemini", "3"));
  if (!Number.isInteger(maxGeminiRequests) || maxGeminiRequests < 0 || maxGeminiRequests > 3) {
    throw new Error("--max-gemini must be an integer from 0 to 3");
  }

  const result = await reconcileResetDisplayNames({
    maxGeminiRequests,
    dryRun: !apply,
  });
  process.stdout.write(JSON.stringify({
    status: apply ? "applied" : "dry_run",
    ...result,
  }, null, 2) + "\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "reconciliation failed";
  console.error(message);
  process.exitCode = 1;
});
