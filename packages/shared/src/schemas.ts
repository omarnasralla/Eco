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
  USER_ROLES,
  ACCOUNT_KINDS,
} from './enums';

/** Amounts arrive as integer minor units — see money.ts for the rationale. */
export const minorAmount = z
  .number()
  .int('Amount must be an integer number of minor units')
  .nonnegative('Amount cannot be negative')
  .max(Number.MAX_SAFE_INTEGER);

/**
 * An amount that must actually be an amount.
 *
 * `minorAmount` permits zero, which is right for a savings balance or a budget
 * line but wrong for a transaction: a zero-amount income source or expense is
 * never something a person meant to record, and accepting one silently stores a
 * row that displays as nothing. The forms already tell the user the figure must
 * be above zero; this is what makes that true, on the server as well.
 */
export const positiveMinorAmount = minorAmount.refine(
  (v) => v > 0,
  'Enter an amount greater than zero',
);

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
    amountMinor: positiveMinorAmount,
    currency: currencyCode,
    frequency: z.enum(FREQUENCIES),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    isActive: z.boolean().default(true),
    /** Receipts land in this account whenever they do not name their own. */
    accountId: uuid.nullish(),
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
  amountMinor: positiveMinorAmount,
  /** Which account it came out of. Null leaves every balance untouched. */
  accountId: uuid.nullish(),
  currency: currencyCode,
  categoryId: uuid,
  date: isoDate,
  merchant: z.string().trim().max(160).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  isRecurring: z.boolean().default(false),
  recurringFrequency: z.enum(FREQUENCIES).nullish(),
  /** Spent, but outside what any budget was meant to cover. */
  excludedFromBudget: z.boolean().default(false),
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
  /** Only the captured rows whose category nobody has confirmed yet. */
  needsReview: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * `created` — the order things were entered, which is what a list you are
   * adding to should show: the row you just typed belongs at the top even when
   * you dated it last Tuesday. `date` orders by when the money was spent.
   */
  sort: z.enum(['created', 'date', 'amount', 'merchant']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Renaming a merchant across every expense that uses it.
 *
 * Card terminals and bank alerts spell a shop however they like — "Nwateh"
 * typed by hand, "Nawateh" from the SMS, "Motor Sports" and "MotorSports" from
 * the same till. Each spelling is a separate merchant to every report and to
 * category inference, and there was no way to reconcile them without editing
 * the database by hand.
 *
 * Renaming onto a name that already exists is a merge, which is the common
 * case rather than an edge one.
 */
export const renameMerchantSchema = z.object({
  from: z.string().trim().min(1).max(160),
  to: z.string().trim().min(1).max(160),
  /**
   * Optionally file every affected row under one category at the same time.
   * Two spellings often carry two categories, and a merge that leaves the
   * merchant split across both has only half-solved the problem.
   */
  categoryId: uuid.optional(),
});

export type RenameMerchantInput = z.infer<typeof renameMerchantSchema>;

/* ── Planned purchases ────────────────────────────────────── */

/**
 * Something you intend to buy in a given month, deliberately outside that
 * month's budget.
 */
export const plannedPurchaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  amountMinor: positiveMinorAmount,
  currency: currencyCode,
  /** Any date inside the intended month; the server keeps the first of it. */
  month: isoDate,
  categoryId: uuid.nullish(),
  /** The point of the feature, so it defaults on. */
  excludeFromBudget: z.boolean().default(true),
  notes: z.string().trim().max(500).nullish(),
});

export const updatePlannedPurchaseSchema = plannedPurchaseSchema.partial();

/** Marking one bought, optionally pointing at the expense it became. */
export const markPurchasedSchema = z.object({
  /**
   * The expense this turned into. Given one, the exclusion is applied to that
   * row — which is the whole reason to plan a purchase ahead rather than
   * remember to tick a box afterwards.
   */
  expenseId: uuid.nullish(),
});

