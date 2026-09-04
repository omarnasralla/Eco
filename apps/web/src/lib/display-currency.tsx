'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { convertMinor, formatMoney } from '@eco/shared';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-provider';

const STORAGE_KEY = 'eco:display-currency';

interface DisplayCurrency {
  /** What figures are being shown in right now. */
  currency: string;
  /** The base currency every stored aggregate is denominated in. */
  baseCurrency: string;
  /** The other currency to flip to, when one is configured. */
  secondaryCurrency: string | null;
  /** True when there is a second currency to flip between. */
  canFlip: boolean;
  flip: () => void;
  locale: string;
  /**
   * Formats an amount, converting it from the currency it is actually in.
   *
   * `from` defaults to the base currency because that is what almost every
   * figure in the API is denominated in. Amounts carrying their own currency —
   * a bill, a goal, an expense as entered — must pass it.
   */
  format: (minor: number, from?: string) => string;
  /**
   * The amount restated in whatever currency it can honestly be shown in —
   * the display one when a rate is available, otherwise the one it is already
   * in. Callers that need formatting options of their own use this and format
   * the result themselves.
   */
  convert: (minor: number, from?: string) => { minor: number; currency: string };
}

const Ctx = createContext<DisplayCurrency | null>(null);

export function DisplayCurrencyProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const baseCurrency = user?.currency ?? 'USD';
  const secondaryCurrency = user?.secondaryCurrency ?? null;
  const locale = user?.locale ?? 'en-US';

  // Default to the secondary currency: it is the money actually being handed
  // over, and someone who has bothered to set one is telling us they think in
  // it. The base is one click away and the choice is remembered.
  const [currency, setCurrency] = useState(baseCurrency);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage disabled. The default below is a fine answer.
    }
    const allowed = [baseCurrency, secondaryCurrency].filter(Boolean) as string[];
    // A remembered value that is no longer one of the two configured
    // currencies is stale, not a preference.
    setCurrency(stored && allowed.includes(stored) ? stored : (secondaryCurrency ?? baseCurrency));
  }, [baseCurrency, secondaryCurrency]);

  const flip = useCallback(() => {
    setCurrency((current) => {
      if (!secondaryCurrency) return current;
      const next = current === baseCurrency ? secondaryCurrency : baseCurrency;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not remembering it must never stop the flip itself.
      }
      return next;
    });
  }, [baseCurrency, secondaryCurrency]);

  // One rate table for the whole app. Rates move daily at most, so this is
  // cached hard rather than refetched per screen.
  const rates = useQuery({
    queryKey: ['currency', 'rates'],
    queryFn: () => api.get<{ rates: Record<string, number> }>('/currency/rates'),
    staleTime: 60 * 60 * 1000,
    enabled: Boolean(secondaryCurrency),
  });

  const convert = useCallback(
    (minor: number, from: string = baseCurrency) => {
      if (from === currency) return { minor, currency };

      const table = rates.data?.rates;
      // Never relabel: without a usable rate, report the amount in the currency
      // it is genuinely in. A figure under the wrong symbol is a wrong figure,
      // and one that looks entirely plausible.
      if (!table) return { minor, currency: from };
      try {
        return { minor: convertMinor(minor, from, currency, table), currency };
      } catch {
        return { minor, currency: from };
      }
    },
    [baseCurrency, currency, rates.data],
  );

  const format = useCallback(
    (minor: number, from?: string) => {
      const shown = convert(minor, from);
      return formatMoney(shown.minor, shown.currency, { locale });
    },
    [convert, locale],
  );

  const value = useMemo(
    () => ({
      currency,
      baseCurrency,
      secondaryCurrency,
      canFlip: Boolean(secondaryCurrency && secondaryCurrency !== baseCurrency),
      flip,
      locale,
      format,
      convert,
    }),
    [currency, baseCurrency, secondaryCurrency, flip, locale, format, convert],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * A `moneyFormatter`-shaped function that converts before formatting.
 *
 * Charts read raw base-currency minor units, so handing them a formatter built
 * from the display currency alone would print a dollar figure under a riyal
 * symbol — the amount unchanged, only the label a lie.
 */
export function useChartMoney(): (minor: number, compact?: boolean) => string {
  const { convert, locale } = useDisplayCurrency();
  return useCallback(
    (minor: number, compact = false) => {
      const shown = convert(minor);
      return formatMoney(shown.minor, shown.currency, { locale, compact });
    },
    [convert, locale],
  );
}

export function useDisplayCurrency(): DisplayCurrency {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDisplayCurrency must be used inside DisplayCurrencyProvider');
  return ctx;
}
