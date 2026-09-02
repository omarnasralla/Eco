-- A goal contribution can now be entered in a currency other than the goal's.
-- "amountMinor" keeps what the user typed; "goalAmountMinor" is that amount
-- converted into the goal's currency at the contribution date's rate, frozen on
-- the row so the balance never restates when a rate moves.

ALTER TABLE "goal_contributions" ADD COLUMN "currency" CHAR(3);
ALTER TABLE "goal_contributions" ADD COLUMN "goalAmountMinor" BIGINT;

-- Every existing contribution was, by construction, in its goal's currency and
-- was added to the balance unconverted. The backfill says exactly that.
UPDATE "goal_contributions" c
SET "currency" = g."currency",
    "goalAmountMinor" = c."amountMinor"
FROM "savings_goals" g
WHERE g."id" = c."goalId";

-- Defensive: a contribution whose goal has been hard-deleted cannot be joined.
UPDATE "goal_contributions"
SET "currency" = 'USD', "goalAmountMinor" = "amountMinor"
WHERE "currency" IS NULL;

ALTER TABLE "goal_contributions" ALTER COLUMN "currency" SET NOT NULL;
ALTER TABLE "goal_contributions" ALTER COLUMN "goalAmountMinor" SET NOT NULL;
