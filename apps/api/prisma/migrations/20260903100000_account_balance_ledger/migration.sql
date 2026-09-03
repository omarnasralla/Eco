-- Account balances become derived rather than typed.
--
-- A balance is now an opening figure at a date, plus every transaction assigned
-- to the account since. Deriving it makes it self-correcting: an edited or
-- deleted expense moves the balance back by exactly what it moved it by, which
-- an incrementally-adjusted running total cannot promise.
--
-- "balanceMinor" becomes the opening figure. Existing balances are exactly
-- that: a number the user typed as true at some point, so the opening date is
-- set to today, meaning "true as of now" and leaving history untouched.

ALTER TABLE "financial_accounts" RENAME COLUMN "balanceMinor" TO "openingBalanceMinor";

ALTER TABLE "financial_accounts"
  ADD COLUMN "openingBalanceDate" DATE NOT NULL DEFAULT CURRENT_DATE;

-- Expenses already carried an unused, unconstrained accountId. Give it a real
-- foreign key now that something reads it. ON DELETE SET NULL: removing an
-- account must not delete the spending that went through it.
CREATE INDEX IF NOT EXISTS "expenses_accountId_date_idx"
  ON "expenses" ("accountId", "date");

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;

-- Income lands in an account too, or the balance only ever falls.
ALTER TABLE "income_receipts" ADD COLUMN "accountId" UUID;

CREATE INDEX IF NOT EXISTS "income_receipts_accountId_date_idx"
  ON "income_receipts" ("accountId", "date");

ALTER TABLE "income_receipts"
  ADD CONSTRAINT "income_receipts_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;
