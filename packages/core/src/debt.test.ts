import { describe, expect, it } from 'vitest';
import {
  amortisingPaymentMinor,
  compareStrategies,
  monthlyInterestMinor,
  monthsToPayoff,
  orderDebts,
  simulatePayoff,
  totalInterestFor,
  type DebtLike,
} from './debt';

const card: DebtLike = {
  id: 'card',
  name: 'Rewards Card',
  currentBalanceMinor: 480_000, // $4,800
  interestRateApr: 22.9,
  minimumPaymentMinor: 12_000, // $120
};
const carLoan: DebtLike = {
  id: 'car',
  name: 'Car Loan',
  currentBalanceMinor: 1_250_000,
  interestRateApr: 6.4,
  minimumPaymentMinor: 32_000,
};
const studentLoan: DebtLike = {
  id: 'student',
  name: 'Student Loan',
  currentBalanceMinor: 210_000,
  interestRateApr: 4.5,
  minimumPaymentMinor: 9_000,
};

const portfolio = [card, carLoan, studentLoan];

describe('monthlyInterestMinor', () => {
  it('divides the APR across twelve months', () => {
    expect(monthlyInterestMinor(120_000, 12)).toBe(1_200);
  });

  it('returns zero for a cleared or interest-free balance', () => {
    expect(monthlyInterestMinor(0, 22.9)).toBe(0);
    expect(monthlyInterestMinor(500_000, 0)).toBe(0);
  });
});

describe('orderDebts', () => {
  it('puts the smallest balance first for the snowball', () => {
    expect(orderDebts(portfolio, 'SNOWBALL').map((d) => d.id)).toEqual(['student', 'card', 'car']);
  });

  it('puts the highest rate first for the avalanche', () => {
    expect(orderDebts(portfolio, 'AVALANCHE').map((d) => d.id)).toEqual(['card', 'car', 'student']);
  });

  it('honours an explicit order and drops cleared debts', () => {
    const withCleared = [...portfolio, { ...card, id: 'paid', currentBalanceMinor: 0 }];
    const ordered = orderDebts(withCleared, 'CUSTOM', ['car', 'student', 'card']);
    expect(ordered.map((d) => d.id)).toEqual(['car', 'student', 'card']);
  });
});

describe('simulatePayoff', () => {
  it('clears every balance and reports the payoff order', () => {
    const result = simulatePayoff(portfolio, {
      strategy: 'AVALANCHE',
      monthlyBudgetMinor: 80_000,
      startMonth: '2026-01',
    });

    expect(result.isFeasible).toBe(true);
    expect(result.monthsToDebtFree).toBeGreaterThan(0);
    expect(result.payoffOrder).toHaveLength(3);
    // Highest APR is targeted first, so it clears first.
    expect(result.payoffOrder[0]!.debtId).toBe('card');
    // Every debt reaches a zero closing balance in its final schedule row.
    for (const debt of portfolio) {
      const rows = result.schedule.filter((r) => r.debtId === debt.id);
      expect(rows.at(-1)!.endingBalanceMinor).toBe(0);
    }
  });

  it('reports infeasibility when the budget cannot cover the minimums', () => {
    const result = simulatePayoff(portfolio, {
      strategy: 'AVALANCHE',
      monthlyBudgetMinor: 10_000,
    });
    expect(result.isFeasible).toBe(false);
    expect(result.infeasibleReason).toMatch(/minimum payments/);
  });

  it('applies a one-off lump sum in the first month only', () => {
    const base = simulatePayoff(portfolio, {
      strategy: 'AVALANCHE',
      monthlyBudgetMinor: 80_000,
      startMonth: '2026-01',
    });
    const withLump = simulatePayoff(portfolio, {
      strategy: 'AVALANCHE',
      monthlyBudgetMinor: 80_000,
      extraOneOffMinor: 200_000,
      startMonth: '2026-01',
    });

    expect(withLump.monthsToDebtFree).toBeLessThan(base.monthsToDebtFree);
    expect(withLump.totalInterestMinor).toBeLessThan(base.totalInterestMinor);
  });

  it('never pays more than the outstanding balance', () => {
    const result = simulatePayoff([card], {
      strategy: 'AVALANCHE',
      monthlyBudgetMinor: 500_000, // Far more than the balance.
    });
    expect(result.monthsToDebtFree).toBe(1);
    expect(result.totalPaidMinor).toBeLessThanOrEqual(
      card.currentBalanceMinor + monthlyInterestMinor(card.currentBalanceMinor, card.interestRateApr),
    );
  });

  it('rolls a cleared debt’s minimum into the remaining debts', () => {
    const result = simulatePayoff(portfolio, {
      strategy: 'SNOWBALL',
      monthlyBudgetMinor: 60_000,
      startMonth: '2026-01',
    });
    const firstCleared = result.payoffOrder[0]!.clearedInMonth;
    const later = result.schedule.filter(
      (r) => r.monthIndex === firstCleared + 1 && r.paymentMinor > 0,
    );
    const spendAfter = later.reduce((s, r) => s + r.paymentMinor, 0);
    // The whole budget is still deployed once a debt drops out.
    expect(spendAfter).toBe(60_000);
  });

  it('returns an empty, feasible plan when there is no debt', () => {
    const result = simulatePayoff([], { strategy: 'AVALANCHE', monthlyBudgetMinor: 50_000 });
    expect(result.isFeasible).toBe(true);
    expect(result.monthsToDebtFree).toBe(0);
    expect(result.schedule).toEqual([]);
  });
});

