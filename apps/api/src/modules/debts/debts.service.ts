import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  compareStrategies,
  monthsToPayoff,
  nextDueDate,
  simulatePayoff,
  totalInterestFor,
  type DebtLike,
} from '@eco/core';
import type {
  DebtDto,
  DebtInput,
  DebtPaymentInput,
  PayoffPlanDto,
  PayoffPlanInput,
} from '@eco/shared';
import type { Debt } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { decimalToNumber, toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, todayIso, toIsoDate } from '../../common/utils/dates';

function toDomain(debt: Debt): DebtLike {
  return {
    id: debt.id,
    name: debt.name,
    currentBalanceMinor: toNumber(debt.currentBalanceMinor),
    interestRateApr: decimalToNumber(debt.interestRateApr),
    minimumPaymentMinor: toNumber(debt.minimumPaymentMinor),
  };
}

function toDto(debt: Debt): DebtDto {
  const balance = toNumber(debt.currentBalanceMinor);
  const apr = decimalToNumber(debt.interestRateApr);
  const minimum = toNumber(debt.minimumPaymentMinor);

  return {
    id: debt.id,
    name: debt.name,
    type: debt.type,
    lender: debt.lender,
    principalMinor: toNumber(debt.principalMinor),
    currentBalanceMinor: balance,
    interestRateApr: apr,
    minimumPaymentMinor: minimum,
    currency: debt.currency,
    dueDayOfMonth: debt.dueDayOfMonth,
    nextDueDate: nextDueDate(todayIso(), debt.dueDayOfMonth),
    isClosed: debt.isClosed,
    notes: debt.notes,
    // Null when the minimum payment does not even cover the interest — the
    // balance grows forever, and the UI surfaces that loudly.
    monthsToPayoffAtMinimum: monthsToPayoff(balance, apr, minimum),
    totalInterestAtMinimumMinor: totalInterestFor(balance, apr, minimum),
    createdAt: debt.createdAt.toISOString(),
  };
}

