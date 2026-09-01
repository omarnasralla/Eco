import type { PayoffStrategy } from '@eco/shared';
import { addMonths, endOfMonth, type IsoDate, type IsoMonth, monthOf } from './date-utils';

export interface DebtLike {
  id: string;
  name: string;
  currentBalanceMinor: number;
  /** Nominal annual percentage rate, e.g. 21.99. */
  interestRateApr: number;
  minimumPaymentMinor: number;
}

export interface PayoffScheduleEntry {
  monthIndex: number;
  month: IsoMonth;
  debtId: string;
  debtName: string;
  startingBalanceMinor: number;
  paymentMinor: number;
  interestMinor: number;
  principalMinor: number;
  endingBalanceMinor: number;
}

export interface PayoffResult {
  strategy: PayoffStrategy;
  monthlyBudgetMinor: number;
  monthsToDebtFree: number;
  debtFreeDate: IsoDate;
  totalPaidMinor: number;
  totalInterestMinor: number;
  payoffOrder: Array<{ debtId: string; debtName: string; clearedInMonth: number }>;
  schedule: PayoffScheduleEntry[];
  /** Set when the budget cannot even cover interest — the plan never converges. */
  isFeasible: boolean;
  infeasibleReason?: string;
}

/** Hard stop so a pathological input can never spin the event loop forever. */
const MAX_MONTHS = 720; // 60 years

/** Interest accrued this month on a balance, rounded to whole minor units. */
export function monthlyInterestMinor(balanceMinor: number, apr: number): number {
  if (balanceMinor <= 0 || apr <= 0) return 0;
  return Math.round((balanceMinor * apr) / 100 / 12);
}

/**
 * Orders debts according to the chosen strategy.
 *
 * AVALANCHE targets the highest APR first — mathematically optimal, it always
 * pays the least total interest.  SNOWBALL targets the smallest balance first —
 * costs more, but clears individual debts sooner, and the behavioural research
 * is clear that people actually finish snowball plans.  We compute both and let
 * the user see the trade-off in money rather than argue about it.
 */
