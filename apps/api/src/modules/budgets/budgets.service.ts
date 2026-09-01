import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import { addMonths, evaluateBudget, rolloverAmountMinor, suggestBudget } from '@eco/core';
import { CACHE_TTL_SECONDS, type BudgetDto, type BudgetInput, type BudgetLineDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toNumber } from '../../common/utils/money';
import { dateToMonth, monthToDate, todayIso } from '../../common/utils/dates';

@Injectable()
export class BudgetsService {
  private readonly logger = new Logger(BudgetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * A budget is stored as limits; everything else — spend, remaining,
   * projection, status — is computed against live expenses at read time. That
   * keeps the numbers correct after a back-dated expense edit, which a stored
   * running total would silently get wrong.
   */
  async findByMonth(userId: string, month: string, userCurrency: string): Promise<BudgetDto | null> {
    const cacheKey = this.redis.key(userId, 'budget', month);

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.dashboard, async () => {
      const budget = await this.prisma.budget.findFirst({
        where: { userId, month: monthToDate(month), deletedAt: null },
        include: {
          lines: {
            include: { category: { select: { id: true, name: true, color: true } } },
          },
        },
      });
      if (!budget) return null;

      const [spendByCategory, committedSpendByCategory] = await Promise.all([
        this.spendByCategory(userId, month),
        this.committedSpendByCategory(userId, month),
      ]);

      const evaluation = evaluateBudget({
        month,
        lines: budget.lines.map((l) => ({
          categoryId: l.categoryId,
          limitMinor: toNumber(l.limitMinor),
          rollover: l.rollover,
          rolloverFromPreviousMinor: toNumber(l.rolloverFromPreviousMinor),
        })),
        spendByCategory,
        committedSpendByCategory,
        alertThresholdPct: budget.alertThresholdPct,
        // Only treat the month as partially elapsed when it is the current one;
        // a past month is fully spent and a future one has not started.
        asOf: this.asOfFor(month),
        ...(budget.totalLimitMinor ? { totalLimitMinor: toNumber(budget.totalLimitMinor) } : {}),
      });

      const categoryById = new Map(budget.lines.map((l) => [l.categoryId, l.category]));

      const lines: BudgetLineDto[] = evaluation.lines.map((line) => ({
        categoryId: line.categoryId,
        categoryName: categoryById.get(line.categoryId)?.name ?? 'Unknown',
        categoryColor: categoryById.get(line.categoryId)?.color ?? '#64748b',
        limitMinor: line.limitMinor,
        spentMinor: line.spentMinor,
        remainingMinor: line.remainingMinor,
        utilisationPct: line.utilisationPct,
        rollover: line.rollover,
        rolloverFromPreviousMinor: line.rolloverFromPreviousMinor,
        status: line.status,
      }));

      return {
        id: budget.id,
        month,
        type: budget.type,
        currency: budget.currency,
        totalLimitMinor: evaluation.totalLimitMinor,
        totalSpentMinor: evaluation.totalSpentMinor,
        totalRemainingMinor: evaluation.totalRemainingMinor,
        utilisationPct: evaluation.utilisationPct,
        alertThresholdPct: budget.alertThresholdPct,
        lines,
        projectedSpendMinor: evaluation.projectedSpendMinor,
        daysRemaining: evaluation.daysRemaining,
        createdAt: budget.createdAt.toISOString(),
      } satisfies BudgetDto;
    });
  }

  async list(userId: string, limit = 12): Promise<Array<{ month: string; id: string }>> {
    const budgets = await this.prisma.budget.findMany({
      where: { userId, deletedAt: null },
      orderBy: { month: 'desc' },
      take: limit,
      select: { id: true, month: true },
    });
    return budgets.map((b) => ({ id: b.id, month: dateToMonth(b.month) }));
  }

