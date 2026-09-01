import { addMonths, type IsoDate, type IsoMonth } from './date-utils';

/**
 * Baseline forecasting.
 *
 * The production forecast comes from the Python service (`services/ai`), which
 * runs Holt-Winters and gradient-boosted models over a far longer history.
 * This module is the *fallback*: it runs in-process, in milliseconds, on the
 * server or the phone, and it is what the user sees when the AI service is
 * cold, rate-limited, or unreachable.  A slightly cruder number now beats a
 * spinner, and the two implementations agree closely on smooth series.
 */

export interface SeriesPoint {
  month: IsoMonth;
  valueMinor: number;
}

/**
 * Drops the current month from a history series.
 *
 * This matters more than it looks. The month in progress is partial by
 * definition — on the 1st it holds a single day of spending. Fed to a
 * forecaster as though it were a finished month, that partial figure reads as
 * a collapse in spending: it drags the trend sharply downward and, with a
 * seasonal model fitted over it, can push every subsequent projection to zero.
 *
 * Forecasts are therefore built only from complete months. The current month
 * is not ignored by the product — it is handled by the budget's month-end
 * projection, which knows how far through the month it is.
 */
export function completeMonthsOnly(history: SeriesPoint[], today: IsoDate): SeriesPoint[] {
  const currentMonth = today.slice(0, 7);
  return history.filter((point) => point.month < currentMonth);
}

export interface ForecastPoint {
  month: IsoMonth;
  valueMinor: number;
  lowerBoundMinor: number;
  upperBoundMinor: number;
}

/**
 * Holt's linear trend method: one smoothing pass for level, one for trend.
 * `alpha` weights recent levels, `beta` weights recent trend changes.  Defaults
 * are deliberately conservative — personal finance series are short and noisy,
 * and an over-reactive forecast erodes trust the first time it is wrong.
 */
export function holtLinear(
  series: number[],
  options: { alpha?: number; beta?: number; horizon: number },
): { fitted: number[]; forecast: number[]; level: number; trend: number } {
  const { alpha = 0.35, beta = 0.15, horizon } = options;

  if (series.length === 0) {
    return { fitted: [], forecast: Array(horizon).fill(0), level: 0, trend: 0 };
  }
  if (series.length === 1) {
    const only = series[0]!;
    return { fitted: [only], forecast: Array(horizon).fill(only), level: only, trend: 0 };
  }

  let level = series[0]!;
  let trend = series[1]! - series[0]!;
  const fitted: number[] = [level];

  for (let i = 1; i < series.length; i += 1) {
    const value = series[i]!;
    const lastLevel = level;
    level = alpha * value + (1 - alpha) * (level + trend);
    trend = beta * (level - lastLevel) + (1 - beta) * trend;
    fitted.push(level);
  }

  const forecast = Array.from({ length: horizon }, (_, h) => level + (h + 1) * trend);
  return { fitted, forecast, level, trend };
}

