/**
 * Response shapes returned by the API.  The web client and (later) the React
 * Native client type their fetch layer against these, so a breaking API change
 * shows up as a TypeScript error rather than a runtime surprise.
 */
import type {
  BudgetType,
  DebtType,
  Frequency,
  GoalStatus,
  GoalType,
  IncomeType,
  NotificationChannel,
  NotificationType,
  PayoffStrategy,
  RecommendationKind,
  RecommendationStatus,
  UserRole,
} from './enums';
import type { NotificationPreferences } from './schemas';

export interface Paginated<T> {
  items: T[];
  /** Opaque cursor for the next page; null when the list is exhausted. */
  nextCursor: string | null;
  total?: number;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  /** Correlates a client report with server logs. */
  requestId: string;
  timestamp: string;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  country: string | null;
  currency: string;
  timezone: string;
  locale: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  financialGoals: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginResponseDto {
  user?: UserDto;
  tokens?: AuthTokensDto;
  /** Set when the account has TOTP on and the client must collect a code. */
  twoFactorRequired?: boolean;
  challengeToken?: string;
}

export interface TwoFactorSetupDto {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

export interface IncomeSourceDto {
  id: string;
  name: string;
  type: IncomeType;
  amountMinor: number;
  currency: string;
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  notes: string | null;
  /** Derived: amountMinor normalised to a monthly figure. */
  monthlyEquivalentMinor: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryDto {
  id: string;
  name: string;
  icon: string;
  color: string;
  parentId: string | null;
  isSystem: boolean;
  isArchived: boolean;
  monthlyBudgetMinor: number | null;
  createdAt: string;
}

export interface ExpenseDto {
  id: string;
  amountMinor: number;
  currency: string;
  /** amountMinor converted to the user's base currency at the txn-date rate. */
  baseAmountMinor: number;
  categoryId: string;
  category?: Pick<CategoryDto, 'id' | 'name' | 'icon' | 'color'>;
  date: string;
  merchant: string | null;
  notes: string | null;
  isRecurring: boolean;
  recurringFrequency: Frequency | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DebtDto {
  id: string;
  name: string;
  type: DebtType;
  lender: string | null;
  principalMinor: number;
  currentBalanceMinor: number;
  interestRateApr: number;
  minimumPaymentMinor: number;
  currency: string;
  dueDayOfMonth: number;
  nextDueDate: string;
  isClosed: boolean;
  notes: string | null;
  /** Months to clear at the minimum payment; null if it never amortises. */
  monthsToPayoffAtMinimum: number | null;
  totalInterestAtMinimumMinor: number | null;
  createdAt: string;
}

export interface PayoffScheduleEntryDto {
  monthIndex: number;
  month: string;
  debtId: string;
  debtName: string;
  startingBalanceMinor: number;
  paymentMinor: number;
  interestMinor: number;
  principalMinor: number;
  endingBalanceMinor: number;
}

export interface PayoffPlanDto {
  strategy: PayoffStrategy;
  monthlyBudgetMinor: number;
  monthsToDebtFree: number;
  debtFreeDate: string;
  totalPaidMinor: number;
  totalInterestMinor: number;
  /** Interest saved versus paying only the minimums. */
  interestSavedVsMinimumMinor: number;
  monthsSavedVsMinimum: number;
  payoffOrder: Array<{ debtId: string; debtName: string; clearedInMonth: number }>;
  schedule: PayoffScheduleEntryDto[];
}

export interface SavingsGoalDto {
  id: string;
  name: string;
  type: GoalType;
  status: GoalStatus;
  targetAmountMinor: number;
  currentAmountMinor: number;
  currency: string;
  deadline: string | null;
  monthlyContributionMinor: number | null;
  progressPct: number;
  /** Contribution needed each month to hit the deadline; null without one. */
  requiredMonthlyMinor: number | null;
  projectedCompletionDate: string | null;
  onTrack: boolean;
  color: string;
  icon: string;
  createdAt: string;
}

export interface BudgetLineDto {
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  utilisationPct: number;
  rollover: boolean;
  rolloverFromPreviousMinor: number;
  status: 'UNDER' | 'WARNING' | 'OVER';
}

export interface BudgetDto {
  id: string;
  month: string;
  type: BudgetType;
  currency: string;
  totalLimitMinor: number;
  totalSpentMinor: number;
  totalRemainingMinor: number;
  utilisationPct: number;
  alertThresholdPct: number;
  lines: BudgetLineDto[];
  /** Extrapolated month-end spend from the pace so far. */
  projectedSpendMinor: number;
  daysRemaining: number;
  createdAt: string;
}

export interface UpcomingBillDto {
  id: string;
  /** Which module the obligation came from. */
  source: 'DEBT' | 'RECURRING_EXPENSE' | 'SUBSCRIPTION';
  name: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  daysUntilDue: number;
  categoryColor: string | null;
}

export interface DashboardSummaryDto {
  currency: string;
  period: { from: string; to: string };
  totalIncomeMinor: number;
  totalExpensesMinor: number;
  netCashFlowMinor: number;
  savingsRatePct: number;
  totalDebtMinor: number;
  totalSavingsMinor: number;
  netWorthMinor: number;
  /** Percentage change against the previous equivalent period. */
  deltas: {
    incomePct: number;
    expensesPct: number;
    netWorthPct: number;
  };
  upcomingBills: UpcomingBillDto[];
  budgetUtilisationPct: number | null;
  goalsOnTrack: number;
  goalsTotal: number;
}

export interface TrendPointDto {
  month: string;
  incomeMinor: number;
  expensesMinor: number;
  netMinor: number;
}

export interface CategoryBreakdownDto {
  categoryId: string;
  categoryName: string;
  color: string;
  amountMinor: number;
  sharePct: number;
  /** Change versus the previous period, as a percentage. */
  changePct: number | null;
  transactionCount: number;
}

export interface CashFlowForecastPointDto {
  month: string;
  projectedIncomeMinor: number;
  projectedExpensesMinor: number;
  projectedNetMinor: number;
  projectedBalanceMinor: number;
  /** 80% prediction interval around projectedNetMinor. */
  lowerBoundMinor: number;
  upperBoundMinor: number;
  isShortfall: boolean;
}

export interface ForecastDto {
  generatedAt: string;
  model: string;
  currency: string;
  horizonMonths: number;
  confidence: number;
  points: CashFlowForecastPointDto[];
  categoryForecasts?: Array<{
    categoryId: string;
    categoryName: string;
    nextMonthMinor: number;
    trend: 'RISING' | 'FALLING' | 'STABLE';
  }>;
  warnings: string[];
}

export interface RecommendationDto {
  id: string;
  kind: RecommendationKind;
  status: RecommendationStatus;
  title: string;
  body: string;
  /** Estimated monthly money impact if the user acts on it. */
  estimatedImpactMinor: number | null;
  currency: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  /** What the engine looked at — shown in the UI so advice is never a black box. */
  evidence: Array<{ label: string; value: string }>;
  actionUrl: string | null;
  createdAt: string;
}

export interface SpendingPatternDto {
  recurringExpenses: Array<{
    merchant: string;
    categoryId: string;
    averageAmountMinor: number;
    frequency: Frequency;
    lastSeen: string;
    occurrences: number;
    confidence: number;
  }>;
  incomeConsistency: {
    /** Coefficient of variation of monthly income; lower is steadier. */
    volatility: number;
    label: 'STEADY' | 'VARIABLE' | 'IRREGULAR';
    averageMonthlyMinor: number;
  };
  seasonality: Array<{ month: number; indexVsAverage: number }>;
  topMerchants: Array<{ merchant: string; amountMinor: number; count: number }>;
  weekdayDistribution: Array<{ weekday: number; amountMinor: number }>;
}

export interface AiMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Tool calls the assistant made against the user's own data. */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  tokensUsed?: number;
}

export interface AiChatResponseDto {
  conversationId: string;
  message: AiMessageDto;
  /** Follow-up prompts rendered as tap-targets under the reply. */
  suggestions: string[];
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  channel: NotificationChannel;
  isRead: boolean;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface NotificationSettingsDto extends NotificationPreferences {
  updatedAt: string;
}

export interface ReportDto {
  id: string;
  period: string;
  from: string;
  to: string;
  format: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  downloadUrl: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface ExchangeRateDto {
  base: string;
  date: string;
  rates: Record<string, number>;
  provider: string;
  fetchedAt: string;
}
