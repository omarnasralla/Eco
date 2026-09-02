'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import {
  FREQUENCIES,
  INCOME_TYPES,
  INCOME_TYPE_LABELS,
  convertMinor,
  formatMoney,
  incomeSourceSchema,
  type IncomeSourceInput,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useEntryCurrency } from '@/lib/entry-currency';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyField, useExchangeRates } from '@/components/ui/money-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

const FREQUENCY_LABELS: Record<string, string> = {
  ONE_TIME: 'one-off',
  WEEKLY: 'weekly',
  BIWEEKLY: 'every two weeks',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
};

function IncomeContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { currency, locale } = useMoneyFormat();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const [dialogOpen, setDialogOpen] = useState(searchParams.get('new') === '1');

  const income = useQuery({ queryKey: queryKeys.income, queryFn: fetchers.income });
  const summary = useQuery({ queryKey: queryKeys.incomeSummary, queryFn: fetchers.incomeSummary });
  const rates = useExchangeRates();

  /**
   * A source is denominated in its own currency, so it is shown in that one.
   * The run-rate contribution is what belongs in the base currency, and the API
   * has already converted the headline total; this converts the per-row figure
   * to match it.
   */
  const monthlyInBase = (minor: number, from: string): number | null => {
    if (from === currency) return minor;
    if (!rates.data) return null;
    try {
      return convertMinor(minor, from, currency, rates.data.rates);
    } catch {
      return null;
    }
  };

  const isEmpty = !income.isLoading && (income.data?.length ?? 0) === 0;

  return (
    <>
      <PageHeader
        title="Income"
        description="Every stream of money coming in."
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

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
          ) : isEmpty ? (
            // An empty state that only says "nothing here" leaves a new account
            // stuck, and every figure that divides by income reads as zero
            // until this is filled in — so the way out is in the message.
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                No income recorded yet. Your savings rate, budgets and payoff plans all measure
                against this.
              </p>
              <Button size="sm" className="mt-4" onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Add your first income
              </Button>
            </div>
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
                    {/* Shown in the source's own currency: a riyal salary under
                        a dollar sign is a different, wrong number. */}
                    <p className="tabular text-sm font-semibold">
                      {formatMoney(source.amountMinor, source.currency, { locale })}
                    </p>
                    {(() => {
                      // The monthly line earns its place when the frequency
                      // needs annualising, when the currency needs converting,
                      // or both.
                      if (source.frequency === 'ONE_TIME') return null;
                      const differs = source.currency !== currency;
                      if (source.frequency === 'MONTHLY' && !differs) return null;
                      const base = monthlyInBase(source.monthlyEquivalentMinor, source.currency);
                      if (base === null) {
                        return (
                          <p className="tabular text-xs text-muted-foreground">
                            {formatMoney(source.monthlyEquivalentMinor, source.currency, {
                              locale,
                            })}
                            /mo
                          </p>
                        );
                      }
                      return (
                        <p className="tabular text-xs text-muted-foreground">
                          {differs ? '≈ ' : ''}
                          {money(base)}/mo
                        </p>
                      );
                    })()}
                  </div>
                  {!source.isActive ? <Badge variant="secondary">inactive</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddIncomeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        baseCurrency={currency}
        locale={locale}
        onCreated={() => {
          // Income moves the savings rate, the budget headroom, the payoff
          // plans and the health score — invalidate the lot, not just this list.
          void queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function AddIncomeDialog({
  open,
  onOpenChange,
  baseCurrency,
  locale,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the run rate is reported in; pay may arrive in another currency. */
  baseCurrency: string;
  locale: string;
  onCreated: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [entryCurrency, setEntryCurrency] = useEntryCurrency(baseCurrency);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<IncomeSourceInput>({
    resolver: zodResolver(incomeSourceSchema),
    defaultValues: {
      name: '',
      type: 'SALARY',
      amountMinor: 0,
      currency: baseCurrency,
      frequency: 'MONTHLY',
      startDate: new Date().toISOString().slice(0, 10),
      isActive: true,
    },
  });

  const create = useMutation({
    mutationFn: (input: IncomeSourceInput) => api.post('/income', input),
    onSuccess: () => {
      // Keep the currency they just used; a second stream is usually paid in
      // the same one.
      reset({
        name: '',
        type: 'SALARY',
        amountMinor: 0,
        currency: entryCurrency,
        frequency: 'MONTHLY',
        startDate: new Date().toISOString().slice(0, 10),
        isActive: true,
      });
      setAmount('');
      onOpenChange(false);
      onCreated();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that income.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    // The currency lives in component state rather than the form, so the two
    // are joined here. `useEntryCurrency` only ever yields a supported code,
    // which is what the schema's `currency` field accepts.
    create.mutate({ ...values, currency: entryCurrency });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add income</DialogTitle>
          <DialogDescription>
            One stream of money coming in — a salary, a client, a rental.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="income-name">Name</Label>
            <Input id="income-name" placeholder="Acme Ltd — Salary" {...register('name')} />
            {errors.name ? (
              <p className="text-sm text-destructive">Give this income a name.</p>
            ) : null}
          </div>

          <MoneyField
            id="income-amount"
            label="Amount"
            amount={amount}
            onAmountChange={(raw, minorUnits) => {
              setAmount(raw);
              setValue('amountMinor', minorUnits, { shouldValidate: true });
            }}
            currency={entryCurrency}
            onCurrencyChange={setEntryCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            hint="What actually lands in your account — take-home pay, not gross. Nothing is deducted from this figure."
            error={errors.amountMinor ? 'Enter an amount above zero.' : undefined}
          />

          <div className="space-y-2">
            <Label htmlFor="income-frequency">How often</Label>
            <Select
              value={watch('frequency')}
              onValueChange={(value) =>
                setValue('frequency', value as IncomeSourceInput['frequency'], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger id="income-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((frequency) => (
                  <SelectItem key={frequency} value={frequency}>
                    {FREQUENCY_LABELS[frequency]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {watch('frequency') === 'ONE_TIME' ? (
              <p className="text-xs text-muted-foreground">
                A one-off is recorded but adds nothing to your monthly run rate — a single bonus is
                not a monthly income stream.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="income-type">Type</Label>
            <Select
              value={watch('type')}
              onValueChange={(value) =>
                setValue('type', value as IncomeSourceInput['type'], { shouldValidate: true })
              }
            >
              <SelectTrigger id="income-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCOME_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {INCOME_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="income-start">Started on</Label>
            <Input id="income-start" type="date" {...register('startDate')} />
            <p className="text-xs text-muted-foreground">
              When this stream began, even if that was years ago.
            </p>
            {errors.startDate ? (
              <p className="text-sm text-destructive">Pick a start date.</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="income-notes">Notes (optional)</Label>
            <Input
              id="income-notes"
              placeholder="Net pay after tax and pension"
              {...register('notes')}
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Save income
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function IncomePage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <IncomeContent />
    </Suspense>
  );
}
