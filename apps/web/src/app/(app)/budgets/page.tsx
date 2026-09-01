'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoney } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatMonth } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const STATUS_VARIANT = { UNDER: 'secondary', WARNING: 'warning', OVER: 'destructive' } as const;

export default function BudgetsPage() {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const budget = useQuery({
    queryKey: queryKeys.budget(month),
    queryFn: () => fetchers.budget(month),
  });

  const data = budget.data;
  const projectedOver = data ? data.projectedSpendMinor > data.totalLimitMinor : false;

  return (
    <>
      <PageHeader
        title="Budgets"
        description="What you planned to spend, against what you actually have."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, -1))}>
              ←
            </Button>
            <span className="min-w-[9rem] text-center text-sm font-medium">
              {formatMonth(month, locale)}
            </span>
            <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, 1))}>
              →
            </Button>
          </div>
        }
      />

      {budget.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !data ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No budget set for {formatMonth(month, locale)}.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Eco can suggest limits from your last six months of spending.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-4 sm:p-6">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm text-muted-foreground">Spent this month</p>
                  <p className="tabular mt-1 text-3xl font-semibold">
                    {money(data.totalSpentMinor)}
                  </p>
                </div>
                <p className="tabular text-sm text-muted-foreground">
                  of {money(data.totalLimitMinor)}
                </p>
              </div>

              <Progress
                value={Math.min(data.utilisationPct, 100)}
                aria-label={`${data.utilisationPct.toFixed(0)}% of budget used`}
                indicatorStyle={{
                  background:
                    data.utilisationPct > 100
                      ? theme.negative
                      : data.utilisationPct >= data.alertThresholdPct
                        ? '#c87f00'
                        : theme.positive,
                }}
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {data.totalRemainingMinor >= 0
                    ? `${money(data.totalRemainingMinor)} left`
                    : `${money(-data.totalRemainingMinor)} over`}
                  {data.daysRemaining > 0 ? ` · ${data.daysRemaining} days to go` : ''}
                </span>
                <span className="tabular text-muted-foreground">
                  {data.utilisationPct.toFixed(0)}%
                </span>
              </div>

              {data.daysRemaining > 0 ? (
                <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {/* Recurring charges are excluded from the run rate, so this
                      does not read rent on the 1st as a daily habit. */}
                  On your current pace you will finish the month at{' '}
                  <strong className="tabular text-foreground">
                    {money(data.projectedSpendMinor)}
                  </strong>
                  {projectedOver
                    ? ` — about ${money(data.projectedSpendMinor - data.totalLimitMinor)} over budget.`
                    : ' — comfortably inside your budget.'}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">By category</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.lines.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No category limits set for this month.
                </p>
              ) : (
                data.lines.map((line) => {
                  const colour = theme.category(line.categoryColor);
                  return (
                    <div key={line.categoryId}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: colour }}
                          />
                          <span className="truncate">{line.categoryName}</span>
                          {line.status !== 'UNDER' ? (
                            <Badge variant={STATUS_VARIANT[line.status]} className="shrink-0">
                              {line.status === 'OVER' ? 'over' : 'close'}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="tabular shrink-0 text-muted-foreground">
                          {money(line.spentMinor)} / {money(line.limitMinor)}
                        </span>
                      </div>
                      <Progress
                        value={Math.min(line.utilisationPct, 100)}
                        aria-label={`${line.categoryName}: ${line.utilisationPct.toFixed(0)}% used`}
                        indicatorStyle={{
                          background:
                            line.status === 'OVER'
                              ? theme.negative
                              : line.status === 'WARNING'
                                ? '#c87f00'
                                : colour,
                        }}
                      />
                      {line.rollover && line.rolloverFromPreviousMinor > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Includes {money(line.rolloverFromPreviousMinor)} carried over from last
                          month.
                        </p>
                      ) : null}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
