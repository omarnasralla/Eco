import { daysInMonth, diffDays, endOfMonth, parseIsoMonth, startOfMonth, type IsoDate, type IsoMonth } from './date-utils';

export type BudgetLineStatus = 'UNDER' | 'WARNING' | 'OVER';

export interface BudgetLineLike {
  categoryId: string;
  limitMinor: number;
  rollover?: boolean;
  rolloverFromPreviousMinor?: number;
}

export interface BudgetLineResult {
  categoryId: string;
  limitMinor: number;
  /** limit + anything carried over from last month. */
  effectiveLimitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  utilisationPct: number;
  rollover: boolean;
  rolloverFromPreviousMinor: number;
  status: BudgetLineStatus;
}

export interface BudgetEvaluation {
  month: IsoMonth;
  totalLimitMinor: number;
  totalSpentMinor: number;
  totalRemainingMinor: number;
  utilisationPct: number;
  lines: BudgetLineResult[];
  /** Month-end spend extrapolated from the pace so far. */
  projectedSpendMinor: number;
  projectedOverspendMinor: number;
  daysElapsed: number;
  daysRemaining: number;
  overspentCategories: string[];
  warningCategories: string[];
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return part > 0 ? 100 : 0;
  return Math.round((part / whole) * 1000) / 10;
}

function statusFor(spent: number, limit: number, thresholdPct: number): BudgetLineStatus {
  if (limit <= 0) return spent > 0 ? 'OVER' : 'UNDER';
  const used = (spent / limit) * 100;
  if (used > 100) return 'OVER';
  return used >= thresholdPct ? 'WARNING' : 'UNDER';
}

/**
 * Scores a month's budget against actual spend.
 *
 * `asOf` matters: mid-month, a category at 60% of its limit on day 5 is a
 * problem and the same figure on day 27 is fine.  We therefore report both the
 * raw utilisation and a straight-line projection to month end, and the UI
 * leads with whichever tells the user something actionable.
 */
