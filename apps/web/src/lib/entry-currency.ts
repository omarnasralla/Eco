'use client';

import { CURRENCIES } from '@eco/shared';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'eco:entry-currency';

/**
 * Storage is user-writable, and this value goes straight into a request body,
 * so anything not on the supported list is discarded rather than sent.
 */
function supported(code: string | null): code is string {
  return code !== null && CURRENCIES.some((item) => item.code === code);
}

/**
 * The currency the amount fields start in, remembered per browser.
 *
 * Someone in Riyadh reporting in dollars types riyals all day; making them
 * re-pick SAR on every entry is a tax on the common case. This is a
 * convenience only — nothing is stored on the server, and the base currency in
 * Settings still decides what totals are reported in.
 */
export function useEntryCurrency(
  baseCurrency: string,
): [string, (next: string, persist?: boolean) => void] {
  // Starts at the base currency so the server-rendered markup and the first
  // client render agree; the remembered value arrives in the effect below.
  const [currency, setCurrency] = useState(baseCurrency);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode, or storage disabled. The base currency is a fine answer.
    }
    setCurrency(supported(stored) ? stored : baseCurrency);
  }, [baseCurrency]);

  /**
   * `persist` is opt-out for a reason: editing an existing expense has to show
   * the currency that expense was entered in, and that is not a statement
   * about what the next new one should default to. Persisting it there let
   * opening one foreign-currency row silently redefine the default for
   * everything after it.
   */
  const remember = useCallback((next: string, persist = true) => {
    setCurrency(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice must never block making it.
    }
  }, []);

  return [currency, remember];
}
