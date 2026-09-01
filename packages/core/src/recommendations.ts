import { formatMoney, type RecommendationKind } from '@eco/shared';
import type { DebtLike } from './debt';
import { compareStrategies, monthlyInterestMinor } from './debt';
import type { RecurringExpense } from './patterns';
import { savingsRatePct } from './savings';
import type { CashFlowForecastPoint } from './forecast';

/**
 * The recommendation engine is **deterministic and numeric**.
 *
 * Every figure a user sees — "cut £180/month", "save £4,120 in interest" — is
 * computed here, from their own data, with the inputs attached as `evidence`.
 * The LLM never invents a number; it only rewrites these findings into natural
 * language and answers follow-up questions about them.  That split is what
 * makes the advice auditable, reproducible, and safe to put in front of someone
 * making a real financial decision.
 */

export interface Recommendation {
  kind: RecommendationKind;
  title: string;
  body: string;
  /** Monthly money impact if acted on; null when not quantifiable. */
  estimatedImpactMinor: number | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  /** The exact inputs behind the advice, shown in the UI. */
  evidence: Array<{ label: string; value: string }>;
  actionUrl: string | null;
}

export interface FinancialSnapshot {
  currency: string;
  /** BCP-47 tag used to format the money in the generated copy. */
  locale?: string;
  monthlyIncomeMinor: number;
  monthlyExpensesMinor: number;
  liquidSavingsMinor: number;
  /** Current-month spend per category, in minor units. */
  spendByCategory: Array<{
    categoryId: string;
    categoryName: string;
    amountMinor: number;
    /** Median of the preceding months, for a fair comparison. */
    historicalMedianMinor: number;
    isEssential: boolean;
  }>;
  debts: DebtLike[];
  recurring: RecurringExpense[];
  forecast: CashFlowForecastPoint[];
  emergencyFundTargetMinor: number;
  /** Contribution the user has told us they want to hit each month. */
  targetSavingsRatePct?: number;
}

/** Fractions of a currency unit below which advice is not worth the interruption. */
const MIN_IMPACT_MINOR = 500; // e.g. $5.00/month

/**
 * Binds a money formatter to a snapshot's currency and locale.
 *
 * Everything user-facing in this file — titles, bodies and the `evidence`
 * rows — renders through it. Minor units are an internal representation; a
 * recommendation that tells someone they could "save 5079 a month" is worse
 * than no recommendation at all.
 */
function moneyFormatter(s: FinancialSnapshot): (minor: number) => string {
  const options = { locale: s.locale ?? 'en-US' };
  return (minor: number) => formatMoney(minor, s.currency, options);
}

export function generateRecommendations(snapshot: FinancialSnapshot): Recommendation[] {
  const out: Recommendation[] = [
    ...cashflowWarnings(snapshot),
    ...categoryOverspend(snapshot),
    ...debtAdvice(snapshot),
    ...idleCashAdvice(snapshot),
    ...emergencyFundAdvice(snapshot),
    ...subscriptionAdvice(snapshot),
  ];

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return out
    .filter((r) => r.estimatedImpactMinor === null || Math.abs(r.estimatedImpactMinor) >= MIN_IMPACT_MINOR)
    .sort(
      (a, b) =>
        rank[a.priority] - rank[b.priority] ||
        (b.estimatedImpactMinor ?? 0) - (a.estimatedImpactMinor ?? 0),
    );
}

/** An impending negative balance outranks everything else we could say. */
function cashflowWarnings(s: FinancialSnapshot): Recommendation[] {
  const firstShortfall = s.forecast.find((p) => p.isShortfall);
  if (!firstShortfall) return [];

  const fmt = moneyFormatter(s);
  const gap = Math.abs(Math.min(firstShortfall.projectedBalanceMinor, 0));
  const perMonth = Math.ceil(gap / Math.max(monthsUntil(s.forecast, firstShortfall.month), 1));

  return [
    {
      kind: 'CASHFLOW_WARNING',
      title: `Projected shortfall in ${firstShortfall.month}`,
      body: `On your current trajectory your balance dips below zero in ${firstShortfall.month}. Closing a gap of this size needs roughly ${fmt(perMonth)} per month set aside between now and then, or a matching cut in spending.`,
      estimatedImpactMinor: gap,
      priority: 'HIGH',
      evidence: [
        { label: 'Projected balance', value: fmt(firstShortfall.projectedBalanceMinor) },
        { label: 'Projected income', value: fmt(firstShortfall.projectedIncomeMinor) },
        { label: 'Projected expenses', value: fmt(firstShortfall.projectedExpensesMinor) },
      ],
      actionUrl: '/budgets',
    },
  ];
}

