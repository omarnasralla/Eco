import { OCCURRENCES_PER_YEAR, type Frequency } from '@eco/shared';
import {
  diffDays,
  monthOf,
  type IsoDate,
  type IsoMonth,
  startOfMonth,
  endOfMonth,
} from './date-utils';

export interface IncomeStreamLike {
  amountMinor: number;
  frequency: Frequency;
  startDate: IsoDate;
  endDate?: IsoDate | null;
  isActive?: boolean;
}

/**
 * Normalises any pay cadence to a monthly figure.
 *
 * Weekly and bi-weekly income is deliberately annualised (52 / 26 payments a
 * year, divided by 12) rather than treated as "4 weeks a month". Over a year
 * that difference is a full extra paycheque, and under-counting it makes every
 * downstream budget and forecast wrong in the same direction.
 */
export function toMonthlyMinor(amountMinor: number, frequency: Frequency): number {
  const perYear = OCCURRENCES_PER_YEAR[frequency];
  if (perYear === 0) return 0; // ONE_TIME contributes nothing to a run rate.
  return Math.round((amountMinor * perYear) / 12);
}

export function toAnnualMinor(amountMinor: number, frequency: Frequency): number {
  return Math.round(amountMinor * OCCURRENCES_PER_YEAR[frequency]);
}

/** True when the stream is live at any point during `month`. */
export function isActiveInMonth(stream: IncomeStreamLike, month: IsoMonth): boolean {
  if (stream.isActive === false) return false;
  const from = startOfMonth(month);
  const to = endOfMonth(month);
  if (stream.startDate > to) return false;
  if (stream.endDate && stream.endDate < from) return false;
  return true;
}

/**
 * Actual income expected in a given month, counting real payment dates.
 * ONE_TIME income lands only in the month it is dated; recurring income is
 * counted per occurrence so a 3-paycheque month shows as a 3-paycheque month.
 */
export function expectedIncomeInMonth(stream: IncomeStreamLike, month: IsoMonth): number {
  if (!isActiveInMonth(stream, month)) return 0;

  if (stream.frequency === 'ONE_TIME') {
    return monthOf(stream.startDate) === month ? stream.amountMinor : 0;
  }

  const windowStart = startOfMonth(month);
  const windowEnd = endOfMonth(month);
  const from = stream.startDate > windowStart ? stream.startDate : windowStart;
  const to = stream.endDate && stream.endDate < windowEnd ? stream.endDate : windowEnd;
  if (from > to) return 0;

  switch (stream.frequency) {
    case 'WEEKLY':
    case 'BIWEEKLY': {
      const step = stream.frequency === 'WEEKLY' ? 7 : 14;
      // Walk forward from the anchor date to count real pay dates in the window.
      const offset = diffDays(stream.startDate, from);
      const firstGap = offset <= 0 ? -offset : (step - (offset % step)) % step;
      const span = diffDays(from, to);
      if (firstGap > span) return 0;
      const occurrences = Math.floor((span - firstGap) / step) + 1;
      return stream.amountMinor * occurrences;
    }
    case 'MONTHLY':
      return stream.amountMinor;
    case 'QUARTERLY':
    case 'YEARLY': {
      // Paid in the anniversary months of the start date.
      const period = stream.frequency === 'QUARTERLY' ? 3 : 12;
      const startMonth = Number(stream.startDate.slice(5, 7));
      const thisMonth = Number(month.slice(5, 7));
      const startYear = Number(stream.startDate.slice(0, 4));
      const thisYear = Number(month.slice(0, 4));
      const monthsSince = (thisYear - startYear) * 12 + (thisMonth - startMonth);
      return monthsSince >= 0 && monthsSince % period === 0 ? stream.amountMinor : 0;
    }
    default:
      return 0;
  }
}

export function totalMonthlyIncomeMinor(streams: IncomeStreamLike[]): number {
  return streams.reduce(
    (sum, s) => (s.isActive === false ? sum : sum + toMonthlyMinor(s.amountMinor, s.frequency)),
    0,
  );
}

/**
 * Income stability, expressed as the coefficient of variation of monthly
 * totals.  A salaried user sits near 0; a freelancer with feast-and-famine
 * months sits above 0.4.  The forecaster widens its intervals accordingly.
 */
export function incomeVolatility(monthlyTotalsMinor: number[]): {
  volatility: number;
  label: 'STEADY' | 'VARIABLE' | 'IRREGULAR';
  averageMonthlyMinor: number;
} {
  const n = monthlyTotalsMinor.length;
  if (n === 0) return { volatility: 0, label: 'STEADY', averageMonthlyMinor: 0 };

  const mean = monthlyTotalsMinor.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return { volatility: 0, label: 'IRREGULAR', averageMonthlyMinor: 0 };

  const variance = monthlyTotalsMinor.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const volatility = Math.sqrt(variance) / mean;

  const label = volatility < 0.1 ? 'STEADY' : volatility < 0.35 ? 'VARIABLE' : 'IRREGULAR';
  return { volatility: round4(volatility), label, averageMonthlyMinor: Math.round(mean) };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
