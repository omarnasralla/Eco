'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'eco:selected-month';

/** `YYYY-MM` for the month containing today. */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year!, (m ?? 1) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/** First and last day of a `YYYY-MM`, as ISO dates, for a date-range filter. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, which avoids having
  // to know which months have 30, 31 or 28 days.
  const last = new Date(Date.UTC(year!, m!, 0));
  return { from: `${month}-01`, to: last.toISOString().slice(0, 10) };
}

/**
 * The month the app is currently looking at, shared across screens.
 *
 * Kept in localStorage rather than in each page's own state so that moving
 * back to August on Expenses and then opening Budgets shows August too —
 * otherwise "show me last month" means finding the arrows again on every
 * screen, and the two views silently disagree about which month you mean.
 *
 * Reads happen after mount. Next renders these pages on the server, where
 * localStorage does not exist, and seeding state from it directly makes the
 * first client render disagree with the server's — so it starts on the current
 * month and corrects itself immediately.
 */
export function useSelectedMonth(): [string, (month: string) => void] {
  const [month, setMonthState] = useState(currentMonth);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && /^\d{4}-\d{2}$/.test(stored)) setMonthState(stored);
    } catch {
      // Private browsing, or site data blocked. The current month is a fine
      // answer and nothing here is worth failing a page render over.
    }
  }, []);

  const setMonth = useCallback((next: string) => {
    setMonthState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // As above: remembering is a convenience, not a requirement.
    }
  }, []);

  return [month, setMonth];
}
