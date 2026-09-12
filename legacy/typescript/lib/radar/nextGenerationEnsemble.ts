import {
  NEXT_GENERATION_A_ALPHA_PRIOR_STD_DEV,
  NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON,
  NEXT_GENERATION_A_COMPONENT_VERSIONS,
  NEXT_GENERATION_A_MINIMUM_SAMPLES,
  NEXT_GENERATION_A_MODEL_VERSION,
  NEXT_GENERATION_A_SOLVER_BACKTRACKING_FACTOR,
  NEXT_GENERATION_A_SOLVER_INITIAL_STEP,
  NEXT_GENERATION_A_SOLVER_MAX_BACKTRACKING_STEPS,
  NEXT_GENERATION_A_SOLVER_MAX_ITERATIONS,
  NEXT_GENERATION_A_SOLVER_TOLERANCE,
  NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN,
  NEXT_GENERATION_A_WEIGHT_PRIOR_STD_DEV,
  NEXT_GENERATION_FREEZE_AT,
  NEXT_GENERATION_FREEZE_POLICY,
} from "@/data/shadowProbabilityConfig";
import { derive12hFrom24hProbability, derive72hFrom48hProbability } from "./shadowProbability";
import { enforceNextGenerationHorizonCoherence } from "./nextGenerationProbability";

export type NextGenerationComponentForecast = {
  modelVersion: string;
  probability24h: number;
  probability48h: number;
};

export type NextGenerationEnsembleTrainingRow = {
  generatedAt: string;
  components: Record<string, NextGenerationComponentForecast>;
  actual24h?: boolean;
  actual48h?: boolean;
};

type EnsembleHorizon = "24h" | "48h";

export type NextGenerationEnsembleFit = {
  trainingMode: "equal" | "fitted" | "solver_failed";
  alpha: number;
  weights: number[];
  sampleCount: number;
  positiveCount: number;
  solver: {
    converged: boolean;
    iterations: number;
    objective: number | null;
    reason: string | null;
  };
  lastResolvedOrigin: string | null;
};

export type NextGenerationAResult = {
  modelVersion: typeof NEXT_GENERATION_A_MODEL_VERSION;
  generatedAt: string;
  rawProbability24h: number;
  rawProbability48h: number;
  probability12h: number;
  probability24h: number;
  probability48h: number;
  probability72h: number;
  componentModelVersions: readonly string[];
  componentProbabilities24h: number[];
  componentProbabilities48h: number[];
  componentLogitEpsilon: number;
  alpha24h: number;
  alpha48h: number;
  weights24h: number[];
  weights48h: number[];
  trainingMode24h: NextGenerationEnsembleFit["trainingMode"];
  trainingMode48h: NextGenerationEnsembleFit["trainingMode"];
  trainingSampleCount24h: number;
  trainingSampleCount48h: number;
  positiveTrainingCount24h: number;
  positiveTrainingCount48h: number;
  fitCutoff24h: string | null;
  fitCutoff48h: string | null;
  horizonCoherenceAdjusted: boolean;
  regularization: {
    alphaPriorStdDev: number;
    weightPriorMean: number;
    weightPriorStdDev: number;
  };
  solver24h: NextGenerationEnsembleFit["solver"];
  solver48h: NextGenerationEnsembleFit["solver"];
  freezeAt: typeof NEXT_GENERATION_FREEZE_AT;
  freezePolicy: typeof NEXT_GENERATION_FREEZE_POLICY;
};

function finiteProbability(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectNextGenerationSimplex(values: number[]) {
  if (values.length === 0) return [];
  const sorted = values
    .map((value) => Number.isFinite(value) ? value : 0)
    .slice()
    .sort((left, right) => right - left);
  let cumulative = 0;
  let rho = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    cumulative += sorted[index];
    if (sorted[index] + (1 - cumulative) / (index + 1) > 0) rho = index;
  }
  if (rho < 0) return values.map(() => 1 / values.length);
  const theta = (sorted.slice(0, rho + 1).reduce((sum, value) => sum + value, 0) - 1) / (rho + 1);
  return values.map((value) => Math.max(0, (Number.isFinite(value) ? value : 0) - theta));
}