function monthsUntil(forecast: CashFlowForecastPoint[], month: string): number {
  return Math.max(forecast.findIndex((p) => p.month === month), 0) + 1;
}

/**
 * Flags discretionary categories running materially above their own historical
 * median.  The comparison is against the user's own past behaviour, never
 * against a population average — "you spend more on food than the average
 * household" is noise; "you spend 34% more on food than you usually do" is a
 * fact they can act on.
 */
function categoryOverspend(s: FinancialSnapshot): Recommendation[] {
  const fmt = moneyFormatter(s);
  return s.spendByCategory
    .filter((c) => !c.isEssential && c.historicalMedianMinor > 0)
    .map((c) => {
      const overBy = c.amountMinor - c.historicalMedianMinor;
      const overPct = Math.round((overBy / c.historicalMedianMinor) * 100);
      return { c, overBy, overPct };
    })
    .filter(({ overPct, overBy }) => overPct >= 20 && overBy >= MIN_IMPACT_MINOR)
    .slice(0, 3)
    .map(({ c, overBy, overPct }): Recommendation => {
      // Suggest closing most of the gap, not all of it — an achievable target.
      const suggestedCutMinor = Math.round(overBy * 0.75);
      return {
        kind: 'REDUCE_CATEGORY_SPEND',
        title: `${c.categoryName} is ${overPct}% above your usual`,
        body: `You have spent ${fmt(c.amountMinor)} on ${c.categoryName} this month against a typical ${fmt(c.historicalMedianMinor)}. Trimming ${fmt(suggestedCutMinor)} would bring you back in line without touching your essentials.`,
        estimatedImpactMinor: suggestedCutMinor,
        priority: overPct >= 50 ? 'HIGH' : 'MEDIUM',
        evidence: [
          { label: 'This month', value: fmt(c.amountMinor) },
          { label: 'Your typical month', value: fmt(c.historicalMedianMinor) },
          { label: 'Difference', value: `+${overPct}%` },
        ],
        actionUrl: `/expenses?categoryId=${c.categoryId}`,
      };
    });
}

/**
 * Two distinct pieces of debt advice: refinance anything priced far above the
 * rest of the portfolio, and redirect surplus into the payoff plan.
 */
function debtAdvice(s: FinancialSnapshot): Recommendation[] {
  const open = s.debts.filter((d) => d.currentBalanceMinor > 0);
  if (open.length === 0) return [];

  const fmt = moneyFormatter(s);
  const recommendations: Recommendation[] = [];

  // 1. High-APR balances worth refinancing or transferring.
  const highRate = open
    .filter((d) => d.interestRateApr >= 15)
    .sort((a, b) => b.interestRateApr - a.interestRateApr)[0];

  if (highRate) {
    const currentMonthly = monthlyInterestMinor(highRate.currentBalanceMinor, highRate.interestRateApr);
    // A realistic consolidation loan for a decent credit profile.
    const targetApr = 9;
    const refinancedMonthly = monthlyInterestMinor(highRate.currentBalanceMinor, targetApr);
    const savingMinor = currentMonthly - refinancedMonthly;

    if (savingMinor >= MIN_IMPACT_MINOR) {
      recommendations.push({
        kind: 'REFINANCE_DEBT',
        title: `Refinancing ${highRate.name} could save ${fmt(savingMinor)} a month`,
        body: `${highRate.name} carries ${highRate.interestRateApr}% APR and costs you ${fmt(currentMonthly)} in interest every month. Moving the balance to a consolidation loan near ${targetApr}% would cut that to about ${fmt(refinancedMonthly)} — worth checking what you qualify for before you commit.`,
        estimatedImpactMinor: savingMinor,
        priority: highRate.interestRateApr >= 22 ? 'HIGH' : 'MEDIUM',
        evidence: [
          { label: 'Balance', value: fmt(highRate.currentBalanceMinor) },
          { label: 'Current APR', value: `${highRate.interestRateApr}%` },
          { label: 'Monthly interest', value: fmt(currentMonthly) },
        ],
        actionUrl: `/debts`,
      });
    }
  }

  // 2. Surplus cash that would clear debt faster than it earns in savings.
  const surplus = s.monthlyIncomeMinor - s.monthlyExpensesMinor;
  const totalMinimums = open.reduce((sum, d) => sum + d.minimumPaymentMinor, 0);

  if (surplus > MIN_IMPACT_MINOR && totalMinimums > 0) {
    const extra = Math.round(surplus * 0.5);
    const withExtra = compareStrategies(open, totalMinimums + extra);
    const baseline = withExtra.minimumOnly;
    const monthsSaved = baseline.monthsToDebtFree - withExtra.avalanche.monthsToDebtFree;
    const interestSaved = baseline.totalInterestMinor - withExtra.avalanche.totalInterestMinor;

    if (monthsSaved > 0 && interestSaved >= MIN_IMPACT_MINOR) {
      recommendations.push({
        kind: 'INCREASE_DEBT_PAYMENT',
        title: `Adding ${fmt(extra)} a month clears your debt ${monthsSaved} months sooner`,
        body: `You are running a surplus of about ${fmt(surplus)} a month. Putting half of it toward ${withExtra.avalanche.payoffOrder[0]?.debtName ?? 'your highest-rate balance'} under the ${withExtra.recommended.toLowerCase()} method would save ${fmt(interestSaved)} in interest and finish ${monthsSaved} months early. ${withExtra.rationale}`,
        estimatedImpactMinor: interestSaved,
        priority: 'MEDIUM',
        evidence: [
          { label: 'Monthly surplus', value: fmt(surplus) },
          { label: 'Suggested extra payment', value: fmt(extra) },
          { label: 'Months saved', value: String(monthsSaved) },
          { label: 'Interest saved', value: fmt(interestSaved) },
        ],
        actionUrl: '/debts/payoff-plan',
      });
    }
  }

  return recommendations;
}

