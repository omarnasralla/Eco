-- A goal contribution is money moving, not money appearing.
--
-- Paying into a goal took cash out of an account and added it to the goal, but
-- only the second half was recorded. Net worth counts cash plus savings, so the
-- same money was counted twice: $2,071.50 held and $964 saved read as $3,035.50
-- of net worth, which is more than the person had.
--
-- Recording which account it came out of makes the movement a transfer, which
-- is what it is: cash falls, savings rise, net worth is unchanged.

ALTER TABLE "goal_contributions" ADD COLUMN "accountId" UUID;

CREATE INDEX IF NOT EXISTS "goal_contributions_accountId_date_idx"
  ON "goal_contributions" ("accountId", "date");

ALTER TABLE "goal_contributions"
  ADD CONSTRAINT "goal_contributions_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON DELETE SET NULL;
