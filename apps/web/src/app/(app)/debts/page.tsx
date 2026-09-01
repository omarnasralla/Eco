'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Loader2, TrendingDown } from 'lucide-react';
import { formatMoney, toMinorUnits, type PayoffPlanDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { PayoffChart } from '@/components/charts/payoff-chart';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function DebtsPage() {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const debts = useQuery({ queryKey: queryKeys.debts, queryFn: fetchers.debts });

  const totalBalance = (debts.data ?? []).reduce((sum, d) => sum + d.currentBalanceMinor, 0);
  const totalMinimum = (debts.data ?? []).reduce((sum, d) => sum + d.minimumPaymentMinor, 0);

  const [budgetInput, setBudgetInput] = useState('');
  const budgetMinor = budgetInput ? toMinorUnits(Number(budgetInput) || 0, currency) : 0;

  const comparison = useQuery({
    queryKey: queryKeys.debtComparison(budgetMinor),
    queryFn: () => fetchers.debtComparison(budgetMinor),
    // Only ask once the budget actually covers the minimums; below that the
    // API correctly refuses, and firing anyway would just render an error.
    enabled: budgetMinor >= totalMinimum && totalMinimum > 0,
  });

  const plan = useMutation({
    mutationFn: (strategy: 'SNOWBALL' | 'AVALANCHE') =>
      api.post<PayoffPlanDto>('/debts/payoff-plan', {
        strategy,
        monthlyBudgetMinor: budgetMinor,
        extraOneOffMinor: 0,
      }),
  });

  return (
    <>
      <PageHeader
        title="Debts"
        description="What you owe, and the fastest way out of it."
      />

      {debts.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (debts.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No debts recorded. If you have any, adding them lets Eco build a payoff plan.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Total owed</p>
              <p className="tabular mt-2 text-2xl font-semibold">{money(totalBalance)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Minimum payments</p>
              <p className="tabular mt-2 text-2xl font-semibold">{money(totalMinimum)}</p>
              <p className="mt-1 text-xs text-muted-foreground">per month</p>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Your debts</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {debts.data!.map((debt) => (
                  <li key={debt.id} className="px-4 py-3 sm:px-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{debt.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {debt.lender ? `${debt.lender} · ` : ''}
                          {debt.interestRateApr}% APR · due {formatDate(debt.nextDueDate, locale)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular text-sm font-semibold">
                          {money(debt.currentBalanceMinor)}
                        </p>
                        <p className="tabular text-xs text-muted-foreground">
                          min {money(debt.minimumPaymentMinor)}
                        </p>
                      </div>
                    </div>

                    {/* The loudest thing this app can tell someone: a minimum
                        payment that never clears the interest. */}
                    {debt.monthsToPayoffAtMinimum === null ? (
                      <p
                        className="mt-2 rounded-md px-2 py-1.5 text-xs"
                        style={{
                          background: `${theme.negative}1a`,
                          color: theme.negative,
                        }}
                      >
                        At the minimum payment this balance never clears — the interest outpaces it.
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {debt.monthsToPayoffAtMinimum} months at the minimum, costing{' '}
                        {money(debt.totalInterestAtMinimumMinor ?? 0)} in interest.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingDown className="size-4 text-primary" aria-hidden />
                Payoff planner
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-4 max-w-xs space-y-2">
                <Label htmlFor="budget">Monthly budget for debt</Label>
                <Input
                  id="budget"
                  inputMode="decimal"
                  placeholder={String(Math.ceil(totalMinimum / 100))}
                  value={budgetInput}
                  onChange={(event) => setBudgetInput(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Must be at least {money(totalMinimum)} to cover your minimums.
                </p>
              </div>

              {budgetMinor > 0 && budgetMinor < totalMinimum ? (
                <p className="text-sm text-muted-foreground">
                  That is below your combined minimum payments, so no plan can clear these debts.
                </p>
              ) : comparison.isLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : comparison.data ? (
                <>
                  <div className="mb-4 rounded-lg border p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge variant="success">
                        Recommended: {comparison.data.recommended.toLowerCase()}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{comparison.data.rationale}</p>
                    <p className="mt-2 text-sm">
                      Either way you save{' '}
                      <strong className="tabular">
                        {money(comparison.data.interestSavedVsMinimumMinor)}
                      </strong>{' '}
                      and finish{' '}
                      <strong>{comparison.data.monthsSavedVsMinimum} months</strong> sooner than
                      paying minimums.
                    </p>
                  </div>

                  <Tabs defaultValue="avalanche">
                    <TabsList>
                      <TabsTrigger value="avalanche">Avalanche</TabsTrigger>
                      <TabsTrigger value="snowball">Snowball</TabsTrigger>
                    </TabsList>

                    {(['avalanche', 'snowball'] as const).map((key) => {
                      const result = comparison.data![key];
                      return (
                        <TabsContent key={key} value={key}>
                          <p className="mb-3 text-sm text-muted-foreground">
                            {key === 'avalanche'
                              ? 'Highest interest rate first — mathematically the cheapest route.'
                              : 'Smallest balance first — costs a little more, but clears individual debts sooner.'}
                          </p>
                          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div>
                              <dt className="text-xs text-muted-foreground">Debt-free in</dt>
                              <dd className="tabular text-lg font-semibold">
                                {result.monthsToDebtFree} mo
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">By</dt>
                              <dd className="text-lg font-semibold">
                                {formatDate(result.debtFreeDate, locale)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">Total interest</dt>
                              <dd className="tabular text-lg font-semibold">
                                {money(result.totalInterestMinor)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">Total paid</dt>
                              <dd className="tabular text-lg font-semibold">
                                {money(result.totalPaidMinor)}
                              </dd>
                            </div>
                          </dl>

                          <ol className="mb-4 space-y-1.5 text-sm">
                            {result.payoffOrder.map((entry, index) => (
                              <li key={entry.debtId} className="flex items-center gap-2">
                                <span className="tabular flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                                  {index + 1}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{entry.debtName}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  month {entry.clearedInMonth}
                                </span>
                              </li>
                            ))}
                          </ol>

                          <Button
                            size="sm"
                            onClick={() =>
                              plan.mutate(key === 'avalanche' ? 'AVALANCHE' : 'SNOWBALL')
                            }
                            disabled={plan.isPending}
                          >
                            {plan.isPending ? (
                              <Loader2 className="animate-spin" aria-hidden />
                            ) : null}
                            Build full schedule
                          </Button>
                        </TabsContent>
                      );
                    })}
                  </Tabs>

                  {plan.data ? (
                    <div className="mt-6 border-t pt-4">
                      <h3 className="mb-3 text-sm font-medium">Balances over time</h3>
                      <PayoffChart schedule={plan.data.schedule} />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Enter a monthly budget to compare payoff strategies.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
