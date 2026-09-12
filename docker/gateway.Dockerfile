# syntax=docker/dockerfile:1.7
#
# docker/gateway.Dockerfile
#
# Same two-stage pattern as cache-node.Dockerfile — see that file's
# header comment for the reasoning. The runtime image here only needs
# @flowcache/shared, @flowcache/consistent-hash, @flowcache/metrics,
# and the gateway app itself (no storage-engine, eviction, snapshot,
# worker-pool, or replication — the gateway never touches Kafka or
# local storage).

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.build.json ./
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

COPY packages packages
COPY services/cache-node services/cache-node
COPY apps/gateway apps/gateway

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S flowcache && adduser -S flowcache -G flowcache

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/consistent-hash/package.json packages/consistent-hash/package.json
COPY --from=build /app/packages/consistent-hash/dist packages/consistent-hash/dist
COPY --from=build /app/packages/metrics/package.json packages/metrics/package.json
COPY --from=build /app/packages/metrics/dist packages/metrics/dist

COPY --from=build /app/apps/gateway/package.json apps/gateway/package.json
COPY --from=build /app/apps/gateway/dist apps/gateway/dist

USER flowcache
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/gateway/dist/index.js"]