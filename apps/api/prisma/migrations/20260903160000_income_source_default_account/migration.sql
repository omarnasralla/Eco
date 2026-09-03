-- The account an income source is paid into by default.
--
-- A receipt could already name the account the money landed in, but every
-- recording started from "whichever account is primary" and had to be
-- re-picked for anything else — a salary paid into one account and rent
-- collected into another meant getting it right by hand, every time, with a
-- silently wrong balance on both sides whenever it was missed.
--
-- A source carries a frequency, so it is a recurring arrival by construction:
-- naming the account once is enough. recordReceipt falls back to this whenever
-- a receipt does not name its own account.
--
-- Nullable and not backfilled: a source that predates this, or income that
-- lands somewhere untracked, has nowhere honest to point.

ALTER TABLE "income_sources" ADD COLUMN "accountId" UUID;

CREATE INDEX IF NOT EXISTS "income_sources_accountId_idx"
  ON "income_sources" ("accountId");

ALTER TABLE "income_sources"
  ADD CONSTRAINT "income_sources_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;
