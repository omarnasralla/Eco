import { Injectable, Logger } from '@nestjs/common';
import type { UpdateProfileInput, UserDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { toUserDto } from './user.mapper';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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
    // derived caches have to go. The stored `baseAmountMinor` on historical
    // transactions is deliberately NOT rewritten — those were converted at the
    // rate on the day, and retroactively restating them would make last year's
    // reports disagree with themselves.
    if (input.currency && input.currency !== current.currency) {
      this.logger.log(`User ${userId} changed base currency ${current.currency} → ${input.currency}`);
      await this.redis.invalidateUser(userId);
    }

    await this.redis.del(`auth:user:${userId}`);
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
    await this.redis.del(`auth:user:${userId}`);
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
}
