import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AccountDto, AccountInput, AccountsSummaryDto, UpdateAccountInput } from '@eco/shared';
import type { FinancialAccount } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';

function toDto(account: FinancialAccount): AccountDto {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind as AccountDto['kind'],
    currency: account.currency,
    balanceMinor: toNumber(account.balanceMinor),
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
    return accounts.map(toDto);
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
    return toDto(account);
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
          balanceMinor: BigInt(input.balanceMinor),
          // The first account is primary whether or not the box was ticked:
          // one account and no primary is a state with no useful meaning.
          isPrimary: input.isPrimary || isFirst,
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return toDto(account);
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
            ? { balanceMinor: BigInt(input.balanceMinor) }
            : {}),
          ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return toDto(account);
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
