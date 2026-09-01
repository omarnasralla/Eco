import { Injectable } from '@nestjs/common';
import {
  addMonths,
  completeMonthsOnly,
  detectRecurringExpenses,
  financialHealthScore,
  forecastCashFlow,
  generateRecommendations,
  incomeVolatility,
  monthlyTotals,
  seasonalityIndex,
  topMerchants,
  weekdayDistribution,
  type FinancialSnapshot,
  type TransactionLike,
} from '@eco/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IncomeService } from '../income/income.service';
import { GoalsService } from '../goals/goals.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { decimalToNumber, toNumber } from '../../common/utils/money';
import { monthToDate, requireIsoDate, todayIso } from '../../common/utils/dates';

/**
 * Assembles the financial picture that both the recommendation engine and the
 * LLM reason over.
 *
 * This is the only place that reads a user's raw ledger for AI purposes. It
 * returns a bounded, aggregated snapshot — never a stream of individual
 * transactions — which keeps the prompt small, the latency low, and the amount
 * of personal data crossing into the model to the minimum that answers the
 * question.
 */
@Injectable()
export class AiContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly income: IncomeService,
    private readonly goals: GoalsService,
    private readonly dashboard: DashboardService,
  ) {}

  /** Transactions over the trailing window, for pattern detection. */
  async transactions(userId: string, months = 12): Promise<TransactionLike[]> {
    const from = addMonths(todayIso().slice(0, 7), -months);
    const rows = await this.prisma.expense.findMany({
      where: { userId, deletedAt: null, date: { gte: monthToDate(from) } },
      select: {
        id: true,
        baseAmountMinor: true,
        categoryId: true,
        date: true,
        merchant: true,
      },
      orderBy: { date: 'asc' },
      // Hard cap: a heavy user with five years of daily coffee should not be
      // able to make one AI request pull a hundred thousand rows into memory.
      take: 20_000,
    });

    return rows.map((row) => ({
      id: row.id,
      amountMinor: toNumber(row.baseAmountMinor),
      categoryId: row.categoryId,
      date: requireIsoDate(row.date),
      merchant: row.merchant,
    }));
  }

  /** The full snapshot the deterministic recommendation engine consumes. */
  async buildSnapshot(userId: string, userCurrency: string): Promise<FinancialSnapshot> {
    const thisMonth = todayIso().slice(0, 7);
    // The recommendation copy formats money with this, so a GB user reads
    // "£1,615.95" rather than a US-formatted figure in their own currency.
    const { locale } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { locale: true },
    });

    const [transactions, monthlyIncomeMinor, liquidSavingsMinor, debts, categories] =
      await Promise.all([
        this.transactions(userId, 12),
        this.income.monthlyTotal(userId, userCurrency),
        this.goals.totalSaved(userId, userCurrency),
        this.prisma.debt.findMany({ where: { userId, deletedAt: null, isClosed: false } }),
        this.prisma.category.findMany({
          where: { userId, deletedAt: null },
          select: { id: true, name: true, isEssential: true },
        }),
      ]);

    const categoryMeta = new Map(categories.map((c) => [c.id, c]));

    // Current month per category, plus the median of the preceding months so
    // "unusual" is measured against the user's own baseline.
    const currentByCategory = new Map<string, number>();
    const historyByCategory = new Map<string, number[]>();

    for (const tx of transactions) {
      const month = tx.date.slice(0, 7);
      if (month === thisMonth) {
        currentByCategory.set(tx.categoryId, (currentByCategory.get(tx.categoryId) ?? 0) + tx.amountMinor);
      }
    }

    const monthlyByCategory = new Map<string, Map<string, number>>();
    for (const tx of transactions) {
      const month = tx.date.slice(0, 7);
      if (month === thisMonth) continue;
      const perMonth = monthlyByCategory.get(tx.categoryId) ?? new Map<string, number>();
      perMonth.set(month, (perMonth.get(month) ?? 0) + tx.amountMinor);
      monthlyByCategory.set(tx.categoryId, perMonth);
    }
    for (const [categoryId, perMonth] of monthlyByCategory) {
      historyByCategory.set(categoryId, [...perMonth.values()]);
    }

    const spendByCategory = [...new Set([...currentByCategory.keys(), ...historyByCategory.keys()])].map(
      (categoryId) => {
        const history = historyByCategory.get(categoryId) ?? [];
        const sorted = [...history].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median =
          sorted.length === 0
            ? 0
            : sorted.length % 2 === 0
              ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
              : (sorted[mid] ?? 0);

        return {
          categoryId,
          categoryName: categoryMeta.get(categoryId)?.name ?? 'Unknown',
          amountMinor: currentByCategory.get(categoryId) ?? 0,
          historicalMedianMinor: median,
          isEssential: categoryMeta.get(categoryId)?.isEssential ?? false,
        };
      },
    );

    // See ai.service.ts: forecasts are built from complete months only.
    const expenseHistory = completeMonthsOnly(
      monthlyTotals(transactions).map((t) => ({
        month: t.month,
        valueMinor: t.amountMinor,
      })),
      todayIso(),
    );
    const incomeHistory = expenseHistory.map((p) => ({
      month: p.month,
      valueMinor: monthlyIncomeMinor,
    }));

    const seasonal = seasonalityIndex(monthlyTotals(transactions)).map((s) => s.indexVsAverage);

    const forecast = forecastCashFlow({
      incomeHistory,
      expenseHistory,
      openingBalanceMinor: liquidSavingsMinor,
      horizon: 6,
      seasonalIndices: seasonal,
    }).points;

    const monthlyExpensesMinor =
      expenseHistory.length > 0
        ? Math.round(
            expenseHistory.slice(-3).reduce((s, p) => s + p.valueMinor, 0) /
              Math.min(expenseHistory.length, 3),
          )
        : 0;

    return {
      currency: userCurrency,
      locale,
      monthlyIncomeMinor,
      monthlyExpensesMinor,
      liquidSavingsMinor,
      spendByCategory,
      debts: debts.map((d) => ({
        id: d.id,
        name: d.name,
        currentBalanceMinor: toNumber(d.currentBalanceMinor),
        interestRateApr: decimalToNumber(d.interestRateApr),
        minimumPaymentMinor: toNumber(d.minimumPaymentMinor),
      })),
      recurring: detectRecurringExpenses(transactions),
      forecast,
      emergencyFundTargetMinor: await this.dashboard.emergencyFundTarget(userId),
    };
  }

  /** Learned spending patterns: recurring charges, seasonality, consistency. */
  async patterns(userId: string, userCurrency: string) {
    const transactions = await this.transactions(userId, 24);
    const monthlyIncomeMinor = await this.income.monthlyTotal(userId, userCurrency);

    const totals = monthlyTotals(transactions);
    const categories = await this.prisma.category.findMany({
      where: { userId },
      select: { id: true, name: true },
    });
    const nameById = new Map(categories.map((c) => [c.id, c.name]));

    return {
      recurringExpenses: detectRecurringExpenses(transactions).map((r) => ({
        merchant: r.merchant,
        categoryId: r.categoryId,
        categoryName: nameById.get(r.categoryId) ?? 'Unknown',
        averageAmountMinor: r.averageAmountMinor,
        frequency: r.frequency,
        lastSeen: r.lastSeen,
        nextExpectedDate: r.nextExpectedDate,
        occurrences: r.occurrences,
        confidence: r.confidence,
      })),
      // Income consistency is derived from the run rate repeated across the
      // observed months; once IncomeReceipt rows accumulate we switch to
      // actuals, which will show real volatility for freelancers.
      incomeConsistency: incomeVolatility(totals.map(() => monthlyIncomeMinor)),
      seasonality: seasonalityIndex(totals),
      topMerchants: topMerchants(transactions, 10),
      weekdayDistribution: weekdayDistribution(transactions),
      monthsAnalysed: totals.length,
      transactionsAnalysed: transactions.length,
    };
  }

  /** Deterministic recommendations plus a financial health score. */
  async insights(userId: string, userCurrency: string) {
    const snapshot = await this.buildSnapshot(userId, userCurrency);
    return {
      recommendations: generateRecommendations(snapshot),
      health: financialHealthScore(snapshot),
      snapshot,
    };
  }
}
