import { describe, expect, it } from 'vitest';
import {
  detectAnomalies,
  detectRecurringExpenses,
  monthlyTotals,
  seasonalityIndex,
  topMerchants,
  weekdayDistribution,
  type TransactionLike,
} from './patterns';

/** Builds a monthly subscription series starting on the given date. */
function monthlySeries(
  merchant: string,
  amountMinor: number,
  months: number,
  startMonth = 1,
  jitterDays = 0,
): TransactionLike[] {
  return Array.from({ length: months }, (_, i) => {
    const m = startMonth + i;
    const year = 2026 + Math.floor((m - 1) / 12);
    const month = ((m - 1) % 12) + 1;
    const day = 5 + (jitterDays ? (i % 2 ? jitterDays : 0) : 0);
    return {
      id: `${merchant}-${i}`,
      amountMinor,
      categoryId: 'entertainment',
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      merchant,
    };
  });
}

describe('detectRecurringExpenses', () => {
  it('identifies a steady monthly subscription', () => {
    const found = detectRecurringExpenses(monthlySeries('Netflix', 1_599, 6));
    expect(found).toHaveLength(1);
    expect(found[0]!.frequency).toBe('MONTHLY');
    expect(found[0]!.averageAmountMinor).toBe(1_599);
    expect(found[0]!.occurrences).toBe(6);
    expect(found[0]!.confidence).toBeGreaterThan(0.8);
  });

  it('tolerates a few days of billing jitter', () => {
    const found = detectRecurringExpenses(monthlySeries('Spotify', 1_099, 6, 1, 2));
    expect(found).toHaveLength(1);
    expect(found[0]!.frequency).toBe('MONTHLY');
  });

  it('normalises noisy card descriptors to one merchant', () => {
    const noisy: TransactionLike[] = [
      { id: '1', amountMinor: 1_200, categoryId: 'food', date: '2026-01-05', merchant: "SQ *JOE'S COFFEE #4412" },
      { id: '2', amountMinor: 1_200, categoryId: 'food', date: '2026-02-05', merchant: "SQ *JOE'S COFFEE #7781" },
      { id: '3', amountMinor: 1_200, categoryId: 'food', date: '2026-03-05', merchant: "TST* JOE'S COFFEE" },
      { id: '4', amountMinor: 1_200, categoryId: 'food', date: '2026-04-05', merchant: "JOE'S COFFEE" },
    ];
    const found = detectRecurringExpenses(noisy);
    expect(found).toHaveLength(1);
    expect(found[0]!.merchant).toBe('joes coffee');
  });

  it('rejects irregular one-off spending at the same merchant', () => {
    const irregular: TransactionLike[] = [
      { id: '1', amountMinor: 4_500, categoryId: 'food', date: '2026-01-03', merchant: 'Corner Deli' },
      { id: '2', amountMinor: 800, categoryId: 'food', date: '2026-01-09', merchant: 'Corner Deli' },
      { id: '3', amountMinor: 12_000, categoryId: 'food', date: '2026-02-27', merchant: 'Corner Deli' },
      { id: '4', amountMinor: 2_100, categoryId: 'food', date: '2026-05-14', merchant: 'Corner Deli' },
    ];
    expect(detectRecurringExpenses(irregular)).toEqual([]);
  });

  it('classifies weekly and yearly cadences', () => {
    const weekly: TransactionLike[] = Array.from({ length: 8 }, (_, i) => ({
      id: `w${i}`,
      amountMinor: 2_500,
      categoryId: 'transport',
      date: `2026-01-${String(1 + i * 7).padStart(2, '0')}`,
      merchant: 'Rail Pass',
    })).filter((t) => Number(t.date.slice(8)) <= 31);
    const found = detectRecurringExpenses(weekly);
    expect(found[0]!.frequency).toBe('WEEKLY');

    const yearly: TransactionLike[] = [
      { id: 'y1', amountMinor: 45_000, categoryId: 'insurance', date: '2024-03-01', merchant: 'Home Insurance' },
      { id: 'y2', amountMinor: 46_000, categoryId: 'insurance', date: '2025-03-02', merchant: 'Home Insurance' },
      { id: 'y3', amountMinor: 47_000, categoryId: 'insurance', date: '2026-03-01', merchant: 'Home Insurance' },
    ];
    expect(detectRecurringExpenses(yearly)[0]!.frequency).toBe('YEARLY');
  });

  it('predicts the next charge date', () => {
    const found = detectRecurringExpenses(monthlySeries('Gym', 3_500, 5));
    expect(found[0]!.lastSeen).toBe('2026-05-05');
    // Gaps are 31, 28, 31, 30 days, so the median gap is 31.
    expect(found[0]!.nextExpectedDate).toBe('2026-06-05');
  });

  it('ignores transactions with no merchant and respects minOccurrences', () => {
    const noMerchant: TransactionLike[] = [
      { id: '1', amountMinor: 1_000, categoryId: 'food', date: '2026-01-05', merchant: null },
      { id: '2', amountMinor: 1_000, categoryId: 'food', date: '2026-02-05', merchant: null },
      { id: '3', amountMinor: 1_000, categoryId: 'food', date: '2026-03-05', merchant: null },
    ];
    expect(detectRecurringExpenses(noMerchant)).toEqual([]);
    expect(detectRecurringExpenses(monthlySeries('Netflix', 1_599, 3), { minOccurrences: 5 })).toEqual([]);
  });
});

