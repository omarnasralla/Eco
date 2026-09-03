'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  FREQUENCIES,
  INCOME_TYPES,
  INCOME_TYPE_LABELS,
  convertMinor,
  formatMoney,
  incomeSourceSchema,
  parseAmountInput,
  toMajorUnits,
  toMinorUnits,
  type AccountDto,
  type IncomeSourceDto,
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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Why a source is or is not counted in the run rate.
 *
 * The API applies exactly these three conditions, and a figure the user cannot
 * account for is worse than no figure — so the reason is stated on the row
 * rather than left to be inferred from a date they have to compare by eye.
 */
function runRateState(source: IncomeSourceDto): { counted: boolean; label?: string } {
  const now = today();
  if (!source.isActive) return { counted: false, label: 'paused' };
  if (source.endDate && source.endDate < now) return { counted: false, label: 'ended' };
  if (source.startDate > now) return { counted: false, label: 'not started' };
  return { counted: true };
}

function IncomeContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { currency, locale } = useMoneyFormat();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  const [addOpen, setAddOpen] = useState(searchParams.get('new') === '1');
  const [editing, setEditing] = useState<IncomeSourceDto | null>(null);
  const [receiptFor, setReceiptFor] = useState<IncomeSourceDto | null>(null);
  const [oneOffOpen, setOneOffOpen] = useState(false);
  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: fetchers.accounts });
  const receipts = useQuery({ queryKey: queryKeys.incomeReceipts, queryFn: fetchers.incomeReceipts });

  const income = useQuery({ queryKey: queryKeys.income, queryFn: fetchers.income });
  const summary = useQuery({ queryKey: queryKeys.incomeSummary, queryFn: fetchers.incomeSummary });
  const rates = useExchangeRates();

  // Income moves the savings rate, the budget headroom, the payoff plans and
  // the health score — invalidate the lot, not just this list.
  const refreshAll = () => void queryClient.invalidateQueries();

  const removeReceipt = useMutation({
    mutationFn: (id: string) => api.delete(`/income/receipts/${id}`),
    onSuccess: refreshAll,
  });

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
          <Button size="sm" onClick={() => setAddOpen(true)}>
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
            twelve — so a three-paycheque month is not mistaken for a raise. Paused and ended
            sources are left out.
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
              <Button size="sm" className="mt-4" onClick={() => setAddOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Add your first income
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {income.data!.map((source) => {
                const state = runRateState(source);
                return (
                  <li key={source.id}>
                    {/* The whole row opens the editor: pay changes, and hunting
                        for a small pencil on a phone is the wrong tax to put on
                        a raise. */}
                    <button
                      type="button"
                      onClick={() => setEditing(source)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent sm:px-6"
                      aria-label={`Edit ${source.name}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{source.name}</span>
                          {state.label ? (
                            <Badge variant="secondary" className="shrink-0">
                              {state.label}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {INCOME_TYPE_LABELS[source.type]} ·{' '}
                          {FREQUENCY_LABELS[source.frequency] ?? source.frequency.toLowerCase()} ·{' '}
                          {source.endDate
                            ? `${formatDate(source.startDate, locale)} to ${formatDate(source.endDate, locale)}`
                            : `since ${formatDate(source.startDate, locale)}`}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {/* Shown in the source's own currency: a riyal salary
                            under a dollar sign is a different, wrong number. */}
                        <p className="tabular text-sm font-semibold">
                          {formatMoney(source.amountMinor, source.currency, { locale })}
                        </p>
                        {(() => {
                          // The monthly line earns its place when the frequency
                          // needs annualising, when the currency needs
                          // converting, or both.
                          if (source.frequency === 'ONE_TIME') return null;
                          const differs = source.currency !== currency;
                          if (source.frequency === 'MONTHLY' && !differs) return null;
                          const base = monthlyInBase(
                            source.monthlyEquivalentMinor,
                            source.currency,
                          );
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
                      <Pencil
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </button>
                    {/* Outside the row button, since a button cannot nest in
                        one. This is the tap that turns a schedule into money:
                        the source says what is expected, this says it arrived. */}
                    <div className="flex justify-end px-4 pb-3 sm:px-6">
                      <Button size="sm" variant="outline" onClick={() => setReceiptFor(source)}>
                        <Plus className="size-4" aria-hidden />
                        Record a payment
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <div>
            <CardTitle className="text-base">Received</CardTitle>
            {/* The distinction the app previously left implicit, and which cost
                a user an afternoon: a source is a forecast, a receipt is money. */}
            <p className="text-xs text-muted-foreground">
              Payments that actually landed. These move your account balances; the schedules above
              do not.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOneOffOpen(true)}>
            <Plus className="size-4" aria-hidden />
            One-off
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {receipts.isLoading ? (
            <Skeleton className="m-4 h-16" />
          ) : (receipts.data?.length ?? 0) === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">
              Nothing recorded yet. Use “Record a payment” on a source when it arrives, or “One-off”
              for money with no schedule behind it.
            </p>
          ) : (
            <ul className="divide-y">
              {receipts.data!.map((receipt) => (
                <li key={receipt.id} className="flex items-center gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{receipt.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(receipt.date, locale)}
                      {receipt.accountId ? '' : ' · not paid into a tracked account'}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-sm font-semibold">
                    {formatMoney(receipt.amountMinor, receipt.currency, { locale })}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${receipt.name}`}
                    onClick={() => removeReceipt.mutate(receipt.id)}
                    disabled={removeReceipt.isPending}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ReceiptDialog
        key={receiptFor?.id ?? 'none'}
        source={receiptFor}
        accounts={accounts.data ?? []}
        onClose={() => setReceiptFor(null)}
        locale={locale}
        onSaved={() => {
          setReceiptFor(null);
          refreshAll();
        }}
      />

      <OneOffReceiptDialog
        open={oneOffOpen}
        onOpenChange={setOneOffOpen}
        accounts={accounts.data ?? []}
        baseCurrency={currency}
        locale={locale}
        onSaved={() => {
          setOneOffOpen(false);
          refreshAll();
        }}
      />

      <IncomeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        baseCurrency={currency}
        locale={locale}
        onSaved={refreshAll}
      />

      <IncomeDialog
        source={editing ?? undefined}
        open={editing !== null}
        onOpenChange={(next) => (next ? undefined : setEditing(null))}
        baseCurrency={currency}
        locale={locale}
        onSaved={refreshAll}
      />
    </>
  );
}

/**
 * Creates a source, or edits one when `source` is given.
 *
 * One component for both because the fields are the same fields — a raise is
 * the amount box, a finished contract is the end date. Splitting them would
 * mean two places to keep the currency handling and the validation honest.
 */
function IncomeDialog({
  source,
  open,
  onOpenChange,
  baseCurrency,
  locale,
  onSaved,
}: {
  source?: IncomeSourceDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the run rate is reported in; pay may arrive in another currency. */
  baseCurrency: string;
  locale: string;
  onSaved: () => void;
}) {
  const editing = source !== undefined;

  const [amount, setAmount] = useState('');
  const [rememberedCurrency, rememberCurrency] = useEntryCurrency(baseCurrency);
  const [currency, setCurrency] = useState(baseCurrency);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
      startDate: today(),
      isActive: true,
    },
  });

  /**
   * Loads the source being edited, or resets to a blank entry.
   *
   * Keyed on `open` as well as the source so that reopening after a cancelled
   * edit shows the stored values again rather than the abandoned ones, and so a
   * second Add does not inherit the first.
   */
  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);

    if (source) {
      setCurrency(source.currency);
      setAmount(String(toMajorUnits(source.amountMinor, source.currency)));
      reset({
        name: source.name,
        type: source.type,
        amountMinor: source.amountMinor,
        currency: source.currency,
        frequency: source.frequency,
        startDate: source.startDate,
        endDate: source.endDate,
        isActive: source.isActive,
        notes: source.notes,
      });
      return;
    }

    setCurrency(rememberedCurrency);
    setAmount('');
    reset({
      name: '',
      type: 'SALARY',
      amountMinor: 0,
      currency: rememberedCurrency,
      frequency: 'MONTHLY',
      startDate: today(),
      isActive: true,
    });
  }, [open, source, rememberedCurrency, reset]);

  const save = useMutation({
    mutationFn: (input: IncomeSourceInput) =>
      editing ? api.patch(`/income/${source.id}`, input) : api.post('/income', input),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that income.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/income/${source!.id}`),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not delete that income.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    // The currency lives in component state rather than the form, so the two
    // are joined here. Only a new entry updates the remembered choice: editing
    // an old riyal salary should not change what the next expense defaults to.
    if (!editing) rememberCurrency(currency);
    save.mutate({ ...values, currency });
  });

  const pending = save.isPending || remove.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit income' : 'Add income'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the amount after a raise, or set an end date when it stops.'
              : 'One stream of money coming in — a salary, a client, a rental.'}
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
            currency={currency}
            onCurrencyChange={setCurrency}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="income-start">Started on</Label>
              <Input id="income-start" type="date" {...register('startDate')} />
              {errors.startDate ? (
                <p className="text-sm text-destructive">Pick a start date.</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="income-end">Ends on (optional)</Label>
              <Input
                id="income-end"
                type="date"
                // An untouched date input submits "", which is not a date. Map
                // it to null before validation so "no end date" is expressible,
                // and so clearing the field ends up removing the end date.
                {...register('endDate', { setValueAs: (v) => (v === '' ? null : v) })}
              />
              {errors.endDate ? (
                <p className="text-sm text-destructive">The end date must fall after the start.</p>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the end date empty while it is ongoing. Once it has passed, the source stops
            counting towards your run rate.
          </p>

          {editing ? (
            <div className="space-y-2">
              <Label htmlFor="income-status">Status</Label>
              <Select
                value={watch('isActive') ? 'active' : 'paused'}
                onValueChange={(value) => setValue('isActive', value === 'active')}
              >
                <SelectTrigger id="income-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Counting towards income</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Pausing keeps the record but leaves it out of every total — useful for a client
                between contracts.
              </p>
            </div>
          ) : null}

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

          {editing && confirmingDelete ? (
            <div className="rounded-lg border border-destructive/50 p-3">
              <p className="text-sm">
                Delete <span className="font-medium">{source.name}</span>? Its history goes with
                it. To stop it counting without losing the record, pause it instead.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep it
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Delete
                </Button>
              </div>
            </div>
          ) : null}

          <DialogFooter className="sm:justify-between">
            {editing && !confirmingDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </Button>
            ) : (
              <span className="hidden sm:block" />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {editing ? 'Save changes' : 'Save income'}
              </Button>
            </div>
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

/** Shared by both receipt dialogs: where the money landed. */
function AccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: AccountDto[];
  value: string | null | undefined;
  onChange: (next: string | null) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor="receipt-account">Paid into</Label>
      <Select
        value={value ?? 'none'}
        onValueChange={(v) => {
          // Radix emits '' while its items register; no item has that value.
          if (!v) return;
          onChange(v === 'none' ? null : v);
        }}
      >
        <SelectTrigger id="receipt-account">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name}
            </SelectItem>
          ))}
          <SelectItem value="none">Not into a tracked account</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** Records a payment against an existing source. */
function ReceiptDialog({
  source,
  accounts,
  onClose,
  locale,
  onSaved,
}: {
  source: IncomeSourceDto | null;
  accounts: AccountDto[];
  onClose: () => void;
  locale: string;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const primaryId = accounts.find((a) => a.isPrimary)?.id ?? accounts[0]?.id ?? null;

  useEffect(() => {
    if (!source) return;
    setFormError(null);
    setDate(today());
    // Prefilled with the scheduled figure, which is what most payments are.
    setAmount(String(toMajorUnits(source.amountMinor, source.currency)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  useEffect(() => {
    if (!primaryId) return;
    setAccountId((current) => (current === undefined ? primaryId : current));
  }, [primaryId]);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/income/${source!.id}/receipts`, {
        amountMinor: toMinorUnits(parseAmountInput(amount) ?? 0, source!.currency),
        date,
        accountId: accountId ?? null,
      }),
    onSuccess: onSaved,
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not record that payment.'),
  });

  if (!source) return null;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            From {source.name}. This is money that arrived, so it moves the balance of the account
            it landed in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="receipt-amount">Amount ({source.currency})</Label>
            <Input
              id="receipt-amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="receipt-date">Date received</Label>
            <Input id="receipt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A payment with no schedule behind it.
 *
 * The case this exists for: money that arrived once. Recording it as a source
 * made it a recurring rate it is not, so it contributed nothing to the run rate
 * and moved no balance — it landed nowhere at all.
 */
