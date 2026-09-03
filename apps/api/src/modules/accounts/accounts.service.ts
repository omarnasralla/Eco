import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AccountDto, AccountInput, AccountsSummaryDto, UpdateAccountInput } from '@eco/shared';
import type { FinancialAccount } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';

function toDto(account: FinancialAccount, balanceMinor: number, movements: number): AccountDto {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind as AccountDto['kind'],
    currency: account.currency,
    openingBalanceMinor: toNumber(account.openingBalanceMinor),
    openingBalanceDate: account.openingBalanceDate.toISOString().slice(0, 10),
    balanceMinor,
    movementCount: movements,
    isPrimary: account.isPrimary,
    updatedAt: account.updatedAt.toISOString(),
    createdAt: account.createdAt.toISOString(),
  };
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  async findAll(userId: string): Promise<AccountDto[]> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return Promise.all(accounts.map((account) => this.withBalance(account)));
  }

  /**
   * The live balance: the opening figure plus everything assigned to the
   * account since that date.
   *
   * Computed on read rather than kept as a running total. A stored total has to
   * be adjusted on every create, edit and delete, and any missed path leaves it
   * quietly wrong for good; deriving it means an edited expense moves the
   * balance by exactly what it moved it by, and a deleted one un-moves it.
   *
   * Sums are grouped by currency in the database and converted once per
   * currency rather than once per row. Cross-currency movements convert at
   * today's rate, not the transaction's: a balance is a position held now, and
   * what a past purchase would be worth today is the honest way to express a
   * foreign-currency movement inside an account denominated in something else.
   * The overwhelmingly common case — spending from an account in its own
   * currency — needs no conversion at all.
   */
  private async withBalance(account: FinancialAccount): Promise<AccountDto> {
    const { net, count } = await this.movementsSince(account);
    return toDto(account, toNumber(account.openingBalanceMinor) + net, count);
  }

  /**
   * The net effect of everything assigned to the account since its opening
   * date, in the account's own currency.
   *
   * Sums are grouped by currency in the database and converted once per
   * currency rather than once per row. Cross-currency movements convert at
   * today's rate, not the transaction's: a balance is a position held now, so
   * what a foreign-currency purchase is worth today is the honest way to
   * express it inside an account denominated in something else. The
   * overwhelmingly common case — spending from an account in its own currency
   * — needs no conversion at all.
   */
  private async movementsSince(
    account: FinancialAccount,
  ): Promise<{ net: number; count: number }> {
    const since = account.openingBalanceDate;

    const [spent, received] = await Promise.all([
      this.prisma.expense.groupBy({
        by: ['currency'],
        where: { accountId: account.id, deletedAt: null, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.incomeReceipt.groupBy({
        by: ['currency'],
        where: { accountId: account.id, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
    ]);

    let net = 0;
    let count = 0;
    for (const [rows, sign] of [
      [spent, -1],
      [received, 1],
    ] as const) {
      for (const row of rows) {
        count += row._count._all;
        const amount = toNumber(row._sum.amountMinor ?? BigInt(0));
        net +=
          sign *
          (row.currency === account.currency
            ? amount
            : await this.currency.convertForDisplay(amount, row.currency, account.currency));
      }
    }
    return { net, count };
  }

  /**
   * Every balance in the user's base currency.
   *
   * Converted per account rather than summed raw: accounts can be held in
   * different currencies, and adding a riyal balance to a dollar one produces a
   * number that is money in neither. An account whose currency has no rate is
   * counted separately and reported, not folded in at face value.
   */
  async summary(userId: string, userCurrency: string): Promise<AccountsSummaryDto> {
    const accounts = await this.findAll(userId);

    const needsRates = accounts.some((a) => a.currency !== userCurrency);
    // Fetched once rather than per account: a user with six accounts should
    // not cause six lookups of the same day's table.
    const rates = needsRates ? (await this.currency.getRates()).rates : {};

    let totalMinor = 0;
    let unconvertedCount = 0;
    for (const account of accounts) {
      if (account.currency === userCurrency) {
        totalMinor += account.balanceMinor;
        continue;
      }
      // convertForDisplay falls back to face value when no rate exists, which
      // here would quietly add riyals to dollars. A headline balance is the
      // wrong place for that fallback, so a missing rate is reported instead.
      if (rates[account.currency] === undefined) {
        unconvertedCount += 1;
        continue;
      }
      totalMinor += await this.currency.convertForDisplay(
        account.balanceMinor,
        account.currency,
        userCurrency,
      );
    }

    return { totalMinor, currency: userCurrency, unconvertedCount, accounts };
  }

  async findOne(userId: string, id: string): Promise<AccountDto> {
    const account = await this.prisma.financialAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Account not found');
    return this.withBalance(account);
  }

  async create(userId: string, input: AccountInput): Promise<AccountDto> {
    const account = await this.prisma.$transaction(async (tx) => {
      // Exactly one primary account, so the dashboard has an unambiguous
      // "your main account" to point at.
      if (input.isPrimary) {
        await tx.financialAccount.updateMany({
          where: { userId, deletedAt: null },
          data: { isPrimary: false },
        });
      }
      const isFirst =
        (await tx.financialAccount.count({ where: { userId, deletedAt: null } })) === 0;
      return tx.financialAccount.create({
        data: {
          userId,
          name: input.name,
          kind: input.kind,
          currency: input.currency,
          openingBalanceMinor: BigInt(input.balanceMinor),
          openingBalanceDate: new Date(),
          // The first account is primary whether or not the box was ticked:
          // one account and no primary is a state with no useful meaning.
          isPrimary: input.isPrimary || isFirst,
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return this.withBalance(account);
  }

  async update(userId: string, id: string, input: UpdateAccountInput): Promise<AccountDto> {
    const existing = await this.prisma.financialAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');

    const account = await this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.financialAccount.updateMany({
          where: { userId, deletedAt: null, id: { not: id } },
          data: { isPrimary: false },
        });
      }
      return tx.financialAccount.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.balanceMinor !== undefined
            ? { openingBalanceMinor: BigInt(await this.openingFor(existing, input.balanceMinor)) }
            : {}),
          ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return this.withBalance(account);
  }

  /**
   * The opening figure that makes the derived balance equal what the user just
   * said the balance is.
   *
   * Setting a balance is a reconciliation — "the bank says it is this" — so it
   * has to land on that number exactly. Moving the opening *date* to today
   * cannot achieve that: a transaction dated today would still be counted on
   * top of the correction, so reconciling to 500 after spending 30 today read
   * 470. Solving for the opening instead keeps every movement in the ledger and
   * still lands on the stated figure, and leaves `openingBalanceMinor` meaning
   * exactly what it says — the balance as at the opening date.
   */
  private async openingFor(account: FinancialAccount, targetMinor: number): Promise<number> {
    const { net } = await this.movementsSince(account);
    return targetMinor - net;
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.financialAccount.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date(), isPrimary: false },
    });
    if (count === 0) throw new NotFoundException('Account not found');

    // Deleting the primary leaves no primary, so the oldest survivor takes it.
    const remaining = await this.prisma.financialAccount.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (remaining && !remaining.isPrimary) {
      await this.prisma.financialAccount.update({
        where: { id: remaining.id },
        data: { isPrimary: true },
      });
    }

    await this.redis.invalidateUser(userId);
  }

  /** Total cash in the base currency, for the dashboard's net worth. */
  async totalBalance(userId: string, userCurrency: string): Promise<number> {
    const { totalMinor } = await this.summary(userId, userCurrency);
    return totalMinor;
  }
}
