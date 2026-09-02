/**
 * Zod contracts.  The API validates inbound payloads with these, the web app
 * validates forms with the *same* objects via react-hook-form, and React
 * Native will do the same.  One definition, three consumers, no drift.
 */
import { z } from 'zod';
import {
  BUDGET_TYPES,
  DEBT_TYPES,
  EXPORT_FORMATS,
  FREQUENCIES,
  GOAL_TYPES,
  INCOME_TYPES,
  NOTIFICATION_CHANNELS,
  PAYOFF_STRATEGIES,
  REPORT_PERIODS,
} from './enums';

/** Amounts arrive as integer minor units — see money.ts for the rationale. */
export const minorAmount = z
  .number()
  .int('Amount must be an integer number of minor units')
  .nonnegative('Amount cannot be negative')
  .max(Number.MAX_SAFE_INTEGER);

export const signedMinorAmount = z.number().int().safe();

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Currency must be a 3-letter ISO 4217 code');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');

export const isoMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month in YYYY-MM form');

export const uuid = z.string().uuid();

export const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex colour like #16a34a');

/* ── Auth ─────────────────────────────────────────────────── */

/**
 * NIST SP 800-63B: length beats composition rules. We require 12+ characters
 * and screen against a breach list server-side rather than demanding symbols.
 */
export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Password is too long');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password,
  name: z.string().trim().min(1).max(120),
  country: z.string().trim().length(2).optional(),
  currency: currencyCode.default('USD'),
  timezone: z.string().trim().max(64).default('UTC'),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms to continue' }),
  }),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
  /** Present only when the account has TOTP enabled. */
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(16),
    password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const verifyEmailSchema = z.object({ token: z.string().min(16) });
export const refreshSchema = z.object({ refreshToken: z.string().min(16) });
export const enable2faSchema = z.object({ totpCode: z.string().regex(/^\d{6}$/) });

/* ── Profile ──────────────────────────────────────────────── */

export const financialGoalPrefsSchema = z.object({
  monthlySavingsTargetMinor: minorAmount.optional(),
  targetSavingsRatePct: z.number().min(0).max(100).optional(),
  emergencyFundMonths: z.number().min(0).max(36).optional(),
  debtFreeBy: isoDate.optional(),
  primaryObjective: z
    .enum(['PAY_OFF_DEBT', 'BUILD_SAVINGS', 'CONTROL_SPENDING', 'GROW_WEALTH'])
    .optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().length(2).optional(),
  currency: currencyCode.optional(),
  timezone: z.string().trim().max(64).optional(),
  locale: z.string().trim().max(16).optional(),
  financialGoals: financialGoalPrefsSchema.optional(),
});

/* ── Income ───────────────────────────────────────────────── */

export const incomeSourceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(INCOME_TYPES),
    amountMinor: minorAmount,
    currency: currencyCode,
    frequency: z.enum(FREQUENCIES),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'End date must fall on or after the start date',
    path: ['endDate'],
  });

export const updateIncomeSourceSchema = incomeSourceSchema.innerType().partial();

/* ── Categories & expenses ────────────────────────────────── */

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().max(40).default('circle'),
  color: hexColor.default('#64748b'),
  parentId: uuid.nullish(),
  monthlyBudgetMinor: minorAmount.nullish(),
});

