-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'PREMIUM', 'SUPPORT', 'ADMIN');

-- CreateEnum
CREATE TYPE "IncomeType" AS ENUM ('SALARY', 'FREELANCE', 'BUSINESS', 'INVESTMENT', 'RENTAL', 'SIDE_HUSTLE', 'OTHER');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "DebtType" AS ENUM ('CREDIT_CARD', 'PERSONAL_LOAN', 'CAR_LOAN', 'MORTGAGE', 'STUDENT_LOAN', 'MEDICAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PayoffStrategy" AS ENUM ('SNOWBALL', 'AVALANCHE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('EMERGENCY_FUND', 'VACATION', 'CAR_PURCHASE', 'HOME_DOWN_PAYMENT', 'RETIREMENT', 'EDUCATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'PAUSED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "BudgetType" AS ENUM ('FIXED', 'VARIABLE', 'ROLLING');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BILL_DUE', 'BUDGET_EXCEEDED', 'BUDGET_WARNING', 'DEBT_DUE', 'SAVINGS_MILESTONE', 'GOAL_ACHIEVED', 'AI_INSIGHT', 'SECURITY_ALERT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RecommendationKind" AS ENUM ('REDUCE_CATEGORY_SPEND', 'MOVE_CASH_TO_SAVINGS', 'REFINANCE_DEBT', 'ADJUST_BUDGET', 'BUILD_EMERGENCY_FUND', 'CANCEL_SUBSCRIPTION', 'INCREASE_DEBT_PAYMENT', 'CASHFLOW_WARNING');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('NEW', 'SEEN', 'ACCEPTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('PDF', 'XLSX', 'CSV');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_RESET', 'TWO_FA_ENABLED', 'TWO_FA_DISABLED', 'EXPORT', 'AI_QUERY');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant', 'system');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "country" CHAR(2),
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en-US',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "financialGoals" JSONB,
    "tokensValidFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "userAgent" VARCHAR(400),
    "ipAddress" INET,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "providerId" VARCHAR(60),
    "externalId" VARCHAR(120),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "base" CHAR(3) NOT NULL,
    "quote" CHAR(3) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "date" DATE NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_sources" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "IncomeType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "frequency" "Frequency" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "income_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_receipts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "incomeSourceId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "baseAmountMinor" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "income_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(40),
    "icon" VARCHAR(40) NOT NULL DEFAULT 'circle',
    "color" CHAR(7) NOT NULL DEFAULT '#64748b',
    "parentId" UUID,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isEssential" BOOLEAN NOT NULL DEFAULT false,
    "monthlyBudgetMinor" BIGINT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "accountId" UUID,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "baseAmountMinor" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "merchant" VARCHAR(160),
    "notes" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurringFrequency" "Frequency",
    "recurringGroupId" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "receiptUrl" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "DebtType" NOT NULL,
    "lender" VARCHAR(160),
    "principalMinor" BIGINT NOT NULL,
    "currentBalanceMinor" BIGINT NOT NULL,
    "interestRateApr" DECIMAL(6,3) NOT NULL,
    "minimumPaymentMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dueDayOfMonth" SMALLINT NOT NULL,
    "openedDate" DATE,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debt_payments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "debtId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "interestMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "balanceAfterMinor" BIGINT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payoff_plans" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "strategy" "PayoffStrategy" NOT NULL,
    "monthlyBudgetMinor" BIGINT NOT NULL,
    "extraOneOffMinor" BIGINT NOT NULL DEFAULT 0,
    "debtOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payoff_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_goals" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "GoalType" NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetAmountMinor" BIGINT NOT NULL,
    "currentAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "deadline" DATE,
    "monthlyContributionMinor" BIGINT,
    "color" CHAR(7) NOT NULL DEFAULT '#0ea5e9',
    "icon" VARCHAR(40) NOT NULL DEFAULT 'piggy-bank',
    "notes" TEXT,
    "achievedAt" TIMESTAMP(3),
    "lastMilestoneNotified" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "savings_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_contributions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "type" "BudgetType" NOT NULL DEFAULT 'FIXED',
    "currency" CHAR(3) NOT NULL,
    "totalLimitMinor" BIGINT,
    "alertThresholdPct" INTEGER NOT NULL DEFAULT 80,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL,
    "budgetId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "limitMinor" BIGINT NOT NULL,
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "rolloverFromPreviousMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spending_patterns" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_snapshots" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "horizonMonths" INTEGER NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "payload" JSONB NOT NULL,
    "realisedError" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'NEW',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "estimatedImpactMinor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "priority" VARCHAR(10) NOT NULL,
    "evidence" JSONB NOT NULL,
    "actionUrl" VARCHAR(200),
    "fingerprint" VARCHAR(80) NOT NULL,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "model" VARCHAR(60),
    "tokensUsed" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" VARCHAR(200),
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "dedupeKey" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channels" "NotificationChannel"[] DEFAULT ARRAY['IN_APP', 'EMAIL']::"NotificationChannel"[],
    "billDueLeadDays" INTEGER NOT NULL DEFAULT 3,
    "budgetWarnings" BOOLEAN NOT NULL DEFAULT true,
    "debtReminders" BOOLEAN NOT NULL DEFAULT true,
    "savingsMilestones" BOOLEAN NOT NULL DEFAULT true,
    "aiInsights" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStart" VARCHAR(5),
    "quietHoursEnd" VARCHAR(5),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "deviceName" VARCHAR(120),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "period" "ReportPeriod" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" VARCHAR(400),
    "sizeBytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" "AuditAction" NOT NULL,
    "entityType" VARCHAR(60) NOT NULL,
    "entityId" UUID,
    "changes" JSONB,
    "ipAddress" INET,
    "userAgent" VARCHAR(400),
    "requestId" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "oauth_accounts_userId_idx" ON "oauth_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_providerUserId_key" ON "oauth_accounts"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "verification_tokens_userId_purpose_idx" ON "verification_tokens"("userId", "purpose");

-- CreateIndex
CREATE INDEX "verification_tokens_expiresAt_idx" ON "verification_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "financial_accounts_userId_deletedAt_idx" ON "financial_accounts"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_providerId_externalId_key" ON "financial_accounts"("providerId", "externalId");

-- CreateIndex
CREATE INDEX "exchange_rates_date_idx" ON "exchange_rates"("date");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_quote_date_key" ON "exchange_rates"("base", "quote", "date");

-- CreateIndex
CREATE INDEX "income_sources_userId_isActive_deletedAt_idx" ON "income_sources"("userId", "isActive", "deletedAt");

-- CreateIndex
CREATE INDEX "income_sources_userId_startDate_idx" ON "income_sources"("userId", "startDate");

-- CreateIndex
CREATE INDEX "income_receipts_userId_date_idx" ON "income_receipts"("userId", "date");

-- CreateIndex
CREATE INDEX "income_receipts_incomeSourceId_date_idx" ON "income_receipts"("incomeSourceId", "date");

-- CreateIndex
CREATE INDEX "categories_userId_isArchived_idx" ON "categories"("userId", "isArchived");

-- CreateIndex
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_userId_name_key" ON "categories"("userId", "name");

-- CreateIndex
CREATE INDEX "expenses_userId_date_deletedAt_idx" ON "expenses"("userId", "date" DESC, "deletedAt");

-- CreateIndex
CREATE INDEX "expenses_userId_categoryId_date_idx" ON "expenses"("userId", "categoryId", "date");

-- CreateIndex
CREATE INDEX "expenses_userId_merchant_idx" ON "expenses"("userId", "merchant");

-- CreateIndex
CREATE INDEX "expenses_recurringGroupId_idx" ON "expenses"("recurringGroupId");

-- CreateIndex
CREATE INDEX "debts_userId_isClosed_deletedAt_idx" ON "debts"("userId", "isClosed", "deletedAt");

-- CreateIndex
CREATE INDEX "debts_userId_dueDayOfMonth_idx" ON "debts"("userId", "dueDayOfMonth");

-- CreateIndex
CREATE INDEX "debt_payments_userId_date_idx" ON "debt_payments"("userId", "date");

-- CreateIndex
CREATE INDEX "debt_payments_debtId_date_idx" ON "debt_payments"("debtId", "date" DESC);

-- CreateIndex
CREATE INDEX "payoff_plans_userId_isActive_idx" ON "payoff_plans"("userId", "isActive");

-- CreateIndex
CREATE INDEX "savings_goals_userId_status_deletedAt_idx" ON "savings_goals"("userId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "goal_contributions_goalId_date_idx" ON "goal_contributions"("goalId", "date" DESC);

-- CreateIndex
CREATE INDEX "goal_contributions_userId_date_idx" ON "goal_contributions"("userId", "date");

-- CreateIndex
CREATE INDEX "budgets_userId_month_idx" ON "budgets"("userId", "month" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "budgets_userId_month_key" ON "budgets"("userId", "month");

-- CreateIndex
CREATE INDEX "budget_lines_categoryId_idx" ON "budget_lines"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_budgetId_categoryId_key" ON "budget_lines"("budgetId", "categoryId");

-- CreateIndex
CREATE INDEX "spending_patterns_expiresAt_idx" ON "spending_patterns"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "spending_patterns_userId_key" ON "spending_patterns"("userId");

-- CreateIndex
CREATE INDEX "forecast_snapshots_userId_createdAt_idx" ON "forecast_snapshots"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "forecast_snapshots_expiresAt_idx" ON "forecast_snapshots"("expiresAt");

-- CreateIndex
CREATE INDEX "recommendations_userId_status_priority_idx" ON "recommendations"("userId", "status", "priority");

-- CreateIndex
CREATE INDEX "recommendations_expiresAt_idx" ON "recommendations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_userId_fingerprint_key" ON "recommendations"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "ai_conversations_userId_updatedAt_idx" ON "ai_conversations"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

-- CreateIndex
CREATE INDEX "push_tokens_userId_idx" ON "push_tokens"("userId");

-- CreateIndex
CREATE INDEX "reports_userId_createdAt_idx" ON "reports"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "reports_expiresAt_idx" ON "reports"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_incomeSourceId_fkey" FOREIGN KEY ("incomeSourceId") REFERENCES "income_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "savings_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spending_patterns" ADD CONSTRAINT "spending_patterns_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_snapshots" ADD CONSTRAINT "forecast_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
