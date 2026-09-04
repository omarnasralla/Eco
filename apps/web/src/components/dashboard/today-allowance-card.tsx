'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Sun } from 'lucide-react';
import { formatMoney, type TodayAllowanceLineDto, type TodayStatus } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { useChartTheme } from '@/components/charts/chart-theme';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_VARIANT = { OK: 'success', NEAR: 'warning', OVER: 'destructive' } as const;
const STATUS_LABEL: Record<TodayStatus, string> = { OK: 'OK', NEAR: 'Close', OVER: 'Over' };

/**
 * What is still spendable *today*, against a limit that does not move.
 *
 * The Expenses tab answers the other question — the rate that is sustainable
 * across the rest of the month — and that figure necessarily falls as money is
 * spent. This one is fixed at the start of the day, so approaching it means
 * something and a warning can fire before rather than after.
 *
 * Live by the same mechanism as everywhere else: recording an expense
 * invalidates the budget query, and this reads it.
 */
export function TodayAllowanceCard() {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const month = new Date().toISOString().slice(0, 7);

  const budget = useQuery({
    queryKey: queryKeys.budget(month),
    queryFn: () => fetchers.budget(month),
  });

  if (budget.isLoading) return <Skeleton className="mt-3 h-40 w-full" />;

  const today = budget.data?.todayAllowance;
  if (!today || today.lines.length === 0) return null;

  const money = (minor: number) => formatMoney(minor, today.currency, { locale });
  const over = today.status === 'OVER';

  // Only categories with something to say today. A list of untouched limits is
  // noise on a dashboard; the ones being spent are the ones worth watching.
  const notable = today.lines
    .filter((line) => line.spentTodayMinor > 0 || line.status !== 'OK')
    .sort((a, b) => b.utilisationPct - a.utilisationPct);

  return (
    <Card className="mt-3">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            {over ? (
              <AlertTriangle className="size-4 text-destructive" aria-hidden />
            ) : (
              <Sun className="size-4 text-muted-foreground" aria-hidden />
            )}
            <h2 className="text-sm font-medium">Today</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {money(today.totalSpentTodayMinor)} of {money(today.totalAllowanceMinor)}
          </p>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          {over ? (
            <>
              <span className="tabular text-2xl font-semibold text-destructive">
                {money(Math.abs(today.totalRemainingTodayMinor))}
              </span>{' '}
              over today&rsquo;s budget.
            </>
          ) : (
            <>
              <span className="tabular text-2xl font-semibold text-foreground">
                {money(today.totalRemainingTodayMinor)}
              </span>{' '}
              left to spend today.
            </>
          )}
        </p>

        <Progress
          className="mt-3"
          value={Math.min(
            today.totalAllowanceMinor > 0
              ? (today.totalSpentTodayMinor / today.totalAllowanceMinor) * 100
              : 100,
            100,
          )}
          aria-label={`${money(today.totalSpentTodayMinor)} of today's ${money(
            today.totalAllowanceMinor,
          )} budget used`}
          indicatorStyle={{
            background:
              today.status === 'OVER'
                ? theme.negative
                : today.status === 'NEAR'
                  ? // Same amber the Budgets tab uses for a warning bar; the
                    // chart theme carries only positive and negative.
                    '#c87f00'
                  : theme.positive,
          }}
        />

        {notable.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {notable.map((line) => (
              <TodayRow key={line.categoryId} line={line} money={money} theme={theme} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Nothing spent yet today.</p>
        )}

        {today.currency === currency ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            Converted from your {currency} budget at today&rsquo;s rate.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TodayRow({
  line,
  money,
  theme,
}: {
  line: TodayAllowanceLineDto;
  money: (minor: number) => string;
  theme: ReturnType<typeof useChartTheme>;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: theme.category(line.categoryColor) }}
      />
      {/* Stacked, not inline: a phone clips a shared line and a clipped amount
          still looks like an amount. */}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{line.categoryName}</span>
        <span className="block text-xs text-muted-foreground">
          {money(line.spentTodayMinor)} of {money(line.allowanceMinor)}
        </span>
      </span>
      <Badge
        variant={STATUS_VARIANT[line.status]}
        className="w-14 shrink-0 justify-center px-1 sm:w-16 sm:px-2.5"
      >
        {STATUS_LABEL[line.status]}
      </Badge>
    </li>
  );
}
