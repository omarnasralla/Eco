# User guide — first run, mobile navigation, and income

This is the practical companion to the architecture docs: what a brand-new
account can actually do today, where each screen lives, and what is still
missing from the web UI. It is written against the code in `apps/web` and
`apps/api`, not against a roadmap — where the app cannot yet do something, this
document says so and gives the workaround.

## 1. Where everything lives

Navigation is defined once, in `apps/web/src/components/layout/nav-items.ts`,
and rendered two ways:

- **Desktop (`lg` and wider, ≥1024px)** — the left sidebar
  (`components/layout/sidebar.tsx`) lists **all nine** destinations plus your
  profile and Sign out.
- **Phone and tablet (below 1024px)** — the bottom tab bar
  (`components/layout/mobile-nav.tsx`) shows only the five entries flagged
  `primary: true`. The sidebar is hidden entirely (`hidden … lg:flex`).

| Page | Path | In the phone tab bar? |
|---|---|---|
| Dashboard | `/dashboard` | Yes |
| Expenses | `/expenses` | Yes |
| Eco AI | `/assistant` | Yes |
| Budgets | `/budgets` | Yes |
| Debts | `/debts` | Yes |
| **Income** | `/income` | **No** |
| **Goals** | `/goals` | **No** |
| **Reports** | `/reports` | **No** |
| **Settings** | `/settings` | **No** |

### Reaching Settings (and Income, Goals, Reports) on a phone

There is currently **no "More" menu, overflow button, or header link** on
mobile, so the four non-primary pages have no tap path. Until one is added, use
one of these:

1. **Type the URL.** In your phone browser's address bar, go to
   `https://<your-eco-host>/settings` — or `/income`, `/goals`, `/reports`.
   Locally that is `http://localhost:3000/settings`.
2. **Bookmark or add to the home screen.** The app ships a web manifest
   (`apps/web/public/manifest.webmanifest`), so "Add to Home Screen" works;
   add `/settings` and `/income` as separate shortcuts and they become
   one-tap.
3. **Rotate a tablet to landscape, or use desktop mode.** The sidebar appears
   at viewport widths of 1024px and up, and it links to every page. Requesting
   the desktop site in mobile Safari or Chrome usually crosses that threshold.

Signing out is on the Settings page and in the desktop sidebar, so it has the
same constraint on mobile — reach it via `/settings`.

> **Known gap.** Four of nine destinations being unreachable by tap on mobile
> is a bug, not a design decision; the tab bar's own comment says the rest
> "lives behind Settings", but Settings is not in the tab bar either. The fix
> is a fifth "More" tab (or a Settings entry in a header) that opens the
> non-primary items.

## 2. A fresh account, start to finish

1. **Register** at `/register`, then verify the email that arrives. In local
   development, mail is caught by MailHog at `http://localhost:8025` — nothing
   leaves the machine. An unverified account still works; Settings shows an
   `unverified` badge.
2. **Set your base currency** at `/settings` → *Profile* → *Base currency*.
   Do this **before** entering data. Every total and chart is rendered in this
   currency; past transactions keep the exchange rate from the day they
   happened, so history stays consistent, but starting in the right currency
   saves you reading converted figures.
3. **Choose a theme** at `/settings` → *Appearance* (light / dark / system).
4. **Review security** at `/settings` → *Security*: it shows whether two-factor
   authentication is on, lists your active sessions, and offers *Sign out
   everywhere*. Note that the page only **reports** the 2FA state — there is no
   enable button yet; turning it on means calling `POST /auth/2fa/setup` and
   `POST /auth/2fa/enable`.
5. **Add your income** — see section 3. This matters first because the
   dashboard's savings rate, the budget headroom, the debt payoff plans and
   the AI health score all divide by income. With no income recorded, a fresh
   account reports a 0 monthly run rate and every derived figure reads as if
   you earn nothing.
6. **Add expenses** at `/expenses` → *Add expense*. This is the one entity with
   a full create form in the web UI. The dialog also opens directly via the
   deep link `/expenses?new=1`, which is handy as a home-screen shortcut.
7. **Set a budget** at `/budgets`, and **goals** at `/goals`, once there is
   income and a few weeks of spending for them to be measured against.

Your twelve default expense categories (Housing, Transportation, Food, …) are
seeded automatically at registration — you do not need to create them.

## 3. Adding income

### What the UI does today