describe('compareStrategies', () => {
  it('shows the avalanche costing no more interest than the snowball', () => {
    const comparison = compareStrategies(portfolio, 80_000, '2026-01');
    expect(comparison.avalanche.totalInterestMinor).toBeLessThanOrEqual(
      comparison.snowball.totalInterestMinor,
    );
    expect(comparison.snowballExtraInterestMinor).toBeGreaterThanOrEqual(0);
  });

  it('beats the minimum-only baseline on both time and interest', () => {
    const comparison = compareStrategies(portfolio, 90_000, '2026-01');
    expect(comparison.monthsSavedVsMinimum).toBeGreaterThan(0);
    expect(comparison.interestSavedVsMinimumMinor).toBeGreaterThan(0);
  });

  it('recommends the snowball when it costs almost nothing extra', () => {
    // Similar rates: the ordering barely matters, so early wins should win out.
    const similar: DebtLike[] = [
      { id: 'a', name: 'A', currentBalanceMinor: 100_000, interestRateApr: 10, minimumPaymentMinor: 5_000 },
      { id: 'b', name: 'B', currentBalanceMinor: 110_000, interestRateApr: 10.2, minimumPaymentMinor: 5_000 },
    ];
    expect(compareStrategies(similar, 40_000, '2026-01').recommended).toBe('SNOWBALL');
  });
});

describe('single-debt helpers', () => {
  it('returns null when the payment never clears the interest', () => {
    // $50/month against $4,800 at 22.9% accrues ~$91.60 a month.
    expect(monthsToPayoff(480_000, 22.9, 5_000)).toBeNull();
    expect(totalInterestFor(480_000, 22.9, 5_000)).toBeNull();
  });

  it('clears an interest-free balance in exact instalments', () => {
    expect(monthsToPayoff(100_000, 0, 25_000)).toBe(4);
    expect(totalInterestFor(100_000, 0, 25_000)).toBe(0);
  });

  it('computes a standard amortising payment', () => {
    // $250,000 over 30 years at 6% ≈ $1,498.88/month.
    const payment = amortisingPaymentMinor(25_000_000, 6, 360);
    expect(payment).toBeGreaterThan(149_000);
    expect(payment).toBeLessThan(151_000);
  });

  it('splits an interest-free loan evenly across its term', () => {
    expect(amortisingPaymentMinor(120_000, 0, 12)).toBe(10_000);
  });
});
