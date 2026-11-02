'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link2, Loader2, Pencil, Plus, Scale, Star, Trash2 } from 'lucide-react';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  accountSchema,
  formatMoney,
  toMajorUnits,
  toMinorUnits,
  type AccountDto,
  type AccountInput,
  type ReconciliationDto,
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
import { BalanceFlowCard } from '@/components/accounts/balance-flow-card';

export default function AccountsPage() {
  const { currency, locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountDto | null>(null);
  const [counting, setCounting] = useState<AccountDto | null>(null);

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
                  <li key={account.id} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => setEditing(account)}
                      aria-label={`Edit ${account.name}`}
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
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
                          {/* An anchored balance came from the bank, so saying
                              how many transactions built it would be a lie —
                              they did not build it, they only moved it since. */}
                          {account.anchor
                            ? `bank figure for ···${account.anchor.cardLast4}, ${formatDate(account.anchor.asOf, locale)}`
                            : account.movementCount > 0
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
                        {account.anchor ? (
                          <p className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                            <Link2 className="size-3" aria-hidden />
                            ···{account.anchor.cardLast4}
                          </p>
                        ) : null}
                      </div>
                      <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setCounting(account)}
                      aria-label={`Count the money in ${account.name}`}
                      title="Count what is really there"
                      className="shrink-0 border-l px-4 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <Scale className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <p className="mt-3 text-xs text-muted-foreground">
            Balances update themselves from the expenses and income you assign to each account.
            Counted the real money and it does not match? Use{' '}
            <Scale className="inline size-3" aria-hidden /> to enter what is actually there — the
            difference is recorded as a transaction, so the money is accounted for rather than
            quietly written off.
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

      {/* What the bank's own balance alerts say it costs to move money between
          these accounts — derived from the balances, since no message ever
          states a fee. */}
      <div className="mt-6 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Transfers and fees</h2>
        <BalanceFlowCard />
      </div>

      <ReconcileDialog
        key={`count-${counting?.id ?? 'none'}`}
        account={counting}
        open={counting !== null}
        onOpenChange={(next) => (next ? undefined : setCounting(null))}
        locale={locale}
        onSaved={refreshAll}
        onClose={() => setCounting(null)}
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
  const [balanceCard, setBalanceCard] = useState('');
  const [alertChannel, setAlertChannel] = useState('');
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
      setBalanceCard(account.balanceCardLast4 ?? '');
      setAlertChannel(account.alertChannel ?? '');
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
            save.mutate({
              ...values,
              currency: accountCurrency,
              openingBalanceDate: asOf,
              // Empty means "go back to computing it", which is a real
              // instruction — so it is sent as null rather than omitted.
              balanceCardLast4: balanceCard.length === 4 ? balanceCard : null,
              alertChannel: alertChannel || null,
            });
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

          {/* The balance can come from the bank instead of from adding
              movements up. Offered only when editing: a card has to have texted
              a balance before linking to it means anything, and that cannot be
              true of an account being created. */}
          {editing ? (
            <div className="space-y-2">
              <Label htmlFor="account-balance-card">Read the balance from a card</Label>
              <Input
                id="account-balance-card"
                inputMode="numeric"
                maxLength={4}
                placeholder="0115"
                value={balanceCard}
                onChange={(e) => setBalanceCard(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
              <p className="text-xs text-muted-foreground">
                Last four digits. When this card&apos;s bank texts a balance, that figure becomes
                this account&apos;s balance and only what you spend afterwards moves it — so a
                missed capture stops being permanent. Leave empty to add movements up instead.
              </p>
            </div>
          ) : null}

          {/* The one bank whose alerts name no card at all. Without this the
              money lands in the primary account, which is another bank in
              another country. */}
          {editing ? (
            <div className="space-y-2">
              <Label htmlFor="account-alert-channel">Bank alerts without a card number</Label>
              <Input
                id="account-alert-channel"
                placeholder="neo-request"
                maxLength={32}
                value={alertChannel}
                onChange={(e) => setAlertChannel(e.target.value.trim())}
              />
              <p className="text-xs text-muted-foreground">
                Most bank messages name the card, which is how Eco knows the account. For a bank
                that names none — Neo&apos;s &ldquo;sent you&rdquo; transfers — put its channel here
                so that money lands in this account. Leave empty unless you know you need it.
              </p>
            </div>
          ) : null}

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

/**
 * Reconcile an account against money counted by hand.
 *
 * The preview is the point. "Set the balance" already exists on the edit
 * dialog, and it reaches the same number by rewriting the opening figure —
 * which silently erases the discrepancy. This says what it is about to record,
 * in words, before it records it: a shortfall becomes spending, a surplus
 * becomes income, and either way the money is accounted for.
 */
function ReconcileDialog({
  account,
  open,
  onOpenChange,
  locale,
  onSaved,
  onClose,
}: {
  account: AccountDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [counted, setCounted] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconciliationDto | null>(null);

  useEffect(() => {
    if (!open) return;
    setCounted('');
    setNotes('');
    setDate(new Date().toISOString().slice(0, 10));
    setFormError(null);
    setResult(null);
  }, [open, account?.id]);

  const reconcile = useMutation({
    mutationFn: (countedMinor: number) =>
      api.post<ReconciliationDto>(`/accounts/${account!.id}/reconcile`, {
        actualBalanceMinor: countedMinor,
        date,
        notes: notes.trim() || null,
      }),
    onSuccess: (data) => {
      // Deliberately not closed on success: the whole point is to see what was
      // recorded. Closing would leave the user guessing whether it did anything.
      setResult(data);
      onSaved();
    },
    onError: (error) =>
      setFormError(
        error instanceof ApiError ? error.message : 'Could not reconcile that account.',
      ),
  });

  if (!account) return null;

  // Empty is not zero. Treating a blank box as "I counted nothing" would offer
  // to record the entire balance as spending the moment the dialog opens.
  const typed = counted.trim();
  const parsed = typed === '' ? null : Number(typed);
  const countedMinor =
    parsed === null || !Number.isFinite(parsed) ? null : toMinorUnits(parsed, account.currency);
  const difference = countedMinor === null ? null : countedMinor - account.balanceMinor;
  const money = (minor: number) => formatMoney(minor, account.currency, { locale });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Count {account.name}</DialogTitle>
          <DialogDescription>
            Enter what is really there. Eco records the difference as a transaction, so the balance
            matches reality and the money still shows up in your spending.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              {result.outcome === 'MATCHED' ? (
                <p>
                  Already matched at <span className="font-medium">{money(result.account.balanceMinor)}</span>.
                  Nothing was recorded.
                </p>
              ) : result.outcome === 'SHORTFALL' ? (
                <p>
                  Recorded <span className="font-medium">{money(Math.abs(result.differenceMinor))}</span> of
                  spending under <span className="font-medium">Reconciliation</span>. The balance is
                  now <span className="font-medium">{money(result.account.balanceMinor)}</span>.
                </p>
              ) : (
                <p>
                  Recorded <span className="font-medium">{money(result.differenceMinor)}</span> as one-off
                  income. The balance is now{' '}
                  <span className="font-medium">{money(result.account.balanceMinor)}</span>.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setFormError(null);
              if (countedMinor === null) {
                setFormError('Enter the amount you counted.');
                return;
              }
              reconcile.mutate(countedMinor);
            }}
            className="space-y-4"
            noValidate
          >
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Eco says</span>
              <span className="tabular font-medium">{money(account.balanceMinor)}</span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="counted">You counted ({account.currency})</Label>
              <Input
                id="counted"
                inputMode="decimal"
                autoFocus
                placeholder="0.00"
                value={counted}
                onChange={(event) => setCounted(event.target.value)}
              />
            </div>

            {difference !== null && difference !== 0 ? (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-sm">
                {difference < 0 ? (
                  <>
                    <span className="font-medium">{money(Math.abs(difference))}</span> is missing. It
                    will be recorded as spending under <span className="font-medium">Reconciliation</span>,
                    and counts toward your budgets.
                  </>
                ) : (
                  <>
                    <span className="font-medium">{money(difference)}</span> more than expected. It
                    will be recorded as one-off income.
                  </>
                )}
              </p>
            ) : null}

            {difference === 0 ? (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                That matches what Eco already has. Nothing will be recorded.
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="counted-on">Counted on</Label>
              <Input
                id="counted-on"
                type="date"
                value={date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="counted-notes">Note (optional)</Label>
              <Input
                id="counted-notes"
                placeholder="Cash counted at the end of the month"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>

            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={reconcile.isPending || countedMinor === null}>
                {reconcile.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {difference === 0 ? 'Check' : 'Record the difference'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