function logit(value: number) {
  const safe = Math.min(
    1 - NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON,
    Math.max(NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON, value),
  );
  return Math.log(safe / (1 - safe));
}

function sigmoid(value: number) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function getLogits(row: NextGenerationEnsembleTrainingRow, horizon: EnsembleHorizon) {
  return NEXT_GENERATION_A_COMPONENT_VERSIONS.map((modelVersion) => {
    const component = row.components[modelVersion];
    return logit(component[horizon === "24h" ? "probability24h" : "probability48h"]);
  });
}

function getJstDayKey(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp(value)!));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function selectDailyResolvedTrainingRows(
  rows: Array<NextGenerationEnsembleTrainingRow>,
  horizon: EnsembleHorizon,
) {
  const selected = new Map<string, NextGenerationEnsembleTrainingRow>();
  for (const row of rows
    .filter((candidate) => {
      const actual = horizon === "24h" ? candidate.actual24h : candidate.actual48h;
      return timestamp(candidate.generatedAt) !== null && typeof actual === "boolean";
    })
    .slice()
    .sort((left, right) => timestamp(left.generatedAt)! - timestamp(right.generatedAt)!)) {
    const dayKey = getJstDayKey(row.generatedAt);
    if (!selected.has(dayKey)) selected.set(dayKey, row);
  }
  return Array.from(selected.values());
}

function getObjective(
  samples: Array<{ logits: number[]; actual: boolean }>,
  alpha: number,
  weights: number[],
) {
  if (!Number.isFinite(alpha) || weights.some((value) => !Number.isFinite(value))) return Number.POSITIVE_INFINITY;
  let objective = alpha ** 2 / (2 * NEXT_GENERATION_A_ALPHA_PRIOR_STD_DEV ** 2);
  for (const weight of weights) {
    objective += (weight - NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN) ** 2 /
      (2 * NEXT_GENERATION_A_WEIGHT_PRIOR_STD_DEV ** 2);
  }
  for (const sample of samples) {
    const eta = alpha + sample.logits.reduce((sum, value, index) => sum + value * weights[index], 0);
    if (!Number.isFinite(eta)) return Number.POSITIVE_INFINITY;
    objective += Math.max(0, eta) - Number(sample.actual) * eta + Math.log1p(Math.exp(-Math.abs(eta)));
  }
  return Number.isFinite(objective) ? objective : Number.POSITIVE_INFINITY;
}

function getGradient(
  samples: Array<{ logits: number[]; actual: boolean }>,
  alpha: number,
  weights: number[],
) {
  let alphaGradient = alpha / (NEXT_GENERATION_A_ALPHA_PRIOR_STD_DEV ** 2);
  const weightGradient = weights.map((weight) =>
    (weight - NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN) /
    (NEXT_GENERATION_A_WEIGHT_PRIOR_STD_DEV ** 2),
  );
  for (const sample of samples) {
    const eta = alpha + sample.logits.reduce((sum, value, index) => sum + value * weights[index], 0);
    const probability = sigmoid(eta);
    const residual = probability - Number(sample.actual);
    alphaGradient += residual;
    for (let index = 0; index < weightGradient.length; index += 1) {
      weightGradient[index] += residual * sample.logits[index];
    }
  }
  return { alphaGradient, weightGradient };
}

function failedFit(sampleCount: number, positiveCount: number, lastResolvedOrigin: string | null, reason: string): NextGenerationEnsembleFit {
  return {
    trainingMode: "solver_failed",
    alpha: 0,
    weights: [],
    sampleCount,
    positiveCount,
    lastResolvedOrigin,
    solver: { converged: false, iterations: 0, objective: null, reason },
  };
}

