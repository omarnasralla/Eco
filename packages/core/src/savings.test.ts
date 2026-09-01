import { describe, expect, it } from 'vitest';
import {
  allocateSurplus,
  crossedMilestones,
  emergencyFundTargetMinor,
  projectGoal,
  savingsRatePct,
} from './savings';

describe('projectGoal', () => {
  it('reports progress and what the deadline demands each month', () => {
    const projection = projectGoal(
      {
        targetAmountMinor: 1_200_000,
        currentAmountMinor: 300_000,
        deadline: '2027-01-01',
        monthlyContributionMinor: 100_000,
      },
      '2026-01-01',
    );

    expect(projection.progressPct).toBe(25);
    expect(projection.remainingMinor).toBe(900_000);
    expect(projection.monthsRemaining).toBe(12);
    expect(projection.requiredMonthlyMinor).toBe(75_000);
    expect(projection.onTrack).toBe(true);
    expect(projection.shortfallPerMonthMinor).toBe(0);
  });

  it('surfaces the monthly gap when the plan falls short', () => {
    const projection = projectGoal(
      {
        targetAmountMinor: 1_200_000,
        currentAmountMinor: 0,
        deadline: '2026-07-01',
        monthlyContributionMinor: 100_000,
      },
      '2026-01-01',
    );

    expect(projection.onTrack).toBe(false);
    expect(projection.requiredMonthlyMinor).toBe(200_000);
    expect(projection.shortfallPerMonthMinor).toBe(100_000);
  });

  it('projects a completion date for open-ended goals', () => {
    const projection = projectGoal(
      { targetAmountMinor: 500_000, currentAmountMinor: 100_000, monthlyContributionMinor: 100_000 },
      '2026-01-15',
    );
    expect(projection.requiredMonthlyMinor).toBeNull();
    expect(projection.projectedCompletionMonths).toBe(4);
    expect(projection.projectedCompletionDate).toBe('2026-04-30');
    expect(projection.onTrack).toBe(true);
  });

  it('marks a funded goal as achieved', () => {
    const projection = projectGoal(
      { targetAmountMinor: 500_000, currentAmountMinor: 500_000, deadline: '2026-12-01' },
      '2026-01-01',
    );
    expect(projection.isAchieved).toBe(true);
    expect(projection.progressPct).toBe(100);
    expect(projection.onTrack).toBe(true);
    expect(projection.remainingMinor).toBe(0);
  });

  it('treats a goal with no contribution as off track', () => {
    const projection = projectGoal({ targetAmountMinor: 500_000, currentAmountMinor: 0 }, '2026-01-01');
    expect(projection.onTrack).toBe(false);
    expect(projection.projectedCompletionDate).toBeNull();
  });

  it('caps progress at 100% when a goal is overfunded', () => {
    const projection = projectGoal(
      { targetAmountMinor: 100_000, currentAmountMinor: 150_000 },
      '2026-01-01',
    );
    expect(projection.progressPct).toBe(100);
    expect(projection.remainingMinor).toBe(0);
  });
});

describe('allocateSurplus', () => {
  it('funds the most urgent deadline first', () => {
    const allocations = allocateSurplus(
      150_000,
      [
        {
          id: 'far',
          goal: { targetAmountMinor: 1_000_000, currentAmountMinor: 0, deadline: '2027-06-01' },
        },
        {
          id: 'soon',
          goal: { targetAmountMinor: 300_000, currentAmountMinor: 0, deadline: '2026-04-01' },
        },
      ],
      '2026-01-01',
    );

    expect(allocations[0]!.goalId).toBe('soon');
    expect(allocations.reduce((s, a) => s + a.allocatedMinor, 0)).toBeLessThanOrEqual(150_000);
  });

  it('splits what is left evenly across open-ended goals', () => {
    const allocations = allocateSurplus(
      100_000,
      [
        { id: 'a', goal: { targetAmountMinor: 1_000_000, currentAmountMinor: 0 } },
        { id: 'b', goal: { targetAmountMinor: 1_000_000, currentAmountMinor: 0 } },
      ],
      '2026-01-01',
    );
    expect(allocations).toHaveLength(2);
    expect(allocations[0]!.allocatedMinor).toBe(50_000);
    expect(allocations[1]!.allocatedMinor).toBe(50_000);
  });

  it('never over-funds a nearly complete goal', () => {
    const allocations = allocateSurplus(
      100_000,
      [{ id: 'almost', goal: { targetAmountMinor: 100_000, currentAmountMinor: 95_000 } }],
      '2026-01-01',
    );
    expect(allocations[0]!.allocatedMinor).toBe(5_000);
  });

  it('allocates nothing from a zero or negative surplus', () => {
    expect(allocateSurplus(0, [{ id: 'a', goal: { targetAmountMinor: 1, currentAmountMinor: 0 } }], '2026-01-01')).toEqual([]);
    expect(allocateSurplus(-5_000, [], '2026-01-01')).toEqual([]);
  });
});

describe('savingsRatePct and emergencyFundTargetMinor', () => {
  it('computes a savings rate and goes negative when overspending', () => {
    expect(savingsRatePct(500_000, 400_000)).toBe(20);
    expect(savingsRatePct(500_000, 600_000)).toBe(-20);
    expect(savingsRatePct(0, 100_000)).toBe(0);
  });

  it('sizes the emergency fund from essential spend', () => {
    expect(emergencyFundTargetMinor(300_000)).toBe(900_000);
    expect(emergencyFundTargetMinor(300_000, 6)).toBe(1_800_000);
  });
});

describe('crossedMilestones', () => {
  it('reports only newly crossed thresholds', () => {
    expect(crossedMilestones(200_000, 300_000, 1_000_000)).toEqual([25]);
    expect(crossedMilestones(200_000, 800_000, 1_000_000)).toEqual([25, 50, 75]);
    expect(crossedMilestones(900_000, 1_000_000, 1_000_000)).toEqual([100]);
    expect(crossedMilestones(300_000, 400_000, 1_000_000)).toEqual([]);
  });
});
