# Frontend

Next.js 15 (App Router), React 19, TypeScript, Tailwind, Radix primitives.
**14 routes.** Mobile-first, not mobile-adapted.

## Screens

| Route | Purpose |
|---|---|
| `/login` | Sign in; swaps in-place to a TOTP field when 2FA is required |
| `/register` | Name, email, password, currency (timezone auto-detected) |
| `/forgot-password` | Always reports success — no enumeration oracle |
| `/dashboard` | Four stat tiles, savings rate, trend, category breakdown, forecast, upcoming bills, recommendations, health score |
| `/expenses` | Filterable list, keyset pagination, add sheet |
| `/income` | Sources with monthly-equivalent normalisation |
| `/debts` | Balances, payoff-at-minimum, snowball vs avalanche, schedule chart |
| `/budgets` | Month navigation, overall and per-category progress, projection |
| `/goals` | Progress, required monthly, on-track status |
| `/assistant` | Eco AI chat with data-aware follow-up chips |
| `/reports` | PDF / Excel / CSV export |
| `/settings` | Profile, currency, theme, 2FA status, active sessions |

## Mobile-first, structurally

Not "responsive as an afterthought": the Tailwind config has **no `screens`
overrides**, so every unprefixed utility *is* the phone layout and `sm:`/`lg:`
only add to it. You cannot accidentally write desktop-first CSS.

- **Navigation splits by viewport.** A fixed bottom tab bar below `lg`, a
  sidebar above it. The tab bar is capped at five destinations — a sixth turns
  a tap target into a guess.
- **44px minimum touch targets** on every button and input. That is the
  iOS/Android floor, not a design preference.
- **16px base font on inputs.** Below that, iOS Safari zooms the viewport on
  focus, which is jarring and hard to undo.
- **Dialogs are bottom sheets on phones**, centred modals from `sm` up. Same
  component, two idioms, each what that platform's users expect.
- **`env(safe-area-inset-bottom)`** so the tab bar clears the home indicator.
- **Zoom is not disabled.** `maximumScale: 5` — locking zoom fails WCAG 1.4.4.

## Charts

Built on Recharts, following a validated design method rather than taste.

### The palette is computed, not chosen

The twelve seeded category colours were selected by search and verified with a
colour-vision validator. The original hand-picked set **failed**: its
"Investments" `#10b981` and "Travel" `#22c55e` scored ΔE 6.3 to *normal* colour
vision — effectively the same green on a chart — and two other pairs were
indistinguishable under deuteranopia.

The replacement scores **ΔE 13.2 on the worst adjacent pair under
deuteranopia** (target ≥ 8) and **16.7 under normal vision** (hard floor 15).

Order matters, because the checks run on adjacent pairs and these categories
render in this order in pickers and legends. A semantic preference (food →
orange, healthcare → red, investments → green) was applied only as a tie-break
*above* the accessibility gate, never traded against it.

Every colour also sits inside the OKLCH lightness band that light and dark mode
**share** (0.48–0.67), so one stored hex is legible on white and on near-black.
Users pick their own category colours, so `adaptToSurface()` clamps any
arbitrary colour into the target band at render time, preserving hue and
chroma — a deep violet chosen on white does not vanish against a dark card.

"Miscellaneous" is deliberately neutral gray: it is the "everything else"
bucket, gray is the honest reading, and it is never the only cue because chips
always carry a name and an icon.

### Colour carries meaning, so it is spent carefully

Green and red mean money in and money out. That is why:

- **Chart series use neutral categorical slots**, not green/red. On a line chart
  there is no arrow to fall back on when a reader cannot separate those hues.
- **Deltas use green/red** — but never alone. Every one ships with an arrow
  glyph (▲/▼) and an explicit sign, so the meaning survives colour-vision
  deficiency, greyscale printing and forced-colours mode.
- **`invertDelta`** exists because up is not always good: rising income is
  positive, rising expenses is not.

### Form follows the question

- **Income vs expenses** → line + area wash. Two series, legend always present.
- **Category spending** → horizontal bar list, not a pie. The job is comparing
  magnitudes, and length on a shared baseline is what people read most
  accurately. Bars carry their own labels; a pie forces colour-matching for
  every slice. Beyond seven categories the tail folds into "Other" rather than
  putting twelve hues on screen at once.
- **Cash-flow forecast** → line with an 80% prediction band. The band is the
  point: a single confident line implies precision the model does not have.
  Only shortfall months get a marker — a dot on every point is noise, a dot on
  the one that matters is a signal.
- **Debt payoff** → one line per debt, capped at five with the tail summed.

Marks follow fixed specs: 2px lines with round caps, ≥8px markers with a 2px
surface ring, area fills at ~10% opacity, hairline solid gridlines one step off
the surface, and **text never wears the data colour** — identity comes from a
coloured dot beside the label.

## State

- **TanStack Query** for server state. 60s stale time: financial data changes
  when the user changes it, not on a timer. 4xx responses are never retried —
  retrying a rejection just repeats it.
- **Query keys are domain-prefixed**, so a mutation invalidates a whole subtree.
  Writing an expense invalidates the dashboard too, because it changes both.
- **Each dashboard widget owns its query**, so a slow forecast never blocks the
  headline numbers. The page fills in progressively.

### The auth state model, and the bug that shaped it

`isAuthenticated` is derived from **token presence**, not from whether the
profile fetch succeeded.

The first version derived it from `user !== null`, and a rate-limited
`/users/me` therefore read as "signed out" and bounced the user to `/login`
mid-session. Two fixes followed:

1. Only a **401/403** ends a session. A 429 or a 5xx is transient — destroying
   tokens there loses the user's place over a hiccup.
2. The **profile is cached** alongside the tokens. This is a correctness fix,
   not an optimisation: currency and locale live on the profile, and without
   them the UI fell back to USD and rendered a GBP user's balances with a
   dollar sign. Wrong currency is worse than a loading state.

## Accessibility

- Semantic landmarks, `aria-current` on active navigation, `aria-invalid` and
  linked error text on fields, `role="alert"` on form errors.
- Visible focus rings for keyboard users, suppressed for pointer users.
- `prefers-reduced-motion` honoured rather than overridden.
- Colour is never the sole carrier of meaning — icons, labels and signs
  accompany it everywhere.
- Charts have text alternatives; the category list is readable as a table.
- Zoom to 500% permitted.

## Performance

Production build: **103kB shared JS**, largest route 272kB (the dashboard, which
loads Recharts). All 14 routes prerender as static shells and hydrate with
client data.

Tabular figures (`font-variant-numeric: tabular-nums`) on every money column, so
digits line up and a balance does not shimmy as it updates.
