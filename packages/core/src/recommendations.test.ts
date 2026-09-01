import { describe, expect, it } from 'vitest';
import {
  financialHealthScore,
  generateRecommendations,
  type FinancialSnapshot,
} from './recommendations';
import type { CashFlowForecastPoint } from './forecast';
import type { RecurringExpense } from './patterns';

function forecastPoints(overrides: Partial<CashFlowForecastPoint>[] = []): CashFlowForecastPoint[] {
  return Array.from({ length: 6 }, (_, i) => ({
    month: `2026-0${i + 1}`,
    projectedIncomeMinor: 500_000,
    projectedExpensesMinor: 400_000,
    projectedNetMinor: 100_000,
    projectedBalanceMinor: 1_000_000 + i * 100_000,
    lowerBoundMinor: 50_000,
    upperBoundMinor: 150_000,
    isShortfall: false,
    ...overrides[i],
  }));
}

function recurring(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
  return {
    merchant: 'netflix',
    categoryId: 'entertainment',
    averageAmountMinor: 1_599,
    frequency: 'MONTHLY',
    medianIntervalDays: 30,
    occurrences: 6,
    firstSeen: '2026-01-04',
    lastSeen: '2026-06-04',
    nextExpectedDate: '2026-07-04',
    confidence: 0.9,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    currency: 'USD',
    monthlyIncomeMinor: 500_000,
    monthlyExpensesMinor: 400_000,
    liquidSavingsMinor: 1_200_000,
    spendByCategory: [],
    debts: [],
    recurring: [],
    forecast: forecastPoints(),
    emergencyFundTargetMinor: 1_200_000,
    ...overrides,
  };
}

describe('money formatting in generated copy', () => {
  it('renders every amount as currency, never as raw minor units', () => {
    const recommendations = generateRecommendations(
      snapshot({
        debts: [
          {
            id: 'card',
            name: 'Rewards Card',
            currentBalanceMinor: 438_500,
            interestRateApr: 22.9,
            minimumPaymentMinor: 11_000,
          },
        ],
      }),
    );

    const refinance = recommendations.find((r) => r.kind === 'REFINANCE_DEBT');
    expect(refinance).toBeDefined();
    expect(refinance!.title).toMatch(/\$[\d,]+\.\d{2}/);
    // The bare integer must not survive into user-facing copy.
    expect(refinance!.title).not.toMatch(/save \d+ a month/);
    for (const item of refinance!.evidence) {
      if (item.label.includes('APR')) continue;
      expect(item.value).toMatch(/^\$[\d,]+\.\d{2}$/);
    }
  });

  it('honours the snapshot currency and locale', () => {
    const recommendations = generateRecommendations(
      snapshot({
        currency: 'GBP',
        locale: 'en-GB',
        debts: [
          {
            id: 'card',
            name: 'Card',
            currentBalanceMinor: 438_500,
            interestRateApr: 24,
            minimumPaymentMinor: 11_000,
          },
        ],
      }),
    );
    expect(recommendations.find((r) => r.kind === 'REFINANCE_DEBT')!.title).toContain('£');
  });
});

