'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import {
  formatMoney,
  toMajorUnits,
  toMinorUnits,
  type BudgetDto,
  type CategoryDto,
  type PlannedPurchasesDto,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { useSelectedMonth } from '@/lib/use-selected-month';
import { formatMonth } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const STATUS_VARIANT = { UNDER: 'secondary', WARNING: 'warning', OVER: 'destructive' } as const;

export default function BudgetsPage() {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  // Shared with the Expenses list, so moving to August on one moves both.
  const [month, setMonth] = useSelectedMonth();
  const budget = useQuery({
    queryKey: queryKeys.budget(month),
    queryFn: () => fetchers.budget(month),
  });

  const categories = useQuery({ queryKey: queryKeys.categories, queryFn: fetchers.categories });
  const [editorOpen, setEditorOpen] = useState(false);
  const queryClient = useQueryClient();

  const data = budget.data;
  const projectedOver = data ? data.projectedSpendMinor > data.totalLimitMinor : false;

  return (
    <>
      <PageHeader
        title="Budgets"
        description="What you planned to spend, against what you actually have."
        actions={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, -1))}>
              ←
            </Button>
            <span className="min-w-[9rem] text-center text-sm font-medium">
              {formatMonth(month, locale)}
            </span>
            <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, 1))}>
              →
            </Button>
            <Button size="sm" className="ml-2" onClick={() => setEditorOpen(true)}>
              {data ? (
                <>
                  <Pencil className="size-4" aria-hidden />
                  Edit
                </>
              ) : (
                <>
                  <Plus className="size-4" aria-hidden />
                  Set budget
                </>
              )}
            </Button>
          </div>
        }
      />

      {/* Shown whether or not a budget exists for the month: planning what you
          intend to buy is useful on its own, and often precedes setting one. */}
      <PlannedPurchasesCard month={month} categories={categories.data ?? []} locale={locale} />

      {budget.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !data ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No budget set for {formatMonth(month, locale)}.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Eco can suggest limits from your last six months of spending.
            </p>
            <Button size="sm" className="mt-4" onClick={() => setEditorOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Set a budget
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-4 sm:p-6">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm text-muted-foreground">Spent this month</p>
                  <p className="tabular mt-1 text-3xl font-semibold">
                    {money(data.totalSpentMinor)}
                  </p>
                </div>
                <p className="tabular text-sm text-muted-foreground">
                  of {money(data.totalLimitMinor)}
                </p>
              </div>

              <Progress
                value={Math.min(data.utilisationPct, 100)}
                aria-label={`${data.utilisationPct.toFixed(0)}% of budget used`}
                indicatorStyle={{
                  background:
                    data.utilisationPct > 100
                      ? theme.negative
                      : data.utilisationPct >= data.alertThresholdPct
                        ? '#c87f00'
                        : theme.positive,
                }}
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {data.totalRemainingMinor >= 0
                    ? `${money(data.totalRemainingMinor)} left`
                    : `${money(-data.totalRemainingMinor)} over`}
                  {data.daysRemaining > 0 ? ` · ${data.daysRemaining} days to go` : ''}
                </span>
                <span className="tabular text-muted-foreground">
                  {data.utilisationPct.toFixed(0)}%
                </span>
              </div>

              {data.daysRemaining > 0 ? (
                <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {/* Recurring charges are excluded from the run rate, so this
                      does not read rent on the 1st as a daily habit. */}
                  On your current pace you will finish the month at{' '}
                  <strong className="tabular text-foreground">
                    {money(data.projectedSpendMinor)}
                  </strong>
                  {projectedOver
                    ? ` — about ${money(data.projectedSpendMinor - data.totalLimitMinor)} over budget.`
                    : ' — comfortably inside your budget.'}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">By category</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.lines.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No category limits set for this month.
                </p>
              ) : (
                data.lines.map((line) => {
                  const colour = theme.category(line.categoryColor);
                  return (
                    <div key={line.categoryId}>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: colour }}
                          />
                          <span className="truncate">{line.categoryName}</span>
                          {line.status !== 'UNDER' ? (
                            <Badge variant={STATUS_VARIANT[line.status]} className="shrink-0">
                              {line.status === 'OVER' ? 'over' : 'close'}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="tabular shrink-0 text-muted-foreground">
                          {money(line.spentMinor)} / {money(line.limitMinor)}
                        </span>
                      </div>
                      <Progress
                        value={Math.min(line.utilisationPct, 100)}
                        aria-label={`${line.categoryName}: ${line.utilisationPct.toFixed(0)}% used`}
                        indicatorStyle={{
                          background:
                            line.status === 'OVER'
                              ? theme.negative
                              : line.status === 'WARNING'
                                ? '#c87f00'
                                : colour,
                        }}
                      />
                      {line.rollover && line.rolloverFromPreviousMinor > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Includes {money(line.rolloverFromPreviousMinor)} carried over from last
                          month.
                        </p>
                      ) : null}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </>
      )}

      <BudgetEditor
        key={month}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        month={month}
        budget={data ?? undefined}
        categories={categories.data ?? []}
        currency={currency}
        locale={locale}
        onSaved={() => {
          setEditorOpen(false);
          // A budget changes the dashboard and the health score too.
          void queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

/**
 * Set or change a month's budget.
 *
 * The API is a single PUT that replaces the whole month, so this edits the
 * month as one object rather than sending per-line patches: a category left
 * blank is a category with no limit, and that has to be expressible.
 *
 * Amounts are typed in the base currency. A budget is a plan denominated in
 * whatever the user reports in, unlike an expense, which is a record of what a
 * particular receipt actually said — so there is no per-line currency picker.
 */
function BudgetEditor({
  open,
  onOpenChange,
  month,
  budget,
  categories,
  currency,
  locale,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  budget?: BudgetDto;
  categories: CategoryDto[];
  currency: string;
  locale: string;
  onSaved: () => void;
}) {
  const editing = budget !== undefined;
  // Keyed by category id, held as the raw text typed so a half-finished "12."
  // is a legal keystroke rather than an error.
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [threshold, setThreshold] = useState('80');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);
    const next: Record<string, string> = {};
    for (const line of budget?.lines ?? []) {
      next[line.categoryId] = String(toMajorUnits(line.limitMinor, currency));
    }
    setLimits(next);
    setThreshold(String(budget?.alertThresholdPct ?? 80));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budget?.id]);

  const suggestion = useMutation({
    mutationFn: () => fetchers.budgetSuggestion(month),
    onSuccess: (data) => {
      const next: Record<string, string> = {};
      for (const line of data.lines) {
        if (line.limitMinor > 0) next[line.categoryId] = String(toMajorUnits(line.limitMinor, currency));
      }
      // Replaces rather than merges: a suggestion is a coherent whole derived
      // from six months of history, and half of it mixed with half of an old
      // plan is neither.
      setLimits(next);
    },
    onError: () =>
      setFormError('Could not build a suggestion — there may not be enough history yet.'),
  });

  const lines = Object.entries(limits)
    .map(([categoryId, raw]) => ({ categoryId, limitMinor: toMinorUnits(Number(raw) || 0, currency) }))
    .filter((line) => line.limitMinor > 0);
  const totalLimitMinor = lines.reduce((sum, line) => sum + line.limitMinor, 0);

  const save = useMutation({
    mutationFn: () =>
      api.put('/budgets', {
        month,
        type: budget?.type ?? 'FIXED',
        currency,
        totalLimitMinor,
        alertThresholdPct: Number(threshold) || 80,
        lines: lines.map((line) => ({ ...line, rollover: false })),
      }),
    onSuccess: onSaved,
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that budget.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/budgets/${month}`),
    onSuccess: onSaved,
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not delete that budget.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit budget' : 'Set a budget'} · {formatMonth(month, locale)}
          </DialogTitle>
          <DialogDescription>
            A limit per category. Leave one blank to leave it unbudgeted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={suggestion.isPending}
            onClick={() => suggestion.mutate()}
          >
            {suggestion.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            Suggest from my history
          </Button>

          <div className="space-y-2">
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No categories yet — record an expense first and the categories will appear here.
              </p>
            ) : (
              categories.map((category) => (
                <div key={category.id} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: category.color }}
                  />
                  <Label htmlFor={`limit-${category.id}`} className="min-w-0 flex-1 truncate text-sm font-normal">
                    {category.name}
                  </Label>
                  <Input
                    id={`limit-${category.id}`}
                    inputMode="decimal"
                    placeholder="—"
                    className="w-28 text-right"
                    value={limits[category.id] ?? ''}
                    onChange={(e) =>
                      setLimits((prev) => ({ ...prev, [category.id]: e.target.value }))
                    }
                  />
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-3">
            <span className="text-sm font-medium">Total</span>
            <span className="tabular text-lg font-semibold">
              {formatMoney(totalLimitMinor, currency, { locale })}
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="threshold">Warn me at (% of budget)</Label>
            <Input
              id="threshold"
              inputMode="numeric"
              className="w-24"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing && confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Delete the budget for {formatMonth(month, locale)}?
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
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
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
                <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {editing ? 'Save changes' : 'Save budget'}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What you intend to buy this month, deliberately outside its budget.
 *
 * The distinction this screen has to make obvious: a planned purchase is a
 * decision, not money already gone. It moves no balance and counts as no
 * spending until it happens — so the totals are labelled "still to buy" rather
 * than anything that sounds like a figure you owe.
 *
 * Marking one bought is where the value is. The exclusion decided here gets
 * applied to the real expense then, instead of relying on someone remembering
 * a checkbox weeks later at a till.
 */
function PlannedPurchasesCard({
  month,
  categories,
  locale,
}: {
  month: string;
  categories: Array<{ id: string; name: string }>;
  locale: string;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string>('none');
  const [error, setError] = useState<string | null>(null);

  const planned = useQuery({
    queryKey: ['planned', month],
    queryFn: () => api.get<PlannedPurchasesDto>('/planned', { query: { month: `${month}-01` } }),
  });

  const refresh = () => void queryClient.invalidateQueries();

  const add = useMutation({
    mutationFn: () =>
      api.post('/planned', {
        name: name.trim(),
        // Entered in the currency actually spent, not the reporting one.
        amountMinor: toMinorUnits(Number(amount), planned.data?.currency ?? 'USD'),
        currency: planned.data?.currency ?? 'USD',
        month: `${month}-01`,
        ...(categoryId !== 'none' ? { categoryId } : {}),
      }),
    onSuccess: () => {
      setName('');
      setAmount('');
      setAdding(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add that.'),
  });

  const markBought = useMutation({
    mutationFn: (id: string) => api.post(`/planned/${id}/purchased`, {}),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/planned/${id}/cancel`, {}),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/planned/${id}`),
    onSuccess: refresh,
  });

  const data = planned.data;
  const money = (minor: number) => formatMoney(minor, data?.currency ?? 'USD', { locale });

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Planned purchases</CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-4" aria-hidden />
          Plan one
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <Input
              placeholder="What is it?"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="What are you planning to buy"
            />
            <Input
              placeholder={`Amount in ${data?.currency ?? ''}`}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount"
            />
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No category</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={add.isPending || !name.trim() || !Number(amount)}
              onClick={() => {
                setError(null);
                add.mutate();
              }}
            >
              {add.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Add to {formatMonth(month, locale)}
            </Button>
          </div>
        ) : null}

        {planned.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing planned for {formatMonth(month, locale)}. Things you add here are kept
            out of this month&apos;s budget.
          </p>
        ) : (
          <ul className="divide-y">
            {data!.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-medium ${
                      item.status === 'CANCELLED' ? 'text-muted-foreground line-through' : ''
                    }`}
                  >
                    {item.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.categoryName ?? 'No category'}
                    {item.excludeFromBudget ? ' · outside budget' : ' · counts toward budget'}
                    {item.status === 'PURCHASED' ? ' · bought' : ''}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm">
                  {formatMoney(item.amountMinor, item.currency, { locale })}
                </span>
                {item.status === 'PLANNED' ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Mark ${item.name} as bought`}
                      onClick={() => markBought.mutate(item.id)}
                    >
                      <Check className="size-4" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Cancel ${item.name}`}
                      onClick={() => cancel.mutate(item.id)}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => remove.mutate(item.id)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {data && data.items.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
            {/* "Still to buy", never anything that reads like a debt: none of
                this is money that has left yet. */}
            <span className="text-muted-foreground">Still to buy</span>
            <span className="tabular font-medium">{money(data.outstandingMinor)}</span>
          </div>
        ) : null}
        {data && data.outsideBudgetMinor > 0 ? (
          <p className="text-xs text-muted-foreground">
            {money(data.outsideBudgetMinor)} of that is set to stay outside this month&apos;s
            budget, so it will not count against your limits when you buy it.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
