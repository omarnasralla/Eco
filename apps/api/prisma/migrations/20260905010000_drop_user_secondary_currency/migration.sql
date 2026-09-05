-- Reverts 20260904190000_user_secondary_currency.
--
-- Dropped forward rather than by deleting that migration: it has already been
-- applied here, and removing an applied migration from the directory leaves
-- Prisma holding a record of something it can no longer find. The column's
-- history stays legible — added, then removed — instead of appearing never to
-- have existed while the database disagreed.
--
-- Nothing was ever stored in it. It carried a display preference only, so no
-- amount, rate or aggregate depends on it and this loses no financial data.

ALTER TABLE "users" DROP COLUMN IF EXISTS "secondaryCurrency";
