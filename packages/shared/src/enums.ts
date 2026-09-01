/**
 * Domain enums.  These are the single source of truth: the Prisma schema,
 * the API DTOs and the React/React Native UI all derive from this file, so a
 * new income type or debt kind is added in exactly one place.
 */

export const INCOME_TYPES = [
  'SALARY',
  'FREELANCE',
  'BUSINESS',
  'INVESTMENT',
  'RENTAL',
  'SIDE_HUSTLE',
  'OTHER',
] as const;
export type IncomeType = (typeof INCOME_TYPES)[number];

export const FREQUENCIES = [
  'ONE_TIME',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'YEARLY',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** How many times a frequency occurs per year. Drives every annualisation. */
export const OCCURRENCES_PER_YEAR: Record<Frequency, number> = {
  ONE_TIME: 0,
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  YEARLY: 1,
};

export const DEBT_TYPES = [
  'CREDIT_CARD',
  'PERSONAL_LOAN',
  'CAR_LOAN',
  'MORTGAGE',
  'STUDENT_LOAN',
  'MEDICAL',
  'CUSTOM',
] as const;
export type DebtType = (typeof DEBT_TYPES)[number];

export const PAYOFF_STRATEGIES = ['SNOWBALL', 'AVALANCHE', 'CUSTOM'] as const;
export type PayoffStrategy = (typeof PAYOFF_STRATEGIES)[number];

export const GOAL_TYPES = [
  'EMERGENCY_FUND',
  'VACATION',
  'CAR_PURCHASE',
  'HOME_DOWN_PAYMENT',
  'RETIREMENT',
  'EDUCATION',
  'CUSTOM',
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_STATUSES = ['ACTIVE', 'ACHIEVED', 'PAUSED', 'ABANDONED'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const BUDGET_TYPES = ['FIXED', 'VARIABLE', 'ROLLING'] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'BILL_DUE',
  'BUDGET_EXCEEDED',
  'BUDGET_WARNING',
  'DEBT_DUE',
  'SAVINGS_MILESTONE',
  'GOAL_ACHIEVED',
  'AI_INSIGHT',
  'SECURITY_ALERT',
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const USER_ROLES = ['USER', 'PREMIUM', 'SUPPORT', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const RECOMMENDATION_KINDS = [
  'REDUCE_CATEGORY_SPEND',
  'MOVE_CASH_TO_SAVINGS',
  'REFINANCE_DEBT',
  'ADJUST_BUDGET',
  'BUILD_EMERGENCY_FUND',
  'CANCEL_SUBSCRIPTION',
  'INCREASE_DEBT_PAYMENT',
  'CASHFLOW_WARNING',
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export const RECOMMENDATION_STATUSES = ['NEW', 'SEEN', 'ACCEPTED', 'DISMISSED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const REPORT_PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const EXPORT_FORMATS = ['PDF', 'XLSX', 'CSV'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_RESET',
  'TWO_FA_ENABLED',
  'TWO_FA_DISABLED',
  'EXPORT',
  'AI_QUERY',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
