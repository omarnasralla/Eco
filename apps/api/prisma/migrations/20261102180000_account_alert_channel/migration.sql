-- Which bank's card-less alerts belong to this account.
--
-- Every other alert names a card, and the card says which account it is. One
-- does not: Neo's person-to-person notice reads "DONIA HARB sent you USD
-- 100.00 on 31/10/2026" and carries no account identifier at all. Routed by
-- the usual fallback it would land in the primary account, which is a
-- different bank in a different country.
--
-- So the account declares the channel instead of the message declaring the
-- account. Nullable, because only a bank whose messages lack a card needs one.

ALTER TABLE "financial_accounts"
    ADD COLUMN "alertChannel" VARCHAR(32);

COMMENT ON COLUMN "financial_accounts"."alertChannel" IS
    'Bank alert channel whose card-less messages belong to this account.';
