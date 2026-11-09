import { Injectable } from '@nestjs/common';
import {
  addMonths,
  emergencyFundTargetMinor,
  monthRange,
  nextDueDate,
  nextOccurrence,
  savingsRatePct,
} from '@eco/core';
import {
  CACHE_TTL_SECONDS,
  type CategoryBreakdownDto,
  type DashboardSummaryDto,
  type TrendPointDto,
  type UpcomingBillDto,
  type BreakdownLineDto,
  type DashboardBreakdownDto,
  type DashboardMetric,
  formatMoney,
} from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { IncomeService } from '../income/income.service';
import { AccountsService } from '../accounts/accounts.service';
import { GoalsService } from '../goals/goals.service';
import { ReceivablesService } from '../receivables/receivables.service';
import { toNumber } from '../../common/utils/money';
import { monthToDate, requireIsoDate, todayIso } from '../../common/utils/dates';
import { CurrencyService } from '../currency/currency.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly income: IncomeService,
    private readonly goals: GoalsService,
    private readonly receivables: ReceivablesService,
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
        incomeByMonth,
        totalDebt,
        totalSavings,
        totalCash,
        goalCounts,
        upcomingBills,
        owedToUser,
      ] = await Promise.all([
        this.totalExpenses(userId, targetMonth),
        this.totalExpenses(userId, previousMonth),
        // What each month actually earned, not a run rate: a one-off payment,
        // a bonus or an irregular invoice is income, and reporting zero for a
        // month that paid the rent is simply wrong. Both months come back in
        // one pass so the month-over-month delta costs no extra queries.
        this.income.incomeBreakdownByMonth(userId, userCurrency, [previousMonth, targetMonth]),
        this.totalDebt(userId, userCurrency),
        this.goals.totalSaved(userId, userCurrency),
        this.accounts.totalBalance(userId, userCurrency),
        this.goalCounts(userId),
        this.upcomingBills(userId, 14),
        // Money lent out is still the user's money, in someone else's hands.
        // Left out, net worth drops by the whole loan the moment it is made,
        // which reports a loss where nothing was lost.
        this.receivables.totalOutstanding(userId, userCurrency),
      ]);

      // Received only. Salary that has not landed yet is money the user does
      // not have, and netting it against spending that has already happened
      // reports a balance nobody holds — the headline read +$3,114 on an
      // account whose entire receipt history was $2,071.
      const incomeThis = incomeByMonth.get(targetMonth)?.received ?? 0;
      const incomePrev = incomeByMonth.get(previousMonth)?.received ?? 0;
      const expectedIncomeMinor = incomeByMonth.get(targetMonth)?.expected ?? 0;
      const netCashFlowMinor = incomeThis - expensesThis;

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
      // Income is averaged over the same three months as expenses. Now that it
      // varies month to month, holding one side to a single month and the other
      // to a trailing average would compare unlike things — a month that
      // happened to carry a bonus would read as a spectacular saver.
      const basisIncome = await this.income.incomeByMonth(userId, userCurrency, basisMonths);
      const averageIncome = Math.round(
        basisMonths.reduce((sum, m) => sum + (basisIncome.get(m) ?? 0), 0) / basisMonths.length,
      );
      const savingsRateBasisMonth = `${basisMonths.at(-1)} to ${basisMonths[0]}`;
      const savingsRatePctValue = savingsRatePct(averageIncome, averageExpenses);

      // Cash in accounts, plus what is set aside in goals, less what is owed.
      // Cash belongs here because it is the part of net worth a person can
      // actually spend, and its absence was conspicuous: money received last
      // month and held for this one appeared nowhere at all.
      //
      // Still deliberately excludes illiquid assets — property and pensions are
      // not tracked, and a partial figure presented as "net worth" would
      // mislead in the flattering direction.
      const netWorthMinor = totalCash + totalSavings + owedToUser - totalDebt;

      const budget = await this.currentBudgetUtilisation(userId, targetMonth);

      return {
        currency: userCurrency,
        period: { from: `${targetMonth}-01`, to: this.endOfMonth(targetMonth) },
        totalIncomeMinor: incomeThis,
        expectedIncomeMinor,
        totalExpensesMinor: expensesThis,
        netCashFlowMinor,
        savingsRatePct: savingsRatePctValue,
        savingsRateBasisMonth,
        savingsRateBasisIncomeMinor: averageIncome,
        totalDebtMinor: totalDebt,
        totalSavingsMinor: totalSavings,
        totalCashMinor: totalCash,
        owedToUserMinor: owedToUser,
        netWorthMinor,
        deltas: {
          incomePct: this.percentChange(incomePrev, incomeThis),
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
      const window = monthRange(`${from}-01`, `${thisMonth}-28`);

      // Income per month, not one run rate repeated across the chart. A flat
      // line cannot show a bonus, a gap between contracts, or a month with
      // three paycheques — which is most of what an income trend is for.
      const incomeByMonth = await this.income.incomeByMonth(userId, userCurrency, window);

      return window.map((m) => {
        const expensesMinor = expenseByMonth.get(m) ?? 0;
        const incomeMinor = incomeByMonth.get(m) ?? 0;
        return {
          month: m,
          incomeMinor,
          expensesMinor,
          netMinor: incomeMinor - expensesMinor,
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
          recurringFrequency: true,
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
      // Project from the charge's own cadence, and never return the occurrence
      // being projected from: a subscription billed on the 4th and looked at
      // on the 4th would otherwise match itself and come back as "due today" —
      // the bill just paid, listed as one still owed.
      const lastLanded = expense.date.toISOString().slice(0, 10);
      const dueDate = nextOccurrence({
        last: lastLanded,
        // A row flagged recurring without a cadence is treated as monthly:
        // that is what every such row created before the field was settable
        // actually is, and dropping them from the list would hide real bills.
        frequency: expense.recurringFrequency ?? 'MONTHLY',
        from: today,
      });
      if (!dueDate) continue;
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

  /**
   * How a headline figure was reached.
   *
   * Every card on the dashboard is a single number standing for a lot of rows,
   * and a number you cannot take apart is a number you cannot check — "income
   * $4,313.33" looked wrong and was, but only because it could be opened up.
   * So each metric explains itself from the same data the card is computed
   * from, and the lines are made to add to the total: a remainder is shown
   * rather than letting a breakdown quietly disagree with the figure above it.
   */
  async breakdown(
    userId: string,
    userCurrency: string,
    metric: DashboardMetric,
    month: string,
  ): Promise<DashboardBreakdownDto> {
    const from = monthToDate(month);
    const to = monthToDate(addMonths(month, 1));
    const base = { metric, month, currency: userCurrency };

    // Money as it actually sits, named only when it differs from the base
    // currency — "SAR 1,822.41" beside "$485.98" explains a figure that
    // otherwise looks invented.
    const native = (minor: number, currency: string) =>
      currency === userCurrency ? null : `${currency} ${(minor / 100).toFixed(2)}`;

    if (metric === 'income') {
      const receipts = await this.prisma.incomeReceipt.findMany({
        where: { userId, date: { gte: from, lt: to } },
        orderBy: { date: 'asc' },
        include: { incomeSource: { select: { name: true } } },
      });
      const lines: BreakdownLineDto[] = receipts.map((r) => ({
        label: r.name ?? r.incomeSource?.name ?? 'Income',
        amountMinor: toNumber(r.baseAmountMinor),
        nativeLabel: native(toNumber(r.amountMinor), r.currency),
        detail: requireIsoDate(r.date),
      }));
      return {
        ...base,
        totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
        lines,
        note:
          'Money you were paid. Transfers between your own accounts, cash put in and ' +
          'people settling up are not income and are left out.',
      };
    }

    if (metric === 'expenses') {
      const rows = await this.spendByCategoryWithMeta(userId, month);
      const lines: BreakdownLineDto[] = rows
        .map((r) => ({
          label: r.categoryName,
          amountMinor: r.amountMinor,
          nativeLabel: null,
          detail: null,
        }))
        .sort((a, b) => b.amountMinor - a.amountMinor);
      return {
        ...base,
        totalMinor: await this.totalExpenses(userId, month),
        lines,
        note: 'By category. A transfer to another of your accounts is not spending.',
      };
    }

    if (metric === 'netCashFlow') {
      const income = await this.income.incomeBreakdownByMonth(userId, userCurrency, [month]);
      const received = income.get(month)?.received ?? 0;
      const spent = await this.totalExpenses(userId, month);
      return {
        ...base,
        totalMinor: received - spent,
        lines: [
          { label: 'Income received', amountMinor: received, nativeLabel: null, detail: null },
          { label: 'Spent', amountMinor: -spent, nativeLabel: null, detail: null },
        ],
        note: 'Received, not expected. Pay that has not landed is money you do not have.',
      };
    }

    if (metric === 'debt') {
      const debts = await this.prisma.debt.findMany({
        where: { userId, deletedAt: null, isClosed: false },
        select: { name: true, currentBalanceMinor: true, currency: true },
        orderBy: { currentBalanceMinor: 'desc' },
      });
      const lines: BreakdownLineDto[] = [];
      for (const d of debts) {
        lines.push({
          label: d.name,
          amountMinor: await this.currency.convertForDisplay(
            toNumber(d.currentBalanceMinor),
            d.currency,
            userCurrency,
          ),
          nativeLabel: native(toNumber(d.currentBalanceMinor), d.currency),
          detail: null,
        });
      }
      return {
        ...base,
        totalMinor: lines.reduce((sum, l) => sum + l.amountMinor, 0),
        lines,
        // Not a month figure at all, and saying so stops it being read as one.
        note: 'What is outstanding now, not what moved this month. Closed debts are left out.',
      };
    }

    if (metric === 'cash') {
      const accounts = await this.accounts.findAll(userId);
      const lines: BreakdownLineDto[] = [];
      let reserved = 0;
      for (const a of accounts) {
        const provenance = a.anchor
          ? `bank figure for ···${a.anchor.cardLast4}, ${a.anchor.asOf}`
          : `${a.movementCount} movement${a.movementCount === 1 ? '' : 's'} since ${a.openingBalanceDate}`;
        // Said on the account that holds it, because "which account is the
        // reserved money in" is the next question after "how much".
        const held =
          a.reservedMinor > 0
            ? `${provenance} · ${formatMoney(a.reservedMinor, a.currency)} reserved`
            : provenance;
        reserved += await this.currency.convertForDisplay(
          a.reservedMinor,
          a.currency,
          userCurrency,
        );
        lines.push({
          label: a.name,
          amountMinor: await this.currency.convertForDisplay(
            a.balanceMinor,
            a.currency,
            userCurrency,
          ),
          nativeLabel: native(a.balanceMinor, a.currency),
          detail: held,
        });
      }

      const totalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);

      // Cash on hand is every balance, and the balances are right — but some
      // of that money is already promised to a goal, and a total that does not
      // say so reads as money free to spend. Stated as a memo rather than
      // subtracted: the cash is genuinely held, it simply is not all free.
      if (reserved > 0) {
        lines.push({
          label: 'Free to spend',
          amountMinor: totalMinor - reserved,
          nativeLabel: null,
          detail: `${formatMoney(reserved, userCurrency)} of this is reserved for savings goals`,
          memo: true,
        });
      }

      return {
        ...base,
        totalMinor,
        lines,
        note: 'Every account, converted at today\'s rate. A balance is a position held now.',
      };
    }

    const [cash, savings, earmarked, debt, owed] = await Promise.all([
      this.accounts.totalBalance(userId, userCurrency),
      this.goals.totalSaved(userId, userCurrency),
      this.goals.totalAlreadyCounted(userId, userCurrency),
      this.totalDebt(userId, userCurrency),
      this.receivables.totalOutstanding(userId, userCurrency),
    ]);
    return {
      ...base,
      totalMinor: cash + savings + owed - debt,
      lines: [
        { label: 'Cash on hand', amountMinor: cash, nativeLabel: null, detail: null },
        {
          label: 'Savings',
          amountMinor: savings,
          nativeLabel: null,
          // Said out loud, so a goal balance missing from this line does not
          // look like a goal that was lost.
          detail:
            earmarked > 0
              ? `Not counting ${formatMoney(earmarked, userCurrency)} set aside in goals from cash or loans already listed`
              : null,
        },
        { label: 'Owed to you', amountMinor: owed, nativeLabel: null, detail: null },
        { label: 'Debt', amountMinor: -debt, nativeLabel: null, detail: null },
      ],
      note:
        'What you hold, plus what people owe you, less what you owe. ' +
        'Property and pensions are not tracked.',
    };
  }

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
    const thisMonth = todayIso().slice(0, 7);
    // Complete months only. The month in progress is partial — on the 2nd it
    // holds two days of essentials — and averaging it in reports a monthly
    // cost nobody could actually live on.
    const window = [1, 2, 3].map((back) => addMonths(thisMonth, -back));
    const earliest = window[window.length - 1]!;

    const rows = await this.prisma.expense.groupBy({
      by: ['categoryId'],
      where: {
        userId,
        deletedAt: null,
        excludedFromBudget: false,
        date: { gte: monthToDate(earliest), lt: monthToDate(thisMonth) },
      },
      _sum: { baseAmountMinor: true },
    });

    const essentials = await this.prisma.category.findMany({
      where: { userId, isEssential: true },
      select: { id: true },
    });
    const essentialIds = new Set(essentials.map((c) => c.id));

    const total = rows
      .filter((r) => essentialIds.has(r.categoryId))
      .reduce((sum, r) => sum + toNumber(r._sum.baseAmountMinor ?? BigInt(0)), 0);

    // Divided by the months that actually have spending in them, not a flat
    // three. A ledger two months old has one empty month in the window, and
    // dividing by three there understates the monthly cost by a third —
    // producing a target too small to survive the thing it is for.
    const active = await this.prisma.expense.findMany({
      where: {
        userId,
        deletedAt: null,
        date: { gte: monthToDate(earliest), lt: monthToDate(thisMonth) },
      },
      select: { date: true },
    });
    const activeMonths = new Set(active.map((e) => requireIsoDate(e.date).slice(0, 7))).size;

    return emergencyFundTargetMinor(Math.round(total / Math.max(activeMonths, 1)), months);
  }
}
