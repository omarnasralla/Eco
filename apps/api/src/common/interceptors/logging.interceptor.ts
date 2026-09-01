import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';

/**
 * Structured access logging with duration.
 *
 * Deliberately logs metadata only — method, path, status, latency, user id.
 * Request bodies in this system contain salaries, debts and merchant names, so
 * they never reach a log sink, not even at debug level.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { id?: string; user?: { id: string } }>();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(req, context, started),
        error: () => this.log(req, context, started),
      }),
    );
  }

  private log(
    req: Request & { id?: string; user?: { id: string } },
    context: ExecutionContext,
    started: number,
  ): void {
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    const durationMs = Date.now() - started;

    this.logger.log(
      JSON.stringify({
        requestId: req.id,
        method: req.method,
        // `route.path` is the pattern ("/expenses/:id"), so log cardinality
        // stays bounded and the metrics remain aggregatable.
        path: (req as unknown as { route?: { path?: string } }).route?.path ?? req.url,
        status: res.statusCode,
        durationMs,
        userId: req.user?.id,
      }),
    );
  }
}
