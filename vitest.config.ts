/**
 * vitest.config.ts
 *
 * Aliases every `@flowcache/*` workspace package straight to its
 * `src/index.ts` rather than relying on the published `dist/`
 * output — so `npm test` works immediately after `npm install`,
 * without requiring `npm run build` first. Vitest's esbuild-based
 * transform handles the TypeScript directly.
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const src = (pkg: string) => path.resolve(rootDir, `packages/${pkg}/src/index.ts`);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@flowcache/shared': src('shared'),
      '@flowcache/storage-engine': src('storage-engine'),
      '@flowcache/eviction': src('eviction'),
      '@flowcache/consistent-hash': src('consistent-hash'),
      '@flowcache/metrics': src('metrics'),
      '@flowcache/snapshot': src('snapshot'),
      '@flowcache/worker-pool': src('worker-pool'),
      '@flowcache/replication': src('replication'),
      '@flowcache/benchmark': src('benchmark'),
    },
  },
});