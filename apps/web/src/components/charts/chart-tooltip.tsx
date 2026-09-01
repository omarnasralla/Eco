'use client';

import { formatMoney } from '@eco/shared';
import { cn } from '@/lib/utils';
import { useChartTheme } from './chart-theme';

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

/**
 * The one tooltip every chart uses.
 *
 * Values are pre-formatted by the caller so the tooltip never has to know
 * whether it is showing money, a percentage or a count — and so a currency is
 * never guessed.
 */
export function ChartTooltip({
  title,
  rows,
  footnote,
  className,
}: {
  title: string;
  rows: TooltipRow[];
  footnote?: string;
  className?: string;
}) {
  const theme = useChartTheme();

  return (
    <div
      className={cn('rounded-lg border px-3 py-2 text-xs shadow-lg', className)}
      style={{ background: theme.tooltipBg, borderColor: theme.tooltipBorder }}
    >
      <p className="mb-1.5 font-medium text-foreground">{title}</p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {row.color ? (
                // Identity rides a coloured mark beside the text; the text
                // itself keeps a text token so a pale hue stays legible.
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
              ) : null}
              {row.label}
            </span>
            <span className="tabular font-medium text-foreground">{row.value}</span>
          </div>
        ))}
      </div>
      {footnote ? <p className="mt-1.5 text-[11px] text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}

/** Builds a money formatter bound to the user's currency and locale. */
export function moneyFormatter(currency: string, locale: string) {
  return (minor: number, compact = false) =>
    formatMoney(minor, currency, { locale, compact });
}
