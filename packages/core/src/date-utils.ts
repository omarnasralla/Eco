/**
 * Calendar helpers.  Everything here works on `YYYY-MM-DD` / `YYYY-MM` strings
 * in UTC rather than Date objects, because a "month" in personal finance is a
 * label, not an instant — and passing Dates across a timezone boundary is how
 * you end up filing January's rent under December.
 */

import type { Frequency } from '@eco/shared';

export type IsoDate = string; // YYYY-MM-DD
export type IsoMonth = string; // YYYY-MM

export function parseIsoDate(date: IsoDate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new TypeError(`Invalid ISO date: "${date}"`);
  return { y, m, d };
}

export function toIsoDate(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function monthOf(date: IsoDate): IsoMonth {
  return date.slice(0, 7);
}

export function parseIsoMonth(month: IsoMonth): { y: number; m: number } {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) throw new TypeError(`Invalid ISO month: "${month}"`);
  return { y, m };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonths(month: IsoMonth, delta: number): IsoMonth {
  const { y, m } = parseIsoMonth(month);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

export function addDays(date: IsoDate, delta: number): IsoDate {
  const { y, m, d } = parseIsoDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function diffDays(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86_400_000);
}

export function diffMonths(from: IsoMonth, to: IsoMonth): number {
  const a = parseIsoMonth(from);
  const b = parseIsoMonth(to);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

export function startOfMonth(month: IsoMonth): IsoDate {
  return `${month}-01`;
}

export function endOfMonth(month: IsoMonth): IsoDate {
  const { y, m } = parseIsoMonth(month);
  return toIsoDate(y, m, daysInMonth(y, m));
}

/**
 * Resolves a "due on the Nth" rule against a specific month, clamping to the
 * last day when the month is short — the 31st of February becomes the 28th/29th.
 */
export function dueDateInMonth(month: IsoMonth, dayOfMonth: number): IsoDate {
  const { y, m } = parseIsoMonth(month);
  return toIsoDate(y, m, Math.min(dayOfMonth, daysInMonth(y, m)));
}

/** The next occurrence of a monthly due day, on or after `today`. */
export function nextDueDate(today: IsoDate, dayOfMonth: number): IsoDate {
  const thisMonth = monthOf(today);
  const candidate = dueDateInMonth(thisMonth, dayOfMonth);
  return candidate >= today ? candidate : dueDateInMonth(addMonths(thisMonth, 1), dayOfMonth);
}

/** Inclusive list of months spanning two dates, oldest first. */
export function monthRange(from: IsoDate, to: IsoDate): IsoMonth[] {
  const out: IsoMonth[] = [];
  let cursor = monthOf(from);
  const last = monthOf(to);
  // Guard against an inverted range rather than looping forever.
  if (diffMonths(cursor, last) < 0) return out;
  while (cursor <= last) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/**
 * The next occurrence of a repeating charge, strictly after `last`, on or
 * after `from`. Null when the frequency does not repeat.
 *
 * `nextDueDate` handles the monthly-on-the-Nth case and nothing else; a weekly
 * subscription projected through it lands a month out, which is wrong in the
 * direction that matters — the user is told a bill is far away when it is due
 * in days.
 *
 * Weekly and biweekly step in days from the last occurrence, so the weekday is
 * preserved. The month-based ones step in months and clamp, so a charge on the
 * 31st falls on the 30th or 28th rather than skipping those months entirely.
 */
export function nextOccurrence(params: {
  last: IsoDate;
  frequency: Frequency;
  from: IsoDate;
}): IsoDate | null {
  const { last, frequency, from } = params;
  if (frequency === 'ONE_TIME') return null;

  if (frequency === 'WEEKLY' || frequency === 'BIWEEKLY') {
    const step = frequency === 'WEEKLY' ? 7 : 14;
    const gap = diffDays(last, from);
    // Always at least one step past `last`, even when `from` is behind it.
    const steps = gap <= 0 ? 1 : Math.ceil(gap / step) || 1;
    return addDays(last, steps * step);
  }

  const period = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12;
  const dayOfMonth = parseIsoDate(last).d;
  let cursor = monthOf(last);
  // Bounded: twelve years of steps is far past any date a user is looking at,
  // and a loop with no ceiling here would hang the request rather than fail it.
  for (let i = 0; i < 144; i += 1) {
    cursor = addMonths(cursor, period);
    const candidate = dueDateInMonth(cursor, dayOfMonth);
    if (candidate > last && candidate >= from) return candidate;
  }
  return null;
}

/** Weekday index for an ISO date: 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: IsoDate): number {
  const { y, m, d } = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
