'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus, Search } from 'lucide-react';
import { expenseSchema, formatMoney, type ExpenseInput } from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
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
import { MoneyInput } from '@/components/ui/money-input';
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
                <li key={expense.id} className="flex items-center gap-3 px-4 py-3">
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
                    {/* The headline figure is the *converted* amount, which is
                        what the ledger totals — formatting the entry amount with
                        the base currency's symbol would relabel 100 EUR as
                        $100.00 while the real converted value sat elsewhere. */}
                    <p className="tabular text-sm font-medium">
                      {money(expense.baseAmountMinor)}
                    </p>
                    {expense.currency !== currency ? (
                      // What was actually paid, in the currency it was paid in.
                      // This figure never moves: it is the receipt, not a view.
                      <p className="tabular text-xs text-muted-foreground">
                        {formatMoney(expense.amountMinor, expense.currency, { locale })} paid
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddExpenseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={categories.data ?? []}
        currency={currency}
        locale={locale}
        onCreated={() => {
          // An expense changes the dashboard, the budget and the AI's picture,
          // so invalidate the lot rather than just this list.
          void queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function AddExpenseDialog({
  open,
  onOpenChange,
  categories,
  currency,
  locale,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Array<{ id: string; name: string }>;
  /** The account's base currency; entries are converted into it. */
  currency: string;
  locale: string;
  onCreated: () => void;
}) {
  const [amount, setAmount] = useState('');
  // The currency the user types in, which need not be their base currency —
  // the API converts at the transaction date's rate and freezes the result.
  const [entryCurrency, setEntryCurrency] = useState(currency);
  const [formError, setFormError] = useState<string | null>(null);

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
      currency,
      categoryId: '',
      date: new Date().toISOString().slice(0, 10),
      isRecurring: false,
      tags: [],
    },
  });

  const create = useMutation({
    mutationFn: (input: ExpenseInput) => api.post('/expenses', input),
    onSuccess: () => {
      reset();
      setAmount('');
      setEntryCurrency(currency);
      onOpenChange(false);
      onCreated();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that expense.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    create.mutate(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an expense</DialogTitle>
          <DialogDescription>Record what you spent and where.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <MoneyInput
              id="amount"
              amount={amount}
              onAmountChange={setAmount}
              entryCurrency={entryCurrency}
              onCurrencyChange={(next) => {
                setEntryCurrency(next);
                setValue('currency', next, { shouldValidate: true });
              }}
              onMinorChange={(minor) =>
                setValue('amountMinor', minor, { shouldValidate: true })
              }
              baseCurrency={currency}
              locale={locale}
              date={watch('date')}
            />
            {errors.amountMinor ? (
              <p className="text-sm text-destructive">Enter an amount above zero.</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select
              value={watch('categoryId')}
              onValueChange={(value) => setValue('categoryId', value, { shouldValidate: true })}
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

          <div className="space-y-2">
            <Label htmlFor="date">Date</Label>
            <Input id="date" type="date" {...register('date')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="merchant">Merchant (optional)</Label>
            <Input id="merchant" placeholder="Tesco" {...register('merchant')} />
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
              Save expense
            </Button>
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
