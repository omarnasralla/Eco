/**
 * Prices restated as the time it takes to earn them.
 *
 * "$180" is abstract; "a day and a half of work" is not. The figure is only as
 * good as its inputs, so nothing here guesses: with no hours or no income the
 * rate is null and the caller shows nothing, rather than a confident number
 * built on an assumed 40-hour week.
 */

/** Weeks in a year. Annualised rather than "4 weeks a month", for the same
 *  reason toMonthlyMinor does it: four weeks undercounts a year by a month. */
const WEEKS_PER_YEAR = 52;

/** A working week is taken as five days when a figure is restated in days. */
const DAYS_PER_WORK_WEEK = 5;

/** Minor units earned per hour worked, or null when that cannot be stated. */
export function hourlyRateMinor(
  monthlyIncomeMinor: number,
  hoursPerWeek: number | null | undefined,
): number | null {
  if (!hoursPerWeek || hoursPerWeek <= 0 || monthlyIncomeMinor <= 0) return null;
  return Math.round((monthlyIncomeMinor * 12) / (hoursPerWeek * WEEKS_PER_YEAR));
}

/** Hours of work an amount costs; null without a rate. */
export function workHoursFor(amountMinor: number, hourlyMinor: number | null): number | null {
  if (!hourlyMinor || hourlyMinor <= 0) return null;
  return amountMinor / hourlyMinor;
}

/**
 * A duration of work in the largest unit that reads naturally.
 *
 * Days and weeks are *working* ones — a day is a fifth of the user's own week,
 * not 24 hours — because "3 days" of a 40-hour week means three shifts, which
 * is what a person actually pictures.
 */
export function formatWorkTime(hours: number, hoursPerWeek: number): string {
  if (hours <= 0) return '0 min';

  const minutes = hours * 60;
  if (minutes < 1) return 'under a minute';
  if (minutes < 59.5) {
    // Nearest five once it is past ten: "35 min" claims no false precision.
    const rounded = minutes < 10 ? Math.round(minutes) : Math.round(minutes / 5) * 5;
    return `${rounded} min`;
  }

  const hoursPerDay = hoursPerWeek / DAYS_PER_WORK_WEEK;
  if (hours < hoursPerDay) return `${short(hours)} h`;

  if (hours < hoursPerWeek) return plural(short(hours / hoursPerDay), 'day');

  const weeks = hours / hoursPerWeek;
  if (weeks < 9) return plural(short(weeks), 'week');

  return plural(short((weeks * 12) / WEEKS_PER_YEAR), 'month');
}

/** One decimal under ten, whole numbers above; a trailing ".0" is dropped. */
function short(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function plural(count: string, unit: string): string {
  return `${count} ${unit}${count === '1' ? '' : 's'}`;
}
