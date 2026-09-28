-- The last four digits of the card an account is spent from.
--
-- Bank SMS alerts identify the card and nothing else: "Your card ending with
-- 0363 is approved for...". Matching those to an account by name cannot work —
-- the message never carries a name — so the digits are the join key.
--
-- Four characters, nullable, and not unique: an account may have no card, and
-- two cards can share a last four. The lookup treats an ambiguous match as no
-- match rather than guessing which account was charged.

ALTER TABLE "financial_accounts" ADD COLUMN "cardLast4" CHAR(4);

CREATE INDEX "financial_accounts_userId_cardLast4_idx"
    ON "financial_accounts" ("userId", "cardLast4");
