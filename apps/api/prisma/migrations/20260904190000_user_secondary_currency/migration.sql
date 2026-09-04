-- The other currency a person thinks in.
--
-- `currency` is the base: the unit every stored aggregate is denominated in,
-- and changing it rewrites history at each transaction's own rate. This is not
-- that. It is a display preference — the currency someone actually hands over
-- at a till, which for anyone living outside their reporting currency is not
-- the one their totals are kept in.
--
-- Nothing is stored in it and nothing is converted on write. It exists so the
-- UI can offer both and flip between them, and so that choice survives a new
-- device, which a browser preference cannot.

ALTER TABLE "users" ADD COLUMN "secondaryCurrency" CHAR(3);