`/income` is **read-only**. It renders your monthly run rate and a list of
sources; it has no *Add income* button, and neither `apps/web/src/app/(app)/income/page.tsx`
nor `lib/queries.ts` contains a create mutation. A fresh account therefore sees
"No income recorded yet." with no way forward from that screen. Expenses is
currently the only entity with a create form; Income, Goals, Debts and Budgets
are all view-only in the web app.

> **Known gap.** The API is complete — `POST /income`, `PATCH /income/:id`,
> `DELETE /income/:id` and `POST /income/:id/receipts` all exist and are
> audited. Only the client form is missing. Until it lands, use the API
> directly as below.

### Adding income through the API

In development the interactive Swagger UI at
`http://localhost:4000/api/v1/docs` is the easiest route: authorise with your
access token, open **income → POST /income**, and *Try it out*. Swagger is
disabled in production (`main.ts` mounts it only when `isProduction` is false),
so on a deployed instance use curl or any HTTP client.

By hand:

```bash
# 1. Sign in and keep the access token
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])')

# 2. Create an income source
curl -X POST http://localhost:4000/api/v1/income \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Acme Ltd — Salary",
    "type": "SALARY",
    "amountMinor": 320000,
    "currency": "GBP",
    "frequency": "MONTHLY",
    "startDate": "2026-01-25",
    "isActive": true,
    "notes": "Net pay after tax and pension."
  }'
```

If two-factor authentication is on, `POST /auth/login` returns a challenge
rather than tokens — complete it at `POST /auth/login/2fa` and use the
`accessToken` from that response instead.

Reload `/income` and the source, and your monthly run rate, appear.

### Field reference

Validated by `incomeSourceSchema` in `packages/shared/src/schemas.ts`.

| Field | Required | Notes |
|---|---|---|
| `name` | yes | 1–120 characters. |
| `type` | yes | `SALARY`, `FREELANCE`, `BUSINESS`, `INVESTMENT`, `RENTAL`, `SIDE_HUSTLE`, `OTHER`. |
| `amountMinor` | yes | **Minor units** — pence, cents. £3,200.00 is `320000`. Not `3200`. |
| `currency` | yes | ISO-4217 code, e.g. `GBP`. May differ from your base currency; it is converted for totals. |
| `frequency` | yes | `ONE_TIME`, `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `YEARLY`. |
| `startDate` | yes | `YYYY-MM-DD` — when the stream began, which may be years ago. |
| `endDate` | no | Must fall on or after `startDate`. Use it for a contract that ends. |
| `isActive` | no | Defaults `true`. Set `false` to keep a finished job in your history without counting it. |
| `notes` | no | Up to 2000 characters. |

**The amount to enter is your take-home pay**, not gross, unless you also plan
to record tax as an expense. The number is used as-is; nothing is deducted.

### How the monthly run rate is calculated

Weekly and fortnightly pay is annualised over 52 and 26 payments and then
divided by twelve (`OCCURRENCES_PER_YEAR` in `packages/shared/src/enums.ts`).
A three-paycheque month is therefore not mistaken for a raise, and the figure
you see on `/income` and on the dashboard is the same figure. `ONE_TIME`
income counts zero times per year and so adds nothing to the run rate — that is
deliberate; a one-off bonus is not a monthly income stream.

### Recording what actually arrived

A source is the *expectation*. `POST /income/:id/receipts` records an actual
payment (`amountMinor`, `date`, optional `notes`), which is what the AI layer's
income-consistency analysis reads to tell steady pay from variable pay. There
is no UI for this yet either.

### Local development shortcut

`npm run prisma:seed` builds a demo account — `demo@eco.app` /
`demo-password-2026` — with a monthly salary, freelance income, three years of
expenses, debts and goals already in place. Use it to see populated screens
without entering anything; it is a development fixture, not your account.

## 4. Summary of current gaps

| Gap | Impact | Workaround |
|---|---|---|
| Settings, Income, Goals, Reports absent from the mobile tab bar | Unreachable by tap below 1024px | Direct URL, home-screen shortcut, or desktop-width viewport |
| No *Add income* form | A fresh account cannot record income in the UI | `POST /income` via Swagger (`/api/v1/docs`, dev only) or curl |
| No create UI for Goals, Debts, Budgets | Same | Their `POST` endpoints, documented in `docs/03-api-design.md` |
| No UI for income receipts | Income-consistency analysis has no actuals to read | `POST /income/:id/receipts` |
| Settings reports 2FA state but cannot enable it | Two-factor cannot be turned on from the UI | `POST /auth/2fa/setup` then `POST /auth/2fa/enable` |
