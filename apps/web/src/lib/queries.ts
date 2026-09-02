'use client';

import type {
  AdminStats,
  AdminUserDetail,
  AdminUserRow,
  BudgetDto,
  CategoryBreakdownDto,
  CategoryDto,
  DashboardSummaryDto,
  DebtDto,
  ExchangeRateDto,
  ExpenseDto,
  ForecastDto,
  IncomeSourceDto,
  NotificationDto,
  Paginated,
  RecommendationDto,
  SavingsGoalDto,
  TrendPointDto,
  UpcomingBillDto,
} from '@eco/shared';
import { api } from './api-client';

/**
 * Query keys, centralised.
 *
 * Every key starts with a domain segment so an invalidation after a mutation
 * can knock out a whole subtree — writing an expense invalidates `['expenses']`
 * *and* `['dashboard']`, because a new expense changes both.
 */
export const queryKeys = {
  me: ['me'] as const,
  dashboard: (month?: string) => ['dashboard', 'summary', month ?? 'current'] as const,
  trend: (months: number) => ['dashboard', 'trend', months] as const,
  breakdown: (month: string) => ['dashboard', 'breakdown', month] as const,
  upcomingBills: ['dashboard', 'upcoming-bills'] as const,
  netWorth: (months: number) => ['dashboard', 'net-worth', months] as const,
  expenses: (filters: Record<string, unknown>) => ['expenses', filters] as const,
  categories: ['categories'] as const,
  income: ['income'] as const,
  incomeSummary: ['income', 'summary'] as const,
  debts: ['debts'] as const,
  debtComparison: (budget: number) => ['debts', 'compare', budget] as const,
  goals: ['goals'] as const,
  goalContributions: (id: string) => ['goals', id, 'contributions'] as const,
  budget: (month: string) => ['budgets', month] as const,
  budgetSuggestion: (month: string) => ['budgets', 'suggest', month] as const,
  adminStats: ['admin', 'stats'] as const,
  adminUsers: (search: string, status: string) => ['admin', 'users', search, status] as const,
  adminUser: (id: string) => ['admin', 'users', id] as const,
  forecast: (horizon: number) => ['ai', 'forecast', horizon] as const,
  patterns: ['ai', 'patterns'] as const,
  recommendations: ['ai', 'recommendations'] as const,
  healthScore: ['ai', 'health-score'] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: string) => ['ai', 'conversation', id] as const,
  exchangeRates: (date?: string) => ['currency', 'rates', date ?? 'latest'] as const,
  notifications: ['notifications'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
} as const;