export function fitNextGenerationEnsemble(
  rows: Array<NextGenerationEnsembleTrainingRow>,
  horizon: EnsembleHorizon,
): NextGenerationEnsembleFit {
  const resolvedRows = selectDailyResolvedTrainingRows(rows, horizon);
  const samples = resolvedRows.map((row) => ({
    logits: getLogits(row, horizon),
    actual: (horizon === "24h" ? row.actual24h : row.actual48h) as boolean,
  }));
  const positiveCount = samples.filter((sample) => sample.actual).length;
  const lastResolvedOrigin = resolvedRows.at(-1)?.generatedAt ?? null;
  if (samples.length < NEXT_GENERATION_A_MINIMUM_SAMPLES) {
    return {
      trainingMode: "equal",
      alpha: 0,
      weights: NEXT_GENERATION_A_COMPONENT_VERSIONS.map(() => NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN),
      sampleCount: samples.length,
      positiveCount,
      lastResolvedOrigin,
      solver: { converged: true, iterations: 0, objective: null, reason: null },
    };
  }

  let alpha = 0;
  let weights = NEXT_GENERATION_A_COMPONENT_VERSIONS.map(() => NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN);
  let objective = getObjective(samples, alpha, weights);
  if (!Number.isFinite(objective)) return failedFit(samples.length, positiveCount, lastResolvedOrigin, "initial_objective_non_finite");

  for (let iteration = 1; iteration <= NEXT_GENERATION_A_SOLVER_MAX_ITERATIONS; iteration += 1) {
    const gradient = getGradient(samples, alpha, weights);
    let step = NEXT_GENERATION_A_SOLVER_INITIAL_STEP;
    let accepted: { alpha: number; weights: number[]; objective: number } | null = null;
    for (let backtracking = 0; backtracking <= NEXT_GENERATION_A_SOLVER_MAX_BACKTRACKING_STEPS; backtracking += 1) {
      const candidateAlpha = alpha - step * gradient.alphaGradient;
      const candidateWeights = projectNextGenerationSimplex(
        weights.map((weight, index) => weight - step * gradient.weightGradient[index]),
      );
      const candidateObjective = getObjective(samples, candidateAlpha, candidateWeights);
      if (
        Number.isFinite(candidateObjective)
        && candidateObjective <= objective
        && candidateWeights.every((value) => Number.isFinite(value) && value >= 0)
        && Math.abs(candidateWeights.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9
      ) {
        accepted = { alpha: candidateAlpha, weights: candidateWeights, objective: candidateObjective };
        break;
      }
      step *= NEXT_GENERATION_A_SOLVER_BACKTRACKING_FACTOR;
    }
    if (!accepted) return failedFit(samples.length, positiveCount, lastResolvedOrigin, "backtracking_failed");
    const maxDelta = Math.max(
      Math.abs(accepted.alpha - alpha),
      ...accepted.weights.map((value, index) => Math.abs(value - weights[index])),
    );
    alpha = accepted.alpha;
    weights = accepted.weights;
    objective = accepted.objective;
    if (maxDelta <= NEXT_GENERATION_A_SOLVER_TOLERANCE) {
      return {
        trainingMode: "fitted",
        alpha,
        weights,
        sampleCount: samples.length,
        positiveCount,
        lastResolvedOrigin,
        solver: { converged: true, iterations: iteration, objective, reason: null },
      };
    }
  }

  return failedFit(samples.length, positiveCount, lastResolvedOrigin, "max_iterations_exceeded");
}

function getComponentSet(components: Record<string, NextGenerationComponentForecast>) {
  const selected = NEXT_GENERATION_A_COMPONENT_VERSIONS.map((modelVersion) => {
    const component = components[modelVersion];
    if (!component || component.modelVersion !== modelVersion) return null;
    if (!finiteProbability(component.probability24h) || !finiteProbability(component.probability48h)) return null;
    return component;
  });
  return selected.every(Boolean)
    ? selected as NextGenerationComponentForecast[]
    : null;
}

export type NextGenerationACalculationOptions = {
  generatedAt: string;
  trainingRows: Array<NextGenerationEnsembleTrainingRow>;
  trainingReadStatus: "ok" | "error";
};

export function calculateNextGenerationAEnsemble(
  components: Record<string, NextGenerationComponentForecast>,
  options: NextGenerationACalculationOptions,
): NextGenerationAResult | null {
  if (options.trainingReadStatus === "error") return null;
  const selectedComponents = getComponentSet(components);
  if (!selectedComponents) return null;
  const generatedTime = timestamp(options.generatedAt);
  if (generatedTime === null || generatedTime < timestamp(NEXT_GENERATION_FREEZE_AT)!) return null;
  const rows = options.trainingRows.filter((row) => {
    const rowTime = timestamp(row.generatedAt);
    return rowTime !== null
      && rowTime >= timestamp(NEXT_GENERATION_FREEZE_AT)!
      && rowTime < generatedTime
      && getComponentSet(row.components) !== null;
  });
  const fit24h = fitNextGenerationEnsemble(rows, "24h");
  const fit48h = fitNextGenerationEnsemble(rows, "48h");
  if (fit24h.trainingMode === "solver_failed" || fit48h.trainingMode === "solver_failed") return null;
  const probabilities24h = selectedComponents.map((component) => component.probability24h);
  const probabilities48h = selectedComponents.map((component) => component.probability48h);
  const ensemble24h = sigmoid(
    fit24h.alpha + probabilities24h.reduce((sum, probability, index) => sum + logit(probability) * fit24h.weights[index], 0),
  );
  const ensemble48h = sigmoid(
    fit48h.alpha + probabilities48h.reduce((sum, probability, index) => sum + logit(probability) * fit48h.weights[index], 0),
  );
  const coherent = enforceNextGenerationHorizonCoherence(ensemble24h, ensemble48h);
  return {
    modelVersion: NEXT_GENERATION_A_MODEL_VERSION,
    generatedAt: options.generatedAt,
    rawProbability24h: ensemble24h,
    rawProbability48h: ensemble48h,
    probability12h: derive12hFrom24hProbability(coherent.probability24h),
    probability24h: coherent.probability24h,
    probability48h: coherent.probability48h,
    probability72h: derive72hFrom48hProbability(coherent.probability48h),
    componentModelVersions: NEXT_GENERATION_A_COMPONENT_VERSIONS,
    componentProbabilities24h: probabilities24h,
    componentProbabilities48h: probabilities48h,
    componentLogitEpsilon: NEXT_GENERATION_A_COMPONENT_LOGIT_EPSILON,
    alpha24h: fit24h.alpha,
    alpha48h: fit48h.alpha,
    weights24h: fit24h.weights,
    weights48h: fit48h.weights,
    trainingMode24h: fit24h.trainingMode,
    trainingMode48h: fit48h.trainingMode,
    trainingSampleCount24h: fit24h.sampleCount,
    trainingSampleCount48h: fit48h.sampleCount,
    positiveTrainingCount24h: fit24h.positiveCount,
    positiveTrainingCount48h: fit48h.positiveCount,
    fitCutoff24h: fit24h.lastResolvedOrigin,
    fitCutoff48h: fit48h.lastResolvedOrigin,
    horizonCoherenceAdjusted: coherent.adjusted,
    regularization: {
      alphaPriorStdDev: NEXT_GENERATION_A_ALPHA_PRIOR_STD_DEV,
      weightPriorMean: NEXT_GENERATION_A_WEIGHT_PRIOR_MEAN,
      weightPriorStdDev: NEXT_GENERATION_A_WEIGHT_PRIOR_STD_DEV,
    },
    solver24h: fit24h.solver,
    solver48h: fit48h.solver,
    freezeAt: NEXT_GENERATION_FREEZE_AT,
    freezePolicy: NEXT_GENERATION_FREEZE_POLICY,
  };
}
