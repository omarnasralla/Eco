-- ═══════════════════════════════════════════════════════════════════════════
--  Row-Level Security — defence in depth for tenant isolation
--
--  The API already filters every query by userId.  These policies exist for
--  the day someone forgets: a missing `where: { userId }` becomes an empty
--  result set instead of a cross-account data leak.
--
--  Apply AFTER `prisma migrate deploy`:
--      psql "$DATABASE_URL" -f infra/postgres/rls.sql
--
--  The application connects as `eco_app`, which is NOT the table owner and has
--  no BYPASSRLS.  Prisma sets the tenant on each checked-out connection:
--      SELECT set_config('app.current_user_id', $1, true);
--  `true` scopes it to the transaction, so a pooled connection cannot carry
--  one user's identity into another user's request.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Roles ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eco_app') THEN
    CREATE ROLE eco_app LOGIN PASSWORD 'set_me_from_secret_manager';
  END IF;
  -- Read-only role for analytics, BI tools and the Python service's
  -- feature queries. It can never mutate financial records.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eco_readonly') THEN
    CREATE ROLE eco_readonly LOGIN PASSWORD 'set_me_from_secret_manager';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO eco_app, eco_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eco_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO eco_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eco_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eco_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO eco_readonly;

-- The audit log is append-only. Even the application role cannot rewrite
-- history; that is the entire point of keeping one.
REVOKE UPDATE, DELETE ON audit_logs FROM eco_app;
REVOKE UPDATE, DELETE ON audit_logs FROM eco_readonly;

-- ─── Helper ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  -- `true` in current_setting() means "return NULL if unset" rather than
  -- raising, so an unauthenticated connection simply sees nothing.
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- ─── Policies ─────────────────────────────────────────────────────────────

-- Tables owning a direct `userId` column.
DO $$
DECLARE
  t text;
  direct_tables text[] := ARRAY[
    'income_sources', 'income_receipts', 'categories', 'expenses',
    'debts', 'debt_payments', 'payoff_plans', 'savings_goals',
    'goal_contributions', 'budgets', 'financial_accounts',
    'notifications', 'notification_preferences', 'push_tokens',
    'reports', 'recommendations', 'ai_conversations',
    'spending_patterns', 'forecast_snapshots', 'refresh_tokens',
    'verification_tokens', 'oauth_accounts'
  ];
BEGIN
  FOREACH t IN ARRAY direct_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("userId" = current_app_user_id())
        WITH CHECK ("userId" = current_app_user_id())
    $f$, t);
  END LOOP;
END
$$;

-- Users may only ever see their own row.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (id = current_app_user_id())
  WITH CHECK (id = current_app_user_id());

-- Child tables reached through a parent's ownership.
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_lines;
CREATE POLICY tenant_isolation ON budget_lines
  USING (EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.id = budget_lines."budgetId" AND b."userId" = current_app_user_id()
  ));

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_messages;
CREATE POLICY tenant_isolation ON ai_messages
  USING (EXISTS (
    SELECT 1 FROM ai_conversations c
    WHERE c.id = ai_messages."conversationId" AND c."userId" = current_app_user_id()
  ));

-- Audit logs: insertable by anyone authenticated, readable only for your own
-- account.  Compliance staff read them through a separate BYPASSRLS role.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_insert ON audit_logs;
DROP POLICY IF EXISTS audit_select_own ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY audit_select_own ON audit_logs FOR SELECT
  USING ("userId" = current_app_user_id());

-- Exchange rates are reference data, identical for every tenant.
GRANT SELECT ON exchange_rates TO eco_app, eco_readonly;

-- ─── Verification ─────────────────────────────────────────────────────────
-- Lists any table still missing a policy. Should return zero rows.
--
--   SELECT c.relname
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relkind = 'r'
--     AND c.relname NOT IN ('_prisma_migrations', 'exchange_rates')
--     AND NOT c.relrowsecurity;
