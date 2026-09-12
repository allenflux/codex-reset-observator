import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { classifyTiboTweet, type ClassificationSignalType } from "../lib/radar/classification";
import {
  classifyWithGemini,
  type GeminiClassificationOutput,
  type GeminiClassificationStatus,
} from "../lib/radar/geminiClassification";

type SignalType = ClassificationSignalType;
type GoldSignalType = SignalType;

type CsvRow = {
  tweetId: string;
  text: string;
  tweetCreatedAt: string;
  detectedAt: string;
  isReply: boolean;
  isQuote: boolean;
};

type GoldRow = CsvRow & {
  gold: GoldSignalType;
  ambiguous: boolean;
};

type EvaluationRow = GoldRow & {
  rulePrediction: SignalType;
  ruleConfidence: number;
  ruleReason: string;
  geminiPrediction: SignalType | null;
  geminiConfidence: number | null;
  geminiTemporalDirection: GeminiClassificationOutput["temporalDirection"];
  geminiEvidenceQuote: string | null;
  geminiReasonJa: string | null;
  geminiResetTypeJa: GeminiClassificationOutput["resetTypeJa"];
  geminiNoticeToExecution: string | null;
  geminiStatus: GeminiClassificationStatus;
  geminiLatencyMs: number;
  geminiAttemptCount: number;
  geminiModel: string | null;
  fallbackPrediction: SignalType;
};

type ClassMetrics = {
  support: number;
  precision: number;
  recall: number;
  f1: number;
};

type EvaluationMetrics = {
  total: number;
  validPredictions: number;
  invalidPredictions: number;
  correct: number;
  accuracy: number;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  byClass: Record<SignalType, ClassMetrics>;
  confusion: Record<GoldSignalType, Record<SignalType | "no_valid_prediction", number>>;
};

type BinaryMetrics = {
  total: number;
  validPredictions: number;
  invalidPredictions: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositive: number;
  falseNegative: number;
};

const SIGNAL_TYPES: SignalType[] = ["reset_executed", "official_notice", "teaser", "irrelevant"];
const RESET_RELATED = new Set<SignalType>(["reset_executed", "official_notice", "teaser"]);
const RESET_EXECUTED_ID = new Set([
  "2083395449814229287",
  "2082317452755751098",
  "2081940052154933696",
]);
const TEASER_ID = "2081899343091843463";
const AMBIGUOUS_ID = "2083053369351090254";
export const REQUIRED_RESUME_GEMINI_MODEL = "gemini-3.5-flash-lite";
const RESUME_DELAY_MS = 10_000;
const RESUME_TWEET_IDS = new Set([
  "2082981910209540352",
  "2081899343091843463",
  "2083387677945036995",
  "2082637967852806207",
  "2082609662231502932",
  "2082241164850364555",
]);
const HISTORICAL_MODEL_ATTEMPTS = [
  ["gemini-2.0-flash", "initial candidate-order probe", "no valid classification"],
  ["gemini-flash-latest", "all 23 posts", "17 valid classifications; 6 rate_limited"],
  ["gemini-flash-latest", "remaining 6 retry", "6 rate_limited"],
  ["gemini-2.0-flash-lite", "remaining 6 retry", "6 rate_limited"],
  ["gemini-1.5-flash-latest", "remaining 6 retry", "6 api_error"],
] as const;

type EvaluationStatusRow = {
  tweetId: string;
  geminiStatus: GeminiClassificationStatus;
};

export function isAllowedResumeGeminiModel(model: string | undefined): model is string {
  return model === REQUIRED_RESUME_GEMINI_MODEL;
}

export function selectRowsForResume<T extends EvaluationStatusRow>(rows: T[]): T[] {
  return rows.filter((row) => row.geminiStatus !== "success");
}

export function shouldStopAfterStatus(status: GeminiClassificationStatus): boolean {
  return status === "rate_limited";
}

export function mergeEvaluationRows<T extends { tweetId: string }>(rows: T[], updatedRow: T): T[] {
  return rows.map((row) => (row.tweetId === updatedRow.tweetId ? updatedRow : row));
}

export function shouldWriteResumeReport(
  rows: Array<{ geminiStatus: GeminiClassificationStatus }>,
  expectedRowCount: number
): boolean {
  return rows.length === expectedRowCount && rows.every((row) => row.geminiStatus === "success");
}

function loadLocalEnvironment() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args.set(key, argv[index + 1]);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (inQuotes) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

function csvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  const header = rows.shift() ?? [];
  return rows.map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""]))
  );
}

