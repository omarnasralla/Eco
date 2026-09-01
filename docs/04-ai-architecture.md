# The AI layer

Eco AI is three things that are frequently conflated: a **pattern learner**, a
**forecaster**, and a **language interface**. Only the third involves a language
model, and it is the only one that cannot be trusted with a number.

## The rule everything follows

> **The model never produces a figure. It selects and phrases figures that were
> already computed from the user's ledger.**

Every amount a user sees in a recommendation — "cut £180/month", "save
£4,022.76 in interest", "37 months sooner" — comes from `@eco/core`, running
deterministic arithmetic over that user's own rows. The LLM's job is to decide
which of those findings answers the question and to say it in a sentence.

This is not a stylistic preference. A language model is an unreliable
calculator, and a wrong number in financial advice is worse than no advice.
Splitting computation from expression means every claim is reproducible,
auditable, and testable — the recommendation engine has 16 unit tests and no
mock of a model anywhere.

## 1. Pattern learning — `packages/core/src/patterns.ts`

Pure functions over a transaction list. No model, no training, no inference.

**Recurring charge detection** requires two independent signals to agree:

- **Cadence.** Gaps between charges from the same merchant cluster tightly
  around a median, which is then classified into a band (weekly ≈ 7 days,
  monthly 26–35, yearly 350–380).
- **Price stability.** Amounts cluster tightly around their own median.

Requiring both is what keeps "coffee three times a week" out of the
subscription list while still catching an annual insurance premium from three
data points. Confidence combines timing regularity (0.4), price stability
(0.35), how centred the cadence is in its band (0.15) and sighting count (0.1).

Merchant strings are normalised first, because card descriptors are noisy:
`SQ *JOE'S COFFEE #4412 SEATTLE` and `TST* JOE'S COFFEE` must resolve to one
merchant. The `*` after a processor prefix is a *separator*, so it is consumed
with the prefix rather than treated as noise — an earlier version stripped
`*<word>` wholesale and deleted the merchant name itself.

**Seasonality** is a multiplicative index per calendar month, meaningful only
with two or more years of history. **Anomaly detection** uses a robust z-score
(median + MAD) rather than mean and standard deviation, because the mean is
dragged around by the very outliers being looked for.

*Verified on the demo account:* all 10 seeded recurring charges found, fixed
subscriptions scored 0.95 confidence and variable utility bills 0.60–0.68, and
December (1.89×) and August (1.46×) correctly identified as the seasonal peaks.

## 2. Forecasting — two implementations, on purpose

### Production: `services/ai` (Python)

Model selection is driven by how much history exists, because fitting a
seasonal model to eight months produces confident nonsense:

| History | Model | Why |
|---|---|---|
| < 4 months | Flat mean, wide interval, loud warning | Nothing to infer a direction from |
| 4–23 months | Holt's linear trend, **damped** | Trend without a full seasonal cycle |
| ≥ 24 months | Holt-Winters, additive, 12-period seasonal | Two cycles is the minimum to fit one |

The trend is damped (`damped_trend=True`) because personal finance series are
short, and an undamped uptrend extrapolated twelve months out produces numbers
no user believes.

Any fit failure degrades to a recent-window mean rather than raising — a
forecast endpoint that 500s takes the whole dashboard with it.

### Fallback: `packages/core/src/forecast.ts` (TypeScript)

Holt's linear method with damping, in-process, in milliseconds. It runs when
the Python service is cold, rate-limited or unreachable. The response says
which model produced it, so a degraded number is never passed off as the full
one.

### Prediction intervals are the point

A single confident line implies a precision the model does not have. Intervals
widen with the **square root** of the horizon — the standard random-walk
assumption, making month 6 about 2.4× as uncertain as month 1, not 6×.

A month is flagged as a shortfall on the **pessimistic** path (income at its
lower bound, expenses at their upper), not the central estimate. Warning only
once a shortfall is certain leaves no time to act on it.

### One bug worth recording

The forecast initially projected expenses collapsing to **£0**. The cause was
the history including the *current, partial* month: on the 1st it held a single
day of spending, which the seasonal fit read as a catastrophic drop in outgoings
and extrapolated forward.

The fix is `completeMonthsOnly()` — forecasts are built only from finished
months. The current month is handled by the budget's month-end projection,
which knows how far through the month it is. A regression test pins it.

## 3. Recommendations — `packages/core/src/recommendations.ts`

Deterministic rules over the snapshot. Each returns a title, a body, a
quantified monthly impact, a priority, and **`evidence`** — the exact inputs
behind the finding, rendered in the UI beneath the advice.