function OneOffReceiptDialog({
  open,
  onOpenChange,
  accounts,
  baseCurrency,
  locale,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountDto[];
  baseCurrency: string;
  locale: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useEntryCurrency(baseCurrency);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const primaryId = accounts.find((a) => a.isPrimary)?.id ?? accounts[0]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setName('');
    setAmount('');
    setDate(today());
  }, [open]);

  useEffect(() => {
    if (!primaryId) return;
    setAccountId((current) => (current === undefined ? primaryId : current));
  }, [primaryId]);

  const save = useMutation({
    mutationFn: () =>
      api.post('/income/receipts', {
        name,
        amountMinor: toMinorUnits(parseAmountInput(amount) ?? 0, currency),
        currency,
        date,
        accountId: accountId ?? null,
      }),
    onSuccess: onSaved,
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not record that payment.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a one-off payment</DialogTitle>
          <DialogDescription>
            Money that arrived once, with no schedule behind it — a bonus, a refund, a gift. It
            moves your balance without pretending to be a monthly rate.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="oneoff-name">What was it</Label>
            <Input
              id="oneoff-name"
              placeholder="Bonus"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <MoneyField
            id="oneoff-amount"
            label="Amount"
            amount={amount}
            onAmountChange={(raw) => setAmount(raw)}
            currency={currency}
            onCurrencyChange={setCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            autoFocus
          />

          <div className="space-y-2">
            <Label htmlFor="oneoff-date">Date received</Label>
            <Input
              id="oneoff-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
