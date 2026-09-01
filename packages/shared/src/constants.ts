import type { DebtType, GoalType, IncomeType } from './enums';

/**
 * The twelve default expense categories every new account is seeded with.
 * Users may archive them, rename them, or add their own; `slug` is stable so
 * the AI layer can reason about "Food" even after a rename.
 */
export interface SeedCategory {
  slug: string;
  name: string;
  icon: string;
  color: string;
}

export const DEFAULT_CATEGORIES: readonly SeedCategory[] = [
  { slug: 'housing', name: 'Housing', icon: 'home', color: '#0ea5e9' },
  { slug: 'transportation', name: 'Transportation', icon: 'car', color: '#6366f1' },
  { slug: 'food', name: 'Food', icon: 'utensils', color: '#f97316' },
  { slug: 'utilities', name: 'Utilities', icon: 'zap', color: '#eab308' },
  { slug: 'healthcare', name: 'Healthcare', icon: 'heart-pulse', color: '#ef4444' },
  { slug: 'insurance', name: 'Insurance', icon: 'shield', color: '#14b8a6' },
  { slug: 'entertainment', name: 'Entertainment', icon: 'clapperboard', color: '#ec4899' },
  { slug: 'education', name: 'Education', icon: 'graduation-cap', color: '#8b5cf6' },
  { slug: 'shopping', name: 'Shopping', icon: 'shopping-bag', color: '#f43f5e' },
  { slug: 'travel', name: 'Travel', icon: 'plane', color: '#22c55e' },
  { slug: 'investments', name: 'Investments', icon: 'trending-up', color: '#10b981' },
  { slug: 'miscellaneous', name: 'Miscellaneous', icon: 'circle-ellipsis', color: '#64748b' },
] as const;

export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  SALARY: 'Salary',
  FREELANCE: 'Freelancing',
  BUSINESS: 'Business income',
  INVESTMENT: 'Investments',
  RENTAL: 'Rental income',
  SIDE_HUSTLE: 'Side hustle',
  OTHER: 'Other',
};

export const DEBT_TYPE_LABELS: Record<DebtType, string> = {
  CREDIT_CARD: 'Credit card',
  PERSONAL_LOAN: 'Personal loan',
  CAR_LOAN: 'Car loan',
  MORTGAGE: 'Mortgage',
  STUDENT_LOAN: 'Student loan',
  MEDICAL: 'Medical debt',
  CUSTOM: 'Other debt',
};

export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  EMERGENCY_FUND: 'Emergency fund',
  VACATION: 'Vacation',
  CAR_PURCHASE: 'Car purchase',
  HOME_DOWN_PAYMENT: 'Home down payment',
  RETIREMENT: 'Retirement',
  EDUCATION: 'Education',
  CUSTOM: 'Custom goal',
};

/** Chart palette — colour-blind safe, legible on both light and dark grounds. */
export const CHART_COLORS = [
  '#0ea5e9',
  '#22c55e',
  '#f97316',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#eab308',
  '#6366f1',
  '#ef4444',
  '#64748b',
] as const;

/** Rate-limit budgets, kept here so the client can back off before it is told to. */
export const RATE_LIMITS = {
  auth: { windowSeconds: 60, max: 10 },
  api: { windowSeconds: 60, max: 120 },
  ai: { windowSeconds: 60, max: 20 },
  export: { windowSeconds: 3600, max: 20 },
} as const;

export const CACHE_TTL_SECONDS = {
  dashboard: 120,
  categoryBreakdown: 300,
  exchangeRates: 3600,
  forecast: 21600,
  patterns: 21600,
  userProfile: 600,
} as const;
