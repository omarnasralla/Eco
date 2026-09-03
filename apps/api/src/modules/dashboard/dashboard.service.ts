import { Injectable } from '@nestjs/common';
import {
  addMonths,
  emergencyFundTargetMinor,
  monthRange,
  nextDueDate,
  savingsRatePct,
} from '@eco/core';
import {
  CACHE_TTL_SECONDS,
  type CategoryBreakdownDto,
  type DashboardSummaryDto,
  type TrendPointDto,
  type UpcomingBillDto,
} from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { IncomeService } from '../income/income.service';
import { AccountsService } from '../accounts/accounts.service';
import { GoalsService } from '../goals/goals.service';
import { toNumber } from '../../common/utils/money';
import { monthToDate, todayIso } from '../../common/utils/dates';
import { CurrencyService } from '../currency/currency.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly income: IncomeService,
    private readonly goals: GoalsService,
    private readonly accounts: AccountsService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * The headline numbers.
   *
   * Cached for two minutes: a dashboard is loaded on every navigation and the
   * underlying aggregates are unchanged between them, but two minutes is short
   * enough that an expense the user just added shows up almost immediately —
   * and any write invalidates the whole user namespace anyway.
   */
  async summary(userId: string, userCurrency: string, month?: string): Promise<DashboardSummaryDto> {
    const targetMonth = month ?? todayIso().slice(0, 7);
    const cacheKey = this.redis.key(userId, 'dashboard', targetMonth);

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.dashboard, async () => {
      const previousMonth = addMonths(targetMonth, -1);

      const [
        expensesThis,
        expensesPrev,
        monthlyIncome,
        totalDebt,
        totalSavings,
        totalCash,
        goalCounts,
        upcomingBills,
      ] = await Promise.all([
        this.totalExpenses(userId, targetMonth),
        this.totalExpenses(userId, previousMonth),
        this.income.monthlyTotal(userId, userCurrency),
        this.totalDebt(userId, userCurrency),
        this.goals.totalSaved(userId, userCurrency),
        this.accounts.totalBalance(userId, userCurrency),
        this.goalCounts(userId),
        this.upcomingBills(userId, 14),
      ]);

      const netCashFlowMinor = monthlyIncome - expensesThis;

      // The savings rate is a trailing average over complete months, never the
      // month in progress.
      //
      // Two reasons. The month in progress is partial — on the 1st it holds a
      // single day of spending, and dividing full-month income by it reports a
      // 97% savings rate that is simply false. And a *single* complete month is
      // still too noisy: one holiday turns a healthy saver into a -47% headline.
      // Averaging three months matches the basis the financial health score
      // uses, so the two figures on this page agree instead of contradicting
      // each other.
      const basisMonths = [1, 2, 3].map((offset) => addMonths(targetMonth, -offset));
      const basisExpenses = await Promise.all(
        basisMonths.map((m) => this.totalExpenses(userId, m)),
      );
      const averageExpenses = Math.round(
        basisExpenses.reduce((sum, value) => sum + value, 0) / basisExpenses.length,
      );
      const savingsRateBasisMonth = `${basisMonths.at(-1)} to ${basisMonths[0]}`;
      const savingsRatePctValue = savingsRatePct(monthlyIncome, averageExpenses);

      // Cash in accounts, plus what is set aside in goals, less what is owed.
      // Cash belongs here because it is the part of net worth a person can
      // actually spend, and its absence was conspicuous: money received last
      // month and held for this one appeared nowhere at all.
      //
      // Still deliberately excludes illiquid assets — property and pensions are
      // not tracked, and a partial figure presented as "net worth" would
      // mislead in the flattering direction.
      const netWorthMinor = totalCash + totalSavings - totalDebt;

      const budget = await this.currentBudgetUtilisation(userId, targetMonth);

      return {
        currency: userCurrency,
        period: { from: `${targetMonth}-01`, to: this.endOfMonth(targetMonth) },
        totalIncomeMinor: monthlyIncome,
        totalExpensesMinor: expensesThis,
        netCashFlowMinor,
        savingsRatePct: savingsRatePctValue,
        savingsRateBasisMonth,
        totalDebtMinor: totalDebt,
        totalSavingsMinor: totalSavings,
        totalCashMinor: totalCash,
        netWorthMinor,
        deltas: {
          incomePct: 0, // Income is a run rate, so month-over-month is flat by construction.
          expensesPct: this.percentChange(expensesPrev, expensesThis),
          netWorthPct: 0,
        },
        upcomingBills,
        budgetUtilisationPct: budget,
        goalsOnTrack: goalCounts.onTrack,
        goalsTotal: goalCounts.total,
      } satisfies DashboardSummaryDto;
    });
  }

  /** Income vs expenses per month, for the trend chart. */
  async trend(userId: string, userCurrency: string, months = 12): Promise<TrendPointDto[]> {
    const cacheKey = this.redis.key(userId, 'trend', months);

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.categoryBreakdown, async () => {
      const thisMonth = todayIso().slice(0, 7);
      const from = addMonths(thisMonth, -(months - 1));

      // One grouped query for the whole window rather than N per-month queries.
      const rows = await this.prisma.$queryRaw<Array<{ month: string; total: bigint }>>`
        SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month,
               SUM("baseAmountMinor")::bigint AS total
        FROM expenses
        WHERE "userId" = ${userId}::uuid
          AND "deletedAt" IS NULL
          AND "date" >= ${monthToDate(from)}
        GROUP BY 1
        ORDER BY 1
      `;

      const expenseByMonth = new Map(rows.map((r) => [r.month, toNumber(r.total)]));
      const monthlyIncome = await this.income.monthlyTotal(userId, userCurrency);

      return monthRange(`${from}-01`, `${thisMonth}-28`).map((m) => {
        const expensesMinor = expenseByMonth.get(m) ?? 0;
        return {
          month: m,
          incomeMinor: monthlyIncome,
          expensesMinor,
          netMinor: monthlyIncome - expensesMinor,
        };
      });
    });
  }

  /** Spend by category for a month, with change against the previous month. */
  async categoryBreakdown(
    userId: string,
    month: string,
  ): Promise<CategoryBreakdownDto[]> {
    const cacheKey = this.redis.key(userId, 'breakdown', month);

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.categoryBreakdown, async () => {
      const [current, previous] = await Promise.all([
        this.spendByCategoryWithMeta(userId, month),
        this.spendByCategoryWithMeta(userId, addMonths(month, -1)),
      ]);

      const previousById = new Map(previous.map((c) => [c.categoryId, c.amountMinor]));
      const total = current.reduce((sum, c) => sum + c.amountMinor, 0);

      return current
        .map((c) => {
          const prior = previousById.get(c.categoryId);
          return {
            categoryId: c.categoryId,
            categoryName: c.categoryName,
            color: c.color,
            amountMinor: c.amountMinor,
            sharePct: total > 0 ? Math.round((c.amountMinor / total) * 1000) / 10 : 0,
            // Null rather than 0 when there is no prior month: "no data" and
            // "no change" are different statements and the chart shows them
            // differently.
            changePct: prior !== undefined ? this.percentChange(prior, c.amountMinor) : null,
            transactionCount: c.transactionCount,
          };
        })
        .sort((a, b) => b.amountMinor - a.amountMinor);
    });
  }

  /** Debt payments and recurring expenses falling due soon. */
  async upcomingBills(userId: string, days = 14): Promise<UpcomingBillDto[]> {
    const today = todayIso();

    const [debts, recurring] = await Promise.all([
      this.prisma.debt.findMany({
        where: { userId, deletedAt: null, isClosed: false },
        select: {
          id: true,
          name: true,
          minimumPaymentMinor: true,
          currency: true,
          dueDayOfMonth: true,
        },
      }),
      this.prisma.expense.findMany({
        where: { userId, deletedAt: null, isRecurring: true },
        distinct: ['merchant'],
        orderBy: { date: 'desc' },
        take: 50,
        select: {
          id: true,
          merchant: true,
          amountMinor: true,
          currency: true,
          date: true,
          category: { select: { color: true } },
        },
      }),
    ]);

    const bills: UpcomingBillDto[] = debts.map((debt) => {
      const dueDate = nextDueDate(today, debt.dueDayOfMonth);
      return {
        id: debt.id,
        source: 'DEBT' as const,
        name: debt.name,
        amountMinor: toNumber(debt.minimumPaymentMinor),
        currency: debt.currency,
        dueDate,
        daysUntilDue: this.daysBetween(today, dueDate),
        categoryColor: null,
      };
    });

    for (const expense of recurring) {
      // Project the next occurrence from the day-of-month it last landed on.
      const dueDate = nextDueDate(today, Number(expense.date.toISOString().slice(8, 10)));
      bills.push({
        id: expense.id,
        source: 'RECURRING_EXPENSE',
        name: expense.merchant ?? 'Recurring expense',
        amountMinor: toNumber(expense.amountMinor),
        currency: expense.currency,
        dueDate,
        daysUntilDue: this.daysBetween(today, dueDate),
        categoryColor: expense.category?.color ?? null,
      });
    }

    return bills
      .filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= days)
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
      .slice(0, 20);
  }

  /** Net worth over time, for the sparkline on the net-worth card. */
  async netWorthHistory(userId: string, months = 12) {
    const thisMonth = todayIso().slice(0, 7);
    const from = addMonths(thisMonth, -(months - 1));

    // Reconstruct history from the ledgers: debt balances after each payment,
    // and cumulative goal contributions.
    const [debtPoints, contributionPoints] = await Promise.all([
      this.prisma.$queryRaw<Array<{ month: string; balance: bigint }>>`
        SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month,
               SUM("balanceAfterMinor")::bigint AS balance
        FROM debt_payments
        WHERE "userId" = ${userId}::uuid AND "date" >= ${monthToDate(from)}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ month: string; total: bigint }>>`
        SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month,
               SUM("amountMinor")::bigint AS total
        FROM goal_contributions
        WHERE "userId" = ${userId}::uuid AND "date" >= ${monthToDate(from)}
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    const debtByMonth = new Map(debtPoints.map((r) => [r.month, toNumber(r.balance)]));
    const contributionByMonth = new Map(contributionPoints.map((r) => [r.month, toNumber(r.total)]));

    let cumulativeSavings = 0;
    return monthRange(`${from}-01`, `${thisMonth}-28`).map((month) => {
      cumulativeSavings += contributionByMonth.get(month) ?? 0;
      const debt = debtByMonth.get(month) ?? 0;
      return {
        month,
        savingsMinor: cumulativeSavings,
        debtMinor: debt,
        netWorthMinor: cumulativeSavings - debt,
      };
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async totalExpenses(userId: string, month: string): Promise<number> {
    const result = await this.prisma.expense.aggregate({
      where: {
        userId,
        deletedAt: null,
        date: { gte: monthToDate(month), lt: monthToDate(addMonths(month, 1)) },
      },
      _sum: { baseAmountMinor: true },
    });
    return toNumber(result._sum.baseAmountMinor ?? BigInt(0));
  }

  /**
   * Outstanding debt in the user's base currency.
   *
   * A SQL `SUM` over `currentBalanceMinor` would be faster but silently adds
   * unlike units — a £5,000 card and a $5,000 loan summing to "10,000" of
   * whichever currency the page happens to be labelled with. Balances are
   * current values rather than dated events, so today's rate is the right one.
   */
  private async totalDebt(userId: string, userCurrency: string): Promise<number> {
    const debts = await this.prisma.debt.findMany({
      where: { userId, deletedAt: null, isClosed: false },
      select: { currentBalanceMinor: true, currency: true },
    });

    let total = 0;
    for (const debt of debts) {
      total += await this.currency.convertForDisplay(
        toNumber(debt.currentBalanceMinor),
        debt.currency,
        userCurrency,
      );
    }
    return total;
  }

  private async goalCounts(userId: string): Promise<{ onTrack: number; total: number }> {
    const goals = await this.goals.findAll(userId);
    return { onTrack: goals.filter((g) => g.onTrack).length, total: goals.length };
  }

  private async currentBudgetUtilisation(
    userId: string,
    month: string,
  ): Promise<number | null> {
    const budget = await this.prisma.budget.findFirst({
      where: { userId, month: monthToDate(month), deletedAt: null },
      include: { lines: true },
    });
    if (!budget) return null;

    const limit =
      toNumber(budget.totalLimitMinor ?? BigInt(0)) ||
      budget.lines.reduce((sum, l) => sum + toNumber(l.limitMinor), 0);
    if (limit <= 0) return null;

    const spent = await this.totalExpenses(userId, month);
    return Math.round((spent / limit) * 1000) / 10;
  }

  private async spendByCategoryWithMeta(userId: string, month: string) {
    const rows = await this.prisma.expense.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        deletedAt: null,
        date: { gte: monthToDate(month), lt: monthToDate(addMonths(month, 1)) },
      },
      _sum: { baseAmountMinor: true },
      _count: { _all: true },
    });
    if (rows.length === 0) return [];

    const categories = await this.prisma.category.findMany({
      where: { id: { in: rows.map((r) => r.categoryId) } },
      select: { id: true, name: true, color: true },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));

    return rows.map((row) => ({
      categoryId: row.categoryId,
      categoryName: byId.get(row.categoryId)?.name ?? 'Unknown',
      color: byId.get(row.categoryId)?.color ?? '#64748b',
      amountMinor: toNumber(row._sum.baseAmountMinor ?? BigInt(0)),
      transactionCount: row._count._all,
    }));
  }

  private percentChange(from: number, to: number): number {
    if (from === 0) return to === 0 ? 0 : 100;
    return Math.round(((to - from) / Math.abs(from)) * 1000) / 10;
  }

  private daysBetween(from: string, to: string): number {
    return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
  }

  private endOfMonth(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  }

  /** Essential monthly spend — the denominator of the emergency-fund target. */
  async emergencyFundTarget(userId: string, months = 3): Promise<number> {
    const month = todayIso().slice(0, 7);
    const rows = await this.prisma.expense.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        deletedAt: null,
        date: { gte: monthToDate(addMonths(month, -3)), lt: monthToDate(addMonths(month, 1)) },
      },
      _sum: { baseAmountMinor: true },
    });

    const essentials = await this.prisma.category.findMany({
      where: { userId, isEssential: true },
      select: { id: true },
    });
    const essentialIds = new Set(essentials.map((c) => c.id));

    const totalOverThreeMonths = rows
      .filter((r) => essentialIds.has(r.categoryId))
      .reduce((sum, r) => sum + toNumber(r._sum.baseAmountMinor ?? BigInt(0)), 0);

    return emergencyFundTargetMinor(Math.round(totalOverThreeMonths / 3), months);
  }
}
