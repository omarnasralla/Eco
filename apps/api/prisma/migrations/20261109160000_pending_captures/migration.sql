-- Messages that describe money but cannot be booked the moment they arrive.
--
-- Two kinds, both learned from urpay's statement:
--
--   PURCHASE — a 3-D Secure verification code. It names an amount and a
--              merchant before the payment completes, and was ignored on the
--              assumption that a purchase alert always follows. For some
--              merchants none ever does: two WHISH MONEY payments were lost
--              that way. Held for a few minutes; if no purchase alert claims
--              it, the code itself is recorded as the purchase.
--
--   REVERSAL — a reversal that arrived before the charge it cancels. It was
--              refused as matching nothing, and the charge was then recorded
--              when it did arrive, 34 minutes later, and never cancelled. Held
--              for a day; the charge is cancelled on arrival.

CREATE TABLE "pending_captures" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "userId"      UUID         NOT NULL,
    "accountId"   UUID,
    "kind"        VARCHAR(16)  NOT NULL,
    "amountMinor" BIGINT       NOT NULL,
    "currency"    CHAR(3)      NOT NULL,
    "merchant"    VARCHAR(160) NOT NULL,
    "occurredOn"  DATE         NOT NULL,
    -- The message's own key, so a code forwarded twice is held once.
    "externalRef" VARCHAR(120) NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "resolvedAt"  TIMESTAMP(3),
    -- MATCHED (an alert claimed it), RECORDED (it became the expense),
    -- CANCELLED (a reversal cancelled the charge), EXPIRED (nothing came).
    "resolution"  VARCHAR(16),
    "expenseId"   UUID,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_captures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_captures_kind" CHECK ("kind" IN ('PURCHASE', 'REVERSAL'))
);

ALTER TABLE "pending_captures"
    ADD CONSTRAINT "pending_captures_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "pending_captures"
    ADD CONSTRAINT "pending_captures_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "financial_accounts"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE UNIQUE INDEX "pending_captures_userId_externalRef_key" ON "pending_captures"("userId", "externalRef");
CREATE INDEX "pending_captures_userId_kind_resolvedAt_idx" ON "pending_captures"("userId", "kind", "resolvedAt");
CREATE INDEX "pending_captures_resolvedAt_expiresAt_idx" ON "pending_captures"("resolvedAt", "expiresAt");

ALTER TABLE "pending_captures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_captures" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pending_captures";
CREATE POLICY tenant_isolation ON "pending_captures"
    USING ("userId" = current_app_user_id())
    WITH CHECK ("userId" = current_app_user_id());