/** Damped trend — stops a short uptrend extrapolating to the moon over 12 months. */
export function dampedTrendForecast(
  series: number[],
  horizon: number,
  phi = 0.85,
): number[] {
  const { level, trend } = holtLinear(series, { horizon: 1 });
  return Array.from({ length: horizon }, (_, h) => {
    // Geometric decay of the trend contribution: phi + phi^2 + … + phi^(h+1).
    const damping = Array.from({ length: h + 1 }, (_, k) => phi ** (k + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    return level + damping * trend;
  });
}

/** Residual standard deviation of the fit — the basis for prediction intervals. */
export function residualStdDev(series: number[], fitted: number[]): number {
  const n = Math.min(series.length, fitted.length);
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (series[i]! - fitted[i]!) ** 2;
  return Math.sqrt(sum / (n - 1));
}

/**
 * Forecasts a monthly series with 80% prediction intervals.
 *
 * Intervals widen with the square root of the horizon, which is the standard
 * random-walk assumption: uncertainty about month 6 is roughly 2.4x uncertainty
 * about month 1, not 6x. Optional seasonal indices are applied multiplicatively.
 */
export function forecastSeries(
  history: SeriesPoint[],
  options: {
    horizon: number;
    /** 12 multiplicative indices from `seasonalityIndex`, January first. */
    seasonalIndices?: number[];
    /** z for the interval; 1.28 ≈ 80%, 1.96 ≈ 95%. */
    z?: number;
    damping?: number;
  },
): { points: ForecastPoint[]; confidence: number; warnings: string[] } {
  const { horizon, seasonalIndices, z = 1.2816, damping = 0.85 } = options;
  const warnings: string[] = [];

  const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
  const values = sorted.map((p) => p.valueMinor);
  const lastMonth = sorted[sorted.length - 1]?.month ?? new Date().toISOString().slice(0, 7);

  if (values.length < 3) {
    warnings.push('Fewer than three months of history — this projection is a rough estimate.');
  }
  if (values.length === 0) {
    return { points: [], confidence: 0, warnings: ['No history available to forecast from.'] };
  }

  const { fitted } = holtLinear(values, { horizon: 1 });
  const raw = dampedTrendForecast(values, horizon, damping);
  const sigma = residualStdDev(values, fitted);

  const points: ForecastPoint[] = raw.map((value, h) => {
    const month = addMonths(lastMonth, h + 1);
    const seasonal = seasonalIndices?.[Number(month.slice(5, 7)) - 1] ?? 1;
    const centre = Math.max(Math.round(value * seasonal), 0);
    // Uncertainty compounds with the square root of the horizon.
    const spread = Math.round(z * sigma * Math.sqrt(h + 1));
    return {
      month,
      valueMinor: centre,
      lowerBoundMinor: Math.max(centre - spread, 0),
      upperBoundMinor: centre + spread,
    };
  });

  // Confidence falls with noise and rises with history length.
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const noise = mean > 0 ? sigma / mean : 1;
  const historyScore = Math.min(values.length / 12, 1);
  const confidence = Math.max(0, Math.min(1, (1 - Math.min(noise, 1)) * 0.7 + historyScore * 0.3));

  if (noise > 0.4) {
    warnings.push('Your month-to-month figures vary a lot, so the range here is wide.');
  }

  return { points, confidence: Math.round(confidence * 100) / 100, warnings };
}

export interface CashFlowForecastPoint {
  month: IsoMonth;
  projectedIncomeMinor: number;
  projectedExpensesMinor: number;
  projectedNetMinor: number;
  projectedBalanceMinor: number;
  lowerBoundMinor: number;
  upperBoundMinor: number;
  isShortfall: boolean;
}

/**
 * Projects running cash balance forward by forecasting income and expenses
 * separately and compounding the difference.  Separate models matter: income is
 * usually near-flat and expenses trend, so a single "net" series would blur two
 * very different processes into one bad line.
 *
 * A month is flagged as a shortfall when the *lower bound* of the projected
 * balance goes negative — warning on the central estimate alone would only
 * raise the alarm once the problem is already unavoidable.
 */
export function forecastCashFlow(params: {
  incomeHistory: SeriesPoint[];
  expenseHistory: SeriesPoint[];
  openingBalanceMinor: number;
  horizon: number;
  seasonalIndices?: number[];
}): { points: CashFlowForecastPoint[]; confidence: number; warnings: string[] } {
  const { incomeHistory, expenseHistory, openingBalanceMinor, horizon, seasonalIndices } = params;

  const income = forecastSeries(incomeHistory, { horizon });
  const expenses = forecastSeries(expenseHistory, {
    horizon,
    ...(seasonalIndices ? { seasonalIndices } : {}),
  });

  let balance = openingBalanceMinor;
  const points: CashFlowForecastPoint[] = [];

  for (let h = 0; h < horizon; h += 1) {
    const inc = income.points[h];
    const exp = expenses.points[h];
    if (!inc || !exp) break;

    const net = inc.valueMinor - exp.valueMinor;
    balance += net;

    // Worst case: income at its lower bound, expenses at their upper bound.
    const worstNet = inc.lowerBoundMinor - exp.upperBoundMinor;
    const bestNet = inc.upperBoundMinor - exp.lowerBoundMinor;

    points.push({
      month: inc.month,
      projectedIncomeMinor: inc.valueMinor,
      projectedExpensesMinor: exp.valueMinor,
      projectedNetMinor: net,
      projectedBalanceMinor: balance,
      lowerBoundMinor: worstNet,
      upperBoundMinor: bestNet,
      isShortfall: balance < 0 || worstNet + balance - net < 0,
    });
  }

  return {
    points,
    confidence: Math.round(Math.min(income.confidence, expenses.confidence) * 100) / 100,
    warnings: [...new Set([...income.warnings, ...expenses.warnings])],
  };
}

/** Can the user afford `amountMinor` by `targetMonth` without going negative? */
export function affordabilityCheck(
  forecast: CashFlowForecastPoint[],
  amountMinor: number,
  targetMonth: IsoMonth,
): {
  affordable: boolean;
  projectedBalanceMinor: number;
  balanceAfterMinor: number;
  shortfallMinor: number;
  monthsOfBufferRemaining: number;
} {
  const point = forecast.find((p) => p.month === targetMonth) ?? forecast[forecast.length - 1];
  const projectedBalanceMinor = point?.projectedBalanceMinor ?? 0;
  const balanceAfterMinor = projectedBalanceMinor - amountMinor;

  const averageMonthlySpend =
    forecast.length > 0
      ? forecast.reduce((s, p) => s + p.projectedExpensesMinor, 0) / forecast.length
      : 0;

  return {
    affordable: balanceAfterMinor >= 0,
    projectedBalanceMinor,
    balanceAfterMinor,
    shortfallMinor: Math.max(-balanceAfterMinor, 0),
    monthsOfBufferRemaining:
      averageMonthlySpend > 0
        ? Math.round((balanceAfterMinor / averageMonthlySpend) * 10) / 10
        : 0,
  };
}
