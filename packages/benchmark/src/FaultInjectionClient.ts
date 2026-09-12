/**
 * @flowcache/benchmark — FaultInjectionClient.ts
 *
 * Sends `FaultInjectionCommand`s (kill node, restart node, delay
 * replication, drop messages — see `FaultInjectionCommand` in
 * @flowcache/shared) to a target cache node's internal admin endpoint,
 * so stress-test scenarios can verify FlowCache's fault tolerance and
 * recovery behavior under controlled, repeatable failure conditions
 * rather than only under organic failures.
 *
 * Expects the target's cache-node service to expose
 * `POST /internal/fault-injection` (see `services/cache-node`'s
 * internal routes).
 */

import type { FaultInjectionCommand } from '@flowcache/shared';

export class FaultInjectionClient {
  async sendCommand(targetBaseUrl: string, command: FaultInjectionCommand): Promise<void> {
    const response = await fetch(`${targetBaseUrl}/internal/fault-injection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(
        `Fault injection command "${command.type}" against ${targetBaseUrl} failed with status ${response.status}` +
          (body ? `: ${body}` : ''),
      );
    }
  }

  /** Convenience wrapper: kill a node, wait `downtimeMs`, then send it
   *  a RESTART command — the standard "verify recovery" stress test
   *  scenario (does the node correctly restore from its latest
   *  snapshot + replay replication events it missed while down?). */
  async killAndRestart(targetBaseUrl: string, nodeId: string, downtimeMs: number): Promise<void> {
    await this.sendCommand(targetBaseUrl, { type: 'KILL', targetNodeId: nodeId });
    await sleep(downtimeMs);
    await this.sendCommand(targetBaseUrl, { type: 'RESTART', targetNodeId: nodeId });
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}