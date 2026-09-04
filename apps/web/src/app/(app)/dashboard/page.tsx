'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  ArrowLeftRight,
  CalendarClock,
  CreditCard,
  Landmark,
  PiggyBank,
  Receipt,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { formatMoney } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate, relativeDays } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { StatTile } from '@/components/dashboard/stat-tile';
import { HealthScoreCard } from '@/components/dashboard/health-score-card';
import { RecommendationsList } from '@/components/dashboard/recommendations-list';
import { TrendChart } from '@/components/charts/trend-chart';
import { CategoryChart } from '@/components/charts/category-chart';
import { ForecastChart } from '@/components/charts/forecast-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

const currentMonth = () => new Date().toISOString().slice(0, 7);

export default function DashboardPage() {
  const { currency, locale } = useMoneyFormat();
  const month = currentMonth();

  // Each widget owns its own query so a slow forecast never blocks the
  // headline numbers — the page fills in progressively rather than waiting
  // on its slowest dependency.
  const summary = useQuery({
    queryKey: queryKeys.dashboard(month),
    queryFn: () => fetchers.dashboardSummary(month),
  });
  const trend = useQuery({ queryKey: queryKeys.trend(12), queryFn: () => fetchers.trend(12) });
  const breakdown = useQuery({
    queryKey: queryKeys.breakdown(month),
    queryFn: () => fetchers.categoryBreakdown(month),
  });
  const forecast = useQuery({
    queryKey: queryKeys.forecast(6),
    queryFn: () => fetchers.forecast(6),
  });
  const health = useQuery({
    queryKey: queryKeys.healthScore,
    queryFn: () => fetchers.healthScore(),
  });
  const recommendations = useQuery({
    queryKey: queryKeys.recommendations,
    queryFn: () => fetchers.recommendations(),
  });

  const money = (minor: number) => formatMoney(minor, currency, { locale });
  const data = summary.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Where your money stands this month."
        actions={
          <Button asChild size="sm">
            <Link href="/expenses?new=1">
              <Receipt className="size-4" aria-hidden />
              Add expense
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Income"
          valueMinor={data?.totalIncomeMinor ?? 0}
          deltaPct={data?.deltas.incomePct}
          icon={TrendingUp}
          loading={summary.isLoading}
          hint="Received or due this month"
        />
        <StatTile
          label="Spent this month"
          valueMinor={data?.totalExpensesMinor ?? 0}
          deltaPct={data?.deltas.expensesPct}
          invertDelta
          icon={Receipt}
          loading={summary.isLoading}
        />
        {/* Sits beside the two figures it is the difference of, because on its
            own a negative number here reads as a mistake. Deliberately not
            given a month-over-month delta: the percentage change between two
            signed figures that can straddle zero is not a quantity anyone can
            read — a swing from -50 to +50 is not "200% better". */}
        <StatTile
          label="Net cash flow"
          valueMinor={data?.netCashFlowMinor ?? 0}
          icon={ArrowLeftRight}
          loading={summary.isLoading}
          hint="Income less spending, this month"
        />
        <StatTile
          label="Total debt"
          valueMinor={data?.totalDebtMinor ?? 0}
          icon={CreditCard}
          loading={summary.isLoading}
          hint={data ? `${data.goalsOnTrack}/${data.goalsTotal} goals on track` : undefined}
        />
        <StatTile
          label="Cash on hand"
          valueMinor={data?.totalCashMinor ?? 0}
          icon={Landmark}
          loading={summary.isLoading}
          hint={
            data && data.totalCashMinor === 0
              ? 'Add an account to track this'
              : 'Across your accounts'
          }
        />
        <StatTile
          label="Net worth"
          valueMinor={data?.netWorthMinor ?? 0}
          icon={Wallet}
          loading={summary.isLoading}
          hint="Cash plus savings, less debt"
        />
      </div>

      {data ? (
        <Card className="mt-3">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              {/* Named for the month it actually measures. A rate for the month
                  in progress would divide full-month income by part-month
                  spending and report a number nobody can act on. */}
              <p className="text-sm text-muted-foreground">
                Savings rate · last 3 months
              </p>
              <p className="tabular mt-0.5 text-xl font-semibold">
                {data.savingsRatePct.toFixed(1)}%
              </p>
            </div>
            <p className="max-w-xs text-xs text-muted-foreground">
              {data.savingsRatePct >= 20
                ? 'Comfortably above the 20% benchmark — this is what builds a buffer.'
                : data.savingsRatePct > 0
                  ? 'Positive, but under the 20% many aim for. Small, steady cuts move this fastest.'
                  : data.savingsRateBasisIncomeMinor === 0
                    ? // A rate of zero means "nothing to divide by" as often as it
                      // means overspending, and telling someone who recorded no
                      // income that they spent too much is simply a wrong statement.
                      'No income recorded over these three months, so there is no rate to compute yet.'
                    : 'You spent more than you earned over these three months. Worth a look at your budget.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Income vs expenses</CardTitle>
          </CardHeader>
          <CardContent>
            {trend.isLoading ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (
              <TrendChart data={trend.data ?? []} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Where it went this month</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdown.isLoading ? (
              <div className="space-y-4">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <CategoryChart data={breakdown.data ?? []} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cash-flow forecast</CardTitle>
          </CardHeader>
          <CardContent>
            {forecast.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : forecast.data ? (
              <ForecastChart forecast={forecast.data} />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Forecasting is unavailable right now.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
              Coming up
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (data?.upcomingBills.length ?? 0) === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nothing due in the next two weeks.
              </p>
            ) : (
              <ul className="divide-y">
                {data!.upcomingBills.slice(0, 6).map((bill) => (
                  <li key={`${bill.source}-${bill.id}`} className="flex items-center gap-3 py-2.5">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: bill.categoryColor ?? 'hsl(var(--muted-foreground))' }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{bill.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(bill.dueDate, locale)} · {relativeDays(bill.daysUntilDue)}
                      </p>
                    </div>
                    <span className="tabular shrink-0 text-sm font-medium">
                      {money(bill.amountMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RecommendationsList
          data={recommendations.data}
          loading={recommendations.isLoading}
          limit={3}
        />
        <HealthScoreCard data={health.data} loading={health.isLoading} />
      </div>
    </>
  );
}
