'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cake, Loader2, Plus, Trash2 } from 'lucide-react';
import type { BirthdayDto } from '@eco/shared';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Shown without asking; the rest are one tap away. */
const SOON_DAYS = 30;

/**
 * Birthdays, soonest first. The briefing mentions one the morning it falls and
 * during the week before — early enough to buy a present, which is what the
 * note field is for.
 */
export function BirthdaysCard() {
  const { locale } = useMoneyFormat();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const birthdays = useQuery({
    queryKey: ['birthdays'],
    queryFn: () => api.get<BirthdayDto[]>('/birthdays'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['birthdays'] });
    void queryClient.invalidateQueries({ queryKey: ['briefing'] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/birthdays/${id}`),
    onSuccess: refresh,
  });

  const all = birthdays.data ?? [];
  const soon = all.filter((b) => b.daysUntil <= SOON_DAYS);
  const shown = showAll ? all : soon;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cake className="size-4 text-muted-foreground" aria-hidden />
            Birthdays
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {birthdays.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : all.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add the birthdays you never want to miss. You will hear about each one the week
              before and on the day.
            </p>
          ) : (
            <>
              {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None in the next {SOON_DAYS} days.
                </p>
              ) : (
                <ul className="divide-y">
                  {shown.map((b) => (
                    <li key={b.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{b.name}</span>
                          {b.daysUntil === 0 ? (
                            <Badge variant="success" className="shrink-0">
                              Today
                            </Badge>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {b.daysUntil === 0
                            ? 'Today'
                            : b.daysUntil === 1
                              ? 'Tomorrow'
                              : `In ${b.daysUntil} days · ${formatDate(b.nextDate, locale)}`}
                          {b.turning ? ` · turns ${b.turning}` : ''}
                          {b.note ? ` · ${b.note}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Forget ${b.name}'s birthday`}
                        onClick={() => remove.mutate(b.id)}
                        disabled={remove.isPending}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {all.length > soon.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-0"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show the next month only' : `Show all ${all.length}`}
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <AddBirthdayDialog
        open={adding}
        locale={locale}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          refresh();
        }}
      />
    </>
  );
}

function AddBirthdayDialog({
  open,
  locale,
  onClose,
  onSaved,
}: {
  open: boolean;
  locale: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [month, setMonth] = useState('1');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setMonth(String(new Date().getMonth() + 1));
    setDay('');
    setYear('');
    setNote('');
    setError(null);
  }, [open]);

  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2000, i, 1)).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' }),
  );

  const save = useMutation({
    mutationFn: () =>
      api.post('/birthdays', {
        name: name.trim(),
        month: Number(month),
        day: Number(day),
        year: year.trim() ? Number(year) : null,
        note: note.trim() || null,
      }),
    onSuccess: onSaved,
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? e.validationMessages.join(' ') || e.message
          : 'Could not save that birthday.',
      ),
  });

  const valid = name.trim().length > 0 && Number(day) >= 1 && Number(day) <= 31;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a birthday</DialogTitle>
          <DialogDescription>
            The year is optional — with it, Eco tells you how old they turn.
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
            <Label htmlFor="bday-name">Who</Label>
            <Input
              id="bday-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Their name"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="bday-month">Month</Label>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger id="bday-month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((label, i) => (
                    <SelectItem key={label} value={String(i + 1)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-20 space-y-2">
              <Label htmlFor="bday-day">Day</Label>
              <Input
                id="bday-day"
                inputMode="numeric"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </div>
            <div className="w-24 space-y-2">
              <Label htmlFor="bday-year">Year</Label>
              <Input
                id="bday-year"
                inputMode="numeric"
                placeholder="—"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bday-note">Gift ideas</Label>
            <Input
              id="bday-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Shown with the reminder"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
