# syntax=docker/dockerfile:1.7
#
# docker/dashboard.Dockerfile
#
# Two stages:
#   1. build   — installs the workspace, compiles the type-only
#                dependencies the dashboard imports from
#                (@flowcache/shared, @flowcache/metrics — it needs
#                their `dist/*.d.ts` for TypeScript to resolve types;
#                it does NOT need their `dist/*.js`, since Vite bundles
#                the dashboard's own code and never executes those
#                packages at runtime), then runs `vite build`.
#   2. runtime — a plain nginx image serving the static build output,
#                configured (see nginx.dashboard.conf) to proxy API
#                calls through to the gateway container.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage-engine/package.json packages/storage-engine/package.json
COPY packages/eviction/package.json packages/eviction/package.json
COPY packages/consistent-hash/package.json packages/consistent-hash/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/snapshot/package.json packages/snapshot/package.json
COPY packages/worker-pool/package.json packages/worker-pool/package.json
COPY packages/replication/package.json packages/replication/package.json
COPY packages/benchmark/package.json packages/benchmark/package.json
COPY services/cache-node/package.json services/cache-node/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN npm install

COPY packages/shared packages/shared
COPY packages/metrics packages/metrics
COPY apps/dashboard apps/dashboard

# Only build the two packages the dashboard actually imports types
# from — no need to compile the rest of the monorepo for a static
# frontend build.
RUN npx tsc -b packages/shared packages/metrics
RUN npm run build -w apps/dashboard

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY docker/nginx.dashboard.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider -q http://localhost/ || exit 1