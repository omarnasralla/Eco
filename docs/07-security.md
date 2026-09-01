# Security

## Threat model

What this system is actually protecting, in priority order:

1. **One user reading another user's finances.** The worst outcome. Defended at
   two independent layers.
2. **Account takeover.** Someone's complete financial position, plus the ability
   to alter it.
3. **Data at rest.** A database dump must not yield usable secrets.
4. **The AI layer as a new attack surface.** Prompt injection, and data leaving
   the deployment.

## Tenant isolation — two independent layers

**Layer 1 — the application.** Every user-owned query filters on `userId`.
Every service method takes it as an explicit argument rather than reading
ambient state, which makes the tenant boundary visible in each signature.

**Layer 2 — Postgres RLS.** The application connects as `eco_app`, which is not
the table owner and has no `BYPASSRLS`. Each transaction sets
`app.current_user_id`, transaction-scoped so a pooled connection cannot carry
one user's identity into another's request. Every policy compares against it.

A query that forgets its `where` clause returns **zero rows**, not another
user's data. Verified: every table except `_prisma_migrations` and the shared
`exchange_rates` reference table has RLS enabled and forced.

*Tested:* a second account receives 404 on another user's expense by id, 404 on
attempting to delete it, and an empty list — while the owner still sees it.

## Authentication

### Passwords
Argon2id, 64MiB memory cost, 3 iterations, parallelism 4 — the OWASP
recommendation. Minimum 12 characters, no composition rules: NIST SP 800-63B is
explicit that length beats forced symbols, which mostly produce `Password1!`.

### Access tokens
JWT, 15 minutes, signed with a secret distinct from the refresh secret — if they
were the same, a leaked access token could be replayed as a refresh token.
Validation checks signature, issuer, audience, expiry, that the account still
exists, and that the token predates no revocation.

That last check uses `User.tokensValidFrom`, bumped on password change and on
"sign out everywhere". It kills unexpired access tokens without a table scan.

> **A bug found and fixed here.** JWT `iat` is whole seconds (RFC 7519) while
> `tokensValidFrom` carries milliseconds. Comparing them directly rejected any
> token issued at `12:00:00.4` against a watermark of `12:00:00.750` — which was
> *every* token handed out at registration. Every new user got a 401 on their
> first request. The fix truncates the watermark to second granularity; the cost
> is a sub-second window, and the refresh token is revoked outright regardless.

### Refresh tokens — rotation with reuse detection
Opaque 48-byte CSPRNG values, not JWTs: they are presented to exactly one
endpoint, so they need no self-describing claims, and an opaque token cannot be
decoded by whoever intercepts it. Only SHA-256 digests are stored.

Every refresh rotates the token and retires the old one, linked by `familyId`.
If a **retired** token is presented again, either the legitimate client is
replaying or an attacker holds a stolen copy — and we cannot tell which. The
entire family is revoked. That is the OAuth 2.0 BCP response, and it converts a
silent, indefinite compromise into one visible logout.

> The client makes this workable: a single in-flight refresh promise is shared
> by every caller. Without it, a dashboard firing six parallel requests would
> trigger six concurrent refreshes, five of which would present an
> already-rotated token — which the server would correctly read as theft and
> punish by logging the user out.

### Two-factor
TOTP (RFC 6238), one step of clock drift. The secret is encrypted at rest with
AES-256-GCM, so a database dump alone does not let an attacker generate codes.
Recovery codes are Argon2-hashed and single-use.

Enrolment is two-step: the secret is generated, but 2FA is **not** enabled until
the user proves they can produce a valid code — otherwise a mis-scanned QR locks
them out permanently. Disabling requires the current password, so a momentarily
unlocked device is not enough to strip the second factor.

### Lockout
Eight failed attempts freezes the account for 15 minutes. Enough to stop
credential stuffing, short enough that an attacker cannot lock a victim out
permanently by guessing at their address.

### Account enumeration
- Registration with an existing address returns the same message as success,
  and emails the **real owner** that someone tried.
- Password reset always returns 204.
- Login hashes a dummy password when the account does not exist, so both paths
  take the same time.

