'use client';

import type {
  BudgetDto,
  CategoryBreakdownDto,
  CategoryDto,
  DashboardSummaryDto,
  DebtDto,
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
  budget: (month: string) => ['budgets', month] as const,
  forecast: (horizon: number) => ['ai', 'forecast', horizon] as const,
  patterns: ['ai', 'patterns'] as const,
  recommendations: ['ai', 'recommendations'] as const,
  healthScore: ['ai', 'health-score'] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: string) => ['ai', 'conversation', id] as const,
  notifications: ['notifications'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
} as const;

export const fetchers = {
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

  income: () => api.get<IncomeSourceDto[]>('/income'),

  incomeSummary: () =>
    api.get<{ monthlyTotalMinor: number; currency: string }>('/income/summary'),

  debts: () => api.get<DebtDto[]>('/debts'),

  debtComparison: (monthlyBudgetMinor: number) =>
    api.get<DebtStrategyComparison>('/debts/strategies/compare', {
      query: { monthlyBudgetMinor },
    }),

  goals: () => api.get<SavingsGoalDto[]>('/goals'),

  budget: (month: string) => api.get<BudgetDto | null>(`/budgets/${month}`),

  forecast: (horizonMonths = 6) =>
    api.get<ForecastDto>('/ai/forecast', { query: { horizonMonths } }),

  patterns: () => api.get<SpendingPatternsResponse>('/ai/patterns'),

  recommendations: () => api.get<RecommendationDto[]>('/ai/recommendations'),

  healthScore: () => api.get<HealthScore>('/ai/health-score'),

  notifications: () => api.get<Paginated<NotificationDto>>('/notifications'),

  unreadCount: () => api.get<{ count: number }>('/notifications/unread-count'),
};

/* ── Response shapes the API composes rather than importing wholesale ─── */

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
