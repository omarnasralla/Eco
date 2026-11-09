'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Hourglass, Loader2, Plus, Trash2, Undo2, X } from 'lucide-react';
import {
  CURRENCIES,
  formatMoney,
  parseAmountInput,
  toMinorUnits,
  type WantDto,
  type WantsDto,
  type WorkRateDto,
} from '@eco/shared';
import { api, ApiError } from '@/lib/api-client';
import { useAuth, useMoneyFormat } from '@/lib/auth-provider';
import { workTimeLabel } from '@/lib/work-time';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { safeConvert, useExchangeRates } from '@/components/ui/money-field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const WAITS = [
  { hours: 24, label: '1 day' },
  { hours: 48, label: '2 days' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
] as const;

/** Re-renders once a minute, so a countdown never sits stale on screen. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The cooling-off list.
 *
 * Something you are tempted by goes here instead of into a basket, and cannot
 * be marked bought until its wait is over. Most impulses do not survive two
 * days; the ones that do were wants all along.
 */
export default function WantsPage() {
  const { locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const wants = useQuery({ queryKey: ['wants'], queryFn: () => api.get<WantsDto>('/wants') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['wants'] });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'buy' | 'skip' | 'reopen' }) =>
      api.post(`/wants/${id}/${action}`),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/wants/${id}`),
    onSuccess: refresh,
  });

  const data = wants.data;
  const ready = data?.items.filter((w) => w.status === 'READY') ?? [];
  const cooling = data?.items.filter((w) => w.status === 'COOLING') ?? [];
  const decided = data?.items.filter((w) => w.status === 'BOUGHT' || w.status === 'SKIPPED') ?? [];

  const row = (want: WantDto) => (
    <WantRow
      key={want.id}
      want={want}
      rate={data?.rate}
      locale={locale}
      now={now}
      busy={decide.isPending || remove.isPending}
      onDecide={(action) => decide.mutate({ id: want.id, action })}
      onRemove={() => remove.mutate(want.id)}
    />
  );

  return (
    <>
      <PageHeader
        title="Cooling off"
        description="Wait before you buy. If you still want it when the time is up, it was worth it."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        }
      />

      <div className="space-y-4">
        {data ? <WorkHoursPrompt rate={data.rate} /> : null}

        {data && data.skippedMinor > 0 ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Not spent, by letting things go</p>
              <p className="tabular mt-0.5 text-xl font-semibold">
                {formatMoney(data.skippedMinor, data.currency, { locale })}
              </p>
              {workTimeLabel(data.skippedMinor, data.rate) ? (
                <p className="text-sm text-muted-foreground">
                  {workTimeLabel(data.skippedMinor, data.rate)} of work you kept
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {wants.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !data?.items.length ? (
          <Card>
            <CardContent className="space-y-2 p-6 text-center">
              <Hourglass className="mx-auto size-6 text-muted-foreground" aria-hidden />
              <p className="font-medium">Nothing cooling off</p>
              <p className="text-sm text-muted-foreground">
                Next time something catches your eye, add it here instead of buying it. Eco will
                tell you when the wait is over.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {ready.length > 0 ? (
              <Section title="Ready to decide">{ready.map(row)}</Section>
            ) : null}
            {cooling.length > 0 ? <Section title="Cooling off">{cooling.map(row)}</Section> : null}
            {decided.length > 0 ? <Section title="Decided">{decided.map(row)}</Section> : null}
          </>
        )}
      </div>

      <AddWantDialog
        open={adding}
        rate={data?.rate}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          refresh();
        }}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function WantRow({
  want,
  rate,
  locale,
  now,
  busy,
  onDecide,
  onRemove,
}: {
  want: WantDto;
  rate: WorkRateDto | undefined;
  locale: string;
  now: number;
  busy: boolean;
  onDecide: (action: 'buy' | 'skip' | 'reopen') => void;
  onRemove: () => void;
}) {
  const time = workTimeLabel(want.baseAmountMinor, rate);
  const decided = want.status === 'BOUGHT' || want.status === 'SKIPPED';

  return (
    <div className={`rounded-md border p-3 ${decided ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium">
            <span className="truncate">{want.name}</span>
            {want.url ? (
              <a
                href={want.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open the link for ${want.name}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
            {want.status === 'BOUGHT' ? (
              <Badge variant="secondary" className="shrink-0">
                Bought
              </Badge>
            ) : want.status === 'SKIPPED' ? (
              <Badge variant="success" className="shrink-0">
                Let go
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {want.status === 'COOLING'
              ? countdown(want.readyAt, now, locale)
              : want.status === 'READY'
                ? 'The wait is over'
                : `Decided ${formatDate(want.decidedAt ?? want.createdAt, locale)}`}
          </p>
          {want.note ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">{want.note}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular font-medium">
            {formatMoney(want.amountMinor, want.currency, { locale })}
          </p>
          {time ? <p className="text-xs text-muted-foreground">{time} of work</p> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {want.status === 'READY' ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide('buy')}>
              <Check className="size-4" aria-hidden />
              I still want it
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('skip')}>
              <X className="size-4" aria-hidden />
              Let it go
            </Button>
          </>
        ) : want.status === 'COOLING' ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('skip')}>
            <X className="size-4" aria-hidden />
            Let it go now
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('reopen')}>
              <Undo2 className="size-4" aria-hidden />
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${want.name}`}
              onClick={onRemove}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** "Ready in 31 h", or the day and time once it is more than a day away. */
function countdown(readyAt: string, now: number, locale: string): string {
  const ms = new Date(readyAt).getTime() - now;
  const hours = ms / 3_600_000;
  if (hours < 1) return `Ready in ${Math.max(1, Math.ceil(ms / 60_000))} min`;
  if (hours < 36) return `Ready in ${Math.ceil(hours)} h`;
  return `Ready ${new Date(readyAt).toLocaleString(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * Asks for the one figure work time needs. Shown until it is given, and
 * explains itself when the hours are set but there is no income to divide.
 */
function WorkHoursPrompt({ rate }: { rate: WorkRateDto }) {
  const { refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState('40');

  const save = useMutation({
    mutationFn: () => api.patch('/users/me', { workHoursPerWeek: Number(hours) }),
    onSuccess: async () => {
      await refreshUser();
      await queryClient.invalidateQueries({ queryKey: ['wants'] });
    },
  });

  if (rate.workHoursPerWeek && rate.hourlyMinor) return null;

  if (rate.workHoursPerWeek && !rate.hourlyMinor) {
    return (
      <p className="text-sm text-muted-foreground">
        Add your income to see prices as hours of work.
      </p>
    );
  }

  const valid = Number.isInteger(Number(hours)) && Number(hours) >= 1 && Number(hours) <= 100;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="font-medium">See prices as time</p>
          <p className="text-sm text-muted-foreground">
            How many hours do you work in a normal week? Eco divides your income by it, so a price
            reads as the hours it took to earn.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="work-hours">Hours a week</Label>
            <Input
              id="work-hours"
              inputMode="numeric"
              className="w-28"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!valid || save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AddWantDialog({
  open,
  rate,
  onClose,
  onSaved,
}: {
  open: boolean;
  rate: WorkRateDto | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { currency: baseCurrency } = useMoneyFormat();
  const rates = useExchangeRates();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(baseCurrency);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [coolOffHours, setCoolOffHours] = useState<number>(48);
  const [error, setError] = useState<string | null>(null);

  // Reset on every open: a half-typed want from last time is not this one.
  useEffect(() => {
    if (!open) return;
    setName('');
    setAmount('');
    setCurrency(baseCurrency);
    setUrl('');
    setNote('');
    setCoolOffHours(48);
    setError(null);
  }, [open, baseCurrency]);

  const parsed = parseAmountInput(amount);
  const minor = parsed && parsed > 0 ? toMinorUnits(parsed, currency) : null;
  const base = minor === null ? null : safeConvert(minor, currency, baseCurrency, rates.data?.rates);
  const preview = base === null ? null : workTimeLabel(base, rate);

  const save = useMutation({
    mutationFn: () =>
      api.post('/wants', {
        name: name.trim(),
        amountMinor: minor,
        currency,
        url: url.trim() || null,
        note: note.trim() || null,
        coolOffHours,
      }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add that.'),
  });

  const valid = name.trim().length > 0 && minor !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Something you want</DialogTitle>
          <DialogDescription>
            It waits here first. You can only mark it bought once the time is up.
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
            <Label htmlFor="want-name">What</Label>
            <Input
              id="want-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Noise-cancelling headphones"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="want-amount">Price</Label>
              <Input
                id="want-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="w-28 space-y-2">
              <Label htmlFor="want-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="want-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {preview ? (
            <p className="text-sm text-muted-foreground">
              That is <span className="font-medium text-foreground">{preview}</span> of work.
            </p>
          ) : null}

          <div className="space-y-2">
            <Label>Wait</Label>
            <div className="flex flex-wrap gap-2">
              {WAITS.map((wait) => (
                <Button
                  key={wait.hours}
                  type="button"
                  size="sm"
                  variant={coolOffHours === wait.hours ? 'default' : 'outline'}
                  onClick={() => setCoolOffHours(wait.hours)}
                >
                  {wait.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="want-url">Link</Label>
            <Input
              id="want-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="want-note">Why you want it</Label>
            <Input
              id="want-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Worth reading again when the wait is over"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Start the wait
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
