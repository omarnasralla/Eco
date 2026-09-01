# ── Eco web image ────────────────────────────────────────────────────────────
# Uses Next.js `output: 'standalone'`, which traces the exact module graph the
# server needs. The result is ~180MB instead of ~1.2GB with node_modules intact.

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspace @eco/web --workspace @eco/shared --workspace @eco/core --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so the
# API URL is a build argument rather than a runtime variable.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @eco/shared \
 && npm run build --workspace @eco/core \
 && npm run build --workspace @eco/web

FROM build AS development
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev", "--workspace", "@eco/web"]

FROM base AS production
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
