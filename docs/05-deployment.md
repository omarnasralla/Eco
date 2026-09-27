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

## The VM this actually runs on

The Kubernetes manifests above describe the intended production shape. The
machine serving the app today is a single VM, arranged like this:

| Piece | How it runs |
|---|---|
| Postgres, Redis, Ollama | Containers, `restart: unless-stopped` |
| API (`:9000`) and web (`:3000`) | systemd units `eco-api`, `eco-web`, loopback only |
| Edge (`:80`, `:443`) | A shared Caddy container, `ospos-gateway-caddy-1` |

Caddy is not this project's — it is the machine's edge, terminating TLS for
several applications, and its Eco route lives in that gateway's
`extra/eco.caddy`. It reaches these two loopback services through socat relays
on the Docker bridge, because a container cannot dial the host's `127.0.0.1`
and widening the bind would publish an internal API to the internet.

Deploy with [`scripts/redeploy.sh`](../scripts/redeploy.sh) `[api|web|all]`. It
builds, then `systemctl restart`s the unit and waits on the health endpoint;
for web it also stages Next's `static/` and `public/` beside the standalone
output and swaps them in with a rename, so there is no window where the app
serves HTML with no assets. Logs stay in `/var/log/eco/{api,web}.log` — the
units append there rather than writing to the journal.

Both units are **enabled**, so they start at boot and restart on crash. That is
not a precaution; it is a repair. Both services used to be started by hand from
a shell, and when an unattended kernel upgrade rebooted the machine on
2026-09-22 they did not come back. The containers did, so Caddy kept answering
and returned 502 for a day.

A 502 from the edge means the upstream is not listening. In order:

```bash
systemctl status eco-api eco-web        # units up?
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/eco/api/v1/health/live
docker exec ospos-gateway-caddy-1 wget -qO- http://127.0.0.1:2019/config/ | head -c 200
```

That last one has been empty once: the gateway's site files are bind-mounted,
the directories were replaced on the host, and the container kept pointing at
the old empty ones — so a reload adapted to `{}` and every site on the machine
went dark. `caddy validate` passes on an empty config, so neither the reload
guard nor the healthcheck caught it. Restarting the container re-mounts the
real directories.

## Backups

[`scripts/backup-db.sh`](../scripts/backup-db.sh) dumps `eco` out of the
Postgres container into `/var/backups/eco` (`ECO_BACKUP_DIR`), keeping the 12
most recent archives (`ECO_BACKUP_KEEP`). Root's crontab runs it on the 1st of
each month at 03:30, logging to `/var/log/eco/backup.log`:

```
30 3 1 * * /root/Eco/scripts/backup-db.sh --verify >> /var/log/eco/backup.log 2>&1
```

The database is the whole backup: reports render in memory rather than to disk,
and Redis holds only cache, sessions and rate-limit counters.

This is the operator's backup: everything, one file, restorable into a database.
Users have their own, separately — *Settings → Your data → Download backup*
(`GET /users/me/export`), which hands one user their own rows as JSON. Neither
replaces the other: a user's export cannot rebuild the service, and a database
dump is not something to hand a person who asks for their data.

`--verify` restores each fresh dump into a scratch database, counts what came
back and drops it — so a dump that cannot be restored is discovered on the 1st
rather than during an outage. Every run also reads the archive's table of
contents back through `pg_restore --list` before accepting it.

Restore, in full or one table:

```bash
docker exec -i eco-postgres pg_restore -U eco -d eco --clean --if-exists \
  --no-owner --no-privileges < /var/backups/eco/eco-<stamp>.dump

# One table, into a running database:
docker exec -i eco-postgres pg_restore -U eco -d eco --data-only \
  -t expenses --no-owner < /var/backups/eco/eco-<stamp>.dump
```

**`ENCRYPTION_KEY` is not in the dump, on purpose.** 2FA secrets are AES-256-GCM
encrypted at rest, so an archive stored beside the key is an archive with no
encryption at all. Keep the key somewhere the backup directory is not; restoring
without it recovers everything except those columns.

Still open, and worth closing before this carries real money:

- **Off-host copies.** Archives sit on the machine they back up, which survives
  a bad migration but not a dead disk. Point `ECO_BACKUP_DIR` at mounted remote
  storage, or add an upload step.
- **Point-in-time recovery.** Monthly snapshots mean up to a month of loss.
  Continuous archiving (WAL shipping) or a managed provider's PITR is the fix;
  the cadence here is a floor, not a target.
- **Longer `audit_logs` retention** than the main window, for compliance.
