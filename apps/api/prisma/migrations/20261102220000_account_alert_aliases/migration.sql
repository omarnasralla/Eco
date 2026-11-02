-- Merchant strings that mean "money moved into this account".
--
-- A bank writes the destination into the merchant field of its alert, but it
-- writes the bank's own name for it, not the user's: a counter withdrawal at
-- IBL Ashrafieh reads "IBL ASHRAFIEHASHRAFIEHLB", which is cash arriving in
-- the user's pocket and looks like a purchase at a shop called IBL.
--
-- Matching on the account NAME already covers the easy case — "URPAYRIYADH SA"
-- contains "urpay" — but a cash account cannot be named after every bank
-- branch the user might stand in. So an account may also list the strings its
-- inflows arrive under.
--
-- Deliberately NOT one shared list of "cash merchants": the alias belongs to
-- the account the money lands in, so adding a second cash account or a second
-- bank needs no change anywhere else.

ALTER TABLE "financial_accounts"
    ADD COLUMN "alertAliases" TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "financial_accounts"."alertAliases" IS
    'Merchant substrings in a bank alert that mean money moved into this account.';
