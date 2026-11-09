-- Two features that change behaviour rather than record it.
--
-- 1. Wants: things the user is tempted to buy, held for a cooling-off period
--    before they can be bought. Not a planned purchase — that table records a
--    decision already made, and this one exists to delay the decision. Nothing
--    here moves a balance; a want that is bought is captured as an expense by
--    the same alerts as any other purchase.
--
-- 2. A morning briefing: one push a day, at a local time the user picks,
--    summarising what is spendable and what is due. Opt-in, because a daily
--    message nobody asked for is how notifications learn to be ignored.
--
-- Plus the one input that turns a price into work time: the hours a person
-- works in a week. Null means the feature is off — there is no honest default
-- for how long someone works.

CREATE TABLE "wants" (
    "id"              UUID         NOT NULL,
    "userId"          UUID         NOT NULL,
    "name"            VARCHAR(160) NOT NULL,
    "amountMinor"     BIGINT       NOT NULL,
    "currency"        CHAR(3)      NOT NULL,
    "url"             VARCHAR(500),
    "note"            VARCHAR(300),
    -- How long it waits. Stored with the row so changing the default later
    -- does not move a deadline the user has already been told.
    "coolOffHours"    SMALLINT     NOT NULL DEFAULT 48,
    "readyAt"         TIMESTAMP(3) NOT NULL,
    -- Set once the "time is up" push has gone, so it goes exactly once.
    "readyNotifiedAt" TIMESTAMP(3),
    -- Decided, one way or the other. Timestamps rather than a status so the
    -- row records when, and the status is derived.
    "boughtAt"        TIMESTAMP(3),
    "skippedAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wants_amount_positive" CHECK ("amountMinor" > 0),
    CONSTRAINT "wants_cool_off_range" CHECK ("coolOffHours" BETWEEN 1 AND 720),
    CONSTRAINT "wants_one_decision" CHECK ("boughtAt" IS NULL OR "skippedAt" IS NULL)
);

ALTER TABLE "wants"
    ADD CONSTRAINT "wants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "wants_userId_createdAt_idx" ON "wants"("userId", "createdAt" DESC);
-- The ready sweep: undecided rows whose time has come and who have not been told.
CREATE INDEX "wants_readyAt_readyNotifiedAt_idx" ON "wants"("readyAt", "readyNotifiedAt");

ALTER TABLE "wants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "wants";
CREATE POLICY tenant_isolation ON "wants"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());

ALTER TABLE "users" ADD COLUMN "workHoursPerWeek" SMALLINT;
ALTER TABLE "users" ADD CONSTRAINT "users_work_hours_range"
    CHECK ("workHoursPerWeek" IS NULL OR "workHoursPerWeek" BETWEEN 1 AND 100);

ALTER TABLE "notification_preferences"
    ADD COLUMN "dailyBriefing" BOOLEAN    NOT NULL DEFAULT false,
    ADD COLUMN "briefingTime"  VARCHAR(5) NOT NULL DEFAULT '07:30';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DAILY_BRIEFING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WANT_READY';
