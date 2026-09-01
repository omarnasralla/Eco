import {
  addMonths,
  diffDays,
  endOfMonth,
  monthOf,
  type IsoDate,
  type IsoMonth,
} from './date-utils';

export interface SavingsGoalLike {
  targetAmountMinor: number;
  currentAmountMinor: number;
  deadline?: IsoDate | null;
  monthlyContributionMinor?: number | null;
}

export interface GoalProjection {
  progressPct: number;
  remainingMinor: number;
  /** Monthly contribution needed to hit the deadline; null without one. */
  requiredMonthlyMinor: number | null;
  monthsRemaining: number | null;
  /** When the current contribution rate would finish the goal. */
  projectedCompletionDate: IsoDate | null;
  projectedCompletionMonths: number | null;
  onTrack: boolean;
  /** Positive when the plan is short of the deadline requirement. */
  shortfallPerMonthMinor: number;
  isAchieved: boolean;
}

/**
 * Projects a savings goal two ways at once: what the deadline *demands* per
 * month, and what the user's *current* contribution actually delivers.  The gap
 * between those two numbers is the only thing worth showing on the card.
 */
export function projectGoal(goal: SavingsGoalLike, today: IsoDate): GoalProjection {
  const remainingMinor = Math.max(goal.targetAmountMinor - goal.currentAmountMinor, 0);
  const progressPct =
    goal.targetAmountMinor > 0
      ? Math.min(Math.round((goal.currentAmountMinor / goal.targetAmountMinor) * 1000) / 10, 100)
      : 0;
  const isAchieved = remainingMinor === 0 && goal.targetAmountMinor > 0;

  let monthsRemaining: number | null = null;
  let requiredMonthlyMinor: number | null = null;

  if (goal.deadline) {
    const days = diffDays(today, goal.deadline);
    // Round up: 40 days left is two contribution opportunities, not one.
    monthsRemaining = Math.max(Math.ceil(days / 30.44), 0);
    requiredMonthlyMinor =
      monthsRemaining > 0 ? Math.ceil(remainingMinor / monthsRemaining) : remainingMinor;
  }

  const contribution = goal.monthlyContributionMinor ?? 0;
  let projectedCompletionMonths: number | null = null;
  let projectedCompletionDate: IsoDate | null = null;

  if (isAchieved) {
    projectedCompletionMonths = 0;
    projectedCompletionDate = today;
  } else if (contribution > 0) {
    projectedCompletionMonths = Math.ceil(remainingMinor / contribution);
    projectedCompletionDate = endOfMonth(
      addMonths(monthOf(today), Math.max(projectedCompletionMonths - 1, 0)),
    );
  }

  const shortfallPerMonthMinor =
    requiredMonthlyMinor !== null ? Math.max(requiredMonthlyMinor - contribution, 0) : 0;

  const onTrack = isAchieved
    ? true
    : requiredMonthlyMinor === null
      ? contribution > 0
      : contribution >= requiredMonthlyMinor;

  return {
    progressPct,
    remainingMinor,
    requiredMonthlyMinor,
    monthsRemaining,
    projectedCompletionDate,
    projectedCompletionMonths,
    onTrack,
    shortfallPerMonthMinor,
    isAchieved,
  };
}

/**
 * Splits surplus cash across goals.
 *
 * Deadline-bound goals are funded first, in order of urgency, up to what they
 * need this month.  Whatever survives is split evenly across the open-ended
 * goals.  Nothing is over-funded past its target.
 */
export function allocateSurplus(
  surplusMinor: number,
  goals: Array<{ id: string; goal: SavingsGoalLike; priority?: number }>,
  today: IsoDate,
): Array<{ goalId: string; allocatedMinor: number; reason: string }> {
  if (surplusMinor <= 0) return [];

  const projections = goals.map((g) => ({ ...g, projection: projectGoal(g.goal, today) }));
  const open = projections.filter((g) => !g.projection.isAchieved);

  const deadlineBound = open
    .filter((g) => g.projection.requiredMonthlyMinor !== null)
    .sort((a, b) => (a.projection.monthsRemaining ?? 0) - (b.projection.monthsRemaining ?? 0));
  const openEnded = open.filter((g) => g.projection.requiredMonthlyMinor === null);

  const allocations: Array<{ goalId: string; allocatedMinor: number; reason: string }> = [];
  let pool = surplusMinor;

  for (const g of deadlineBound) {
    if (pool <= 0) break;
    const need = Math.min(g.projection.requiredMonthlyMinor ?? 0, g.projection.remainingMinor);
    const amount = Math.min(need, pool);
    if (amount <= 0) continue;
    pool -= amount;
    allocations.push({
      goalId: g.id,
      allocatedMinor: amount,
      reason: `Keeps this goal on track for its ${g.goal.deadline} deadline.`,
    });
  }

  if (pool > 0 && openEnded.length > 0) {
    const each = Math.floor(pool / openEnded.length);
    for (const g of openEnded) {
      const amount = Math.min(each, g.projection.remainingMinor);
      if (amount <= 0) continue;
      pool -= amount;
      allocations.push({
        goalId: g.id,
        allocatedMinor: amount,
        reason: 'Even share of the leftover surplus.',
      });
    }
  }

  return allocations;
}

/**
 * Recommended emergency fund: N months of essential outgoings.
 * Three months is the common floor; irregular earners are steered to six.
 */
export function emergencyFundTargetMinor(
  monthlyEssentialSpendMinor: number,
  months = 3,
): number {
  return Math.round(monthlyEssentialSpendMinor * months);
}

/** Savings rate as a percentage of income. Negative means living on credit. */
export function savingsRatePct(incomeMinor: number, expensesMinor: number): number {
  if (incomeMinor <= 0) return 0;
  return Math.round(((incomeMinor - expensesMinor) / incomeMinor) * 1000) / 10;
}

/** Milestone crossings worth a notification — 25/50/75/100% of target. */
export function crossedMilestones(
  previousMinor: number,
  currentMinor: number,
  targetMinor: number,
): number[] {
  if (targetMinor <= 0) return [];
  const before = (previousMinor / targetMinor) * 100;
  const after = (currentMinor / targetMinor) * 100;
  return [25, 50, 75, 100].filter((m) => before < m && after >= m);
}

/** Month labels a goal's contributions would span, for the progress chart. */
export function contributionMonths(
  goal: SavingsGoalLike,
  today: IsoDate,
  maxMonths = 24,
): IsoMonth[] {
  const projection = projectGoal(goal, today);
  const count = Math.min(projection.projectedCompletionMonths ?? maxMonths, maxMonths);
  return Array.from({ length: Math.max(count, 1) }, (_, i) => addMonths(monthOf(today), i));
}
