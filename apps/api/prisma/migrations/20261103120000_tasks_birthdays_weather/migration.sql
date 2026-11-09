-- Three inputs to the morning briefing that are not money: what to do today,
-- whose birthday is coming, and what the weather will be.

-- Things to do. A due date is optional — "call the bank" has no deadline but
-- still belongs on the list — and completion is a timestamp, so a finished
-- task records when and the list can show what was done this week.
CREATE TABLE "tasks" (
    "id"        UUID         NOT NULL,
    "userId"    UUID         NOT NULL,
    "title"     VARCHAR(200) NOT NULL,
    "dueOn"     DATE,
    "doneAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- A birthday is a month and a day, not a date: it recurs, and the year is
-- often unknown. When the year is known it says how old they turn.
CREATE TABLE "birthdays" (
    "id"        UUID         NOT NULL,
    "userId"    UUID         NOT NULL,
    "name"      VARCHAR(120) NOT NULL,
    "month"     SMALLINT     NOT NULL,
    "day"       SMALLINT     NOT NULL,
    "year"      SMALLINT,
    -- Gift ideas, mostly. Worth having to hand the morning it comes up.
    "note"      VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "birthdays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "birthdays_month_range" CHECK ("month" BETWEEN 1 AND 12),
    CONSTRAINT "birthdays_day_range" CHECK ("day" BETWEEN 1 AND 31),
    CONSTRAINT "birthdays_year_range" CHECK ("year" IS NULL OR "year" BETWEEN 1900 AND 2100)
);

ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "birthdays"
    ADD CONSTRAINT "birthdays_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "tasks_userId_doneAt_dueOn_idx" ON "tasks"("userId", "doneAt", "dueOn");
CREATE INDEX "birthdays_userId_month_day_idx" ON "birthdays"("userId", "month", "day");

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tasks";
CREATE POLICY tenant_isolation ON "tasks"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());

ALTER TABLE "birthdays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "birthdays" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "birthdays";
CREATE POLICY tenant_isolation ON "birthdays"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());

-- Where the weather is for: a city the user picked, never the device's
-- location. Coordinates are what the forecast provider takes; the name is
-- what the user recognises.
ALTER TABLE "users"
    ADD COLUMN "weatherPlace" VARCHAR(160),
    ADD COLUMN "weatherLat"   DOUBLE PRECISION,
    ADD COLUMN "weatherLon"   DOUBLE PRECISION;
