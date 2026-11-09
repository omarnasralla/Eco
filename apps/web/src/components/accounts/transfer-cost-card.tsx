'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { formatMoney, type TransferCostDto, type TransferCostsDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { useMoneyFormat } from '@/lib/auth-provider';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * What moving money between currencies cost — the part no message states.
 *
 * Beside the transfer-fee card on purpose: that card finds debits the bank
 * made without saying so, this one finds the margin inside the rate, and a
 * top-up can carry either or both. Shown only for moves whose two sides were
 * both seen; a half-known move is listed, but never priced.
 */
export function TransferCostCard() {
  const { locale } = useMoneyFormat();
  const costs = useQuery({
    queryKey: ['balance', 'transfer-costs'],
    queryFn: () => api.get<TransferCostsDto>('/balance/transfer-costs'),
  });

  if (costs.isLoading) return <Skeleton className="h-32 w-full" />;
  if (!costs.data?.items.length) return null;

  const money = (minor: number, currency: string) => formatMoney(minor, currency, { locale });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden />
          Exchange-rate costs
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          What you paid above the market rate when moving money between currencies. Not a fee
          the bank deducts — it is built into the rate you were given.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {costs.data.totals.map((total) => (
          <div key={total.currency} className="rounded-md bg-muted/40 p-3">
            <p className="text-sm text-muted-foreground">
              {total.moves} top-up{total.moves === 1 ? '' : 's'} ·{' '}
              {money(total.sentMinor, total.currency)} sent
            </p>
            <p className="tabular text-xl font-semibold">
              {money(total.costMinor, total.currency)}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {total.sentMinor > 0
                  ? `${((total.costMinor / (total.sentMinor - total.costMinor)) * 100).toFixed(2)}% on average`
                  : ''}
              </span>
            </p>
          </div>
        ))}

        <ul className="divide-y">
          {costs.data.items.map((item) => (
            <CostRow key={item.id} item={item} locale={locale} money={money} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CostRow({
  item,
  locale,
  money,
}: {
  item: TransferCostDto;
  locale: string;
  money: (minor: number, currency: string) => string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {item.fromAccount ?? '?'} → {item.toAccount ?? '?'}
        </p>
        <p className="break-words text-xs text-muted-foreground">
          {formatDate(item.occurredOn, locale)} ·{' '}
          {item.status === 'AWAITING_SENT'
            ? `${item.receivedMinor !== null && item.receivedCurrency ? money(item.receivedMinor, item.receivedCurrency) : ''} arrived; the bank has not said what left`
            : item.status === 'AWAITING_ARRIVAL'
              ? `${money(item.sentMinor, item.sentCurrency)} sent; ${item.toAccount ?? 'the wallet'} has not said what arrived`
              : `${money(item.sentMinor, item.sentCurrency)} for ${money(item.receivedMinor!, item.receivedCurrency!)} · ${item.effectiveRate} vs ${item.marketRate} market`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {item.status === 'COMPLETE' && item.costMinor !== null ? (
          <>
            <p className="tabular text-sm font-medium">{money(item.costMinor, item.sentCurrency)}</p>
            <p className="tabular text-xs text-muted-foreground">{item.costPct}%</p>
          </>
        ) : (
          <Badge variant="secondary">one side missing</Badge>
        )}
      </div>
    </li>
  );
}