export function evaluateBudget(params: {
  month: IsoMonth;
  lines: BudgetLineLike[];
  /** Actual spend this month, keyed by category id, in minor units. */
  spendByCategory: Record<string, number>;
  /**
   * The portion of `spendByCategory` that is already-committed recurring
   * spend — rent, subscriptions, standing bills. Excluded from the run-rate
   * extrapolation; see `projectedSpendMinor` for why that matters.
   */
  committedSpendByCategory?: Record<string, number>;
  alertThresholdPct?: number;
  /** Defaults to the last day of the month, i.e. a full retrospective view. */
  asOf?: IsoDate;
  /** Overall cap for FIXED budgets; falls back to the sum of the lines. */
  totalLimitMinor?: number;
}): BudgetEvaluation {
  const {
    month,
    lines,
    spendByCategory,
    committedSpendByCategory = {},
    alertThresholdPct = 80,
    totalLimitMinor,
  } = params;
  const { y, m } = parseIsoMonth(month);
  const totalDays = daysInMonth(y, m);
  const asOf = params.asOf ?? endOfMonth(month);

  const daysElapsed = Math.min(
    Math.max(diffDays(startOfMonth(month), asOf) + 1, 0),
    totalDays,
  );
  const daysRemaining = totalDays - daysElapsed;

  const lineResults: BudgetLineResult[] = lines.map((line) => {
    const rolloverFromPreviousMinor = line.rollover ? (line.rolloverFromPreviousMinor ?? 0) : 0;
    const effectiveLimitMinor = line.limitMinor + rolloverFromPreviousMinor;
    const spentMinor = spendByCategory[line.categoryId] ?? 0;
    return {
      categoryId: line.categoryId,
      limitMinor: line.limitMinor,
      effectiveLimitMinor,
      spentMinor,
      remainingMinor: effectiveLimitMinor - spentMinor,
      utilisationPct: pct(spentMinor, effectiveLimitMinor),
      rollover: line.rollover ?? false,
      rolloverFromPreviousMinor,
      status: statusFor(spentMinor, effectiveLimitMinor, alertThresholdPct),
    };
  });

  const budgetedLimit = lineResults.reduce((s, l) => s + l.effectiveLimitMinor, 0);
  const totalLimit = totalLimitMinor ?? budgetedLimit;

  // Count every expense in the month, including categories with no budget line —
  // money spent outside the plan is exactly what a budget needs to reveal.
  const totalSpent = Object.values(spendByCategory).reduce((s, v) => s + v, 0);

  /**
   * Month-end projection.
   *
   * Only *variable* spend is extrapolated. Naively scaling the whole month's
   * total by days-elapsed is badly wrong early on: rent landing on the 1st
   * would be read as a daily rate and project a month thirty times the size of
   * reality. Committed recurring charges have already happened, so they are
   * added once and the run rate is computed from what is left.
   *
   * The projection is also floored at actual spend — a projection that comes
   * in under what has already been spent is not a projection.
   */
  const committedTotal = Object.entries(committedSpendByCategory).reduce(
    // Never count more as committed than was actually spent in that category.
    (sum, [categoryId, amount]) => sum + Math.min(amount, spendByCategory[categoryId] ?? 0),
    0,
  );
  const variableSpent = Math.max(totalSpent - committedTotal, 0);
  const projectedVariable =
    daysElapsed > 0 ? Math.round((variableSpent / daysElapsed) * totalDays) : variableSpent;
  const projectedSpendMinor = Math.max(committedTotal + projectedVariable, totalSpent);

  return {
    month,
    totalLimitMinor: totalLimit,
    totalSpentMinor: totalSpent,
    totalRemainingMinor: totalLimit - totalSpent,
    utilisationPct: pct(totalSpent, totalLimit),
    lines: lineResults,
    projectedSpendMinor,
    projectedOverspendMinor: Math.max(projectedSpendMinor - totalLimit, 0),
    daysElapsed,
    daysRemaining,
    overspentCategories: lineResults.filter((l) => l.status === 'OVER').map((l) => l.categoryId),
    warningCategories: lineResults.filter((l) => l.status === 'WARNING').map((l) => l.categoryId),
  };
}

/**
 * Unspent room a rollover line carries into next month.
 * Overspend is not carried as a debt — punishing next month's budget for last
 * month's mistake is how people abandon budgeting altogether.
 */
export function rolloverAmountMinor(line: BudgetLineResult): number {
  return line.rollover ? Math.max(line.remainingMinor, 0) : 0;
}

/**
 * Proposes limits from history: the median of the last N months per category,
 * nudged by the target savings rate when income does not cover the total.
 *
 * The median, not the mean — one holiday or one medical bill should not set
 * next month's grocery budget.
 */
