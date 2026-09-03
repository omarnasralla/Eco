-- The expense list now defaults to creation order, so that is the ordering the
-- workhorse query sorts by. The existing index covers (userId, date) and does
-- nothing for it, leaving every page load to sort the user's whole history.
CREATE INDEX IF NOT EXISTS "expenses_userId_createdAt_deletedAt_idx"
  ON "expenses" ("userId", "createdAt" DESC, "deletedAt");

-- Merchant suggestions are looked up per category, most-used first.
CREATE INDEX IF NOT EXISTS "expenses_userId_categoryId_merchant_idx"
  ON "expenses" ("userId", "categoryId", "merchant");
