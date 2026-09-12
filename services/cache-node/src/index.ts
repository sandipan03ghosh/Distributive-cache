/**
 * @flowcache/cache-node — index.ts
 *
 * Process entrypoint. Loads config from the environment, starts a
 * `CacheNodeServer`, and wires SIGTERM/SIGINT to a graceful shutdown
 * (final snapshot, clean Kafka disconnect, worker pool teardown)
 * rather than letting Docker/Kubernetes hard-kill the process.
 */

import { loadCacheNodeConfig, createLogger, sleep, type CacheNodeConfig } from '@flowcache/shared';
import { CacheNodeServer } from './CacheNodeServer.js';

const bootLogger = createLogger({ service: 'cache-node-bootstrap' });

/** Cold-start races are common here: on a fresh Kafka broker with
 *  auto-create-topics enabled, the first client to touch a topic can
 *  hit a brief window where the topic exists but its partition leader
 *  hasn't been elected yet ("This server does not host this
 *  topic-partition"). That's transient and self-resolving within a
 *  second or two — retrying the whole startup sequence a few times
 *  with backoff rides it out instead of the node giving up on its
 *  very first attempt. A fresh `CacheNodeServer` is constructed per
 *  attempt (rather than reusing one across retries) since a failed
 *  attempt may have partially spun up workers/connections that
 *  shouldn't be reused; `stop()` best-effort tears those down before
 *  the next attempt. */
const MAX_START_ATTEMPTS = 5;
const START_RETRY_BASE_DELAY_MS = 1_000;

async function startWithRetry(config: CacheNodeConfig): Promise<CacheNodeServer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    const server = new CacheNodeServer(config);
    try {
      await server.start();
      return server;
    } catch (err) {
      lastErr = err;
      await server.stop().catch(() => undefined);
      if (attempt < MAX_START_ATTEMPTS) {
        const delayMs = START_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        bootLogger.warn(
          { err, attempt, maxAttempts: MAX_START_ATTEMPTS, retryInMs: delayMs },
          'Cache node failed to start; retrying after backoff',
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const config = loadCacheNodeConfig();
  const server = await startWithRetry(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info({ signal }, 'Received shutdown signal');
    try {
      await server.stop();
      process.exit(0);
    } catch (err) {
      bootLogger.error({ err }, 'Error during graceful shutdown; forcing exit');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  bootLogger.fatal({ err }, 'Cache node failed to start');
  process.exit(1);
});