## Encryption

**In transit:** TLS 1.2+ at the ingress, HSTS with `preload`, `sslmode=require`
to Postgres (enforced by boot-time validation in production).

**At rest:** database-level encryption is the provider's responsibility.
Application-level AES-256-GCM protects the columns that hold secrets — TOTP
seeds and OAuth provider tokens.

The envelope is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
prefix is what makes rotation possible: a job can decrypt v1 and re-encrypt as
v2 without a flag day, because every row says which key made it. GCM
authenticates as well as encrypts, so tampering fails loudly.

## OWASP Top 10

| Risk | Mitigation |
|---|---|
| A01 Broken access control | RLS + explicit `userId` filtering; global auth guard, opt-out not opt-in |
| A02 Cryptographic failures | Argon2id, AES-256-GCM, SHA-256 token digests, TLS everywhere |
| A03 Injection | Prisma parameterises everything; the two raw queries use tagged templates. Zod validates every input |
| A04 Insecure design | Rate limits per operation class; lockout; short token lifetimes; deletes are soft |
| A05 Misconfiguration | Boot-time env validation **refuses to start** on placeholders; helmet; restricted PSS; default-deny network policy |
| A06 Vulnerable components | Pinned versions; Trivy in CI failing on HIGH/CRITICAL; unused deps removed |
| A07 Auth failures | Rotation with reuse detection, 2FA, lockout, enumeration resistance |
| A08 Integrity failures | Append-only audit log, enforced by grant not convention |
| A09 Logging failures | Structured logs with request ids; audit trail; **request bodies never logged** |
| A10 SSRF | No user-supplied URL is ever fetched. Outbound calls go to configured hosts only |

## What is deliberately never logged

Request bodies. They contain salaries, debts, merchant names and notes. Not at
debug level either. Logs carry method, route *pattern*, status, duration, user
id and request id — enough to debug, insufficient to reconstruct anyone's
finances.

The audit log records field-level changes, but the serialiser redacts any key
matching `pass|secret|token|hash|otp|recovery|authorization|cookie`,
recursively.

## AI-specific security

**Data never leaves the deployment.** Ollama runs a local model. Sending a
user's complete financial position to a third-party API is not a trade to make
on their behalf.

**The model has no tools and no database access.** It receives a pre-computed,
aggregated snapshot — never a transaction list, never a query interface.

**Prompt injection is contained rather than filtered.** Merchant names and notes
are user-controlled text inside the prompt. The data block is fenced and
labelled as data; the system prompt says to ignore instructions found inside it.
But the real defence is that there is nothing to escalate to: a fully successful
injection influences one sentence of one reply to the person who typed it. A
unit test asserts hostile merchant text stays inside the fence.

**The AI service is never publicly exposed.** Internal-only, authenticated by a
shared token compared with `hmac.compare_digest`, and the network policy admits
only the API pod.

## Compliance

- **GDPR Art. 15/20** — `GET /users/me/export` returns everything held, as JSON.
- **GDPR Art. 17** — `DELETE /users/me` soft-deletes and kills every session
  immediately; a hard purge follows after 30 days. Audit rows are anonymised
  rather than deleted, satisfying both erasure and security-record retention.
- **Audit trail** — append-only, with IP, user agent and request id.
- **PCI DSS** — not in scope. Eco stores no card numbers. Debts reference a
  lender and a balance, never a PAN.

## Known gaps

- **Access tokens live in `localStorage`**, readable by any script achieving XSS
  on the origin. Mitigated by a strict CSP, `X-Frame-Options: DENY`, and the
  15-minute lifetime. The httpOnly-cookie path is supported by the API and is
  the phase-3 default for web; the current approach exists so the same client
  code runs unmodified on React Native, where cookies are unavailable.
- **No CSRF tokens**, because there are no cookie-authenticated state-changing
  endpoints. This must be revisited the moment cookies are adopted.
- **No WAF or bot protection** beyond application rate limiting.
- **Dependency scanning is CI-only**; runtime SBOM monitoring is not set up.