| Rule | Fires when | Guard |
|---|---|---|
| `CASHFLOW_WARNING` | Balance dips below zero in the forecast | Outranks everything else |
| `REDUCE_CATEGORY_SPEND` | Discretionary category ≥20% above its own median | Never essentials; suggests closing 75% of the gap, not all of it |
| `REFINANCE_DEBT` | A balance at ≥15% APR | Quantified against a realistic ~9% consolidation rate |
| `INCREASE_DEBT_PAYMENT` | A monthly surplus exists | Uses the real payoff simulation, not a heuristic |
| `MOVE_CASH_TO_SAVINGS` | Cash well past a full emergency fund | **Suppressed while any debt ≥8% APR is open** |
| `BUILD_EMERGENCY_FUND` | Buffer below target | — |
| `CANCEL_SUBSCRIPTION` | ≥3 high-confidence recurring charges ≥5% of income | Only charges at ≥0.75 confidence |

The comparison is always against **the user's own history**, never a population
average. "You spend more on food than the average household" is noise; "you
spend 34% more on food than you usually do" is a fact they can act on.

Findings below a minimum impact are dropped entirely. An interruption that
saves someone £2 a month costs more attention than it returns.

### Financial health score

Four weighted components, 0–100:

| Component | Weight | Measure |
|---|---|---|
| Savings rate | 0.30 | Against a 20% benchmark |
| Emergency buffer | 0.25 | Months of expenses covered, target 6 |
| Debt load | 0.25 | **Payment**-based DTI: full marks below 20%, zero at 43% |
| Cash-flow stability | 0.20 | Projected shortfall months |

Debt is scored on *payment burden*, not balance. Balance-to-income scores
anyone with a mortgage at zero — £250k against a £50k salary is 500%, which
says nothing about whether the debt is manageable. Lenders use payment DTI for
exactly that reason, and the thresholds (20% comfortable, 36% conventional
ceiling, 43% where lending stops) are well established.

## 4. The language interface

### What the model receives

An aggregated snapshot, never a transaction list: monthly income and expenses,
per-category spend with each category's own historical median, debts with APRs,
detected recurring charges, and the forecast. All amounts arrive
**pre-formatted as strings** (`"£1,450.00"`), so the model has nothing to
compute and no unit to misread.

That keeps the prompt small, inference fast, and the personal data crossing
into the model to the minimum that answers the question.

### Prompt injection

Merchant names, category names and notes are user-controlled text that ends up
inside the prompt. Three defences:

1. The data block is **fenced and labelled** (`=== FINANCIAL DATA … ===`).
2. The system prompt states that everything inside it is **data, not
   instruction**, and that anything resembling a command should be ignored and
   flagged.
3. The model has **no tools and no database access**. Even a fully successful
   injection has nothing to escalate to — it can influence one sentence of one
   reply to the person who typed the injection.

A unit test asserts that hostile merchant text lands inside the fence and
cannot break out of it.

### Why a local model

Ollama running `llama3.2:3b` by default; Mistral, Phi and DeepSeek variants are
drop-in via `ECO_LLM_MODEL`.

Sending a user's complete financial position to a third-party API is not a
trade we are willing to make on their behalf. A 3B model is enough for the job
it is actually given — selecting from pre-computed figures and phrasing them —
and it means the deployment owner keeps the data.

Cost: roughly 28 seconds per answer on 6 CPU cores. A GPU node brings that
under 3 seconds; the compose file has the device reservation commented in.

### Verified behaviour

Against the demo account, running the full stack:

- *"What category wastes most of my money?"* → identified Shopping at £448.76 —
  a real figure from the ledger.
- *"How much do I have in my Bitcoin wallet?"* → **refused**, and stated
  exactly which data it does have. No hallucinated balance.
- *"Can I afford a £3,000 vacation next summer?"* → used the projected balance
  correctly.

### The limitation, stated plainly

On the affordability question the model performed a subtraction. The system
prompt forbids arithmetic beyond comparison, and the answer happened to be
correct — but a 3B model is not a calculator, and "happened to be correct" is
not a guarantee.

The fix is tool-calling: `affordabilityCheck()` already exists in `@eco/core`,
fully tested. Wiring the model to call it rather than compute is a phase-3 item
and is tracked on the roadmap. Until then, affordability answers should be read
as indicative.

## Scheduled work

| Job | Cadence | Guard |
|---|---|---|
| Nightly insights | 02:00 | Distributed lock; active users only (30-day window); one user's bad data cannot stop the batch |
| Pattern recomputation | On significant change | Cached in `spending_patterns` with a TTL |
| Forecast accuracy | Post-hoc | `ForecastSnapshot.realisedError` — we measure our own error |
| Budget alerts | Every 6h | Deduped per category per status per month |
| Bill reminders | 08:00 | Deduped per debt per month |

`ForecastSnapshot` retains every forecast so that once the month arrives the
prediction can be compared against reality. A forecasting feature that never
measures its own accuracy is a guess with a chart on it.