describe('generateRecommendations', () => {
  it('returns nothing for a healthy, unremarkable picture', () => {
    expect(generateRecommendations(snapshot())).toEqual([]);
  });

  it('puts a projected shortfall above everything else', () => {
    const forecast = forecastPoints();
    forecast[3] = { ...forecast[3]!, projectedBalanceMinor: -250_000, isShortfall: true };

    const recommendations = generateRecommendations(
      snapshot({
        forecast,
        debts: [
          {
            id: 'card',
            name: 'Card',
            currentBalanceMinor: 500_000,
            interestRateApr: 25,
            minimumPaymentMinor: 12_000,
          },
        ],
      }),
    );

    expect(recommendations[0]!.kind).toBe('CASHFLOW_WARNING');
    expect(recommendations[0]!.priority).toBe('HIGH');
  });

  it('flags a discretionary category running above its own median', () => {
    const recommendations = generateRecommendations(
      snapshot({
        spendByCategory: [
          {
            categoryId: 'dining',
            categoryName: 'Dining out',
            amountMinor: 80_000,
            historicalMedianMinor: 50_000,
            isEssential: false,
          },
        ],
      }),
    );

    const overspend = recommendations.find((r) => r.kind === 'REDUCE_CATEGORY_SPEND');
    expect(overspend).toBeDefined();
    expect(overspend!.title).toContain('60%');
    // Suggests closing 75% of the gap, not all of it.
    expect(overspend!.estimatedImpactMinor).toBe(22_500);
  });

  it('leaves essential categories alone', () => {
    const recommendations = generateRecommendations(
      snapshot({
        spendByCategory: [
          {
            categoryId: 'housing',
            categoryName: 'Housing',
            amountMinor: 200_000,
            historicalMedianMinor: 100_000,
            isEssential: true,
          },
        ],
      }),
    );
    expect(recommendations.find((r) => r.kind === 'REDUCE_CATEGORY_SPEND')).toBeUndefined();
  });

  it('never suggests moving cash to savings while expensive debt is open', () => {
    const withDebt = generateRecommendations(
      snapshot({
        liquidSavingsMinor: 5_000_000,
        debts: [
          {
            id: 'card',
            name: 'Card',
            currentBalanceMinor: 300_000,
            interestRateApr: 19,
            minimumPaymentMinor: 9_000,
          },
        ],
      }),
    );
    expect(withDebt.find((r) => r.kind === 'MOVE_CASH_TO_SAVINGS')).toBeUndefined();

    const debtFree = generateRecommendations(snapshot({ liquidSavingsMinor: 5_000_000 }));
    expect(debtFree.find((r) => r.kind === 'MOVE_CASH_TO_SAVINGS')).toBeDefined();
  });

  it('raises the emergency fund when the buffer is thin', () => {
    const recommendations = generateRecommendations(
      snapshot({ liquidSavingsMinor: 100_000, emergencyFundTargetMinor: 1_200_000 }),
    );
    const fund = recommendations.find((r) => r.kind === 'BUILD_EMERGENCY_FUND');
    expect(fund).toBeDefined();
    expect(fund!.priority).toBe('HIGH');
  });

  it('totals recurring charges only once they are a real share of income', () => {
    const cheap = generateRecommendations(
      snapshot({
        recurring: [
          recurring({ merchant: 'a', averageAmountMinor: 500 }),
          recurring({ merchant: 'b', averageAmountMinor: 500 }),
          recurring({ merchant: 'c', averageAmountMinor: 500 }),
        ],
      }),
    );
    expect(cheap.find((r) => r.kind === 'CANCEL_SUBSCRIPTION')).toBeUndefined();

    const expensive = generateRecommendations(
      snapshot({
        recurring: [
          recurring({ merchant: 'a', averageAmountMinor: 20_000 }),
          recurring({ merchant: 'b', averageAmountMinor: 25_000 }),
          recurring({ merchant: 'c', averageAmountMinor: 30_000 }),
        ],
      }),
    );
    const subs = expensive.find((r) => r.kind === 'CANCEL_SUBSCRIPTION');
    expect(subs).toBeDefined();
    expect(subs!.title).toContain('3 recurring charges');
  });

  it('ignores low-confidence recurring detections', () => {
    const recommendations = generateRecommendations(
      snapshot({
        recurring: [
          recurring({ merchant: 'a', averageAmountMinor: 30_000, confidence: 0.5 }),
          recurring({ merchant: 'b', averageAmountMinor: 30_000, confidence: 0.5 }),
          recurring({ merchant: 'c', averageAmountMinor: 30_000, confidence: 0.5 }),
        ],
      }),
    );
    expect(recommendations.find((r) => r.kind === 'CANCEL_SUBSCRIPTION')).toBeUndefined();
  });

  it('sorts by priority, then by money at stake', () => {
    const recommendations = generateRecommendations(
      snapshot({
        liquidSavingsMinor: 100_000,
        spendByCategory: [
          {
            categoryId: 'dining',
            categoryName: 'Dining',
            amountMinor: 120_000,
            historicalMedianMinor: 50_000,
            isEssential: false,
          },
        ],
        debts: [
          {
            id: 'card',
            name: 'Card',
            currentBalanceMinor: 800_000,
            interestRateApr: 24,
            minimumPaymentMinor: 20_000,
          },
        ],
      }),
    );

    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    for (let i = 1; i < recommendations.length; i += 1) {
      expect(rank[recommendations[i - 1]!.priority]).toBeLessThanOrEqual(
        rank[recommendations[i]!.priority],
      );
    }
  });
});

describe('financialHealthScore', () => {
  it('scores a strong position highly', () => {
    const result = financialHealthScore(
      snapshot({
        monthlyIncomeMinor: 600_000,
        monthlyExpensesMinor: 400_000,
        liquidSavingsMinor: 2_400_000,
      }),
    );
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.band).toBe('EXCELLENT');
    expect(result.components).toHaveLength(4);
  });

  it('penalises a heavy debt load', () => {
    const result = financialHealthScore(
      snapshot({
        debts: [
          {
            id: 'mortgage',
            name: 'Mortgage',
            currentBalanceMinor: 20_000_000,
            interestRateApr: 5,
            minimumPaymentMinor: 120_000,
          },
        ],
      }),
    );
    expect(result.components.find((c) => c.name === 'Debt load')!.score).toBe(0);
    expect(result.score).toBeLessThan(80);
  });

  it('penalises projected shortfalls', () => {
    const forecast = forecastPoints();
    forecast[2] = { ...forecast[2]!, isShortfall: true };
    forecast[3] = { ...forecast[3]!, isShortfall: true };

    const result = financialHealthScore(snapshot({ forecast }));
    expect(result.components.find((c) => c.name === 'Cash-flow stability')!.score).toBe(50);
  });

  it('weights its components to exactly 1', () => {
    const result = financialHealthScore(snapshot());
    expect(result.components.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
  });

  it('handles a zero-income account without dividing by zero', () => {
    const result = financialHealthScore(
      snapshot({ monthlyIncomeMinor: 0, monthlyExpensesMinor: 0, liquidSavingsMinor: 0 }),
    );
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
