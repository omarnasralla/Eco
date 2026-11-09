import { Injectable } from '@nestjs/common';
import { buildFlow, moveCost, type BalanceCheckpoint } from '@eco/core';
import type { BalanceFlowDto, TransferCostDto, TransferCostsDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import { requireIsoDate } from '../../common/utils/dates';

@Injectable()
export class BalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * What each move between currencies cost, beyond any fee the chain finds.
   *
   * The two are different money and are kept apart: a fee is a debit the
   * bank made without saying so, found as a gap in its balances; this is the
   * margin inside the rate, found by valuing what arrived at the market. A
   * top-up can carry either, both, or neither.
   *
   * Valued at the rate stored for the move's own date, so a cost does not
   * restate itself as the market moves afterwards.
   */
  async transferCosts(userId: string): Promise<TransferCostsDto> {
    const rows = await this.prisma.transfer.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
      include: {
        fromAccount: { select: { name: true, currency: true } },
        toAccount: { select: { name: true, currency: true } },
      },
    });

    const items: TransferCostDto[] = [];
    const totals = new Map<string, { costMinor: number; sentMinor: number; moves: number }>();

    for (const row of rows) {
      const fromCurrency = row.fromAccount?.currency ?? null;
      const toCurrency = row.toAccount?.currency ?? row.receivedCurrency ?? null;
      // Only moves that change currency carry a rate to price.
      if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) continue;

      const occurredOn = requireIsoDate(row.occurredOn);
      const sentMinor = toNumber(row.amountMinor);
      const receivedMinor = row.receivedMinor === null ? null : toNumber(row.receivedMinor);
      const base = {
        id: row.id,
        occurredOn,
        fromAccount: row.fromAccount?.name ?? null,
        toAccount: row.toAccount?.name ?? null,
        sentMinor,
        sentCurrency: row.currency,
        receivedMinor,
        receivedCurrency: row.receivedCurrency,
        costMinor: null,
        costPct: null,
        effectiveRate: null,
        marketRate: null,
      };

      // A sent side in anything but the sending account's currency is the
      // destination's guess at it, not a figure the bank stated.
      if (row.currency !== fromCurrency) {
        items.push({ ...base, status: 'AWAITING_SENT' });
        continue;
      }
      if (receivedMinor === null || !row.receivedCurrency) {
        items.push({ ...base, status: 'AWAITING_ARRIVAL' });
        continue;
      }

      const fairSentMinor = await this.currency.convertForDisplay(
        receivedMinor,
        row.receivedCurrency,
        row.currency,
        occurredOn,
      );
      const cost = moveCost({
        sentMinor,
        sentCurrency: row.currency,
        receivedMinor,
        receivedCurrency: row.receivedCurrency,
        fairSentMinor,
      });
      items.push({ ...base, status: 'COMPLETE', ...(cost ?? {}) });

      if (cost) {
        const total = totals.get(row.currency) ?? { costMinor: 0, sentMinor: 0, moves: 0 };
        total.costMinor += cost.costMinor;
        total.sentMinor += sentMinor;
        total.moves += 1;
        totals.set(row.currency, total);
      }
    }

    return {
      items,
      totals: [...totals].map(([currency, t]) => ({ currency, ...t })),
    };
  }

  /**
   * Every card's balance chain, newest movement last.
   *
   * The arithmetic lives in @eco/core and is pure; this loads the rows, names
   * the account, and supplies the salary figure the classification needs — so
   * what the gaps mean is tested without a database.
   */
  async flow(userId: string): Promise<BalanceFlowDto[]> {
    const rows = await this.prisma.balanceCheckpoint.findMany({
      where: { userId },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
      include: { account: { select: { name: true } } },
    });
    if (rows.length === 0) return [];

    const checkpoints: BalanceCheckpoint[] = rows.map((row) => ({
      id: row.id,
      cardLast4: row.cardLast4,
      currency: row.currency,
      amountMinor: toNumber(row.amountMinor),
      direction: row.direction,
      statedBalanceMinor: toNumber(row.statedBalanceMinor),
      merchant: row.merchant,
      occurredOn: requireIsoDate(row.occurredOn),
      recordedAt: row.createdAt.toISOString(),
    }));

    // Whichever account claims the card. Read from the rows rather than looked
    // up again: a card moved between accounts should still name the account
    // the movement was actually filed against.
    const accountFor = new Map<string, string>();
    for (const row of rows) {
      if (row.account && !accountFor.has(row.cardLast4)) {
        accountFor.set(row.cardLast4, row.account.name);
      }
    }

    // The salary on file is what lets the biggest credits be named rather than
    // left as "money arrived from somewhere". Largest active monthly source: a
    // chain like this receives one salary, and summing several would set the
    // bar too high for any of them to match.
    const salary = await this.prisma.incomeSource.findFirst({
      where: { userId, isActive: true, frequency: 'MONTHLY' },
      orderBy: { amountMinor: 'desc' },
      select: { amountMinor: true, currency: true },
    });

    // One salary figure per currency, since a chain is compared in its own.
    const currencies = [...new Set(checkpoints.map((c) => c.currency))];
    const salaryFor = new Map<string, number>();
    if (salary) {
      for (const currency of currencies) {
        salaryFor.set(
          currency,
          salary.currency === currency
            ? toNumber(salary.amountMinor)
            : await this.currency.convertForDisplay(
                toNumber(salary.amountMinor),
                salary.currency,
                currency,
              ),
        );
      }
    }

    // Built per currency so each chain is classified against its own salary
    // figure. buildFlow still splits by card within that.
    return currencies.flatMap((currency) => {
      const expected = salaryFor.get(currency);
      return buildFlow(
        checkpoints.filter((c) => c.currency === currency),
        expected,
      ).map((summary) => ({
        cardLast4: summary.cardLast4,
        currency: summary.currency,
        accountName: accountFor.get(summary.cardLast4) ?? null,
        steps: summary.steps.map((step) => ({
          id: step.checkpoint.id,
          occurredOn: step.checkpoint.occurredOn,
          merchant: step.checkpoint.merchant,
          amountMinor: step.checkpoint.amountMinor,
          direction: step.checkpoint.direction,
          statedBalanceMinor: step.checkpoint.statedBalanceMinor,
          openingBalanceMinor: step.openingBalanceMinor,
          expectedBalanceMinor: step.expectedBalanceMinor,
          gapMinor: step.gapMinor,
          kind: step.kind,
        })),
        statedOutMinor: summary.statedOutMinor,
        feesMinor: summary.feesMinor,
        unexplainedDebitsMinor: summary.unexplainedDebitsMinor,
        salaryMinor: summary.salaryMinor,
        salaryShortfallMinor: summary.salaryShortfallMinor,
        expectedSalaryMinor: expected ?? null,
        unexplainedCreditsMinor: summary.unexplainedCreditsMinor,
        closingBalanceMinor: summary.closingBalanceMinor,
        closingOn: summary.closingOn,
        blindSteps: summary.blindSteps,
      }));
    });
  }
}
