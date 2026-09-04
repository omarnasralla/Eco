'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Loader2, Pencil, Plus, TrendingDown, Trash2 } from 'lucide-react';
import {
  DEBT_TYPES,
  debtPaymentSchema,
  debtSchema,
  toMajorUnits,
  toMinorUnits,
  type DebtDto,
  type DebtInput,
  type DebtPaymentInput,
  type PayoffPlanDto,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useDisplayCurrency } from '@/lib/display-currency';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { PayoffChart } from '@/components/charts/payoff-chart';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MoneyField, safeConvert, useExchangeRates } from '@/components/ui/money-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEntryCurrency } from '@/lib/entry-currency';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function DebtsPage() {
  const { currency, locale, format: money } = useDisplayCurrency();
  const theme = useChartTheme();

  const debts = useQuery({ queryKey: queryKeys.debts, queryFn: fetchers.debts });

  // Debts can each be held in their own currency, so these cannot be a raw
  // sum: adding a pound balance to a dollar one gives a figure that is money in
  // neither, then prints it under the base currency's symbol. Anything that
  // cannot be converted is left out of the total and reported below it rather
  // than silently folded in at face value.
  const rates = useExchangeRates();
  const convertAll = (pick: (d: DebtDto) => number) =>
    (debts.data ?? []).reduce(
      (acc, d) => {
        const converted = safeConvert(pick(d), d.currency, currency, rates.data?.rates);
        return converted === null
          ? { total: acc.total, unconverted: acc.unconverted + 1 }
          : { total: acc.total + converted, unconverted: acc.unconverted };
      },
      { total: 0, unconverted: 0 },
    );
  const balance = convertAll((d) => d.currentBalanceMinor);
  const minimum = convertAll((d) => d.minimumPaymentMinor);
  const totalBalance = balance.total;
  const totalMinimum = minimum.total;

  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<DebtDto | null>(null);
  const [payingOff, setPayingOff] = useState<DebtDto | null>(null);
  const refreshAll = () => void queryClient.invalidateQueries();

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
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

      {debts.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (debts.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No debts recorded. If you have any, adding them lets Eco build a payoff plan.
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Add a debt
            </Button>
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

          {balance.unconverted > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {balance.unconverted} debt{balance.unconverted === 1 ? '' : 's'} in a currency with no
              rate available {balance.unconverted === 1 ? 'is' : 'are'} not counted in these totals.
            </p>
          ) : null}

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
                      <div className="flex shrink-0 items-start gap-2">
                        <div className="text-right">
                          {/* A debt is held in its own currency, so it is shown
                              in that currency. Formatting it with the base
                              symbol would relabel £5,000 as $5,000. */}
                          <p className="tabular text-sm font-semibold">
                            {money(debt.currentBalanceMinor, debt.currency)}
                          </p>
                          <p className="tabular text-xs text-muted-foreground">
                            min {money(debt.minimumPaymentMinor, debt.currency)}
                          </p>
                          {debt.currency !== currency ? (
                            <p className="tabular text-xs text-muted-foreground">
                              ≈{' '}
                              {(() => {
                                const c = safeConvert(
                                  debt.currentBalanceMinor,
                                  debt.currency,
                                  currency,
                                  rates.data?.rates,
                                );
                                return c === null ? '—' : money(c);
                              })()}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPayingOff(debt)}
                            aria-label={`Record a payment against ${debt.name}`}
                          >
                            Pay
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing(debt)}
                            aria-label={`Edit ${debt.name}`}
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                        </div>
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

      <DebtDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        baseCurrency={currency}
        locale={locale}
        onSaved={refreshAll}
      />

      {/* Keyed per debt so the form remounts rather than carrying the previous
          row's values across. */}
      <DebtDialog
        key={editing?.id ?? 'none'}
        debt={editing ?? undefined}
        open={editing !== null}
        onOpenChange={(next) => (next ? undefined : setEditing(null))}
        baseCurrency={currency}
        locale={locale}
        onSaved={() => {
          setEditing(null);
          refreshAll();
        }}
      />

      <PaymentDialog
        key={payingOff?.id ?? 'none-pay'}
        debt={payingOff}
        onClose={() => setPayingOff(null)}
        locale={locale}
        onSaved={() => {
          setPayingOff(null);
          refreshAll();
        }}
      />
    </>
  );
}

const DEBT_TYPE_LABELS: Record<string, string> = {
  CREDIT_CARD: 'Credit card',
  PERSONAL_LOAN: 'Personal loan',
  CAR_LOAN: 'Car loan',
  MORTGAGE: 'Mortgage',
  STUDENT_LOAN: 'Student loan',
  MEDICAL: 'Medical',
  CUSTOM: 'Other',
};

