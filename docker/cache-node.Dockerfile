# syntax=docker/dockerfile:1.7
#
# docker/cache-node.Dockerfile
#
# Two stages:
#   1. build   — installs the full workspace, compiles every package
#                this service depends on via TypeScript project
#                references (tsc -b guarantees correct dependency
#                order regardless of npm workspace iteration order),
#                then strips devDependencies.
#   2. runtime — a fresh, minimal image containing only compiled
#                `dist/` output, each package's `package.json` (for
#                workspace resolution), and production node_modules.
#                No TypeScript, no source, no build tooling.
#
# Note: gateway.Dockerfile and dashboard.Dockerfile each independently
# repeat the "install + build the whole workspace" step rather than
# sharing a cached base layer across separate image builds. That's a
# deliberate simplicity-over-build-speed tradeoff for this project;
# a build-speed-optimized setup would use a single multi-target
# Dockerfile (or Turborepo/BuildKit cache mounts) so all three images
# share one compiled `build` stage.

FROM node:20-alpine AS build
WORKDIR /app

# Copy manifests first so `npm install` is cached across rebuilds
# unless a package.json actually changed.
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

RUN addgroup -S flowcache && adduser -S flowcache -G flowcache \
    && mkdir -p /data/snapshots && chown -R flowcache:flowcache /data/snapshots

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/storage-engine/package.json packages/storage-engine/package.json
COPY --from=build /app/packages/storage-engine/dist packages/storage-engine/dist
COPY --from=build /app/packages/eviction/package.json packages/eviction/package.json
COPY --from=build /app/packages/eviction/dist packages/eviction/dist
COPY --from=build /app/packages/consistent-hash/package.json packages/consistent-hash/package.json
COPY --from=build /app/packages/consistent-hash/dist packages/consistent-hash/dist
COPY --from=build /app/packages/metrics/package.json packages/metrics/package.json
COPY --from=build /app/packages/metrics/dist packages/metrics/dist
COPY --from=build /app/packages/snapshot/package.json packages/snapshot/package.json
COPY --from=build /app/packages/snapshot/dist packages/snapshot/dist
COPY --from=build /app/packages/worker-pool/package.json packages/worker-pool/package.json
COPY --from=build /app/packages/worker-pool/dist packages/worker-pool/dist
COPY --from=build /app/packages/replication/package.json packages/replication/package.json
COPY --from=build /app/packages/replication/dist packages/replication/dist

COPY --from=build /app/services/cache-node/package.json services/cache-node/package.json
COPY --from=build /app/services/cache-node/dist services/cache-node/dist

USER flowcache
EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "services/cache-node/dist/index.js"]