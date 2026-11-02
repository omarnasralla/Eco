'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, HandCoins, Loader2, Plus } from 'lucide-react';
import {
  formatMoney,
  toMinorUnits,
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
import { Skeleton } from '@/components/ui/skeleton';

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

  const settle = useMutation({
    mutationFn: (id: string) => api.patch(`/receivables/${id}`, { settled: true }),
    onSuccess: refreshAll,
  });

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
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={settle.isPending}
                      onClick={() => settle.mutate(item.id)}
                    >
                      <Check className="size-4" aria-hidden />
                      {item.outstandingMinor > 0 ? 'Write it off' : 'Mark settled'}
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

  const save = useMutation({
    mutationFn: () =>
      api.post(`/receivables/${receivable!.id}/payments`, {
        amountMinor: toMinorUnits(Number(amount), receivable!.currency),
        currency: receivable!.currency,
        date,
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
