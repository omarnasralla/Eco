'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import {
  GOAL_TYPES,
  GOAL_TYPE_LABELS,
  formatMoney,
  goalContributionSchema,
  savingsGoalSchema,
  type GoalContributionInput,
  type SavingsGoalDto,
  type SavingsGoalInput,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useEntryCurrency } from '@/lib/entry-currency';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { useChartTheme } from '@/components/charts/chart-theme';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
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
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

function GoalsContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();

  const [addOpen, setAddOpen] = useState(searchParams.get('new') === '1');
  const [contributeTo, setContributeTo] = useState<SavingsGoalDto | null>(null);

  const goals = useQuery({ queryKey: queryKeys.goals, queryFn: fetchers.goals });

  // Savings moves net worth and the health score as well as this page.
  const refreshAll = () => void queryClient.invalidateQueries();

  return (
    <>
      <PageHeader
        title="Savings goals"
        description="What you are putting money aside for."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

      {goals.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (goals.data?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No goals yet. An emergency fund is usually the right first one.
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Add your first goal
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {goals.data!.map((goal) => {
            const colour = theme.category(goal.color);
            const inGoalCurrency = (minor: number) =>
              formatMoney(minor, goal.currency, { locale });
            return (
              <Card key={goal.id}>
                <CardContent className="p-4 sm:p-6">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 font-medium">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: colour }}
                        />
                        <span className="truncate">{goal.name}</span>
                        {goal.status === 'ACHIEVED' ? (
                          <CheckCircle2
                            className="size-4 shrink-0"
                            style={{ color: theme.positive }}
                            aria-label="Achieved"
                          />
                        ) : null}
                      </h2>
                      {goal.deadline ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Target date {formatDate(goal.deadline, locale)}
                        </p>
                      ) : null}
                    </div>
                    {goal.status !== 'ACHIEVED' ? (
                      <Badge variant={goal.onTrack ? 'success' : 'warning'}>
                        {goal.onTrack ? 'on track' : 'behind'}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    {/* A goal keeps its own currency, so its balance and target
                        are shown in that one. Only the dashboard total is
                        converted to the base currency. */}
                    <span className="tabular text-xl font-semibold">
                      {inGoalCurrency(goal.currentAmountMinor)}
                    </span>
                    <span className="tabular text-sm text-muted-foreground">
                      of {inGoalCurrency(goal.targetAmountMinor)}
                    </span>
                  </div>

                  <Progress
                    value={goal.progressPct}
                    aria-label={`${goal.name}: ${goal.progressPct}% funded`}
                    indicatorStyle={{ background: colour }}
                  />

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {goal.progressPct}% funded
                      {goal.requiredMonthlyMinor !== null && goal.status !== 'ACHIEVED'
                        ? ` · needs ${inGoalCurrency(goal.requiredMonthlyMinor)}/month to hit the deadline`
                        : goal.projectedCompletionDate && goal.status !== 'ACHIEVED'
                          ? ` · on course to finish ${formatDate(goal.projectedCompletionDate, locale)}`
                          : ''}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setContributeTo(goal)}
                    >
                      <Plus className="size-4" aria-hidden />
                      Add money
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddGoalDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        baseCurrency={currency}
        locale={locale}
        onCreated={refreshAll}
      />

      <ContributeDialog
        goal={contributeTo}
        onClose={() => setContributeTo(null)}
        locale={locale}
        onSaved={refreshAll}
      />
    </>
  );
}

function AddGoalDialog({
  open,
  onOpenChange,
  baseCurrency,
  locale,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseCurrency: string;
  locale: string;
  onCreated: () => void;
}) {
  const [target, setTarget] = useState('');
  const [starting, setStarting] = useState('');
  const [goalCurrency, setGoalCurrency] = useEntryCurrency(baseCurrency);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<SavingsGoalInput>({
    resolver: zodResolver(savingsGoalSchema),
    defaultValues: {
      name: '',
      type: 'EMERGENCY_FUND',
      targetAmountMinor: 0,
      currentAmountMinor: 0,
      currency: baseCurrency,
      color: '#0ea5e9',
      icon: 'piggy-bank',
    },
  });

  const create = useMutation({
    mutationFn: (input: SavingsGoalInput) => api.post('/goals', input),
    onSuccess: () => {
      reset({
        name: '',
        type: 'EMERGENCY_FUND',
        targetAmountMinor: 0,
        currentAmountMinor: 0,
        currency: goalCurrency,
        color: '#0ea5e9',
        icon: 'piggy-bank',
      });
      setTarget('');
      setStarting('');
      onOpenChange(false);
      onCreated();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that goal.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    // The currency lives in component state rather than the form, so the two
    // are joined here. `useEntryCurrency` only ever yields a supported code,
    // which is what the schema's `currency` field accepts.
    create.mutate({ ...values, currency: goalCurrency });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New savings goal</DialogTitle>
          <DialogDescription>
            Something you are putting money aside for, and how much it needs.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="goal-name">Name</Label>
            <Input id="goal-name" placeholder="Emergency fund" {...register('name')} />
            {errors.name ? <p className="text-sm text-destructive">Give this goal a name.</p> : null}
          </div>

          <MoneyField
            id="goal-target"
            label="Target amount"
            amount={target}
            onAmountChange={(raw, minorUnits) => {
              setTarget(raw);
              setValue('targetAmountMinor', minorUnits, { shouldValidate: true });
            }}
            currency={goalCurrency}
            onCurrencyChange={setGoalCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            hint="The goal is kept in this currency. Payments into it can be in any currency."
            error={errors.targetAmountMinor ? 'Set a target above zero.' : undefined}
          />

          <MoneyField
            id="goal-starting"
            label="Already saved (optional)"
            amount={starting}
            onAmountChange={(raw, minorUnits) => {
              setStarting(raw);
              setValue('currentAmountMinor', minorUnits, { shouldValidate: true });
            }}
            // A starting balance is part of the goal, so it is denominated in
            // the goal's currency rather than picked separately.
            currency={goalCurrency}
            onCurrencyChange={setGoalCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            hint="What you have put aside for this already."
            error={errors.currentAmountMinor ? 'That looks implausible against the target.' : undefined}
          />

          <div className="space-y-2">
            <Label htmlFor="goal-type">Type</Label>
            <Select
              value={watch('type')}
              onValueChange={(value) =>
                setValue('type', value as SavingsGoalInput['type'], { shouldValidate: true })
              }
            >
              <SelectTrigger id="goal-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GOAL_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {GOAL_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-deadline">Target date (optional)</Label>
            <Input
              id="goal-deadline"
              type="date"
              // An untouched date input submits "", which is not a date. Map it
              // to null before validation so "no deadline" is expressible.
              {...register('deadline', { setValueAs: (v) => (v === '' ? null : v) })}
            />
            <p className="text-xs text-muted-foreground">
              With a date, Eco works out what you need to put aside each month.
            </p>
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
              Save goal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ContributeDialog({
  goal,
  onClose,
  locale,
  onSaved,
}: {
  goal: SavingsGoalDto | null;
  onClose: () => void;
  locale: string;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // The goal's own currency is the sensible default here — not the base
  // currency, and not the last one used for an expense.
  const [currency, setCurrency] = useState(goal?.currency ?? 'USD');

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<GoalContributionInput>({
    resolver: zodResolver(goalContributionSchema),
    defaultValues: { amountMinor: 0, date: new Date().toISOString().slice(0, 10) },
  });

  // The dialog is reused across goals, so each opening starts clean.
  useEffect(() => {
    if (!goal) return;
    setCurrency(goal.currency);
    setAmount('');
    setFormError(null);
    reset({
      amountMinor: 0,
      currency: goal.currency,
      date: new Date().toISOString().slice(0, 10),
    });
  }, [goal, reset]);

  const contribute = useMutation({
    mutationFn: (input: GoalContributionInput) =>
      api.post(`/goals/${goal!.id}/contributions`, input),
    onSuccess: () => {
      onClose();
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that payment.'),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    // Same joining as the other forms: the picker owns the currency, the form
    // owns everything else.
    contribute.mutate({ ...values, currency });
  });

  return (
    <Dialog open={goal !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add money</DialogTitle>
          <DialogDescription>
            {goal ? `Paying into ${goal.name}.` : null}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <MoneyField
            id="contribution-amount"
            label="Amount"
            amount={amount}
            onAmountChange={(raw, minorUnits) => {
              setAmount(raw);
              setValue('amountMinor', minorUnits, { shouldValidate: true });
            }}
            currency={currency}
            onCurrencyChange={setCurrency}
            // A payment is measured against the goal, so the conversion shown
            // is into the goal's currency rather than the account-wide one.
            baseCurrency={goal?.currency ?? 'USD'}
            locale={locale}
            error={errors.amountMinor ? 'Enter an amount above zero.' : undefined}
          />

          <div className="space-y-2">
            <Label htmlFor="contribution-date">Date</Label>
            <Input id="contribution-date" type="date" {...register('date')} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="contribution-notes">Notes (optional)</Label>
            <Input id="contribution-notes" placeholder="Monthly transfer" {...register('notes')} />
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={contribute.isPending}>
              {contribute.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add money
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function GoalsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <GoalsContent />
    </Suspense>
  );
}
