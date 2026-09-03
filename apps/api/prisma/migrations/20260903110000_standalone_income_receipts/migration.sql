-- A payment that arrived once needs somewhere to live.
--
-- Until now every receipt hung off an income source, so recording a one-off
-- meant inventing a permanent schedule for something that happened once. That
-- schedule then contributes nothing to the run rate (correctly — a one-off is
-- not a rate) and moves no balance, so the money landed nowhere at all.
--
-- A receipt may now stand alone, carrying its own name.

ALTER TABLE "income_receipts" ALTER COLUMN "incomeSourceId" DROP NOT NULL;
ALTER TABLE "income_receipts" ADD COLUMN "name" VARCHAR(120);

-- Existing receipts all have a source and take their name from it. There are
-- none at the time of writing, but the backfill states the rule rather than
-- relying on the table being empty.
UPDATE "income_receipts" r
SET "name" = s."name"
FROM "income_sources" s
WHERE s."id" = r."incomeSourceId" AND r."name" IS NULL;