/**
 * Cash sitting well past a healthy emergency buffer is losing value to
 * inflation.  We only raise this once the buffer is genuinely full and there is
 * no high-interest debt outstanding — paying 22% to earn 4% is never advice.
 */
function idleCashAdvice(s: FinancialSnapshot): Recommendation[] {
  const hasExpensiveDebt = s.debts.some(
    (d) => d.currentBalanceMinor > 0 && d.interestRateApr >= 8,
  );
  if (hasExpensiveDebt) return [];

  const excess = s.liquidSavingsMinor - s.emergencyFundTargetMinor;
  if (excess < s.monthlyExpensesMinor || excess < MIN_IMPACT_MINOR * 20) return [];

  const fmt = moneyFormatter(s);
  // Indicative yield gap between a current account and an instant-access saver.
  const annualYieldMinor = Math.round(excess * 0.04);

  return [
    {
      kind: 'MOVE_CASH_TO_SAVINGS',
      title: `${fmt(excess)} is sitting idle beyond your emergency fund`,
      body: `Your emergency fund is fully funded at ${fmt(s.emergencyFundTargetMinor)}, and you are holding ${fmt(excess)} on top of that. Moving the excess into an interest-bearing account would earn roughly ${fmt(annualYieldMinor)} a year at current instant-access rates, and you keep same-day access to it.`,
      estimatedImpactMinor: Math.round(annualYieldMinor / 12),
      priority: 'LOW',
      evidence: [
        { label: 'Liquid savings', value: fmt(s.liquidSavingsMinor) },
        { label: 'Emergency fund target', value: fmt(s.emergencyFundTargetMinor) },
        { label: 'Excess', value: fmt(excess) },
      ],
      actionUrl: '/goals',
    },
  ];
}

function emergencyFundAdvice(s: FinancialSnapshot): Recommendation[] {
  if (s.emergencyFundTargetMinor <= 0) return [];
  const coverage = s.liquidSavingsMinor / s.emergencyFundTargetMinor;
  if (coverage >= 1) return [];

  const fmt = moneyFormatter(s);
  const gap = s.emergencyFundTargetMinor - s.liquidSavingsMinor;
  const surplus = Math.max(s.monthlyIncomeMinor - s.monthlyExpensesMinor, 0);
  const suggested = surplus > 0 ? Math.min(Math.round(surplus * 0.4), gap) : Math.round(gap / 12);
  const months = suggested > 0 ? Math.ceil(gap / suggested) : null;

  return [
    {
      kind: 'BUILD_EMERGENCY_FUND',
      title:
        coverage < 0.25
          ? 'Your emergency fund needs attention'
          : `You are ${Math.round(coverage * 100)}% of the way to a full emergency fund`,
      body: `A ${Math.round(s.emergencyFundTargetMinor / Math.max(s.monthlyExpensesMinor, 1))}-month buffer for you is ${fmt(s.emergencyFundTargetMinor)}; you currently hold ${fmt(s.liquidSavingsMinor)}. Setting aside ${fmt(suggested)} a month would close the ${fmt(gap)} gap${months ? ` in about ${months} months` : ''}.`,
      estimatedImpactMinor: suggested,
      priority: coverage < 0.25 ? 'HIGH' : 'MEDIUM',
      evidence: [
        { label: 'Current buffer', value: fmt(s.liquidSavingsMinor) },
        { label: 'Target', value: fmt(s.emergencyFundTargetMinor) },
        { label: 'Monthly surplus', value: fmt(surplus) },
      ],
      actionUrl: '/goals/emergency-fund',
    },
  ];
}

