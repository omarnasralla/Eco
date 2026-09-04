-- Money that was genuinely spent, but which no budget was ever meant to cover.
--
-- A budget answers "am I pacing my discretionary spending?". Some outgoings
-- are real and belong in your balances and net worth, yet answer a different
-- question entirely: a savings transfer that turned out to be spent, a
-- reimbursable expense, a one-off that was never part of the plan. Counting
-- them silently reports the month as blown and drives every daily allowance to
-- zero, which teaches the user to distrust the budget rather than act on it.
--
-- Excluded, not hidden: the amount is still summed and reported back so the
-- exclusion is visible. A budget that quietly drops spending is worse than one
-- that overstates it.
--
-- Defaults to false and is not backfilled. Every expense recorded before this
-- existed was counted against its budget, and silently retiring some of them
-- would restate months the user has already read.

ALTER TABLE "expenses"
  ADD COLUMN "excludedFromBudget" BOOLEAN NOT NULL DEFAULT false;

-- The budget query filters on this alongside the date range it already scans.
CREATE INDEX IF NOT EXISTS "expenses_userId_excludedFromBudget_date_idx"
  ON "expenses" ("userId", "excludedFromBudget", "date");