  async upsert(userId: string, input: BudgetInput, userCurrency: string): Promise<BudgetDto> {
    if (!input.month) throw new BadRequestException('A budget needs a month');

    const categoryIds = (input.lines ?? []).map((l) => l.categoryId);
    if (categoryIds.length > 0) {
      const owned = await this.prisma.category.count({
        where: { id: { in: categoryIds }, userId, deletedAt: null },
      });
      if (owned !== new Set(categoryIds).size) {
        throw new NotFoundException('One or more categories were not found');
      }
    }

    const month = monthToDate(input.month);

    await this.prisma.$transaction(async (tx) => {
      const budget = await tx.budget.upsert({
        where: { userId_month: { userId, month } },
        create: {
          userId,
          month,
          type: input.type ?? 'FIXED',
          currency: input.currency ?? userCurrency,
          totalLimitMinor: input.totalLimitMinor ? BigInt(input.totalLimitMinor) : null,
          alertThresholdPct: input.alertThresholdPct ?? 80,
          notes: input.notes ?? null,
        },
        update: {
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.totalLimitMinor !== undefined
            ? { totalLimitMinor: input.totalLimitMinor ? BigInt(input.totalLimitMinor) : null }
            : {}),
          ...(input.alertThresholdPct !== undefined
            ? { alertThresholdPct: input.alertThresholdPct }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          deletedAt: null,
        },
      });

      if (input.lines) {
        // Replace the line set wholesale: the client always sends the complete
        // budget, and diffing would only add a way for the two to disagree.
        await tx.budgetLine.deleteMany({ where: { budgetId: budget.id } });
        if (input.lines.length > 0) {
          await tx.budgetLine.createMany({
            data: input.lines.map((line) => ({
              budgetId: budget.id,
              categoryId: line.categoryId,
              limitMinor: BigInt(line.limitMinor),
              rollover: line.rollover,
            })),
          });
        }
      }
    });

    await this.redis.del(this.redis.key(userId, 'budget', input.month));
    await this.redis.invalidateUser(userId);

    const result = await this.findByMonth(userId, input.month, userCurrency);
    if (!result) throw new NotFoundException('Budget could not be loaded after saving');
    return result;
  }

  async remove(userId: string, month: string): Promise<void> {
    const { count } = await this.prisma.budget.updateMany({
      where: { userId, month: monthToDate(month), deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Budget not found');
    await this.redis.invalidateUser(userId);
  }

  /**
   * Proposes limits from the last six months of spending. The median per
   * category means one holiday does not become next month's travel budget.
   */
  async suggest(userId: string, month: string, monthlyIncomeMinor: number) {
    const months = Array.from({ length: 6 }, (_, i) => addMonths(month, -(i + 1)));
    const historyByCategory: Record<string, number[]> = {};

    for (const historicalMonth of months) {
      const spend = await this.spendByCategory(userId, historicalMonth);
      for (const [categoryId, amount] of Object.entries(spend)) {
        (historyByCategory[categoryId] ??= []).push(amount);
      }
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { financialGoals: true },
    });
    const goals = (user.financialGoals as { targetSavingsRatePct?: number } | null) ?? null;

    const suggestion = suggestBudget({
      historyByCategory,
      monthlyIncomeMinor,
      ...(goals?.targetSavingsRatePct !== undefined
        ? { targetSavingsRatePct: goals.targetSavingsRatePct }
        : {}),
    });

    const categories = await this.prisma.category.findMany({
      where: { id: { in: suggestion.lines.map((l) => l.categoryId) } },
      select: { id: true, name: true, color: true },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));

    return {
      month,
      basedOnMonths: months.length,
      adjustmentFactor: suggestion.adjustmentFactor,
      totalLimitMinor: suggestion.totalLimitMinor,
      lines: suggestion.lines.map((line) => ({
        categoryId: line.categoryId,
        categoryName: byId.get(line.categoryId)?.name ?? 'Unknown',
        categoryColor: byId.get(line.categoryId)?.color ?? '#64748b',
        limitMinor: line.limitMinor,
      })),
    };
  }

  /** Spend per category for a month, in the user's base currency. */
  async spendByCategory(userId: string, month: string): Promise<Record<string, number>> {
    return this.spendGrouped(userId, month, false);
  }

  /**
   * The recurring slice of a month's spend — rent, subscriptions, standing
   * bills. `evaluateBudget` excludes it from the run-rate extrapolation, which
   * is what stops rent on the 1st projecting a month thirty times its real size.
   */
  async committedSpendByCategory(userId: string, month: string): Promise<Record<string, number>> {
    return this.spendGrouped(userId, month, true);
  }

  private async spendGrouped(
    userId: string,
    month: string,
    recurringOnly: boolean,
  ): Promise<Record<string, number>> {
    const start = monthToDate(month);
    const end = monthToDate(addMonths(month, 1));

    const rows = await this.prisma.expense.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        deletedAt: null,
        date: { gte: start, lt: end },
        ...(recurringOnly ? { isRecurring: true } : {}),
      },
      _sum: { baseAmountMinor: true },
    });

