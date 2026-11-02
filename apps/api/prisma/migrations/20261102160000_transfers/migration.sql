-- Money moved between two accounts the same person owns.
--
-- Not an expense and not income, which is the whole reason this table exists.
-- Topping up a wallet from a bank account spends nothing and earns nothing —
-- booking it as either would inflate a month's spending or a month's income by
-- the size of the float, and the urpay top-ups alone would have added about a
-- thousand dollars a month to both.
--
-- Two amounts, not one. A top-up leaves the Lebanese account in dollars and
-- arrives in the Saudi wallet as riyals, and the bank states each side in its
-- own message: the IBL alert gives the dollars debited, the urpay alert gives
-- the riyals credited. Storing both means neither side is ever a guess, and
-- the difference between them is the real cost of the conversion. When only
-- one side has been seen the other is converted, and `receivedMinor` stays
-- NULL so it is clear which figure was measured and which was derived.

CREATE TABLE "transfers" (
    "id"                 UUID         NOT NULL,
    "userId"             UUID         NOT NULL,
    -- Nullable on either side: a transfer out of an account that is not set up
    -- yet still has to reduce the one it left.
    "fromAccountId"      UUID,
    "toAccountId"        UUID,
    -- What left the source, in the source's terms.
    "amountMinor"        BIGINT       NOT NULL,
    "currency"           CHAR(3)      NOT NULL,
    -- What arrived, when a message stated it. NULL means nobody said.
    "receivedMinor"      BIGINT,
    "receivedCurrency"   CHAR(3),
    "note"               VARCHAR(160),
    "occurredOn"         DATE         NOT NULL,
    -- The message that produced it, hashed — same idempotency rule as a
    -- captured expense, so a forwarded SMS cannot move the money twice.
    "externalRef"        VARCHAR(120),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    "deletedAt"          TIMESTAMP(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id"),
    -- A transfer from an account to itself moves nothing and would subtract
    -- and add the same figure, so the balance would be right by accident.
    CONSTRAINT "transfers_distinct_sides" CHECK (
        "fromAccountId" IS DISTINCT FROM "toAccountId"
    ),
    -- One side may be unknown; both may not.
    CONSTRAINT "transfers_has_a_side" CHECK (
        "fromAccountId" IS NOT NULL OR "toAccountId" IS NOT NULL
    )
);

ALTER TABLE "transfers"
    ADD CONSTRAINT "transfers_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "transfers"
    ADD CONSTRAINT "transfers_fromAccountId_fkey"
    FOREIGN KEY ("fromAccountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "transfers"
    ADD CONSTRAINT "transfers_toAccountId_fkey"
    FOREIGN KEY ("toAccountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE UNIQUE INDEX "transfers_userId_externalRef_key"
    ON "transfers"("userId", "externalRef");
-- Balances read every transfer touching an account from a date onward, and
-- each side is queried separately.
CREATE INDEX "transfers_fromAccountId_occurredOn_idx"
    ON "transfers"("fromAccountId", "occurredOn");
CREATE INDEX "transfers_toAccountId_occurredOn_idx"
    ON "transfers"("toAccountId", "occurredOn");

ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "transfers";
CREATE POLICY tenant_isolation ON "transfers"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());
