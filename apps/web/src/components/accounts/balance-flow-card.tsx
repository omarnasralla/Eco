'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CircleHelp, Info } from 'lucide-react';
import { formatMoney, type BalanceFlowDto, type FlowStepDto } from '@eco/shared';
import { fetchers, queryKeys } from '@/lib/queries';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * What a card's bank alerts add up to.
 *
 * The bank states a balance after every movement but never states its fee.
 * Subtract the movement from the previous balance and whatever is left over is
 * money that moved without being announced — which is what a fee is. So this
 * reads the chain rather than the messages, and every fee here is derived
 * arithmetic, not something a bank reported.
 */
export function BalanceFlowCard() {
  const flows = useQuery({ queryKey: queryKeys.balanceFlow, queryFn: fetchers.balanceFlow });

  if (flows.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Nothing to show until a bank that states balances has sent one. Saying so
  // beats an empty table, which reads as a bug.
  if (!flows.data?.length) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4">
          <h2 className="font-medium">Transfer fees</h2>
          <p className="text-sm text-muted-foreground">
            No balance alerts captured yet. When a bank texts you a balance after a
            transaction, the fee it did not mention is worked out here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {flows.data.map((flow) => (
        <FlowChain key={`${flow.cardLast4}-${flow.currency}`} flow={flow} />
      ))}
    </div>
  );
}

function FlowChain({ flow }: { flow: BalanceFlowDto }) {
  const money = (minor: number) => formatMoney(minor, flow.currency);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">
            Card ···{flow.cardLast4}
            {flow.accountName ? (
              <span className="text-muted-foreground"> · {flow.accountName}</span>
            ) : null}
          </h2>
          {flow.closingBalanceMinor !== null && flow.closingOn ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {money(flow.closingBalanceMinor)} on {formatDate(flow.closingOn)}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Moved" value={money(flow.statedOutMinor)} />
          <Stat label="Fees" value={money(flow.feesMinor)} tone="warn" />
          <Stat label="Arrived" value={money(flow.unexplainedCreditsMinor)} tone="good" />
          <Stat
            label="Unexplained"
            value={money(flow.unexplainedDebitsMinor)}
            tone={flow.unexplainedDebitsMinor > 0 ? 'bad' : undefined}
          />
        </div>

        <ol className="space-y-2">
          {flow.steps.map((step) => (
            <Step key={step.id} step={step} currency={flow.currency} />
          ))}
        </ol>

        {flow.blindSteps > 0 ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {flow.blindSteps === 1 ? 'One movement has' : `${flow.blindSteps} movements have`} no
              earlier balance to be checked against, so{' '}
              {flow.blindSteps === 1 ? 'its fee is' : 'their fees are'} not in these totals.
            </span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-destructive'
          : '';
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-medium tabular-nums ${colour}`}>{value}</p>
    </div>
  );
}

/** One movement, with what the balance says it really cost. */
function Step({ step, currency }: { step: FlowStepDto; currency: string }) {
  const money = (minor: number) => formatMoney(minor, currency);
  const left = step.direction < 0;

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{step.merchant}</p>
          <p className="text-xs text-muted-foreground">{formatDate(step.occurredOn)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="flex items-center justify-end gap-1 font-medium tabular-nums">
            {left ? (
              <ArrowDownRight className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <ArrowUpRight className="size-4 text-emerald-600" aria-hidden />
            )}
            {money(step.amountMinor)}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            balance {money(step.statedBalanceMinor)}
          </p>
        </div>
      </div>
      <GapLine step={step} currency={currency} />
    </li>
  );
}

/**
 * The line that does the work: what the balance should have been, what it was,
 * and therefore what the bank took without saying so.
 */
function GapLine({ step, currency }: { step: FlowStepDto; currency: string }) {
  const money = (minor: number) => formatMoney(minor, currency);
  const gap = Math.abs(step.gapMinor ?? 0);

  if (step.kind === 'UNKNOWN') {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleHelp className="size-3.5 shrink-0" aria-hidden />
        No earlier balance — nothing to check this against
      </p>
    );
  }

  if (step.kind === 'EXACT') {
    return <p className="mt-2 text-xs text-muted-foreground">Balance lands exactly — no fee</p>;
  }

  if (step.kind === 'FEE') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-amber-700 dark:text-amber-400">
          Fee {money(gap)}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          expected {money(step.expectedBalanceMinor ?? 0)}, bank said{' '}
          {money(step.statedBalanceMinor)}
        </span>
      </div>
    );
  }

  if (step.kind === 'UNEXPLAINED_CREDIT') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-400">
          +{money(gap)} arrived
        </Badge>
        <span className="text-xs text-muted-foreground">
          money came in here with no alert — a salary, a refund or a transfer
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Badge variant="destructive">{money(gap)} unaccounted</Badge>
      <span className="text-xs text-muted-foreground">
        too large to be a fee — a message for this is probably missing
      </span>
    </div>
  );
}
