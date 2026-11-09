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

/**
 * The calendar date and minute of the day on a user's own clock.
 *
 * For anything that has to happen at a local time — a 07:30 briefing is 04:30
 * UTC in Riyadh and 07:30 in London. An unknown zone falls back to UTC rather
 * than throwing: a typo in a profile must not stop every other user's job.
 */
export function localClock(timezone: string, at: Date = new Date()): { date: string; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return timezone === 'UTC' ? { date: at.toISOString().slice(0, 10), minutes: 0 } : localClock('UTC', at);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/** "07:30" → 450. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
