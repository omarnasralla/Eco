import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { crossedMilestones, projectGoal } from '@eco/core';
import type { GoalContributionInput, SavingsGoalDto, SavingsGoalInput } from '@eco/shared';
import type { SavingsGoal } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toNumber, toNumberOrNull } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, todayIso, toIsoDate } from '../../common/utils/dates';
import { CurrencyService } from '../currency/currency.service';

function toDto(goal: SavingsGoal): SavingsGoalDto {
  const projection = projectGoal(
    {
      targetAmountMinor: toNumber(goal.targetAmountMinor),
      currentAmountMinor: toNumber(goal.currentAmountMinor),
      deadline: toIsoDate(goal.deadline),
      monthlyContributionMinor: toNumberOrNull(goal.monthlyContributionMinor),
    },
    todayIso(),
  );

  return {
    id: goal.id,
    name: goal.name,
    type: goal.type,
    status: goal.status,
    targetAmountMinor: toNumber(goal.targetAmountMinor),
    currentAmountMinor: toNumber(goal.currentAmountMinor),
    currency: goal.currency,
    deadline: toIsoDate(goal.deadline),
    monthlyContributionMinor: toNumberOrNull(goal.monthlyContributionMinor),
    progressPct: projection.progressPct,
    requiredMonthlyMinor: projection.requiredMonthlyMinor,
    projectedCompletionDate: projection.projectedCompletionDate,
    onTrack: projection.onTrack,
    color: goal.color,
    icon: goal.icon,
    createdAt: goal.createdAt.toISOString(),
  };
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly currency: CurrencyService,
  ) {}

  async findAll(userId: string, includeArchived = false): Promise<SavingsGoalDto[]> {
    const goals = await this.prisma.savingsGoal.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(includeArchived ? {} : { status: { in: ['ACTIVE', 'ACHIEVED'] } }),
      },
      orderBy: [{ status: 'asc' }, { deadline: 'asc' }, { createdAt: 'desc' }],
    });
    return goals.map(toDto);
  }

  async findOne(userId: string, id: string): Promise<SavingsGoalDto> {
    const goal = await this.prisma.savingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!goal) throw new NotFoundException('Savings goal not found');
    return toDto(goal);
  }

  async create(userId: string, input: SavingsGoalInput): Promise<SavingsGoalDto> {
    const goal = await this.prisma.savingsGoal.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        targetAmountMinor: BigInt(input.targetAmountMinor),
        currentAmountMinor: BigInt(input.currentAmountMinor),
        currency: input.currency,
        deadline: input.deadline ? fromIsoDate(input.deadline) : null,
        monthlyContributionMinor:
          input.monthlyContributionMinor != null
            ? BigInt(input.monthlyContributionMinor)
            : null,
        color: input.color,
        icon: input.icon,
        notes: input.notes ?? null,
      },
    });
    await this.redis.invalidateUser(userId);
    return toDto(goal);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<SavingsGoalInput>,
  ): Promise<SavingsGoalDto> {
    const existing = await this.prisma.savingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Savings goal not found');

    const goal = await this.prisma.savingsGoal.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.targetAmountMinor !== undefined
          ? { targetAmountMinor: BigInt(input.targetAmountMinor) }
          : {}),
        ...(input.currentAmountMinor !== undefined
          ? { currentAmountMinor: BigInt(input.currentAmountMinor) }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.deadline !== undefined
          ? { deadline: input.deadline ? fromIsoDate(input.deadline) : null }
          : {}),
        ...(input.monthlyContributionMinor !== undefined
          ? {
              monthlyContributionMinor:
                input.monthlyContributionMinor != null
                  ? BigInt(input.monthlyContributionMinor)
                  : null,
            }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });

    await this.redis.invalidateUser(userId);
    return toDto(goal);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.savingsGoal.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date(), status: 'ABANDONED' },
    });
    if (count === 0) throw new NotFoundException('Savings goal not found');
    await this.redis.invalidateUser(userId);
  }

  /**
   * Adds (or withdraws, with a negative amount) against a goal.
   *
   * Milestone notifications are keyed off `lastMilestoneNotified`, so a balance
   * hovering around 50% cannot spam the user with the same congratulation every
   * time it crosses back and forth.
   */
  async contribute(userId: string, goalId: string, input: GoalContributionInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const goal = await tx.savingsGoal.findFirst({
        where: { id: goalId, userId, deletedAt: null },
      });
      if (!goal) throw new NotFoundException('Savings goal not found');
      if (goal.status === 'ABANDONED') {
        throw new BadRequestException('This goal has been abandoned');
      }

      const previous = toNumber(goal.currentAmountMinor);
      const target = toNumber(goal.targetAmountMinor);
      const updated = Math.max(previous + input.amountMinor, 0);
      const achieved = updated >= target;

      await tx.goalContribution.create({
        data: {
          userId,
          goalId,
          amountMinor: BigInt(input.amountMinor),
          date: fromIsoDate(input.date),
          notes: input.notes ?? null,
        },
      });

      const milestones = crossedMilestones(previous, updated, target).filter(
        (m) => m > goal.lastMilestoneNotified,
      );

      const saved = await tx.savingsGoal.update({
        where: { id: goalId },
        data: {
          currentAmountMinor: BigInt(updated),
          ...(achieved && goal.status !== 'ACHIEVED'
            ? { status: 'ACHIEVED' as const, achievedAt: new Date() }
            : {}),
          ...(milestones.length
            ? { lastMilestoneNotified: Math.max(...milestones) }
            : {}),
        },
      });

      return { goal: saved, milestones, previous, updated, achieved };
    });

    await this.redis.invalidateUser(userId);

    for (const milestone of result.milestones) {
      await this.notifications.create(userId, {
        type: milestone === 100 ? 'GOAL_ACHIEVED' : 'SAVINGS_MILESTONE',
        title:
          milestone === 100
            ? `You reached your goal: ${result.goal.name}`
            : `${milestone}% of the way to ${result.goal.name}`,
        body:
          milestone === 100
            ? `Your ${result.goal.name} goal is fully funded. Nicely done.`
            : `You have saved ${milestone}% of your ${result.goal.name} target. Keep going.`,
        actionUrl: `/goals/${goalId}`,
        dedupeKey: `goal:${goalId}:milestone:${milestone}`,
      });
    }

    return toDto(result.goal);
  }

  async listContributions(userId: string, goalId: string) {
    const contributions = await this.prisma.goalContribution.findMany({
      where: { userId, goalId },
      orderBy: { date: 'desc' },
      take: 200,
    });

    return contributions.map((c) => ({
      id: c.id,
      amountMinor: toNumber(c.amountMinor),
      date: requireIsoDate(c.date),
      notes: c.notes,
    }));
  }

  /** Total saved across active goals, in the user's base currency. */
  /**
   * Total saved across active goals, in the user's base currency. Converted per
   * goal rather than SQL-summed: goals may be held in different currencies, and
   * adding those figures raw produces a number in no currency at all.
   */
  async totalSaved(userId: string, userCurrency: string): Promise<number> {
    const goals = await this.prisma.savingsGoal.findMany({
      where: { userId, deletedAt: null, status: { in: ['ACTIVE', 'ACHIEVED'] } },
      select: { currentAmountMinor: true, currency: true },
    });

    let total = 0;
    for (const goal of goals) {
      total += await this.currency.convertForDisplay(
        toNumber(goal.currentAmountMinor),
        goal.currency,
        userCurrency,
      );
    }
    return total;
  }
}
