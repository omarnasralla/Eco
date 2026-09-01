# System architecture

## The shape of the system

```
                          ┌──────────────────────┐
                          │  Browser / React     │
                          │  Native (phase 3)    │
                          └──────────┬───────────┘
                                     │ HTTPS
                          ┌──────────▼───────────┐
                          │   Ingress (nginx)    │
                          │  TLS · HSTS · rate   │
                          └────┬────────────┬────┘
                               │            │
                  ┌────────────▼──┐   ┌─────▼─────────────┐
                  │  Next.js 15   │   │   NestJS API      │
                  │  App Router   │──▶│   REST · JWT      │
                  │  SSR + client │   │   94 routes       │
                  └───────────────┘   └──┬────┬────┬──────┘
                                         │    │    │
                     ┌───────────────────┘    │    └──────────────┐
                     │                        │                   │
            ┌────────▼────────┐     ┌─────────▼──────┐   ┌────────▼────────┐
            │  PostgreSQL 16  │     │    Redis 7     │   │  FastAPI (AI)   │
            │  28 tables · RLS│     │  cache · locks │   │  forecasting    │
            └─────────────────┘     └────────────────┘   └────────┬────────┘
                                                                  │
                                                         ┌────────▼────────┐
                                                         │  Ollama         │
                                                         │  llama3.2:3b    │
                                                         └─────────────────┘
```

## The decision that shapes everything else

**Financial logic lives in a pure TypeScript package, not in the API.**

`packages/core` contains every calculation Eco makes — debt amortisation,
budget evaluation, savings projection, pattern detection, forecasting,
recommendations. It has no database access, no HTTP, no framework imports. Its
only dependency is `packages/shared`, which is types and Zod schemas.

Three things follow from that:

1. **It is tested exhaustively without infrastructure.** 128 unit tests run in
   under a second with no database, no fixtures and no mocking. The tests that
   matter most — "does the snowball ever cost more than the avalanche", "does a
   minimum payment below the interest correctly return null" — are the ones
   that would be slowest and least reliable as integration tests.

2. **React Native reuses it verbatim.** The mobile app is not a rewrite of the
   business logic; it is a second presentation layer over the same package. A
   payoff schedule computed on the phone is byte-identical to one computed on
   the server, because it is the same code.

3. **The AI cannot invent numbers.** Every figure in a recommendation is
   produced by this package from the user's own ledger. The language model
   receives those figures pre-computed and pre-formatted and is instructed only
   to select and phrase them.

## Component responsibilities

| Component | Owns | Explicitly does not own |
|---|---|---|
| `packages/shared` | Types, enums, Zod schemas, currency table | Any logic with branches |
| `packages/core` | All financial mathematics | I/O of any kind |
| `apps/api` | Persistence, auth, authorisation, orchestration | Financial calculation |
| `apps/web` | Presentation, interaction, formatting | Business rules |
| `services/ai` | Statistical forecasting, LLM mediation | Writing to the database |

The API is deliberately thin: it authenticates, loads rows, hands them to
`@eco/core`, and maps the result to a DTO. When a service method starts doing
arithmetic, that arithmetic belongs in `core` instead.

## Request lifecycle

A `POST /api/v1/expenses` traverses:

1. **`RequestIdMiddleware`** — stamps `X-Request-Id`, echoed in every error body.
2. **`ThrottlerGuard`** — rate limit, checked before any authentication work so
   an unauthenticated flood is cheap to reject.
3. **`JwtAuthGuard`** — validates the access token. Registered *globally*, so
   authentication is opt-out (`@Public()`) rather than opt-in; a forgotten
   decorator yields a 401, not an open endpoint.
4. **`JwtStrategy.validate`** — confirms the account still exists and that the
   token predates no revocation, using a 60-second Redis cache.
5. **`RolesGuard`** — coarse role check.
6. **`ZodValidationPipe`** — validates against the *same* schema object the
   browser form used.
