import { Injectable } from '@nestjs/common';
import { buildFlow, type BalanceCheckpoint } from '@eco/core';
import type { BalanceFlowDto } from '@eco/shared';
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