@Injectable()
export class DebtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findAll(userId: string, includeClosed = false): Promise<DebtDto[]> {
    const debts = await this.prisma.debt.findMany({
      where: { userId, deletedAt: null, ...(includeClosed ? {} : { isClosed: false }) },
      orderBy: [{ isClosed: 'asc' }, { interestRateApr: 'desc' }],
    });
    return debts.map(toDto);
  }

  async findOne(userId: string, id: string): Promise<DebtDto> {
    const debt = await this.prisma.debt.findFirst({ where: { id, userId, deletedAt: null } });
    if (!debt) throw new NotFoundException('Debt not found');
    return toDto(debt);
  }

  async create(userId: string, input: DebtInput): Promise<DebtDto> {
    const debt = await this.prisma.debt.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        lender: input.lender ?? null,
        principalMinor: BigInt(input.principalMinor),
        currentBalanceMinor: BigInt(input.currentBalanceMinor),
        interestRateApr: input.interestRateApr,
        minimumPaymentMinor: BigInt(input.minimumPaymentMinor),
        currency: input.currency,
        dueDayOfMonth: input.dueDayOfMonth,
        openedDate: input.openedDate ? fromIsoDate(input.openedDate) : null,
        notes: input.notes ?? null,
      },
    });
    await this.redis.invalidateUser(userId);
    return toDto(debt);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<DebtInput> & { isClosed?: boolean },
  ): Promise<DebtDto> {
    const existing = await this.prisma.debt.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Debt not found');

    const debt = await this.prisma.debt.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.lender !== undefined ? { lender: input.lender } : {}),
        ...(input.principalMinor !== undefined
          ? { principalMinor: BigInt(input.principalMinor) }
          : {}),
        ...(input.currentBalanceMinor !== undefined
          ? { currentBalanceMinor: BigInt(input.currentBalanceMinor) }
          : {}),
        ...(input.interestRateApr !== undefined ? { interestRateApr: input.interestRateApr } : {}),
        ...(input.minimumPaymentMinor !== undefined
          ? { minimumPaymentMinor: BigInt(input.minimumPaymentMinor) }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.dueDayOfMonth !== undefined ? { dueDayOfMonth: input.dueDayOfMonth } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isClosed !== undefined
          ? { isClosed: input.isClosed, closedAt: input.isClosed ? new Date() : null }
          : {}),
      },
    });

    await this.redis.invalidateUser(userId);
    return toDto(debt);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.debt.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Debt not found');
    await this.redis.invalidateUser(userId);
  }

  /**
   * Records a payment and decrements the balance in one transaction.
   *
   * When the caller does not supply a principal/interest split we derive it
   * from the APR, but the recorded values are what the ledger keeps — a
   * lender's actual allocation can differ from any model of it, and the
   * statement is the source of truth.
   */
  async recordPayment(userId: string, debtId: string, input: DebtPaymentInput) {
    return this.prisma.$transaction(async (tx) => {
      const debt = await tx.debt.findFirst({ where: { id: debtId, userId, deletedAt: null } });
      if (!debt) throw new NotFoundException('Debt not found');
      if (debt.isClosed) throw new BadRequestException('This debt is already closed');

      const balance = toNumber(debt.currentBalanceMinor);
      const apr = decimalToNumber(debt.interestRateApr);

      const interestMinor =
        input.interestMinor ?? Math.round((balance * apr) / 100 / 12);
      const principalMinor =
        input.principalMinor ?? Math.max(input.amountMinor - interestMinor, 0);

      // Interest accrues first, then the payment lands against the total.
      const newBalance = Math.max(balance + interestMinor - input.amountMinor, 0);
      const clearsDebt = newBalance === 0;

      const payment = await tx.debtPayment.create({
        data: {
          userId,
          debtId,
          amountMinor: BigInt(input.amountMinor),
          principalMinor: BigInt(principalMinor),
          interestMinor: BigInt(interestMinor),
          currency: debt.currency,
          date: fromIsoDate(input.date),
          balanceAfterMinor: BigInt(newBalance),
          notes: input.notes ?? null,
        },
      });

      await tx.debt.update({
        where: { id: debtId },
        data: {
          currentBalanceMinor: BigInt(newBalance),
          ...(clearsDebt ? { isClosed: true, closedAt: new Date() } : {}),
        },
      });

      await this.redis.invalidateUser(userId);

      return {
        id: payment.id,
        amountMinor: input.amountMinor,
        principalMinor,
        interestMinor,
        balanceAfterMinor: newBalance,
        debtCleared: clearsDebt,
        date: input.date,
      };
    });
  }

  async listPayments(userId: string, debtId: string) {
    const payments = await this.prisma.debtPayment.findMany({
      where: { userId, debtId },
      orderBy: { date: 'desc' },
      take: 200,
    });

    return payments.map((p) => ({
      id: p.id,
      amountMinor: toNumber(p.amountMinor),
      principalMinor: toNumber(p.principalMinor),
      interestMinor: toNumber(p.interestMinor),
      balanceAfterMinor: toNumber(p.balanceAfterMinor),
      currency: p.currency,
      date: requireIsoDate(p.date),
      notes: p.notes,
    }));
  }

  /** Runs a payoff simulation for the user's open debts. */
  async buildPayoffPlan(
    userId: string,
    input: PayoffPlanInput,
    userCurrency: string,
  ): Promise<PayoffPlanDto> {
    const debts = await this.prisma.debt.findMany({
      where: { userId, deletedAt: null, isClosed: false },
    });
    if (debts.length === 0) {
      throw new BadRequestException('You have no open debts to build a plan for');
    }

    const domain = debts.map(toDomain);
    const result = simulatePayoff(domain, {
      strategy: input.strategy,
      monthlyBudgetMinor: input.monthlyBudgetMinor,
      extraOneOffMinor: input.extraOneOffMinor,
      ...(input.debtOrder ? { customOrder: input.debtOrder } : {}),
    });

    if (!result.isFeasible) {
      throw new BadRequestException(
        result.infeasibleReason ?? 'That budget cannot clear these debts',
      );
    }

    const comparison = compareStrategies(domain, input.monthlyBudgetMinor);

    await this.prisma.payoffPlan.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    await this.prisma.payoffPlan.create({
      data: {
        userId,
        strategy: input.strategy,
        monthlyBudgetMinor: BigInt(input.monthlyBudgetMinor),
        extraOneOffMinor: BigInt(input.extraOneOffMinor),
        debtOrder: input.debtOrder ?? [],
      },
    });

    return {
      strategy: result.strategy,
      monthlyBudgetMinor: result.monthlyBudgetMinor,
      monthsToDebtFree: result.monthsToDebtFree,
      debtFreeDate: result.debtFreeDate,
      totalPaidMinor: result.totalPaidMinor,
      totalInterestMinor: result.totalInterestMinor,
      interestSavedVsMinimumMinor: comparison.interestSavedVsMinimumMinor,
      monthsSavedVsMinimum: comparison.monthsSavedVsMinimum,
      payoffOrder: result.payoffOrder,
      schedule: result.schedule,
    };
  }

  /** Side-by-side snowball vs avalanche, with a recommendation. */
  async compare(userId: string, monthlyBudgetMinor: number) {
    const debts = await this.prisma.debt.findMany({
      where: { userId, deletedAt: null, isClosed: false },
    });
    if (debts.length === 0) {
      throw new BadRequestException('You have no open debts to compare');
    }

    const comparison = compareStrategies(debts.map(toDomain), monthlyBudgetMinor);

    // Strip the full schedules from the comparison payload — the caller only
    // needs the headline numbers, and three schedules is a lot of JSON.
    const summarise = (r: typeof comparison.snowball) => ({
      strategy: r.strategy,
      monthsToDebtFree: r.monthsToDebtFree,
      debtFreeDate: r.debtFreeDate,
      totalPaidMinor: r.totalPaidMinor,
      totalInterestMinor: r.totalInterestMinor,
      isFeasible: r.isFeasible,
      payoffOrder: r.payoffOrder,
    });

    return {
      snowball: summarise(comparison.snowball),
      avalanche: summarise(comparison.avalanche),
      minimumOnly: summarise(comparison.minimumOnly),
      snowballExtraInterestMinor: comparison.snowballExtraInterestMinor,
      interestSavedVsMinimumMinor: comparison.interestSavedVsMinimumMinor,
      monthsSavedVsMinimum: comparison.monthsSavedVsMinimum,
      recommended: comparison.recommended,
      rationale: comparison.rationale,
    };
  }

  /** Debts due within `days`, for the upcoming-bills widget and reminders. */
  async upcomingDue(userId: string, days = 14) {
    const debts = await this.prisma.debt.findMany({
      where: { userId, deletedAt: null, isClosed: false },
    });
    const today = todayIso();

    return debts
      .map((debt) => {
        const due = nextDueDate(today, debt.dueDayOfMonth);
        const daysUntil = Math.round(
          (new Date(due).getTime() - new Date(today).getTime()) / 86_400_000,
        );
        return {
          id: debt.id,
          name: debt.name,
          amountMinor: toNumber(debt.minimumPaymentMinor),
          currency: debt.currency,
          dueDate: due,
          daysUntilDue: daysUntil,
        };
      })
      .filter((d) => d.daysUntilDue <= days)
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  }
}
