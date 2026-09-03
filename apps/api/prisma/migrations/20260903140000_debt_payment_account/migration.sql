-- A debt payment is money leaving an account, same as an expense.
--
-- The debt's balance dropped when a payment was recorded, but nothing said
-- where that money came from — an installment could reduce what you owed
-- without ever reducing the cash you were shown as holding. Net worth counts
-- cash minus debt, so a payment that isn't tied to an account understates the
-- debt (good) without offsetting it against cash (which should also fall),
-- overstating net worth by the same amount each time a payment lands.
--
-- Nullable and not backfilled: a payment made before this existed, or paid in
-- cash outside any tracked account, has nowhere honest to point.

ALTER TABLE "debt_payments" ADD COLUMN "accountId" UUID;

CREATE INDEX IF NOT EXISTS "debt_payments_accountId_date_idx"
  ON "debt_payments" ("accountId", "date");

ALTER TABLE "debt_payments"
  ADD CONSTRAINT "debt_payments_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;
