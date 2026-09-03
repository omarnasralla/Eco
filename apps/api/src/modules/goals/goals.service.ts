import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { crossedMilestones, projectGoal } from '@eco/core';
import type { GoalContributionInput, SavingsGoalDto, SavingsGoalInput } from '@eco/shared';
import type { SavingsGoal } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toNumber, toNumberOrNull } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, todayIso, toIsoDate } from '../../common/utils/dates';

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
    private readonly currency: CurrencyService,
    private readonly notifications: NotificationsService,
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
   * The amount may be entered in any currency; it is converted into the goal's
   * own currency at the contribution date's rate and frozen on the row, so a
   * balance built from riyal payments into a dollar goal does not restate
   * itself every time the rate moves.
   *
   * Milestone notifications are keyed off `lastMilestoneNotified`, so a balance
   * hovering around 50% cannot spam the user with the same congratulation every
   * time it crosses back and forth.
   */
  async contribute(userId: string, goalId: string, input: GoalContributionInput) {
    // Read the goal's currency first: conversion hits Redis and possibly the
    // rate table, and an interactive transaction is the wrong place to wait on
    // that. The transaction below re-reads the goal, so this is a hint, not the
    // authority — and the currency of a goal is not something a concurrent
    // contribution changes.
    const target = await this.prisma.savingsGoal.findFirst({
      where: { id: goalId, userId, deletedAt: null },
      select: { currency: true },
    });
    if (!target) throw new NotFoundException('Savings goal not found');

    if (input.accountId) {
      const owned = await this.prisma.financialAccount.count({
        where: { id: input.accountId, userId, deletedAt: null },
      });
      if (owned === 0) throw new NotFoundException('Account not found');
    }

    const enteredCurrency = input.currency ?? target.currency;
    const goalAmountMinor = await this.currency.convert(
      input.amountMinor,
      enteredCurrency,
      target.currency,
      input.date,
    );

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
      const updated = Math.max(previous + goalAmountMinor, 0);
      const achieved = updated >= target;

      await tx.goalContribution.create({
        data: {
          userId,
          goalId,
          accountId: input.accountId ?? null,
          amountMinor: BigInt(input.amountMinor),
          currency: enteredCurrency,
          goalAmountMinor: BigInt(goalAmountMinor),
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
      currency: c.currency,
      goalAmountMinor: toNumber(c.goalAmountMinor),
      date: requireIsoDate(c.date),
      notes: c.notes,
    }));
  }

  /**
   * Total saved across active goals, in the user's base currency.
   *
   * Goals each carry their own currency, so this cannot be a SUM: adding a
   * riyal balance to a dollar one produces a number that is not money in any
   * currency. Conversion is per goal at today's rate — unlike a transaction,
   * a savings balance is a present-day holding, so today's rate is the honest
   * one. A user has a handful of goals, so the loop is cheap, and same-currency
   * goals short-circuit before any rate is consulted.
   *
   * Lenient conversion, deliberately: this is a read-only summary figure, and
   * one goal in an unquoted currency should degrade its own contribution
   * rather than fail the caller's whole dashboard.
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
