/**
 * @flowcache/shared — errors.ts
 *
 * A small, deliberate error hierarchy. Every error carries an HTTP
 * status code and a machine-readable `code` so the gateway's error
 * middleware can translate any thrown error into a consistent JSON
 * response without special-casing strings.
 */

export abstract class FlowCacheError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export class KeyNotFoundError extends FlowCacheError {
  readonly httpStatus = 404;
  readonly code = 'KEY_NOT_FOUND';
  constructor(key: string) {
    super(`Key not found: "${key}"`);
  }
}

export class ConfigurationError extends FlowCacheError {
  readonly httpStatus = 500;
  readonly code = 'CONFIGURATION_ERROR';
}

export class ValidationError extends FlowCacheError {
  readonly httpStatus = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class NodeUnavailableError extends FlowCacheError {
  readonly httpStatus = 503;
  readonly code = 'NODE_UNAVAILABLE';
  constructor(nodeId: string, cause?: unknown) {
    super(`Cache node unavailable: "${nodeId}"`, cause);
  }
}

export class NoHealthyNodesError extends FlowCacheError {
  readonly httpStatus = 503;
  readonly code = 'NO_HEALTHY_NODES';
  constructor() {
    super('No healthy cache nodes are available in the ring');
  }
}

export class ReplicationError extends FlowCacheError {
  readonly httpStatus = 500;
  readonly code = 'REPLICATION_ERROR';
}

export class SnapshotError extends FlowCacheError {
  readonly httpStatus = 500;
  readonly code = 'SNAPSHOT_ERROR';
}

export class RecoveryError extends FlowCacheError {
  readonly httpStatus = 500;
  readonly code = 'RECOVERY_ERROR';
}

export class CapacityExceededError extends FlowCacheError {
  readonly httpStatus = 507;
  readonly code = 'CAPACITY_EXCEEDED';
}

export function isFlowCacheError(err: unknown): err is FlowCacheError {
  return err instanceof FlowCacheError;
}

/** Serializes any thrown value into a stable shape for HTTP responses. */
export function toErrorResponse(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (isFlowCacheError(err)) {
    return { status: err.httpStatus, body: err.toJSON() };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message } },
  };
}