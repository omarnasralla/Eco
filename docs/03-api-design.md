# API design

REST over HTTPS. Base path `/eco/api/v1`. JSON in, JSON out. Interactive
documentation is served at `/eco/api/v1/docs` (OpenAPI 3, development only).

**94 routes** across 14 modules.

## Conventions

| Concern | Decision |
|---|---|
| Money | Integer minor units + ISO-4217 code. `{ "amountMinor": 145000, "currency": "GBP" }` |
| Dates | ISO `YYYY-MM-DD`; months as `YYYY-MM`. Never a datetime for a calendar date. |
| Auth | `Authorization: Bearer <access token>`, 15-minute lifetime |
| Errors | `{ statusCode, error, message, requestId, timestamp }` |
| Validation | Zod schemas from `@eco/shared` — the same objects the web forms use |
| Lists | Keyset cursor: `{ items, nextCursor }` |
| Tracing | `X-Request-Id` echoed on every response and in every error body |

Authentication is **global and opt-out**. `JwtAuthGuard` is registered as an
`APP_GUARD`; a route is public only if it carries `@Public()`. Forgetting the
decorator produces a 401, never an open endpoint.

## Error format

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "A record with this email already exists.",
  "requestId": "18b2a822-8a15-4b54-9604-406748f64774",
  "timestamp": "2026-09-01T09:38:44.120Z"
}
```

`message` is a string, or an array of strings for field-level validation
failures. Prisma error codes are translated to honest statuses rather than a
blanket 500:

| Prisma | HTTP | Meaning |
|---|---|---|
| `P2002` | 409 | Unique violation — names the field, never echoes the value |
| `P2003` | 400 | Referenced record does not exist |
| `P2025` | 404 | Record not found |
| `P2014` | 409 | Still referenced by other data |

In production, 5xx responses carry a generic message plus the request id; the
detail goes to logs. A stack trace never reaches a client.

## Authentication

```
POST   /auth/register              Create account; seeds 12 categories
POST   /auth/login                 Sign in; may return a 2FA challenge
POST   /auth/login/2fa             Complete a 2FA sign-in
POST   /auth/refresh               Rotate the refresh token
POST   /auth/logout                Revoke one refresh token
POST   /auth/logout-all            Revoke every session
GET    /auth/sessions              List active sessions
GET    /auth/me                    Current user
POST   /auth/verify-email          Confirm an address
POST   /auth/resend-verification
POST   /auth/forgot-password       Always 204 — see below
POST   /auth/reset-password
POST   /auth/change-password
POST   /auth/2fa/setup             Returns secret + QR + recovery codes
POST   /auth/2fa/enable            Confirm with a valid code
POST   /auth/2fa/disable           Requires the password
POST   /auth/2fa/recovery-codes    Regenerate
GET    /auth/oauth/google          Begin OAuth
GET    /auth/oauth/google/callback
```

### Two-factor is a two-step exchange

`POST /auth/login` with a password on a 2FA account returns
`{ twoFactorRequired: true, challengeToken }` — **not** a session. The
challenge token proves the password step succeeded, expires in five minutes,
and is single-use. `POST /auth/login/2fa` exchanges it plus a TOTP code for
tokens. Recovery codes are accepted in place of a TOTP code and are consumed.

### Account enumeration is closed off

- `POST /auth/register` with an existing address returns the same message as a
  success and emails the *real owner* that someone tried.
- `POST /auth/forgot-password` always returns 204.
- `POST /auth/login` hashes a dummy password when the account does not exist, so
  a missing account and a wrong password take the same time to answer.

### OAuth tokens return via a URL fragment

The callback redirects to `/auth/callback#access_token=…`. Fragments are not
sent to servers, so the tokens stay out of access logs, proxy logs and the
`Referer` header — which a query string would not.

## Financial resources

```
GET    /income                     ?includeInactive
GET    /income/summary             Monthly run rate in base currency
POST   /income
POST   /income/:id/receipts        An actual payment landing
PATCH  /income/:id
DELETE /income/:id

GET    /categories                 ?includeArchived
POST   /categories
PATCH  /categories/:id
POST   /categories/:id/merge/:targetId
DELETE /categories/:id             Archives when history exists

GET    /expenses                   Filters + keyset cursor
POST   /expenses
POST   /expenses/bulk              Up to 500 (CSV / bank export)
PATCH  /expenses/:id
DELETE /expenses/:id

GET    /debts                      With payoff projections
GET    /debts/upcoming             ?days
GET    /debts/strategies/compare   ?monthlyBudgetMinor
POST   /debts/payoff-plan          Full month-by-month schedule
POST   /debts/:id/payments
GET    /debts/:id/payments

GET    /goals
POST   /goals/:id/contributions    Negative amount = withdrawal
GET    /goals/:id/contributions

GET    /budgets                    Months that have a budget
GET    /budgets/suggest            ?month — from six months of history
GET    /budgets/:month             Live spend, projection, per-line status
PUT    /budgets                    Create or replace
DELETE /budgets/:month
```

