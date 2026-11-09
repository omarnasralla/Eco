'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, HandCoins, Loader2, Plus } from 'lucide-react';
import {
  formatMoney,
  toMinorUnits,
  type AccountsSummaryDto,
  type ReceivableDto,
  type ReceivablesSummaryDto,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
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
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The accounts a returning loan can land in.
 *
 * Shared by both dialogs below, because "which account did it go into" is the
 * same question whether the money came back in instalments or all at once.
 */
function useAccountOptions() {
  const accounts = useQuery({
    queryKey: ['accounts', 'summary'],
    queryFn: () => api.get<AccountsSummaryDto>('/accounts/summary'),
  });
  const list = accounts.data?.accounts ?? [];
  return { list, primaryId: list.find((a) => a.isPrimary)?.id ?? list[0]?.id ?? null };
}

/** The account picker, identical in both dialogs. */
function AccountPicker({
  id,
  value,
  onChange,
  accounts,
}: {
  id: string;
  value: string | null;
  onChange: (next: string | null) => void;
  accounts: { id: string; name: string }[];
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Deposited into</Label>
      <Select
        value={value ?? 'none'}
        onValueChange={(v) => {
          // Radix emits '' while items register; no item has that value.
          if (!v) return;
          onChange(v === 'none' ? null : v);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
          <SelectItem value="none">Not into a tracked account</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        The money has to arrive somewhere. Name the account and its balance goes up by this
        much; leave it untracked and the loan is cleared with nothing to show for it.
      </p>
    </div>
  );
}

/**
 * Money lent to people, and what has come back.
 *
 * On the debts page because it is the same question pointed the other way, and
 * separating them would hide that one offsets the other. It is NOT a negative
 * debt though: a loan out raises net worth, and every total that reads `debts`
 * would be wrong if it lived there.
 */
export function LentOutCard() {
  const { currency, locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [repaying, setRepaying] = useState<ReceivableDto | null>(null);

  const lent = useQuery({
    queryKey: ['receivables'],
    queryFn: () => api.get<ReceivablesSummaryDto>('/receivables'),
  });

  // A loan moves net worth and the dashboard reads it, so this refreshes
  // broadly rather than just this list.
  const refreshAll = () => void queryClient.invalidateQueries();

  const [settling, setSettling] = useState<ReceivableDto | null>(null);

  const data = lent.data;
  const money = (minor: number, cur = data?.currency ?? currency) =>
    formatMoney(minor, cur, { locale });

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <HandCoins className="size-4 text-muted-foreground" aria-hidden />
              Lent out
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {data && data.outstandingMinor > 0
                ? `${money(data.outstandingMinor)} still owed to you by ${data.peopleOwing} ${
                    data.peopleOwing === 1 ? 'person' : 'people'
                  }`
                : 'Money you have lent is still yours — it counts towards net worth.'}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Lend
          </Button>
        </CardHeader>

        <CardContent className="space-y-2">
          {lent.isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : !data?.items.length ? (
            <p className="text-sm text-muted-foreground">
              Nothing lent out. When you lend someone money, record it here so it is not mistaken
              for spending.
            </p>
          ) : (
            data.items.map((item) => (
              <div key={item.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-medium">
                      {item.person}
                      {item.settled ? (
                        <Badge variant="secondary" className="shrink-0">
                          Settled
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {money(item.principalMinor, item.currency)} lent{' '}
                      {formatDate(item.lentOn, locale)}
                      {item.accountName ? ` from ${item.accountName}` : ''}
                    </p>
                    {item.note ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.note}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-medium tabular-nums">
                      {money(item.outstandingMinor, item.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.repaidMinor > 0
                        ? `${money(item.repaidMinor, item.currency)} back`
                        : 'nothing back yet'}
                    </p>
                  </div>
                </div>

                {/* Shown only once something has come back: an empty bar on a
                    fresh loan reads as a failure rather than a start. */}
                {item.repaidPct > 0 ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${item.repaidPct}%` }}
                    />
                  </div>
                ) : null}

                {!item.settled ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setRepaying(item)}>
                      Record a repayment
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSettling(item)}>
                      <Check className="size-4" aria-hidden />
                      {item.outstandingMinor > 0 ? 'Close it off' : 'Mark settled'}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <LendDialog
        open={adding}
        onClose={() => setAdding(false)}
        baseCurrency={currency}
        onSaved={() => {
          setAdding(false);
          refreshAll();
        }}
      />

      <SettleDialog
        key={`settle-${settling?.id ?? 'none'}`}
        receivable={settling}
        locale={locale}
        onClose={() => setSettling(null)}
        onSaved={() => {
          setSettling(null);
          refreshAll();
        }}
      />

      <RepayDialog
        key={repaying?.id ?? 'none'}
        receivable={repaying}
        locale={locale}
        onClose={() => setRepaying(null)}
        onSaved={() => {
          setRepaying(null);
          refreshAll();
        }}
      />
    </>
  );
}

function LendDialog({
  open,
  onClose,
  baseCurrency,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  baseCurrency: string;
  onSaved: () => void;
}) {
  const [person, setPerson] = useState('');
  const [amount, setAmount] = useState('');
  const [lentOn, setLentOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.post('/receivables', {
        person: person.trim(),
        amountMinor: toMinorUnits(Number(amount), baseCurrency),
        currency: baseCurrency,
        lentOn,
        note: note.trim() || null,
      }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record that loan.'),
  });

  const valid = person.trim().length > 0 && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lend money</DialogTitle>
          <DialogDescription>
            Money you have lent is not spending — it is still yours, just held by someone else.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="lend-person">Who</Label>
            <Input
              id="lend-person"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              placeholder="Their name"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lend-amount">How much ({baseCurrency})</Label>
            <Input
              id="lend-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lend-date">When</Label>
            <Input
              id="lend-date"
              type="date"
              value={lentOn}
              onChange={(e) => setLentOn(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lend-note">Note</Label>
            <Input
              id="lend-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What it was for"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Record it
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Closing a loan off, with the one question the old button never asked.
 *
 * "Settled" covered two opposite endings. Either the money came back — in
 * which case it landed in an account and belongs in that balance — or it is
 * not coming back, which is a loss. The old action silently chose neither: it
 * cleared what you were owed and credited nothing, so being repaid and being
 * stiffed moved net worth by exactly the same amount, downwards.
 *
 * So the ending is asked for, and only the first of them names an account.
 */
function SettleDialog({
  receivable,
  locale,
  onClose,
  onSaved,
}: {
  receivable: ReceivableDto | null;
  locale: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<'repaid' | 'writtenOff'>('repaid');
  const [error, setError] = useState<string | null>(null);
  const { list: accounts, primaryId } = useAccountOptions();
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!primaryId) return;
    setAccountId((current) => (current === undefined ? primaryId : current));
  }, [primaryId]);

  const outstanding = receivable?.outstandingMinor ?? 0;

  const save = useMutation({
    mutationFn: async () => {
      // The repayment goes first. If it fails the loan stays open, which is
      // recoverable; settling first and then failing to record the money
      // would lose it with no sign that anything went wrong.
      if (outcome === 'repaid' && outstanding > 0) {
        await api.post(`/receivables/${receivable!.id}/payments`, {
          amountMinor: outstanding,
          currency: receivable!.currency,
          date: new Date().toISOString().slice(0, 10),
          accountId: accountId ?? null,
        });
      }
      await api.patch(`/receivables/${receivable!.id}`, { settled: true });
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not close that loan.'),
  });

  const money = (minor: number) =>
    formatMoney(minor, receivable?.currency ?? 'USD', { locale });

  return (
    <Dialog open={receivable !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close off {receivable?.person}</DialogTitle>
          <DialogDescription>
            {outstanding > 0
              ? `${money(outstanding)} is still outstanding. What happened to it?`
              : 'Everything has come back already, so this just marks it done.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {outstanding > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="settle-outcome">What happened</Label>
              <Select
                value={outcome}
                onValueChange={(v) => {
                  if (!v) return;
                  setOutcome(v as 'repaid' | 'writtenOff');
                }}
              >
                <SelectTrigger id="settle-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="repaid">I got the {money(outstanding)} back</SelectItem>
                  <SelectItem value="writtenOff">
                    Writing it off — it is not coming back
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {outstanding > 0 && outcome === 'repaid' ? (
            <AccountPicker
              id="settle-account"
              value={accountId ?? null}
              onChange={setAccountId}
              accounts={accounts}
            />
          ) : null}

          {outstanding > 0 && outcome === 'writtenOff' ? (
            <p className="text-xs text-muted-foreground">
              {money(outstanding)} comes off what you are owed and lands in no account, because
              it is gone. Your net worth falls by that much, which is what happened.
            </p>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {outstanding > 0 && outcome === 'writtenOff' ? 'Write it off' : 'Close it off'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepayDialog({
  receivable,
  locale,
  onClose,
  onSaved,
}: {
  receivable: ReceivableDto | null;
  locale: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const { list: accounts, primaryId } = useAccountOptions();
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  // Defaults to the primary account once it is known, while leaving a
  // deliberate choice of "none" alone.
  useEffect(() => {
    if (!primaryId) return;
    setAccountId((current) => (current === undefined ? primaryId : current));
  }, [primaryId]);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/receivables/${receivable!.id}/payments`, {
        amountMinor: toMinorUnits(Number(amount), receivable!.currency),
        currency: receivable!.currency,
        date,
        accountId: accountId ?? null,
      }),
    onSuccess: onSaved,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not record that repayment.'),
  });

  return (
    <Dialog open={receivable !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Money back from {receivable?.person}</DialogTitle>
          <DialogDescription>
            {receivable
              ? `${formatMoney(receivable.outstandingMinor, receivable.currency, {
                  locale,
                })} still owed.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="repay-amount">How much ({receivable?.currency})</Label>
            <Input
              id="repay-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="repay-date">When</Label>
            <Input
              id="repay-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <AccountPicker
            id="repay-account"
            value={accountId ?? null}
            onChange={setAccountId}
            accounts={accounts}
          />

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="submit" disabled={Number(amount) <= 0 || save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Record it
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
