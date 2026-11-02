-- The card whose bank-stated balance this account's balance is read from.
--
-- Without it an account's balance is opening + every movement since, which is
-- only ever as right as the movements are complete. One missed capture and it
-- is wrong forever, drifting further with each month. Main was $1,414.08 below
-- what the bank actually held.
--
-- With it, the bank's own figure is the starting point and only movements
-- recorded AFTER that message are applied. Every new balance alert re-anchors,
-- so the balance cannot drift for longer than the gap between two messages —
-- it snaps back to the truth each time one arrives, instead of accumulating
-- error forever.
--
-- Opt-in per account, and nullable: most accounts have no bank that texts a
-- balance, and those keep the computed figure. Deliberately NOT inferred from
-- `cardsLast4`, even though the link could be guessed from it — an account
-- holding several cards would have its balance silently decided by whichever
-- of them texted last.
--
-- No foreign key: a card is four digits on an account, not a row.

ALTER TABLE "financial_accounts"
    ADD COLUMN "balanceCardLast4" CHAR(4);

COMMENT ON COLUMN "financial_accounts"."balanceCardLast4" IS
    'Card whose stated balance anchors this account; NULL = compute from movements.';
