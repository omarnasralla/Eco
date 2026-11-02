import { Injectable } from '@nestjs/common';
import { buildFlow, type BalanceCheckpoint } from '@eco/core';
import type { BalanceFlowDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toNumber } from '../../common/utils/money';
import { requireIsoDate } from '../../common/utils/dates';

@Injectable()
export class BalanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every card's balance chain, newest movement last.
   *
   * The arithmetic lives in @eco/core and is pure; this only loads the rows
   * and names the account, so what the gaps mean is tested without a database.
   */
  async flow(userId: string): Promise<BalanceFlowDto[]> {
    const rows = await this.prisma.balanceCheckpoint.findMany({
      where: { userId },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
      include: { account: { select: { name: true } } },
    });

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

    return buildFlow(checkpoints).map((summary) => ({
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
      unexplainedCreditsMinor: summary.unexplainedCreditsMinor,
      closingBalanceMinor: summary.closingBalanceMinor,
      closingOn: summary.closingOn,
      blindSteps: summary.blindSteps,
    }));
  }
}