function required(record: Record<string, string>, key: string): string {
  const value = record[key];
  if (!value) throw new Error(`CSV column ${key} is missing or empty`);
  return value;
}

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function goldForTweet(tweetId: string): { gold: GoldSignalType; ambiguous: boolean } {
  if (RESET_EXECUTED_ID.has(tweetId)) return { gold: "reset_executed", ambiguous: false };
  if (tweetId === TEASER_ID) return { gold: "teaser", ambiguous: false };
  if (tweetId === AMBIGUOUS_ID) return { gold: "irrelevant", ambiguous: true };
  return { gold: "irrelevant", ambiguous: false };
}

function readInput(filePath: string): GoldRow[] {
  const records = csvRecords(fs.readFileSync(filePath, "utf8"));
  const rows = records.map((record) => {
    const tweetId = required(record, "tweet_id");
    const { gold, ambiguous } = goldForTweet(tweetId);
    return {
      tweetId,
      text: required(record, "text"),
      tweetCreatedAt: required(record, "tweet_created_at"),
      detectedAt: required(record, "detected_at"),
      isReply: parseBoolean(record.is_reply ?? "false"),
      isQuote: parseBoolean(record.is_quote ?? "false"),
      gold,
      ambiguous,
    };
  });

  const ids = new Set(rows.map((row) => row.tweetId));
  if (rows.length !== 23 || ids.size !== 23) {
    throw new Error(`Expected 23 unique rows, found ${rows.length} rows and ${ids.size} unique tweet_id values`);
  }
  return rows;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function classifyGemini(
  row: GoldRow,
  apiKey: string | undefined,
  model: string | undefined,
): Promise<{
  output: GeminiClassificationOutput;
  latencyMs: number;
  attemptCount: number;
}> {
  const started = performance.now();
  const output = await classifyWithGemini(
    {
      text: row.text,
      tweetCreatedAt: row.tweetCreatedAt,
    },
    {
      apiKey,
      model,
      mode: "shadow",
    }
  );
  return {
    output,
    latencyMs: Math.round(performance.now() - started),
    attemptCount: 1,
  };
}

function makeMetrics(rows: EvaluationRow[], prediction: (row: EvaluationRow) => SignalType | null): EvaluationMetrics {
  const confusion = Object.fromEntries(
    SIGNAL_TYPES.map((gold) => [
      gold,
      Object.fromEntries([...SIGNAL_TYPES, "no_valid_prediction"].map((value) => [value, 0])),
    ])
  ) as EvaluationMetrics["confusion"];
  const byClass = {} as EvaluationMetrics["byClass"];
  let validPredictions = 0;
  let invalidPredictions = 0;
  let correct = 0;

  for (const row of rows) {
    const predicted = prediction(row);
    if (predicted === null) {
      invalidPredictions += 1;
      confusion[row.gold].no_valid_prediction += 1;
      continue;
    }
    validPredictions += 1;
    confusion[row.gold][predicted] += 1;
    if (predicted === row.gold) correct += 1;
  }

  for (const signalType of SIGNAL_TYPES) {
    const support = rows.filter((row) => row.gold === signalType).length;
    const tp = confusion[signalType][signalType];
    const fp = SIGNAL_TYPES.filter((gold) => gold !== signalType).reduce(
      (sum, gold) => sum + confusion[gold][signalType],
      0
    );
    const fn = SIGNAL_TYPES.filter((predicted) => predicted !== signalType).reduce(
      (sum, predicted) => sum + confusion[signalType][predicted],
      0
    ) + confusion[signalType].no_valid_prediction;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    byClass[signalType] = { support, precision, recall, f1 };
  }

  const macro = (key: keyof ClassMetrics) =>
    SIGNAL_TYPES.reduce((sum, signalType) => sum + byClass[signalType][key], 0) / SIGNAL_TYPES.length;
  return {
    total: rows.length,
    validPredictions,
    invalidPredictions,
    correct,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    macroPrecision: macro("precision"),
    macroRecall: macro("recall"),
    macroF1: macro("f1"),
    byClass,
    confusion,
  };
}

function binaryMetrics(
  rows: EvaluationRow[],
  prediction: (row: EvaluationRow) => SignalType | null,
  positive: (gold: GoldSignalType) => boolean
): BinaryMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  let validPredictions = 0;
  let invalidPredictions = 0;

  for (const row of rows) {
    const predicted = prediction(row);
    if (predicted === null) {
      invalidPredictions += 1;
      if (positive(row.gold)) fn += 1;
      continue;
    }
    validPredictions += 1;
    const actualPositive = positive(row.gold);
    const predictedPositive = positive(predicted);
    if (actualPositive === predictedPositive) correct += 1;
    if (actualPositive && predictedPositive) tp += 1;
    if (!actualPositive && predictedPositive) fp += 1;
    if (actualPositive && !predictedPositive) fn += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    total: rows.length,
    validPredictions,
    invalidPredictions,
    accuracy: rows.length === 0 ? 0 : correct / rows.length,
    precision,
    recall,
    f1,
    falsePositive: fp,
    falseNegative: fn,
  };
}