### `GET /expenses` filters

`from`, `to`, `categoryId`, `merchant`, `minAmountMinor`, `maxAmountMinor`,
`search`, `cursor`, `limit` (≤100), `sort` (`date|amount|merchant`), `order`.

The cursor is opaque. It encodes `(date, id)` to match the covering index, so
depth costs nothing and concurrent inserts cannot make the client skip or
repeat a row.

### Budgets use `PUT`, not `PATCH`

A budget is submitted whole: the client always sends the complete line set and
the server replaces it. Diffing individual lines would only create a way for
client and server to disagree about what the budget is.

## Dashboard

```
GET /dashboard/summary             ?month — headline widgets
GET /dashboard/trend               ?months — income vs expenses
GET /dashboard/category-breakdown  ?month — with MoM change
GET /dashboard/upcoming-bills      ?days
GET /dashboard/net-worth-history   ?months
```

`summary.savingsRatePct` is averaged over the **last three complete months**,
and `savingsRateBasisMonth` says so. Two reasons: the month in progress is
partial (on the 1st it holds one day of spending, and dividing full-month
income by it reports a savings rate near 100% that is simply false), and a
single complete month is too noisy — one holiday swings the figure by fifty
points. Three months matches the basis the health score uses, so the two
figures on the dashboard agree instead of contradicting each other.

## AI

```
POST   /ai/chat                    Grounded natural-language answer
GET    /ai/conversations
GET    /ai/conversations/:id
DELETE /ai/conversations/:id
GET    /ai/forecast                ?horizonMonths (1–24)
GET    /ai/patterns                Recurring charges, seasonality, merchants
GET    /ai/recommendations         Deterministic, evidence-backed
POST   /ai/recommendations/:id/dismiss
GET    /ai/health-score            0–100 with components
```

`GET /ai/forecast` degrades rather than failing: if the Python service is
unreachable the API computes the forecast in-process with `@eco/core` and
labels the response `model: "holt-damped-local"` with an explicit warning. The
client renders the same chart either way and the user is told which model
produced the number.

Recommendations always ship their `evidence` — the exact inputs behind the
advice — because advice a user cannot check is advice taken on faith.

## Reports, notifications, currency, audit

```
GET  /reports                      Previously generated
POST /reports/generate             Streams PDF / XLSX / CSV

GET   /notifications               ?unreadOnly&cursor&limit
GET   /notifications/unread-count
GET   /notifications/preferences
PATCH /notifications/preferences
POST  /notifications/push-tokens
PATCH /notifications/:id/read
PATCH /notifications/read-all

GET /currency/supported
GET /currency/rates                ?date
GET /currency/convert              ?amountMinor&from&to&date

GET /audit/me                      Your own account activity

GET /users/me
PATCH /users/me
POST /users/me/onboarding/complete
GET /users/me/export               GDPR Article 20 portability
DELETE /users/me                   30-day grace, then hard purge

GET /health/live                   Liveness — checks nothing external
GET /health/ready                  Readiness — checks dependencies
```

Reports are generated synchronously and streamed straight back. A personal
finance report covers at most a year of one user's data and renders in well
under a second, so there is no bucket of un-expired financial documents to
secure. `Cache-Control: no-store, private` — a financial report must never sit
in a shared proxy cache.

## Rate limits

Defined once in `@eco/shared`'s `RATE_LIMITS` and consumed by both the server's
throttler configuration and the client, so a client can back off before it is
told to.

| Bucket | Window | Limit | Applies to |
|---|---|---|---|
| `default` | 60s | 120 | Everything |
| `auth` | 60s | 10 | Login, 2FA |
| `auth` (registration) | 1h | 5 | Register, password reset |
| `ai` | 60s | 20 | Chat and inference — the costliest work |
| `export` | 1h | 20 | Report generation |

## Health probes are deliberately different

`/health/live` checks nothing external. If it fails, the process is broken and
should be restarted. Making liveness depend on Postgres would turn a brief
database blip into a cluster-wide restart loop, precisely when restarting helps
least.

`/health/ready` checks what a request actually needs. Redis reports
`degraded` rather than failing readiness — it is a cache, and the API falls
through to uncached reads without it.