    return Object.fromEntries(
      rows.map((row) => [row.categoryId, toNumber(row._sum.baseAmountMinor ?? BigInt(0))]),
    );
  }

  private asOfFor(month: string): string {
    const today = todayIso();
    const currentMonth = today.slice(0, 7);
    if (month === currentMonth) return today;
    // Past months are complete; future months have not begun. Returning the
    // month's own start for a future month yields a zero-day projection
    // rather than nonsense extrapolated from no data.
    return month < currentMonth ? `${month}-28` : `${month}-01`;
  }

  /**
   * Checks live budgets a few times a day and warns before the limit is hit,
   * not after. Being told you are 20% over is much less useful than being told
   * you are at 85% with nine days left.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async checkBudgetAlerts(): Promise<void> {
    if (!(await this.redis.acquireLock('budget-alerts', 900))) return;

    try {
      const month = todayIso().slice(0, 7);
      const budgets = await this.prisma.budget.findMany({
        where: { month: monthToDate(month), deletedAt: null },
        include: {
          lines: { include: { category: { select: { name: true } } } },
          user: { select: { id: true, currency: true, deletedAt: true } },
        },
      });

      let alerts = 0;

      for (const budget of budgets) {
        if (budget.user.deletedAt) continue;

        const [spend, committed] = await Promise.all([
          this.spendByCategory(budget.userId, month),
          this.committedSpendByCategory(budget.userId, month),
        ]);
        const evaluation = evaluateBudget({
          month,
          lines: budget.lines.map((l) => ({
            categoryId: l.categoryId,
            limitMinor: toNumber(l.limitMinor),
            rollover: l.rollover,
            rolloverFromPreviousMinor: toNumber(l.rolloverFromPreviousMinor),
          })),
          spendByCategory: spend,
          committedSpendByCategory: committed,
          alertThresholdPct: budget.alertThresholdPct,
          asOf: todayIso(),
          ...(budget.totalLimitMinor ? { totalLimitMinor: toNumber(budget.totalLimitMinor) } : {}),
        });

        const nameById = new Map(budget.lines.map((l) => [l.categoryId, l.category.name]));

        for (const line of evaluation.lines) {
          if (line.status === 'UNDER') continue;
          const name = nameById.get(line.categoryId) ?? 'a category';

          const created = await this.notifications.create(budget.userId, {
            type: line.status === 'OVER' ? 'BUDGET_EXCEEDED' : 'BUDGET_WARNING',
            title:
              line.status === 'OVER'
                ? `You are over budget on ${name}`
                : `${name} is at ${Math.round(line.utilisationPct)}% of budget`,
            body:
              line.status === 'OVER'
                ? `You have spent ${line.spentMinor} against a ${line.effectiveLimitMinor} limit, with ${evaluation.daysRemaining} days left in the month.`
                : `${line.remainingMinor} remains of your ${name} budget, with ${evaluation.daysRemaining} days to go.`,
            actionUrl: `/budgets?month=${month}`,
            // One alert per category per status per month.
            dedupeKey: `budget:${month}:${line.categoryId}:${line.status}`,
          });
          if (created) alerts += 1;
        }
      }

      if (alerts > 0) this.logger.log(`Raised ${alerts} budget alerts`);
    } finally {
      await this.redis.releaseLock('budget-alerts');
    }
  }

  /**
   * On the 1st of each month, carries unspent room forward on rollover lines.
   * Overspend is never carried as a debt — penalising next month for last
   * month's mistake is how people give up on budgeting altogether.
   */
  @Cron('5 0 1 * *')
  async processRollovers(): Promise<void> {
    if (!(await this.redis.acquireLock('budget-rollover', 1_800))) return;

    try {
      const thisMonth = todayIso().slice(0, 7);
      const lastMonth = addMonths(thisMonth, -1);

      const previous = await this.prisma.budget.findMany({
        where: { month: monthToDate(lastMonth), deletedAt: null, type: 'ROLLING' },
        include: { lines: true },
      });

      for (const budget of previous) {
        const spend = await this.spendByCategory(budget.userId, lastMonth);
        const evaluation = evaluateBudget({
          month: lastMonth,
          lines: budget.lines.map((l) => ({
            categoryId: l.categoryId,
            limitMinor: toNumber(l.limitMinor),
            rollover: l.rollover,
            rolloverFromPreviousMinor: toNumber(l.rolloverFromPreviousMinor),
          })),
          spendByCategory: spend,
        });

        const current = await this.prisma.budget.findFirst({
          where: { userId: budget.userId, month: monthToDate(thisMonth), deletedAt: null },
          include: { lines: true },
        });
        if (!current) continue;

        for (const line of evaluation.lines) {
          const carry = rolloverAmountMinor(line);
          if (carry <= 0) continue;

          await this.prisma.budgetLine.updateMany({
            where: { budgetId: current.id, categoryId: line.categoryId },
            data: { rolloverFromPreviousMinor: BigInt(carry) },
          });
        }

        await this.redis.invalidateUser(budget.userId);
      }

      this.logger.log(`Processed rollovers for ${previous.length} budgets`);
    } finally {
      await this.redis.releaseLock('budget-rollover');
    }
  }
}
