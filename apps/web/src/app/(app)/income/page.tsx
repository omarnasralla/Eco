'use client';

import { useQuery } from '@tanstack/react-query';
import { formatMoney, INCOME_TYPE_LABELS } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const FREQUENCY_LABELS: Record<string, string> = {
  ONE_TIME: 'one-off',
  WEEKLY: 'weekly',
  BIWEEKLY: 'every two weeks',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
};

export default function IncomePage() {
  const { currency, locale } = useMoneyFormat();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const income = useQuery({ queryKey: queryKeys.income, queryFn: fetchers.income });
  const summary = useQuery({ queryKey: queryKeys.incomeSummary, queryFn: fetchers.incomeSummary });

  return (
    <>
      <PageHeader title="Income" description="Every stream of money coming in." />

      <Card>
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">Monthly run rate</p>
          {summary.isLoading ? (
            <Skeleton className="mt-2 h-9 w-40" />
          ) : (
            <p className="tabular mt-1 text-3xl font-semibold">
              {money(summary.data?.monthlyTotalMinor ?? 0)}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Weekly and fortnightly pay is annualised across 52 and 26 payments, then divided by
            twelve — so a three-paycheque month is not mistaken for a raise.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your income sources</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {income.isLoading ? (
            <div className="space-y-px">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-none" />
              ))}
            </div>
          ) : (income.data?.length ?? 0) === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              No income recorded yet.
            </p>
          ) : (
            <ul className="divide-y">
              {income.data!.map((source) => (
                <li key={source.id} className="flex items-start gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{source.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {INCOME_TYPE_LABELS[source.type]} ·{' '}
                      {FREQUENCY_LABELS[source.frequency] ?? source.frequency.toLowerCase()} · since{' '}
                      {formatDate(source.startDate, locale)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-sm font-semibold">{money(source.amountMinor)}</p>
                    {source.frequency !== 'MONTHLY' && source.frequency !== 'ONE_TIME' ? (
                      <p className="tabular text-xs text-muted-foreground">
                        {money(source.monthlyEquivalentMinor)}/mo
                      </p>
                    ) : null}
                  </div>
                  {!source.isActive ? <Badge variant="secondary">inactive</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
