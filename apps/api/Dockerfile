# ── Eco API image ────────────────────────────────────────────────────────────
# Multi-stage: the final image carries the compiled output, production
# dependencies and the Prisma engines — nothing else. No source, no toolchain,
# no dev packages.

# ── Base ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
# openssl is required by Prisma's query engine; libc6-compat covers the glibc
# symbols some native modules (argon2) expect on musl.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# ── Dependencies ─────────────────────────────────────────────────────────────
# Manifests are copied alone so this layer is cached until a dependency
# actually changes — the difference between a 5-second and a 90-second rebuild.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace @eco/api --workspace @eco/shared --workspace @eco/core --include-workspace-root

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build --workspace @eco/shared \
 && npm run build --workspace @eco/core \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build --workspace @eco/api

# ── Development ──────────────────────────────────────────────────────────────
# Target used by docker-compose: keeps the toolchain for hot reload.
FROM build AS development
ENV NODE_ENV=development
EXPOSE 4000
CMD ["npm", "run", "dev", "--workspace", "@eco/api"]

# ── Migrate ──────────────────────────────────────────────────────────────────
# Runs `prisma migrate deploy` as a Kubernetes initContainer. It is the only
# thing that needs the Prisma CLI, so the CLI lives here rather than in the
# image that serves traffic.
FROM base AS migrate
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
RUN npm ci --omit=dev --workspace @eco/api --workspace @eco/shared --workspace @eco/core --include-workspace-root \
 && npm cache clean --force
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
USER node
CMD ["npx", "prisma", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]

# ── Production ───────────────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/

# Install and prune in ONE layer. A later `rm -rf` would not shrink the image
# at all — the files still exist in the layer that added them, and an image is
# the sum of its layers. Removing them in the same RUN is what actually keeps
# them out.
#
# The running server loads the query engine from .prisma/client and never
# shells out to the CLI, so the CLI, its engines and the TypeScript compiler
# (~110MB) have no business in the image serving user traffic — they are pull
# latency on every scale-up and CVE surface for the life of the deployment.
# Migrations use the `migrate` target above, which keeps them.
RUN npm ci --omit=dev --workspace @eco/api --workspace @eco/shared --workspace @eco/core --include-workspace-root \
 && rm -rf node_modules/prisma \
           node_modules/@prisma/engines \
           node_modules/@prisma/fetch-engine \
           node_modules/@prisma/get-platform \
           node_modules/typescript \
           node_modules/.bin/prisma \
           node_modules/.bin/tsc \
           node_modules/.bin/tsserver \
 && npm cache clean --force

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# The generated client lives in the root node_modules of a workspace install
# and is not reproduced by `npm ci --omit=dev`, so it is copied explicitly.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 4000
# Kubernetes probes this endpoint too; having it in the image means `docker run`
# reports health without extra wiring.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
