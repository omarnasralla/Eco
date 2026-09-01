import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Stamps every request with an id, echoed in the `X-Request-Id` header and in
 * every error body. When a user reports "it failed at 14:32", that id is what
 * turns a vague report into one log line.
 *
 * An inbound id from the edge proxy is trusted and reused so a trace spans the
 * whole system, but it is length-capped — the header is user-controlled input.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const inbound = req.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    req.id = candidate && candidate.length <= 64 ? candidate : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  }
}
