'use client';

import { ArrowLeftRight } from 'lucide-react';
import { useDisplayCurrency } from '@/lib/display-currency';

/**
 * Flips every figure on the page between the two configured currencies.
 *
 * A single control rather than making each amount clickable: many of them
 * already sit inside buttons and links, and a button inside a button is
 * invalid markup that keyboards and screen readers handle badly.
 *
 * Absent entirely until a secondary currency is set — a toggle between one
 * currency and itself is a control that does nothing.
 */
export function CurrencyToggle() {
  const { currency, canFlip, flip } = useDisplayCurrency();
  if (!canFlip) return null;

  return (
    <div className="mb-3 flex justify-end">
      <button
        type="button"
        onClick={flip}
        aria-label={`Showing amounts in ${currency}. Switch currency.`}
        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftRight className="size-3.5" aria-hidden />
        <span className="tabular">{currency}</span>
      </button>
    </div>
  );
}
