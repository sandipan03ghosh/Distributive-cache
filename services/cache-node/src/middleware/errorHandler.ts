/**
 * @flowcache/cache-node — middleware/errorHandler.ts
 *
 * Every route in this service calls `next(err)` on failure rather than
 * building its own error response, so this single middleware is the
 * only place that knows how to turn an arbitrary thrown value into an
 * HTTP status + JSON body (via `toErrorResponse` from
 * @flowcache/shared, which every FlowCache error class already
 * supports).
 */

import type { NextFunction, Request, Response } from 'express';
import { toErrorResponse, type Logger } from '@flowcache/shared';

export function errorHandlerMiddleware(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const { status, body } = toErrorResponse(err);

    if (status >= 500) {
      logger.error({ err, method: req.method, path: req.path }, 'Unhandled error while processing request');
    } else {
      logger.debug({ code: body.error.code, method: req.method, path: req.path }, 'Request rejected');
    }

    res.status(status).json(body);
  };
}