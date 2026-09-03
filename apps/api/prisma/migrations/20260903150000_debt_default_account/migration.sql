-- The account an installment is paid from by default.
--
-- A debt already carries its own due day, so it is a recurring obligation by
-- design — unlike a one-off expense, remembering the paying account once is
-- what turns "record payment" into a single click every month instead of a
-- re-pick. recordPayment falls back to this whenever a payment does not name
-- its own account.

ALTER TABLE "debts" ADD COLUMN "accountId" UUID;

CREATE INDEX IF NOT EXISTS "debts_accountId_idx" ON "debts" ("accountId");

ALTER TABLE "debts"
  ADD CONSTRAINT "debts_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;
