-- One account, several cards.
--
-- Added as a single CHAR(4) an hour ago, which the first real messages
-- disproved: the same urpay balance is spent from a VISA ending 1360, a MADA
-- ending 3367 and the funding card ending 0115. A bank alert names only the
-- card, so an account has to be able to claim all of its own.
--
-- Replaced rather than kept alongside: the column was added today, is not yet
-- read by anything, and holds no data worth migrating.

ALTER TABLE "financial_accounts" DROP COLUMN "cardLast4";
ALTER TABLE "financial_accounts" ADD COLUMN "cardsLast4" TEXT[] NOT NULL DEFAULT '{}';

-- Looking up "which account owns this card" scans the user's few accounts and
-- tests membership, so the useful index is on the array itself.
CREATE INDEX "financial_accounts_cardsLast4_idx"
    ON "financial_accounts" USING GIN ("cardsLast4");
