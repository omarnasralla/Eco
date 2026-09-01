/**
 * Postgres `date` columns come back as JS Date objects pinned to UTC midnight.
 * The API speaks ISO date strings, so conversion happens at exactly these two
 * points and nowhere else — that is what keeps a rent payment out of the wrong
 * month for a user in UTC+13.
 */

export function toIsoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function requireIsoDate(value: Date | string): string {
  const iso = toIsoDate(value);
  if (!iso) throw new TypeError('Expected a date value');
  return iso;
}

/** ISO date string → UTC-midnight Date, for writing back to a `date` column. */
export function fromIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** "2026-07" → the Date representing 2026-07-01, how budgets key their month. */
export function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

export function dateToMonth(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 7) : value.toISOString().slice(0, 7);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