describe('seasonalityIndex', () => {
  it('scores a reliably expensive month above average', () => {
    const totals = Array.from({ length: 24 }, (_, i) => {
      const month = (i % 12) + 1;
      const year = 2025 + Math.floor(i / 12);
      return {
        month: `${year}-${String(month).padStart(2, '0')}`,
        amountMinor: month === 12 ? 900_000 : 500_000,
      };
    });

    const index = seasonalityIndex(totals);
    expect(index).toHaveLength(12);
    expect(index[11]!.indexVsAverage).toBeGreaterThan(1.4);
    expect(index[11]!.sampleSize).toBe(2);
    expect(index[5]!.indexVsAverage).toBeLessThan(1);
  });

  it('returns a neutral index with no data', () => {
    expect(seasonalityIndex([]).every((m) => m.indexVsAverage === 1)).toBe(true);
  });
});

describe('topMerchants and weekdayDistribution', () => {
  const txs: TransactionLike[] = [
    { id: '1', amountMinor: 5_000, categoryId: 'food', date: '2026-06-13', merchant: 'Market' }, // Saturday
    { id: '2', amountMinor: 3_000, categoryId: 'food', date: '2026-06-13', merchant: 'Market' },
    { id: '3', amountMinor: 9_000, categoryId: 'fun', date: '2026-06-15', merchant: 'Cinema' }, // Monday
  ];

  it('ranks merchants by total spend', () => {
    const top = topMerchants(txs);
    expect(top[0]).toEqual({ merchant: 'cinema', amountMinor: 9_000, count: 1 });
    expect(top[1]).toEqual({ merchant: 'market', amountMinor: 8_000, count: 2 });
  });

  it('buckets spend by day of week', () => {
    const dist = weekdayDistribution(txs);
    expect(dist).toHaveLength(7);
    expect(dist[6]!.amountMinor).toBe(8_000); // Saturday
    expect(dist[1]!.amountMinor).toBe(9_000); // Monday
  });
});

describe('monthlyTotals', () => {
  it('sums by month in chronological order', () => {
    const totals = monthlyTotals([
      { id: '1', amountMinor: 100, categoryId: 'a', date: '2026-02-10' },
      { id: '2', amountMinor: 200, categoryId: 'a', date: '2026-01-10' },
      { id: '3', amountMinor: 300, categoryId: 'a', date: '2026-01-20' },
    ]);
    expect(totals).toEqual([
      { month: '2026-01', amountMinor: 500 },
      { month: '2026-02', amountMinor: 100 },
    ]);
  });
});

describe('detectAnomalies', () => {
  it('flags a transaction far above the category norm', () => {
    const txs: TransactionLike[] = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      amountMinor: 2_000 + (i % 3) * 100,
      categoryId: 'food',
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    }));
    txs.push({ id: 'outlier', amountMinor: 90_000, categoryId: 'food', date: '2026-01-20' });

    const anomalies = detectAnomalies(txs);
    expect(anomalies[0]!.transactionId).toBe('outlier');
    expect(anomalies[0]!.score).toBeGreaterThan(3.5);
  });

  it('stays quiet when there is too little history to judge', () => {
    const few: TransactionLike[] = [
      { id: '1', amountMinor: 1_000, categoryId: 'food', date: '2026-01-01' },
      { id: '2', amountMinor: 99_000, categoryId: 'food', date: '2026-01-02' },
    ];
    expect(detectAnomalies(few)).toEqual([]);
  });
});
