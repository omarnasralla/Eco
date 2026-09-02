# User guide — first run, mobile navigation, and income

This is the practical companion to the architecture docs: how to get a
brand-new account set up, where each screen lives on a phone and on a desktop,
and how income works. It is written against the code in `apps/web` and
`apps/api`, not against a roadmap — where the app cannot yet do something, this
document says so and gives the workaround.

## 1. Where everything lives

Navigation is defined once, in `apps/web/src/components/layout/nav-items.ts`,
and rendered two ways:

- **Desktop (`lg` and wider, ≥1024px)** — the left sidebar
  (`components/layout/sidebar.tsx`) lists **all nine** destinations plus your
  profile and Sign out.
- **Phone and tablet (below 1024px)** — the bottom tab bar
  (`components/layout/mobile-nav.tsx`), where the sidebar is hidden
  (`hidden … lg:flex`). Five slots: four destinations flagged `primary: true`,
  and **More**, which opens a sheet holding the other five pages plus your
  account and Sign out.

| Page | Path | On a phone |
|---|---|---|
| Dashboard | `/dashboard` | Tab bar |
| Expenses | `/expenses` | Tab bar |
| Eco AI | `/assistant` | Tab bar |
| Budgets | `/budgets` | Tab bar |
| Debts | `/debts` | More |
| Income | `/income` | More |
| Goals | `/goals` | More |
| Reports | `/reports` | More |
| Settings | `/settings` | More |

### Reaching Settings, Income, Goals and Reports on a phone

**Tap More**, the last tab in the bottom bar. It opens a sheet listing Debts,
Income, Goals, Reports and Settings, with your account and Sign out beneath
them. Tapping any row navigates and closes the sheet.

The More tab is highlighted whenever you are on one of the pages it holds, so
the tab bar never claims you are nowhere.

Two details worth knowing:

- **Debts moved into More.** Five slots is the platform maximum before a tap
  target becomes a guess, and the fifth is now spent on More. Debts is a
  planning screen visited occasionally rather than a daily-entry one, so it
  yielded its slot. It is one extra tap away, and unchanged on desktop.
- **Direct URLs still work** and make good home-screen shortcuts, since the app
  ships a web manifest (`apps/web/public/manifest.webmanifest`). `/settings`
  and `/expenses?new=1` are the two worth pinning.

At 1024px and wider — a landscape tablet, or a phone browser set to request the
desktop site — the tab bar gives way to the sidebar, which lists all nine
destinations at once.

## 2. A fresh account, start to finish

1. **Register** at `/register`, then verify the email that arrives. In local
   development, mail is caught by MailHog at `http://localhost:8025` — nothing
   leaves the machine. An unverified account still works; Settings shows an
   `unverified` badge.
2. **Set your base currency** at `/settings` → *Profile* → *Base currency*.
   Do this **before** entering data. Every total and chart is reported in this
   currency, and you can still enter individual amounts in any other one
   (section 3). Getting it right up front matters because the converted figure
   frozen onto each past transaction is **not** rewritten when you change the
   base later — deliberately, so last year's reports do not restate themselves
   — which means totals spanning the change mix the old base with the new.
3. **Choose a theme** at `/settings` → *Appearance* (light / dark / system).
4. **Review security** at `/settings` → *Security*: it shows whether two-factor
   authentication is on, lists your active sessions, and offers *Sign out
   everywhere*. Note that the page only **reports** the 2FA state — there is no
   enable button yet; turning it on means calling `POST /auth/2fa/setup` and
   `POST /auth/2fa/enable`.
5. **Add your income** at `/income` → *Add* — see section 4. This matters first
   because the dashboard's savings rate, the budget headroom, the debt payoff
   plans and the AI health score all divide by income. With no income recorded, a fresh
   account reports a 0 monthly run rate and every derived figure reads as if
   you earn nothing.
6. **Add expenses** at `/expenses` → *Add*. The dialog also opens directly via
   the deep link `/expenses?new=1`, which is handy as a home-screen shortcut;
   `/income?new=1` does the same for income.
7. **Add a savings goal** at `/goals` → *Add* — see section 5. This is where an
   amount set aside for savings goes, and it is what the dashboard's net worth
   is built from.