export function orderDebts(
  debts: DebtLike[],
  strategy: PayoffStrategy,
  customOrder?: string[],
): DebtLike[] {
  const active = debts.filter((d) => d.currentBalanceMinor > 0);

  if (strategy === 'CUSTOM' && customOrder?.length) {
    const rank = new Map(customOrder.map((id, i) => [id, i]));
    return [...active].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  if (strategy === 'SNOWBALL') {
    return [...active].sort(
      (a, b) =>
        a.currentBalanceMinor - b.currentBalanceMinor || b.interestRateApr - a.interestRateApr,
    );
  }

  return [...active].sort(
    (a, b) => b.interestRateApr - a.interestRateApr || a.currentBalanceMinor - b.currentBalanceMinor,
  );
}

export interface SimulateOptions {
  strategy: PayoffStrategy;
  /** Total available for all debt payments each month, in minor units. */
  monthlyBudgetMinor: number;
  /** Extra lump sum applied in the first month only. */
  extraOneOffMinor?: number;
  customOrder?: string[];
  /** Anchors the returned month labels; defaults to the current month. */
  startMonth?: IsoMonth;
  /** Emit the month-by-month schedule (off for cheap comparison runs). */
  includeSchedule?: boolean;
}

/**
 * Month-by-month amortisation of a whole debt portfolio.
 *
 * Each month: interest accrues on every balance, minimums are paid on every
 * debt, and whatever budget is left is thrown entirely at the current target.
 * As debts clear, their minimums stay in the pot — that is the "snowball"
 * effect, and it applies to the avalanche ordering too.
 */
export function simulatePayoff(debts: DebtLike[], options: SimulateOptions): PayoffResult {
  const {
    strategy,
    monthlyBudgetMinor,
    extraOneOffMinor = 0,
    customOrder,
    startMonth = monthOf(new Date().toISOString().slice(0, 10)),
    includeSchedule = true,
  } = options;

  const ordered = orderDebts(debts, strategy, customOrder);
  const balances = new Map(ordered.map((d) => [d.id, d.currentBalanceMinor]));
  const schedule: PayoffScheduleEntry[] = [];
  const payoffOrder: PayoffResult['payoffOrder'] = [];

  const totalMinimums = ordered.reduce((s, d) => s + d.minimumPaymentMinor, 0);
  const empty = (reason?: string): PayoffResult => ({
    strategy,
    monthlyBudgetMinor,
    monthsToDebtFree: 0,
    debtFreeDate: endOfMonth(startMonth),
    totalPaidMinor: 0,
    totalInterestMinor: 0,
    payoffOrder: [],
    schedule: [],
    isFeasible: reason === undefined,
    ...(reason ? { infeasibleReason: reason } : {}),
  });

  if (ordered.length === 0) return empty();

  if (monthlyBudgetMinor < totalMinimums) {
    return empty(
      `A budget of ${monthlyBudgetMinor} does not cover the combined minimum payments of ${totalMinimums}.`,
    );
  }

  let totalPaid = 0;
  let totalInterest = 0;
  let month = 0;

  while (month < MAX_MONTHS) {
    const remaining = ordered.filter((d) => (balances.get(d.id) ?? 0) > 0);
    if (remaining.length === 0) break;

    month += 1;
    const label = addMonths(startMonth, month - 1);
    let budget = monthlyBudgetMinor + (month === 1 ? extraOneOffMinor : 0);

    // 1. Accrue interest on every open balance before any money moves.
    const interestByDebt = new Map<string, number>();
    const openingByDebt = new Map<string, number>();
    for (const debt of remaining) {
      const opening = balances.get(debt.id) ?? 0;
      const interest = monthlyInterestMinor(opening, debt.interestRateApr);
      openingByDebt.set(debt.id, opening);
      interestByDebt.set(debt.id, interest);
      balances.set(debt.id, opening + interest);
      totalInterest += interest;
    }

    const paidByDebt = new Map<string, number>();

    // 2. Cover the minimum on every debt (never more than the payoff amount).
    for (const debt of remaining) {
      const owed = balances.get(debt.id) ?? 0;
      const payment = Math.min(debt.minimumPaymentMinor, owed, budget);
      if (payment <= 0) continue;
      balances.set(debt.id, owed - payment);
      paidByDebt.set(debt.id, payment);
      budget -= payment;
      totalPaid += payment;
    }

    // 3. Everything left over attacks the debts in strategy order.
    for (const debt of remaining) {
      if (budget <= 0) break;
      const owed = balances.get(debt.id) ?? 0;
      if (owed <= 0) continue;
      const extra = Math.min(owed, budget);
      balances.set(debt.id, owed - extra);
      paidByDebt.set(debt.id, (paidByDebt.get(debt.id) ?? 0) + extra);
      budget -= extra;
      totalPaid += extra;
    }

    // 4. Record the month and note anything that just hit zero.
    for (const debt of remaining) {
      const closing = balances.get(debt.id) ?? 0;
      const payment = paidByDebt.get(debt.id) ?? 0;
      const interest = interestByDebt.get(debt.id) ?? 0;

      if (includeSchedule) {
        schedule.push({
          monthIndex: month,
          month: label,
          debtId: debt.id,
          debtName: debt.name,
          startingBalanceMinor: openingByDebt.get(debt.id) ?? 0,
          paymentMinor: payment,
          interestMinor: interest,
          principalMinor: payment - interest,
          endingBalanceMinor: closing,
        });
      }

      if (closing <= 0 && !payoffOrder.some((p) => p.debtId === debt.id)) {
        payoffOrder.push({ debtId: debt.id, debtName: debt.name, clearedInMonth: month });
      }
    }
  }

  const cleared = [...balances.values()].every((b) => b <= 0);

  return {
    strategy,
    monthlyBudgetMinor,
    monthsToDebtFree: month,
    debtFreeDate: endOfMonth(addMonths(startMonth, Math.max(month - 1, 0))),
    totalPaidMinor: totalPaid,
    totalInterestMinor: totalInterest,
    payoffOrder,
    schedule,
    isFeasible: cleared,
    ...(cleared
      ? {}
      : { infeasibleReason: `Balances remain after ${MAX_MONTHS} months at this budget.` }),
  };
}

/**
 * Months and interest if the user only ever pays the minimum.  This is the
 * baseline every plan is sold against — "you save $4,120 and finish 19 months
 * sooner" is far more motivating than an abstract schedule.
 */
export function payoffAtMinimums(debts: DebtLike[], startMonth?: IsoMonth): PayoffResult {
  const totalMinimums = debts.reduce((s, d) => s + d.minimumPaymentMinor, 0);
  return simulatePayoff(debts, {
    strategy: 'AVALANCHE',
    monthlyBudgetMinor: totalMinimums,
    includeSchedule: false,
    ...(startMonth ? { startMonth } : {}),
  });
}

export interface StrategyComparison {
  snowball: PayoffResult;
  avalanche: PayoffResult;
  minimumOnly: PayoffResult;
  /** Extra interest the snowball costs versus the avalanche. */
  snowballExtraInterestMinor: number;
  interestSavedVsMinimumMinor: number;
  monthsSavedVsMinimum: number;
  recommended: PayoffStrategy;
  rationale: string;
}

/** Runs both strategies plus the do-nothing baseline and explains the trade-off. */
export function compareStrategies(
  debts: DebtLike[],
  monthlyBudgetMinor: number,
  startMonth?: IsoMonth,
): StrategyComparison {
  const base = { monthlyBudgetMinor, ...(startMonth ? { startMonth } : {}) };
  const snowball = simulatePayoff(debts, { ...base, strategy: 'SNOWBALL' });
  const avalanche = simulatePayoff(debts, { ...base, strategy: 'AVALANCHE' });
  const minimumOnly = payoffAtMinimums(debts, startMonth);

  const snowballExtraInterestMinor = snowball.totalInterestMinor - avalanche.totalInterestMinor;
  const interestSavedVsMinimumMinor = minimumOnly.totalInterestMinor - avalanche.totalInterestMinor;
  const monthsSavedVsMinimum = minimumOnly.monthsToDebtFree - avalanche.monthsToDebtFree;

  // If the snowball costs little, the motivational win is worth more than the
  // rounding error; past that, the money argument wins.
  const negligible = avalanche.totalInterestMinor * 0.03;
  const recommended: PayoffStrategy =
    snowballExtraInterestMinor <= negligible ? 'SNOWBALL' : 'AVALANCHE';

  const rationale =
    recommended === 'SNOWBALL'
      ? 'The snowball clears your smallest balances first for almost the same total cost, so you get early wins without paying meaningfully more interest.'
      : `The avalanche saves ${snowballExtraInterestMinor} minor units of interest versus the snowball — enough that targeting your highest rate first is worth it.`;

  return {
    snowball,
    avalanche,
    minimumOnly,
    snowballExtraInterestMinor,
    interestSavedVsMinimumMinor,
    monthsSavedVsMinimum,
    recommended,
    rationale,
  };
}

/**
 * Months to clear a single debt at a fixed payment.
 * Returns null when the payment never exceeds the monthly interest, which is
 * the case the UI must surface loudly — that balance grows forever.
 */
export function monthsToPayoff(
  balanceMinor: number,
  apr: number,
  paymentMinor: number,
): number | null {
  if (balanceMinor <= 0) return 0;
  if (paymentMinor <= monthlyInterestMinor(balanceMinor, apr)) return null;

  let balance = balanceMinor;
  let months = 0;
  while (balance > 0 && months < MAX_MONTHS) {
    balance += monthlyInterestMinor(balance, apr);
    balance -= Math.min(paymentMinor, balance);
    months += 1;
  }
  return balance <= 0 ? months : null;
}

/** Total interest paid clearing a single debt at a fixed payment. */
export function totalInterestFor(
  balanceMinor: number,
  apr: number,
  paymentMinor: number,
): number | null {
  if (balanceMinor <= 0) return 0;
  if (paymentMinor <= monthlyInterestMinor(balanceMinor, apr)) return null;

  let balance = balanceMinor;
  let interest = 0;
  let months = 0;
  while (balance > 0 && months < MAX_MONTHS) {
    const accrued = monthlyInterestMinor(balance, apr);
    interest += accrued;
    balance += accrued;
    balance -= Math.min(paymentMinor, balance);
    months += 1;
  }
  return balance <= 0 ? interest : null;
}

/** Standard amortising payment for an instalment loan (mortgage, car, student). */
export function amortisingPaymentMinor(
  principalMinor: number,
  apr: number,
  termMonths: number,
): number {
  if (termMonths <= 0) return principalMinor;
  const r = apr / 100 / 12;
  if (r === 0) return Math.ceil(principalMinor / termMonths);
  const factor = (1 + r) ** termMonths;
  return Math.ceil((principalMinor * r * factor) / (factor - 1));
}