function fixed(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function appendMetricTable(lines: string[], values: Array<[string, EvaluationMetrics]>) {
  lines.push("| classifier | accuracy | macro precision | macro recall | macro F1 | valid / total |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [name, metrics] of values) {
    lines.push(
      `| ${name} | ${fixed(metrics.accuracy)} | ${fixed(metrics.macroPrecision)} | ${fixed(metrics.macroRecall)} | ${fixed(metrics.macroF1)} | ${metrics.validPredictions} / ${metrics.total} |`
    );
  }
}

function appendClassMetrics(lines: string[], name: string, metrics: EvaluationMetrics) {
  lines.push(`#### ${name}`);
  lines.push("");
  lines.push("| class | support | precision | recall | F1 |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const signalType of SIGNAL_TYPES) {
    const item = metrics.byClass[signalType];
    lines.push(`| ${signalType} | ${item.support} | ${fixed(item.precision)} | ${fixed(item.recall)} | ${fixed(item.f1)} |`);
  }
}

function appendConfusion(lines: string[], name: string, metrics: EvaluationMetrics) {
  lines.push(`#### ${name}`);
  lines.push("");
  lines.push("| gold \\ predicted | reset_executed | official_notice | teaser | irrelevant | no valid prediction |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const gold of SIGNAL_TYPES) {
    const row = metrics.confusion[gold];
    lines.push(`| ${gold} | ${row.reset_executed} | ${row.official_notice} | ${row.teaser} | ${row.irrelevant} | ${row.no_valid_prediction} |`);
  }
}

function appendBinary(lines: string[], name: string, metrics: BinaryMetrics) {
  lines.push(`| ${name} | ${fixed(metrics.precision)} | ${fixed(metrics.recall)} | ${fixed(metrics.f1)} | ${metrics.falsePositive} | ${metrics.falseNegative} | ${metrics.invalidPredictions} |`);
}

function reasonForRecommendation(
  rows: EvaluationRow[],
  primaryRows: EvaluationRow[],
  ruleMetrics: EvaluationMetrics,
  geminiMetrics: EvaluationMetrics,
  fallbackMetrics: EvaluationMetrics,
  apiSuccess: number
): string {
  if (apiSuccess === 0) {
    return "Gemini APIが有効回答を返していないため、今回の結果だけでは移行判断不能です。キーとモデルを設定して同じスクリプトを再実行し、当面はShadow運用を継続してください。";
  }
  const ruleExecuted = binaryMetrics(primaryRows, (row) => row.rulePrediction, (value) => value === "reset_executed");
  const geminiExecuted = binaryMetrics(primaryRows, (row) => row.geminiPrediction, (value) => value === "reset_executed");
  if (geminiExecuted.recall >= ruleExecuted.recall && geminiMetrics.macroF1 >= ruleMetrics.macroF1 && fallbackMetrics.accuracy >= ruleMetrics.accuracy) {
    return `Gemini主＋ルールfallbackを候補にできます。ただし${rows.length}件（曖昧除外${primaryRows.length}件）の小標本で、official_noticeの正解例もないため、直ちに全面移行せずShadow運用で追加データを集めます。`;
  }
  return "現時点ではルール継続またはGemini Shadow継続を推奨します。reset_executedのRecall、リセット関連Recall、False Positive、API安定性を追加データで確認してから主分類器を決めます。";
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[\",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeResults(filePath: string, rows: EvaluationRow[]) {
  const columns = [
    "tweet_id", "text", "gold_signal_type", "is_ambiguous", "rule_prediction", "rule_confidence", "rule_reason", "rule_correct",
    "gemini_prediction", "gemini_confidence", "gemini_temporal_direction", "gemini_evidence_quote", "gemini_reason_ja", "gemini_reset_type_ja",
    "gemini_notice_to_execution", "gemini_status", "gemini_latency_ms", "gemini_attempt_count", "gemini_model", "gemini_correct",
    "fallback_prediction", "fallback_correct",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const values = [
      row.tweetId, row.text, row.gold, row.ambiguous, row.rulePrediction, row.ruleConfidence, row.ruleReason, row.rulePrediction === row.gold,
      row.geminiPrediction, row.geminiConfidence, row.geminiTemporalDirection, row.geminiEvidenceQuote, row.geminiReasonJa, row.geminiResetTypeJa,
      row.geminiNoticeToExecution, row.geminiStatus, row.geminiLatencyMs, row.geminiAttemptCount, row.geminiModel, row.geminiPrediction === row.gold,
      row.fallbackPrediction, row.fallbackPrediction === row.gold,
    ];
    lines.push(values.map(csvEscape).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function readExistingResults(filePath: string, sourceRows: GoldRow[]): EvaluationRow[] {
  const sourceById = new Map(sourceRows.map((row) => [row.tweetId, row]));
  return csvRecords(fs.readFileSync(filePath, "utf8")).map((record) => {
    const source = sourceById.get(required(record, "tweet_id"));
    if (!source) throw new Error(`Result row has no matching source tweet: ${record.tweet_id}`);
    const optionalNumber = (value: string | undefined) => value ? Number(value) : null;
    const optionalText = (value: string | undefined) => value || null;
    return {
      ...source,
      rulePrediction: required(record, "rule_prediction") as SignalType,
      ruleConfidence: Number(required(record, "rule_confidence")),
      ruleReason: required(record, "rule_reason"),
      geminiPrediction: optionalText(record.gemini_prediction) as SignalType | null,
      geminiConfidence: optionalNumber(record.gemini_confidence),
      geminiTemporalDirection: optionalText(record.gemini_temporal_direction) as GeminiClassificationOutput["temporalDirection"],
      geminiEvidenceQuote: optionalText(record.gemini_evidence_quote),
      geminiReasonJa: optionalText(record.gemini_reason_ja),
      geminiResetTypeJa: optionalText(record.gemini_reset_type_ja) as GeminiClassificationOutput["resetTypeJa"],
      geminiNoticeToExecution: optionalText(record.gemini_notice_to_execution),
      geminiStatus: required(record, "gemini_status") as GeminiClassificationStatus,
      geminiLatencyMs: Number(record.gemini_latency_ms || 0),
      geminiAttemptCount: Number(record.gemini_attempt_count || 0),
      geminiModel: optionalText(record.gemini_model),
      fallbackPrediction: required(record, "fallback_prediction") as SignalType,
    };
  });
}

function buildReport(
  inputPath: string,
  rows: EvaluationRow[],
  primaryRows: EvaluationRow[],
  model: string | undefined,
  currentRunRows: EvaluationRow[],
  runMode: "standard" | "resume" | "fixed",
  apiSuccess: number,
  firstAttemptSuccess: number,
  totalRequests: number,
  retryCount: number,
  metrics: Record<string, EvaluationMetrics>,
  binary: Record<string, BinaryMetrics>
): string {
  const lines: string[] = [];
  const statuses = countBy(rows.map((row) => row.geminiStatus));
  const goldCounts = countBy(rows.map((row) => row.gold));
  const disagreements = rows.filter((row) => row.geminiStatus === "success" && row.rulePrediction !== row.geminiPrediction);
  const ruleMistakes = rows.filter((row) => row.rulePrediction !== row.gold);
  const geminiMistakes = rows.filter((row) => row.geminiStatus === "success" && row.geminiPrediction !== row.gold);
  const fallbackMistakes = rows.filter((row) => row.fallbackPrediction !== row.gold);
  const unavailableGemini = rows.filter((row) => row.geminiStatus !== "success");
  const fixedRunRows = runMode === "fixed"
    ? (currentRunRows.length > 0 ? currentRunRows : rows)
    : runMode === "resume"
      ? (currentRunRows.length > 0
        ? currentRunRows
        : rows.filter((row) => row.geminiModel === model && RESUME_TWEET_IDS.has(row.tweetId)))
      : [];
  const historicalRows = rows.filter((row) => !fixedRunRows.some((currentRow) => currentRow.tweetId === row.tweetId));

  lines.push("# Tibo classifier evaluation");
  lines.push("");
  lines.push(`- Input: \`${inputPath}\``);
  lines.push(`- Unique input rows: ${rows.length}`);
  lines.push(`- Primary rows: ${primaryRows.length} (ambiguous tweet ${AMBIGUOUS_ID} excluded)`);
  lines.push(`- Provisional-all rows: ${rows.length}`);
  lines.push(`- Gemini model configured for this run: ${model || "未設定"}`);
  const modelsUsed = Array.from(new Set(rows.map((row) => row.geminiModel).filter((model): model is string => Boolean(model))));
  lines.push(`- Models recorded in CSV (including historical rows): ${modelsUsed.length ? modelsUsed.join(", ") : "なし"}`);
  lines.push("- API input mode: one CSV row per request; tweet text is never batched with another post.");
  lines.push(`- API key: ${process.env.GEMINI_API_KEY ? "configured (value omitted)" : "not configured"}`);
  lines.push(`- API success: ${apiSuccess} / ${rows.length}`);
  lines.push(`- Current run requests: ${runMode === "standard" ? rows.length : fixedRunRows.length}`);
  lines.push(`- Current run successes: ${runMode === "standard" ? apiSuccess : fixedRunRows.filter((row) => row.geminiStatus === "success").length}`);
  lines.push(`- Current run first-attempt success: ${runMode === "standard" ? firstAttemptSuccess : fixedRunRows.filter((row) => row.geminiStatus === "success" && row.geminiAttemptCount === 1).length}`);
  lines.push(`- Total requests: ${totalRequests}`);
  lines.push(`- Retry requests: ${retryCount}`);
  lines.push(`- Statuses: ${Object.entries(statuses).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  lines.push("");
  lines.push("## Evaluation run separation");
  lines.push("");
  lines.push("### Historical multi-model attempts");
  lines.push("");
  lines.push("These attempts belong to the earlier exploratory evaluation. They are historical only and were not called during the current fixed-model evaluation.");
  lines.push("");
  lines.push("| model | scope | result |");
  lines.push("|---|---|---|");
  for (const [historicalModel, scope, result] of HISTORICAL_MODEL_ATTEMPTS) {
    lines.push(`| ${historicalModel} | ${scope} | ${result} |`);
  }
  lines.push("");
  lines.push(runMode === "fixed" ? "### Fixed-model evaluation" : "### Fixed-model resume");
  lines.push("");
  lines.push(`- Model: ${model || "未設定"}`);
  lines.push(`- Requests in this run: ${fixedRunRows.length}`);
  lines.push(`- Successful rows preserved from the existing CSV: ${runMode === "resume" ? historicalRows.filter((row) => row.geminiStatus === "success").length : 0}`);
  lines.push(`- Result: ${fixedRunRows.length > 0 && fixedRunRows.every((row) => row.geminiStatus === "success") ? "all successful" : "incomplete"}`);
  lines.push("");
  lines.push("## Gold labels");
  lines.push("");
  lines.push(Object.entries(goldCounts).map(([key, value]) => `- ${key}: ${value}`).join("\n"));
  lines.push("");
  lines.push("`official_notice` has zero gold examples, so its class-level metrics are undefined in a statistical sense and are shown as 0 for the fixed four-class macro average. Macro metrics average all four fixed classes, including that zero-support class.");
  lines.push("");
  lines.push("## Primary 22-row comparison");
  lines.push("");
  appendMetricTable(lines, [
    ["rule", metrics.primaryRule],
    ["Gemini", metrics.primaryGemini],
    ["Gemini + rule fallback", metrics.primaryFallback],
  ]);
  lines.push("");
  lines.push("### Binary metrics");
  lines.push("");
  lines.push("| classifier | precision | recall | F1 | false positive | false negative | invalid |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  appendBinary(lines, "rule / reset-related", binary.primaryRuleRelated);
  appendBinary(lines, "Gemini / reset-related", binary.primaryGeminiRelated);
  appendBinary(lines, "fallback / reset-related", binary.primaryFallbackRelated);
  appendBinary(lines, "rule / reset-executed", binary.primaryRuleExecuted);
  appendBinary(lines, "Gemini / reset-executed", binary.primaryGeminiExecuted);
  appendBinary(lines, "fallback / reset-executed", binary.primaryFallbackExecuted);
  lines.push("");
  appendClassMetrics(lines, "Rule", metrics.primaryRule);
  lines.push("");
  appendClassMetrics(lines, "Gemini", metrics.primaryGemini);
  lines.push("");
  appendClassMetrics(lines, "Gemini + rule fallback", metrics.primaryFallback);
  lines.push("");
  appendConfusion(lines, "Rule confusion matrix", metrics.primaryRule);
  lines.push("");
  appendConfusion(lines, "Gemini confusion matrix", metrics.primaryGemini);
  lines.push("");
  appendConfusion(lines, "Fallback confusion matrix", metrics.primaryFallback);
  lines.push("");
  lines.push("## Provisional-all 23-row comparison");
  lines.push("");
  appendMetricTable(lines, [
    ["rule", metrics.allRule],
    ["Gemini", metrics.allGemini],
    ["Gemini + rule fallback", metrics.allFallback],
  ]);
  lines.push("");
  appendConfusion(lines, "Rule confusion matrix", metrics.allRule);
  lines.push("");
  appendConfusion(lines, "Gemini confusion matrix", metrics.allGemini);
  lines.push("");
  appendConfusion(lines, "Fallback confusion matrix", metrics.allFallback);
  lines.push("");
  lines.push("## API operations");
  lines.push("");
  const successful = rows.filter((row) => row.geminiStatus === "success");
  const latencies = successful.map((row) => row.geminiLatencyMs).sort((a, b) => a - b);
  const percentile = (fraction: number) => latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * fraction))];
  lines.push(`- Valid response rate: ${fixed(apiSuccess / rows.length)}`);
  lines.push(`- Average latency: ${successful.length ? `${Math.round(successful.reduce((sum, row) => sum + row.geminiLatencyMs, 0) / successful.length)} ms` : "n/a"}`);
  lines.push(`- p50 latency: ${percentile(0.5) === null ? "n/a" : `${percentile(0.5)} ms`}`);
  lines.push(`- p95 latency: ${percentile(0.95) === null ? "n/a" : `${percentile(0.95)} ms`}`);
  lines.push("- Token usage: unavailable because the current production Gemini classifier does not expose usageMetadata.");
  lines.push("");
  lines.push("## Gemini classification results");
  lines.push("");
  const successfulClassifications = rows.filter((row) => row.geminiStatus === "success" && row.geminiPrediction);
  if (successfulClassifications.length === 0) {
    lines.push("- No valid Gemini classification results were recorded.");
  }
  for (const row of successfulClassifications) {
    lines.push(`- ${row.tweetId}: Gemini=${row.geminiPrediction}, confidence=${row.geminiConfidence ?? "n/a"}, gold=${row.gold}, correct=${row.geminiPrediction === row.gold}, model=${row.geminiModel ?? "n/a"}`);
  }
  lines.push("");
  lines.push("## Mistakes and disagreements");
  lines.push("");
  lines.push("### Rule classification mistakes");
  if (ruleMistakes.length === 0) lines.push("- None");
  for (const row of ruleMistakes) {
    lines.push(`- ${row.tweetId}: gold=${row.gold}, rule=${row.rulePrediction}`);
  }
  lines.push("");
  lines.push("### Gemini classification mistakes");
  if (geminiMistakes.length === 0) lines.push("- None among valid Gemini responses");
  for (const row of geminiMistakes) {
    lines.push(`- ${row.tweetId}: gold=${row.gold}, Gemini=${row.geminiPrediction}`);
  }
  lines.push("");
  lines.push("### Gemini + rule fallback mistakes");
  if (fallbackMistakes.length === 0) lines.push("- None");
  for (const row of fallbackMistakes) {
    lines.push(`- ${row.tweetId}: gold=${row.gold}, fallback=${row.fallbackPrediction}`);
  }
  lines.push("");
  lines.push("### Rule/Gemini disagreements");
  if (disagreements.length === 0) lines.push("- None");
  for (const row of disagreements) {
    lines.push(`- ${row.tweetId}: rule=${row.rulePrediction}, Gemini=${row.geminiPrediction}, evidence=${row.geminiEvidenceQuote ? `\`${row.geminiEvidenceQuote}\`` : "none"}`);
  }
  lines.push("");
  lines.push("### Gemini classification unavailable");
  if (unavailableGemini.length === 0) lines.push("- None");
  for (const row of unavailableGemini) lines.push(`- ${row.tweetId}: no classification result (${row.geminiStatus})`);
  lines.push("");
  lines.push("## Interpretation and recommendation");
  lines.push("");
  lines.push("- The gold set contains no `official_notice` examples, so notice performance cannot be evaluated.");
  lines.push("- API failures are never converted to `irrelevant`; they remain explicit statuses. For overall accuracy, invalid predictions count as incorrect. The confusion matrix keeps them in a separate `no_valid_prediction` column.");
  lines.push(`- ${reasonForRecommendation(rows, primaryRows, metrics.primaryRule, metrics.primaryGemini, metrics.primaryFallback, apiSuccess)}`);
  lines.push("");
  lines.push("## Scope and safety");
  lines.push("");
  lines.push("This evaluation reads the CSV, calls the existing rule and Gemini classification functions, and writes only the two report files. It does not call the production webhook, write Supabase, update `tibo_signals`, modify classifier prompts/rules, or change `classification_source`.");
  lines.push("");
  lines.push("## Re-run");
  lines.push("");
  lines.push("```text");
  if (runMode === "fixed") {
    lines.push(`npm run eval:tibo-classifiers:fixed -- --input "${inputPath}"`);
  } else if (runMode === "resume") {
    lines.push(`npm run eval:tibo-classifiers:resume -- --input "${inputPath}"`);
  } else {
    lines.push(`npm run eval:tibo-classifiers -- --input "${inputPath}"`);
  }
  lines.push("```");
  return `${lines.join("\n")}\n`;
}

async function main() {
  loadLocalEnvironment();
  const args = parseArgs(process.argv.slice(2));
  const skipGemini = args.get("skip-gemini") === "true";
  const resume = args.get("resume") === "true";
  const fixedModelEvaluation = args.get("fixed-model") === "true";
  if (skipGemini) delete process.env.GEMINI_API_KEY;
  const inputPath = path.resolve(args.get("input") || path.join("Downloads", "tibo_signals_rows.csv"));
  const outputDir = path.resolve(args.get("output-dir") || "reports");
  const limit = Number(args.get("limit") || 0);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
  if (resume && limit > 0) throw new Error("--limit cannot be used with --resume");
  if (fixedModelEvaluation && resume) throw new Error("--fixed-model cannot be combined with --resume");
  if (fixedModelEvaluation && limit > 0) throw new Error("--limit cannot be used with --fixed-model");
  if (!fs.existsSync(inputPath)) throw new Error(`Input CSV not found: ${inputPath}`);

  const allInputRows = readInput(inputPath).slice(0, limit || undefined);
  const apiKey = skipGemini ? undefined : process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL?.trim();
  if ((resume || fixedModelEvaluation) && !isAllowedResumeGeminiModel(model)) {
    throw new Error(`固定モデル評価にはGEMINI_MODEL=${REQUIRED_RESUME_GEMINI_MODEL}が必要です。APIは呼び出していません`);
  }
  if ((resume || fixedModelEvaluation) && !apiKey) {
    throw new Error("固定モデル評価にはGEMINI_API_KEYが必要です。APIは呼び出していません");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const dateStamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date()).replaceAll("-", "");
  const outputPrefix = args.get("output-prefix")?.trim();
  const outputStem = outputPrefix ? `${outputPrefix}-${dateStamp}` : `tibo-classifier-eval-${dateStamp}`;
  const csvPath = path.join(outputDir, `${outputStem}.csv`);
  const reportPath = path.join(outputDir, `${outputStem}.md`);
  if (fixedModelEvaluation && (fs.existsSync(csvPath) || fs.existsSync(reportPath))) {
    throw new Error(`Fixed-model output already exists; refusing to overwrite: ${outputStem}`);
  }
  if (resume && !fs.existsSync(csvPath)) {
    throw new Error(`Cannot resume because the result CSV does not exist: ${csvPath}`);
  }
  const existingRows = resume ? readExistingResults(csvPath, allInputRows) : [];
  const existingIds = new Set(existingRows.map((row) => row.tweetId));
  if (
    resume &&
    (existingRows.length !== allInputRows.length ||
      existingIds.size !== allInputRows.length ||
      allInputRows.some((row) => !existingIds.has(row.tweetId)))
  ) {
    throw new Error(`Cannot resume safely: result CSV has ${existingRows.length} rows, expected ${allInputRows.length}`);
  }
  let resultRows = existingRows;
  const resultById = new Map(resultRows.map((row) => [row.tweetId, row]));
  const inputRows = resume
    ? selectRowsForResume(allInputRows.map((row) => resultById.get(row.tweetId)!))
      .map((resultRow) => allInputRows.find((row) => row.tweetId === resultRow.tweetId)!)
    : allInputRows;
  if (resume) {
    const unexpectedRows = inputRows.filter((row) => !RESUME_TWEET_IDS.has(row.tweetId));
    if (unexpectedRows.length > 0) {
      throw new Error(`Cannot resume safely: unexpected unfinished tweet_id(s): ${unexpectedRows.map((row) => row.tweetId).join(", ")}`);
    }
    console.log(`Resume model: ${model}`);
    console.log(`Pending Gemini requests: ${inputRows.length}; successful rows preserved: ${allInputRows.length - inputRows.length}`);
  }
  if (fixedModelEvaluation) {
    console.log(`Fixed-model evaluation: ${model}`);
    console.log(`New Gemini requests: ${inputRows.length}; existing results reused: 0`);
  }

  let stoppedOnRateLimit = false;
  const currentRunRows: EvaluationRow[] = [];
  for (let index = 0; index < inputRows.length; index += 1) {
    const row = inputRows[index];
    if (apiKey && model && index > 0) await sleep(RESUME_DELAY_MS);
    const ruleResult = classifyTiboTweet(row.text, "");
    const gemini = await classifyGemini(row, apiKey, model);
    const evaluatedRow: EvaluationRow = {
      ...row,
      rulePrediction: ruleResult.signalType,
      ruleConfidence: ruleResult.confidence,
      ruleReason: ruleResult.reason,
      geminiPrediction: gemini.output.signalType,
      geminiConfidence: gemini.output.confidence,
      geminiTemporalDirection: gemini.output.temporalDirection,
      geminiEvidenceQuote: gemini.output.evidenceQuote,
      geminiReasonJa: gemini.output.reasonJa,
      geminiResetTypeJa: gemini.output.resetTypeJa,
      geminiNoticeToExecution: gemini.output.noticeToExecution,
      geminiStatus: gemini.output.status,
      geminiLatencyMs: gemini.latencyMs,
      geminiAttemptCount: gemini.attemptCount,
      geminiModel: gemini.output.model,
      fallbackPrediction: gemini.output.status === "success" && gemini.output.signalType ? gemini.output.signalType : ruleResult.signalType,
    };
    currentRunRows.push(evaluatedRow);
    resultRows = mergeEvaluationRows(resultRows, evaluatedRow);
    if (!resultRows.some((resultRow) => resultRow.tweetId === row.tweetId)) resultRows.push(evaluatedRow);
    resultById.set(row.tweetId, evaluatedRow);
    const checkpointRows = allInputRows
      .map((sourceRow) => resultById.get(sourceRow.tweetId))
      .filter((result): result is EvaluationRow => Boolean(result));
    writeResults(csvPath, checkpointRows);
    console.log(`${index + 1}/${inputRows.length}: ${row.tweetId} rule=${ruleResult.signalType} gemini=${gemini.output.signalType ?? gemini.output.status}`);
    if (shouldStopAfterStatus(gemini.output.status)) {
      console.warn("Gemini returned rate_limited (HTTP 429); stopping immediately.");
      stoppedOnRateLimit = true;
      break;
    }
  }

  const rows = allInputRows
    .map((sourceRow) => resultById.get(sourceRow.tweetId))
    .filter((result): result is EvaluationRow => Boolean(result));
  if (stoppedOnRateLimit || (resume && !shouldWriteResumeReport(rows, allInputRows.length))) {
    console.log("Evaluation incomplete; CSV checkpoint saved. Markdown report was not regenerated.");
    return;
  }
  const firstAttemptSuccess = rows.filter((row) => row.geminiStatus === "success" && row.geminiAttemptCount === 1).length;
  const totalRequests = rows.reduce((sum, row) => sum + row.geminiAttemptCount, 0);
  const primaryRows = rows.filter((row) => !row.ambiguous);
  const metrics: Record<string, EvaluationMetrics> = {
    primaryRule: makeMetrics(primaryRows, (row) => row.rulePrediction),
    primaryGemini: makeMetrics(primaryRows, (row) => row.geminiPrediction),
    primaryFallback: makeMetrics(primaryRows, (row) => row.fallbackPrediction),
    allRule: makeMetrics(rows, (row) => row.rulePrediction),
    allGemini: makeMetrics(rows, (row) => row.geminiPrediction),
    allFallback: makeMetrics(rows, (row) => row.fallbackPrediction),
  };
  const binary: Record<string, BinaryMetrics> = {
    primaryRuleRelated: binaryMetrics(primaryRows, (row) => row.rulePrediction, (value) => RESET_RELATED.has(value)),
    primaryGeminiRelated: binaryMetrics(primaryRows, (row) => row.geminiPrediction, (value) => RESET_RELATED.has(value)),
    primaryFallbackRelated: binaryMetrics(primaryRows, (row) => row.fallbackPrediction, (value) => RESET_RELATED.has(value)),
    primaryRuleExecuted: binaryMetrics(primaryRows, (row) => row.rulePrediction, (value) => value === "reset_executed"),
    primaryGeminiExecuted: binaryMetrics(primaryRows, (row) => row.geminiPrediction, (value) => value === "reset_executed"),
    primaryFallbackExecuted: binaryMetrics(primaryRows, (row) => row.fallbackPrediction, (value) => value === "reset_executed"),
  };

  writeResults(csvPath, rows);
  fs.writeFileSync(
    reportPath,
    buildReport(
      inputPath,
      rows,
      primaryRows,
      model,
      currentRunRows,
      fixedModelEvaluation ? "fixed" : resume ? "resume" : "standard",
      rows.filter((row) => row.geminiStatus === "success").length,
      firstAttemptSuccess,
      totalRequests,
      totalRequests - rows.length,
      metrics,
      binary
    ),
    "utf8"
  );
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${reportPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Evaluation failed");
    process.exitCode = 1;
  });
}