8. **Set a budget** at `/budgets` once there is income and a few weeks of
   spending for it to be measured against.

If you earn or spend in a currency other than the one you picked in step 2,
read section 3 before entering anything — the short version is that every
amount field has a currency picker, and you should type what the receipt says.

Your twelve default expense categories (Housing, Transportation, Food, …) are
seeded automatically at registration — you do not need to create them.

## 3. Entering money in another currency

Your **base currency** (Settings → Profile) is what every total, chart and
report is reported in. It is not what you have to type in.

Every amount field in the app — expenses, income, savings targets, payments
into a goal — is an amount *and* a currency picker. Living in Riyadh with your
reports in dollars, you type what the receipt says, 87.50 SAR, and the field
shows you what it will land as: `≈ $23.33 at today's rate`.

What is stored is both figures. The original amount and currency are kept
exactly as entered, and the converted figure is computed by the API **at the
rate on the date of the transaction**, then frozen on the row. Backdating an
expense to March uses March's rate, and today's move in the riyal cannot
restate what you spent in March. That is why the preview says "≈": it uses
today's rate, and only the saved figure is authoritative.

The picker remembers your last choice per browser, so a run of riyal expenses
takes one pick, not one per entry. Clearing site data resets it to your base
currency; nothing about it is stored on the server.

### Where the conversion happens

| Entry | Stored as entered | Converted to | When |
|---|---|---|---|
| Expense | `amountMinor` + `currency` | your base currency (`baseAmountMinor`) | the expense's date |
| Income source | `amountMinor` + `currency` | your base currency, for the run rate | read time |
| Savings goal | its own `currency` | your base currency, for the dashboard total | today's rate |
| Payment into a goal | `amountMinor` + `currency` | the **goal's** currency (`goalAmountMinor`) | the payment's date |

A goal keeps its own currency. A riyal goal shows riyals on the Goals page —
converting it for display would only invite you to compare it against a target
in a different unit. Only the dashboard's *Total savings* is converted, because
that figure is added to your other holdings.

### When a currency is greyed out

The picker only offers currencies your rate provider actually publishes. Which
those are depends on `FX_PROVIDER`:

- **`ecb`** (the default in `.env.example`) is the ECB reference set via
  Frankfurter. It is free and needs no key, but it publishes **no Gulf
  currencies** — no SAR, AED, EGP, JOD, KWD. If you are in KSA, this is the
  wrong provider for you.
- **`openexchangerates`** covers SAR and the rest; it needs a free
  `OPENEXCHANGERATES_APP_ID`.
- **`fixed`** is a small offline table for development.

If the currency you want is greyed out, that is the provider, not the app.
Switch `FX_PROVIDER` and restart; rates are fetched at boot when none are
stored, so you do not have to wait for the 05:00 refresh.

An amount in your base currency never needs a rate, so it always saves, even
if the provider is unreachable. A cross-currency amount that cannot be
converted is **refused** with an explanation rather than saved: filing 375
riyals as 375 dollars is a silent four-fold error that is indistinguishable
from a real figure afterwards.

## 4. Adding income

### In the app

Open `/income` — via **More → Income** on a phone, or the sidebar on desktop —
and tap **Add**. On a fresh account the empty state carries the same button, so
there is no dead end to back out of.

Six fields, and the last three come pre-filled — a name, an amount and a
frequency is a complete entry:

| Field | What to put |
|---|---|
| **Name** | Whatever you will recognise: "Acme Ltd — Salary", "Weekend shifts". |
| **Amount** | What actually lands in your account — take-home pay, not gross. Nothing is deducted from this figure. Type it in normal units (`3200`, `3200.50`); the form converts to minor units before sending. |
| **How often** | Monthly, weekly, every two weeks, quarterly, yearly, or a one-off. |
| **Type** | Salary, freelancing, business, investments, rental, side hustle, other. Defaults to Salary. |
| **Started on** | When the stream began, even if that was years ago. Defaults to today. |
| **Notes** | Optional. |

Saving refreshes the run rate, the dashboard, your budget headroom and the
health score together — income moves all of them, so none is left stale.