7. **Controller → Service** — the service filters by `userId` on every query.
8. **Postgres RLS** — a second, independent enforcement of the tenant boundary.
9. **`AuditInterceptor`** — writes an append-only audit record.
10. **`AllExceptionsFilter`** — maps Prisma error codes to honest HTTP statuses
    and strips internals from production responses.

## Tenant isolation, twice

Every user-owned table carries `userId`, and every query filters on it. That is
the primary boundary.

Postgres Row-Level Security is the second. The application connects as
`eco_app`, which is not the table owner and has no `BYPASSRLS`. Each
transaction sets `app.current_user_id`, and every policy compares against it.
A query that forgets its `where: { userId }` returns **zero rows** instead of
another user's data.

Belt and braces is the right posture here: the cost is one `set_config` per
transaction, and the failure it prevents is the worst failure this product has.

## Caching

Redis is a cache and a coordination primitive, never a source of truth.

- **Keys are namespaced per user** (`eco:<userId>:<resource>`), so invalidation
  after a write is a scoped `SCAN`-based delete, and no key can be read by the
  wrong tenant.
- **`SCAN`, never `KEYS`** — `KEYS` blocks the Redis event loop for the length
  of the keyspace, which on a shared instance blocks every other tenant.
- **Failures are swallowed and logged.** Redis being down makes Eco slower, not
  broken; `remember()` falls through to the factory function.
- **Distributed locks** stop three replicas sending the same user three copies
  of the same nightly reminder.

## Why the AI layer is a separate service

Forecasting needs numpy, pandas, scikit-learn and statsmodels — roughly 400MB
of scientific Python. Three reasons not to force that into the Node process:

- **Different scaling shape.** A Holt-Winters fit is CPU-bound and bursty; API
  requests are I/O-bound and steady. They want different replica counts and
  different resource envelopes.
- **Different failure tolerance.** The API must stay up. Forecasting may
  degrade — and does: when the service is unreachable the API falls back to the
  in-process forecaster in `@eco/core` and labels the response with which model
  produced it.
- **The right tool.** statsmodels' `ExponentialSmoothing` is a mature,
  well-tested implementation. Reimplementing seasonal decomposition in
  TypeScript to avoid a service boundary would be a poor trade.

## Mobile readiness

The React Native app is a phase-3 deliverable, and the current code is built so
that it is a presentation project rather than a rewrite:

| Layer | Web | React Native | Shared? |
|---|---|---|---|
| Types & schemas | `@eco/shared` | `@eco/shared` | **Yes, verbatim** |
| Financial logic | `@eco/core` | `@eco/core` | **Yes, verbatim** |
| API client | `lib/api-client.ts` | same file | **Yes** — `fetch` is universal |
| Token storage | `lib/tokens.ts` (localStorage) | same interface, Keychain | Interface only |
| Formatting | `Intl.NumberFormat` | same | **Yes** |
| Components | React DOM + Tailwind | React Native + NativeWind | No |
| Navigation | App Router | React Navigation | No |

`lib/tokens.ts` is deliberately three functions wide (`get`, `store`, `clear`)
precisely so the native implementation swaps the body and nothing else changes.

## Known limitations

Stated plainly, because a design document that only lists strengths is a sales
document:

- **The LLM does arithmetic it should not.** The system prompt forbids
  calculation beyond comparison, and the model mostly complies — but asked
  "can I afford £3,000 next summer" it will subtract. The answers observed were
  correct, but a 3B model is not a calculator. The fix is tool-calling against
  `@eco/core`'s `affordabilityCheck`, which already exists; it is on the
  roadmap and is not yet wired.
- **Income volatility is modelled from a run rate**, not from actual receipts,
  until enough `IncomeReceipt` rows accumulate. A freelancer's real volatility
  therefore reads as zero at first.
- **Net worth excludes illiquid assets.** Property, pensions and investments
  are not tracked yet, so the figure is savings minus debt and is labelled as
  such rather than presented as a complete net worth.
- **Access tokens are in `localStorage`**, readable by any script achieving XSS
  on the origin. Mitigated by a strict CSP and a 15-minute token lifetime; the
  httpOnly-cookie path is supported by the API and is the phase-2 default for
  web.
