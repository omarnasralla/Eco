'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  CURRENCIES,
  convertMinor,
  currencyMeta,
  formatMoney,
  toMinorUnits,
} from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface MoneyInputProps {
  id: string;
  /** Raw text the user is typing, kept as a string so "1." is not destroyed. */
  amount: string;
  onAmountChange: (raw: string) => void;
  /** The currency the amount is being *entered* in. */
  entryCurrency: string;
  onCurrencyChange: (currency: string) => void;
  /** Called with the amount in minor units of `currency`, ready for the API. */
  onMinorChange: (amountMinor: number) => void;
  /** The account's base currency — what the entry is converted into. */
  baseCurrency: string;
  locale?: string;
  /** The rate date; a transaction converts at the rate on its own date. */
  date?: string;
  placeholder?: string;
}

/**
 * An amount field paired with the currency it is entered in.
 *
 * The preview underneath is advisory only. The authoritative conversion happens
 * server-side at write time, against the rate for the transaction's own date,
 * and is frozen onto the row — so this shows the user what to expect without
 * ever becoming the number of record.
 */
export function MoneyInput({
  id,
  amount,
  onAmountChange,
  entryCurrency,
  onCurrencyChange,
  onMinorChange,
  baseCurrency,
  locale = 'en-US',
  date,
  placeholder,
}: MoneyInputProps) {
  const differs = entryCurrency !== baseCurrency;

  const rates = useQuery({
    queryKey: queryKeys.exchangeRates(date),
    queryFn: () => fetchers.exchangeRates(date),
    // Rates move once a day; refetching them on every dialog open is waste.
    staleTime: 60 * 60 * 1000,
    enabled: differs,
  });

  const decimals = currencyMeta(entryCurrency).decimals;

  const preview = useMemo(() => {
    if (!differs) return null;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (!rates.data) return null;
    try {
      const minor = toMinorUnits(parsed, entryCurrency);
      const converted = convertMinor(minor, entryCurrency, baseCurrency, rates.data.rates);
      return formatMoney(converted, baseCurrency, { locale });
    } catch {
      // No rate for this pair — the API will refuse the write and say so.
      return null;
    }
  }, [amount, entryCurrency, baseCurrency, differs, rates.data, locale]);

  const emit = (raw: string, code: string) => {
    const parsed = Number(raw);
    onMinorChange(Number.isFinite(parsed) && parsed > 0 ? toMinorUnits(parsed, code) : 0);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id={id}
          // A decimal keypad on mobile, and the value is converted to minor
          // units before it leaves the form — floats never touch a balance.
          inputMode="decimal"
          className="flex-1"
          placeholder={placeholder ?? (decimals === 0 ? '0' : '0.00')}
          value={amount}
          onChange={(event) => {
            const raw = event.target.value;
            onAmountChange(raw);
            emit(raw, entryCurrency);
          }}
        />
        <Select
          value={entryCurrency}
          onValueChange={(next) => {
            onCurrencyChange(next);
            // Re-scale against the new currency: 5.00 is 500 minor units in USD
            // but 5 in LBP, and keeping the old figure would inflate it 100×.
            emit(amount, next);
          }}
        >
          <SelectTrigger aria-label="Currency" className="w-[7.5rem] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((item) => (
              <SelectItem key={item.code} value={item.code}>
                {item.code} {item.symbol}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {differs ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {preview ? (
            <>
              ≈ <span className="tabular font-medium text-foreground">{preview}</span> at today&apos;s
              rate, stored in {baseCurrency}
            </>
          ) : rates.isLoading ? (
            'Fetching the exchange rate…'
          ) : (
            `Converted to ${baseCurrency} when saved.`
          )}
        </p>
      ) : null}
    </div>
  );
}
