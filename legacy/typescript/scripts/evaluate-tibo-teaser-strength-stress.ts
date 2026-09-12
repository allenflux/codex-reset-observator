import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPost,
  computeAgreement,
  computeEvidenceValidity,
  computeTeaserStrengthMetrics,
  loadLocalEnvironment,
  type TeaserEvaluationCase,
  type TeaserEvaluationResult,
  type TeaserEvaluationRow,
  type TeaserStrength,
} from "./evaluate-tibo-teaser-strength";

export const STRESS_CASES: TeaserEvaluationCase[] = [
  { tweetId: "S1", text: "I have a suspiciously convenient reset button and a free evening. Give me a couple hours.", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "S2", text: "Keep the good Codex feedback coming. I might have something for your usage limits later tonight :)", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "S3", text: "Laptop is charging. Reset finger is warming up. See you after dinner.", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "S4", text: "If you're running low on Codex today, maybe don't go to bed too early.", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "S5", text: "Okay okay, I hear you. Let me get back to my laptop and see what I can do about those limits.", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "S6", text: "Good feedback today. Very good feedback. I suddenly feel like pressing a certain button in a few hours.", tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "W1", text: "Good bug reports have been known to dramatically increase the odds that I press the reset button. Just saying.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W2", text: "I do have the ability to reset limits, and good feedback is usually the fastest way to convince me.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W3", text: "People keep asking what it takes to get a reset out of me. Useful feedback certainly doesn't hurt.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W4", text: "I'm not promising anything, but I have occasionally rewarded exceptionally good Codex feedback with a reset.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W5", text: "The reset button is entirely discretionary. Fortunately for you, I enjoy good bug reports.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W6", text: "Yes, sometimes I reset people just because the request made me laugh. There are worse governance models.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W7", text: "A surprisingly effective way to get me to reset limits is to send me a genuinely useful reproduction.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "W8", text: "No schedule for resets. I just occasionally do one when the feedback and timing are good.", tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "N1", text: "There will be signs when the infrastructure gets really efficient. Faster inference. Lower prices. Maybe even more resets.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N2", text: "The reset button remains one of my favorite accidental product features.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N3", text: "Three resets in one week was probably a little excessive in hindsight.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N4", text: "No reset tonight. Please stop refreshing my profile :)", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N5", text: "People have asked for a reset approximately 200 times today. You people are relentless.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N6", text: "Imagine if there were a giant red reset button in the Codex app. Product team, you're welcome.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N7", text: "Resets are an interesting signal of how quickly usage can change after a model launch.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N8", text: "One day I'll write the full story of how the reset button became a meme.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N9", text: "I reset the limits earlier today. Please enjoy them responsibly this time.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N10", text: "You all seem convinced that every vague tweet I make means a reset is coming.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N11", text: "If I had a dollar for every reset request, we'd have enough compute for everyone.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "N12", text: "Maybe resets are the friends we made along the way.", tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "R1", text: "Great repro. You know how to get my attention :)", replyContext: { parentText: "Any chance of a Codex reset today? I have a great repro for the Luna issue." }, tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "R2", text: "lol", replyContext: { parentText: "Reset us please!" }, tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "R3", text: "Give me an hour.", replyContext: { parentText: "Reset tonight?" }, tweetUrl: null, tweetCreatedAt: null, expected: "strong", source: "synthetic" },
  { tweetId: "R4", text: "Yep, done.", replyContext: { parentText: "Did you reset everyone already?" }, tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
  { tweetId: "R5", text: "A really good bug report usually helps.", replyContext: { parentText: "What does it take to convince you to reset Codex?" }, tweetUrl: null, tweetCreatedAt: null, expected: "weak", source: "synthetic" },
  { tweetId: "R6", text: "I hope not :)", replyContext: { parentText: "Are resets going to become a regular feature?" }, tweetUrl: null, tweetCreatedAt: null, expected: "none", source: "synthetic" },
];

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function csvField(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(filePath: string, rows: TeaserEvaluationRow[]) {
  const headers = [
    "run", "tweet_id", "reply_context", "text", "expected", "prediction", "confidence",
    "evidence_quote", "evidence_valid", "reason_ja", "status", "model", "latency_ms", "http_status",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push([
      row.run, row.tweetId, row.replyContext?.parentText ?? "", row.text, row.expected, row.prediction,
      row.confidence, row.evidenceQuote, row.evidenceValid, row.reasonJa, row.status, row.model,
      row.latencyMs, row.httpStatus,
    ].map(csvField).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function buildReport(
  rows: TeaserEvaluationRow[],
  model: string,
  requestedRuns: number,
  completedRuns: number,
  startedAt: string,
) {
  const cases = STRESS_CASES;
  const ordinaryCases = cases.filter((post) => !post.replyContext);
  const replyCases = cases.filter((post) => post.replyContext);
  const lines = [
    "# Tibo teaser strength synthetic stress test",
    "",
    "This is a holdout evaluation-only dataset. Its expected labels were not sent to Gemini and were not added to the system prompt or few-shot examples.",
    "Production classification, database rows, UI, probability, and the existing Gemini prompt were not changed.",
    "",
    `- Evaluation started: ${startedAt}`,
    `- Gemini model: ${model}`,
    `- Dataset: ${cases.length} holdout posts (${ordinaryCases.length} ordinary + ${replyCases.length} reply-context)` ,
    `- Requested runs: ${requestedRuns}`,
    `- Completed runs: ${completedRuns}`,
    `- API requests: ${rows.length}`,
    `- Successful responses: ${rows.filter((row) => row.status === "success").length}`,
    `- Rate-limited responses: ${rows.filter((row) => row.status === "rate_limited").length}`,
    "",
    "## Gold distribution",
    "",
    ...(["strong", "weak", "none"] as const).map((label) => `- ${label}: ${cases.filter((post) => post.expected === label).length}`),
  ];

  const metricsForRun = (subset: TeaserEvaluationCase[], run: number) => {
    const runRows = rows.filter((row) => row.run === run);
    return computeTeaserStrengthMetrics(subset, subset.map((post) => {
      const row = runRows.find((candidate) => candidate.tweetId === post.tweetId);
      return row ? { teaserStrength: row.prediction, status: row.status } : null;
    }));
  };
  const metricsForAggregate = (subset: TeaserEvaluationCase[]) => {
    const ids = new Set(subset.map((post) => post.tweetId));
    const aggregateRows = rows.filter((row) => ids.has(row.tweetId));
    return computeTeaserStrengthMetrics(
      aggregateRows,
      aggregateRows.map((row) => ({ teaserStrength: row.prediction, status: row.status })),
    );
  };
  const addMetrics = (title: string, subset: TeaserEvaluationCase[]) => {
    lines.push("", title, "", "| run | accuracy | strong P/R | weak P/R | none P/R |", "|---:|---:|---:|---:|---:|");
    for (let run = 1; run <= requestedRuns; run += 1) {
      const metrics = metricsForRun(subset, run);
      lines.push(`| ${run} | ${percent(metrics.accuracy)} | ${percent(metrics.byClass.strong.precision)} / ${percent(metrics.byClass.strong.recall)} | ${percent(metrics.byClass.weak.precision)} / ${percent(metrics.byClass.weak.recall)} | ${percent(metrics.byClass.none.precision)} / ${percent(metrics.byClass.none.recall)} |`);
    }
    const metrics = metricsForAggregate(subset);
    lines.push(`| all | ${percent(metrics.accuracy)} | ${percent(metrics.byClass.strong.precision)} / ${percent(metrics.byClass.strong.recall)} | ${percent(metrics.byClass.weak.precision)} / ${percent(metrics.byClass.weak.recall)} | ${percent(metrics.byClass.none.precision)} / ${percent(metrics.byClass.none.recall)} |`);
  };

  const evidenceForRun = (subset: TeaserEvaluationCase[], run: number) => {
    const runRows = rows.filter((row) => row.run === run);
    return computeEvidenceValidity(subset, subset.map((post) => {
      const row = runRows.find((candidate) => candidate.tweetId === post.tweetId);
      return row ? { teaserStrength: row.prediction, status: row.status, evidenceValid: row.evidenceValid } : null;
    }));
  };
  const evidenceForAggregate = (subset: TeaserEvaluationCase[]) => {
    const ids = new Set(subset.map((post) => post.tweetId));
    const aggregateRows = rows.filter((row) => ids.has(row.tweetId));
    return computeEvidenceValidity(aggregateRows, aggregateRows.map((row) => ({ teaserStrength: row.prediction, status: row.status, evidenceValid: row.evidenceValid })));
  };
  const addEvidence = (title: string, subset: TeaserEvaluationCase[]) => {
    lines.push("", title, "", "| run | classified | evidence valid | invalid_evidence | valid rate |", "|---:|---:|---:|---:|---:|");
    for (let run = 1; run <= requestedRuns; run += 1) {
      const evidence = evidenceForRun(subset, run);
      lines.push(`| ${run} | ${evidence.classified} | ${evidence.valid} | ${evidence.invalid} | ${percent(evidence.validRate)} |`);
    }
    const evidence = evidenceForAggregate(subset);
    lines.push(`| all | ${evidence.classified} | ${evidence.valid} | ${evidence.invalid} | ${percent(evidence.validRate)} |`);
    for (const label of ["strong", "weak", "none"] as const) {
      const classEvidence = evidence.byClass[label];
      lines.push(`- Expected ${label}: ${classEvidence.valid}/${classEvidence.total} valid (${percent(classEvidence.validRate)}).`);
    }
  };

  addMetrics("## Classification metrics (all)", cases);
  addMetrics("## Classification metrics (ordinary posts)", ordinaryCases);
  addMetrics("## Classification metrics (reply-context posts)", replyCases);
  addEvidence("## Evidence quote validation (all)", cases);
  addEvidence("## Evidence quote validation (ordinary posts)", ordinaryCases);
  addEvidence("## Evidence quote validation (reply-context posts)", replyCases);

  const agreement = computeAgreement(rows, requestedRuns);
  const ordinaryAgreement = computeAgreement(rows.filter((row) => !row.replyContext), requestedRuns);
  const replyAgreement = computeAgreement(rows.filter((row) => row.replyContext), requestedRuns);
  lines.push(
    "",
    "## Stability",
    "",
    `- All-run unanimous: ${agreement.unanimousCaseCount}/${agreement.caseCount} (${percent(agreement.unanimousRate)})`,
    `- Pairwise agreement: ${agreement.pairwiseAgreementCount}/${agreement.pairwiseComparableCount} (${percent(agreement.pairwiseAgreementRate)})`,
    `- Ordinary unanimous: ${ordinaryAgreement.unanimousCaseCount}/${ordinaryAgreement.caseCount} (${percent(ordinaryAgreement.unanimousRate)})`,
    `- Reply-context unanimous: ${replyAgreement.unanimousCaseCount}/${replyAgreement.caseCount} (${percent(replyAgreement.unanimousRate)})`,
    "",
    "## Per-post results",
    "",
    "| id | type | expected | run 1 | run 2 | run 3 | evidence valid |",
    "|---|---|---|---|---|---|---|",
  );
  for (const post of cases) {
    const postRows = rows.filter((row) => row.tweetId === post.tweetId).sort((left, right) => left.run - right.run);
    const cell = (row: TeaserEvaluationRow | undefined) => row?.status === "success" ? `${row.prediction} (${row.confidence?.toFixed(2) ?? "n/a"})` : row?.status ?? "not run";
    const evidence = postRows.every((row) => row.evidenceValid === true) ? "yes" : postRows.some((row) => row.evidenceValid === false) ? "no" : "unknown";
    lines.push(`| ${post.tweetId} | ${post.replyContext ? "reply" : "ordinary"} | ${post.expected} | ${cell(postRows[0])} | ${cell(postRows[1])} | ${cell(postRows[2])} | ${evidence} |`);
  }

  lines.push("", "## Misclassified posts", "");
  const errors = cases.filter((post) => rows.filter((row) => row.tweetId === post.tweetId).some((row) => row.status !== "success" || row.prediction !== post.expected));
  if (errors.length === 0) {
    lines.push("No misclassified posts in the completed runs.");
  } else {
    for (const post of errors) {
      const postRows = rows.filter((row) => row.tweetId === post.tweetId);
      lines.push(`- **${post.tweetId}** expected **${post.expected}**: ${postRows.map((row) => `run ${row.run}=${row.prediction ?? row.status}`).join(", ")}`);
      if (post.replyContext) lines.push(`  - Parent: ${compactText(post.replyContext.parentText)}`);
      lines.push(`  - Tibo text: ${compactText(post.text)}`);
    }
  }

  lines.push(
    "",
    "## Comparison with the third evaluation",
    "",
    "- The prior 35-case evaluation used the same narrowed weak definition and reported 100% class accuracy for its non-synthetic set, with all-run and pairwise agreement at 100%.",
    "- This 32-case set is an unseen stress test: 26 ordinary synthetic cases and 6 reply-context cases. It was not added to the prompt or few-shot examples.",
    "- Synthetic results are diagnostic evidence only and should not be treated as production performance evidence.",
    "",
    "## Safety",
    "",
    "The script calls Gemini only for this holdout dataset. It does not query or update Supabase, does not update production classifications, and does not change UI or probability code.",
  );
  return lines.join("\n");
}

function getArgument(name: string, fallback: string) {
  const index = process.argv.findIndex((value) => value === `--${name}` || value.startsWith(`--${name}=`));
  if (index < 0) return fallback;
  const token = process.argv[index];
  if (token.includes("=")) return token.slice(name.length + 3);
  return process.argv[index + 1] ?? fallback;
}

async function main() {
  loadLocalEnvironment();
  const model = process.env.GEMINI_MODEL?.trim();
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!model) throw new Error("GEMINI_MODEL is not configured; no API call was made");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured; no API call was made");

  const requestedRuns = Number(getArgument("runs", "3"));
  const delayMs = Number(getArgument("delay-ms", "6000"));
  const timeoutMs = Number(getArgument("timeout-ms", "10000"));
  if (!Number.isInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 5) throw new Error("--runs must be an integer from 1 to 5");
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("--delay-ms must be a non-negative integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms must be at least 1000");

  const startedAt = new Date().toISOString();
  const rows: TeaserEvaluationRow[] = [];
  let completedRuns = 0;
  let stopAfterRateLimit = false;
  for (let run = 1; run <= requestedRuns && !stopAfterRateLimit; run += 1) {
    for (let index = 0; index < STRESS_CASES.length; index += 1) {
      if (rows.length > 0) await sleep(delayMs);
      const post = STRESS_CASES[index];
      const result: TeaserEvaluationResult = await classifyPost(post, model, apiKey, timeoutMs);
      rows.push({ ...post, run, prediction: result.teaserStrength, confidence: result.confidence, evidenceQuote: result.evidenceQuote, evidenceValid: result.evidenceValid, reasonJa: result.reasonJa, status: result.status, model: result.model, latencyMs: result.latencyMs, httpStatus: result.httpStatus });
      console.log(`run=${run} ${index + 1}/${STRESS_CASES.length} ${post.tweetId} ${result.status === "success" ? result.teaserStrength : result.status}`);
      if (result.status === "rate_limited") {
        console.warn("Gemini returned HTTP 429; stopping stress test without retrying.");
        stopAfterRateLimit = true;
        break;
      }
    }
    if (!stopAfterRateLimit) completedRuns += 1;
  }

  const dateStamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()).replaceAll("-", "");
  const outputDir = path.resolve(getArgument("output-dir", "reports"));
  const stem = `tibo-teaser-strength-stress-eval-${dateStamp}`;
  const csvPath = path.join(outputDir, `${stem}.csv`);
  const reportPath = path.join(outputDir, `${stem}.md`);
  fs.mkdirSync(outputDir, { recursive: true });
  writeCsv(csvPath, rows);
  fs.writeFileSync(reportPath, buildReport(rows, model, requestedRuns, completedRuns, startedAt), "utf8");
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(`Model: ${model}`);
  console.log(`Dataset: ${STRESS_CASES.length}; completed runs: ${completedRuns}/${requestedRuns}; requests: ${rows.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Teaser strength stress evaluation failed");
    process.exitCode = 1;
  });
}
