'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { formatMoney, type DailyAllowanceLineDto } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { useChartTheme } from '@/components/charts/chart-theme';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_LABEL: Record<DailyAllowanceLineDto['status'], string> = {
  ON_TRACK: 'On track',
  TIGHT: 'Tight',
  EXHAUSTED: 'Spent',
};

const STATUS_VARIANT = {
  ON_TRACK: 'success',
  TIGHT: 'warning',
  EXHAUSTED: 'destructive',
} as const;

/**
 * The month's remaining budget restated as "this much a day, per category".
 *
 * Every figure comes from the budget endpoint, which recomputes against live
 * expenses on each read — so recording a coffee here drops the food line
 * without a page reload, provided the mutation invalidated the budget query.
 *
 * Deliberately absent rather than zeroed when there is no budget for the
 * month: a daily ceiling of nothing is not the same as no ceiling at all.
 */
export function DailyAllowanceCard({ categoryId }: { categoryId: string }) {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const month = new Date().toISOString().slice(0, 7);

  const budget = useQuery({
    queryKey: queryKeys.budget(month),
    queryFn: () => fetchers.budget(month),
  });

  if (budget.isLoading) return <Skeleton className="mb-4 h-28 w-full" />;

  const allowance = budget.data?.dailyAllowance;
  if (!allowance || allowance.lines.length === 0) return null;

  const money = (minor: number) => formatMoney(minor, currency, { locale });

  // Follow the list's own filter: when the user has narrowed to one category,
  // the pacing they are being shown should be the pacing for what they are
  // looking at, not for a month they have filtered out of view.
  const filtered =
    categoryId === 'all'
      ? allowance.lines
      : allowance.lines.filter((line) => line.categoryId === categoryId);
  if (filtered.length === 0) return null;

  const focused = categoryId !== 'all';
  const days = allowance.daysRemainingInclusive;

  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-medium">Safe to spend per day</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {days === 1 ? 'Today is the last day' : `${days} days left, today included`}
          </p>
        </div>

        {/* The whole-budget figure only makes sense against the whole budget;
            with one category in view it would describe something else. */}
        {focused ? null : (
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="tabular text-2xl font-semibold text-foreground">
              {money(allowance.totalAllowanceMinor)}
            </span>{' '}
            a day keeps you inside {money(allowance.totalRemainingMinor)} of remaining budget.
          </p>
        )}

        <ul className={focused ? 'mt-3 space-y-2' : 'mt-4 space-y-2'}>
          {filtered.map((line) => (
            <li key={line.categoryId} className="flex items-center gap-3">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: theme.category(line.categoryColor) }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{line.categoryName}</span>

              {line.status === 'EXHAUSTED' ? (
                <span className="tabular text-sm text-muted-foreground">
                  {money(Math.abs(line.remainingMinor))} over
                </span>
              ) : (
                <span className="tabular text-sm font-medium">
                  {money(line.allowanceMinor)}
                  <span className="font-normal text-muted-foreground">/day</span>
                </span>
              )}

              <Badge variant={STATUS_VARIANT[line.status]} className="w-16 justify-center">
                {STATUS_LABEL[line.status]}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
