'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import {
  expenseSchema,
  type AccountDto,
  formatMoney,
  toMajorUnits,
  type ExpenseDto,
  type ExpenseInput,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useEntryCurrency } from '@/lib/entry-currency';
import { useLastCategory } from '@/lib/last-category';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { DailyAllowanceCard } from '@/components/budget/daily-allowance-card';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { MoneyField } from '@/components/ui/money-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

function ExpensesContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(searchParams.get('new') === '1');
  const [editing, setEditing] = useState<ExpenseDto | null>(null);
  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: fetchers.accounts });

  const filters = useMemo(
    () => ({
      limit: 50,
      ...(search ? { search } : {}),
      ...(categoryId !== 'all' ? { categoryId } : {}),
    }),
    [search, categoryId],
  );

  const categories = useQuery({ queryKey: queryKeys.categories, queryFn: fetchers.categories });
  const expenses = useQuery({
    queryKey: queryKeys.expenses(filters),
    queryFn: () => fetchers.expenses(filters),
  });

  const money = (minor: number) => formatMoney(minor, currency, { locale });

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Everything you have spent, newest first."
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

      {/* Pacing before the ledger: the useful question on this screen is what
          is still spendable today, not what was spent yesterday. */}
      <DailyAllowanceCard categoryId={categoryId} />

      {/* Filters sit in one row above the list, per the interaction spec. */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            placeholder="Search merchant or notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            aria-label="Search expenses"
          />
        </div>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger className="sm:w-52" aria-label="Filter by category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data ?? []).map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {expenses.isLoading ? (
            <div className="space-y-px">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-none" />
              ))}
            </div>
          ) : (expenses.data?.items.length ?? 0) === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {search || categoryId !== 'all'
                ? 'No expenses match those filters.'
                : 'No expenses yet. Add your first one to get started.'}
            </p>
          ) : (
            <ul className="divide-y">
              {expenses.data!.items.map((expense) => (
                <li key={expense.id}>
                  {/* The whole row is the control: on a phone a small pencil
                      icon is a worse target than the thing it would sit on. */}
                  <button
                    type="button"
                    onClick={() => setEditing(expense)}
                    aria-label={`Edit ${expense.merchant || expense.category?.name || 'expense'}`}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                  >
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: theme.category(expense.category?.color ?? '#64748b') }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {expense.merchant || expense.category?.name || 'Expense'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {expense.category?.name} · {formatDate(expense.date, locale)}
                      {expense.isRecurring ? ' · recurring' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {/* The headline is the converted figure the API froze at the
                        transaction date's rate — the same number the totals and
                        charts sum. Reading amountMinor here would print riyals
                        under a dollar sign. */}
                    <p className="tabular text-sm font-medium">{money(expense.baseAmountMinor)}</p>
                    {expense.currency !== currency ? (
                      // Original shown when it differs, so a converted figure is
                      // never mistaken for what was paid.
                      <p className="tabular text-xs text-muted-foreground">
                        {formatMoney(expense.amountMinor, expense.currency, { locale })}
                      </p>
                    ) : null}
                  </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ExpenseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
        baseCurrency={currency}
        locale={locale}
        onSaved={() => {
          // An expense changes the dashboard, the budget and the AI's picture,
          // so invalidate the lot rather than just this list.
          void queryClient.invalidateQueries();
        }}
      />

      {/* Keyed on the row so the form remounts with the right values rather
          than carrying the previous expense's state into the next one. */}
      <ExpenseDialog
        key={editing?.id ?? 'none'}
        expense={editing ?? undefined}
        open={editing !== null}
        onOpenChange={(next) => (next ? undefined : setEditing(null))}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
        baseCurrency={currency}
        locale={locale}
        onSaved={() => {
          setEditing(null);
          void queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function ExpenseDialog({
  open,
  onOpenChange,
  categories,
  accounts,
  baseCurrency,
  locale,
  onSaved,
  expense,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Array<{ id: string; name: string }>;
  accounts: AccountDto[];
  /** What totals are reported in; the entry currency may differ. */
  baseCurrency: string;
  locale: string;
  onSaved: () => void;
  /**
   * The expense being edited, or undefined to record a new one. One component
   * serves both because the fields are the same fields — splitting them would
   * mean two places to keep the currency handling honest.
   */
  expense?: ExpenseDto;
}) {
  const editing = expense !== undefined;
  const [amount, setAmount] = useState('');
  const [entryCurrency, setEntryCurrency] = useEntryCurrency(baseCurrency);
  const [lastCategoryId, rememberCategory] = useLastCategory(categories.map((c) => c.id));
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const primaryAccountId = accounts.find((a) => a.isPrimary)?.id ?? accounts[0]?.id ?? null;
  // Held here rather than in the form, as the entry currency is: it arrives
  // asynchronously with the accounts query and is joined at submit. setValue on
  // a field absent from defaultValues did not reach the watch subscriber, which
  // left every new expense silently unassigned.
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<ExpenseInput>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      amountMinor: 0,
      currency: baseCurrency,
      categoryId: '',
      date: new Date().toISOString().slice(0, 10),
      isRecurring: false,
      tags: [],
    },
  });

  // Editing loads the row's own values, including the currency it was entered
  // in rather than the remembered one — an edit is about this expense, not
  // about what the next new entry should default to.
  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);
    if (expense) {
      setAmount(String(toMajorUnits(expense.amountMinor, expense.currency)));
      setEntryCurrency(expense.currency);
      reset({
        amountMinor: expense.amountMinor,
        currency: expense.currency,
        categoryId: expense.category?.id ?? '',
        date: expense.date.slice(0, 10),
        merchant: expense.merchant ?? '',
        notes: expense.notes ?? '',
        isRecurring: expense.isRecurring,
        tags: expense.tags ?? [],
      });
      setAccountId(expense.accountId);
    }
    // `expense` is the identity that matters; the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense?.id]);

  // The accounts query resolves after the dialog opens, so the default account
  // is applied when it arrives rather than when the dialog mounts — reading it
  // at mount time left every new expense unassigned, moving no balance.
  // Guarded on the field being untouched so it cannot override a real choice,
  // including a deliberate "not from a tracked account" on an existing row.
  useEffect(() => {
    if (!open || editing || !primaryAccountId) return;
    // Only while untouched, so it cannot override a deliberate choice. The
    // primaryAccountId guard matters: this effect first runs before the accounts
    // query resolves, and writing null then would settle the field at "no
    // account" before the real default ever arrived.
    setAccountId((current) => (current === undefined ? primaryAccountId : current));
  }, [open, editing, primaryAccountId]);

  // The remembered category arrives from storage after mount, so it is applied
  // here rather than in defaultValues. Guarded on the field being empty so it
  // can never overwrite a choice the user has already made in this dialog.
  useEffect(() => {
    if (open && lastCategoryId && !watch('categoryId')) {
      setValue('categoryId', lastCategoryId, { shouldValidate: true });
    }
  }, [open, lastCategoryId, setValue, watch]);

  const merchantValue = watch('merchant') ?? '';
  const chosenCategory = watch('categoryId') ?? '';
  // Keyed on the category, so switching it re-ranks the list rather than
  // offering names from the previous one. Kept fresh for a few minutes: a
  // merchant list changes slowly, and this fires on every keystroke.
  const merchantSuggestions = useQuery({
    queryKey: queryKeys.merchantSuggestions(chosenCategory, merchantValue),
    queryFn: () => fetchers.merchantSuggestions(chosenCategory, merchantValue),
    enabled: open,
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });

  const save = useMutation({
    mutationFn: (input: ExpenseInput) =>
      editing ? api.patch(`/expenses/${expense.id}`, input) : api.post('/expenses', input),
    onSuccess: () => {
      // Keep the currency they just used: the next expense is nearly always in
      // the same one.
      reset({
        amountMinor: 0,
        currency: entryCurrency,
        // Carried over with the currency: someone logging three things at the
        // till is usually logging three of the same kind of thing.
        categoryId: lastCategoryId ?? '',
        date: new Date().toISOString().slice(0, 10),
        isRecurring: false,
        tags: [],
      });
      setAmount('');
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that expense.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/expenses/${expense!.id}`),
    onSuccess: () => {
      setConfirmingDelete(false);
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not delete that expense.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    // The currency lives in component state rather than the form, so the two
    // are joined here. `useEntryCurrency` only ever yields a supported code,
    // which is what the schema's `currency` field accepts.
    // Only a new entry updates the remembered currency: correcting an old
    // expense recorded in another currency should not change what the next
    // fresh entry defaults to.
    save.mutate({ ...values, currency: entryCurrency, accountId: accountId ?? null });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit expense' : 'Add an expense'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change any detail, or delete it. The converted figure is recalculated at the rate for the date you set.'
              : 'Record what you spent and where.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <MoneyField
            id="amount"
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
            error={errors.amountMinor ? 'Enter an amount above zero.' : undefined}
            // A new entry is opened in order to type an amount, so the keypad
            // should already be up. An edit is usually opened to change
            // something else, and stealing focus there would fight the user.
            autoFocus={!editing}
          />

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select
              value={watch('categoryId')}
              onValueChange={(value) => {
                setValue('categoryId', value, { shouldValidate: true });
                if (!editing) rememberCategory(value);
              }}
            >
              <SelectTrigger id="category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.categoryId ? (
              <p className="text-sm text-destructive">Pick a category.</p>
            ) : null}
          </div>

          {accounts.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="expense-account">Paid from</Label>
              <Select
                value={accountId ?? 'none'}
                onValueChange={(v) => {
                  // Radix emits an empty value while its items register, which
                  // happens whenever this dialog opens on mount rather than on
                  // a click (/expenses?new=1). No item has an empty value, so
                  // it is never a real choice — taking it left the field blank
                  // and the request rejected as an invalid uuid.
                  if (!v) return;
                  setAccountId(v === 'none' ? null : v);
                }}
              >
                <SelectTrigger id="expense-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                  {/* Explicit, because "no account" is a real answer — cash from
                      a pocket, or a card Eco does not know about — and it has to
                      be distinguishable from having forgotten to choose. */}
                  <SelectItem value="none">Not from a tracked account</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="date">Date</Label>
            <Input id="date" type="date" {...register('date')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="merchant">Merchant (optional)</Label>
            {/* A native datalist rather than a custom dropdown: it suggests
                without hijacking the keyboard, stays fully typeable when the
                name is new, and behaves like the browser's own autofill on a
                phone — which is the interaction people already know. */}
            <Input
              id="merchant"
              placeholder="Tesco"
              list="merchant-suggestions"
              autoComplete="off"
              {...register('merchant')}
            />
            <datalist id="merchant-suggestions">
              {(merchantSuggestions.data ?? []).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            {editing && confirmingDelete ? (
              // Two-step rather than a browser confirm: the question names the
              // amount, so a mis-tap on the wrong row is visible before it
              // takes effect. The delete is soft on the server and reversible
              // by support, but not by the user, so it is worth a beat.
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Delete this {formatMoney(expense.amountMinor, expense.currency, { locale })}{' '}
                  expense?
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
                    {editing ? 'Save changes' : 'Save expense'}
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

export default function ExpensesPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ExpensesContent />
    </Suspense>
  );
}
