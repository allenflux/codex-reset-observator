import {
  NEXT_GENERATION_C_CONTEXT_PRIOR_STD_DEV,
  NEXT_GENERATION_C_MAX_MULTIPLIER,
  NEXT_GENERATION_C_MINIMUM_EXPOSURE_CELLS,
  NEXT_GENERATION_C_MINIMUM_RANDOM_EVENTS,
  NEXT_GENERATION_C_MIN_MULTIPLIER,
  NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_INTERVAL_MINUTES,
  NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_MAX_ITERATIONS,
  NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_TOLERANCE,
  NEXT_GENERATION_C_SOLVER_BACKTRACKING_FACTOR,
  NEXT_GENERATION_C_SOLVER_INITIAL_STEP,
  NEXT_GENERATION_C_SOLVER_MAX_BACKTRACKING_STEPS,
  NEXT_GENERATION_C_SOLVER_MAX_ITERATIONS,
  NEXT_GENERATION_C_SOLVER_TOLERANCE,
} from "@/data/shadowProbabilityConfig";
import type { RecoveryResetBoundary } from "./recoveryBoundary";
import {
  getRandomContinuousHazardAtAge,
  type RandomContinuousHazard,
} from "./randomContinuousProbability";

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_MS = 72 * HOUR_MS;
const STD_EPSILON = 1e-9;
const PROBABILITY_EPSILON = 1e-12;

export type ContextualBurstRawFeatures = {
  randomResetCount72h: number;
  previousRandomIntervalHours: number | null;
  hourSin: number;
  hourCos: number;
};

export type ContextualBurstCoefficients = {
  count72: number;
  previousInterval: number;
  hourSin: number;
  hourCos: number;
};

export type ContextualBurstFit = {
  coefficients: ContextualBurstCoefficients;
  burstStats: {
    count72Mean: number;
    count72StdDev: number;
    previousIntervalMean: number;
    previousIntervalStdDev: number;
  };
  trainingEventCount: number;
  exposureCellCount: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  solver: {
    converged: boolean;
    iterations: number;
    objective: number | null;
    reason: string | null;
  };
};

export type CircadianNormalization = {
  constant: number | null;
  cycleMeanBeforeNormalization: number | null;
  cycleMeanAfterNormalization: number | null;
  fallbackReason: string | null;
};

type TrainingCell = {
  durationHours: number;
  randomAgeHours: number;
  raw: ContextualBurstRawFeatures;
  event: boolean;
};

type NormalizedCell = TrainingCell & {
  features: [number, number, number, number];
  baseCumulativeHazard: number;
};

