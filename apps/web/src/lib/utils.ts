import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges Tailwind classes, with later utilities winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "2026-09-01" → "1 Sep 2026". Parsed as UTC so the day never shifts. */
export function formatDate(iso: string, locale = 'en-GB'): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-09" → "September 2026". */
export function formatMonth(month: string, locale = 'en-GB'): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-09" → "Sep" — for chart axes, where space is scarce. */
export function shortMonth(month: string, locale = 'en-GB'): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(locale, {
    month: 'short',
    timeZone: 'UTC',
  });
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** "in 3 days" / "today" / "2 days ago" — for due dates. */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