/**
 * Create or edit a debt.
 *
 * One component for both, as elsewhere: the fields are the same fields, and a
 * second copy would be another place for the currency handling to drift.
 */
function DebtDialog({
  open,
  onOpenChange,
  baseCurrency,
  locale,
  onSaved,
  debt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseCurrency: string;
  locale: string;
  onSaved: () => void;
  debt?: DebtDto;
}) {
  const editing = debt !== undefined;
  const [balance, setBalance] = useState('');
  const [principal, setPrincipal] = useState('');
  const [minimum, setMinimum] = useState('');
  const [debtCurrency, setDebtCurrency] = useEntryCurrency(baseCurrency);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Held in local state rather than react-hook-form: Radix's Select emits an
  // empty value while its items register on mount, and no item here has an
  // empty value, so that phantom event would otherwise clear a real choice.
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);

  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: fetchers.accounts });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<DebtInput>({
    resolver: zodResolver(debtSchema),
    defaultValues: {
      name: '',
      type: 'CREDIT_CARD',
      currency: baseCurrency,
      principalMinor: 0,
      currentBalanceMinor: 0,
      minimumPaymentMinor: 0,
      interestRateApr: 0,
      dueDayOfMonth: 1,
    },
  });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);
    setAccountId(debt ? debt.accountId : null);
    if (debt) {
      setBalance(String(toMajorUnits(debt.currentBalanceMinor, debt.currency)));
      setPrincipal(String(toMajorUnits(debt.principalMinor, debt.currency)));
      setMinimum(String(toMajorUnits(debt.minimumPaymentMinor, debt.currency)));
      setDebtCurrency(debt.currency);
      reset({
        name: debt.name,
        type: debt.type,
        lender: debt.lender ?? '',
        currency: debt.currency,
        principalMinor: debt.principalMinor,
        currentBalanceMinor: debt.currentBalanceMinor,
        minimumPaymentMinor: debt.minimumPaymentMinor,
        interestRateApr: debt.interestRateApr,
        dueDayOfMonth: debt.dueDayOfMonth,
        notes: debt.notes ?? '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debt?.id]);

  const save = useMutation({
    mutationFn: (input: DebtInput) =>
      editing
        ? api.patch(`/debts/${debt.id}`, { ...input, accountId: accountId ?? null })
        : api.post('/debts', { ...input, accountId: accountId ?? null }),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that debt.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/debts/${debt!.id}`),
    onSuccess: () => {
      setConfirmingDelete(false);
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not delete that debt.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    save.mutate({ ...values, currency: debtCurrency });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit debt' : 'Add a debt'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the balance, rate or payment — or delete it.'
              : 'What you owe, to whom, and on what terms.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="debt-name">Name</Label>
            <Input id="debt-name" placeholder="Barclaycard" {...register('name')} />
            {errors.name ? <p className="text-sm text-destructive">Give it a name.</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="debt-type">Type</Label>
            <Select
              value={watch('type')}
              onValueChange={(v) => setValue('type', v as DebtInput['type'])}
            >
              <SelectTrigger id="debt-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEBT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DEBT_TYPE_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <MoneyField
            id="debt-balance"
            label="Current balance"
            amount={balance}
            onAmountChange={(raw, minor) => {
              setBalance(raw);
              setValue('currentBalanceMinor', minor, { shouldValidate: true });
              // A new debt is nearly always recorded at its current balance, so
              // the original principal follows it unless it is set separately.
              if (!editing && principal === '') {
                setValue('principalMinor', minor);
              }
            }}
            currency={debtCurrency}
            onCurrencyChange={setDebtCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            autoFocus={!editing}
          />

          <MoneyField
            id="debt-minimum"
            label="Minimum monthly payment"
            amount={minimum}
            onAmountChange={(raw, minor) => {
              setMinimum(raw);
              setValue('minimumPaymentMinor', minor, { shouldValidate: true });
            }}
            currency={debtCurrency}
            onCurrencyChange={setDebtCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
          />

          <MoneyField
            id="debt-principal"
            label="Original amount borrowed"
            amount={principal}
            onAmountChange={(raw, minor) => {
              setPrincipal(raw);
              setValue('principalMinor', minor, { shouldValidate: true });
            }}
            currency={debtCurrency}
            onCurrencyChange={setDebtCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            hint="Used to show how far through it you are."
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="debt-apr">Interest rate (APR %)</Label>
              <Input
                id="debt-apr"
                inputMode="decimal"
                placeholder="21.9"
                {...register('interestRateApr', { valueAsNumber: true })}
              />
              {errors.interestRateApr ? (
                <p className="text-sm text-destructive">Enter a rate between 0 and 200.</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="debt-due">Due day of month</Label>
              <Input
                id="debt-due"
                inputMode="numeric"
                placeholder="1"
                {...register('dueDayOfMonth', { valueAsNumber: true })}
              />
              {errors.dueDayOfMonth ? (
                <p className="text-sm text-destructive">A day from 1 to 31.</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="debt-lender">Lender (optional)</Label>
            <Input id="debt-lender" placeholder="Barclays" {...register('lender')} />
          </div>

          {accounts.data && accounts.data.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="debt-account">Pay from</Label>
              <Select
                value={accountId ?? 'none'}
                onValueChange={(v) => {
                  // See the state comment above — Radix fires this with an
                  // empty string during item registration; no real item has
                  // one, so it is never an actual choice.
                  if (!v) return;
                  setAccountId(v === 'none' ? null : v);
                }}
              >
                <SelectTrigger id="debt-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.data.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">Not tracked here</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Recording a payment on this debt uses this account by default, and reduces its
                balance the same way an expense would.
              </p>
            </div>
          ) : null}

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            {editing && confirmingDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Delete “{debt.name}” and its payment history?
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep
                </Button>
              </div>
            ) : (
              <>
                {editing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="mr-1 size-4" aria-hidden />
                    Delete
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {editing ? 'Save changes' : 'Save debt'}
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Record a payment against a debt.
 *
 * The payment is entered in the debt's own currency, not the user's base one:
 * you pay a card in the currency the card is denominated in, and the server
 * reduces the balance by exactly this figure. The split between principal and
 * interest is left to the API, which derives it from the APR.
 */
function PaymentDialog({
  debt,
  onClose,
  locale,
  onSaved,
}: {
  debt: DebtDto | null;
  onClose: () => void;
  locale: string;
  onSaved: () => void;
}) {
  const { format: money } = useDisplayCurrency();
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // Local state for the same Radix-empty-value reason as the account picker
  // on the add/edit form. Starts at the debt's own default account, which is
  // the entire point of setting one — a recurring installment should not
  // need re-picking every month, only overriding on the months it differs.
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);

  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: fetchers.accounts });

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<DebtPaymentInput>({
    resolver: zodResolver(debtPaymentSchema),
    defaultValues: { amountMinor: 0, date: new Date().toISOString().slice(0, 10) },
  });

  useEffect(() => {
    if (!debt) return;
    setFormError(null);
    setAmount('');
    setAccountId(debt.accountId);
    // Prefilled with the minimum, which is what most payments are, and still
    // entirely editable.
    const minimum = toMajorUnits(debt.minimumPaymentMinor, debt.currency);
    if (minimum > 0) {
      setAmount(String(minimum));
      setValue('amountMinor', debt.minimumPaymentMinor, { shouldValidate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debt?.id]);

  const pay = useMutation({
    mutationFn: (input: DebtPaymentInput) =>
      api.post(`/debts/${debt!.id}/payments`, { ...input, accountId: accountId ?? null }),
    onSuccess: () => {
      onClose();
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not record that payment.'),
  });

  if (!debt) return null;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            Against {debt.name} — balance{' '}
            {money(debt.currentBalanceMinor, debt.currency)}.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit((values) => {
            setFormError(null);
            pay.mutate(values);
          })}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="payment-amount">Amount ({debt.currency})</Label>
            <Input
              id="payment-amount"
              inputMode="decimal"
              autoFocus
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const raw = e.target.value;
                setAmount(raw);
                const parsed = Number(raw);
                setValue(
                  'amountMinor',
                  raw.trim() !== '' && Number.isFinite(parsed) && parsed > 0
                    ? toMinorUnits(parsed, debt.currency)
                    : 0,
                  { shouldValidate: true },
                );
              }}
            />
            {errors.amountMinor ? (
              <p className="text-sm text-destructive">Enter an amount above zero.</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-date">Date</Label>
            <Input id="payment-date" type="date" {...register('date')} />
          </div>

          {accounts.data && accounts.data.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="payment-account">From</Label>
              <Select
                value={accountId ?? 'none'}
                onValueChange={(v) => {
                  if (!v) return;
                  setAccountId(v === 'none' ? null : v);
                }}
              >
                <SelectTrigger id="payment-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.data.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">Not tracked here</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pay.isPending}>
              {pay.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