To record a second stream, tap **Add** again.

### Changing one later

Tap any source in the list to edit it — the whole row opens the form, so a
raise is two taps.

- **A raise or a pay cut** — change the amount and save. The run rate is a
  *present-day* figure (the trend chart applies today's income to every month
  it draws), so there is no history to restate and nothing else to update.
- **A job or contract that ends** — set **Ends on**. Once that date has passed
  the source stops counting towards your run rate, while the record stays on
  the page marked *ended*. The end date must fall on or after the start date;
  the form says so if it does not.
- **A pause** — set the status to *Paused*, for a client between contracts.
  It stops counting immediately and can be resumed from the same place.
- **Something entered by mistake** — **Delete**, behind a confirmation. This
  removes the record; pausing is the better move when you only want it to stop
  counting.

A source is counted in the run rate only when all three hold: it is not
paused, its start date has passed, and its end date has not. Any source that
fails one of these is labelled on the row — *paused*, *ended*, *not started* —
so a total you did not expect can always be accounted for.

Editing an existing source does not change the currency your *next* new entry
defaults to: correcting an old riyal salary should not make tomorrow's expense
default to riyals.

### Adding income through the API

You do not need this for normal use — it is here for scripting, bulk imports,
and the operations the UI does not cover yet (editing, deleting, receipts).

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

Validated by `incomeSourceSchema` in `packages/shared/src/schemas.ts`. The form
fills in `currency`, `isActive` and the minor-unit conversion for you; over the
API you send them yourself.

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
income-consistency analysis reads to tell steady pay from variable pay. There is
no UI for this yet.

### Local development shortcut

`npm run prisma:seed` builds a demo account — `demo@eco.app` /
`demo-password-2026` — with a monthly salary, freelance income, three years of
expenses, debts and goals already in place. Use it to see populated screens
without entering anything; it is a development fixture, not your account.

## 5. Savings

Savings live as **goals**: a named thing you are putting money aside for, with
a target. There is no separate "savings balance" — the sum of your goals *is*
your savings, and it is what the dashboard's *Total savings* and *Net worth*
are built from.

### Creating one

`/goals` → **Add** (or *Add your first goal* on an empty account). A name and a
target amount are all that is required.

| Field | Notes |
|---|---|
| **Name** | "Emergency fund", "Hajj", "New car". |
| **Target amount** | With its own currency picker — the goal is then kept in that currency. |
| **Already saved** | Optional opening balance, in the goal's currency. Use it when you have money set aside already rather than starting from zero. |
| **Type** | Emergency fund, vacation, car, home deposit, retirement, education, custom. |
| **Target date** | Optional. With one, Eco works out what you need to put aside each month and marks the goal *behind* if you are short. |

### Paying into one

**Add money** on the goal's card. Amount, currency, date, and an optional note.
The amount may be in any currency: paying $1,000 into a riyal goal records the
thousand dollars as entered and adds ﷼3,750 to the balance, at the rate on the
payment's date.

A negative amount is a withdrawal, over the API. The form takes positive
amounts only for now — see the gaps below.

Crossing 25%, 50%, 75% and 100% raises a notification, once each: a balance
that hovers around a threshold cannot re-congratulate you every time it
wobbles across.

## 6. Summary of current gaps

| Gap | Impact | Workaround |
|---|---|---|
| No create UI for Debts or Budgets | They cannot be set up in the app | Their `POST` endpoints, documented in `docs/03-api-design.md` |
| No withdrawal or edit UI for goals | Correcting a payment needs the API | `POST /goals/:id/contributions` with a negative `amountMinor` |
| No UI for income receipts | Income-consistency analysis has no actuals to read | `POST /income/:id/receipts` |
| Settings reports 2FA state but cannot enable it | Two-factor cannot be turned on from the UI | `POST /auth/2fa/setup` then `POST /auth/2fa/enable` |
| Changing the base currency does not rebase past transactions | Totals spanning the change mix two base currencies | Set the base currency before entering data |

Income (adding and editing), savings and mobile navigation were all on this
list; all of them are fixed. Expenses, income and goals have create forms, amounts can be entered in
any published currency, and every page is reachable by tap on a phone.
