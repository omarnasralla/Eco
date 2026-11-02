-- Money lent to a person, and what has come back.
--
-- The mirror of `debts`, which is money owed BY the user. Neither table can
-- stand in for the other: a debt reduces net worth and a receivable raises it,
-- and recording a loan out as a negative debt would make every total that
-- reads `debts` wrong.
--
-- Not an expense either, which is the mistake this exists to prevent. The
-- 2,400 withdrawn at IBL was not 2,400 spent — 2,000 of it was lent, and that
-- 2,000 is still the user's money, merely in someone else's hands. Filing it
-- as spending would have thrown away an asset and overstated a month's
-- expenses by the same amount.
--
-- Deliberately WITHOUT interest, a schedule or a due day. These are loans
-- between friends: there is a person, an amount, and whatever comes back when
-- it comes back. Inventing an APR and a minimum payment for them would ask
-- questions nobody can answer and make the screen useless for its purpose.

CREATE TABLE "receivables" (
    "id"             UUID         NOT NULL,
    "userId"         UUID         NOT NULL,
    -- Who owes it. A name, not a contact record: the person is identified by
    -- what the user calls them, the same way a merchant is.
    "person"         VARCHAR(120) NOT NULL,
    "principalMinor" BIGINT       NOT NULL,
    "currency"       CHAR(3)      NOT NULL,
    "lentOn"         DATE         NOT NULL,
    -- Which account the money left, when it is known.
    "accountId"      UUID,
    "note"           VARCHAR(300),
    -- Set when the user calls it done, whether or not it was repaid in full:
    -- a loan written off is settled, and leaving it outstanding for ever would
    -- quietly inflate net worth.
    "settledAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "deletedAt"      TIMESTAMP(3),

    CONSTRAINT "receivables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "receivables_principal_positive" CHECK ("principalMinor" > 0)
);

-- What has come back. Separate rows rather than a running balance, so the
-- outstanding figure is derived and an edited or deleted repayment moves it by
-- exactly what it moved it by — the same reason account balances are computed
-- rather than stored.
CREATE TABLE "receivable_payments" (
    "id"            UUID         NOT NULL,
    "userId"        UUID         NOT NULL,
    "receivableId"  UUID         NOT NULL,
    "amountMinor"   BIGINT       NOT NULL,
    "currency"      CHAR(3)      NOT NULL,
    "date"          DATE         NOT NULL,
    -- Where it landed, so the account balance can account for it.
    "accountId"     UUID,
    "note"          VARCHAR(300),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "receivable_payments_amount_positive" CHECK ("amountMinor" > 0)
);

ALTER TABLE "receivables"
    ADD CONSTRAINT "receivables_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "receivables"
    ADD CONSTRAINT "receivables_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "receivable_payments"
    ADD CONSTRAINT "receivable_payments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "receivable_payments"
    ADD CONSTRAINT "receivable_payments_receivableId_fkey"
    FOREIGN KEY ("receivableId") REFERENCES "receivables"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "receivable_payments"
    ADD CONSTRAINT "receivable_payments_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX "receivables_userId_settledAt_deletedAt_idx"
    ON "receivables"("userId", "settledAt", "deletedAt");
CREATE INDEX "receivable_payments_receivableId_date_idx"
    ON "receivable_payments"("receivableId", "date");
CREATE INDEX "receivable_payments_accountId_date_idx"
    ON "receivable_payments"("accountId", "date");

ALTER TABLE "receivables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receivables" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "receivables";
CREATE POLICY tenant_isolation ON "receivables"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());

ALTER TABLE "receivable_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receivable_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "receivable_payments";
CREATE POLICY tenant_isolation ON "receivable_payments"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());
