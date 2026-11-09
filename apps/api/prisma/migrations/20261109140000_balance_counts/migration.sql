-- A hand count is a stated balance, not a transaction.
--
-- Reconciling used to book the difference between what was counted and what
-- the ledger held as an expense (or a one-off receipt) in a Reconciliation
-- category. That made the balance right and everything else wrong: the
-- difference was almost never spending. On urpay it was SAR 165.90, and every
-- riyal of it turned out to be capture errors — wallet transfers filed against
-- the wrong account, a reversal that arrived before its charge, a card fee no
-- message stated. Booked as spending it sat in the month's budget, and frozen
-- as a row it never shrank when the real causes were found.
--
-- So a count is now what a bank-stated balance already is: the figure the
-- account is read from. The balance is the latest count plus whatever was
-- recorded after it, and the difference from what the ledger expected is
-- derived — "unaccounted for" — and recomputed as missing movements are found.

CREATE TABLE "balance_counts" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "userId"       UUID         NOT NULL,
    "accountId"    UUID         NOT NULL,
    -- Signed: an account can genuinely be overdrawn.
    "countedMinor" BIGINT       NOT NULL,
    -- The day it was counted, and the moment: a movement recorded later the
    -- same day happened after the count and still has to be applied.
    "countedOn"    DATE         NOT NULL,
    "countedAt"    TIMESTAMP(3) NOT NULL,
    "note"         VARCHAR(500),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_counts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "balance_counts"
    ADD CONSTRAINT "balance_counts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "balance_counts"
    ADD CONSTRAINT "balance_counts_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "balance_counts_accountId_countedAt_idx" ON "balance_counts"("accountId", "countedAt");

ALTER TABLE "balance_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "balance_counts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "balance_counts";
CREATE POLICY tenant_isolation ON "balance_counts"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());

-- Every past count, from the audit trail that recorded exactly what was typed.
-- MATCHED counts are included: they wrote no row, but they were true counts.
INSERT INTO "balance_counts" ("userId", "accountId", "countedMinor", "countedOn", "countedAt", "note")
SELECT l."userId",
       l."entityId",
       (l."changes"->>'actualBalanceMinor')::bigint,
       (l."changes"->>'date')::date,
       l."createdAt",
       NULLIF(l."changes"->>'notes', '')
FROM "audit_logs" l
JOIN "financial_accounts" a ON a."id" = l."entityId" AND a."deletedAt" IS NULL
WHERE l."entityType" = 'FinancialAccount'
  AND l."userId" IS NOT NULL
  AND l."changes" ? 'actualBalanceMinor';

-- The rows those counts used to write. Expenses are soft-deleted, so the
-- history stays readable; the receipts table has no soft delete, and a
-- reconciliation receipt is identified exactly by having no source and the
-- name reconcile gave it.
UPDATE "expenses" e
SET "deletedAt" = now(),
    "notes" = COALESCE(e."notes" || ' — ', '') || 'Replaced by a balance count; the difference is shown as unaccounted for'
FROM "categories" c
WHERE c."id" = e."categoryId"
  AND c."slug" = 'reconciliation'
  AND e."merchant" LIKE 'Reconciled %'
  AND e."deletedAt" IS NULL;

DELETE FROM "income_receipts"
WHERE "incomeSourceId" IS NULL
  AND "name" LIKE 'Reconciled %';
