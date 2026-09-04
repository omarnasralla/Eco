import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  diffMonths,
  dueDateInMonth,
  endOfMonth,
  monthOf,
  monthRange,
  nextDueDate,
  nextOccurrence,
  startOfMonth,
  weekdayOf,
} from './date-utils';

describe('addMonths', () => {
  it('rolls over year boundaries in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-02', -3)).toBe('2025-11');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
  });
});

describe('addDays and diffDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts whole days between dates', () => {
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(30);
    expect(diffDays('2026-01-31', '2026-01-01')).toBe(-30);
    expect(diffDays('2026-01-01', '2026-01-01')).toBe(0);
  });
});

describe('daysInMonth', () => {
  it('handles leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(1900, 2)).toBe(28); // divisible by 100, not 400
  });
});

describe('dueDateInMonth', () => {
  it('clamps a late due day to the end of a short month', () => {
    expect(dueDateInMonth('2026-02', 31)).toBe('2026-02-28');
    expect(dueDateInMonth('2028-02', 31)).toBe('2028-02-29');
    expect(dueDateInMonth('2026-04', 31)).toBe('2026-04-30');
    expect(dueDateInMonth('2026-01', 15)).toBe('2026-01-15');
  });
});

describe('nextDueDate', () => {
  it('returns this month when the day is still ahead', () => {
    expect(nextDueDate('2026-06-10', 15)).toBe('2026-06-15');
  });

  it('returns today when the due day is today', () => {
    expect(nextDueDate('2026-06-15', 15)).toBe('2026-06-15');
  });

  it('rolls into next month once the day has passed', () => {
    expect(nextDueDate('2026-06-20', 15)).toBe('2026-07-15');
    expect(nextDueDate('2026-12-20', 15)).toBe('2027-01-15');
  });

  it('clamps when next month is shorter', () => {
    expect(nextDueDate('2026-01-31', 30)).toBe('2026-02-28');
  });
});

describe('month helpers', () => {
  it('derives month bounds', () => {
    expect(monthOf('2026-07-14')).toBe('2026-07');
    expect(startOfMonth('2026-07')).toBe('2026-07-01');
    expect(endOfMonth('2026-07')).toBe('2026-07-31');
    expect(endOfMonth('2026-02')).toBe('2026-02-28');
  });

  it('counts months between labels', () => {
    expect(diffMonths('2026-01', '2026-12')).toBe(11);
    expect(diffMonths('2026-12', '2026-01')).toBe(-11);
  });

  it('lists an inclusive month range and returns nothing for an inverted one', () => {
    expect(monthRange('2026-01-15', '2026-04-02')).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    expect(monthRange('2026-04-01', '2026-01-01')).toEqual([]);
  });
});

describe('weekdayOf', () => {
  it('returns a UTC weekday index', () => {
    expect(weekdayOf('2026-06-14')).toBe(0); // Sunday
    expect(weekdayOf('2026-06-15')).toBe(1); // Monday
  });
});

describe('nextOccurrence', () => {
  it('never returns the occurrence it was given', () => {
    // The charge landed today; today is not still upcoming.
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'MONTHLY', from: '2026-09-04' })).toBe(
      '2026-10-04',
    );
  });

  it('steps weekly and biweekly in days, preserving the weekday', () => {
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'WEEKLY', from: '2026-09-04' })).toBe(
      '2026-09-11',
    );
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'BIWEEKLY', from: '2026-09-04' })).toBe(
      '2026-09-18',
    );
    // Skips over as many whole steps as it takes to reach `from`.
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'WEEKLY', from: '2026-09-30' })).toBe(
      '2026-10-02',
    );
  });

  it('clamps a day that a shorter month does not have', () => {
    expect(nextOccurrence({ last: '2026-01-31', frequency: 'MONTHLY', from: '2026-02-01' })).toBe(
      '2026-02-28',
    );
  });

  it('steps quarterly and yearly', () => {
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'QUARTERLY', from: '2026-09-05' })).toBe(
      '2026-12-04',
    );
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'YEARLY', from: '2026-09-05' })).toBe(
      '2027-09-04',
    );
  });

  it('has no next occurrence for a one-off', () => {
    expect(nextOccurrence({ last: '2026-09-04', frequency: 'ONE_TIME', from: '2026-09-04' })).toBeNull();
  });
});
