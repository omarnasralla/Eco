import { describe, expect, it } from 'vitest';
import { formatWorkTime, hourlyRateMinor, workHoursFor } from './work-time';

describe('hourlyRateMinor', () => {
  it('annualises the month over 52 weeks', () => {
    // 4,000/month × 12 = 48,000/year; 40 h × 52 = 2,080 h → 23.08/h.
    expect(hourlyRateMinor(400_000, 40)).toBe(2_308);
  });

  it('refuses to state a rate without hours or income', () => {
    expect(hourlyRateMinor(400_000, null)).toBeNull();
    expect(hourlyRateMinor(400_000, 0)).toBeNull();
    expect(hourlyRateMinor(0, 40)).toBeNull();
  });
});

describe('workHoursFor', () => {
  it('divides the amount by the rate', () => {
    expect(workHoursFor(6_000, 2_000)).toBe(3);
  });

  it('is null without a rate', () => {
    expect(workHoursFor(6_000, null)).toBeNull();
  });
});

describe('formatWorkTime', () => {
  it('states short amounts in minutes, rounded to five past ten', () => {
    expect(formatWorkTime(0.1, 40)).toBe('6 min');
    expect(formatWorkTime(0.58, 40)).toBe('35 min');
    expect(formatWorkTime(0.005, 40)).toBe('under a minute');
  });

  it('uses hours within a working day', () => {
    expect(formatWorkTime(6, 40)).toBe('6 h');
    expect(formatWorkTime(2.46, 40)).toBe('2.5 h');
    // 59.7 minutes is an hour, not "60 min".
    expect(formatWorkTime(0.995, 40)).toBe('1 h');
  });

  it('counts days as fifths of the user’s own week', () => {
    expect(formatWorkTime(12, 40)).toBe('1.5 days');
    expect(formatWorkTime(8, 40)).toBe('1 day');
    // A 30-hour week has 6-hour days.
    expect(formatWorkTime(12, 30)).toBe('2 days');
  });

  it('moves to weeks, then months', () => {
    expect(formatWorkTime(80, 40)).toBe('2 weeks');
    expect(formatWorkTime(40 * 26, 40)).toBe('6 months');
  });
});