/**
 * Surfaces recurring charges the user may have forgotten. We do not claim they
 * are unused — we cannot know that — we simply total them and let the user
 * decide, which is the honest framing.
 */
function subscriptionAdvice(s: FinancialSnapshot): Recommendation[] {
  const confident = s.recurring.filter((r) => r.confidence >= 0.75);
  if (confident.length < 3) return [];

  const fmt = moneyFormatter(s);

  const monthlyTotal = confident.reduce((sum, r) => {
    const perMonth =
      r.frequency === 'YEARLY'
        ? r.averageAmountMinor / 12
        : r.frequency === 'QUARTERLY'
          ? r.averageAmountMinor / 3
          : r.frequency === 'WEEKLY'
            ? r.averageAmountMinor * 4.33
            : r.frequency === 'BIWEEKLY'
              ? r.averageAmountMinor * 2.17
              : r.averageAmountMinor;
    return sum + perMonth;
  }, 0);

  const rounded = Math.round(monthlyTotal);
  const sharePct =
    s.monthlyIncomeMinor > 0 ? Math.round((rounded / s.monthlyIncomeMinor) * 100) : 0;
  if (sharePct < 5) return [];

  const smallest = [...confident].sort((a, b) => a.averageAmountMinor - b.averageAmountMinor);
  const twoSmallestMinor = smallest.slice(0, 2).reduce((sum, r) => sum + r.averageAmountMinor, 0);

  return [
    {
      kind: 'CANCEL_SUBSCRIPTION',
      title: `${confident.length} recurring charges cost you ${fmt(rounded)} a month`,
      body: `That is ${sharePct}% of your monthly income going out on standing charges, including ${smallest
        .slice(-3)
        .map((r) => r.merchant)
        .join(', ')}. It is worth a look — cancelling even the two smallest would free up ${fmt(twoSmallestMinor)} a month.`,
      estimatedImpactMinor: twoSmallestMinor,
      priority: sharePct >= 15 ? 'HIGH' : 'MEDIUM',
      evidence: [
        { label: 'Recurring charges found', value: String(confident.length) },
        { label: 'Monthly total', value: fmt(rounded) },
        { label: 'Share of income', value: `${sharePct}%` },
      ],
      actionUrl: '/expenses?recurring=true',
    },
  ];
}

/** A single 0–100 score summarising financial health, with its components. */
export function financialHealthScore(s: FinancialSnapshot): {
  score: number;
  band: 'CRITICAL' | 'AT_RISK' | 'FAIR' | 'GOOD' | 'EXCELLENT';
  components: Array<{ name: string; score: number; weight: number; detail: string }>;
} {
  const rate = savingsRatePct(s.monthlyIncomeMinor, s.monthlyExpensesMinor);
  const savingsScore = clamp((rate / 20) * 100, 0, 100);

  const bufferMonths =
    s.monthlyExpensesMinor > 0 ? s.liquidSavingsMinor / s.monthlyExpensesMinor : 0;
  const bufferScore = clamp((bufferMonths / 6) * 100, 0, 100);

  const totalDebt = s.debts.reduce((sum, d) => sum + d.currentBalanceMinor, 0);
  const annualIncome = s.monthlyIncomeMinor * 12;
  const debtRatio = annualIncome > 0 ? totalDebt / annualIncome : totalDebt > 0 ? 2 : 0;
  const debtScore = clamp(100 - (debtRatio / 0.4) * 100, 0, 100);

  const shortfalls = s.forecast.filter((p) => p.isShortfall).length;
  const stabilityScore = clamp(100 - shortfalls * 25, 0, 100);

  const components = [
    { name: 'Savings rate', score: Math.round(savingsScore), weight: 0.3, detail: `${rate}% of income saved` },
    { name: 'Emergency buffer', score: Math.round(bufferScore), weight: 0.25, detail: `${bufferMonths.toFixed(1)} months of expenses covered` },
    { name: 'Debt load', score: Math.round(debtScore), weight: 0.25, detail: `Debt is ${Math.round(debtRatio * 100)}% of annual income` },
    { name: 'Cash-flow stability', score: Math.round(stabilityScore), weight: 0.2, detail: shortfalls > 0 ? `${shortfalls} shortfall month(s) projected` : 'No shortfalls projected' },
  ];

  const score = Math.round(components.reduce((sum, c) => sum + c.score * c.weight, 0));
  const band =
    score >= 85 ? 'EXCELLENT' : score >= 70 ? 'GOOD' : score >= 50 ? 'FAIR' : score >= 30 ? 'AT_RISK' : 'CRITICAL';

  return { score, band, components };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