export const fetchers = {
  budgetSuggestion: (month: string) =>
    api.get<{ lines: Array<{ categoryId: string; limitMinor: number }>; totalLimitMinor: number }>(
      '/budgets/suggest',
      { query: { month } },
    ),

  adminStats: () => api.get<AdminStats>('/admin/stats'),

  adminUsers: (search?: string, status?: string) =>
    api.get<Paginated<AdminUserRow>>('/admin/users', {
      query: { search: search || undefined, status: status || undefined, limit: 50 },
    }),

  adminUser: (id: string) => api.get<AdminUserDetail>(`/admin/users/${id}`),

  dashboardSummary: (month?: string) =>
    api.get<DashboardSummaryDto>('/dashboard/summary', { query: { month } }),

  trend: (months = 12) =>
    api.get<TrendPointDto[]>('/dashboard/trend', { query: { months } }),

  categoryBreakdown: (month: string) =>
    api.get<CategoryBreakdownDto[]>('/dashboard/category-breakdown', { query: { month } }),

  upcomingBills: (days = 14) =>
    api.get<UpcomingBillDto[]>('/dashboard/upcoming-bills', { query: { days } }),

  netWorthHistory: (months = 12) =>
    api.get<Array<{ month: string; savingsMinor: number; debtMinor: number; netWorthMinor: number }>>(
      '/dashboard/net-worth-history',
      { query: { months } },
    ),

  expenses: (filters: Record<string, string | number | undefined> = {}) =>
    api.get<Paginated<ExpenseDto>>('/expenses', { query: filters }),

  categories: () => api.get<CategoryDto[]>('/categories'),

  // Inactive and ended sources are listed too: a source you paused or a
  // contract that finished still has to be findable to be edited or resumed.
  // The page marks their state rather than hiding them.
  income: () => api.get<IncomeSourceDto[]>('/income', { query: { includeInactive: 'true' } }),

  incomeSummary: () =>
    api.get<{ monthlyTotalMinor: number; currency: string }>('/income/summary'),

  debts: () => api.get<DebtDto[]>('/debts'),

  debtComparison: (monthlyBudgetMinor: number) =>
    api.get<DebtStrategyComparison>('/debts/strategies/compare', {
      query: { monthlyBudgetMinor },
    }),

  goals: () => api.get<SavingsGoalDto[]>('/goals'),

  goalContributions: (goalId: string) =>
    api.get<GoalContributionRow[]>(`/goals/${goalId}/contributions`),

  // React Query rejects `undefined` as query data, so an absent budget is
  // normalised to an explicit null the UI can render an empty state from.
  budget: (month: string) =>
    api.get<BudgetDto | null>(`/budgets/${month}`).then((b) => b ?? null),

  forecast: (horizonMonths = 6) =>
    api.get<ForecastDto>('/ai/forecast', { query: { horizonMonths } }),

  patterns: () => api.get<SpendingPatternsResponse>('/ai/patterns'),

  recommendations: () => api.get<RecommendationDto[]>('/ai/recommendations'),

  healthScore: () => api.get<HealthScore>('/ai/health-score'),

  notifications: () => api.get<Paginated<NotificationDto>>('/notifications'),

  unreadCount: () => api.get<{ count: number }>('/notifications/unread-count'),

  exchangeRates: (date?: string) =>
    api.get<ExchangeRateDto>('/currency/rates', { query: { date } }),
};

/* ── Response shapes the API composes rather than importing wholesale ─── */

/** One payment into (or out of) a goal, as entered and as converted. */
export interface GoalContributionRow {
  id: string;
  amountMinor: number;
  currency: string;
  goalAmountMinor: number;
  date: string;
  notes: string | null;
}

export interface DebtStrategySummary {
  strategy: 'SNOWBALL' | 'AVALANCHE' | 'CUSTOM';
  monthsToDebtFree: number;
  debtFreeDate: string;
  totalPaidMinor: number;
  totalInterestMinor: number;
  isFeasible: boolean;
  payoffOrder: Array<{ debtId: string; debtName: string; clearedInMonth: number }>;
}

export interface DebtStrategyComparison {
  snowball: DebtStrategySummary;
  avalanche: DebtStrategySummary;
  minimumOnly: DebtStrategySummary;
  snowballExtraInterestMinor: number;
  interestSavedVsMinimumMinor: number;
  monthsSavedVsMinimum: number;
  recommended: 'SNOWBALL' | 'AVALANCHE' | 'CUSTOM';
  rationale: string;
}

export interface HealthScore {
  score: number;
  band: 'CRITICAL' | 'AT_RISK' | 'FAIR' | 'GOOD' | 'EXCELLENT';
  components: Array<{ name: string; score: number; weight: number; detail: string }>;
}

export interface SpendingPatternsResponse {
  recurringExpenses: Array<{
    merchant: string;
    categoryId: string;
    categoryName: string;
    averageAmountMinor: number;
    frequency: string;
    lastSeen: string;
    nextExpectedDate: string;
    occurrences: number;
    confidence: number;
  }>;
  incomeConsistency: {
    volatility: number;
    label: 'STEADY' | 'VARIABLE' | 'IRREGULAR';
    averageMonthlyMinor: number;
  };
  seasonality: Array<{ month: number; indexVsAverage: number; sampleSize: number }>;
  topMerchants: Array<{ merchant: string; amountMinor: number; count: number }>;
  weekdayDistribution: Array<{ weekday: number; amountMinor: number; count: number }>;
  monthsAnalysed: number;
  transactionsAnalysed: number;
}
