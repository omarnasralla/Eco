'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  accountSchema,
  formatMoney,
  toMajorUnits,
  type AccountDto,
  type AccountInput,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { fetchers, queryKeys } from '@/lib/queries';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

export default function AccountsPage() {
  const { currency, locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountDto | null>(null);

  const summary = useQuery({
    queryKey: queryKeys.accountsSummary,
    queryFn: fetchers.accountsSummary,
  });

  // An account balance moves net worth, the health score and every screen that
  // reads either, so this refreshes broadly rather than just this list.
  const refreshAll = () => void queryClient.invalidateQueries();

  const accounts = summary.data?.accounts ?? [];

  return (
    <>
      <PageHeader
        title="Accounts"
        description="What you actually hold, as opposed to what comes in and goes out."
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

      {summary.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : accounts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No accounts yet. Adding one lets Eco show what you are holding now, not just what
              moved this month.
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Add an account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">Total held</p>
            <p className="tabular mt-2 text-3xl font-semibold">
              {formatMoney(summary.data?.totalMinor ?? 0, currency, { locale })}
            </p>
            {summary.data && summary.data.unconvertedCount > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {summary.data.unconvertedCount} account
                {summary.data.unconvertedCount === 1 ? '' : 's'} in a currency with no rate
                available {summary.data.unconvertedCount === 1 ? 'is' : 'are'} not counted here.
              </p>
            ) : null}
          </Card>

          <Card className="mt-4">
            <CardContent className="p-0">
              <ul className="divide-y">
                {accounts.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(account)}
                      aria-label={`Edit ${account.name}`}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate text-sm font-medium">
                          {account.name}
                          {account.isPrimary ? (
                            <Star className="size-3.5 shrink-0 text-muted-foreground" aria-label="Primary account" />
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {ACCOUNT_KIND_LABELS[account.kind]} ·{' '}
                          {account.movementCount > 0
                            ? `${account.movementCount} transaction${account.movementCount === 1 ? '' : 's'} since ${formatDate(account.openingBalanceDate, locale)}`
                            : `set ${formatDate(account.openingBalanceDate, locale)}`}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {/* Shown in the account's own currency: a balance is a
                            real amount in a real account, not a converted view. */}
                        <p
                          className={`tabular text-sm font-semibold ${
                            account.balanceMinor < 0 ? 'text-destructive' : ''
                          }`}
                        >
                          {formatMoney(account.balanceMinor, account.currency, { locale })}
                        </p>
                        {account.currency !== currency ? (
                          <p className="text-xs text-muted-foreground">{account.currency}</p>
                        ) : null}
                      </div>
                      <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <p className="mt-3 text-xs text-muted-foreground">
            Balances update themselves from the expenses and income you assign to each account. If
            one drifts from your bank, set it here and Eco takes that as the truth from then on.
          </p>
        </>
      )}

      <AccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        baseCurrency={currency}
        locale={locale}
        onSaved={refreshAll}
      />

      <AccountDialog
        key={editing?.id ?? 'none'}
        account={editing ?? undefined}
        open={editing !== null}
        onOpenChange={(next) => (next ? undefined : setEditing(null))}
        baseCurrency={currency}
        locale={locale}
        onSaved={() => {
          setEditing(null);
          refreshAll();
        }}
      />
    </>
  );
}

function AccountDialog({
  open,
  onOpenChange,
  baseCurrency,
  locale,
  onSaved,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseCurrency: string;
  locale: string;
  onSaved: () => void;
  account?: AccountDto;
}) {
  const editing = account !== undefined;
  const [balance, setBalance] = useState('');
  const [accountCurrency, setAccountCurrency] = useState(baseCurrency);
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<AccountInput>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: '',
      kind: 'CHECKING',
      currency: baseCurrency,
      balanceMinor: 0,
      isPrimary: false,
    },
  });

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setConfirmingDelete(false);
    if (account) {
      // The opening figure, not the derived balance: this field sets what the
      // balance was on the date below, and the movements since rebuild it.
      setBalance(String(toMajorUnits(account.openingBalanceMinor, account.currency)));
      setAccountCurrency(account.currency);
      setAsOf(account.openingBalanceDate);
      reset({
        name: account.name,
        kind: account.kind,
        currency: account.currency,
        balanceMinor: account.openingBalanceMinor,
        isPrimary: account.isPrimary,
      });
    } else {
      setBalance('');
      setAccountCurrency(baseCurrency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  const save = useMutation({
    mutationFn: (input: AccountInput) =>
      editing ? api.patch(`/accounts/${account.id}`, input) : api.post('/accounts', input),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not save that account.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/accounts/${account!.id}`),
    onSuccess: () => {
      setConfirmingDelete(false);
      onOpenChange(false);
      onSaved();
    },
    onError: (error) =>
      setFormError(error instanceof ApiError ? error.message : 'Could not remove that account.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit account' : 'Add an account'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Setting a balance is a correction: Eco takes it as true now, and carries on from there.'
              : 'An account and what is in it right now.'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit((values) => {
            setFormError(null);
            save.mutate({ ...values, currency: accountCurrency, openingBalanceDate: asOf });
          })}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="account-name">Name</Label>
            <Input id="account-name" placeholder="Main current account" {...register('name')} />
            {errors.name ? <p className="text-sm text-destructive">Give it a name.</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-kind">Kind</Label>
            <Select
              value={watch('kind')}
              onValueChange={(v) => setValue('kind', v as AccountInput['kind'])}
            >
              <SelectTrigger id="account-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {ACCOUNT_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <MoneyField
            id="account-balance"
            label="Balance"
            amount={balance}
            onAmountChange={(raw, minor) => {
              setBalance(raw);
              setValue('balanceMinor', minor, { shouldValidate: true });
            }}
            currency={accountCurrency}
            onCurrencyChange={setAccountCurrency}
            baseCurrency={baseCurrency}
            locale={locale}
            // A current account can be overdrawn, and refusing to record that
            // would make the balance people most need to see the one they
            // cannot enter.
            allowNegative
            autoFocus={!editing}
            hint={
              editing
                ? 'What your bank says it is now. Transactions since will carry on from this figure.'
                : 'What is in it right now. Use a minus sign if you are overdrawn.'
            }
          />

          <div className="space-y-2">
            <Label htmlFor="account-as-of">Balance as at</Label>
            <Input
              id="account-as-of"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Transactions from this date onward move the balance; anything earlier is taken as
              already included in the figure above. Back-date it to let an existing history build
              the balance up.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={watch('isPrimary')}
              onChange={(e) => setValue('isPrimary', e.target.checked)}
            />
            Treat this as my main account
          </label>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            {editing && confirmingDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Remove “{account.name}”?</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Remove
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
                    Remove
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
                    {editing ? 'Save changes' : 'Save account'}
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
