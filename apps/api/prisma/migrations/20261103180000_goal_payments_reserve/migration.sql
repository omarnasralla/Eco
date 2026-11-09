-- Paying into a goal from an account reserves the money; it does not move it.
--
-- The balance used to be reduced by every contribution assigned to it, so an
-- account that funded a goal read lower than the bank said it was. But nothing
-- left: the money is still in the account, reachable, simply spoken for. The
-- account now reports its whole balance alongside the reserved part, and what
-- is free to spend is the difference.
--
-- Net worth must not count that money twice, and `alreadyCountedMinor` is
-- where a goal records the part of its balance some other total already
-- reports. Every contribution made from an account belongs in it. Capped at
-- the goal's balance, because a goal cannot have more counted elsewhere than
-- it holds -- withdrawals can leave it with less than was paid in.
--
-- Contributions made from no account are left out: that money is not in any
-- balance Eco knows, so the goal is the only place it is counted.

UPDATE "savings_goals" g
SET "alreadyCountedMinor" = LEAST(
      g."currentAmountMinor",
      g."alreadyCountedMinor" + GREATEST(0, funded.total)
    )
FROM (
  SELECT "goalId", SUM("goalAmountMinor")::bigint AS total
  FROM "goal_contributions"
  WHERE "accountId" IS NOT NULL
  GROUP BY "goalId"
) AS funded
WHERE funded."goalId" = g.id
  AND g."deletedAt" IS NULL;
