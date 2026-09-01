import { describe, expect, it } from 'vitest';
import {
  expectedIncomeInMonth,
  incomeVolatility,
  isActiveInMonth,
  toAnnualMinor,
  toMonthlyMinor,
  totalMonthlyIncomeMinor,
} from './income';

describe('toMonthlyMinor', () => {
  it('annualises weekly pay rather than assuming four weeks', () => {
    // 52 payments a year, not 48 — the difference is a whole extra paycheque.
    expect(toMonthlyMinor(50_000, 'WEEKLY')).toBe(216_667);
  });

  it('annualises bi-weekly pay across 26 payments', () => {
    expect(toMonthlyMinor(100_000, 'BIWEEKLY')).toBe(216_667);
  });

  it('passes monthly pay through unchanged', () => {
    expect(toMonthlyMinor(500_000, 'MONTHLY')).toBe(500_000);
  });

  it('spreads quarterly and yearly pay across the year', () => {
    expect(toMonthlyMinor(300_000, 'QUARTERLY')).toBe(100_000);
    expect(toMonthlyMinor(1_200_000, 'YEARLY')).toBe(100_000);
  });

  it('excludes one-time income from the run rate', () => {
    expect(toMonthlyMinor(500_000, 'ONE_TIME')).toBe(0);
    expect(toAnnualMinor(500_000, 'ONE_TIME')).toBe(0);
  });
});

describe('isActiveInMonth', () => {
  const stream = { amountMinor: 100, frequency: 'MONTHLY' as const, startDate: '2026-03-15', endDate: '2026-08-10' };

  it('includes the partial first and last months', () => {
    expect(isActiveInMonth(stream, '2026-03')).toBe(true);
    expect(isActiveInMonth(stream, '2026-08')).toBe(true);
  });

  it('excludes months outside the window', () => {
    expect(isActiveInMonth(stream, '2026-02')).toBe(false);
    expect(isActiveInMonth(stream, '2026-09')).toBe(false);
  });

  it('respects an explicit inactive flag', () => {
    expect(isActiveInMonth({ ...stream, isActive: false }, '2026-05')).toBe(false);
  });
});

describe('expectedIncomeInMonth', () => {
  it('counts a three-paycheque month for weekly pay', () => {
    // Fridays in May 2026 starting 2026-05-01: 1, 8, 15, 22, 29 → five payments.
    const weekly = { amountMinor: 50_000, frequency: 'WEEKLY' as const, startDate: '2026-05-01' };
    expect(expectedIncomeInMonth(weekly, '2026-05')).toBe(250_000);
  });

  it('counts bi-weekly pay dates from the anchor date', () => {
    const biweekly = { amountMinor: 100_000, frequency: 'BIWEEKLY' as const, startDate: '2026-01-02' };
    // 2026-01-02, 01-16, 01-30 → three payments in January.
    expect(expectedIncomeInMonth(biweekly, '2026-01')).toBe(300_000);
    // 2026-02-13, 02-27 → two payments in February.
    expect(expectedIncomeInMonth(biweekly, '2026-02')).toBe(200_000);
  });

  it('lands one-time income only in its own month', () => {
    const bonus = { amountMinor: 800_000, frequency: 'ONE_TIME' as const, startDate: '2026-04-20' };
    expect(expectedIncomeInMonth(bonus, '2026-04')).toBe(800_000);
    expect(expectedIncomeInMonth(bonus, '2026-05')).toBe(0);
  });

  it('pays quarterly income only in anniversary months', () => {
    const dividend = { amountMinor: 150_000, frequency: 'QUARTERLY' as const, startDate: '2026-02-10' };
    expect(expectedIncomeInMonth(dividend, '2026-02')).toBe(150_000);
    expect(expectedIncomeInMonth(dividend, '2026-03')).toBe(0);
    expect(expectedIncomeInMonth(dividend, '2026-05')).toBe(150_000);
    expect(expectedIncomeInMonth(dividend, '2026-11')).toBe(150_000);
  });

  it('stops paying after the end date', () => {
    const contract = {
      amountMinor: 400_000,
      frequency: 'MONTHLY' as const,
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    };
    expect(expectedIncomeInMonth(contract, '2026-03')).toBe(400_000);
    expect(expectedIncomeInMonth(contract, '2026-04')).toBe(0);
  });
});

describe('totalMonthlyIncomeMinor', () => {
  it('sums normalised streams and skips inactive ones', () => {
    const total = totalMonthlyIncomeMinor([
      { amountMinor: 500_000, frequency: 'MONTHLY', startDate: '2026-01-01' },
      { amountMinor: 100_000, frequency: 'BIWEEKLY', startDate: '2026-01-01' },
      { amountMinor: 900_000, frequency: 'MONTHLY', startDate: '2026-01-01', isActive: false },
    ]);
    expect(total).toBe(500_000 + 216_667);
  });
});

describe('incomeVolatility', () => {
  it('labels a fixed salary as steady', () => {
    const result = incomeVolatility([500_000, 500_000, 500_000, 500_000]);
    expect(result.volatility).toBe(0);
    expect(result.label).toBe('STEADY');
    expect(result.averageMonthlyMinor).toBe(500_000);
  });

  it('labels swinging freelance income as irregular', () => {
    expect(incomeVolatility([100_000, 900_000, 200_000, 800_000]).label).toBe('IRREGULAR');
  });

  it('handles an empty history without dividing by zero', () => {
    expect(incomeVolatility([])).toEqual({ volatility: 0, label: 'STEADY', averageMonthlyMinor: 0 });
    expect(incomeVolatility([0, 0]).label).toBe('IRREGULAR');
  });
});
