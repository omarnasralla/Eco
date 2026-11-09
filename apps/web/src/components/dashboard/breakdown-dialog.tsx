'use client';

import { useQuery } from '@tanstack/react-query';
import { formatMoney, type DashboardMetric } from '@eco/shared';
import { api } from '@/lib/api-client';
import type { DashboardBreakdownDto } from '@eco/shared';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatMonth } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const TITLES: Record<DashboardMetric, string> = {
  income: 'Income',
  expenses: 'Spent this month',
  netCashFlow: 'Net cash flow',
  debt: 'Total debt',
  cash: 'Cash on hand',
  netWorth: 'Net worth',
};

/**
 * How a headline figure was reached.
 *
 * The lines are summed and compared against the figure the card shows. When
 * they disagree the remainder is named rather than hidden: a breakdown that
 * silently fails to add up is worse than no breakdown, because it reads as
 * proof.
 */
export function BreakdownDialog({
  metric,
  month,
  onClose,
}: {
  metric: DashboardMetric | null;
  month: string;
  onClose: () => void;
}) {
  const { currency, locale } = useMoneyFormat();
  const breakdown = useQuery({
    queryKey: ['dashboard', 'breakdown', metric, month],
    queryFn: () =>
      api.get<DashboardBreakdownDto>('/dashboard/breakdown', { query: { metric, month } }),
    enabled: metric !== null,
  });

  const data = breakdown.data;
  const money = (minor: number) => formatMoney(minor, data?.currency ?? currency, { locale });
  // Memo lines explain the figure rather than make it up, so they are left
  // out of the sum — counting them would invent a discrepancy and the
  // "unaccounted for" row below would report it as a finding.
  const summed =
    data?.lines.reduce((sum, l) => (l.memo ? sum : sum + l.amountMinor), 0) ?? 0;
  const remainder = data ? data.totalMinor - summed : 0;

  return (
    <Dialog open={metric !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{metric ? TITLES[metric] : ''}</DialogTitle>
          <DialogDescription>
            How this is worked out for {formatMonth(month, locale)}.
          </DialogDescription>
        </DialogHeader>

        {breakdown.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">That breakdown could not be loaded.</p>
        ) : data.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded for {formatMonth(month, locale)}.
          </p>
        ) : (
          // min-w-0: the dialog is a grid, and a grid track grows to the
          // widest unbreakable line inside it — one long note used to push the
          // whole dialog off the side of a phone.
          <div className="min-w-0 space-y-1">
            {data.lines.map((line, i) => (
              <div
                key={`${line.label}-${i}`}
                className={
                  line.memo
                    ? // Set apart from the lines that add up, with a rule above
                      // it, so it is read as a note on the total rather than
                      // another component of it.
                      'mt-1 flex items-start justify-between gap-3 border-t px-1 pt-3 text-sm text-muted-foreground'
                    : 'flex items-start justify-between gap-3 rounded-md px-1 py-2 text-sm odd:bg-muted/40'
                }
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{line.label}</p>
                  {/* Wraps rather than truncates: a detail explains the figure,
                      and half an explanation is worse than none. */}
                  {line.detail ? (
                    <p className="break-words text-xs text-muted-foreground">{line.detail}</p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`tabular-nums font-medium ${
                      !line.memo && line.amountMinor < 0 ? 'text-destructive' : ''
                    }`}
                  >
                    {money(line.amountMinor)}
                  </p>
                  {/* The same money as it actually sits, when the account is
                      not held in the base currency. */}
                  {line.nativeLabel ? (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {line.nativeLabel}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}

            {/* Named, never hidden. If the lines do not reach the figure on the
                card, that gap is the most interesting thing on this screen. */}
            {remainder !== 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-md px-1 py-2 text-sm">
                <p className="font-medium text-amber-600 dark:text-amber-400">Unaccounted for</p>
                <p className="tabular-nums font-medium text-amber-600 dark:text-amber-400">
                  {money(remainder)}
                </p>
              </div>
            ) : null}

            <div className="mt-1 flex items-center justify-between gap-3 border-t px-1 pt-3 text-sm">
              <p className="font-semibold">Total</p>
              <p className="tabular-nums font-semibold">{money(data.totalMinor)}</p>
            </div>
          </div>
        )}

        {data?.note ? (
          <p className="text-xs text-muted-foreground">{data.note}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
