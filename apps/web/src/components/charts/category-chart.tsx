'use client';

import type { CategoryBreakdownDto } from '@eco/shared';
import { useMoneyFormat } from '@/lib/auth-provider';
import { cn } from '@/lib/utils';
import { useChartTheme } from './chart-theme';
import { moneyFormatter } from './chart-tooltip';

/**
 * Spending by category, as a horizontal bar list.
 *
 * A bar list rather than a pie or donut: the job is comparing magnitudes, and
 * length along a shared baseline is the encoding people read most accurately.
 * A pie also forces a legend and colour-matching for every slice, where bars
 * carry their own labels.
 *
 * Beyond the top few, categories fold into "Other" — a chart with twelve
 * distinct hues on screen at once cannot keep them separable under
 * colour-vision deficiency, and the tail is not what the user is looking at.
 */
export function CategoryChart({
  data,
  limit = 7,
  className,
}: {
  data: CategoryBreakdownDto[];
  limit?: number;
  className?: string;
}) {
  const theme = useChartTheme();
  const { currency, locale } = useMoneyFormat();
  const money = moneyFormatter(currency, locale);

  if (data.length === 0) {
    return (
      <p className={cn('py-8 text-center text-sm text-muted-foreground', className)}>
        No spending recorded for this period.
      </p>
    );
  }

  const ranked = [...data].sort((a, b) => b.amountMinor - a.amountMinor);
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);

  const rows = [
    ...head,
    ...(tail.length > 0
      ? [
          {
            categoryId: '__other',
            categoryName: `Other (${tail.length})`,
            color: '#64748b',
            amountMinor: tail.reduce((sum, c) => sum + c.amountMinor, 0),
            sharePct: tail.reduce((sum, c) => sum + c.sharePct, 0),
            changePct: null,
            transactionCount: tail.reduce((sum, c) => sum + c.transactionCount, 0),
          } satisfies CategoryBreakdownDto,
        ]
      : []),
  ];

  const max = Math.max(...rows.map((r) => r.amountMinor), 1);

  return (
    <ul className={cn('space-y-3', className)}>
      {rows.map((row) => {
        const colour = theme.category(row.color);
        return (
          <li key={row.categoryId}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: colour }}
                />
                <span className="truncate text-foreground">{row.categoryName}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="tabular font-medium text-foreground">
                  {money(row.amountMinor)}
                </span>
                <span className="tabular w-10 text-right text-xs text-muted-foreground">
                  {/* Rounding a 0.5% slice up to 1% next to a 99.5% slice
                      rounded up to 100% makes the column sum to 101 and read as
                      a bug. Sub-1% shares say so explicitly instead. */}
                  {row.sharePct < 1 && row.sharePct > 0 ? '<1%' : `${row.sharePct.toFixed(0)}%`}
                </span>
              </span>
            </div>
            {/* Bars are capped well under the row height so the band keeps its
                air, with a rounded data-end and a square baseline. */}
            <div className="h-2 w-full overflow-hidden rounded-l-sm rounded-r-full bg-muted">
              <div
                className="h-full rounded-r-full transition-[width] duration-300"
                style={{
                  width: `${Math.max((row.amountMinor / max) * 100, 2)}%`,
                  background: colour,
                }}
              />
            </div>
            {row.changePct !== null && Math.abs(row.changePct) >= 5 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {/* The arrow, not the colour, carries the direction. */}
                <span aria-hidden>{row.changePct > 0 ? '▲' : '▼'}</span>{' '}
                <span style={{ color: row.changePct > 0 ? theme.negative : theme.positive }}>
                  {row.changePct > 0 ? '+' : ''}
                  {row.changePct.toFixed(0)}%
                </span>{' '}
                vs last month · {row.transactionCount} transaction
                {row.transactionCount === 1 ? '' : 's'}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
