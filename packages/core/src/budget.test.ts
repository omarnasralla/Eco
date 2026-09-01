import { describe, expect, it } from 'vitest';
import { evaluateBudget, median, rolloverAmountMinor, suggestBudget } from './budget';

const lines = [
  { categoryId: 'food', limitMinor: 60_000 },
  { categoryId: 'transport', limitMinor: 20_000 },
  { categoryId: 'fun', limitMinor: 15_000, rollover: true, rolloverFromPreviousMinor: 5_000 },
];

describe('evaluateBudget', () => {
  it('classifies lines as under, warning and over', () => {
    const result = evaluateBudget({
      month: '2026-06',
      lines,
      spendByCategory: { food: 30_000, transport: 17_000, fun: 25_000 },
    });

    const byId = Object.fromEntries(result.lines.map((l) => [l.categoryId, l]));
    expect(byId.food!.status).toBe('UNDER');
    expect(byId.transport!.status).toBe('WARNING'); // 85% of 20,000
    expect(byId.fun!.status).toBe('OVER'); // 25,000 against 15,000 + 5,000 rollover
  });

  it('adds rollover room to the effective limit', () => {
    const result = evaluateBudget({ month: '2026-06', lines, spendByCategory: { fun: 18_000 } });
    const fun = result.lines.find((l) => l.categoryId === 'fun')!;
    expect(fun.effectiveLimitMinor).toBe(20_000);
    expect(fun.remainingMinor).toBe(2_000);
    expect(fun.status).toBe('WARNING');
  });

  it('counts spend in categories that have no budget line', () => {
    const result = evaluateBudget({
      month: '2026-06',
      lines,
      spendByCategory: { food: 10_000, unbudgeted: 40_000 },
    });
    expect(result.totalSpentMinor).toBe(50_000);
  });

  it('projects month-end spend from the pace so far', () => {
    // 30,000 spent over the first 10 days of a 30-day month → 90,000 projected.
    const result = evaluateBudget({
      month: '2026-06',
      lines,
      spendByCategory: { food: 30_000 },
      asOf: '2026-06-10',
    });
    expect(result.daysElapsed).toBe(10);
    expect(result.daysRemaining).toBe(20);
    expect(result.projectedSpendMinor).toBe(90_000);
    expect(result.projectedOverspendMinor).toBe(0); // 90,000 is under the 95,000 limit
  });

  it('does not extrapolate committed recurring spend', () => {
    // Rent lands on day 1. Scaling the whole total by days-elapsed would
    // project thirty months of rent; only the variable 724 should be spread.
    const result = evaluateBudget({
      month: '2026-06',
      lines: [
        { categoryId: 'housing', limitMinor: 145_000 },
        { categoryId: 'food', limitMinor: 55_000 },
      ],
      spendByCategory: { housing: 145_000, food: 724 },
      committedSpendByCategory: { housing: 145_000 },
      asOf: '2026-06-01',
    });

    expect(result.totalSpentMinor).toBe(145_724);
    // 145,000 committed + (724 / 1 day × 30 days) = 166,720
    expect(result.projectedSpendMinor).toBe(166_720);
  });

  it('still extrapolates everything when nothing is marked committed', () => {
    const result = evaluateBudget({
      month: '2026-06',
      lines: [{ categoryId: 'food', limitMinor: 55_000 }],
      spendByCategory: { food: 10_000 },
      asOf: '2026-06-10',
    });
    expect(result.projectedSpendMinor).toBe(30_000);
  });

  it('never projects less than what has already been spent', () => {
    // A committed charge larger than the remaining run rate must not drag the
    // projection below reality.
    const result = evaluateBudget({
      month: '2026-06',
      lines: [{ categoryId: 'housing', limitMinor: 145_000 }],
      spendByCategory: { housing: 145_000 },
      committedSpendByCategory: { housing: 145_000 },
      asOf: '2026-06-25',
    });
    expect(result.projectedSpendMinor).toBe(145_000);
  });

  it('ignores a committed amount larger than the category actually spent', () => {
    // Stale committed data must not create phantom spend.
    const result = evaluateBudget({
      month: '2026-06',
      lines: [{ categoryId: 'food', limitMinor: 55_000 }],
      spendByCategory: { food: 5_000 },
      committedSpendByCategory: { food: 99_000 },
      asOf: '2026-06-15',
    });
    expect(result.totalSpentMinor).toBe(5_000);
    expect(result.projectedSpendMinor).toBe(5_000);
  });

  it('treats the full month as elapsed when no as-of date is given', () => {
    const result = evaluateBudget({ month: '2026-02', lines, spendByCategory: { food: 28_000 } });
    expect(result.daysElapsed).toBe(28); // 2026 is not a leap year
    expect(result.daysRemaining).toBe(0);
  });

  it('honours a custom alert threshold', () => {
    const result = evaluateBudget({
      month: '2026-06',
      lines: [{ categoryId: 'food', limitMinor: 100_000 }],
      spendByCategory: { food: 55_000 },
      alertThresholdPct: 50,
    });
    expect(result.lines[0]!.status).toBe('WARNING');
  });
});

describe('rolloverAmountMinor', () => {
  it('carries unspent room forward but never carries a deficit', () => {
    const [under, over] = evaluateBudget({
      month: '2026-06',
      lines: [
        { categoryId: 'a', limitMinor: 10_000, rollover: true },
        { categoryId: 'b', limitMinor: 10_000, rollover: true },
      ],
      spendByCategory: { a: 4_000, b: 14_000 },
    }).lines;

    expect(rolloverAmountMinor(under!)).toBe(6_000);
    expect(rolloverAmountMinor(over!)).toBe(0);
  });
});

describe('suggestBudget', () => {
  it('uses the median so one outlier month does not set the limit', () => {
    const { lines: suggested } = suggestBudget({
      historyByCategory: { food: [50_000, 52_000, 200_000, 48_000, 51_000] },
      monthlyIncomeMinor: 1_000_000,
    });
    expect(suggested[0]!.limitMinor).toBe(51_000);
  });

  it('scales limits down when history exceeds the savings target', () => {
    const result = suggestBudget({
      historyByCategory: { food: [400_000], rent: [500_000] },
      monthlyIncomeMinor: 1_000_000,
      targetSavingsRatePct: 20,
    });
    // 900,000 of history against 800,000 spendable → scale to ~0.889.
    expect(result.adjustmentFactor).toBeCloseTo(0.889, 2);
    expect(result.totalLimitMinor).toBeLessThanOrEqual(800_000);
  });

  it('leaves limits alone when history already fits the target', () => {
    const result = suggestBudget({
      historyByCategory: { food: [100_000] },
      monthlyIncomeMinor: 1_000_000,
    });
    expect(result.adjustmentFactor).toBe(1);
    expect(result.totalLimitMinor).toBe(100_000);
  });
});

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 rounded
    expect(median([10, 20, 30])).toBe(20);
    expect(median([])).toBe(0);
  });
});
