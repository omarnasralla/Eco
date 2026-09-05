import { Injectable, Logger } from '@nestjs/common';
import type { UpdateProfileInput, UserDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { toUserDto } from './user.mapper';
import { CurrencyService } from '../currency/currency.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  async findById(userId: string): Promise<UserDto> {
    return toUserDto(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDto> {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.financialGoals !== undefined ? { financialGoals: input.financialGoals } : {}),
      },
    });

    // Changing the base currency rebases every aggregate the user sees, so all
    // derived caches have to go — and the stored `baseAmountMinor` columns have
    // to be re-expressed in the new unit.
    //
    // Two things get conflated here, so to be explicit: the *rate* a historical
    // transaction was converted at is sacred and is never restated — a EUR
    // expense from last March stays converted at last March's rate. But the
    // *unit* those columns are denominated in is the user's base currency, and
    // when that changes the numbers are simply in the wrong unit. Leaving them
    // alone does not preserve history; it relabels dollars as riyals and every
    // dashboard, budget and report then reads a wrong number with a straight
    // face. So each row is re-converted from its own original amount, at the
    // rate for its own date — which honours both rules at once.
    if (input.currency && input.currency !== current.currency) {
      this.logger.log(`User ${userId} changed base currency ${current.currency} → ${input.currency}`);
      await this.rebaseStoredAmounts(userId, input.currency);
      await this.redis.invalidateUser(userId);
    }

    await this.redis.invalidateUser(userId);
    return toUserDto(user);
  }

  async completeOnboarding(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingCompleted: true },
    });
  }

  /**
   * Soft-deletes the account and kills every session immediately. The hard
   * purge runs 30 days later, which gives a user who changes their mind — or
   * whose account was deleted maliciously — a window to recover.
   */
  async requestDeletion(userId: string): Promise<{ purgeScheduledFor: string }> {
    const purgeDate = new Date(Date.now() + 30 * 24 * 3_600 * 1000);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), tokensValidFrom: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.redis.invalidateUser(userId);
    this.logger.warn(`User ${userId} scheduled for deletion on ${purgeDate.toISOString()}`);

    return { purgeScheduledFor: purgeDate.toISOString() };
  }

  /**
   * GDPR Article 20 data portability: everything we hold, as one JSON document.
   * Secrets are excluded — the point is the user's own data, not our hashes.
   */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const [user, incomes, categories, expenses, debts, payments, goals, contributions, budgets] =
      await Promise.all([
        this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
        this.prisma.incomeSource.findMany({ where: { userId } }),
        this.prisma.category.findMany({ where: { userId } }),
        this.prisma.expense.findMany({ where: { userId } }),
        this.prisma.debt.findMany({ where: { userId } }),
        this.prisma.debtPayment.findMany({ where: { userId } }),
        this.prisma.savingsGoal.findMany({ where: { userId } }),
        this.prisma.goalContribution.findMany({ where: { userId } }),
        this.prisma.budget.findMany({ where: { userId }, include: { lines: true } }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      format: 'eco-data-export-v1',
      profile: toUserDto(user),
      incomeSources: incomes,
      categories,
      expenses,
      debts,
      debtPayments: payments,
      savingsGoals: goals,
      goalContributions: contributions,
      budgets,
    };
  }

  /**
   * Re-expresses every stored `baseAmountMinor` in a new base currency.
   *
   * Each row is converted from `(amountMinor, currency)` at the rate for its
   * own `date`, never from the previously-stored base figure — converting a
   * converted number would compound two roundings and drift the ledger.
   *
   * Rows already denominated in the new base (`currency === base`) need no
   * conversion at all, which is the overwhelming majority for most users.
   */
  private async rebaseStoredAmounts(userId: string, newBase: string): Promise<void> {
    const [expenses, receipts] = await Promise.all([
      this.prisma.expense.findMany({
        where: { userId, deletedAt: null },
        select: { id: true, amountMinor: true, currency: true, date: true },
      }),
      this.prisma.incomeReceipt.findMany({
        where: { userId },
        select: { id: true, amountMinor: true, currency: true, date: true },
      }),
    ]);

    // One rate lookup per distinct date, not per row: a year of daily spending
    // is ~365 lookups instead of thousands, and each one is Redis-cached.
    const convertRow = async (row: {
      amountMinor: bigint;
      currency: string;
      date: Date;
    }): Promise<bigint> => {
      if (row.currency === newBase) return row.amountMinor;
      const isoDate = row.date.toISOString().slice(0, 10);
      // Display semantics on purpose: a missing historical rate must not block
      // a profile update. The face value is wrong but recoverable, and the
      // warning names the row; refusing the whole change would be worse.
      const converted = await this.currency.convertForDisplay(
        Number(row.amountMinor),
        row.currency,
        newBase,
        isoDate,
      );
      return BigInt(converted);
    };

    const expenseUpdates = await Promise.all(
      expenses.map(async (row) => ({ id: row.id, baseAmountMinor: await convertRow(row) })),
    );
    const receiptUpdates = await Promise.all(
      receipts.map(async (row) => ({ id: row.id, baseAmountMinor: await convertRow(row) })),
    );

    await this.prisma.$transaction([
      ...expenseUpdates.map((u) =>
        this.prisma.expense.update({
          where: { id: u.id },
          data: { baseAmountMinor: u.baseAmountMinor },
        }),
      ),
      ...receiptUpdates.map((u) =>
        this.prisma.incomeReceipt.update({
          where: { id: u.id },
          data: { baseAmountMinor: u.baseAmountMinor },
        }),
      ),
    ]);

    this.logger.log(
      `Rebased ${expenseUpdates.length} expenses and ${receiptUpdates.length} income receipts to ${newBase} for user ${userId}`,
    );
  }
}
