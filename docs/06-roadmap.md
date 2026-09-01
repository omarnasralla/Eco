# Roadmap, MVP scope and scaling

## What exists today

Verified running, not aspirational:

- **`@eco/shared`** — types, enums, Zod schemas, currency table
- **`@eco/core`** — all financial logic, **128 unit tests**
- **`apps/api`** — NestJS, **94 routes**, Postgres + Redis, RLS applied
- **`apps/web`** — Next.js, **14 routes**, mobile-first, light and dark
- **`services/ai`** — FastAPI, **44 tests**, forecasting + local LLM
- **Infrastructure** — three Dockerfiles, compose stack, Kubernetes manifests

Confirmed end to end against the demo account: sign-in, dashboard, expense
entry, debt payoff comparison, budget evaluation, pattern detection over 24
months, forecasting via the Python service, and AI chat answering from real
ledger data through a locally-hosted Llama 3.2.

## MVP scope

The smallest product someone could genuinely rely on. Everything here is built.

**In:** email/password auth with 2FA · income tracking with correct cadence
normalisation · expenses with 12 seeded categories and custom ones · debts with
snowball/avalanche comparison · savings goals with projection · monthly budgets
with alerts and rollover · dashboard with five chart types · multi-currency
with historical rates · pattern detection · forecasting with prediction
intervals · deterministic recommendations · AI chat · PDF/Excel/CSV export ·
in-app and email notifications · GDPR export and erasure.

**Deliberately out:** bank connections, investment tracking, shared accounts,
OCR receipts, credit scores, tax reporting, a native app.

Each was excluded for a reason, not for lack of time. Bank aggregation is a
regulated integration with a long compliance tail. Investment tracking needs
market data and a cost-basis model. Shared accounts change the permission model
from "one owner" to "roles per resource" — which is why `FinancialAccount`
exists and is not yet surfaced.

## Phases

### Phase 1 — Foundation ✅ *complete*
Monorepo, shared logic, database with RLS, auth with rotation and 2FA, all
financial CRUD, dashboard, budgets, multi-currency.

### Phase 2 — Intelligence ✅ *complete*
Pattern detection, Holt-Winters forecasting with a graceful local fallback,
deterministic recommendations with evidence, financial health score, grounded
LLM chat, reports.

### Phase 3 — Mobile and hardening *(next, ~8 weeks)*

| Item | Notes |
|---|---|
| React Native app | Reuses `@eco/shared` and `@eco/core` verbatim; only presentation is new |
| Push notifications | `PushToken` table and the dispatch seam already exist |
| **LLM tool-calling** | Wire `affordabilityCheck` so the model reads rather than computes — see the limitation in [04-ai-architecture](04-ai-architecture.md) |
| httpOnly refresh cookies | The API already accepts them; make it the web default |
| Apple & Microsoft OAuth | Google is implemented; the strategy shape is shared |
| Real income volatility | Switch from run rate to `IncomeReceipt` actuals once history accumulates |
| E2E suite | Playwright is already wired for the screenshot harness |

### Phase 4 — Connected data *(~12 weeks)*

Open Banking via Plaid/TrueLayer/Tink. `FinancialAccount` already carries
`providerId`, `externalId` and `lastSyncedAt` for exactly this. Transaction
import feeds the existing `Expense` table, so pattern detection and forecasting
work on connected data with no changes.

Then: OCR receipts (`Expense.receiptUrl` reserved), subscription management
built on the existing recurring detection, and investment tracking.

### Phase 5 — Multi-user and scale *(~12 weeks)*

Shared budgets and family accounts. This is the one phase that changes the data
model meaningfully: ownership moves from `userId` to a household with roles,
and the RLS policies change from `userId = current_app_user_id()` to a
membership check. Doing it now would have complicated every query for a feature
no MVP user needs.

Also: credit-score monitoring, voice input, a coaching layer over the existing
recommendation engine.

## Scaling to 1M+ users

### What the numbers actually look like

A million users is not a large database. Assume 60 transactions/user/month:

| | Volume |
|---|---|
| Expense rows/year | ~720M |
| Storage (expenses, with indexes) | ~200GB |
| Peak API requests | ~2,000 rps |
| Nightly insight jobs | 1M, over 6 hours ≈ 46/s |

That is a single well-indexed Postgres instance with read replicas — not a
distributed system. The instinct to shard early is the expensive mistake here.

### Order of operations

**1. Vertical first.** A `db.r6g.4xlarge` (16 vCPU, 128GB) with 200GB of
working set serves this comfortably. Exhaust it before adding complexity.

**2. Read replicas.** Dashboards, reports, forecasting and the AI service are
read-only. `eco_readonly` already exists in `rls.sql`. Route those to replicas
and the primary handles only writes.

**3. Connection pooling.** PgBouncer in transaction mode. 30 API pods × a pool
of 10 is 300 connections against a server configured for ~200. Pooling is
mandatory well before sharding is.

**4. Partition `expenses` by month.** `RANGE` partitioning on `date` once the
table passes ~100M rows. Every query already filters by date, so partition
pruning is immediate, and dropping old partitions becomes a metadata operation
rather than a mass delete.

**5. Only then, shard by `userId`.** The schema is already shard-ready: every
query carries `userId`, and there are no cross-user joins anywhere. This is a
routing change, not a rewrite — but it is a genuine operational burden and
should be the last resort.

### Application tier

Stateless by construction: sessions are JWTs, cache is external, no local disk
beyond `/tmp`. The API HPA runs 3–30 pods on CPU and memory.

Redis moves to a managed cluster with `allkeys-lru` eviction. Key namespacing
(`eco:<userId>:*`) is already shard-friendly. Note that `SCAN`-based
invalidation gets more expensive in a cluster; per-user hash tags would make it
a single-slot operation.

### The AI tier is the real cost

Inference is the expensive part, and the mitigations are already in place:

- **Forecasts cached 6 hours** — financial data does not change minute to
  minute.
- **Patterns cached 6 hours**, persisted in `spending_patterns`.
- **Recommendations regenerate nightly**, not per request, and only for users
  active in the last 30 days.
- **Chat rate-limited to 20/minute** per user.

At a million users, expect maybe 5% daily chat engagement — 50,000
conversations, a handful of turns each. On GPU nodes at ~2s per answer that is
a modest inference fleet. The queue-plus-worker split (Redis-backed, workers
consuming) is the phase-4 shape; the synchronous path is correct at current
scale and simpler to operate.

### Cost control

The nightly insight job is the largest recurring compute. It is already bounded
to recently-active users, already holds a distributed lock so replicas do not
duplicate work, and already isolates per-user failures so one corrupt account
cannot stop the batch.

### What would need rethinking

Honest limits of the current design:

- **Reports are generated synchronously.** Fine for one user-year of data;
  a multi-year export for a heavy user should move to a queue with a signed
  download URL. The `Report` table already models `status` and `storageKey` for
  that.
- **`SCAN`-based cache invalidation** degrades on a large clustered keyspace.
- **The nightly job is a single sweep.** Past a few million users it wants
  sharding by user-id range across workers.
- **No read/write split in the ORM yet.** Prisma supports it; the routing has
  not been added because there is no replica to route to.
