/**
 * @flowcache/gateway — middleware/errorHandler.ts
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