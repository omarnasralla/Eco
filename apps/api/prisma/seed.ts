/**
 * Development seed.
 *
 * Creates one realistic demo account with two years of history, because the
 * features that matter — pattern detection, seasonality, forecasting, budget
 * projections — say nothing useful about three hand-typed transactions. The
 * generated data has deliberate structure: a salary, a handful of real
 * subscriptions on fixed cadences, weekend-skewed discretionary spending, and
 * a December bump, so every analytical surface has something true to find.
 */
import { PrismaClient, type Category } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEFAULT_CATEGORIES } from '@eco/shared';

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@eco.app';
const DEMO_PASSWORD = 'demo-password-2026';

/** Deterministic PRNG so every seed run produces the same demo account. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260901);

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function isoDate(date: Date): Date {
  return new Date(date.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

/** Merchants that recur on a fixed cadence — what the detector should find. */
const SUBSCRIPTIONS = [
  { merchant: 'Netflix', slug: 'entertainment', amountMinor: 1_599, day: 4 },
  { merchant: 'Spotify', slug: 'entertainment', amountMinor: 1_099, day: 12 },
  { merchant: 'PureGym', slug: 'healthcare', amountMinor: 2_499, day: 2 },
  { merchant: 'iCloud Storage', slug: 'miscellaneous', amountMinor: 299, day: 18 },
  { merchant: 'Adobe Creative Cloud', slug: 'education', amountMinor: 5_499, day: 22 },
];

/** Bills that land every month at a stable-ish amount. */
const FIXED_BILLS = [
  { merchant: 'Greenfield Lettings', slug: 'housing', base: 145_000, spread: 0, day: 1 },
  { merchant: 'Thames Water', slug: 'utilities', base: 4_200, spread: 800, day: 8 },
  { merchant: 'Octopus Energy', slug: 'utilities', base: 9_800, spread: 4_500, day: 15 },
  { merchant: 'Vodafone', slug: 'utilities', base: 3_200, spread: 200, day: 20 },
  { merchant: 'Aviva Insurance', slug: 'insurance', base: 5_600, spread: 0, day: 25 },
];

/** Everyday variable spending, with per-category typical amounts. */
const VARIABLE_SPEND = [
  { slug: 'food', merchants: ['Tesco', 'Sainsburys', 'Pret A Manger', 'Deliveroo', 'The Ivy'], min: 650, max: 9_500, perMonth: 22 },
  { slug: 'transportation', merchants: ['TfL Travel', 'Uber', 'Shell', 'Trainline'], min: 250, max: 6_500, perMonth: 9 },
  { slug: 'shopping', merchants: ['Amazon', 'Zara', 'John Lewis', 'Uniqlo'], min: 1_200, max: 18_000, perMonth: 4 },
  { slug: 'entertainment', merchants: ['Odeon', 'Steam', 'Barbican', 'Ticketmaster'], min: 900, max: 8_500, perMonth: 3 },
  { slug: 'healthcare', merchants: ['Boots Pharmacy', 'Bupa Dental'], min: 800, max: 12_000, perMonth: 1 },
  { slug: 'travel', merchants: ['British Airways', 'Booking.com', 'Airbnb'], min: 8_000, max: 95_000, perMonth: 0 },
  { slug: 'miscellaneous', merchants: ['Post Office', 'Ryman', 'Timpson'], min: 400, max: 4_000, perMonth: 2 },
];

