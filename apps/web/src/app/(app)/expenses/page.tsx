'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronLeft, ChevronRight, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import {
  expenseSchema,
  type AccountDto,
  formatMoney,
  toMajorUnits,
  type ExpenseDto,
  type ExpenseInput,
  type RenameMerchantResultDto,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useEntryCurrency } from '@/lib/entry-currency';
import { useLastCategory } from '@/lib/last-category';
import { useMoneyFormat } from '@/lib/auth-provider';
import { addMonths, currentMonth, monthRange, useSelectedMonth } from '@/lib/use-selected-month';
import { formatDate, formatMonth } from '@/lib/utils';
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

/**
 * ONE_TIME is deliberately absent: a one-off is what an unticked box already
 * means, and offering it as a cadence invites a row flagged as repeating with
 * a frequency that says it does not.
 */
const RECURRING_FREQUENCIES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Every two weeks' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
] as const;

function ExpensesContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>('all');
  // The "needs a category" notification links to ?review=1. Landing on the
  // full list and making the user find the filter would waste the one tap the
  // notification was for.
  const [reviewOnly, setReviewOnly] = useState(searchParams.get('review') === '1');
  const [month, setMonth] = useSelectedMonth();
  const [dialogOpen, setDialogOpen] = useState(searchParams.get('new') === '1');
  const [editing, setEditing] = useState<ExpenseDto | null>(null);
  const accounts = useQuery({ queryKey: queryKeys.accounts, queryFn: fetchers.accounts });

  const filters = useMemo(() => {
    // Reviewing is about captured rows wherever they landed, so it deliberately
    // ignores the month — a guessed category from three weeks ago still needs
    // answering, and hiding it behind a month arrow is how it never gets done.
    const range = reviewOnly ? null : monthRange(month);
    return {
      limit: 50,
      ...(range ? { from: range.from, to: range.to } : {}),
      ...(search ? { search } : {}),
      ...(categoryId !== 'all' ? { categoryId } : {}),
      ...(reviewOnly ? { needsReview: true } : {}),
      // Ordering by the date spent, not the order entered: a month's list is
      // read as a diary, and captures arrive out of order.
      sort: 'date' as const,
      order: 'desc' as const,
    };
  }, [search, categoryId, reviewOnly, month]);

  const categories = useQuery({ queryKey: queryKeys.categories, queryFn: fetchers.categories });
  // Paged rather than a single fetch: one month can easily pass the 50-row
  // page size — and did, which is why only part of the month was showing.
  const expenses = useInfiniteQuery({
    queryKey: queryKeys.expenses(filters),
    queryFn: ({ pageParam }) =>
      fetchers.expenses({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    // The API returns null once the list is exhausted, which is what stops it.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = useMemo(
    () => (expenses.data?.pages ?? []).flatMap((page) => page.items),
    [expenses.data],
  );

  // Fetch the next page when the end of the list comes into view. An observer
  // rather than a scroll handler: it fires once per crossing instead of on
  // every pixel, and it works the same inside the phone's momentum scrolling.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = expenses;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      // Start loading slightly before the end is reached, so the next rows are
      // usually there by the time the user arrives at them.
      { rootMargin: '300px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, items.length]);

  // Its own query rather than a count of the list above: the prompt has to be
  // visible while a filter is applied, and the list may be showing anything.
  const awaitingReview = useQuery({
    queryKey: queryKeys.expenses({ limit: 50, needsReview: true }),
    queryFn: () => fetchers.expenses({ limit: 50, needsReview: true }),
  });
  const reviewCount = awaitingReview.data?.items.length ?? 0;

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

      {/* Captured taps whose category was inferred. Shown as a prompt rather
          than a warning: nothing is wrong, and the money is already counted —
          someone just has not confirmed where it belongs. Opening one and
          saving it is the confirmation. */}
      {reviewCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-4 py-3">
          <p className="text-sm">
            <span className="font-medium">
              {reviewCount} captured expense{reviewCount === 1 ? '' : 's'}
            </span>{' '}
            {reviewCount === 1 ? 'was' : 'were'} filed under a guessed category.
          </p>
          <Button
            type="button"
            variant={reviewOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => setReviewOnly((on) => !on)}
          >
            {reviewOnly ? 'Show all' : 'Review them'}
          </Button>
        </div>
      ) : null}

      {/* The month being viewed, shared with Budgets so the two never disagree
          about which month "last month" means. Hidden while reviewing, since
          that view deliberately spans every month. */}
      {!reviewOnly ? (
        <div className="mb-4 flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(month, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <div className="text-center">
            <p className="text-sm font-medium">{formatMonth(month, locale)}</p>
            {month !== currentMonth() ? (
              <button
                type="button"
                onClick={() => setMonth(currentMonth())}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Back to this month
              </button>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next month"
            // Nothing is recorded in the future, so going past this month shows
            // an empty list and a dead end.
            disabled={month >= currentMonth()}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      ) : null}

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
          ) : items.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {search || categoryId !== 'all'
                ? 'No expenses match those filters.'
                : reviewOnly
                  ? 'Nothing is waiting for a category.'
                  : `No expenses in ${formatMonth(month, locale)}.`}
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((expense) => (
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
                      {expense.excludedFromBudget ? ' · outside budget' : ''}
                      {expense.needsReview ? ' · category guessed' : ''}
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
                  {/* One tap to file a guessed category, rather than opening
                      the row and saving it. Safari shows no action buttons on
                      a web push notification — not on iOS, not on macOS — so
                      the notification can only bring you here; this is what
                      makes arriving here worth the tap. Outside the button
                      above, since a button inside a button is not valid. */}
                  {expense.needsReview ? (
                    <CategoryChips
                      expense={expense}
                      categories={categories.data ?? []}
                      onDone={() => void queryClient.invalidateQueries()}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {/* Watched by the observer above; crossing it loads the next page. */}
          <div ref={sentinel} aria-hidden className="h-px" />
          {expenses.isFetchingNextPage ? (
            <p className="px-4 py-3 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />
              Loading more…
            </p>
          ) : !expenses.hasNextPage && items.length > 0 ? (
            // Says the list is complete rather than leaving the user wondering
            // whether more is still coming.
            <p className="px-4 py-3 text-center text-xs text-muted-foreground">
              {items.length} expense{items.length === 1 ? '' : 's'}
              {reviewOnly ? ' awaiting a category' : ` in ${formatMonth(month, locale)}`}
            </p>
          ) : null}
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
      recurringFrequency: 'MONTHLY',
      excludedFromBudget: false,
      tags: [],
    },
  });

  // Drives the frequency field's visibility; a cadence is meaningless
  // without the flag, and asking for one up front is noise on every one-off.
  const isRecurring = watch('isRecurring');

  // Editing loads the row's own values, including the currency it was entered
  // in rather than the remembered one — an edit is about this expense, not
  // about what the next new entry should default to.
  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);
    if (expense) {
      setAmount(String(toMajorUnits(expense.amountMinor, expense.currency)));
      // Not persisted: this is what the row was entered in, not a new default.
      setEntryCurrency(expense.currency, false);
      reset({
        amountMinor: expense.amountMinor,
        currency: expense.currency,
        categoryId: expense.category?.id ?? '',
        date: expense.date.slice(0, 10),
        merchant: expense.merchant ?? '',
        notes: expense.notes ?? '',
        isRecurring: expense.isRecurring,
        recurringFrequency: expense.recurringFrequency ?? 'MONTHLY',
        excludedFromBudget: expense.excludedFromBudget,
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
        recurringFrequency: 'MONTHLY',
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
            onCurrencyChange={(next) => setEntryCurrency(next, !editing)}
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
            {/* Only when editing, and only once the row has a merchant: this
                rewrites every expense that shares the name, which is a
                different act from correcting this one row. */}
            {expense && (expense.merchant ?? '').trim() ? (
              <RenameMerchantControl
                merchant={expense.merchant!}
                categories={categories}
                onDone={onSaved}
              />
            ) : null}
          </div>

          {/* Subscriptions and standing bills. Flagging one keeps it out of the
              day's discretionary limit — a monthly charge is not a day's
              choice — feeds "Coming up", and stops the month-end projection
              reading a single large charge as a daily rate. */}
          <div className="rounded-md border p-3">
            <div className="flex items-start gap-3">
              <input
                id="is-recurring"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                {...register('isRecurring')}
              />
              <div className="space-y-1">
                <Label htmlFor="is-recurring" className="font-normal">
                  Repeats
                </Label>
                <p className="text-xs text-muted-foreground">
                  A subscription or standing bill, not a one-off purchase.
                </p>
              </div>
            </div>

            {isRecurring ? (
              <div className="mt-3 space-y-2">
                <Label htmlFor="recurring-frequency">How often</Label>
                <Select
                  value={watch('recurringFrequency') ?? 'MONTHLY'}
                  onValueChange={(next) =>
                    next ? setValue('recurringFrequency', next as ExpenseInput['recurringFrequency']) : undefined
                  }
                >
                  <SelectTrigger id="recurring-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRING_FREQUENCIES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Counted from this date, so the next one is projected from here.
                </p>
              </div>
            ) : null}
          </div>

          {/* Not a way to make a bad month look good: the money still leaves
              the account and still counts in balances and net worth. It exists
              because a budget answers "am I pacing my discretionary spending?",
              and a reimbursable cost or a one-off transfer is real spending
              that answers a different question. Counting it reports the month
              as blown and drives every daily allowance to zero, which teaches
              people to distrust the budget rather than act on it. */}
          <div className="flex items-start gap-3 rounded-md border p-3">
            <input
              id="excluded-from-budget"
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              {...register('excludedFromBudget')}
            />
            <div className="space-y-1">
              <Label htmlFor="excluded-from-budget" className="font-normal">
                Keep out of budget limits
              </Label>
              <p className="text-xs text-muted-foreground">
                Still counted in your account balance and net worth — it just
                will not count against a budget.
              </p>
            </div>
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

/**
 * Rename a merchant across every expense that uses it.
 *
 * Spelling stopped being the user's choice the moment capture became
 * automatic: a shop typed as "Nwateh" arrives from the bank as "Nawateh", and
 * the same till produces "Motor Sports" and "MotorSports". Each spelling is a
 * separate merchant to every report and to the inference that decides a
 * captured expense's category — and until now the only way to reconcile them
 * was to edit the database by hand, which is exactly what happened twice in
 * one day.
 *
 * Renaming onto a name that already exists merges the two. That is the normal
 * case here, not an edge one, so the result says plainly which it was.
 */
function RenameMerchantControl({
  merchant,
  categories,
  onDone,
}: {
  merchant: string;
  categories: Array<{ id: string; name: string }>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(merchant);
  const [categoryId, setCategoryId] = useState<string>('keep');
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () =>
      api.post<RenameMerchantResultDto>('/expenses/merchants/rename', {
        from: merchant,
        to: to.trim(),
        ...(categoryId !== 'keep' ? { categoryId } : {}),
      }),
    onSuccess: onDone,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not rename that merchant.'),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Rename “{merchant}” everywhere
      </button>
    );
  }

  const target = to.trim();
  const unchanged = target.toLowerCase() === merchant.toLowerCase();

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">
        Renames every expense using “{merchant}”. If the new name already exists, the two are
        merged.
      </p>
      <Input
        value={to}
        onChange={(event) => setTo(event.target.value)}
        placeholder="New name"
        aria-label="New merchant name"
      />
      <Select value={categoryId} onValueChange={setCategoryId}>
        <SelectTrigger aria-label="Category to apply">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="keep">Keep existing categories</SelectItem>
          {categories.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              File all under {category.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        {/* Not a submit: this sits inside the expense form, and a submit here
            would save the expense instead of renaming anything. */}
        <Button
          type="button"
          size="sm"
          disabled={rename.isPending || !target || unchanged}
          onClick={() => {
            setError(null);
            rename.mutate();
          }}
        >
          {rename.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Rename everywhere
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * One-tap categorising for a captured expense whose category was guessed.
 *
 * This exists because of a hard platform limit: Safari renders no action
 * buttons on a web push notification, on iOS or macOS. The notification can
 * carry a title, a body and a destination, and nothing else — so "pick a
 * category from the notification" is not buildable, and the next best thing is
 * that arriving here costs one tap per expense instead of open-choose-save.
 *
 * Setting a category also teaches every future charge at that merchant, which
 * is why clearing one of these is worth more than it looks.
 */
function CategoryChips({
  expense,
  categories,
  onDone,
}: {
  expense: ExpenseDto;
  categories: Array<{ id: string; name: string }>;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const assign = useMutation({
    mutationFn: (categoryId: string) =>
      // The API clears needsReview on any edit by a human, so this both files
      // the expense and settles the question.
      api.patch(`/expenses/${expense.id}`, { categoryId }),
    onSuccess: onDone,
    onError: () => setError('Could not set that category.'),
  });

  return (
    <div className="px-4 pb-3">
      {error ? (
        <p role="alert" className="mb-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {/* Scrolls rather than wraps: on a phone a wrapping grid of thirteen
          chips pushes the next expense off the screen entirely. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {categories
          .filter((category) => category.id !== expense.categoryId)
          .map((category) => (
            <button
              key={category.id}
              type="button"
              disabled={assign.isPending}
              onClick={() => {
                setError(null);
                assign.mutate(category.id);
              }}
              className="shrink-0 rounded-full border px-3 py-1 text-xs transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50"
            >
              {category.name}
            </button>
          ))}
      </div>
    </div>
  );
}
