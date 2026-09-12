/**
 * @flowcache/gateway — index.ts
 */

import { loadGatewayConfig, createLogger } from '@flowcache/shared';
import { GatewayServer } from './GatewayServer.js';

const bootLogger = createLogger({ service: 'gateway-bootstrap' });

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const server = new GatewayServer(config);

  await server.start();

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
  bootLogger.fatal({ err }, 'Gateway failed to start');
  process.exit(1);
});