function timestamp(value: Date | string | null | undefined) {
  const parsed = value instanceof Date ? value.getTime() : value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function zeroCoefficients(): ContextualBurstCoefficients {
  return { count72: 0, previousInterval: 0, hourSin: 0, hourCos: 0 };
}

function emptyStats() {
  return {
    count72Mean: 0,
    count72StdDev: 0,
    previousIntervalMean: 0,
    previousIntervalStdDev: 0,
  };
}

function fallback(
  reason: string,
  trainingEventCount = 0,
  exposureCellCount = 0,
  stats = emptyStats(),
): ContextualBurstFit {
  return {
    coefficients: zeroCoefficients(),
    burstStats: stats,
    trainingEventCount,
    exposureCellCount,
    fallbackUsed: true,
    fallbackReason: reason,
    solver: {
      converged: false,
      iterations: 0,
      objective: null,
      reason,
    },
  };
}

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[], average: number) {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

function normalizationFailure(
  reason: string,
  cycleMeanBeforeNormalization: number | null = null,
): CircadianNormalization {
  return {
    constant: null,
    cycleMeanBeforeNormalization,
    cycleMeanAfterNormalization: null,
    fallbackReason: reason,
  };
}

function clampedExponential(term: number, logConstant: number) {
  const exponent = term - logConstant;
  if (!Number.isFinite(exponent)) return null;
  if (exponent <= Math.log(NEXT_GENERATION_C_MIN_MULTIPLIER)) {
    return NEXT_GENERATION_C_MIN_MULTIPLIER;
  }
  if (exponent >= Math.log(NEXT_GENERATION_C_MAX_MULTIPLIER)) {
    return NEXT_GENERATION_C_MAX_MULTIPLIER;
  }
  const value = Math.exp(exponent);
  return Number.isFinite(value) ? value : null;
}

function cycleMean(terms: number[], logConstant: number) {
  const values = terms.map((term) => clampedExponential(term, logConstant));
  if (values.some((value) => value === null)) return null;
  return mean(values as number[]);
}

/**
 * Solve the clamped 24-hour circadian mean rather than using an unclamped
 * closed form. The phase is sampled over one idealized Pacific-time cycle;
 * no calendar date or DST transition is involved.
 */
export function calculateCircadianNormalization(
  coefficients: Pick<ContextualBurstCoefficients, "hourSin" | "hourCos">,
): CircadianNormalization {
  if (!Number.isFinite(coefficients.hourSin) || !Number.isFinite(coefficients.hourCos)) {
    return normalizationFailure("non_finite_circadian_coefficients");
  }

  const sampleCount = Math.round(
    24 * 60 / NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_INTERVAL_MINUTES,
  );
  if (!(sampleCount > 0)) return normalizationFailure("invalid_circadian_cycle_sampling");

  const terms = Array.from({ length: sampleCount }, (_, index) => {
    const hour = index * 24 / sampleCount;
    const angle = 2 * Math.PI * hour / 24;
    return coefficients.hourSin * Math.sin(angle) + coefficients.hourCos * Math.cos(angle);
  });
  if (terms.some((term) => !Number.isFinite(term))) {
    return normalizationFailure("non_finite_circadian_terms");
  }

  const cycleMeanBeforeNormalization = cycleMean(terms, 0);
  if (cycleMeanBeforeNormalization === null) {
    return normalizationFailure("non_finite_circadian_cycle_mean");
  }
  if (coefficients.hourSin === 0 && coefficients.hourCos === 0) {
    return {
      constant: 1,
      cycleMeanBeforeNormalization,
      cycleMeanAfterNormalization: cycleMeanBeforeNormalization,
      fallbackReason: null,
    };
  }

  const amplitude = Math.hypot(coefficients.hourSin, coefficients.hourCos);
  if (!Number.isFinite(amplitude)) {
    return normalizationFailure("non_finite_circadian_amplitude", cycleMeanBeforeNormalization);
  }
  const bracket = Math.max(32, amplitude + 8);
  let lower = -bracket;
  let upper = bracket;
  const lowerMean = cycleMean(terms, lower);
  const upperMean = cycleMean(terms, upper);
  if (
    lowerMean === null
    || upperMean === null
    || lowerMean < 1
    || upperMean > 1
  ) {
    return normalizationFailure("circadian_normalization_bracket_failed", cycleMeanBeforeNormalization);
  }

  for (let iteration = 0; iteration < NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_MAX_ITERATIONS; iteration += 1) {
    const middle = (lower + upper) / 2;
    const middleMean = cycleMean(terms, middle);
    if (middleMean === null) {
      return normalizationFailure("non_finite_circadian_bisection_mean", cycleMeanBeforeNormalization);
    }
    if (middleMean > 1) lower = middle;
    else upper = middle;
  }

  const logConstant = (lower + upper) / 2;
  const constant = Math.exp(logConstant);
  const cycleMeanAfterNormalization = cycleMean(terms, logConstant);
  if (
    !Number.isFinite(constant)
    || constant <= 0
    || cycleMeanAfterNormalization === null
    || Math.abs(cycleMeanAfterNormalization - 1) > NEXT_GENERATION_C_V2_CIRCADIAN_NORMALIZATION_TOLERANCE
  ) {
    return normalizationFailure("circadian_normalization_solution_failed", cycleMeanBeforeNormalization);
  }
  return {
    constant,
    cycleMeanBeforeNormalization,
    cycleMeanAfterNormalization,
    fallbackReason: null,
  };
}

export function getPacificHourFeatures(at: Date) {
  if (!Number.isFinite(at.getTime())) {
    return { hourSin: 0, hourCos: 1, localHour: 0 };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hours = Number(values.hour ?? 0);
  const minutes = Number(values.minute ?? 0);
  const seconds = Number(values.second ?? 0);
  const localHour = hours + minutes / 60 + seconds / 3600;
  const angle = 2 * Math.PI * localHour / 24;
  return {
    hourSin: Math.sin(angle),
    hourCos: Math.cos(angle),
    localHour,
  };
}

export function getContextualBurstRawFeatures(
  randomResetTimes: Date[],
  at: Date,
): ContextualBurstRawFeatures {
  const atTime = at.getTime();
  const pastTimes = randomResetTimes
    .map((value) => value.getTime())
    .filter((value) => Number.isFinite(value) && value < atTime)
    .sort((left, right) => left - right);
  const randomResetCount72h = pastTimes.filter((value) => value >= atTime - LOOKBACK_MS).length;
  const latest = pastTimes.at(-1);
  const previous = pastTimes.at(-2);
  const previousRandomIntervalHours = latest !== undefined && previous !== undefined
    ? Math.max(0, (latest - previous) / HOUR_MS)
    : null;
  const pacific = getPacificHourFeatures(at);
  return {
    randomResetCount72h,
    previousRandomIntervalHours,
    hourSin: pacific.hourSin,
    hourCos: pacific.hourCos,
  };
}

function sortedBoundaryTimes(boundaries: RecoveryResetBoundary[], asOf: Date) {
  const cutoff = asOf.getTime();
  return boundaries
    .filter((boundary) => boundary.isRandom)
    .map((boundary) => timestamp(boundary.resetAt))
    .filter((value): value is number => value !== null && value < cutoff)
    .sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
}

function buildTrainingCells(
  boundaries: RecoveryResetBoundary[],
  asOf: Date,
): TrainingCell[] {
  const resetTimes = sortedBoundaryTimes(boundaries, asOf);
  if (resetTimes.length < 3) return [];
  const resetDates = resetTimes.map((value) => new Date(value));
  const cells: TrainingCell[] = [];

  // The previous interval first becomes knowable immediately after the second reset.
  for (let intervalIndex = 1; intervalIndex < resetTimes.length; intervalIndex += 1) {
    const intervalStart = resetTimes[intervalIndex];
    const intervalEnd = intervalIndex + 1 < resetTimes.length
      ? resetTimes[intervalIndex + 1]
      : asOf.getTime();
    if (!Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) continue;

    let cursor = intervalStart;
    while (cursor < intervalEnd) {
      const end = Math.min(intervalEnd, cursor + HOUR_MS);
      const durationHours = (end - cursor) / HOUR_MS;
      if (!(durationHours > 0)) break;
      const featureTime = new Date(cursor + (end - cursor) / 2);
      const raw = getContextualBurstRawFeatures(resetDates, featureTime);
      if (raw.previousRandomIntervalHours === null) {
        cursor = end;
        continue;
      }
      const event = intervalIndex + 1 < resetTimes.length
        && resetTimes[intervalIndex + 1] > cursor
        && resetTimes[intervalIndex + 1] <= end;
      cells.push({
        durationHours,
        randomAgeHours: (featureTime.getTime() - intervalStart) / HOUR_MS,
        raw,
        event,
      });
      cursor = end;
    }
  }
  return cells;
}

function normalizeCells(cells: TrainingCell[], hazard: RandomContinuousHazard) {
  const countValues = cells.map((cell) => Math.log1p(cell.raw.randomResetCount72h));
  const previousValues = cells.map((cell) => Math.log1p(cell.raw.previousRandomIntervalHours ?? 0));
  const count72Mean = mean(countValues);
  const previousIntervalMean = mean(previousValues);
  const count72StdDev = stdDev(countValues, count72Mean);
  const previousIntervalStdDev = stdDev(previousValues, previousIntervalMean);
  const stats = {
    count72Mean,
    count72StdDev,
    previousIntervalMean,
    previousIntervalStdDev,
  };
  const normalized = cells.map((cell, index): NormalizedCell => ({
    ...cell,
    features: [
      count72StdDev < STD_EPSILON ? 0 : (countValues[index] - count72Mean) / count72StdDev,
      previousIntervalStdDev < STD_EPSILON ? 0 : (previousValues[index] - previousIntervalMean) / previousIntervalStdDev,
      cell.raw.hourSin,
      cell.raw.hourCos,
    ],
    // The base offset is fixed for the whole MAP fit. Computing the Gaussian
    // posterior once per cell avoids repeating the expensive kernel reduction
    // during every objective/gradient iteration without changing model semantics.
    baseCumulativeHazard: Math.max(
      PROBABILITY_EPSILON,
      getRandomContinuousHazardAtAge(hazard, cell.randomAgeHours) * cell.durationHours,
    ),
  }));
  return { normalized, stats };
}

function objective(
  cells: NormalizedCell[],
  beta: number[],
) {
  if (beta.some((value) => !Number.isFinite(value))) return Number.POSITIVE_INFINITY;
  let result = beta.reduce(
    (sum, value) => sum + value ** 2 / (2 * NEXT_GENERATION_C_CONTEXT_PRIOR_STD_DEV ** 2),
    0,
  );
  for (const cell of cells) {
    const linear = cell.features.reduce((sum, value, index) => sum + value * beta[index], 0);
    const eta = Math.log(cell.baseCumulativeHazard) + linear;
    const mu = Math.exp(Math.min(40, Math.max(-40, eta)));
    if (cell.event) {
      const probability = Math.max(PROBABILITY_EPSILON, 1 - Math.exp(-mu));
      result -= Math.log(probability);
    } else {
      result += mu;
    }
  }
  return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
}

function gradient(
  cells: NormalizedCell[],
  beta: number[],
) {
  const result = beta.map((value) => value / (NEXT_GENERATION_C_CONTEXT_PRIOR_STD_DEV ** 2));
  for (const cell of cells) {
    const linear = cell.features.reduce((sum, value, index) => sum + value * beta[index], 0);
    const eta = Math.log(cell.baseCumulativeHazard) + linear;
    const mu = Math.exp(Math.min(40, Math.max(-40, eta)));
    const derivative = cell.event
      ? -mu * Math.exp(-mu) / Math.max(PROBABILITY_EPSILON, 1 - Math.exp(-mu))
      : mu;
    for (let index = 0; index < result.length; index += 1) {
      result[index] += derivative * cell.features[index];
    }
  }
  return result;
}

export function fitContextualBurstContext(
  randomBoundaries: RecoveryResetBoundary[],
  asOf: Date,
  hazard: RandomContinuousHazard,
): ContextualBurstFit {
  const cells = buildTrainingCells(randomBoundaries, asOf);
  const trainingEventCount = cells.filter((cell) => cell.event).length;
  const exposureCellCount = cells.length;
  const { normalized, stats } = normalizeCells(cells, hazard);
  if (
    trainingEventCount < NEXT_GENERATION_C_MINIMUM_RANDOM_EVENTS
    || exposureCellCount < NEXT_GENERATION_C_MINIMUM_EXPOSURE_CELLS
  ) {
    return fallback("insufficient_context_history", trainingEventCount, exposureCellCount, stats);
  }

  let beta = [0, 0, 0, 0];
  if (stats.count72StdDev < STD_EPSILON) beta[0] = 0;
  if (stats.previousIntervalStdDev < STD_EPSILON) beta[1] = 0;
  let currentObjective = objective(normalized, beta);
  if (!Number.isFinite(currentObjective)) {
    return fallback("context_initial_objective_non_finite", trainingEventCount, exposureCellCount, stats);
  }

  for (let iteration = 1; iteration <= NEXT_GENERATION_C_SOLVER_MAX_ITERATIONS; iteration += 1) {
    const grad = gradient(normalized, beta);
    if (grad.some((value) => !Number.isFinite(value))) {
      return fallback("context_gradient_non_finite", trainingEventCount, exposureCellCount, stats);
    }
    if (stats.count72StdDev < STD_EPSILON) grad[0] = 0;
    if (stats.previousIntervalStdDev < STD_EPSILON) grad[1] = 0;

    let step = NEXT_GENERATION_C_SOLVER_INITIAL_STEP;
    let accepted: { beta: number[]; objective: number } | null = null;
    for (let backtracking = 0; backtracking <= NEXT_GENERATION_C_SOLVER_MAX_BACKTRACKING_STEPS; backtracking += 1) {
      const candidate = beta.map((value, index) => value - step * grad[index]);
      if (stats.count72StdDev < STD_EPSILON) candidate[0] = 0;
      if (stats.previousIntervalStdDev < STD_EPSILON) candidate[1] = 0;
      const candidateObjective = objective(normalized, candidate);
      if (Number.isFinite(candidateObjective) && candidateObjective <= currentObjective) {
        accepted = { beta: candidate, objective: candidateObjective };
        break;
      }
      step *= NEXT_GENERATION_C_SOLVER_BACKTRACKING_FACTOR;
    }
    if (!accepted) {
      return fallback("context_backtracking_failed", trainingEventCount, exposureCellCount, stats);
    }

    const maxDelta = Math.max(...accepted.beta.map((value, index) => Math.abs(value - beta[index])));
    beta = accepted.beta;
    currentObjective = accepted.objective;
    if (maxDelta <= NEXT_GENERATION_C_SOLVER_TOLERANCE) {
      return {
        coefficients: {
          count72: beta[0],
          previousInterval: beta[1],
          hourSin: beta[2],
          hourCos: beta[3],
        },
        burstStats: stats,
        trainingEventCount,
        exposureCellCount,
        fallbackUsed: false,
        fallbackReason: null,
        solver: {
          converged: true,
          iterations: iteration,
          objective: currentObjective,
          reason: null,
        },
      };
    }
  }

  return fallback("context_max_iterations_exceeded", trainingEventCount, exposureCellCount, stats);
}

function standardizedBurst(raw: ContextualBurstRawFeatures, fit: ContextualBurstFit) {
  const count = Math.log1p(Math.max(0, raw.randomResetCount72h));
  const previous = raw.previousRandomIntervalHours === null
    ? fit.burstStats.previousIntervalMean
    : Math.log1p(Math.max(0, raw.previousRandomIntervalHours));
  return {
    count72: fit.burstStats.count72StdDev < STD_EPSILON
      ? 0
      : (count - fit.burstStats.count72Mean) / fit.burstStats.count72StdDev,
    previousInterval: fit.burstStats.previousIntervalStdDev < STD_EPSILON
      ? 0
      : (previous - fit.burstStats.previousIntervalMean) / fit.burstStats.previousIntervalStdDev,
  };
}

export function getContextualBurstMultiplier(
  raw: ContextualBurstRawFeatures,
  fit: ContextualBurstFit,
  ablation: "full" | "noBurst" | "noCircadian" = "full",
  normalization?: CircadianNormalization,
) {
  if (fit.fallbackUsed) return 1;
  const burst = standardizedBurst(raw, fit);
  const burstTerm = ablation === "noBurst"
    ? 0
    : fit.coefficients.count72 * burst.count72
      + fit.coefficients.previousInterval * burst.previousInterval;
  let circadianTerm = ablation === "noCircadian"
    ? 0
    : fit.coefficients.hourSin * raw.hourSin
      + fit.coefficients.hourCos * raw.hourCos;
  if (ablation !== "noCircadian" && normalization?.constant !== null && normalization?.constant !== undefined) {
    circadianTerm -= Math.log(normalization.constant);
  }
  return clamp(
    Math.exp(burstTerm + circadianTerm),
    NEXT_GENERATION_C_MIN_MULTIPLIER,
    NEXT_GENERATION_C_MAX_MULTIPLIER,
  );
}
