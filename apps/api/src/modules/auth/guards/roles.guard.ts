import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@eco/shared';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

/** Coarse role gate. Per-record ownership is enforced in the services and by RLS. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user) throw new ForbiddenException('Authentication required');

    // ADMIN implies every lesser role; encoding that here keeps callers from
    // having to list ADMIN on every single decorator.
    if (user.role === 'ADMIN') return true;

    if (!required.includes(user.role as UserRole)) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}
