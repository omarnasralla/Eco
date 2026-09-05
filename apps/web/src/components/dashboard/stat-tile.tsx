'use client';

import type { LucideIcon } from 'lucide-react';
import { formatMoney } from '@eco/shared';
import { useMoneyFormat } from '@/lib/auth-provider';
import { useChartTheme } from '@/components/charts/chart-theme';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A single headline figure.
 *
 * The delta uses green/red — the one place this app leans on the finance
 * convention — but it never travels alone: an arrow glyph and an explicit sign
 * carry the direction, so the meaning survives colour-vision deficiency,
 * greyscale printing and forced-colours mode.
 *
 * `invertDelta` exists because "up" is not always "good": rising income is
 * positive, rising expenses is not.
 */
export function StatTile({
  label,
  valueMinor,
  deltaPct,
  invertDelta = false,
  icon: Icon,
  hint,
  loading = false,
  className,
}: {
  label: string;
  valueMinor: number;
  deltaPct?: number | null;
  invertDelta?: boolean;
  icon?: LucideIcon;
  hint?: string;
  loading?: boolean;
  className?: string;
}) {
  const { currency, locale } = useMoneyFormat();
  const theme = useChartTheme();

  if (loading) {
    return (
      <Card className={cn('p-4', className)}>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-3 h-7 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </Card>
    );
  }

  const hasDelta = deltaPct !== undefined && deltaPct !== null && Math.abs(deltaPct) >= 0.1;
  const rising = (deltaPct ?? 0) > 0;
  const good = invertDelta ? !rising : rising;

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
      </div>

      <p className="tabular mt-2 text-2xl font-semibold tracking-tight">
        {formatMoney(valueMinor, currency, { locale })}
      </p>

      {hasDelta ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs">
          <span aria-hidden style={{ color: good ? theme.positive : theme.negative }}>
            {rising ? '▲' : '▼'}
          </span>
          <span className="tabular font-medium" style={{ color: good ? theme.positive : theme.negative }}>
            {rising ? '+' : ''}
            {deltaPct!.toFixed(1)}%
          </span>
          <span className="text-muted-foreground">vs last month</span>
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </Card>
  );
}