export const updateCategorySchema = categorySchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export const expenseSchema = z.object({
  amountMinor: minorAmount,
  currency: currencyCode,
  categoryId: uuid,
  date: isoDate,
  merchant: z.string().trim().max(160).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  isRecurring: z.boolean().default(false),
  recurringFrequency: z.enum(FREQUENCIES).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const updateExpenseSchema = expenseSchema.partial();

export const expenseQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: uuid.optional(),
  merchant: z.string().trim().max(160).optional(),
  minAmountMinor: z.coerce.number().int().nonnegative().optional(),
  maxAmountMinor: z.coerce.number().int().nonnegative().optional(),
  search: z.string().trim().max(160).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['date', 'amount', 'merchant']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/* ── Debts ────────────────────────────────────────────────── */

export const debtSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(DEBT_TYPES),
  lender: z.string().trim().max(160).nullish(),
  principalMinor: minorAmount,
  currentBalanceMinor: minorAmount,
  /** Nominal APR as a percentage, e.g. 21.99. */
  interestRateApr: z.number().min(0).max(200),
  minimumPaymentMinor: minorAmount,
  currency: currencyCode,
  /** Day of month the payment is due, 1–31. */
  dueDayOfMonth: z.number().int().min(1).max(31),
  openedDate: isoDate.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export const updateDebtSchema = debtSchema.partial().extend({
  isClosed: z.boolean().optional(),
});

export const debtPaymentSchema = z.object({
  amountMinor: minorAmount.refine((v) => v > 0, 'Payment must be greater than zero'),
  date: isoDate,
  /** Optional split; when omitted the server derives it from the APR. */
  principalMinor: minorAmount.optional(),
  interestMinor: minorAmount.optional(),
  notes: z.string().trim().max(500).nullish(),
});

export const payoffPlanSchema = z.object({
  strategy: z.enum(PAYOFF_STRATEGIES).default('AVALANCHE'),
  /** Amount available each month across all debts, in minor units. */
  monthlyBudgetMinor: minorAmount,
  /** Optional lump sum applied in month 1. */
  extraOneOffMinor: minorAmount.default(0),
  /** Only used when strategy is CUSTOM. */
  debtOrder: z.array(uuid).optional(),
});

/* ── Savings goals ────────────────────────────────────────── */

export const savingsGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(GOAL_TYPES),
    targetAmountMinor: minorAmount.refine((v) => v > 0, 'Set a target above zero'),
    currentAmountMinor: minorAmount.default(0),
    currency: currencyCode,
    deadline: isoDate.nullish(),
    monthlyContributionMinor: minorAmount.nullish(),
    color: hexColor.default('#0ea5e9'),
    icon: z.string().trim().max(40).default('piggy-bank'),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine((v) => v.currentAmountMinor <= v.targetAmountMinor * 10, {
    message: 'Current amount looks implausible against the target',
    path: ['currentAmountMinor'],
  });

export const updateSavingsGoalSchema = savingsGoalSchema.innerType().partial();

export const goalContributionSchema = z.object({
  amountMinor: signedMinorAmount.refine((v) => v !== 0, 'Contribution cannot be zero'),
  /**
   * The currency the amount was entered in. Optional, and absent means "the
   * goal's own currency" — which is what every caller written before
   * multi-currency contributions meant, so their requests keep working
   * unchanged. Anything else is converted at the contribution date's rate.
   */
  currency: currencyCode.optional(),
  date: isoDate,
  notes: z.string().trim().max(500).nullish(),
});

/* ── Budgets ──────────────────────────────────────────────── */

export const budgetLineSchema = z.object({
  categoryId: uuid,
  limitMinor: minorAmount,
  /** Carry unspent room into next month (ROLLING budgets). */
  rollover: z.boolean().default(false),
});

export const budgetSchema = z.object({
  month: isoMonth,
  type: z.enum(BUDGET_TYPES).default('FIXED'),
  currency: currencyCode,
  totalLimitMinor: minorAmount.nullish(),
  /** Fire an alert once spend crosses this share of the limit. */
  alertThresholdPct: z.number().int().min(1).max(200).default(80),
  lines: z.array(budgetLineSchema).max(200).default([]),
  notes: z.string().trim().max(2000).nullish(),
});

export const updateBudgetSchema = budgetSchema.partial();

/* ── Notifications ────────────────────────────────────────── */

export const notificationPreferencesSchema = z.object({
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(0).default(['IN_APP', 'EMAIL']),
  billDueLeadDays: z.number().int().min(0).max(30).default(3),
  budgetWarnings: z.boolean().default(true),
  debtReminders: z.boolean().default(true),
  savingsMilestones: z.boolean().default(true),
  aiInsights: z.boolean().default(true),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
});

export const registerPushTokenSchema = z.object({
  token: z.string().min(8).max(512),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceName: z.string().trim().max(120).optional(),
});

/* ── Reports ──────────────────────────────────────────────── */

export const reportRequestSchema = z
  .object({
    period: z.enum(REPORT_PERIODS),
    from: isoDate.optional(),
    to: isoDate.optional(),
    format: z.enum(EXPORT_FORMATS).default('PDF'),
    includeCharts: z.boolean().default(true),
  })
  .refine((v) => v.period !== 'CUSTOM' || (v.from && v.to), {
    message: 'Custom reports need both a start and an end date',
    path: ['from'],
  });

/* ── AI ───────────────────────────────────────────────────── */

export const aiChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: uuid.optional(),
});

export const forecastRequestSchema = z.object({
  horizonMonths: z.number().int().min(1).max(24).default(6),
  includeCategories: z.boolean().default(true),
});

/* ── Inferred payload types ───────────────────────────────── */

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type IncomeSourceInput = z.infer<typeof incomeSourceSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;
export type DebtInput = z.infer<typeof debtSchema>;
export type DebtPaymentInput = z.infer<typeof debtPaymentSchema>;
export type PayoffPlanInput = z.infer<typeof payoffPlanSchema>;
export type SavingsGoalInput = z.infer<typeof savingsGoalSchema>;
export type GoalContributionInput = z.infer<typeof goalContributionSchema>;
export type BudgetInput = z.infer<typeof budgetSchema>;
export type BudgetLineInput = z.infer<typeof budgetLineSchema>;
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type AiChatInput = z.infer<typeof aiChatSchema>;
export type ForecastRequest = z.infer<typeof forecastRequestSchema>;
