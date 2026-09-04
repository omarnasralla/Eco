'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { formatMoney, type DailyAllowanceLineDto } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useEntryCurrency } from '@/lib/entry-currency';
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

  // Quote the ceiling in the money the user actually hands over. Someone who
  // reports in dollars but pays in riyals cannot act on "$3.96 a day" without
  // doing the arithmetic themselves at the till, which is the one place they
  // will not do it. The entry currency is the honest signal for this: it is
  // whatever they last typed an amount in.
  const [entryCurrency] = useEntryCurrency(currency);

  const budget = useQuery({
    queryKey: queryKeys.budget(month, entryCurrency),
    queryFn: () => fetchers.budget(month, entryCurrency),
  });

  if (budget.isLoading) return <Skeleton className="mb-4 h-28 w-full" />;

  const allowance = budget.data?.dailyAllowance;
  if (!allowance || allowance.lines.length === 0) return null;
  const excludedMinor = budget.data?.excludedFromBudgetMinor ?? 0;

  // The server decides what it could actually convert; trusting the requested
  // code here would label riyals as dollars whenever a rate was unavailable.
  const money = (minor: number) => formatMoney(minor, allowance.currency, { locale });

  // Follow the list's own filter: when the user has narrowed to one category,
  // the pacing they are being shown should be the pacing for what they are
  // looking at, not for a month they have filtered out of view.
  const filtered =
    categoryId === 'all'
      ? allowance.lines
      : allowance.lines.filter((line) => line.categoryId === categoryId);
  if (filtered.length === 0) return null;

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

        <ul className="mt-3 space-y-2">
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

          {/* The total is a row rather than a headline so it lands in the same
              column as the categories, where it can actually be compared with
              them. It covers the whole budget even when the list above is
              filtered to one category — hiding it there would drop the one
              figure that answers "what can I spend today" outright — so it
              says which categories it counts rather than leaving that to be
              inferred from whatever the filter happens to be. */}
          <li className="flex items-center gap-3 border-t pt-2">
            <span aria-hidden className="size-2.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              All categories
              {/* Spending outside every budgeted category still counts against
                  the month's total, so the total can be exhausted while each
                  line above it still has room. Printing "-696.38 left" and a
                  0.00 daily figure states that as though it were an allowance;
                  it is an overspend, and it reads as one. */}
              <span className="ml-1 font-normal text-muted-foreground">
                {allowance.totalRemainingMinor > 0
                  ? `· ${money(allowance.totalRemainingMinor)} left`
                  : '· over budget'}
              </span>
            </span>
            <span className="tabular text-sm font-semibold">
              {allowance.totalRemainingMinor > 0 ? (
                <>
                  {money(allowance.totalAllowanceMinor)}
                  <span className="font-normal text-muted-foreground">/day</span>
                </>
              ) : (
                <span className="text-destructive">
                  {money(Math.abs(allowance.totalRemainingMinor))} over
                </span>
              )}
            </span>
            {/* Spacer matching the status badges, so the amounts stay aligned. */}
            <span aria-hidden className="w-16" />
          </li>
        </ul>

        {/* Excluded spend is stated, not just subtracted. "Within budget" is
            worth nothing if an amount the user cannot see was set aside to
            make it true — and the figure is in the budget's own currency,
            which is not necessarily the one the allowances are quoted in. */}
        {excludedMinor > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {formatMoney(excludedMinor, currency, { locale })} of this
            month&rsquo;s spending is kept outside these limits.
          </p>
        ) : null}

        {/* The budget itself is still kept in the base currency, and the
            Budgets tab still reports it there. Saying so is the difference
            between a helpful conversion and two screens that disagree. */}
        {allowance.currency === currency ? null : (
          <p className="mt-1 text-xs text-muted-foreground">
            Converted from your {currency} budget at today&rsquo;s rate.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