async function main(): Promise<void> {
  console.log('Seeding Eco demo data…');

  await prisma.user.deleteMany({ where: { email: DEMO_EMAIL } });

  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      passwordHash: await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id }),
      name: 'Demo User',
      country: 'GB',
      currency: 'GBP',
      timezone: 'Europe/London',
      locale: 'en-GB',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      onboardingCompleted: true,
      lastLoginAt: new Date(),
      financialGoals: {
        primaryObjective: 'PAY_OFF_DEBT',
        targetSavingsRatePct: 20,
        emergencyFundMonths: 6,
      },
    },
  });

  const essentials = new Set(['housing', 'utilities', 'healthcare', 'insurance', 'transportation']);
  await prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((c, index) => ({
      userId: user.id,
      name: c.name,
      slug: c.slug,
      icon: c.icon,
      color: c.color,
      isSystem: true,
      isEssential: essentials.has(c.slug),
      sortOrder: index,
    })),
  });
  await prisma.notificationPreference.create({ data: { userId: user.id } });

  const categories = await prisma.category.findMany({ where: { userId: user.id } });
  const bySlug = new Map<string, Category>(categories.map((c) => [c.slug ?? c.name, c]));
  const categoryFor = (slug: string): Category => {
    const category = bySlug.get(slug);
    if (!category) throw new Error(`Seed expected a "${slug}" category`);
    return category;
  };

  // ── Income ────────────────────────────────────────────────────────────
  const salaryStart = new Date();
  salaryStart.setUTCFullYear(salaryStart.getUTCFullYear() - 3);

  await prisma.incomeSource.createMany({
    data: [
      {
        userId: user.id,
        name: 'Northwind Software — Salary',
        type: 'SALARY',
        // Sized so total income (~£5,990/mo) covers average spending
        // (~£4,860/mo) and still funds the goal contributions below. A demo
        // that runs a deficit while claiming to save £1,100 a month is not a
        // demo, it is a bug report.
        amountMinor: BigInt(520_000),
        currency: 'GBP',
        frequency: 'MONTHLY',
        startDate: isoDate(salaryStart),
        isActive: true,
        notes: 'Net monthly pay after tax and pension.',
      },
      {
        userId: user.id,
        name: 'Freelance design work',
        type: 'FREELANCE',
        amountMinor: BigInt(65_000),
        currency: 'GBP',
        frequency: 'MONTHLY',
        startDate: isoDate(new Date(Date.now() - 400 * 86_400_000)),
        isActive: true,
        notes: 'Irregular, but averages out around this.',
      },
      {
        userId: user.id,
        name: 'Dividend income',
        type: 'INVESTMENT',
        amountMinor: BigInt(42_000),
        currency: 'GBP',
        frequency: 'QUARTERLY',
        startDate: isoDate(new Date(Date.now() - 700 * 86_400_000)),
        isActive: true,
      },
    ],
  });

  // ── Expenses: 24 months of history ────────────────────────────────────
  const expenses: Array<{
    userId: string;
    categoryId: string;
    amountMinor: bigint;
    currency: string;
    baseAmountMinor: bigint;
    date: Date;
    merchant: string;
    isRecurring: boolean;
    recurringFrequency: 'MONTHLY' | null;
    tags: string[];
  }> = [];

  const today = new Date();
  const MONTHS = 24;

  for (let monthsAgo = MONTHS - 1; monthsAgo >= 0; monthsAgo -= 1) {
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const isCurrentMonth = monthsAgo === 0;
    // Only seed up to today in the current month, so "spent so far" is real.
    const lastDay = isCurrentMonth ? today.getUTCDate() : daysInMonth;

    // December costs more, August a little more (holidays) — gives the
    // seasonality index something genuine to detect.
    const seasonalMultiplier = month === 11 ? 1.45 : month === 7 ? 1.2 : 1;

    for (const sub of SUBSCRIPTIONS) {
      if (sub.day > lastDay) continue;
      const category = categoryFor(sub.slug);
      expenses.push({
        userId: user.id,
        categoryId: category.id,
        amountMinor: BigInt(sub.amountMinor),
        currency: 'GBP',
        baseAmountMinor: BigInt(sub.amountMinor),
        date: new Date(Date.UTC(year, month, sub.day)),
        merchant: sub.merchant,
        isRecurring: true,
        recurringFrequency: 'MONTHLY',
        tags: ['subscription'],
      });
    }

    for (const bill of FIXED_BILLS) {
      if (bill.day > lastDay) continue;
      const category = categoryFor(bill.slug);
      // Energy is seasonal: colder months cost more.
      const winterFactor =
        bill.slug === 'utilities' && (month <= 2 || month >= 10) ? 1.6 : 1;
      const amount = Math.round(
        (bill.base + randomInt(0, bill.spread)) * winterFactor,
      );
      expenses.push({
        userId: user.id,
        categoryId: category.id,
        amountMinor: BigInt(amount),
        currency: 'GBP',
        baseAmountMinor: BigInt(amount),
        date: new Date(Date.UTC(year, month, bill.day)),
        merchant: bill.merchant,
        isRecurring: true,
        recurringFrequency: 'MONTHLY',
        tags: ['bill'],
      });
    }

    for (const group of VARIABLE_SPEND) {
      const category = categoryFor(group.slug);
      let count = Math.round(group.perMonth * seasonalMultiplier);
      // Two holidays a year rather than a trickle of travel every month.
      if (group.slug === 'travel') count = month === 7 || month === 11 ? 2 : 0;
      if (isCurrentMonth) count = Math.round(count * (lastDay / daysInMonth));

      for (let i = 0; i < count; i += 1) {
        const day = randomInt(1, lastDay);
        const date = new Date(Date.UTC(year, month, day));
        // Weekend discretionary spending runs higher — the weekday
        // distribution chart should show it.
        const weekendFactor = [0, 6].includes(date.getUTCDay()) ? 1.5 : 1;
        const amount = Math.round(
          randomInt(group.min, group.max) * seasonalMultiplier * weekendFactor,
        );
        expenses.push({
          userId: user.id,
          categoryId: category.id,
          amountMinor: BigInt(amount),
          currency: 'GBP',
          baseAmountMinor: BigInt(amount),
          date,
          merchant: pick(group.merchants),
          isRecurring: false,
          recurringFrequency: null,
          tags: [],
        });
      }
    }
  }

  // Chunked: a single 4,000-row insert exceeds the parameter limit.
  for (let i = 0; i < expenses.length; i += 500) {
    await prisma.expense.createMany({ data: expenses.slice(i, i + 500) });
  }

  // ── Debts ─────────────────────────────────────────────────────────────
  const debts = await Promise.all([
    prisma.debt.create({
      data: {
        userId: user.id,
        name: 'Barclaycard Rewards',
        type: 'CREDIT_CARD',
        lender: 'Barclays',
        principalMinor: BigInt(620_000),
        currentBalanceMinor: BigInt(438_500),
        interestRateApr: 22.9,
        minimumPaymentMinor: BigInt(11_000),
        currency: 'GBP',
        dueDayOfMonth: 14,
        openedDate: isoDate(new Date(Date.now() - 900 * 86_400_000)),
      },
    }),
    prisma.debt.create({
      data: {
        userId: user.id,
        name: 'Volkswagen Golf finance',
        type: 'CAR_LOAN',
        lender: 'VW Financial Services',
        principalMinor: BigInt(1_850_000),
        currentBalanceMinor: BigInt(1_124_000),
        interestRateApr: 6.4,
        minimumPaymentMinor: BigInt(31_500),
        currency: 'GBP',
        dueDayOfMonth: 5,
        openedDate: isoDate(new Date(Date.now() - 730 * 86_400_000)),
      },
    }),
    prisma.debt.create({
      data: {
        userId: user.id,
        name: 'Student Finance England',
        type: 'STUDENT_LOAN',
        lender: 'SLC',
        principalMinor: BigInt(2_400_000),
        currentBalanceMinor: BigInt(1_876_000),
        interestRateApr: 4.3,
        minimumPaymentMinor: BigInt(18_000),
        currency: 'GBP',
        dueDayOfMonth: 28,
      },
    }),
  ]);

  // A year of payment history so the net-worth chart has a real trajectory.
  for (const debt of debts) {
    let balance = Number(debt.currentBalanceMinor) + Number(debt.minimumPaymentMinor) * 12;
    for (let monthsAgo = 12; monthsAgo >= 1; monthsAgo -= 1) {
      const date = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, debt.dueDayOfMonth),
      );
      const interest = Math.round((balance * Number(debt.interestRateApr)) / 100 / 12);
      const payment = Number(debt.minimumPaymentMinor);
      const principal = Math.max(payment - interest, 0);
      balance = Math.max(balance + interest - payment, 0);

      await prisma.debtPayment.create({
        data: {
          userId: user.id,
          debtId: debt.id,
          amountMinor: BigInt(payment),
          principalMinor: BigInt(principal),
          interestMinor: BigInt(interest),
          currency: 'GBP',
          date,
          balanceAfterMinor: BigInt(Math.round(balance)),
        },
      });
    }
  }

  // ── Savings goals ─────────────────────────────────────────────────────
  const goals = await Promise.all([
    prisma.savingsGoal.create({
      data: {
        userId: user.id,
        name: 'Emergency fund',
        type: 'EMERGENCY_FUND',
        targetAmountMinor: BigInt(1_200_000),
        currentAmountMinor: BigInt(742_000),
        currency: 'GBP',
        monthlyContributionMinor: BigInt(30_000),
        color: '#0d9aa8',
        icon: 'shield',
        lastMilestoneNotified: 50,
      },
    }),
    prisma.savingsGoal.create({
      data: {
        userId: user.id,
        name: 'Japan trip',
        type: 'VACATION',
        targetAmountMinor: BigInt(450_000),
        currentAmountMinor: BigInt(128_000),
        currency: 'GBP',
        deadline: isoDate(new Date(Date.now() + 300 * 86_400_000)),
        monthlyContributionMinor: BigInt(20_000),
        color: '#d36891',
        icon: 'plane',
        lastMilestoneNotified: 25,
      },
    }),
    prisma.savingsGoal.create({
      data: {
        userId: user.id,
        name: 'House deposit',
        type: 'HOME_DOWN_PAYMENT',
        targetAmountMinor: BigInt(4_000_000),
        currentAmountMinor: BigInt(615_000),
        currency: 'GBP',
        deadline: isoDate(new Date(Date.now() + 1_100 * 86_400_000)),
        monthlyContributionMinor: BigInt(60_000),
        color: '#0fab76',
        icon: 'home',
      },
    }),
  ]);

  for (const goal of goals) {
    const monthly = Number(goal.monthlyContributionMinor ?? BigInt(0));
    if (monthly === 0) continue;
    const months = Math.min(Math.ceil(Number(goal.currentAmountMinor) / monthly), 18);
    for (let monthsAgo = months; monthsAgo >= 1; monthsAgo -= 1) {
      await prisma.goalContribution.create({
        data: {
          userId: user.id,
          goalId: goal.id,
          amountMinor: BigInt(monthly),
          // The demo pays into each goal in that goal's own currency, so the
          // entered and converted amounts are the same figure.
          currency: goal.currency,
          goalAmountMinor: BigInt(monthly),
          date: new Date(
            Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 26),
          ),
        },
      });
    }
  }

  // ── Budget for the current month ──────────────────────────────────────
  const budgetMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const budget = await prisma.budget.create({
    data: {
      userId: user.id,
      month: budgetMonth,
      type: 'ROLLING',
      currency: 'GBP',
      alertThresholdPct: 80,
      notes: 'Trying to keep discretionary spending under control this month.',
    },
  });

  const budgetLimits: Array<[string, number, boolean]> = [
    ['housing', 145_000, false],
    ['food', 55_000, false],
    ['transportation', 22_000, false],
    ['utilities', 20_000, false],
    ['entertainment', 12_000, true],
    ['shopping', 25_000, true],
    ['healthcare', 8_000, false],
    ['insurance', 6_000, false],
    ['miscellaneous', 8_000, true],
  ];

  await prisma.budgetLine.createMany({
    data: budgetLimits.map(([slug, limit, rollover]) => ({
      budgetId: budget.id,
      categoryId: categoryFor(slug).id,
      limitMinor: BigInt(limit),
      rollover,
    })),
  });

  // ── Exchange rates ────────────────────────────────────────────────────
  const rateDate = isoDate(today);
  const rates: Record<string, number> = {
    EUR: 0.92, GBP: 0.79, AED: 3.67, SAR: 3.75, EGP: 48.5,
    JOD: 0.709, KWD: 0.307, CAD: 1.36, AUD: 1.52, CHF: 0.88,
    JPY: 151.2, INR: 83.4, TRY: 34.1, NGN: 1_580, ZAR: 18.2, USD: 1,
  };
  await prisma.exchangeRate.createMany({
    data: Object.entries(rates).map(([quote, rate]) => ({
      base: 'USD',
      quote,
      rate,
      date: rateDate,
      provider: 'seed',
    })),
    skipDuplicates: true,
  });

  const expenseCount = await prisma.expense.count({ where: { userId: user.id } });
  console.log(`
Seed complete.

  Email:    ${DEMO_EMAIL}
  Password: ${DEMO_PASSWORD}

  ${expenseCount} expenses across ${MONTHS} months
  ${debts.length} debts with 12 months of payment history
  ${goals.length} savings goals
  1 rolling budget for the current month
`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
