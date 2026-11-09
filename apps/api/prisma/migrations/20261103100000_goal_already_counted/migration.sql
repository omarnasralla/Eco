-- The part of a goal's balance that is money Eco already counts somewhere
-- else — cash in an account, money lent out.
--
-- A goal created with an amount "already saved" took that amount from
-- nowhere: no account balance went down, so net worth added it on top of the
-- cash and loans it was in fact part of. A $5,100 engagement fund made of cash
-- on hand and money owed raised net worth by $5,100 that did not exist.
--
-- Progress still counts the whole balance — the money is set aside for the
-- goal either way. Only net worth leaves this part out. Contributions paid
-- from an account are unaffected: they lower that account's balance, so the
-- goal is the only place they are counted.
--
-- Zero for existing goals, which keeps their figures exactly as they were.

ALTER TABLE "savings_goals" ADD COLUMN "alreadyCountedMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_already_counted_nonnegative"
    CHECK ("alreadyCountedMinor" >= 0);