export function suggestBudget(params: {
  historyByCategory: Record<string, number[]>;
  monthlyIncomeMinor: number;
  targetSavingsRatePct?: number;
}): { lines: Array<{ categoryId: string; limitMinor: number }>; totalLimitMinor: number; adjustmentFactor: number } {
  const { historyByCategory, monthlyIncomeMinor, targetSavingsRatePct = 20 } = params;

  const medians = Object.entries(historyByCategory).map(([categoryId, values]) => ({
    categoryId,
    limitMinor: median(values.filter((v) => v > 0)),
  }));

  const rawTotal = medians.reduce((s, l) => s + l.limitMinor, 0);
  const spendableMinor = Math.round(monthlyIncomeMinor * (1 - targetSavingsRatePct / 100));

  // Only ever scale down. If history already fits inside the target, keep it.
  const adjustmentFactor =
    rawTotal > 0 && spendableMinor > 0 && rawTotal > spendableMinor ? spendableMinor / rawTotal : 1;

  const lines = medians.map((l) => ({
    categoryId: l.categoryId,
    limitMinor: Math.round(l.limitMinor * adjustmentFactor),
  }));

  return {
    lines,
    totalLimitMinor: lines.reduce((s, l) => s + l.limitMinor, 0),
    adjustmentFactor: Math.round(adjustmentFactor * 1000) / 1000,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

// ─── Daily allowance ──────────────────────────────────────────────────────

export type DailyAllowanceStatus = 'ON_TRACK' | 'TIGHT' | 'EXHAUSTED';

export interface DailyAllowanceLine {
  categoryId: string;
  remainingMinor: number;
  /** The most you can spend each remaining day and still finish on the limit. */
  allowanceMinor: number;
  /** The limit spread evenly over the whole month — what the plan assumed. */
  evenPaceMinor: number;
  status: DailyAllowanceStatus;
}

export interface DailyAllowanceResult {
  /** Days left to spend in, today included. Always >= 1. */
  daysRemainingInclusive: number;
  totalRemainingMinor: number;
  totalAllowanceMinor: number;
  lines: DailyAllowanceLine[];
}

/**
 * Turns "what is left" into "what can I spend today", per category.
 *
 * Today counts as a remaining day. Two reasons: it is still spendable, and it
 * makes the figure self-correcting — an expense recorded at lunchtime lowers
 * the same day's allowance instead of silently borrowing from tomorrow. On the
 * last day of the month the divisor is 1, so the allowance is simply whatever
 * is left; there is no day to divide across and no division by zero.
 *
 * Amounts are floored, never rounded: spending the displayed figure every
 * remaining day must land on or under the limit, and rounding half a minor
 * unit up thirty times is how a "safe" number goes over.
 *
 * Returns null outside a month in progress. A finished month has no days left
 * to pace, and a future one has not started — inventing a number for either
 * would present a plan as though it were a live constraint.
 */
export function dailyAllowance(params: {
  evaluation: BudgetEvaluation;
  /** Today, in the user's own timezone — not the server's. */
  today: IsoDate;
  /**
   * Restates every figure in a second currency, applied *before* the division.
   *
   * Order matters. Converting the already-floored daily figure instead would
   * round twice — once into the budget's currency, once out of it — and the
   * second rounding is pure loss: 107.18 USD over 27 days floors to 3.96, and
   * 3.96 x 3.75 is 14.85 SAR, where converting first gives 14.88. The user is
   * told to spend three halalas a day less than they have, every day, for no
   * reason other than the order of two operations.
   */
  convertMinor?: (minor: number) => number;
}): DailyAllowanceResult | null {
  const { evaluation, today } = params;
  const convert = params.convertMinor ?? ((minor: number) => minor);
  const { y, m } = parseIsoMonth(evaluation.month);
  const totalDays = daysInMonth(y, m);

  if (today < startOfMonth(evaluation.month) || today > endOfMonth(evaluation.month)) return null;

  const daysElapsed = diffDays(startOfMonth(evaluation.month), today) + 1;
  const daysRemainingInclusive = totalDays - daysElapsed + 1;

  const lines = evaluation.lines.map((line): DailyAllowanceLine => {
    // An overspent line has no allowance to give. Reporting a negative daily
    // figure, or quietly showing zero as though it were a budget, both read as
    // "spend nothing" — only one of them is honest about why.
    const remainingMinor = convert(line.remainingMinor);
    const allowanceMinor = Math.max(Math.floor(remainingMinor / daysRemainingInclusive), 0);
    const evenPaceMinor = Math.floor(convert(line.effectiveLimitMinor) / totalDays);

    return {
      categoryId: line.categoryId,
      remainingMinor,
      allowanceMinor,
      evenPaceMinor,
      // "Tight" means the rest of the month has to run at under half the pace
      // the budget was built for — the point where a category stops being on
      // track with a nudge and needs a deliberate change of behaviour.
      status:
        remainingMinor <= 0
          ? 'EXHAUSTED'
          : evenPaceMinor > 0 && allowanceMinor * 2 < evenPaceMinor
            ? 'TIGHT'
            : 'ON_TRACK',
    };
  });

  const totalRemainingMinor = convert(evaluation.totalRemainingMinor);

  return {
    daysRemainingInclusive,
    totalRemainingMinor,
    totalAllowanceMinor: Math.max(Math.floor(totalRemainingMinor / daysRemainingInclusive), 0),
    lines,
  };
}
