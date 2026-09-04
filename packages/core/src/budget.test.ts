import { describe, expect, it } from 'vitest';
import { dailyAllowance, evaluateBudget, median, rolloverAmountMinor, suggestBudget } from './budget';

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

describe('dailyAllowance', () => {
  // 30 days in September; 60,000 food / 20,000 transport / 15,000 + 5,000 fun.
  const evaluate = (spendByCategory: Record<string, number>, asOf: string) =>
    evaluateBudget({ month: '2026-09', lines, spendByCategory, asOf });

  it('spreads what is left over the remaining days, today included', () => {
    // Day 4 of 30 leaves 27 spendable days, this one among them.
    const result = dailyAllowance({
      evaluation: evaluate({ food: 29_282, transport: 2_780 }, '2026-09-04'),
      today: '2026-09-04',
    })!;

    expect(result.daysRemainingInclusive).toBe(27);
    const byId = Object.fromEntries(result.lines.map((l) => [l.categoryId, l]));
    expect(byId.food!.allowanceMinor).toBe(1_137); // 30,718 / 27
    expect(byId.transport!.allowanceMinor).toBe(637); // 17,220 / 27
  });

  it('floors, so spending the figure every day never breaches the limit', () => {
    const result = dailyAllowance({
      evaluation: evaluate({ transport: 0 }, '2026-09-04'),
      today: '2026-09-04',
    })!;
    const transport = result.lines.find((l) => l.categoryId === 'transport')!;

    expect(transport.allowanceMinor).toBe(740); // 20,000 / 27 = 740.7, not 741
    expect(transport.allowanceMinor * result.daysRemainingInclusive).toBeLessThanOrEqual(20_000);
  });

  it('hands the whole remainder to the last day rather than dividing by zero', () => {
    const result = dailyAllowance({
      evaluation: evaluate({ food: 55_000 }, '2026-09-30'),
      today: '2026-09-30',
    })!;

    expect(result.daysRemainingInclusive).toBe(1);
    expect(result.lines.find((l) => l.categoryId === 'food')!.allowanceMinor).toBe(5_000);
  });

  it('reports an overspent line as exhausted, not as a negative allowance', () => {
    const result = dailyAllowance({
      evaluation: evaluate({ food: 72_000 }, '2026-09-10'),
      today: '2026-09-10',
    })!;
    const food = result.lines.find((l) => l.categoryId === 'food')!;

    expect(food.remainingMinor).toBe(-12_000);
    expect(food.allowanceMinor).toBe(0);
    expect(food.status).toBe('EXHAUSTED');
  });

  it('flags a line that must now run at under half its planned pace', () => {
    // 2,000/day was the plan; 55,000 spent by day 10 leaves 5,000 over 21 days.
    const result = dailyAllowance({
      evaluation: evaluate({ food: 55_000 }, '2026-09-10'),
      today: '2026-09-10',
    })!;
    const food = result.lines.find((l) => l.categoryId === 'food')!;

    expect(food.evenPaceMinor).toBe(2_000);
    expect(food.allowanceMinor).toBe(238);
    expect(food.status).toBe('TIGHT');
  });

  it('leaves an untouched line on track at roughly its planned pace', () => {
    const result = dailyAllowance({
      evaluation: evaluate({}, '2026-09-10'),
      today: '2026-09-10',
    })!;
    const food = result.lines.find((l) => l.categoryId === 'food')!;

    expect(food.allowanceMinor).toBe(2_857); // 60,000 / 21 — ahead of the 2,000 plan
    expect(food.status).toBe('ON_TRACK');
  });

  it('totals the remainder against the whole budget, not just the lines', () => {
    // 10,000 of the spend sits in a category with no budget line at all.
    const evaluation = evaluateBudget({
      month: '2026-09',
      lines,
      spendByCategory: { food: 20_000, unbudgeted: 10_000 },
      asOf: '2026-09-06',
    });
    const result = dailyAllowance({ evaluation, today: '2026-09-06' })!;

    expect(result.totalRemainingMinor).toBe(70_000); // 100,000 limit less 30,000
    expect(result.totalAllowanceMinor).toBe(2_800); // over 25 days
  });

  it('converts before dividing, so the figure is not rounded twice', () => {
    // 40,000 limit less 29,282 spent leaves 107.18 USD; at 3.75 SAR that is
    // 401.92 SAR over 27 days = 14.88, not the 14.85 you get by flooring the
    // dollar figure to 3.96 first and converting that.
    const evaluation = evaluateBudget({
      month: '2026-09',
      lines: [{ categoryId: 'food', limitMinor: 40_000 }],
      spendByCategory: { food: 29_282 },
      asOf: '2026-09-04',
    });

    const inRiyals = dailyAllowance({
      evaluation,
      today: '2026-09-04',
      convertMinor: (minor) => Math.round(minor * 3.75),
    })!;

    expect(inRiyals.lines[0]!.allowanceMinor).toBe(1_488);
    expect(inRiyals.lines[0]!.remainingMinor).toBe(40_193);
    expect(inRiyals.lines[0]!.evenPaceMinor).toBe(5_000); // 150,000 SAR / 30
  });

  it('leaves the status alone when only the currency changes', () => {
    const evaluation = evaluateBudget({
      month: '2026-09',
      lines,
      spendByCategory: { food: 55_000 },
      asOf: '2026-09-10',
    });
    const base = dailyAllowance({ evaluation, today: '2026-09-10' })!;
    const converted = dailyAllowance({
      evaluation,
      today: '2026-09-10',
      convertMinor: (minor) => Math.round(minor * 3.75),
    })!;

    expect(converted.lines.map((l) => l.status)).toEqual(base.lines.map((l) => l.status));
  });

  it('returns null for a month that is finished or has not started', () => {
    const evaluation = evaluate({ food: 10_000 }, '2026-09-30');

    expect(dailyAllowance({ evaluation, today: '2026-10-01' })).toBeNull();
    expect(dailyAllowance({ evaluation, today: '2026-08-31' })).toBeNull();
  });
});
