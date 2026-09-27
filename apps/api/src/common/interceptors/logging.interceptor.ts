import {
  CallHandler,
  ExecutionContext,
  HttpException,
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
        // The error has to be passed in. Reading res.statusCode on this path
        // gives Nest's default for the verb — 201 for a POST — because the
        // exception filter has not set the real status yet.
        error: (error: unknown) => this.log(req, context, started, error),
      }),
    );
  }

  private log(
    req: Request & { id?: string; user?: { id: string } },
    context: ExecutionContext,
    started: number,
    error?: unknown,
  ): void {
    const res = context.switchToHttp().getResponse<{ statusCode: number }>();
    const durationMs = Date.now() - started;

    // Every failed request used to be logged with the handler's default status.
    // A POST that threw a 409 was recorded as "201", so the access log said a
    // capture succeeded while the phone was being told it had conflicted —
    // and the 4xx was recorded nowhere else, because the exception filter only
    // writes a line for 401, 403 and 5xx. Two days of a missing expense were
    // spent trusting that "201".
    const status = error
      ? error instanceof HttpException
        ? error.getStatus()
        : 500
      : res.statusCode;

    this.logger.log(
      JSON.stringify({
        requestId: req.id,
        method: req.method,
        // `route.path` is the pattern ("/expenses/:id"), so log cardinality
        // stays bounded and the metrics remain aggregatable.
        path: (req as unknown as { route?: { path?: string } }).route?.path ?? req.url,
        status,
        durationMs,
        userId: req.user?.id,
      }),
    );
  }
}
