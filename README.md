<div align="center">

# Eco

**An intelligent personal finance ecosystem.**

Track income, expenses, debts and goals — with an AI that learns your spending
patterns and never invents a number.

</div>

---

## What this is

A production-shaped SaaS application, built and verified end to end: a Next.js
web client, a NestJS API over PostgreSQL and Redis, a Python forecasting
service, and a locally-hosted LLM. Financial logic lives in a framework-free
TypeScript package that the web app, the API and (in phase 3) React Native all
share verbatim.

| | |
|---|---|
| **Domain tests** | 149 in `@eco/core`, 44 in the AI service — all passing |
| **API** | 94 routes, tenant isolation enforced twice |
| **Web** | 14 routes, mobile-first, light and dark |
| **Database** | 28 tables, row-level security on every tenant table |
| **AI** | Deterministic recommendations + grounded local LLM |

## Quick start

```bash
cp .env.example .env

# The API refuses to boot on placeholder secrets — generate real ones.
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env

docker compose up -d
docker compose exec api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
docker compose exec api npm run prisma:seed --workspace @eco/api
docker compose exec ollama ollama pull llama3.2:3b   # optional; chat needs it
```

| | |
|---|---|
| Web | http://localhost:3000 |
| API + docs | http://localhost:9000/eco/api/v1 · `/docs` |
| AI service | http://localhost:8000/docs |
| Mail catcher | http://localhost:8025 |

**Demo account:** `demo@eco.app` / `demo-password-2026` — 24 months of
generated history with real structure: a salary, five subscriptions on fixed
cadences, weekend-skewed discretionary spending, a December peak, three debts
with a year of payments, and three savings goals.

## The idea that shapes the codebase

> **Financial logic is a pure package. The AI phrases its output; it never
> produces a figure.**

`packages/core` computes every number Eco shows — debt amortisation, budget
evaluation, savings projection, pattern detection, forecasting,
recommendations. No database, no HTTP, no framework.

Three consequences:

- **128 tests run in a second** with no infrastructure and no mocks.
- **React Native reuses it verbatim** — the mobile app is a presentation layer,
  not a reimplementation.
- **Recommendations are auditable.** Every claim ships with the `evidence` it
  was derived from, because advice a user cannot check is advice taken on faith.

## Repository layout

```
Eco/
├── packages/
│   ├── shared/          Types, enums, Zod schemas, currency table
│   └── core/            All financial logic — pure, portable, 128 tests
├── apps/
│   ├── api/             NestJS · Prisma · 94 routes
│   └── web/             Next.js App Router · 14 routes
├── services/ai/         FastAPI · Holt-Winters · Ollama
├── infra/
│   ├── k8s/base/        Deployments, HPAs, PDBs, network policies
│   └── postgres/        Row-level security policies
├── docs/                Architecture, schema, API, AI, security, roadmap
└── scripts/             Palette accessibility guard
```

## Commands

```bash
npm run dev              # API + web with hot reload
npm run build            # Everything
npm run test             # Domain + API tests
npm run typecheck        # Every workspace

npm run prisma:migrate   # Create and apply a migration
npm run prisma:seed      # Reset the demo account
npm run prisma:studio    # Browse the database

cd services/ai && .venv/bin/python -m pytest tests/ -q
```

## Documentation

| | |
|---|---|
| [Architecture](docs/01-architecture.md) | Component boundaries, request lifecycle, mobile readiness, **known limitations** |
| [Database schema](docs/02-database-schema.md) | ERD, indexing, and why each denormalisation exists |
| [API design](docs/03-api-design.md) | All 94 routes, error contract, rate limits |
| [AI layer](docs/04-ai-architecture.md) | Pattern learning, forecasting, prompt safety, verified behaviour |
| [Deployment](docs/05-deployment.md) | Images, Kubernetes, secrets, CI/CD |
| [Roadmap](docs/06-roadmap.md) | MVP scope, phases, scaling to 1M+ users |
| [Security](docs/07-security.md) | Threat model, OWASP mapping, **known gaps** |
| [Frontend](08-frontend.md) | Screens, chart method, accessibility |
| [User guide](docs/09-user-guide.md) | First run on a fresh account, phone navigation, multi-currency entry, income and savings |

## A few decisions worth knowing about

**Money is integer minor units, everywhere.** Cents and fils, `BIGINT` at rest,
JSON numbers on the wire. Floating point never touches a balance.

**Tenant isolation is enforced twice.** Every query filters by `userId`, and
Postgres row-level security independently enforces the same boundary. A query
that forgets its `where` clause returns zero rows, not somebody else's money.

**Refresh tokens rotate, and reuse is treated as theft.** Presenting a retired
token revokes its entire family — the OAuth 2.0 BCP response, which turns a
silent indefinite compromise into one visible logout.

**Forecasts degrade rather than fail.** If the Python service is unreachable the
API computes the forecast in-process and labels the response with which model
produced it.

**The chart palette was computed, not chosen.** The category colours are search-
selected and verified against colour-vision simulation; `scripts/verify-palette.mjs`
fails CI on a regression. The original hand-picked palette had two greens that
were indistinguishable to *normal* colour vision.

**Nothing leaves the deployment.** The LLM runs locally under Ollama. A user's
complete financial position is not something to hand a third party on their
behalf.

## Bugs found and fixed during the build

Recorded because they shaped the design, and because a list of only successes
is a sales document:

| Bug | Consequence | Fix |
|---|---|---|
| JWT `iat` compared against a millisecond watermark | **Every new user got 401 on their first request** | Truncate the watermark to second granularity |
| Budget projection extrapolated rent as a daily rate | £1,457 spent projected to **£43,717** | Exclude committed recurring spend from the run rate |
| Forecast fed the current, partial month | Expenses projected to **£0** | `completeMonthsOnly()` + regression test |
| Merchant normaliser stripped `*<word>` | `SQ *JOE'S COFFEE` lost its merchant name | Consume `*` with the processor prefix |
| Transient 429 on token refresh | **Signed the user out mid-session** | Only 401/403 end a session |
| Profile fetch failure fell back to USD | GBP balances rendered with **`$`** | Cache the profile beside the tokens |
| Savings rate vs health score used different bases | Dashboard showed 68.6% and −6.2% at once | Both use a trailing 3-month average |
| Debt scored on balance-to-income | Anyone with a mortgage scored **0** | Payment-based DTI, the metric lenders use |
| Two seeded category greens at ΔE 6.3 | Indistinguishable on every chart | Search-selected palette + CI guard |

## Status

Phases 1 and 2 are complete and verified running. Phase 3 (React Native, push
notifications, LLM tool-calling) is next — see the
[roadmap](docs/06-roadmap.md).

The [architecture](docs/01-architecture.md#known-limitations) and
[security](docs/07-security.md#known-gaps) documents both end with an explicit
list of what is *not* solved yet. The most important: the LLM will still perform
arithmetic it has been told not to, and access tokens live in `localStorage`
rather than an httpOnly cookie.
