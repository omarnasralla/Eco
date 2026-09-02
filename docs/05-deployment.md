# Deployment

## Local development

```bash
git clone <repo> && cd Eco
cp .env.example .env

# Generate real secrets — the API refuses to boot on the placeholders.
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env

docker compose up -d
docker compose exec api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
docker compose exec api npm run prisma:seed --workspace @eco/api
docker compose exec ollama ollama pull llama3.2:3b
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:9000/eco/api/v1 |
| API docs | http://localhost:9000/eco/api/v1/docs |
| AI service | http://localhost:8000/docs |
| Mail catcher | http://localhost:8025 |

Demo account: `demo@eco.app` / `demo-password-2026` — 24 months of history,
three debts with payment records, three savings goals, a rolling budget.

Without Docker: `npm install && npm run build:packages && npm run dev`, with
Postgres and Redis reachable at the URLs in `.env`.

## Images

Three multi-stage builds. Each has a `development` target (toolchain retained,
used by compose) and a `production` target.

| Image | Size | Notes |
|---|---|---|
| `eco-api` | ~750MB | Prisma CLI and TypeScript stripped from the serving image |
| `eco-web` | ~200MB | Next.js `output: 'standalone'` traces the exact module graph |
| `eco-ai` | ~840MB | numpy + statsmodels; unavoidable for scientific Python |

The API image has a fourth target, `migrate`, which keeps the Prisma CLI and
runs `prisma migrate deploy`. The Kubernetes `initContainer` uses it. Splitting
it out removes ~110MB of migration tooling from the image that serves user
traffic — pull latency on every scale-up, and CVE surface for the life of the
deployment, in exchange for nothing at runtime.

All three run as a non-root user, with `readOnlyRootFilesystem`, all
capabilities dropped, and a `HEALTHCHECK` matching the Kubernetes probe.

## Kubernetes

```bash
kubectl apply -k infra/k8s/base
psql "$DATABASE_URL" -f infra/postgres/rls.sql   # once, after first migrate
```

Manifests in [`infra/k8s/base`](../infra/k8s/base):

| File | Contents |
|---|---|
| `namespace.yaml` | Namespace with the **restricted** Pod Security Standard enforced |
| `configmap.yaml` | Non-secret configuration |
| `secrets.example.yaml` | Template only — never applied |
| `api-deployment.yaml` | Deployment, Service, HPA (3–30), PDB, migrate initContainer |
| `web-deployment.yaml` | Deployment, Service, HPA (2–12), PDB |
| `ai-deployment.yaml` | Deployment, Service, HPA (2–10) |
| `ingress.yaml` | nginx, TLS via cert-manager, security headers |
| `network-policy.yaml` | Default-deny plus the five edges the system uses |

### Decisions

**`maxUnavailable: 0`.** The API is the only path to a user's money. A rollout
adds capacity before removing any.

**Migrations run as an initContainer, not a sidecar or a manual step.** No new
pod serves traffic until the schema matches the code it is running.
`migrate deploy` only applies committed migrations — it never generates or
resets — so it is safe on every pod start.

**Liveness and readiness check different things.** Liveness touches nothing
external: if it fails the process is broken and restarting helps. Readiness
checks Postgres and Redis, so a pod with a dead connection pool leaves the load
balancer instead of serving errors. Making *liveness* depend on Postgres would
turn a brief database blip into a cluster-wide restart loop.

**`preStop` sleeps 10 seconds.** Endpoint removal propagates asynchronously;
without the pause, in-flight requests are cut when the process is signalled.

**Default-deny network policy.** Without it, any compromised pod anywhere in the
cluster can reach Postgres. With it, the database accepts connections from the
API and the AI service and nothing else. The AI service is never exposed
through the ingress at all — the API is its only client.

**Asymmetric autoscaling.** Scale out fast (100% every 30s, 30s stabilisation);
scale in slowly (1 pod per minute, 300s stabilisation). A queue of users waiting
on a dashboard is a worse outcome than briefly over-provisioning, and a traffic
trough should not remove capacity that a spike five minutes later needs back.

## Secrets

`secrets.example.yaml` is a template and is excluded from the kustomization.
Real values come from AWS Secrets Manager / GCP Secret Manager / Vault,
synchronised by External Secrets Operator. The Deployments reference them by
name either way, so nothing else changes between environments.

The API validates its environment at boot and **refuses to start** on anything
invalid — a placeholder JWT secret, an `ENCRYPTION_KEY` that is not exactly 32
bytes, identical access and refresh secrets, or a production `DATABASE_URL`
without `sslmode`. A finance API that starts with a placeholder secret and only
reveals it when someone forges a token is far worse than one that fails loudly
at deploy time.

Rotation: `ENCRYPTION_KEY` is versioned in the ciphertext envelope
(`v1.<iv>.<tag>.<data>`), so a rotation job can decrypt v1 and re-encrypt as v2
without a flag day. Rotating `JWT_ACCESS_SECRET` invalidates live access tokens;
clients recover silently via refresh.

## CI/CD

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

1. **Lint and typecheck** every workspace.
2. **Unit tests** — 128 in `@eco/core`, 44 in the AI service. No infrastructure.
3. **Integration** — Postgres and Redis service containers, migrations applied,
   API booted, endpoints exercised.
4. **Build** all three images.
5. **Scan** with Trivy; fail on HIGH/CRITICAL.
6. **Push** to GHCR tagged with the commit SHA.
7. **Deploy** — staging on merge to `main`, production on a tag.

Rollback is `kubectl rollout undo deployment/eco-api -n eco`. Migrations are
written to be backwards-compatible for one release, so the previous image still
runs against the new schema: expand, deploy, contract in the following release.

## Observability

- **Structured JSON logs** with request id, method, route *pattern* (not the
  raw path, so cardinality stays bounded), status, duration, user id.
- **Never logged:** request bodies. They contain salaries, debts and merchant
  names. Not at debug level either.
- **Audit log** is append-only in the database; `eco_app` has no `UPDATE` or
  `DELETE` grant on it.
- **Health probes** at `/eco/api/v1/health/{live,ready}`. There is no
  unprefixed `/health` route: the global prefix has no exclusions, so a probe
  configured against `/health/live` gets a 404.
- **Prometheus annotations** on the API pods.
- `OTEL_EXPORTER_OTLP_ENDPOINT` and `SENTRY_DSN` are wired in configuration and
  are the intended phase-2 additions.

## Backups

Not automated in this repository — it is a managed-database concern, and the
right implementation depends on the provider. The requirements:

- Point-in-time recovery, 30-day retention.
- Restores **tested**, not merely configured. An untested backup is a hypothesis.
- Encrypted at rest with a customer-managed key.
- `audit_logs` retained beyond the main retention window for compliance.
