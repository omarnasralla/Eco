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

/**
 * These eleven hues plus a neutral were selected by search, not by eye, and
 * every one is verified by the data-viz palette validator.
 *
 * Two properties had to hold simultaneously:
 *
 *  - **Distinguishable under colour-vision deficiency.** Worst adjacent pair
 *    scores ΔE 13.2 under deuteranopia (target ≥ 8) and 16.7 under normal
 *    vision (hard floor 15). The previous hand-picked set failed badly: its
 *    "Investments" (#10b981) and "Travel" (#22c55e) greens scored ΔE 6.3 to
 *    *full-colour* vision — effectively the same colour on a chart.
 *
 *  - **Legible on both surfaces from one stored value.** Each sits inside the
 *    OKLCH lightness band the light and dark themes share (0.48–0.67), so the
 *    single hex a user picks works on white and on near-black without the app
 *    keeping two values or the user choosing twice.
 *
 * Order matters: the CVD checks run on *adjacent* pairs, and these categories
 * render in this order in pickers and legends. Re-ordering them silently
 * weakens the guarantee — re-run the validator if you do.
 *
 * Miscellaneous is deliberately neutral. It is the "everything else" bucket,
 * and gray is the honest reading; it is exempt from the chroma floor for that
 * reason, and it is never the only cue because chips carry a name and icon.
 */
export const DEFAULT_CATEGORIES: readonly SeedCategory[] = [
  { slug: 'housing', name: 'Housing', icon: 'home', color: '#0fab76' },
  { slug: 'transportation', name: 'Transportation', icon: 'car', color: '#5a4dbb' },
  { slug: 'food', name: 'Food', icon: 'utensils', color: '#e5632e' },
  { slug: 'utilities', name: 'Utilities', icon: 'zap', color: '#2a78d6' },
  { slug: 'healthcare', name: 'Healthcare', icon: 'heart-pulse', color: '#e34948' },
  { slug: 'insurance', name: 'Insurance', icon: 'shield', color: '#0d9aa8' },
  { slug: 'entertainment', name: 'Entertainment', icon: 'clapperboard', color: '#6f8f00' },
  { slug: 'education', name: 'Education', icon: 'graduation-cap', color: '#b14fc5' },
  { slug: 'shopping', name: 'Shopping', icon: 'shopping-bag', color: '#c87f00' },
  { slug: 'travel', name: 'Travel', icon: 'plane', color: '#d36891' },
  { slug: 'investments', name: 'Investments', icon: 'trending-up', color: '#008300' },
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

/**
 * Series colours for charts not keyed to a user-chosen category — the
 * income/expense trend, forecast bands, payoff projections.
 *
 * The validated categorical slots, in their documented order. Assigned by
 * position and never cycled: a chart needing a ninth series folds its tail
 * into "Other" rather than reusing a hue, because a repeated colour asserts
 * that two different things are the same thing.
 */
export const CHART_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
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