export type PlannedPurchaseInput = z.infer<typeof plannedPurchaseSchema>;
export type UpdatePlannedPurchaseInput = z.infer<typeof updatePlannedPurchaseSchema>;
export type MarkPurchasedInput = z.infer<typeof markPurchasedSchema>;

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
  /** Paid from this account whenever a payment does not name its own. */
  accountId: uuid.nullish(),
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
  /** Which account the payment came out of. Omitted, it reduces the debt
   *  without reducing any account's cash — net worth overstates by the
   *  payment amount until this is set. */
  accountId: uuid.nullish(),
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
  /**
   * The account the money came out of. Null records the saving without moving
   * any balance, which leaves the same money counted as both cash and savings.
   */
  accountId: uuid.nullish(),
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
  /** A device token, or for web push the subscription's endpoint URL. */
  token: z.string().min(8).max(512),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceName: z.string().trim().max(120).optional(),
  /**
   * Web push only. The browser generates these two keys and the payload is
   * encrypted to them, so a subscription without them can never be sent to.
   */
  p256dh: z.string().max(200).optional(),
  auth: z.string().max(200).optional(),
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

/* ── Admin ────────────────────────────────────────────────── */

/**
 * What an administrator may change about another account.
 *
 * Intentionally narrow. An admin console that can edit a user's own financial
 * records invites exactly the mistake it exists to prevent, so this covers
 * identity and access only — the money stays the user's.
 */
export const adminUpdateUserSchema = z
  .object({
    role: z.enum(USER_ROLES),
    emailVerified: z.boolean(),
    name: z.string().trim().min(1).max(120),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied' });

export const adminUserQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['active', 'locked', 'deleted', 'unverified']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>;

/* ── Accounts ─────────────────────────────────────────────── */

/** Money lent to a person. */
export const receivableSchema = z.object({
  person: z.string().trim().min(1).max(120),
  /** Always positive: the direction is the table, not the sign. */
  amountMinor: z.number().int().positive(),
  currency: currencyCode,
  lentOn: isoDate,
  /** The account it left, so the balance can account for it. */
  accountId: uuid.nullish(),
  note: z.string().trim().max(300).nullish(),
});

export const updateReceivableSchema = receivableSchema.partial().extend({
  /**
   * Call it done. A loan written off is settled too — leaving it outstanding
   * for ever would quietly inflate net worth.
   */
  settled: z.boolean().optional(),
});

/** One repayment coming back. */
export const receivablePaymentSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: currencyCode.optional(),
  date: isoDate.optional(),
  accountId: uuid.nullish(),
  note: z.string().trim().max(300).nullish(),
});

export type ReceivableInput = z.infer<typeof receivableSchema>;
export type UpdateReceivableInput = z.infer<typeof updateReceivableSchema>;
export type ReceivablePaymentInput = z.infer<typeof receivablePaymentSchema>;

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ACCOUNT_KINDS),
  currency: currencyCode,
  /**
   * Signed, unlike a transaction amount: a current account can be overdrawn,
   * and refusing to record that would make the one balance a person most needs
   * to see the one they cannot enter.
   */
  balanceMinor: signedMinorAmount,
  /**
   * The date that balance was true. Transactions from this date onward move it;
   * anything earlier is taken as already reflected in the figure. Defaults to
   * today, but can be back-dated so an existing ledger builds the balance up
   * rather than being ignored.
   */
  openingBalanceDate: isoDate.optional(),
  isPrimary: z.boolean().default(false),
  /**
   * Read this account's balance from the bank's own alerts for this card
   * instead of adding movements up.
   *
   * Four digits, or null to go back to computing it. The card need not be in
   * `cardsLast4` — the list says which card's purchases land here, and the
   * account whose BALANCE a card reports is not always the same one.
   */
  balanceCardLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Four digits')
    .nullish(),
  /**
   * The bank alert channel whose card-less messages belong here.
   *
   * Every other alert names a card and the card names the account. Neo's
   * person-to-person notice names neither, so the account claims the channel
   * instead. Null to stop claiming it.
   */
  alertChannel: z.string().trim().max(32).nullish(),
  /**
   * Merchant substrings whose alerts mean money arrived in this account.
   *
   * Matched case-insensitively as substrings, so "IBL ASHRAFIEH" catches
   * "IBL ASHRAFIEHASHRAFIEHLB". Blank entries are ignored rather than
   * matching everything.
   */
  alertAliases: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
});

export const updateAccountSchema = accountSchema.partial();

export type AccountInput = z.infer<typeof accountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

