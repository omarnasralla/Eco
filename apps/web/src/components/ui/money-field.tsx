'use client';

import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import {
  CURRENCIES,
  convertMinor,
  currencyMeta,
  formatMoney,
  toMinorUnits,
  type ExchangeRateDto,
} from '@eco/shared';
import { api } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Today's rates, fetched once and shared by every money field on the page.
 *
 * This drives the preview only. The figure that is stored is computed by the
 * API at the transaction's own date, which is the number that must be right —
 * see `CurrencyService.convert`. Previewing from a client-side rate keeps
 * typing instant without a request per keystroke, and the two agree for
 * anything dated today, which is nearly every entry.
 */
export function useExchangeRates() {
  return useQuery({
    queryKey: ['currency', 'rates'],
    queryFn: () => api.get<ExchangeRateDto>('/currency/rates'),
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });
}

/**
 * Converts for display, returning null rather than throwing when a rate is
 * missing — a figure that cannot be computed should go quiet, not break the
 * screen around it. Exported because any list that totals amounts held in
 * different currencies needs it: adding a riyal balance to a dollar one gives
 * a number that is money in neither.
 */
export function safeConvert(
  minor: number,
  from: string,
  to: string,
  rates: Record<string, number> | undefined,
): number | null {
  if (from === to) return minor;
  if (!rates) return null;
  try {
    return convertMinor(minor, from, to, rates);
  } catch {
    return null;
  }
}

/**
 * An amount paired with the currency it was entered in.
 *
 * Someone living in Riyadh whose reports are in dollars types what the receipt
 * says — 87.50 SAR — and sees what it will land as. The pairing is the point:
 * an amount without its currency is not money, and asking a user to convert in
 * their head before typing is asking them to do the computer's job.
 */
export function MoneyField({
  id,
  label,
  amount,
  onAmountChange,
  currency,
  onCurrencyChange,
  baseCurrency,
  locale,
  error,
  hint,
  placeholder = '0.00',
  allowNegative = false,
  autoFocus = false,
}: {
  id?: string;
  label: string;
  /** The raw text the user typed, kept as text so "3." is a valid keystroke. */
  amount: string;
  /** Receives the text and the parsed minor units (0 when unparseable). */
  onAmountChange: (raw: string, minorUnits: number) => void;
  currency: string;
  onCurrencyChange: (currency: string) => void;
  /** What totals are reported in — the user's base currency. */
  baseCurrency: string;
  locale: string;
  error?: string;
  hint?: string;
  placeholder?: string;
  allowNegative?: boolean;
  /**
   * Opens the keypad as soon as the field mounts. Worth setting when the field
   * is the first thing in a dialog the user opened *in order to* type a number:
   * it removes a tap, and on a phone that tap is the difference between logging
   * a coffee at the counter and meaning to later.
   */
  autoFocus?: boolean;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const rates = useExchangeRates();

  const parsed = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && (allowNegative || parsed > 0);
  const minorUnits = valid ? toMinorUnits(parsed, currency) : 0;
  const converted =
    valid && currency !== baseCurrency
      ? safeConvert(minorUnits, currency, baseCurrency, rates.data?.rates)
      : null;

  /**
   * Only currencies the server can actually convert are selectable.
   *
   * Which ones those are depends on the configured rate provider — the ECB
   * feed, for instance, publishes no Gulf currencies at all. Offering SAR and
   * then refusing the save is a worse answer than showing it greyed out with
   * the reason, so the list is filtered by what came back from `/currency/rates`
   * rather than by what the app knows how to format. Until the rates arrive
   * nothing is disabled: a slow request must not make the picker look broken.
   */
  const quoted = rates.data ? new Set([...Object.keys(rates.data.rates), baseCurrency]) : null;
  const unavailable = (code: string) => quoted !== null && !quoted.has(code);

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={fieldId}
          // A decimal keypad on mobile, and the value is converted to minor
          // units before it leaves the form — floats never touch a balance.
          inputMode="decimal"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opt-in, and only
          // used where the field is the reason the dialog was opened.
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={amount}
          className="flex-1"
          onChange={(event) => {
            const raw = event.target.value;
            const next = Number(raw);
            const usable =
              raw.trim() !== '' && Number.isFinite(next) && (allowNegative || next > 0);
            onAmountChange(raw, usable ? toMinorUnits(next, currency) : 0);
          }}
        />
        <Select
          value={currency}
          onValueChange={(next) => {
            // Radix emits an empty value while its items are still registering,
            // which happens when a dialog opens on mount rather than on a click
            // (`/income?new=1`). No item has an empty value, so this is never a
            // real choice — taking it would blank the field and leave the form
            // unsubmittable.
            if (!next) return;
            onCurrencyChange(next);
            // The typed figure is a quantity of the *new* currency, and its
            // minor-unit scale may differ (JOD has three decimals, JPY none),
            // so the parsed value has to be recomputed rather than carried.
            const value = Number(amount);
            const usable =
              amount.trim() !== '' && Number.isFinite(value) && (allowNegative || value > 0);
            onAmountChange(amount, usable ? toMinorUnits(value, next) : 0);
          }}
        >
          <SelectTrigger className="w-28 shrink-0" aria-label={`${label} currency`}>
            {/* Rendered explicitly rather than left to `SelectValue` to look
                up from the registered items: the code is exactly what we want
                the trigger to read, and it cannot go blank if the lookup and
                the value ever disagree. */}
            <SelectValue>
              {currencyMeta(currency).symbol} {currency}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((item) => (
              <SelectItem
                key={item.code}
                value={item.code}
                disabled={unavailable(item.code)}
              >
                {item.symbol} {item.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {unavailable(currency) ? (
        <p className="text-sm text-destructive">
          No exchange rate is published for {currencyMeta(currency).code}, so it cannot be
          converted to {currencyMeta(baseCurrency).code}. Pick another currency.
        </p>
      ) : converted !== null ? (
        <p className="text-xs text-muted-foreground">
          ≈ {formatMoney(converted, baseCurrency, { locale })} at today's rate. The exact figure
          is worked out when you save, using the rate on the date you chose.
        </p>
      ) : valid && currency !== baseCurrency && !rates.isLoading ? (
        <p className="text-xs text-muted-foreground">
          Saved as {currencyMeta(currency).code}; converted to {currencyMeta(baseCurrency).code}{' '}
          when you save.
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
