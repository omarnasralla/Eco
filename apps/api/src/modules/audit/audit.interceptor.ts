import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { AUDIT_KEY, type AuditMetadata } from '../../common/decorators/audit.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from './audit.service';

/**
 * Writes an audit entry for any handler carrying `@Audit(...)`.
 *
 * Only successful calls are recorded here, with one exception: failed logins
 * are audited by AuthService itself, because a rejected authentication attempt
 * is exactly the event a security review needs to see.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.get<AuditMetadata>(AUDIT_KEY, context.getHandler());
    if (!metadata) return next.handle();

    const req = context.switchToHttp().getRequest<
      Request & { id?: string; user?: AuthenticatedUser }
    >();

    return next.handle().pipe(
      tap((result) => {
        const entityId =
          (result as { id?: string } | undefined)?.id ??
          (req.params as Record<string, string> | undefined)?.['id'] ??
          null;

        void this.audit.record({
          userId: req.user?.id ?? null,
          action: metadata.action,
          entityType: metadata.entityType,
          entityId,
          // The body is redacted inside AuditService before it is written.
          changes: metadata.action === 'DELETE' ? null : (req.body as Record<string, unknown>),
          ipAddress: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          requestId: req.id ?? null,
        });
      }),
    );
  }
}