/**
 * Reconciling an account against the money actually in it.
 *
 * Distinct from sending `balanceMinor` to PATCH /accounts/:id, which also makes
 * the balance equal what you type — but does it by solving backwards for the
 * opening figure, so the discrepancy disappears into history and is never
 * spent by anyone. This records the difference as a transaction instead: what
 * you counted is the truth, and the gap is money that went somewhere.
 */
export const reconcileAccountSchema = z.object({
  /** What you actually counted. Signed: an account can genuinely be overdrawn. */
  actualBalanceMinor: signedMinorAmount,
  /**
   * When you counted it. Defaults to today, and cannot precede the account's
   * opening date — a correction dated before the opening figure is not counted
   * as a movement, so the balance would not land on the number you typed.
   */
  date: isoDate.optional(),
  notes: z.string().trim().max(500).nullish(),
});

export type ReconcileAccountInput = z.infer<typeof reconcileAccountSchema>;

/* ── Automated capture ────────────────────────────────────── */

/**
 * What a phone posts when a card is tapped.
 *
 * Shaped for the iOS Wallet automation, which hands a shortcut display text
 * rather than numbers — so `amount` accepts "$12.34" and the server parses it
 * against the currency. `amountMinor` is there for any caller that already
 * knows the exact integer and should not have its precision re-derived.
 */
export const ingestExpenseSchema = z
  .object({
    /** Display text straight from the phone: "$12.34", "1.234,56", "﷼ 45". */
    amount: z.union([z.string().trim().min(1).max(40), z.number()]).optional(),
    /** For callers that already have exact minor units. Wins over `amount`. */
    amountMinor: z.number().int().positive().optional(),
    /** Defaults to the matched account's currency, else the user's base. */
    currency: currencyCode.optional(),
    merchant: z.string().trim().min(1).max(160),
    /** The Wallet card name, matched against account names. */
    card: z.string().trim().max(120).nullish(),
    /** Defaults to today. A tap is posted as it happens. */
    date: isoDate.optional(),
    /**
     * Idempotency key. A phone on a bad connection retries, and the same tap
     * must not land twice — send anything stable and unique to the tap.
     *
     * Generous limit on purpose. The natural thing to build in a shortcut is
     * merchant + amount + timestamp, and a long merchant name pushes that past
     * any tight bound — rejecting it would lose the expense over the length of
     * a shop's name. Anything longer than the stored column is hashed server
     * side, which is just as stable and just as unique.
     */
    reference: z.string().trim().max(512).nullish(),
    notes: z.string().trim().max(500).nullish(),
  })
  .refine((v) => v.amount !== undefined || v.amountMinor !== undefined, {
    message: 'Send either amount or amountMinor',
    path: ['amount'],
  });

/**
 * A bank's SMS alert, forwarded unchanged.
 *
 * Deliberately just the text. Everything — amount, merchant, card, direction,
 * and whether it is a transaction at all — is read server side, where it can
 * be tested against real messages instead of assembled by text actions on a
 * phone that fail silently.
 */
export const ingestSmsSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export type IngestSmsInput = z.infer<typeof ingestSmsSchema>;

/** Naming one, so a lost phone can be revoked without cutting off the others. */
export const ingestTokenSchema = z.object({
  label: z.string().trim().min(1).max(80),
});

export type IngestExpenseInput = z.infer<typeof ingestExpenseSchema>;
export type IngestTokenInput = z.infer<typeof ingestTokenSchema>;

/* ── Income receipts ──────────────────────────────────────── */

/** Recording a payment against an existing source. */
export const incomeReceiptSchema = z.object({
  amountMinor: positiveMinorAmount,
  date: isoDate,
  /** Where the money landed. Omitted against a source, it falls back to that
   *  source's own account; an explicit null moves no balance. */
  accountId: uuid.nullish(),
  notes: z.string().trim().max(500).nullish(),
});

/**
 * A one-off payment with no schedule behind it, so it carries its own name and
 * currency rather than borrowing a source's.
 */
export const standaloneReceiptSchema = incomeReceiptSchema.extend({
  name: z.string().trim().min(1).max(120),
  currency: currencyCode,
});

export type IncomeReceiptInput = z.infer<typeof incomeReceiptSchema>;
export type StandaloneReceiptInput = z.infer<typeof standaloneReceiptSchema>;
