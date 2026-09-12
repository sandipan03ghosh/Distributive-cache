/**
 * @flowcache/gateway — GatewayContext.ts
 */

import type { Logger } from '@flowcache/shared';
import type { ConsistentHashRing } from '@flowcache/consistent-hash';
import type { CacheNodeClient } from './discovery/CacheNodeClient.js';

export interface GatewayContext {
  logger: Logger;
  ring: ConsistentHashRing;
  client: CacheNodeClient;
  /** How many ring candidates (primary + replicas) to try, in order,
   *  before giving up on a request with NoHealthyNodesError. */
  replicationFactorForFailover: number;
}