-- Things you intend to buy in a given month, deliberately outside that
-- month's budget.
--
-- `excludedFromBudget` already existed, but only as a flag on money already
-- spent — a statement about history, set by remembering to tick a box weeks
-- after deciding. This is the decision itself, recorded before the purchase,
-- so the exclusion follows automatically when the expense arrives.
--
-- Deliberately NOT a liability: a planned purchase moves no balance and
-- changes no net worth until it actually happens. It is an intention, and
-- treating intentions as debts is how a planner turns into a source of false
-- alarm.
--
-- Status is derived from timestamps rather than stored as an enum, so a row
-- carries WHEN it was bought or abandoned, not merely that it was.

CREATE TABLE "planned_purchases" (
    "id"                 UUID         NOT NULL,
    "userId"             UUID         NOT NULL,
    "name"               VARCHAR(160) NOT NULL,
    "amountMinor"        BIGINT       NOT NULL,
    "currency"           CHAR(3)      NOT NULL,
    -- First day of the month, matching budgets.month so the two line up.
    "month"              DATE         NOT NULL,
    "categoryId"         UUID,
    "excludeFromBudget"  BOOLEAN      NOT NULL DEFAULT true,
    "notes"              TEXT,
    -- The expense this turned into, once bought.
    "purchasedExpenseId" UUID,
    "purchasedAt"        TIMESTAMP(3),
    "cancelledAt"        TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planned_purchases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "planned_purchases_userId_month_idx" ON "planned_purchases" ("userId", "month");
-- One planned purchase per expense: linking the same expense to two plans
-- would double-count the month's intended spending.
CREATE UNIQUE INDEX "planned_purchases_purchasedExpenseId_key"
    ON "planned_purchases" ("purchasedExpenseId");

ALTER TABLE "planned_purchases"
    ADD CONSTRAINT "planned_purchases_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Categories are archived rather than deleted, but a user-made one can go.
-- The plan should survive that with no category rather than vanish.
ALTER TABLE "planned_purchases"
    ADD CONSTRAINT "planned_purchases_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "planned_purchases"
    ADD CONSTRAINT "planned_purchases_purchasedExpenseId_fkey"
    FOREIGN KEY ("purchasedExpenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
