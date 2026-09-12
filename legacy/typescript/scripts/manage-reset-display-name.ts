import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyManualResetDisplayNameOverride } from "../lib/radar/resetDisplayNameStore";
import {
  validateManualResetDisplayNameInput,
  type ManualResetDisplayNameOverrideInput,
  type ManualResetDisplayNameOverrideResult,
} from "../lib/radar/manualResetDisplayNameOverride";

const VALUE_FLAGS = {
  "--event-key": "eventKey",
  "--name-ja": "manualNameJa",
  "--name-en": "manualNameEn",
  "--name-zh": "manualNameZh",
} as const;

type ManualResetDisplayNameInputField = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

export type ParsedManualResetDisplayNameArgs = {
  apply: boolean;
  input: ManualResetDisplayNameOverrideInput;
};

type ManualResetDisplayNameExecutor = (
  input: ManualResetDisplayNameOverrideInput,
  options: { apply?: boolean },
) => Promise<ManualResetDisplayNameOverrideResult>;

export function parseManualResetDisplayNameArgs(
  args: string[],
): ParsedManualResetDisplayNameArgs {
  const values: Partial<Record<ManualResetDisplayNameInputField, string>> = {};
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      if (apply) throw new Error("--apply may only be specified once");
      apply = true;
      continue;
    }

    const field = VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS];
    if (!field) throw new Error(`Unknown argument: ${arg}`);
    if (values[field] !== undefined) throw new Error(`${arg} may only be specified once`);

    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} is required`);
    values[field] = value;
    index += 1;
  }

  for (const [flag, field] of Object.entries(VALUE_FLAGS)) {
    if (values[field] === undefined) throw new Error(`${flag} is required`);
  }

  return {
    apply,
    input: validateManualResetDisplayNameInput({
      eventKey: values.eventKey!,
      manualNameJa: values.manualNameJa!,
      manualNameEn: values.manualNameEn!,
      manualNameZh: values.manualNameZh!,
    }),
  };
}

const USAGE = [
  "Usage:",
  "  pnpm exec tsx scripts/manage-reset-display-name.ts",
  "    --event-key <event-key>",
  "    --name-ja <Japanese name>",
  "    --name-en <English name>",
  "    --name-zh <Chinese name> [--apply]",
  "",
  "Without --apply, the command performs a dry-run and does not write to the database.",
].join("\n");

export async function runManualResetDisplayNameCli(
  args: string[],
  execute: ManualResetDisplayNameExecutor = applyManualResetDisplayNameOverride,
): Promise<number> {
  const parsed = parseManualResetDisplayNameArgs(args);
  const result = await execute(parsed.input, { apply: parsed.apply });
  const report = {
    status: result.status,
    eventKey: result.eventKey,
    sourceTweetId: result.existing?.source_tweet_id ?? null,
    existingManualNameJa: result.existing?.manual_name_ja ?? null,
    existingManualNameEn: result.existing?.manual_name_en ?? null,
    existingManualNameZh: result.existing?.manual_name_zh ?? null,
    apply: parsed.apply,
    proposedUpdate: result.payload,
  };

  if (result.status === "not_found") {
    console.error(JSON.stringify(report, null, 2));
    console.error(`No reset display name record found for event key: ${result.eventKey}`);
    return 1;
  }

  console.log(JSON.stringify(report, null, 2));
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  return runManualResetDisplayNameCli(args);
}

const currentModulePath = path.resolve(fileURLToPath(import.meta.url));
const invokedModulePath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedModulePath === currentModulePath) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
