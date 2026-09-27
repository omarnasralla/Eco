-- Automated expense capture: an iOS Shortcut posts an Apple Pay tap as it
-- happens, so spending is recorded without anyone typing it.
--
-- Three things this needs that did not exist:
--
--   1. A credential the phone can hold. Not a session — a shortcut on a phone
--      is a softer place than a keychain, so this one can append an expense
--      and do nothing else. Only its SHA-256 is stored; the token is shown
--      once, at creation.
--
--   2. Idempotency. A phone on a flaky connection retries, and a retried tap
--      must not become a second expense. `externalRef` is unique per user;
--      Postgres treats NULLs as distinct, so the hand-entered rows, which all
--      have a null ref, do not collide with each other.
--
--   3. A way to say "filed under a guess". A captured tap knows the merchant
--      and the amount but not the category, so the category is inferred from
--      what the user chose for that merchant before. `needsReview` marks the
--      ones nobody has confirmed. It does not hide or discount the row: the
--      money was spent either way, and a captured expense counts in balances,
--      budgets and every total exactly as a typed one does.

CREATE TABLE "ingest_tokens" (
    "id"         UUID         NOT NULL,
    "userId"     UUID         NOT NULL,
    "tokenHash"  CHAR(64)     NOT NULL,
    "label"      VARCHAR(80)  NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"  TIMESTAMP(3),

    CONSTRAINT "ingest_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ingest_tokens_tokenHash_key" ON "ingest_tokens" ("tokenHash");
CREATE INDEX "ingest_tokens_userId_revokedAt_idx" ON "ingest_tokens" ("userId", "revokedAt");

ALTER TABLE "ingest_tokens"
    ADD CONSTRAINT "ingest_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "expenses"
    ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "externalRef" VARCHAR(120);

CREATE INDEX "expenses_userId_needsReview_date_idx"
    ON "expenses" ("userId", "needsReview", "date" DESC);

CREATE UNIQUE INDEX "expenses_userId_externalRef_key"
    ON "expenses" ("userId", "externalRef");
