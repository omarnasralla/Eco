'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { formatMoney } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

export default function GoalsPage() {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const goals = useQuery({ queryKey: queryKeys.goals, queryFn: fetchers.goals });

  return (
    <>
      <PageHeader title="Savings goals" description="What you are putting money aside for." />

      {goals.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (goals.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No goals yet. An emergency fund is usually the right first one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {goals.data!.map((goal) => {
            const colour = theme.category(goal.color);
            return (
              <Card key={goal.id}>
                <CardContent className="p-4 sm:p-6">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 font-medium">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: colour }}
                        />
                        <span className="truncate">{goal.name}</span>
                        {goal.status === 'ACHIEVED' ? (
                          <CheckCircle2
                            className="size-4 shrink-0"
                            style={{ color: theme.positive }}
                            aria-label="Achieved"
                          />
                        ) : null}
                      </h2>
                      {goal.deadline ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Target date {formatDate(goal.deadline, locale)}
                        </p>
                      ) : null}
                    </div>
                    {goal.status !== 'ACHIEVED' ? (
                      <Badge variant={goal.onTrack ? 'success' : 'warning'}>
                        {goal.onTrack ? 'on track' : 'behind'}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <span className="tabular text-xl font-semibold">
                      {money(goal.currentAmountMinor)}
                    </span>
                    <span className="tabular text-sm text-muted-foreground">
                      of {money(goal.targetAmountMinor)}
                    </span>
                  </div>

                  <Progress
                    value={goal.progressPct}
                    aria-label={`${goal.name}: ${goal.progressPct}% funded`}
                    indicatorStyle={{ background: colour }}
                  />

                  <p className="mt-2 text-xs text-muted-foreground">
                    {goal.progressPct}% funded
                    {goal.requiredMonthlyMinor !== null && goal.status !== 'ACHIEVED'
                      ? ` · needs ${money(goal.requiredMonthlyMinor)}/month to hit the deadline`
                      : goal.projectedCompletionDate && goal.status !== 'ACHIEVED'
                        ? ` · on course to finish ${formatDate(goal.projectedCompletionDate, locale)}`
                        : ''}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
