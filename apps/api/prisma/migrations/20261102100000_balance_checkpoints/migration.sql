-- A balance the bank stated, and the movement it stated it after.
--
-- Deliberately NOT expenses. These alerts come from the account that FUNDS
-- the wallet, and the wallet's own purchase alerts are already recorded. A
-- top-up booked here as well would count the same money twice: once leaving
-- Beirut and again being spent in Riyadh.
--
-- What they are kept for is the balance. Chained in date order, consecutive
-- checkpoints say what a transfer actually cost — the gap between the balance
-- arithmetic predicts and the one the bank reports is a fee nobody ever
-- states, and a positive gap is money that arrived with no message to explain
-- it. Neither is derivable from a single message, which is why the balance is
-- stored rather than read and discarded.
--
-- `statedBalanceMinor` is the balance AFTER the movement, as the bank wrote
-- it. Stored exactly as received and never recomputed: it is evidence, and a
-- derived figure that disagrees with the bank is the finding, not an error to
-- paper over.

CREATE TABLE "balance_checkpoints" (
    "id"                  UUID         NOT NULL,
    "userId"              UUID         NOT NULL,
    -- The account this card belongs to, when one claims it. Nullable: a
    -- funding account the user has not set up yet still produces a usable
    -- chain, keyed on the card alone.
    "accountId"           UUID,
    "cardLast4"           CHAR(4)      NOT NULL,
    "currency"            CHAR(3)      NOT NULL,
    "amountMinor"         BIGINT       NOT NULL,
    -- Signed: negative leaves the account, positive arrives. The alert this
    -- was built for only ever reports money leaving, but a chain that cannot
    -- express a credit would need rewriting the first time one appears.
    "direction"           SMALLINT     NOT NULL DEFAULT -1,
    "statedBalanceMinor"  BIGINT       NOT NULL,
    "merchant"            VARCHAR(160) NOT NULL,
    "occurredOn"          DATE         NOT NULL,
    -- Same idempotency key as a captured expense: the message, hashed.
    "externalRef"         VARCHAR(120),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_checkpoints_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "balance_checkpoints"
    ADD CONSTRAINT "balance_checkpoints_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "balance_checkpoints"
    ADD CONSTRAINT "balance_checkpoints_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- A message forwarded twice is one checkpoint, not two — the same rule the
-- captured expenses use, and the reason a duplicate cannot invent a fee.
CREATE UNIQUE INDEX "balance_checkpoints_userId_externalRef_key"
    ON "balance_checkpoints"("userId", "externalRef");

-- The chain is always read per card, in the order the movements happened.
CREATE INDEX "balance_checkpoints_userId_cardLast4_occurredOn_idx"
    ON "balance_checkpoints"("userId", "cardLast4", "occurredOn", "createdAt");

-- Same shape as every other tenant table (infra/postgres/rls.sql), applied
-- here as well so a fresh database is protected the moment the table exists
-- rather than whenever that script is next run by hand.
ALTER TABLE "balance_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "balance_checkpoints" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "balance_checkpoints";
CREATE POLICY tenant_isolation ON "balance_checkpoints"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());
