import { describe, expect, it } from 'vitest';
import {
  affordabilityCheck,
  completeMonthsOnly,
  dampedTrendForecast,
  forecastCashFlow,
  forecastSeries,
  holtLinear,
  residualStdDev,
} from './forecast';

const flat = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map((month) => ({
  month,
  valueMinor: 500_000,
}));

const rising = flat.map((p, i) => ({ month: p.month, valueMinor: 300_000 + i * 20_000 }));

describe('holtLinear', () => {
  it('holds level and zero trend on a flat series', () => {
    const { level, trend, forecast } = holtLinear([100, 100, 100, 100], { horizon: 3 });
    expect(level).toBeCloseTo(100, 5);
    expect(trend).toBeCloseTo(0, 5);
    expect(forecast.every((v) => Math.abs(v - 100) < 1e-6)).toBe(true);
  });

  it('picks up a linear trend', () => {
    const { trend } = holtLinear([100, 110, 120, 130, 140], { horizon: 1 });
    expect(trend).toBeGreaterThan(5);
  });

  it('degrades gracefully on empty and single-point input', () => {
    expect(holtLinear([], { horizon: 2 }).forecast).toEqual([0, 0]);
    expect(holtLinear([42], { horizon: 2 }).forecast).toEqual([42, 42]);
  });
});

describe('dampedTrendForecast', () => {
  it('grows more slowly than an undamped extrapolation', () => {
    const series = [100, 120, 140, 160, 180];
    const damped = dampedTrendForecast(series, 12, 0.85);
    const { forecast: undamped } = holtLinear(series, { horizon: 12 });
    expect(damped[11]!).toBeLessThan(undamped[11]!);
  });
});

describe('residualStdDev', () => {
  it('is zero for a perfect fit', () => {
    expect(residualStdDev([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('forecastSeries', () => {
  it('projects a flat series flat with a tight interval', () => {
    const { points, confidence } = forecastSeries(flat, { horizon: 3 });
    expect(points).toHaveLength(3);
    expect(points[0]!.month).toBe('2026-07');
    expect(points[0]!.valueMinor).toBeCloseTo(500_000, -3);
    expect(points[0]!.lowerBoundMinor).toBe(points[0]!.upperBoundMinor);
    expect(confidence).toBeGreaterThan(0.5);
  });

  it('widens the interval with the horizon', () => {
    const { points } = forecastSeries(
      flat.map((p, i) => ({ ...p, valueMinor: p.valueMinor + (i % 2 ? 50_000 : -50_000) })),
      { horizon: 6 },
    );
    const spread = (i: number) => points[i]!.upperBoundMinor - points[i]!.lowerBoundMinor;
    expect(spread(5)).toBeGreaterThan(spread(0));
  });

  it('follows an upward trend', () => {
    const { points } = forecastSeries(rising, { horizon: 3 });
    expect(points[0]!.valueMinor).toBeGreaterThan(rising.at(-1)!.valueMinor);
  });

  it('applies seasonal indices multiplicatively', () => {
    const indices = Array(12).fill(1);
    indices[6] = 1.5; // July
    const { points } = forecastSeries(flat, { horizon: 1, seasonalIndices: indices });
    expect(points[0]!.month).toBe('2026-07');
    expect(points[0]!.valueMinor).toBeCloseTo(750_000, -4);
  });

  it('warns on thin history and never returns a negative projection', () => {
    const { points, warnings } = forecastSeries([{ month: '2026-01', valueMinor: 1_000 }], { horizon: 2 });
    expect(warnings.join(' ')).toMatch(/three months/);
    expect(points.every((p) => p.valueMinor >= 0 && p.lowerBoundMinor >= 0)).toBe(true);
  });

  it('returns nothing useful with no history at all', () => {
    const { points, confidence } = forecastSeries([], { horizon: 3 });
    expect(points).toEqual([]);
    expect(confidence).toBe(0);
  });
});

describe('forecastCashFlow', () => {
  it('compounds the running balance month over month', () => {
    const { points } = forecastCashFlow({
      incomeHistory: flat,
      expenseHistory: flat.map((p) => ({ ...p, valueMinor: 400_000 })),
      openingBalanceMinor: 1_000_000,
      horizon: 3,
    });

    expect(points).toHaveLength(3);
    expect(points[0]!.projectedNetMinor).toBeCloseTo(100_000, -3);
    expect(points[2]!.projectedBalanceMinor).toBeGreaterThan(points[0]!.projectedBalanceMinor);
    expect(points.every((p) => !p.isShortfall)).toBe(true);
  });

  it('flags a shortfall when expenses outrun income', () => {
    const { points } = forecastCashFlow({
      incomeHistory: flat.map((p) => ({ ...p, valueMinor: 300_000 })),
      expenseHistory: flat.map((p) => ({ ...p, valueMinor: 450_000 })),
      openingBalanceMinor: 200_000,
      horizon: 6,
    });
    expect(points.some((p) => p.isShortfall)).toBe(true);
    expect(points.at(-1)!.projectedBalanceMinor).toBeLessThan(0);
  });
});

describe('affordabilityCheck', () => {
  const forecast = forecastCashFlow({
    incomeHistory: flat,
    expenseHistory: flat.map((p) => ({ ...p, valueMinor: 400_000 })),
    openingBalanceMinor: 1_000_000,
    horizon: 6,
  }).points;

  it('approves a purchase the projected balance covers', () => {
    const result = affordabilityCheck(forecast, 500_000, '2026-12');
    expect(result.affordable).toBe(true);
    expect(result.shortfallMinor).toBe(0);
    expect(result.monthsOfBufferRemaining).toBeGreaterThan(0);
  });

  it('quantifies the gap when it does not', () => {
    const result = affordabilityCheck(forecast, 5_000_000, '2026-12');
    expect(result.affordable).toBe(false);
    expect(result.shortfallMinor).toBeGreaterThan(0);
  });
});


describe('completeMonthsOnly', () => {
  const history = [
    { month: '2026-06', valueMinor: 300_000 },
    { month: '2026-07', valueMinor: 310_000 },
    { month: '2026-08', valueMinor: 305_000 },
    { month: '2026-09', valueMinor: 1_457 }, // one day into the month
  ];

  it('drops the month currently in progress', () => {
    expect(completeMonthsOnly(history, '2026-09-01').map((p) => p.month)).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  it('drops it on the last day of the month too — it is still partial', () => {
    expect(completeMonthsOnly(history, '2026-09-30')).toHaveLength(3);
  });

  it('keeps a month once it is genuinely in the past', () => {
    expect(completeMonthsOnly(history, '2026-10-01')).toHaveLength(4);
  });

  it('returns nothing when the only month is the current one', () => {
    expect(completeMonthsOnly([{ month: '2026-09', valueMinor: 1_457 }], '2026-09-15')).toEqual([]);
  });

  it('stops a partial final month from dragging the projection down', () => {
    // The bug this guards: one day of spending read as a whole month reads as
    // a collapse in spending and pulls the whole trend with it. The damped
    // model here degrades less violently than the seasonal fit in the Python
    // service, so the test asserts the relationship rather than a threshold.
    const withPartial = forecastSeries(history, { horizon: 3 });
    const clean = forecastSeries(completeMonthsOnly(history, '2026-09-01'), { horizon: 3 });

    // Cleaned history stays near the real ~£3,050/month level.
    expect(clean.points[2]!.valueMinor).toBeGreaterThan(250_000);
    // The polluted series is dragged far below it.
    expect(withPartial.points[2]!.valueMinor).toBeLessThan(
      clean.points[2]!.valueMinor * 0.7,
    );
  });
});
